"""Baseline for pre-migration email authentication databases."""

STATEMENTS = [
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at REAL NOT NULL)",
    "CREATE TABLE IF NOT EXISTS credit_accounts (user_id TEXT PRIMARY KEY REFERENCES users(id), balance INTEGER NOT NULL CHECK(balance >= 0), granted INTEGER NOT NULL CHECK(granted >= 0))",
    "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at REAL NOT NULL)",
    "CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT NOT NULL, created_at REAL NOT NULL, expires_at REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS send_events (email TEXT NOT NULL, ip_hash TEXT NOT NULL, created_at REAL NOT NULL)",
    "CREATE INDEX IF NOT EXISTS send_email_time ON send_events(email,created_at)",
    "CREATE INDEX IF NOT EXISTS send_ip_time ON send_events(ip_hash,created_at)",
    "CREATE INDEX IF NOT EXISTS challenge_email ON challenges(email)",
]


def upgrade(connection):
    for statement in STATEMENTS:
        connection.execute(statement)
