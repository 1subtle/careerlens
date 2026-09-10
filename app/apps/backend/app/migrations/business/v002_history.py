"""Optimistic JD edits and independently retained analysis history."""


def upgrade(connection):
    columns = {row[1] for row in connection.execute("PRAGMA table_info(jobs)")}
    if "version" not in columns:
        connection.execute("ALTER TABLE jobs ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1)")
    connection.execute("""CREATE TABLE direction_history (
        id TEXT PRIMARY KEY, resume_id TEXT NOT NULL, resume_hash TEXT NOT NULL,
        input_snapshot JSON NOT NULL, input_hash TEXT NOT NULL, result JSON NOT NULL,
        created_at TEXT NOT NULL
    )""")
    connection.execute("CREATE INDEX ix_direction_history_resume_id ON direction_history(resume_id)")
    connection.execute("CREATE INDEX ix_direction_history_created_at ON direction_history(created_at)")
    connection.execute("""CREATE TABLE market_history (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, input_snapshot JSON NOT NULL,
        input_hash TEXT NOT NULL, result JSON NOT NULL, created_at TEXT NOT NULL
    )""")
    connection.execute("CREATE INDEX ix_market_history_created_at ON market_history(created_at)")
