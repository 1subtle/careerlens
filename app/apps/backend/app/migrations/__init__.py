"""Forward, checksummed SQLite migrations with one transaction per version."""

import hashlib
import importlib.util
import re
import sqlite3
from datetime import UTC, datetime
from pathlib import Path


class MigrationError(RuntimeError):
    pass


def migration_files(kind: str) -> list[Path]:
    if kind not in {"auth", "business"}:
        raise MigrationError("Unknown database kind")
    files = sorted((Path(__file__).parent / kind).glob("v[0-9][0-9][0-9]_*.py"))
    versions = [int(file.name[1:4]) for file in files]
    if versions != list(range(1, len(files) + 1)):
        raise MigrationError("Migration versions must be contiguous")
    return files


def _records(connection):
    exists = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
    ).fetchone()
    return connection.execute(
        "SELECT version,kind,name,checksum FROM schema_migrations ORDER BY version"
    ).fetchall() if exists else []


def _verify(records, files, kind):
    if [row[0] for row in records] != list(range(1, len(records) + 1)):
        raise MigrationError("Stored migration sequence is invalid")
    if len(records) > len(files):
        raise MigrationError("Database requires a newer application version")
    for row, file in zip(records, files):
        if row[1] != kind or row[2] != file.stem:
            raise MigrationError("Database migration kind or name does not match")
        if row[3] != hashlib.sha256(file.read_bytes()).hexdigest():
            raise MigrationError(f"Applied migration was modified: {file.stem}")


def migrate_connection(connection: sqlite3.Connection, kind: str) -> int:
    """The caller supplies an idle SQLite connection; no executescript commits."""
    files = migration_files(kind)
    connection.execute("PRAGMA busy_timeout=10000")
    connection.execute("PRAGMA foreign_keys=ON")
    mode = connection.execute("PRAGMA journal_mode=DELETE").fetchone()[0]
    if mode.lower() != "delete":
        raise MigrationError("Persistent rollback journaling is required")
    connection.execute("PRAGMA synchronous=FULL")
    connection.execute("BEGIN IMMEDIATE")
    try:
        existing_tables = {row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        if (kind == "auth" and "resumes" in existing_tables) or (
            kind == "business" and "users" in existing_tables
        ):
            raise MigrationError("Wrong database kind")
        connection.execute("""CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
            checksum TEXT NOT NULL, applied_at TEXT NOT NULL
        )""")
        _verify(_records(connection), files, kind)
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    for file in files:
        version = int(file.name[1:4])
        connection.execute("BEGIN IMMEDIATE")
        try:
            records = _records(connection)
            _verify(records, files, kind)
            if version <= len(records):
                connection.commit()
                continue
            spec = importlib.util.spec_from_file_location(f"migration_{kind}_{version}", file)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            module.upgrade(connection)
            if connection.execute("PRAGMA foreign_key_check").fetchone():
                raise MigrationError("Migration left invalid foreign keys")
            connection.execute(
                "INSERT INTO schema_migrations VALUES (?, ?, ?, ?, ?)",
                (version, kind, file.stem, hashlib.sha256(file.read_bytes()).hexdigest(),
                 datetime.now(UTC).isoformat()),
            )
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
    return len(files)


def migrate(path: Path, kind: str) -> int:
    path = Path(path)
    if path.is_symlink():
        raise MigrationError("Database symlinks are not supported")
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=10)
    try:
        version = migrate_connection(connection, kind)
    finally:
        connection.close()
    path.chmod(0o600)
    return version


def status(path: Path, kind: str) -> dict:
    files = migration_files(kind)
    if not path.is_file():
        return {"kind": kind, "version": 0, "latest": len(files), "pending": len(files)}
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        records = _records(connection)
        _verify(records, files, kind)
        return {"kind": kind, "version": len(records), "latest": len(files),
                "pending": len(files) - len(records)}
    finally:
        connection.close()


def migrate_existing_workspaces(root: Path) -> int:
    """Startup upgrades known workspace files before accepting requests."""
    users_root = root / "users"
    count = 0
    if users_root.is_symlink():
        raise MigrationError("Workspace root cannot be a symlink")
    if users_root.exists():
        for directory in sorted(users_root.iterdir()):
            if directory.is_symlink() or not re.fullmatch(
                r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", directory.name
            ):
                raise MigrationError("Unexpected workspace path")
            database = directory / "workspace.sqlite"
            if database.exists():
                migrate(database, "business")
                count += 1
    return count
