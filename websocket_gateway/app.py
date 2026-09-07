from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

import asyncpg
import httpx
import jwt
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from jwt import PyJWKClient
from pydantic import BaseModel, Field
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

LOG = logging.getLogger("codestra.websocket")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(message)s")

EVENT_TYPES = {
    "call.ringing", "call.answered", "call.connected", "call.held", "call.resumed",
    "call.transfer.started", "call.transfer.completed", "call.hangup", "call.disposition.updated",
    "recording.starting", "recording.started", "recording.paused", "recording.resumed",
    "recording.completed", "recording.failed", "recording.available",
    "agent.ready", "agent.not_ready", "agent.logged_in", "agent.logged_out",
    "session.expiring", "session.revoked", "realtime.reconnected",
    "callback.warning", "callback.due", "callback.missed", "callback.escalated",
    "callback.cancelled", "callback.completed", "callback.rescheduled",
}

ACTIVE = Gauge("websocket_connections_active", "Active authenticated sockets")
TOTAL = Counter("websocket_connections_total", "Authenticated sockets")
AUTH_FAILURES = Counter("websocket_auth_failures_total", "Authentication failures")
SENT = Counter("websocket_messages_sent_total", "Messages sent")
EVENTS_RECEIVED = Counter("call_workspace_events_received_total", "Validated realtime events received", ["event_type"])
EVENTS_REJECTED = Counter("call_workspace_events_rejected_total", "Realtime event requests rejected", ["status"])
EVENT_DUPLICATES = Counter("call_workspace_event_duplicates_total", "Duplicate realtime events suppressed")
POPUP_DELIVERIES = Counter("call_workspace_popup_deliveries_total", "Call ringing workspaces queued to agents")
DELIVERY_FAILURES = Counter("websocket_delivery_failures_total", "Delivery failures")
DISCONNECTS = Counter("websocket_disconnects_total", "Authenticated WebSocket disconnects")
RECONNECTS = Counter("websocket_reconnects_total", "Reconnects")
REPLAYED = Counter("websocket_replay_events_total", "Events replayed")
BACKPRESSURE = Counter("websocket_backpressure_disconnects_total", "Backpressure disconnects")
CROSS_SCOPE = Counter("websocket_cross_scope_denials_total", "Cross-scope denials")
LATENCY = Histogram("websocket_delivery_latency_seconds", "Persistence-to-socket delivery latency")


def now() -> datetime:
    return datetime.now(timezone.utc)


def secret_file(name: str) -> str:
    path = os.environ[name]
    with open(path, encoding="utf-8") as handle:
        return handle.read().strip()


def log_event(message: str, **fields: Any) -> None:
    safe = {k: v for k, v in fields.items() if k not in {"ticket", "jwt", "token", "phone", "customer_name"}}
    LOG.info(json.dumps({"timestamp": now().isoformat(), "message": message, **safe}, separators=(",", ":"), default=str))


class Settings:
    database_url = ""
    internal_token = ""
    issuer = os.getenv("KEYCLOAK_ISSUER", "https://auth.codestra.co/realms/codestra")
    audience = os.getenv("KEYCLOAK_AUDIENCE", "codestra-agent-desktop")
    jwks_url = os.getenv("KEYCLOAK_JWKS_URL", "http://keycloak:8080/realms/codestra/protocol/openid-connect/certs")
    ws_url = os.getenv("PUBLIC_WS_URL", "wss://api.codestra.agency/ws/agent")
    allowed_origins = frozenset(filter(None, os.getenv("ALLOWED_ORIGINS", "https://crm.codestra.agency,https://phone.codestra.agency").split(",")))
    ticket_ttl = min(60, max(30, int(os.getenv("TICKET_TTL_SECONDS", "45"))))
    auth_timeout = min(10, max(3, int(os.getenv("WS_AUTH_TIMEOUT_SECONDS", "5"))))
    max_pending = min(1000, max(10, int(os.getenv("MAX_PENDING_MESSAGES", "100"))))
    max_message_size = min(262144, max(1024, int(os.getenv("MAX_MESSAGE_SIZE", "65536"))))
    write_timeout = min(10, max(1, int(os.getenv("WRITE_TIMEOUT_SECONDS", "3"))))
    nats_host = os.getenv("NATS_HOST", "host.docker.internal")
    nats_port = int(os.getenv("NATS_PORT", "4222"))
    event_source_health_url = os.getenv("INTERNAL_EVENT_SOURCE_HEALTH_URL", "http://middleware:8095/health")
    passive_standby = os.getenv("PASSIVE_STANDBY", "false").lower() in {"1", "true", "yes"}


settings = Settings()


class Event(BaseModel):
    event_id: str = Field(min_length=1, max_length=128)
    schema_version: str = "1.0"
    type: str
    correlation_id: str = Field(min_length=1, max_length=128)
    timestamp: datetime
    tenant_id: str
    business_unit_id: str
    campaign_id: str
    user_id: str
    agent_id: str
    call_id: str | None = None
    sequence: int = Field(ge=0)
    payload: dict[str, Any] = Field(default_factory=dict)


class Connection:
    def __init__(self, websocket: WebSocket, scope: dict[str, Any]):
        self.websocket = websocket
        self.scope = scope
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(settings.max_pending)
        self.sender: asyncio.Task[None] | None = None

    def allows(self, event: dict[str, Any]) -> bool:
        return (
            event["tenant_id"] == self.scope["tenant_id"]
            and event["business_unit_id"] == self.scope["business_unit_id"]
            and event["user_id"] == self.scope["user_id"]
            and event["agent_id"] == self.scope["agent_id"]
            and event["campaign_id"] in self.scope["campaigns"]
        )

    async def send_loop(self) -> None:
        while True:
            item = await self.queue.get()
            try:
                async with asyncio.timeout(settings.write_timeout):
                    await self.websocket.send_json(item)
                SENT.inc()
                if item.get("timestamp"):
                    try:
                        LATENCY.observe(max(0, time.time() - datetime.fromisoformat(item["timestamp"].replace("Z", "+00:00")).timestamp()))
                    except ValueError:
                        pass
            except Exception:
                DELIVERY_FAILURES.inc()
                await self.websocket.close(code=4500)
                return


connections: dict[str, Connection] = {}


DATABASE_MIGRATION_HEAD = "0001_realtime_gateway"


async def verify_schema(pool: asyncpg.Pool) -> None:
    """Fail closed when the independently-run migration is not at HEAD."""
    head = await pool.fetchval(
        "SELECT version FROM websocket_schema_migrations ORDER BY applied_at DESC LIMIT 1"
    )
    if head != DATABASE_MIGRATION_HEAD:
        raise RuntimeError(f"database migration head mismatch: expected {DATABASE_MIGRATION_HEAD}")
    in_recovery = bool(await pool.fetchval("SELECT pg_is_in_recovery()"))
    if settings.passive_standby:
        if not in_recovery:
            raise RuntimeError("passive standby requires a read-only recovery database")
        return
    if in_recovery:
        raise RuntimeError("active gateway requires the writable database authority")
    # Connections are process-local. A clean start clears stale ownership only.
    await pool.execute(
        "UPDATE realtime_sessions SET active_connection=false WHERE active_connection=true"
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.database_url = secret_file("DATABASE_URL_FILE")
    settings.internal_token = secret_file("INTERNAL_TOKEN_FILE")
    app.state.pool = await asyncpg.create_pool(settings.database_url, min_size=2, max_size=20, command_timeout=5)
    await verify_schema(app.state.pool)
    app.state.jwks = PyJWKClient(settings.jwks_url, cache_keys=True, lifespan=300)
    yield
    for connection in tuple(connections.values()):
        await connection.websocket.close(code=1012)
    await app.state.pool.close()


app = FastAPI(title="Codestra WebSocket Gateway", version="1.0.0", lifespan=lifespan)


@app.middleware("http")
async def observe_rejections(request: Request, call_next):
    response = await call_next(request)
    if request.url.path == "/internal/v1/realtime/events" and response.status_code >= 400:
        EVENTS_REJECTED.labels(status=str(response.status_code)).inc()
    return response


def roles_of(claims: dict[str, Any]) -> set[str]:
    realm = set(claims.get("realm_access", {}).get("roles", []))
    client = set(claims.get("resource_access", {}).get(settings.audience, {}).get("roles", []))
    return realm | client


def decode_access_token(request: Request) -> dict[str, Any]:
    authorization = request.headers.get("authorization", "")
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "bearer token required")
    token = authorization[7:]
    try:
        key = request.app.state.jwks.get_signing_key_from_jwt(token).key
        claims = jwt.decode(token, key, algorithms=["RS256", "ES256"], issuer=settings.issuer, audience=settings.audience, options={"require": ["exp", "iat", "sub"]})
    except Exception:
        AUTH_FAILURES.inc()
        raise HTTPException(401, "invalid access token") from None
    required_roles = {"telephony.webphone.use", "realtime.agent.connect"}
    if not required_roles.issubset(roles_of(claims)):
        raise HTTPException(403, "required realtime roles missing")
    required = ("tenant_id", "business_unit_id", "agent_id", "vicidial_user", "extension", "campaigns")
    if any(not claims.get(field) for field in required) or not isinstance(claims["campaigns"], list):
        raise HTTPException(403, "agent mapping claims incomplete")
    return claims


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "healthy"}


@app.get("/readyz")
async def readyz(request: Request) -> dict[str, Any]:
    checks: dict[str, bool] = {"application": True, "authentication_configuration": bool(settings.issuer and settings.audience and settings.jwks_url)}
    try:
        checks["database"] = await request.app.state.pool.fetchval("SELECT 1") == 1
        in_recovery = bool(await request.app.state.pool.fetchval("SELECT pg_is_in_recovery()"))
        checks["database_role"] = in_recovery == settings.passive_standby
    except Exception:
        checks["database"] = False
        checks["database_role"] = False
    try:
        async with httpx.AsyncClient(timeout=2) as client:
            response = await client.get(settings.event_source_health_url)
        checks["internal_event_source"] = response.status_code == 200
    except Exception:
        checks["internal_event_source"] = False
    checks["realtime_state_backend"] = checks["database"]
    if not all(checks.values()):
        raise HTTPException(503, detail=checks)
    return {"status": "ready", "checks": checks}


@app.get("/metrics")
async def metrics() -> Response:
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.post("/api/v1/realtime/sessions", status_code=201)
async def create_session(request: Request, claims: dict[str, Any] = Depends(decode_access_token)) -> dict[str, Any]:
    if settings.passive_standby:
        raise HTTPException(503, "passive standby does not issue sessions")
    session_id = uuid.uuid4()
    raw_ticket = secrets.token_urlsafe(32)
    ticket_hash = hashlib.sha256(raw_ticket.encode()).hexdigest()
    expires_at = now() + timedelta(seconds=settings.ticket_ttl)
    session_expires = min(datetime.fromtimestamp(claims["exp"], timezone.utc), now() + timedelta(hours=8))
    async with request.app.state.pool.acquire() as connection, connection.transaction():
        await connection.execute("""INSERT INTO realtime_sessions
          (session_id,user_id,tenant_id,business_unit_id,agent_id,vicidial_user,extension,campaigns,created_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)""",
          session_id, claims["sub"], claims["tenant_id"], claims["business_unit_id"], claims["agent_id"],
          claims["vicidial_user"], str(claims["extension"]), json.dumps(claims["campaigns"]), now(), session_expires)
        await connection.execute("INSERT INTO realtime_tickets(ticket_hash,session_id,expires_at) VALUES($1,$2,$3)", ticket_hash, session_id, expires_at)
    log_event("realtime_session_issued", session_id=session_id, user_id=claims["sub"], agent_id=claims["agent_id"], tenant_id=claims["tenant_id"], result="issued")
    return {"session_id": str(session_id), "expires_at": expires_at.isoformat(), "ws_url": settings.ws_url, "ticket": raw_ticket}


async def consume_ticket(pool: asyncpg.Pool, ticket: str) -> dict[str, Any] | None:
    digest = hashlib.sha256(ticket.encode()).hexdigest()
    async with pool.acquire() as connection, connection.transaction():
        row = await connection.fetchrow("""UPDATE realtime_tickets SET used_at=now()
          WHERE ticket_hash=$1 AND used_at IS NULL AND expires_at>now()
          RETURNING session_id""", digest)
        if not row:
            return None
        session = await connection.fetchrow("""SELECT * FROM realtime_sessions
          WHERE session_id=$1 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE""", row["session_id"])
        if not session:
            return None
        conflict = await connection.fetchval("""SELECT session_id FROM realtime_sessions
          WHERE tenant_id=$1 AND agent_id=$2 AND active_connection=true AND session_id<>$3 AND revoked_at IS NULL LIMIT 1""",
          session["tenant_id"], session["agent_id"], session["session_id"])
        if conflict:
            return {"duplicate": True}
        await connection.execute("UPDATE realtime_sessions SET active_connection=true WHERE session_id=$1", session["session_id"])
        result = dict(session)
        stored_campaigns = result["campaigns"]
        result["campaigns"] = json.loads(stored_campaigns) if isinstance(stored_campaigns, str) else list(stored_campaigns)
        return result


async def replay(pool: asyncpg.Pool, scope: dict[str, Any], last_event_id: str | None) -> list[dict[str, Any]]:
    after = 0
    if last_event_id:
        value = await pool.fetchval("SELECT ordinal FROM realtime_events WHERE event_id=$1", last_event_id)
        after = int(value or 0)
    result = []
    while True:
        rows = await pool.fetch("""SELECT ordinal,event_id,schema_version,event_type AS type,correlation_id,occurred_at AS timestamp,
          tenant_id,business_unit_id,campaign_id,user_id,agent_id,call_id,sequence,payload FROM realtime_events
          WHERE ordinal>$1 AND tenant_id=$2 AND business_unit_id=$3 AND user_id=$4 AND agent_id=$5
            AND campaign_id=ANY($6::text[]) ORDER BY ordinal LIMIT 1000""",
          after, scope["tenant_id"], scope["business_unit_id"], scope["user_id"], scope["agent_id"], scope["campaigns"])
        if not rows:
            break
        for row in rows:
            document = dict(row)
            after = int(document.pop("ordinal"))
            if isinstance(document["payload"], str):
                document["payload"] = json.loads(document["payload"])
            document["timestamp"] = row["timestamp"].isoformat()
            result.append(document)
        if len(rows) < 1000:
            break
    return result


@app.websocket("/ws/agent")
async def ws_agent(websocket: WebSocket) -> None:
    if settings.passive_standby:
        await websocket.close(code=1013)
        return
    origin = websocket.headers.get("origin")
    if origin not in settings.allowed_origins:
        CROSS_SCOPE.inc()
        await websocket.close(code=4403)
        return
    await websocket.accept()
    scope: dict[str, Any] | None = None
    connection: Connection | None = None
    try:
        try:
            frame = await asyncio.wait_for(websocket.receive_json(), settings.auth_timeout)
        except asyncio.TimeoutError:
            AUTH_FAILURES.inc()
            await websocket.close(code=4408)
            return
        if frame.get("type") != "auth" or not isinstance(frame.get("ticket"), str) or len(frame["ticket"]) > 256:
            AUTH_FAILURES.inc()
            await websocket.close(code=4401)
            return
        scope = await consume_ticket(websocket.app.state.pool, frame["ticket"])
        if not scope:
            AUTH_FAILURES.inc()
            await websocket.close(code=4401)
            return
        if scope.get("duplicate"):
            await websocket.close(code=4409)
            return
        sid = str(scope["session_id"])
        connection = Connection(websocket, scope)
        connections[sid] = connection
        connection.sender = asyncio.create_task(connection.send_loop())
        ACTIVE.inc()
        TOTAL.inc()
        last_event_id = frame.get("last_event_id")
        missing = await replay(websocket.app.state.pool, scope, last_event_id) if last_event_id else []
        if last_event_id:
            RECONNECTS.inc()
        await websocket.send_json({"type": "authenticated", "session_id": sid, "replayed": len(missing)})
        for event in missing:
            await connection.queue.put(event)
            REPLAYED.inc()
        while True:
            remaining = (scope["expires_at"] - now()).total_seconds()
            if remaining <= 0:
                await websocket.close(code=4401, reason="realtime session expired")
                return
            try:
                message = await asyncio.wait_for(websocket.receive_json(), timeout=remaining)
            except asyncio.TimeoutError:
                await websocket.close(code=4401, reason="realtime session expired")
                return
            if message.get("type") == "pong":
                continue
            if message.get("type") == "disconnect":
                await websocket.close(code=1000)
                return
            await websocket.send_json({"type": "error", "code": "client_command_not_allowed"})
    except WebSocketDisconnect:
        if scope:
            DISCONNECTS.inc()
    finally:
        if scope and connection:
            await websocket.app.state.pool.execute("UPDATE realtime_sessions SET active_connection=false WHERE session_id=$1", scope["session_id"])
            connections.pop(str(scope["session_id"]), None)
            ACTIVE.dec()
        if connection and connection.sender:
            connection.sender.cancel()


def require_internal(x_codestra_internal_token: str = Header(default="")) -> None:
    if not secrets.compare_digest(x_codestra_internal_token, settings.internal_token):
        raise HTTPException(401, "invalid internal identity")


@app.post("/internal/v1/realtime/events", status_code=202, dependencies=[Depends(require_internal)])
async def publish_event(event: Event, request: Request) -> dict[str, Any]:
    if settings.passive_standby:
        raise HTTPException(503, "passive standby does not accept events")
    if event.type not in EVENT_TYPES:
        raise HTTPException(422, "unsupported realtime event type")
    EVENTS_RECEIVED.labels(event_type=event.type).inc()
    encoded = json.dumps(event.payload, separators=(",", ":"))
    if len(encoded.encode()) > settings.max_message_size:
        raise HTTPException(413, "event payload too large")
    row = await request.app.state.pool.fetchrow("""INSERT INTO realtime_events
      (event_id,schema_version,event_type,correlation_id,occurred_at,tenant_id,business_unit_id,campaign_id,user_id,agent_id,call_id,sequence,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
      ON CONFLICT(event_id) DO NOTHING RETURNING ordinal""", event.event_id, event.schema_version, event.type,
      event.correlation_id, event.timestamp, event.tenant_id, event.business_unit_id, event.campaign_id,
      event.user_id, event.agent_id, event.call_id, event.sequence, encoded)
    if not row:
        EVENT_DUPLICATES.inc()
        return {"accepted": True, "duplicate": True, "delivered": 0}
    document = event.model_dump(mode="json")
    delivered = 0
    for active in tuple(connections.values()):
        if not active.allows(document):
            CROSS_SCOPE.inc()
            continue
        try:
            active.queue.put_nowait(document)
            delivered += 1
            if event.type == "call.ringing":
                POPUP_DELIVERIES.inc()
        except asyncio.QueueFull:
            BACKPRESSURE.inc()
            await active.websocket.close(code=4429)
    log_event("realtime_event_accepted", event_id=event.event_id, event_type=event.type, tenant_id=event.tenant_id, campaign_id=event.campaign_id, result="accepted", delivered=delivered)
    return {"accepted": True, "duplicate": False, "delivered": delivered}


@app.post("/internal/v1/realtime/sessions/{session_id}/revoke", dependencies=[Depends(require_internal)])
async def revoke_session(session_id: uuid.UUID, request: Request) -> dict[str, bool]:
    if settings.passive_standby:
        raise HTTPException(503, "passive standby does not revoke sessions")
    changed = await request.app.state.pool.fetchval("UPDATE realtime_sessions SET revoked_at=now() WHERE session_id=$1 AND revoked_at IS NULL RETURNING true", session_id)
    active = connections.get(str(session_id))
    if active:
        await active.websocket.close(code=4401)
    return {"revoked": bool(changed)}
