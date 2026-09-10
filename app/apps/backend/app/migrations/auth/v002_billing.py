"""Persistent generation reservations, append-only ledger and payment orders."""

import time


def upgrade(connection):
    connection.execute("ALTER TABLE credit_accounts ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0)")
    connection.execute("""CREATE TABLE credit_operations (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL CHECK(status IN ('pending','settled','released')),
        created_at REAL NOT NULL, updated_at REAL NOT NULL, lease_expires_at REAL NOT NULL
    )""")
    connection.execute("CREATE INDEX ix_credit_operations_lease ON credit_operations(status,lease_expires_at)")
    connection.execute("""CREATE TABLE credit_generations (
        id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES credit_operations(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL CHECK(status IN ('held','completed','settled','released')),
        created_at REAL NOT NULL, updated_at REAL NOT NULL
    )""")
    connection.execute("CREATE INDEX ix_credit_generations_operation ON credit_generations(operation_id,status)")
    connection.execute("""CREATE TABLE payment_orders (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        idempotency_key TEXT NOT NULL, package_id TEXT NOT NULL, description TEXT NOT NULL,
        amount_fen INTEGER NOT NULL CHECK(amount_fen > 0), currency TEXT NOT NULL DEFAULT 'CNY',
        credits INTEGER NOT NULL CHECK(credits > 0), mchid TEXT NOT NULL, appid TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('created','pending','paid','closed')),
        code_url TEXT, transaction_id TEXT UNIQUE, created_at REAL NOT NULL,
        updated_at REAL NOT NULL, expires_at REAL NOT NULL, paid_at REAL,
        UNIQUE(user_id,idempotency_key)
    )""")
    connection.execute("CREATE INDEX ix_payment_orders_user_created ON payment_orders(user_id,created_at)")
    connection.execute("""CREATE TABLE credit_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id), operation_id TEXT,
        generation_id TEXT, order_id TEXT, kind TEXT NOT NULL,
        balance_delta INTEGER NOT NULL, reserved_delta INTEGER NOT NULL,
        balance_after INTEGER NOT NULL, reserved_after INTEGER NOT NULL, created_at REAL NOT NULL
    )""")
    connection.execute("CREATE INDEX ix_credit_ledger_user_id ON credit_ledger(user_id,id)")
    # Existing balances are an opening snapshot, not invented historical usage.
    connection.execute("""INSERT INTO credit_ledger (
        event_key,user_id,kind,balance_delta,reserved_delta,balance_after,reserved_after,created_at
    ) SELECT 'opening:' || user_id,user_id,'opening',balance,0,balance,0,? FROM credit_accounts""", (time.time(),))
