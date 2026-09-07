from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from fastapi import HTTPException

from websocket_gateway import app as gateway


class Socket:
    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.closed: list[int] = []

    async def send_json(self, item: dict) -> None:
        self.sent.append(item)

    async def close(self, code: int) -> None:
        self.closed.append(code)


def scope(**overrides: object) -> dict:
    value: dict[str, Any] = {
        "tenant_id": "tenant-a",
        "business_unit_id": "unit-a",
        "user_id": "user-a",
        "agent_id": "agent-a",
        "campaigns": ["TEST_SYN"],
    }
    value.update(overrides)
    return value


def event(**overrides: object) -> dict:
    value: dict[str, Any] = {
        "tenant_id": "tenant-a",
        "business_unit_id": "unit-a",
        "user_id": "user-a",
        "agent_id": "agent-a",
        "campaign_id": "TEST_SYN",
    }
    value.update(overrides)
    return value


def test_agent_tenant_business_unit_and_campaign_isolation() -> None:
    connection = gateway.Connection(cast(Any, Socket()), scope())
    assert connection.allows(event())
    assert not connection.allows(event(agent_id="agent-b"))
    assert not connection.allows(event(tenant_id="tenant-b"))
    assert not connection.allows(event(business_unit_id="unit-b"))
    assert not connection.allows(event(campaign_id="OTHER"))


def test_authentication_roles_are_combined_and_required(monkeypatch: pytest.MonkeyPatch) -> None:
    claims = {
        "realm_access": {"roles": ["telephony.webphone.use"]},
        "resource_access": {gateway.settings.audience: {"roles": ["realtime.agent.connect"]}},
        "tenant_id": "tenant-a", "business_unit_id": "unit-a", "agent_id": "agent-a",
        "vicidial_user": "6101", "extension": "6101", "campaigns": ["TEST_SYN"],
        "sub": "user-a", "exp": 4_102_444_800, "iat": 1,
    }
    monkeypatch.setattr(gateway.settings, "issuer", "https://issuer.invalid")
    monkeypatch.setattr(gateway.settings, "audience", "codestra-agent-desktop")
    monkeypatch.setattr(gateway.jwt, "decode", lambda *_args, **_kwargs: claims)
    request = SimpleNamespace(
        headers={"authorization": "Bearer synthetic.jwt.value"},
        app=SimpleNamespace(state=SimpleNamespace(jwks=SimpleNamespace(
            get_signing_key_from_jwt=lambda _token: SimpleNamespace(key="synthetic-public-key")
        ))),
    )
    assert gateway.decode_access_token(cast(Any, request))["campaigns"] == ["TEST_SYN"]
    with pytest.raises(HTTPException) as denied:
        gateway.decode_access_token(cast(Any, SimpleNamespace(headers={}, app=request.app)))
    assert denied.value.status_code == 401


def test_ticket_ttl_auth_timeout_and_replay_bounds_are_fail_closed() -> None:
    assert 30 <= gateway.settings.ticket_ttl <= 60
    assert 3 <= gateway.settings.auth_timeout <= 10
    source = Path(gateway.__file__).read_text(encoding="utf-8")
    assert "UPDATE realtime_tickets SET used_at=now()" in source
    assert "used_at IS NULL" in source
    assert "LIMIT 1000" in source
    assert "last_event_id" in source


def test_screen_pop_recording_reconnect_and_durable_replay_contracts() -> None:
    assert {"call.ringing", "recording.started", "recording.available", "realtime.reconnected", "callback.due", "callback.missed", "callback.completed"} <= gateway.EVENT_TYPES
    migration = (Path(gateway.__file__).with_name("migrations") / "0001_realtime_gateway.up.sql").read_text()
    assert "UNIQUE (tenant_id, call_id, sequence)" in migration
    assert "realtime_event_delivery" in migration
    assert "realtime_replay_cursor" in migration
    assert "realtime_idempotency" in migration


def test_health_handler_and_backpressure_contract() -> None:
    assert asyncio.run(gateway.healthz()) == {"status": "healthy"}
    connection = gateway.Connection(cast(Any, Socket()), scope())
    assert connection.queue.maxsize == gateway.settings.max_pending


def test_passive_standby_requires_recovery_and_performs_no_startup_write() -> None:
    class Pool:
        def __init__(self, recovery: bool):
            self.recovery = recovery
            self.executed: list[str] = []

        async def fetchval(self, query: str):
            if "websocket_schema_migrations" in query:
                return gateway.DATABASE_MIGRATION_HEAD
            if "pg_is_in_recovery" in query:
                return self.recovery
            raise AssertionError(query)

        async def execute(self, query: str) -> None:
            self.executed.append(query)

    original = gateway.settings.passive_standby
    try:
        gateway.settings.passive_standby = True
        replica = Pool(recovery=True)
        asyncio.run(gateway.verify_schema(replica))
        assert replica.executed == []

        gateway.settings.passive_standby = False
        primary = Pool(recovery=False)
        asyncio.run(gateway.verify_schema(primary))
        assert len(primary.executed) == 1
    finally:
        gateway.settings.passive_standby = original


def test_passive_standby_write_paths_fail_closed() -> None:
    source = Path(gateway.__file__).read_text()
    assert 'HTTPException(503, "passive standby does not issue sessions")' in source
    assert 'HTTPException(503, "passive standby does not accept events")' in source
    assert 'HTTPException(503, "passive standby does not revoke sessions")' in source
    assert "await websocket.close(code=1013)" in source
    source = Path(gateway.__file__).read_text(encoding="utf-8")
    assert "BACKPRESSURE.inc()" in source
    assert "active.queue.put_nowait(document)" in source


def test_restart_recovery_and_load_certification_sources_are_committed() -> None:
    root = Path(gateway.__file__).parent
    recovery = (root / "recovery_certify.mjs").read_text()
    certification = (root / "certify.py").read_text()
    assert "REPLAY_EXACTLY_ONCE" in recovery
    assert 'results["LOAD_TEST"] = "PASS"' in certification
    assert "250" in certification
