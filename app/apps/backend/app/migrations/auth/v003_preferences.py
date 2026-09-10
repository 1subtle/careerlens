"""Account preferences and revocable public session identifiers."""


def upgrade(connection):
    connection.execute("""CREATE TABLE account_preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        display_name TEXT NOT NULL DEFAULT '',
        ui_language TEXT NOT NULL DEFAULT 'zh' CHECK(ui_language IN ('en','es','zh','ja','pt','fr','ko')),
        content_language TEXT NOT NULL DEFAULT 'zh' CHECK(content_language IN ('en','es','zh','ja','pt','fr','ko')),
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai'
    )""")
    connection.execute("INSERT INTO account_preferences(user_id) SELECT id FROM users")
    connection.execute("ALTER TABLE sessions ADD COLUMN public_id TEXT")
    connection.execute("ALTER TABLE sessions ADD COLUMN created_at REAL")
    connection.execute("ALTER TABLE sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT ''")
    connection.execute("UPDATE sessions SET public_id=lower(hex(randomblob(16)))")
    connection.execute("CREATE UNIQUE INDEX ix_sessions_public_id ON sessions(public_id)")
    connection.execute("CREATE INDEX ix_sessions_user_expiry ON sessions(user_id,expires_at)")
