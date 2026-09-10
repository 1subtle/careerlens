"""Account audit checks return counts only and never alter stored records."""

import importlib.util
import json
import sqlite3
from pathlib import Path
from uuid import uuid4

from app import migrations

script = Path(__file__).resolve().parents[5] / "scripts" / "audit_hosted_database.py"
spec = importlib.util.spec_from_file_location("account_storage_audit", script)
audit_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit_module)


def test_account_audit_finds_missing_preferences_and_invalid_sessions_without_exposing_data(tmp_path):
    migrations.migrate(tmp_path / "auth.sqlite", "auth")
    migrations.migrate(tmp_path / "resume_matcher.db", "business")
    user_id = str(uuid4())
    email = "private-synthetic@example.test"
    with sqlite3.connect(tmp_path / "auth.sqlite") as connection:
        connection.execute("INSERT INTO users VALUES (?,?,1)", (user_id, email))
        connection.execute("INSERT INTO credit_accounts(user_id,balance,granted,reserved) VALUES (?,0,0,0)", (user_id,))
        connection.execute("INSERT INTO account_preferences(user_id) VALUES (?)", (user_id,))
        connection.execute("INSERT INTO sessions(token_hash,user_id,expires_at,public_id,created_at) VALUES (?,?,9999999999,?,1)",
                           ("a" * 64, user_id, "b" * 32))
    clean = audit_module.audit(tmp_path)
    assert clean["ok"] is True
    assert clean["auth"]["table_rows"]["account_preferences"] == 1
    assert clean["auth"]["users_without_preferences"] == 0
    assert clean["auth"]["invalid_public_session_ids"] == 0
    with sqlite3.connect(tmp_path / "auth.sqlite") as connection:
        connection.execute("DELETE FROM account_preferences WHERE user_id=?", (user_id,))
        connection.execute("UPDATE sessions SET public_id=NULL,created_at=10000000000")
    path = tmp_path / "auth.sqlite"
    before = path.read_bytes()
    report = audit_module.audit(tmp_path)
    assert path.read_bytes() == before
    assert report["ok"] is False
    assert report["auth"]["users_without_preferences"] == 1
    assert report["auth"]["invalid_public_session_ids"] == 1
    assert report["auth"]["invalid_session_timestamps"] == 1
    serialized = json.dumps(report)
    for private in (email, user_id, "a" * 64, "b" * 32):
        assert private not in serialized


def test_account_audit_remains_read_only_on_preference_free_legacy_schema(tmp_path, monkeypatch):
    files = migrations.migration_files("auth")
    with monkeypatch.context() as legacy:
        legacy.setattr(migrations, "migration_files", lambda kind: files[:2])
        migrations.migrate(tmp_path / "auth.sqlite", "auth")
    migrations.migrate(tmp_path / "resume_matcher.db", "business")
    path = tmp_path / "auth.sqlite"
    before = path.read_bytes()
    report = audit_module.audit(tmp_path)
    assert report["ok"] is True
    assert "account_preferences" not in report["auth"]["table_rows"]
    assert "invalid_public_session_ids" not in report["auth"]
    assert path.read_bytes() == before
