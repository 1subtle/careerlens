"""Filtered account billing, stable cursors and complete bounded CSV exports."""

import csv
import io
import time

import pytest

from app import auth
from app.routers.billing import router
from tests.integration.test_hosted_auth import hosted, isolated_hosting, login  # noqa: F401


@pytest.fixture
async def history(hosted):
    client, mailbox, app = hosted
    app.include_router(router, prefix="/api/v1")
    second, _ = await login(client, mailbox, "second@example.test")
    other = second.json()["user"]["id"]
    first, _ = await login(client, mailbox, "first@example.test")
    owner = first.json()["user"]["id"]
    with auth.get_auth_store().connect() as connection:
        for user, prefix in ((owner, "own"), (other, "other")):
            for suffix, kind, stamp, balance, reserved in (
                ("a", "purchase", 100, 50, 0),
                ("b", "spend", 200, 0, -2),
                ("c", "release", 300, 1, -1),
                ("d", "spend", 200, 0, -3),
            ):
                connection.execute(
                    "INSERT INTO credit_ledger(event_key,user_id,kind,balance_delta,reserved_delta,"
                    "balance_after,reserved_after,created_at,operation_id) VALUES (?,?,?,?,?,?,?,?,?)",
                    (prefix + suffix, user, kind, balance, reserved, 20, 0, stamp, "=unsafe-csv"),
                )
            for suffix, status, stamp in (("a", "paid", 100), ("b", "pending", 200), ("c", "pending", 200)):
                connection.execute(
                    "INSERT INTO payment_orders(id,user_id,idempotency_key,package_id,description,"
                    "amount_fen,currency,credits,mchid,appid,status,created_at,updated_at,expires_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (prefix + suffix, user, prefix + suffix, "test", "测试套餐", 990, "CNY", 50,
                     "test", "test", status, stamp, stamp, time.time() + 3600),
                )
    return client


async def test_summary_totals_only_include_current_account(history):
    result = await history.get("/api/v1/billing/summary")
    assert result.status_code == 200
    assert {key: result.json()[key] for key in ("balance", "total_spent", "total_purchased", "total_paid_fen")} == {
        "balance": 20, "total_spent": 5, "total_purchased": 50, "total_paid_fen": 990,
    }


async def test_ledger_filters_stay_applied_across_pages_and_csv(history):
    params = {"kind": "spend", "from": 200, "to": 201, "limit": 1}
    first = (await history.get("/api/v1/billing/ledger", params=params)).json()
    assert len(first["items"]) == 1 and first["next_before_id"] is not None
    second = (await history.get("/api/v1/billing/ledger", params={**params, "before_id": first["next_before_id"]})).json()
    assert len(second["items"]) == 1 and second["next_before_id"] is None
    assert first["items"][0]["id"] > second["items"][0]["id"]
    result = await history.get("/api/v1/billing/ledger/export", params={k: v for k, v in params.items() if k != "limit"})
    assert result.status_code == 200 and result.headers["cache-control"] == "no-store"
    rows = list(csv.DictReader(io.StringIO(result.text.lstrip("\ufeff"))))
    assert len(rows) == 2
    assert {row["id"] for row in rows} == {str(page["items"][0]["id"]) for page in (first, second)}
    assert all(row["operation_id"] == "'=unsafe-csv" and row["created_at_utc"].endswith("+00:00") for row in rows)
    assert (await history.get("/api/v1/billing/ledger", params={"kind": "spend", "to": 200})).json()["items"] == []


async def test_order_cursor_breaks_timestamp_ties_and_cannot_use_another_account(history):
    params = {"status": "pending", "from": 200, "to": 201, "search": "测试", "limit": 1}
    first = (await history.get("/api/v1/billing/orders", params=params)).json()
    assert [row["id"] for row in first["items"]] == ["ownc"]
    second = (await history.get("/api/v1/billing/orders", params={**params, "before_id": first["next_before_id"]})).json()
    assert [row["id"] for row in second["items"]] == ["ownb"]
    assert second["next_before_id"] is None
    assert (await history.get("/api/v1/billing/orders", params={"search": "other"})).json()["items"] == []
    assert (await history.get("/api/v1/billing/orders", params={"before_id": "otherb"})).status_code == 400


@pytest.mark.parametrize("path,params", [
    ("ledger", {"kind": "unknown"}), ("orders", {"status": "unknown"}),
    ("ledger", {"from": 200, "to": 100}), ("ledger/export", {"from": "nan"}),
    ("orders", {"to": "inf"}),
])
async def test_invalid_billing_filters_are_rejected(history, path, params):
    assert (await history.get("/api/v1/billing/" + path, params=params)).status_code == 422


async def test_csv_never_silently_truncates_export(history):
    user = (await history.get("/api/v1/auth/session")).json()["user"]["id"]
    with auth.get_auth_store().connect() as connection:
        connection.executemany(
            "INSERT INTO credit_ledger(event_key,user_id,kind,balance_delta,reserved_delta,"
            "balance_after,reserved_after,created_at) VALUES (?,?,'adjustment',0,0,20,0,400)",
            [(f"export-{index}", user) for index in range(10001)],
        )
    response = await history.get("/api/v1/billing/ledger/export", params={"kind": "adjustment"})
    assert response.status_code == 413
    assert "10,000" in response.json()["detail"]
