"""Authentication regressions use temp SQLite and a no-network SMTP replacement."""

import asyncio
import hashlib
import smtplib
import sqlite3
import sys
import time
from unittest.mock import MagicMock

import pytest
from app.hosting import (
    HostingSettings,
    current_session_cookie,
    current_user_id,
    get_hosting_settings,
    validate_hosting_settings,
)
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from starlette.middleware.cors import CORSMiddleware

from app import auth

ORIGIN = "https://careerlens.example"


@pytest.fixture(autouse=True)
def isolated_hosting(monkeypatch):
    monkeypatch.setenv("CAREERLENS_MODE", "local")
    get_hosting_settings.cache_clear()
    yield
    get_hosting_settings.cache_clear()


@pytest.fixture
async def hosted(monkeypatch, isolated_backend_state):
    from app.database import Database
    from app.tenant_database import TenantDatabaseProxy

    monkeypatch.setenv("CAREERLENS_MODE", "hosted")
    monkeypatch.setenv("CAREERLENS_PUBLIC_URL", ORIGIN)
    monkeypatch.setenv("CAREERLENS_AUTH_SECRET", "test-only-secret-" * 3)
    monkeypatch.setenv("CAREERLENS_SMTP_HOST", "smtp.example.test")
    monkeypatch.setenv("CAREERLENS_SMTP_FROM", "login@example.test")
    get_hosting_settings.cache_clear()
    validate_hosting_settings()
    auth.get_auth_store().initialize()
    proxy = TenantDatabaseProxy(isolated_backend_state, Database)
    for name, module in tuple(sys.modules.items()):
        if name.startswith("app.") and getattr(module, "db", None) is isolated_backend_state:
            monkeypatch.setattr(module, "db", proxy)
    mailbox = []
    monkeypatch.setattr(
        auth, "send_code", lambda email, code: mailbox.append((email, code))
    )
    app = FastAPI()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[ORIGIN],
        allow_credentials=True,
        allow_methods=["*"],
    )
    app.add_middleware(auth.HostingAuthMiddleware)
    app.include_router(auth.router, prefix="/api/v1")

    @app.get("/api/v1/private")
    @app.post("/api/v1/private")
    async def private():
        before = current_user_id.get()
        await asyncio.sleep(0)
        return {
            "id": before,
            "after": current_user_id.get(),
            "thread": await asyncio.to_thread(current_user_id.get),
        }

    @app.get("/api/v1/health")
    async def health():
        return {"status": "healthy"}

    @app.get("/api/v1/config/language")
    async def language():
        return {"language": "zh"}

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}
    ) as client:
        yield client, mailbox, app
    await proxy.close()
    assert current_user_id.get() is None
    assert current_session_cookie.get() is None


async def login(client, mailbox, email="person@example.test"):
    started = await client.post("/api/v1/auth/email/start", json={"email": email})
    assert started.status_code == 200, started.text
    payload = {
        "email": email,
        "challenge_id": started.json()["challenge_id"],
        "code": mailbox[-1][1],
    }
    response = await client.post("/api/v1/auth/email/verify", json=payload)
    assert response.status_code == 200, response.text
    return response, payload


async def test_login_cookie_hashes_and_logout_revocation(hosted):
    client, mailbox, _ = hosted
    public = await client.get("/api/v1/auth/session")
    assert public.json() == {
        "mode": "hosted",
        "user": None,
        "email_login_available": True,
        "github_url": None,
    }
    response, payload = await login(client, mailbox, "Person@Example.Test")
    user = response.json()["user"]
    assert user["email"] == "person@example.test"
    cookie_header = response.headers["set-cookie"]
    for flag in ("HttpOnly", "Secure", "SameSite=lax", "Path=/", "Max-Age=604800"):
        assert flag in cookie_header
    assert "Domain=" not in cookie_header
    token = client.cookies.get("__Host-careerlens_session")
    with auth.get_auth_store().connect() as connection:
        session_hash = connection.execute("SELECT token_hash FROM sessions").fetchone()[
            0
        ]
        code_hash = connection.execute("SELECT code_hash FROM challenges").fetchone()[0]
    assert session_hash == hashlib.sha256(token.encode()).hexdigest()
    assert payload["code"] not in response.text
    assert (
        code_hash != payload["code"]
        and code_hash != hashlib.sha256(payload["code"].encode()).hexdigest()
    )
    identity = await client.get("/api/v1/private")
    assert identity.json() == {
        "id": user["id"],
        "after": user["id"],
        "thread": user["id"],
    }
    assert identity.headers["cache-control"] == "no-store"
    assert (await client.get("/api/v1/auth/session")).json()["user"] == user
    assert (await client.post("/api/v1/auth/logout")).json()["user"] is None
    client.cookies.set("__Host-careerlens_session", token)
    assert (await client.get("/api/v1/private")).status_code == 401
    assert auth.get_auth_store().session(token) is None


async def test_expiry_replay_and_atomic_attempt_limit(hosted):
    client, mailbox, _ = hosted
    started = (
        await client.post(
            "/api/v1/auth/email/start", json={"email": "person@example.test"}
        )
    ).json()
    payload = {
        "email": started["email"],
        "challenge_id": started["challenge_id"],
        "code": "999999" if mailbox[-1][1] != "999999" else "888888",
    }
    attempts = await asyncio.gather(
        *(client.post("/api/v1/auth/email/verify", json=payload) for _ in range(8))
    )
    assert all(response.status_code == 400 for response in attempts)
    with auth.get_auth_store().connect() as connection:
        assert connection.execute("SELECT attempts FROM challenges").fetchone()[0] == 5
    payload["code"] = mailbox[-1][1]
    assert (
        await client.post("/api/v1/auth/email/verify", json=payload)
    ).status_code == 400
    response, good = await login(client, mailbox, "second@example.test")
    assert (
        await client.post("/api/v1/auth/email/verify", json=good)
    ).status_code == 400
    assert response.json()["user"] is not None
    token = client.cookies.get("__Host-careerlens_session")
    with auth.get_auth_store().connect() as connection:
        connection.execute("UPDATE sessions SET expires_at = ?", (time.time() - 1,))
    assert auth.get_auth_store().session(token) is None
    assert (await client.get("/api/v1/private")).status_code == 401


async def test_expired_or_wrong_email_code_never_logs_in(hosted):
    client, mailbox, _ = hosted
    started = (
        await client.post(
            "/api/v1/auth/email/start", json={"email": "person@example.test"}
        )
    ).json()
    payload = {
        "email": "other@example.test",
        "challenge_id": started["challenge_id"],
        "code": mailbox[-1][1],
    }
    assert (
        await client.post("/api/v1/auth/email/verify", json=payload)
    ).status_code == 400
    payload["email"] = started["email"]
    with auth.get_auth_store().connect() as connection:
        connection.execute("UPDATE challenges SET expires_at = ?", (time.time() - 1,))
    assert (
        await client.post("/api/v1/auth/email/verify", json=payload)
    ).status_code == 400


async def test_csrf_auth_config_and_docs_default_deny(hosted):
    client, mailbox, _ = hosted
    assert (await client.get("/api/v1/private")).status_code == 401
    assert (await client.get("/api/v1/future-sensitive-endpoint")).status_code == 401
    assert (await client.get("/api/v1/health")).json() == {"status": "healthy"}
    for origin in (
        "",
        "null",
        "https://careerlens.example.evil.test",
        "https://other.example",
    ):
        result = await client.post(
            "/api/v1/auth/email/start",
            json={"email": "person@example.test"},
            headers={"Origin": origin},
        )
        assert result.status_code == 403
    client.headers.pop("Origin")
    assert (await client.post("/api/v1/auth/logout")).status_code == 403
    client.headers["Origin"] = ORIGIN
    await login(client, mailbox)
    for path in (
        "/api/v1/config",
        "/api/v1/config/llm",
        "/api/v1/config/api-keys",
        "/api/v1/config/prompts",
        "/api/v1/config/features",
    ):
        assert (await client.get(path)).status_code == 403
    assert (await client.get("/api/v1/config/language")).status_code == 200
    assert (
        await client.put("/api/v1/config/language", json={"language": "en"})
    ).status_code == 403
    assert (
        await client.post("/api/v1/private", headers={"Origin": "https://evil.test"})
    ).status_code == 403
    for path in ("/docs", "/docs/", "/docs/oauth2-redirect", "/redoc", "/openapi.json"):
        assert (await client.get(path)).status_code == 404
    assert (
        await client.options(
            "/api/v1/private",
            headers={
                "Origin": "https://evil.test",
                "Access-Control-Request-Method": "POST",
            },
        )
    ).status_code == 403


async def test_resend_limits_smtp_failure_and_no_secret_logging(
    hosted, monkeypatch, caplog
):
    client, mailbox, _ = hosted
    email = "person@example.test"
    first = await client.post("/api/v1/auth/email/start", json={"email": email})
    assert first.status_code == 200
    assert first.json()["retry_after_seconds"] == 60
    assert first.json()["expires_in_seconds"] == 600
    assert len(mailbox) == 1
    assert (
        await client.post("/api/v1/auth/email/start", json={"email": email})
    ).status_code == 429

    def fail(email, code):
        raise smtplib.SMTPException("sensitive SMTP detail " + code)

    monkeypatch.setattr(auth, "send_code", fail)
    failed = await client.post(
        "/api/v1/auth/email/start", json={"email": "second@example.test"}
    )
    assert failed.status_code == 503
    assert "sensitive" not in failed.text and "sensitive" not in caplog.text
    assert mailbox[0][1] not in caplog.text
    with auth.get_auth_store().connect() as connection:
        assert (
            connection.execute(
                "SELECT consumed FROM challenges WHERE email = ?",
                ("second@example.test",),
            ).fetchone()[0]
            == 1
        )


async def test_hourly_email_and_ip_limits_are_persistent(hosted):
    client, _, _ = hosted
    store = auth.get_auth_store()
    now = time.time()
    with store.connect() as connection:
        connection.executemany(
            "INSERT INTO send_events VALUES (?, ?, ?)",
            [("person@example.test", "other", now - 100 - i * 70) for i in range(5)],
        )
    assert (
        await client.post(
            "/api/v1/auth/email/start", json={"email": "person@example.test"}
        )
    ).status_code == 429
    with store.connect() as connection:
        connection.executemany(
            "INSERT INTO send_events VALUES (?, ?, ?)",
            [
                (f"user{i}@example.test", store.digest("ip:127.0.0.1"), now - 100)
                for i in range(20)
            ],
        )
    assert (
        await client.post(
            "/api/v1/auth/email/start", json={"email": "another@example.test"}
        )
    ).status_code == 429


async def test_client_forwarding_headers_cannot_choose_otp_rate_limit_identity(hosted):
    client, mailbox, _ = hosted
    store = auth.get_auth_store()
    with store.connect() as connection:
        connection.executemany(
            "INSERT INTO send_events VALUES (?, ?, ?)",
            [
                (f"user{i}@example.test", store.digest("ip:127.0.0.1"), time.time())
                for i in range(20)
            ],
        )
    result = await client.post(
        "/api/v1/auth/email/start",
        json={"email": "fresh@example.test"},
        headers={"X-Forwarded-For": "198.51.100.23", "X-Real-IP": "198.51.100.24"},
    )
    assert result.status_code == 429
    assert mailbox == []


async def test_two_users_concurrent_contexts_do_not_leak(hosted):
    first, mailbox, app = hosted
    one, _ = await login(first, mailbox, "first@example.test")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}
    ) as second:
        two, _ = await login(second, mailbox, "second@example.test")
        calls = await asyncio.gather(
            first.get("/api/v1/private"), second.get("/api/v1/private")
        )
        assert calls[0].json()["id"] == one.json()["user"]["id"]
        assert calls[1].json()["id"] == two.json()["user"]["id"]
        assert calls[0].json()["id"] != calls[1].json()["id"]


async def test_parallel_resends_create_only_one_deliverable_challenge(hosted):
    client, mailbox, _ = hosted
    responses = await asyncio.gather(
        *(
            client.post(
                "/api/v1/auth/email/start", json={"email": "person@example.test"}
            )
            for _ in range(6)
        )
    )
    assert sorted(response.status_code for response in responses) == [
        200,
        429,
        429,
        429,
        429,
        429,
    ]
    assert len(mailbox) == 1


async def test_concurrent_successful_verifications_consume_code_once(hosted):
    client, mailbox, _ = hosted
    started = (
        await client.post(
            "/api/v1/auth/email/start", json={"email": "person@example.test"}
        )
    ).json()
    payload = {
        "email": started["email"],
        "challenge_id": started["challenge_id"],
        "code": mailbox[-1][1],
    }
    responses = await asyncio.gather(
        *(client.post("/api/v1/auth/email/verify", json=payload) for _ in range(2))
    )
    assert sorted(response.status_code for response in responses) == [200, 400]
    with auth.get_auth_store().connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1


async def test_auth_store_failure_is_503_and_health_stays_public(hosted, monkeypatch):
    client, _, _ = hosted

    def failure(*args):
        raise sqlite3.OperationalError("private storage detail")

    monkeypatch.setattr(auth.AuthStore, "prepare", failure)
    result = await client.post(
        "/api/v1/auth/email/start", json={"email": "person@example.test"}
    )
    assert result.status_code == 503
    assert "private storage" not in result.text
    client.cookies.set("__Host-careerlens_session", "a" * 43)
    monkeypatch.setattr(auth.AuthStore, "session", failure)
    assert (await client.get("/api/v1/private")).status_code == 503
    assert (await client.get("/api/v1/health")).status_code == 200


async def test_unconfigured_smtp_reports_unavailable(hosted, monkeypatch):
    client, mailbox, _ = hosted
    monkeypatch.setenv("CAREERLENS_SMTP_HOST", "")
    monkeypatch.setenv("CAREERLENS_SMTP_FROM", "")
    get_hosting_settings.cache_clear()
    assert (await client.get("/api/v1/auth/session")).json()[
        "email_login_available"
    ] is False
    assert (
        await client.post(
            "/api/v1/auth/email/start", json={"email": "person@example.test"}
        )
    ).status_code == 503
    assert mailbox == []


async def test_auth_validation_never_echoes_rejected_code(hosted):
    client, _, _ = hosted
    result = await client.post(
        "/api/v1/auth/email/verify",
        json={
            "email": "person@example.test",
            "challenge_id": "a" * 43,
            "code": "sensitive-invalid-otp",
        },
    )
    assert result.status_code == 422
    assert isinstance(result.json()["detail"], str)
    assert "sensitive-invalid-otp" not in result.text


async def test_real_app_has_hosted_boundary_and_skips_personal_migration(
    hosted, monkeypatch
):
    from unittest.mock import AsyncMock

    from app.main import app

    from app.scripts import migrate_tinydb_to_sqlite

    migration = AsyncMock(
        side_effect=AssertionError("Hosted must not import local personal data")
    )
    monkeypatch.setattr(migrate_tinydb_to_sqlite, "migrate", migration)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url=ORIGIN) as client,
    ):
        assert (await client.get("/api/v1/career/resumes")).status_code == 401
        assert (await client.get("/api/v1/resumes")).status_code == 401
        assert (await client.get("/api/v1/status")).status_code == 401
        assert (await client.get("/api/v1/auth/session")).json()["mode"] == "hosted"
        assert (await client.get("/openapi.json")).status_code == 404
    migration.assert_not_called()


async def test_second_login_reuses_account_and_rotates_current_session(hosted):
    client, mailbox, _ = hosted
    first, _ = await login(client, mailbox)
    old_token = client.cookies.get("__Host-careerlens_session")
    with auth.get_auth_store().connect() as connection:
        connection.execute("UPDATE send_events SET created_at = ?", (time.time() - 61,))
    second, _ = await login(client, mailbox)
    assert first.json()["user"] == second.json()["user"]
    assert auth.get_auth_store().session(old_token) is None
    assert client.cookies.get("__Host-careerlens_session") != old_token
    with auth.get_auth_store().connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 1


def test_new_delivered_challenge_supersedes_prior_code(hosted):
    store = auth.get_auth_store()
    old_id, old_code = store.prepare("person@example.test", "127.0.0.1")
    with store.connect() as connection:
        connection.execute("UPDATE send_events SET created_at = ?", (time.time() - 61,))
    new_id, new_code = store.prepare("person@example.test", "127.0.0.1")
    store.delivery(new_id, True)
    store.delivery(old_id, True)
    with pytest.raises(auth.HTTPException):
        store.verify("person@example.test", old_id, old_code, None)
    user, _ = store.verify("person@example.test", new_id, new_code, None)
    assert user["email"] == "person@example.test"


async def test_local_mode_preserves_direct_access_and_session():
    from app.main import app

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/api/v1/auth/session")
        assert response.json()["mode"] == "local"
        assert response.json()["user"] is None
        assert (await client.get("/api/v1/health")).status_code == 200
        assert (await client.get("/openapi.json")).status_code == 200
        assert (await client.post("/api/v1/auth/logout")).status_code == 200


@pytest.mark.parametrize(
    "url,secret,valid",
    [
        ("https://career.example", "x" * 32, True),
        ("HTTPS://CAREER.EXAMPLE:443/", "x" * 32, True),
        ("http://localhost:3000", "x" * 32, True),
        ("http://career.example", "x" * 32, False),
        ("https://career.example/path", "x" * 32, False),
        ("https://user:password@career.example", "x" * 32, False),
        ("https://career.example", "short", False),
        ("https://career.example:0", "x" * 32, False),
        ("https://career.example:99999", "x" * 32, False),
    ],
)
def test_hosted_startup_configuration_validation(monkeypatch, url, secret, valid):
    monkeypatch.setenv("CAREERLENS_MODE", "hosted")
    monkeypatch.setenv("CAREERLENS_PUBLIC_URL", url)
    monkeypatch.setenv("CAREERLENS_AUTH_SECRET", secret)
    get_hosting_settings.cache_clear()
    if valid:
        validate_hosting_settings()
    else:
        with pytest.raises(ValueError):
            validate_hosting_settings()


@pytest.mark.parametrize(
    "url,origin,secure",
    [
        ("HTTPS://CAREER.EXAMPLE:443/", "https://career.example", True),
        ("https://Career.Example:8443", "https://career.example:8443", True),
        ("HTTP://LOCALHOST:80/", "http://localhost", False),
        ("http://[::1]:3000/", "http://[::1]:3000", False),
    ],
)
def test_public_origin_is_canonical_and_https_always_secures_cookie(
    url, origin, secure
):
    options = HostingSettings(public_url=url, _env_file=None)
    assert options.public_origin == origin
    assert options.secure_cookie is secure
    assert options.cookie_name.startswith("__Host-") is secure


async def test_normalized_deployment_url_accepts_browser_origin_and_secure_login(
    hosted, monkeypatch
):
    client, mailbox, _ = hosted
    monkeypatch.setenv("CAREERLENS_PUBLIC_URL", "HTTPS://CAREERLENS.EXAMPLE:443/")
    get_hosting_settings.cache_clear()
    validate_hosting_settings()
    response, _ = await login(client, mailbox)
    assert "Secure" in response.headers["set-cookie"]
    assert "__Host-careerlens_session=" in response.headers["set-cookie"]


def test_smtp_uses_tls_and_does_not_log_or_fake_delivery(monkeypatch):
    options = HostingSettings(
        mode="hosted",
        smtp_host="smtp.example.test",
        smtp_username="sender",
        smtp_password="not-real",
        smtp_from="login@example.test",
    )
    monkeypatch.setattr(auth, "get_hosting_settings", lambda: options)
    smtp = MagicMock()
    smtp.__enter__.return_value = smtp
    smtp.send_message.return_value = {}
    constructor = MagicMock(return_value=smtp)
    monkeypatch.setattr(auth.smtplib, "SMTP", constructor)
    auth.send_code("person@example.test", "123456")
    assert smtp.starttls.call_count == 1
    smtp.login.assert_called_once_with("sender", "not-real")
    assert "123456" in smtp.send_message.call_args.args[0].get_content()
    smtp.send_message.return_value = {"person@example.test": (550, "rejected")}
    with pytest.raises(smtplib.SMTPRecipientsRefused):
        auth.send_code("person@example.test", "123456")


async def test_auth_connections_enforce_credit_account_ownership(hosted):
    client, mailbox, _ = hosted
    signed_in, _ = await login(client, mailbox)
    user_id = signed_in.json()["user"]["id"]
    store = auth.get_auth_store()
    # The PRAGMA is connection-local; both independent connections must enforce it.
    for _ in range(2):
        with store.connect() as connection:
            with pytest.raises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO credit_accounts (user_id,balance,granted) VALUES (?, 20, 20)", ("missing-user",)
                )
            with pytest.raises(sqlite3.IntegrityError):
                connection.execute("DELETE FROM users WHERE id = ?", (user_id,))
            assert connection.execute(
                "SELECT balance FROM credit_accounts WHERE user_id = ?", (user_id,)
            ).fetchone()[0] == 20
