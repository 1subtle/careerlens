"""Real local RSA/GCM signatures and isolated SQLite; no actual Wechat requests."""

import asyncio
import base64
import json
import re
import sqlite3
import time
from datetime import UTC, datetime
from unittest.mock import AsyncMock

import httpx
import pytest
import respx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app import auth, billing, payment
from app.credits import credit_balance
from app.payment import PaymentError, PaymentSettings, WechatPay
from app.routers.billing import router
from tests.integration.test_hosted_auth import ORIGIN, hosted, isolated_hosting, login  # noqa: F401

PACKAGE = {"id": "test", "name": "测试积分", "credits": 50, "amount_fen": 100}
KEY_ID = "PUB_KEY_ID_TEST_ONLY"


@pytest.fixture(scope="module")
def keys():
    return tuple(rsa.generate_private_key(public_exponent=65537, key_size=2048) for _ in range(2))


@pytest.fixture
def options(keys, monkeypatch):
    merchant, platform = keys
    value = PaymentSettings(
        _env_file=None, appid="wxTestApp123", mchid="1900000001", merchant_serial="AABB0011",
        merchant_private_key=merchant.private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode(),
        platform_public_key=platform.public_key().public_bytes(serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo).decode(),
        platform_key_id=KEY_ID, api_v3_key="a" * 32, notify_url=ORIGIN + "/api/v1/billing/wechat/notify",
        CAREERLENS_CREDIT_PACKAGES=json.dumps([PACKAGE]),
    )
    monkeypatch.setattr(payment, "get_payment_settings", lambda: value)
    monkeypatch.setattr(billing, "get_payment_settings", lambda: value)
    return value


def signed_headers(body, keys, stamp=None):
    stamp = str(int(time.time()) if stamp is None else stamp)
    nonce = "signed-test-nonce"
    signature = keys[1].sign(f"{stamp}\n{nonce}\n".encode() + body + b"\n", padding.PKCS1v15(), hashes.SHA256())
    return {"Wechatpay-Timestamp": stamp, "Wechatpay-Nonce": nonce,
            "Wechatpay-Serial": KEY_ID, "Wechatpay-Signature": base64.b64encode(signature).decode()}


def provider_response(payload, keys, status=200):
    body = json.dumps(payload, separators=(",", ":")).encode()
    return httpx.Response(status, content=body, headers=signed_headers(body, keys))


def paid_transaction(order):
    return {"out_trade_no": order["id"], "appid": order["appid"], "mchid": order["mchid"],
            "trade_state": "SUCCESS", "trade_type": "NATIVE", "transaction_id": "420000000000000001",
            "success_time": datetime.now(UTC).isoformat(),
            "amount": {"total": order["amount_fen"], "currency": "CNY"}}


def notification(transaction, options, keys):
    nonce, associated = "012345678901", "transaction"
    ciphertext = AESGCM(options.api_v3_key.get_secret_value().encode()).encrypt(
        nonce.encode(), json.dumps(transaction).encode(), associated.encode())
    body = json.dumps({"id": "synthetic-notification", "event_type": "TRANSACTION.SUCCESS", "resource": {
        "original_type": "transaction", "algorithm": "AEAD_AES_256_GCM", "nonce": nonce,
        "associated_data": associated, "ciphertext": base64.b64encode(ciphertext).decode(),
    }}).encode()
    return body, signed_headers(body, keys)


async def test_protocol_native_signs_exact_body_and_verifies_response(options, keys):
    merchant = keys[0].public_key()
    order = {"id": "a" * 32, "appid": options.appid, "mchid": options.mchid,
             "description": "测试积分", "amount_fen": 100, "currency": "CNY", "expires_at": time.time() + 1800}

    def verify_request(request):
        fields = dict(re.findall(r'(\w+)="([^"]+)"', request.headers["Authorization"]))
        assert fields["mchid"] == options.mchid and fields["serial_no"] == options.merchant_serial
        assert request.headers["Wechatpay-Serial"] == KEY_ID
        message = f'POST\n/v3/pay/transactions/native\n{fields["timestamp"]}\n{fields["nonce_str"]}\n'.encode() + request.content + b"\n"
        merchant.verify(base64.b64decode(fields["signature"]), message, padding.PKCS1v15(), hashes.SHA256())
        payload = json.loads(request.content)
        assert payload["amount"] == {"total": 100, "currency": "CNY"}
        assert payload["notify_url"] == options.notify_url
        return provider_response({"code_url": "weixin://wxpay/bizpayurl?pr=test"}, keys)

    with respx.mock:
        route = respx.post("https://api.mch.weixin.qq.com/v3/pay/transactions/native").mock(side_effect=verify_request)
        assert await WechatPay(options).create_native(order) == "weixin://wxpay/bizpayurl?pr=test"
        assert route.call_count == 1


@pytest.mark.parametrize("tamper", ["body", "signature", "serial", "timestamp", "ciphertext"])
def test_protocol_rejects_forged_stale_or_corrupted_notifications(options, keys, tamper):
    transaction = {"trade_state": "SUCCESS"}
    body, headers = notification(transaction, options, keys)
    if tamper == "body":
        body += b" "
    elif tamper == "signature":
        headers["Wechatpay-Signature"] = "WECHATPAY/SIGNTEST/forged"
    elif tamper == "serial":
        headers["Wechatpay-Serial"] = "PUB_KEY_ID_ATTACKER"
    elif tamper == "timestamp":
        headers = signed_headers(body, keys, int(time.time()) - 301)
    else:
        decoded = json.loads(body)
        decoded["resource"]["ciphertext"] = base64.b64encode(b"corrupted" * 5).decode()
        body = json.dumps(decoded).encode()
        headers = signed_headers(body, keys)
    with pytest.raises(PaymentError):
        WechatPay(options).decrypt_notification(httpx.Headers(headers), body)


@pytest.fixture
async def account_order(hosted, options, monkeypatch):
    client, mailbox, app = hosted
    app.include_router(router, prefix="/api/v1")
    signed, _ = await login(client, mailbox)
    user_id = signed.json()["user"]["id"]
    monkeypatch.setattr(WechatPay, "create_native", AsyncMock(return_value="weixin://wxpay/bizpayurl?pr=test"))
    result = await client.post("/api/v1/billing/orders", json={"package_id": "test", "idempotency_key": "test-order-request-1"})
    assert result.status_code == 200, result.text
    yield client, mailbox, app, user_id, billing.get_order(user_id, result.json()["id"], public=False)


async def test_duplicate_notify_and_create_are_idempotent_and_do_not_require_browser_cookie(account_order, options, keys):
    client, _, app, user_id, order = account_order
    again = await client.post("/api/v1/billing/orders", json={"package_id": "test", "idempotency_key": "test-order-request-1"})
    assert again.json()["id"] == order["id"]
    body, headers = notification(paid_transaction(order), options, keys)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN) as webhook:
        replies = await asyncio.gather(*(webhook.post("/api/v1/billing/wechat/notify", content=body, headers=headers) for _ in range(5)))
    assert [reply.status_code for reply in replies] == [204] * 5
    assert credit_balance(user_id)["balance"] == 70
    assert billing.get_order(user_id, order["id"])["status"] == "paid"
    with auth.get_auth_store().connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM credit_ledger WHERE kind='purchase'").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM payment_orders").fetchone()[0] == 1


@pytest.mark.parametrize("field,value", [("mchid", "1900000099"), ("appid", "wxWrong"), ("total", 1),
    ("total", True), ("currency", "USD"), ("trade_type", "JSAPI")])
async def test_verified_but_mismatched_payment_never_adds_credits(account_order, options, keys, field, value):
    client, _, _, user_id, order = account_order
    transaction = paid_transaction(order)
    if field in {"total", "currency"}:
        transaction["amount"][field] = value
    else:
        transaction[field] = value
    body, headers = notification(transaction, options, keys)
    result = await client.post("/api/v1/billing/wechat/notify", content=body, headers=headers)
    assert result.status_code == 400, result.text
    assert credit_balance(user_id)["balance"] == 20
    assert billing.get_order(user_id, order["id"])["status"] == "pending"


async def test_ledger_failure_rolls_back_order_and_balance_then_notification_can_retry(account_order, options, keys, monkeypatch):
    client, _, _, user_id, order = account_order
    body, headers = notification(paid_transaction(order), options, keys)
    original = billing.record_ledger
    def failed(*args, **kwargs):
        raise sqlite3.OperationalError("synthetic ledger write failure")
    monkeypatch.setattr(billing, "record_ledger", failed)
    result = await client.post("/api/v1/billing/wechat/notify", content=body, headers=headers)
    assert result.status_code == 503
    assert credit_balance(user_id)["balance"] == 20
    assert billing.get_order(user_id, order["id"])["status"] == "pending"
    monkeypatch.setattr(billing, "record_ledger", original)
    assert (await client.post("/api/v1/billing/wechat/notify", content=body, headers=headers)).status_code == 204
    assert credit_balance(user_id)["balance"] == 70


async def test_query_verified_paid_order_credits_once_and_other_user_cannot_access(account_order, options, keys):
    client, mailbox, _, user_id, order = account_order
    with respx.mock:
        query = respx.get("https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/" + order["id"],
                          params={"mchid": options.mchid}).mock(return_value=provider_response(paid_transaction(order), keys))
        assert (await client.post(f"/api/v1/billing/orders/{order['id']}/refresh")).json()["status"] == "paid"
        assert (await client.post(f"/api/v1/billing/orders/{order['id']}/refresh")).json()["status"] == "paid"
        assert query.call_count == 1
    assert credit_balance(user_id)["balance"] == 70
    other, _ = await login(client, mailbox, "other@example.test")
    assert (await client.get(f"/api/v1/billing/orders/{order['id']}")).status_code == 404
    assert (await client.post(f"/api/v1/billing/orders/{order['id']}/refresh")).status_code == 404
    assert (await client.get("/api/v1/billing/orders")).json()["items"] == []
    assert all(row["order_id"] is None for row in (await client.get("/api/v1/billing/ledger")).json()["items"])
    assert credit_balance(other.json()["user"]["id"])["balance"] == 20


async def test_unconfigured_payment_is_disabled_and_cannot_create_fake_order(hosted, monkeypatch):
    client, mailbox, app = hosted
    app.include_router(router, prefix="/api/v1")
    await login(client, mailbox)
    options = PaymentSettings(_env_file=None)
    monkeypatch.setattr(payment, "get_payment_settings", lambda: options)
    summary = (await client.get("/api/v1/billing/summary")).json()
    assert summary["payment_enabled"] is False
    assert (await client.post("/api/v1/billing/orders", json={"package_id": "test", "idempotency_key": "test-order-request-1"})).status_code == 503
    assert (await client.get("/api/v1/billing/orders")).json()["items"] == []


async def test_query_signs_path_and_query_and_rejects_wrong_or_unverified_result(account_order, options, keys):
    client, _, _, user_id, order = account_order
    path = "/v3/pay/transactions/out-trade-no/" + order["id"] + "?mchid=" + options.mchid

    def verify(request):
        fields = dict(re.findall(r'(\w+)="([^"]+)"', request.headers["Authorization"]))
        message = f'GET\n{path}\n{fields["timestamp"]}\n{fields["nonce_str"]}\n\n'.encode()
        keys[0].public_key().verify(base64.b64decode(fields["signature"]), message, padding.PKCS1v15(), hashes.SHA256())
        transaction = paid_transaction(order)
        transaction["out_trade_no"] = "different-order"
        return provider_response(transaction, keys)

    with respx.mock:
        route = respx.get("https://api.mch.weixin.qq.com" + path).mock(side_effect=verify)
        assert (await client.post(f"/api/v1/billing/orders/{order['id']}/refresh")).status_code == 503
        route.mock(return_value=httpx.Response(200, json=paid_transaction(order)))
        assert (await client.post(f"/api/v1/billing/orders/{order['id']}/refresh")).status_code == 503
    assert credit_balance(user_id)["balance"] == 20


async def test_same_transaction_cannot_credit_two_orders(account_order, options, keys):
    client, _, _, user_id, first = account_order
    second = (await client.post("/api/v1/billing/orders", json={
        "package_id": "test", "idempotency_key": "test-order-request-2"
    })).json()
    second = billing.get_order(user_id, second["id"], public=False)
    for order, expected in ((first, 204), (second, 400)):
        body, headers = notification(paid_transaction(order), options, keys)
        result = await client.post("/api/v1/billing/wechat/notify", content=body, headers=headers)
        assert result.status_code == expected
    assert credit_balance(user_id)["balance"] == 70
    assert billing.get_order(user_id, second["id"])["status"] == "pending"


async def test_order_keeps_purchase_terms_and_notify_works_after_catalog_disabled(account_order, options, keys):
    client, _, _, user_id, order = account_order
    options.packages_json = "[]"
    assert (await client.get("/api/v1/billing/summary")).json()["payment_enabled"] is False
    assert (await client.post("/api/v1/billing/orders", json={
        "package_id": "test", "idempotency_key": "test-order-request-2"
    })).status_code == 503
    body, headers = notification(paid_transaction(order), options, keys)
    assert (await client.post("/api/v1/billing/wechat/notify", content=body, headers=headers)).status_code == 204
    assert credit_balance(user_id)["balance"] == 70


async def test_uncertain_create_response_queries_before_marking_any_payment(hosted, options, monkeypatch):
    client, mailbox, app = hosted
    app.include_router(router, prefix="/api/v1")
    signed, _ = await login(client, mailbox)
    user_id = signed.json()["user"]["id"]
    monkeypatch.setattr(WechatPay, "create_native", AsyncMock(side_effect=PaymentError(503, "unknown response")))
    query = AsyncMock(side_effect=lambda order: paid_transaction(order))
    monkeypatch.setattr(WechatPay, "query", query)
    result = await client.post("/api/v1/billing/orders", json={
        "package_id": "test", "idempotency_key": "test-order-request-1"
    })
    assert result.status_code == 200 and result.json()["status"] == "paid"
    query.assert_awaited_once()
    assert credit_balance(user_id)["balance"] == 70


async def test_qr_is_owner_only_and_unavailable_after_payment(account_order, options, keys):
    client, mailbox, app, user_id, order = account_order
    path = f"/api/v1/billing/orders/{order['id']}/qr.svg"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN) as anonymous:
        assert (await anonymous.get(path)).status_code == 401
    rendered = await client.get(path)
    assert rendered.status_code == 200 and "<svg" in rendered.text
    assert rendered.headers["cache-control"] == "no-store"
    with auth.get_auth_store().connect() as connection:
        connection.execute("UPDATE payment_orders SET expires_at=0 WHERE id=?", (order["id"],))
    assert (await client.get(path)).status_code == 409
    assert billing.get_order(user_id, order["id"])["code_url"] is None
    with auth.get_auth_store().connect() as connection:
        connection.execute("UPDATE payment_orders SET expires_at=? WHERE id=?", (order["expires_at"], order["id"]))
    body, headers = notification(paid_transaction(order), options, keys)
    assert (await client.post("/api/v1/billing/wechat/notify", content=body, headers=headers)).status_code == 204
    assert (await client.get(path)).status_code == 409
    await login(client, mailbox, "other@example.test")
    assert (await client.get(path)).status_code == 404
