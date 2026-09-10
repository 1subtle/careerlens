"""Real legacy databases, durable migration checksums and rollback behavior."""
import hashlib
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest

from app import migrations


def test_auth_upgrade_preserves_legacy_balance_and_records_opening(tmp_path):
    path = tmp_path / 'auth.sqlite'
    with sqlite3.connect(path) as connection:
        connection.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,created_at REAL NOT NULL);
            CREATE TABLE credit_accounts(user_id TEXT PRIMARY KEY REFERENCES users(id),balance INTEGER NOT NULL,granted INTEGER NOT NULL);
            INSERT INTO users VALUES ('legacy','legacy@example.test',1);
            INSERT INTO credit_accounts VALUES ('legacy',7,20);
        ''')
    connection.close()
    assert migrations.migrate(path, 'auth') == 3
    assert migrations.migrate(path, 'auth') == 3
    with sqlite3.connect(path) as connection:
        assert connection.execute('SELECT balance,granted,reserved FROM credit_accounts').fetchone() == (7,20,0)
        assert connection.execute('SELECT kind,balance_delta,balance_after FROM credit_ledger').fetchall() == [('opening',7,7)]
        assert connection.execute('SELECT COUNT(*) FROM schema_migrations').fetchone()[0] == 3
        assert connection.execute('PRAGMA journal_mode').fetchone()[0] == 'delete'
        assert connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    assert migrations.status(path,'auth')['pending'] == 0


def test_business_upgrade_preserves_records_and_adds_version(tmp_path):
    path = tmp_path / 'workspace.sqlite'
    first = migrations.migration_files('business')[0]
    spec = migrations.importlib.util.spec_from_file_location('legacy_business',first)
    module = migrations.importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with sqlite3.connect(path) as connection:
        module.upgrade(connection)
        connection.execute("INSERT INTO jobs(job_id,content,metadata_json,created_at) VALUES ('job','SQL','{}','2026-01-01')")
    migrations.migrate(path,'business')
    with sqlite3.connect(path) as connection:
        assert connection.execute('SELECT content,version FROM jobs').fetchone() == ('SQL',1)
        assert connection.execute('SELECT COUNT(*) FROM direction_history').fetchone()[0] == 0
        assert connection.execute('SELECT COUNT(*) FROM market_history').fetchone()[0] == 0


def test_modified_or_future_migration_history_fails_closed(tmp_path):
    path=tmp_path/'auth.sqlite'
    migrations.migrate(path,'auth')
    with sqlite3.connect(path) as connection:
        connection.execute("UPDATE schema_migrations SET checksum='modified' WHERE version=1")
    with pytest.raises(migrations.MigrationError, match='modified'):
        migrations.migrate(path,'auth')
    with sqlite3.connect(path) as connection:
        checksum=hashlib.sha256(migrations.migration_files('auth')[0].read_bytes()).hexdigest()
        connection.execute('UPDATE schema_migrations SET checksum=? WHERE version=1',(checksum,))
        connection.execute("INSERT INTO schema_migrations VALUES (4,'auth','v004_future','hash','now')")
    with pytest.raises(migrations.MigrationError,match='newer'):
        migrations.status(path,'auth')


def test_failed_upgrade_rolls_back_ddl_and_version_record(tmp_path,monkeypatch):
    good=tmp_path/'v001_good.py';bad=tmp_path/'v002_bad.py'
    good.write_text("def upgrade(c):\n    c.execute('CREATE TABLE preserved(id INTEGER)')\n")
    bad.write_text("def upgrade(c):\n    c.execute('CREATE TABLE discarded(id INTEGER)')\n    c.execute('INSERT INTO absent VALUES (1)')\n")
    monkeypatch.setattr(migrations,'migration_files',lambda kind:[good,bad])
    path=tmp_path/'test.sqlite'
    with pytest.raises(sqlite3.OperationalError):
        migrations.migrate(path,'business')
    with sqlite3.connect(path) as connection:
        names={r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert 'preserved' in names and 'discarded' not in names
        assert connection.execute('SELECT version FROM schema_migrations').fetchall() == [(1,)]


def test_concurrent_startup_runs_each_migration_once(tmp_path):
    path=tmp_path/'auth.sqlite'
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert list(pool.map(lambda _:migrations.migrate(path,'auth'),range(4))) == [3]*4
    assert migrations.status(path,'auth')['version'] == 3


def test_account_upgrade_keeps_legacy_sessions_valid_and_assigns_public_ids(tmp_path, monkeypatch):
    path = tmp_path / 'auth.sqlite'
    files = migrations.migration_files('auth')
    with monkeypatch.context() as legacy:
        legacy.setattr(migrations, 'migration_files', lambda kind: files[:2])
        migrations.migrate(path, 'auth')
    with sqlite3.connect(path) as connection:
        connection.execute("INSERT INTO users VALUES ('user','person@example.test',1)")
        connection.executemany("INSERT INTO sessions VALUES (?,'user',9999999999)", [('hash-a',), ('hash-b',)])
    migrations.migrate(path, 'auth')
    with sqlite3.connect(path) as connection:
        rows = connection.execute('SELECT token_hash,public_id,created_at,user_agent FROM sessions ORDER BY token_hash').fetchall()
        assert [row[0] for row in rows] == ['hash-a', 'hash-b']
        assert len({row[1] for row in rows}) == 2 and all(len(row[1]) == 32 for row in rows)
        assert all(row[2] is None and row[3] == '' for row in rows)
        assert connection.execute('SELECT ui_language,content_language,timezone FROM account_preferences').fetchone() == ('zh','zh','Asia/Shanghai')


def test_status_does_not_create_database_and_wrong_kind_is_rejected(tmp_path):
    path=tmp_path/'missing.sqlite'
    assert migrations.status(path,'auth')['version'] == 0
    assert not path.exists()
    migrations.migrate(path,'auth')
    with pytest.raises(migrations.MigrationError,match='Wrong database kind'):
        migrations.migrate(path,'business')
