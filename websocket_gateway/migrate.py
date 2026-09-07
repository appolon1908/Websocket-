from __future__ import annotations

import asyncio
import os
import pathlib
import sys

import asyncpg

HEAD = "0001_realtime_gateway"
ROOT = pathlib.Path(__file__).with_name("migrations")


def database_url() -> str:
    with open(os.environ["DATABASE_URL_FILE"], encoding="utf-8") as handle:
        return handle.read().strip()


async def migrate(direction: str) -> None:
    if direction not in {"up", "down"}:
        raise SystemExit("usage: migrate.py up|down")
    connection = await asyncpg.connect(database_url())
    try:
        async with connection.transaction():
            if direction == "up":
                exists = await connection.fetchval(
                    "SELECT to_regclass('public.websocket_schema_migrations') IS NOT NULL"
                )
                if exists:
                    version = await connection.fetchval(
                        "SELECT version FROM websocket_schema_migrations ORDER BY applied_at DESC LIMIT 1"
                    )
                    if version == HEAD:
                        return
                    raise RuntimeError(f"unknown database migration head: {version}")
            sql = (ROOT / f"{HEAD}.{direction}.sql").read_text(encoding="utf-8")
            await connection.execute(sql)
    finally:
        await connection.close()


if __name__ == "__main__":
    asyncio.run(migrate(sys.argv[1] if len(sys.argv) == 2 else ""))
