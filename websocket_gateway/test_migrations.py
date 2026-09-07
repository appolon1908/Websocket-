from pathlib import Path


def test_migration_chain_has_matching_head_and_rollback() -> None:
    root = Path(__file__).with_name("migrations")
    assert (root / "0001_realtime_gateway.up.sql").is_file()
    assert (root / "0001_realtime_gateway.down.sql").is_file()
    source = Path(__file__).with_name("app.py").read_text(encoding="utf-8")
    assert 'DATABASE_MIGRATION_HEAD = "0001_realtime_gateway"' in source
    assert "CREATE TABLE IF NOT EXISTS realtime_sessions" not in source
