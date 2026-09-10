"""Real account storage and authenticated, isolated personal-center requests."""

import re
import time

import pytest
from httpx import ASGITransport, AsyncClient

from app import auth
from app.hosting import current_user_id
from app.routers import account
from tests.integration.test_hosted_auth import ORIGIN, hosted, isolated_hosting, login  # noqa: F401


@pytest.fixture
async def account_client(hosted):
    client, mailbox, app = hosted
    app.include_router(account.router, prefix="/api/v1")
    return client, mailbox, app


def allow_resend():
    with auth.get_auth_store().connect() as connection:
        connection.execute("UPDATE send_events SET created_at=?", (time.time() - 61,))


async def test_preferences_persist_across_login_and_stay_with_their_account(account_client):
    client, mailbox, _ = account_client
    signed, _ = await login(client, mailbox)
    first_id = signed.json()["user"]["id"]
    initial = (await client.get("/api/v1/account/profile")).json()
    assert initial == {"id": first_id, "email": "person@example.test", "created_at": initial["created_at"],
                       "display_name": "", "ui_language": "zh", "content_language": "zh", "timezone": "Asia/Shanghai"}
    preferences = {"display_name": "Ada", "ui_language": "en", "content_language": "ja", "timezone": "Europe/London"}
    changed = await client.patch("/api/v1/account/profile", json=preferences)
    assert changed.status_code == 200
    assert changed.json() == {**initial, **preferences}
    assert changed.headers["cache-control"] == "no-store"
    other, _ = await login(client, mailbox, "other@example.test")
    other_profile = (await client.get("/api/v1/account/profile")).json()
    assert other_profile["id"] == other.json()["user"]["id"]
    assert other_profile["display_name"] == "" and other_profile["ui_language"] == "zh"
    allow_resend()
    auth.get_auth_store().initialize()
    await login(client, mailbox)
    assert (await client.get("/api/v1/account/profile")).json() == {**initial, **preferences}
    assert (await client.patch("/api/v1/account/profile", json={"display_name": "Grace"})).json()["ui_language"] == "en"


@pytest.mark.parametrize("payload", [
    {"ui_language": "xx"}, {"content_language": "xx"}, {"timezone": "Mars/Olympus"},
    {"timezone": "/etc/passwd"}, {"display_name": "x" * 81}, {"display_name": "name\x00"},
    {"id": "other-user"}, {"email": "other@example.test"}, {"ui_language": None},
])
async def test_invalid_preferences_cannot_change_profile(account_client, payload):
    client, mailbox, _ = account_client
    await login(client, mailbox)
    before = (await client.get("/api/v1/account/profile")).json()
    assert (await client.patch("/api/v1/account/profile", json=payload)).status_code == 422
    assert (await client.get("/api/v1/account/profile")).json() == before


async def test_sessions_expose_opaque_ids_and_revoke_only_other_owned_logins(account_client):
    client, mailbox, app = account_client
    client.headers["user-agent"] = "Mozilla/5.0 (Macintosh) Chrome/120.0 raw-private-marker"
    await login(client, mailbox)
    current_token = client.cookies.get("__Host-careerlens_session")
    async with AsyncClient(transport=ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}) as second:
        allow_resend()
        await login(second, mailbox)
        second_token = second.cookies.get("__Host-careerlens_session")
        items_response = await client.get("/api/v1/account/sessions")
        assert "token_hash" not in items_response.text and current_token not in items_response.text
        assert second_token not in items_response.text and "raw-private-marker" not in items_response.text
        items = items_response.json()["items"]
        assert len(items) == 2 and items[0]["current"] is True and items[1]["current"] is False
        assert items[0]["user_agent"] == "Chrome · Mac"
        assert all(re.fullmatch(r"[0-9a-f]{32}", item["id"]) for item in items)
        assert all(0 < item["created_at"] < item["expires_at"] for item in items)
        assert (await client.delete(f"/api/v1/account/sessions/{items[0]['id']}")).status_code == 409
        async with AsyncClient(transport=ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}) as other:
            await login(other, mailbox, "other@example.test")
            assert (await other.delete(f"/api/v1/account/sessions/{items[1]['id']}")).status_code == 404
            assert len((await other.get("/api/v1/account/sessions")).json()["items"]) == 1
            assert (await client.delete(f"/api/v1/account/sessions/{items[1]['id']}")).status_code == 204
            assert auth.get_auth_store().session(second_token) is None
            assert (await second.get("/api/v1/account/profile")).status_code == 401
            second.cookies.clear()
            allow_resend()
            await login(second, mailbox)
            assert (await client.post("/api/v1/account/sessions/revoke-others")).json() == {"revoked": 1}
            assert (await client.post("/api/v1/account/sessions/revoke-others")).json() == {"revoked": 0}
            assert (await client.get("/api/v1/account/profile")).status_code == 200
            assert (await second.get("/api/v1/account/profile")).status_code == 401
            assert (await other.get("/api/v1/account/profile")).status_code == 200


async def test_account_export_contains_only_owned_workspace_and_no_internal_secrets(account_client):
    client, mailbox, app = account_client
    signed, code = await login(client, mailbox)
    first_id = signed.json()["user"]["id"]
    cookie = client.cookies.get("__Host-careerlens_session")
    token = current_user_id.set(first_id)
    try:
        own = await account.db.create_resume_atomic_master(content="First account private resume", content_type="md")
        await account.db.claim_resume_processing(own["resume_id"])
        account.db.set_api_key_ciphertext("synthetic", "must-not-export-provider-key")
    finally:
        current_user_id.reset(token)
    async with AsyncClient(transport=ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}) as other:
        signed_other, _ = await login(other, mailbox, "other@example.test")
        token = current_user_id.set(signed_other.json()["user"]["id"])
        try:
            await account.db.create_resume_atomic_master(content="Second account private resume", content_type="md")
        finally:
            current_user_id.reset(token)
    result = await client.get("/api/v1/account/export")
    assert result.status_code == 200 and result.headers["content-type"].startswith("application/json")
    assert result.headers["content-disposition"].startswith("attachment;")
    assert result.headers["cache-control"] == "no-store"
    value = result.json()
    assert set(value) == {"exported_at", "profile", "workspace"}
    assert value["profile"]["id"] == first_id
    assert value["workspace"]["resumes"][0]["resume_id"] == own["resume_id"]
    assert "First account private resume" in result.text
    for secret in ("Second account private resume", "must-not-export-provider-key", "processing_token",
                   "claim_token", "token_hash", "api_keys", cookie, code["code"]):
        assert secret not in result.text
    assert len(value["workspace"]["resumes"]) == 1
    assert all(isinstance(rows, list) for rows in value["workspace"].values())


@pytest.mark.parametrize("method,path", [
    ("GET", "/profile"), ("PATCH", "/profile"), ("GET", "/sessions"),
    ("DELETE", "/sessions/" + "a" * 32), ("POST", "/sessions/revoke-others"), ("GET", "/export"),
])
async def test_account_routes_require_authentication(account_client, method, path):
    client, _, _ = account_client
    assert (await client.request(method, "/api/v1/account" + path)).status_code == 401
