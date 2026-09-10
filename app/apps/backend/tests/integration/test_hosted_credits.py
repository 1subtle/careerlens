"""Hosted grants, provider metering and quota boundaries without paid requests."""

import asyncio
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest

from app import auth, llm
from app.credits import CreditError, _change_credits, credit_balance
from app.hosting import current_user_id, get_hosting_settings
from tests.integration.test_hosted_auth import hosted, isolated_hosting, login  # noqa: F401


@pytest.fixture
def provider(monkeypatch):
    router = MagicMock()
    router.acompletion = AsyncMock()
    config = llm.LLMConfig(provider="deepseek", model="deepseek-chat", api_key="test-only")
    monkeypatch.setattr(llm, "get_router", lambda *_: (router, config))
    monkeypatch.setattr(llm, "_supports_json_mode", lambda *_: False)
    monkeypatch.setattr(llm, "_get_retry_temperature", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(llm, "_supports_temperature", lambda *_args, **_kwargs: False)
    return router.acompletion


def response(content):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


async def test_grant_is_once_and_session_balance_survives_relogin_and_restart(hosted):
    client, mailbox, _ = hosted
    first, _ = await login(client, mailbox, "Person@Example.Test")
    user = first.json()["user"]
    assert user["credits"] == 20
    _change_credits(user["id"], -1)
    assert (await client.get("/api/v1/auth/session")).json()["user"]["credits"] == 19
    auth.get_auth_store().initialize()
    with auth.get_auth_store().connect() as connection:
        connection.execute("UPDATE send_events SET created_at = ?", (time.time() - 61,))
    again, _ = await login(client, mailbox)
    assert again.json()["user"] == {**user, "credits": 19}
    assert (await client.get("/api/v1/auth/credits")).json() == {
        "balance": 19, "signup_grant": 20, "cost_per_generation": 1
    }
    second, _ = await login(client, mailbox, "second@example.test")
    assert second.json()["user"]["credits"] == 20
    assert credit_balance(user["id"])["balance"] == 19


async def test_parallel_debits_cannot_overdraw_or_charge_other_account(hosted):
    client, mailbox, _ = hosted
    first, _ = await login(client, mailbox)
    user_id = first.json()["user"]["id"]
    with auth.get_auth_store().connect() as connection:
        connection.execute("UPDATE credit_accounts SET balance = 3 WHERE user_id = ?", (user_id,))

    def spend(_):
        try:
            _change_credits(user_id, -1)
            return 200
        except CreditError as error:
            return error.status_code

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(spend, range(12)))
    assert results.count(200) == 3
    assert results.count(402) == 9
    assert credit_balance(user_id)["balance"] == 0


async def test_generations_meter_success_retry_failure_and_cancellation(hosted, provider):
    client, mailbox, _ = hosted
    signed_in, _ = await login(client, mailbox)
    user_id = signed_in.json()["user"]["id"]
    token = current_user_id.set(user_id)
    try:
        provider.return_value = response("polished text")
        assert await llm.complete("resume") == "polished text"
        provider.side_effect = [response("invalid json"), response('{"ok": true}')]
        assert await llm.complete_json("resume", schema_type="career") == {"ok": True}
        assert credit_balance(user_id)["balance"] == 18

        provider.side_effect = ValueError("provider rejected request")
        with pytest.raises(ValueError):
            await llm.complete_json("resume", retries=0)
        assert credit_balance(user_id)["balance"] == 18

        started = asyncio.Event()
        async def pending(**kwargs):
            started.set()
            await asyncio.Event().wait()
        provider.side_effect = pending
        worker = asyncio.create_task(llm.complete("resume"))
        await started.wait()
        assert credit_balance(user_id)["balance"] == 17
        worker.cancel()
        with pytest.raises(asyncio.CancelledError):
            await worker
        assert credit_balance(user_id)["balance"] == 18
    finally:
        current_user_id.reset(token)


async def test_zero_balance_and_missing_identity_never_reach_provider(hosted, provider):
    client, mailbox, _ = hosted
    signed_in, _ = await login(client, mailbox)
    user_id = signed_in.json()["user"]["id"]
    with auth.get_auth_store().connect() as connection:
        connection.execute("UPDATE credit_accounts SET balance = 0 WHERE user_id = ?", (user_id,))
    with pytest.raises(CreditError) as denied:
        await llm.complete("resume")
    assert denied.value.status_code == 401
    token = current_user_id.set(user_id)
    try:
        for generate in (llm.complete, llm.complete_json):
            with pytest.raises(CreditError) as exhausted:
                await generate("resume")
            assert exhausted.value.status_code == 402
    finally:
        current_user_id.reset(token)
    provider.assert_not_awaited()


async def test_concurrent_success_and_refund_stay_with_their_users(hosted, provider):
    client, mailbox, _ = hosted
    first, _ = await login(client, mailbox)
    second, _ = await login(client, mailbox, "second@example.test")
    first_id, second_id = (signed.json()["user"]["id"] for signed in (first, second))
    barrier = asyncio.Barrier(2)

    async def complete_provider(**kwargs):
        await barrier.wait()
        if kwargs["messages"][-1]["content"] == "fail":
            raise ValueError("provider rejected request")
        return response("generated")

    async def generate(user_id, prompt):
        token = current_user_id.set(user_id)
        try:
            return await llm.complete(prompt)
        finally:
            current_user_id.reset(token)

    provider.side_effect = complete_provider
    results = await asyncio.gather(
        generate(first_id, "success"), generate(second_id, "fail"),
        return_exceptions=True,
    )
    assert results[0] == "generated" and isinstance(results[1], ValueError)
    assert credit_balance(first_id)["balance"] == 19
    assert credit_balance(second_id)["balance"] == 20
    assert current_user_id.get() is None


@pytest.mark.parametrize("generate", [llm.complete, llm.complete_json])
async def test_provider_errors_do_not_log_private_content_or_credentials(
    generate, provider, caplog
):
    private = "Private applicant phone 13800001234; api_key=synthetic-provider-secret"
    provider.side_effect = ValueError(private)
    with pytest.raises(ValueError):
        if generate is llm.complete_json:
            await generate("resume", retries=0)
        else:
            await generate("resume")
    assert "13800001234" not in caplog.text
    assert "synthetic-provider-secret" not in caplog.text
    assert "ValueError" in caplog.text


async def test_quota_is_402_through_career_http_and_file_fallback(hosted, monkeypatch, provider):
    from app.routers import career

    client, mailbox, app = hosted
    app.include_router(career.router, prefix="/api/v1")
    monkeypatch.setattr(career.career_ai, "model_info", lambda: {"configured": True})
    signed_in, _ = await login(client, mailbox)
    with auth.get_auth_store().connect() as connection:
        connection.execute("UPDATE credit_accounts SET balance = 0 WHERE user_id = ?", (signed_in.json()["user"]["id"],))
    parsed = await client.post("/api/v1/career/resumes/parse", json={"text": "A resume with experience in Python and SQL", "use_ai": True})
    assert parsed.status_code == 402, parsed.text
    uploaded = await client.post("/api/v1/career/resumes/file", files={"file": ("resume.txt", b"A resume with experience in Python and SQL", "text/plain")}, data={"use_ai": "true"})
    assert uploaded.status_code == 402, uploaded.text
    provider.assert_not_awaited()


async def test_hosted_status_has_no_unmetered_provider_probe(hosted, monkeypatch):
    from app.routers import health

    client, mailbox, app = hosted
    app.include_router(health.router, prefix="/api/v1")
    await login(client, mailbox)
    probe = AsyncMock(side_effect=AssertionError("Unmetered paid probe"))
    monkeypatch.setattr(health, "check_llm_health", probe)
    assert (await client.get("/api/v1/status")).status_code == 200
    probe.assert_not_awaited()


async def test_local_mode_has_no_credit_requirement(provider):
    provider.return_value = response("local result")
    assert await llm.complete("resume") == "local result"
    provider.assert_awaited_once()


async def test_configurable_grant_does_not_top_up_existing_accounts(hosted, monkeypatch):
    client, mailbox, _ = hosted
    monkeypatch.setenv("CAREERLENS_SIGNUP_CREDITS", "7")
    get_hosting_settings.cache_clear()
    signed_in, _ = await login(client, mailbox)
    assert signed_in.json()["user"]["credits"] == 7
    monkeypatch.setenv("CAREERLENS_SIGNUP_CREDITS", "40")
    get_hosting_settings.cache_clear()
    auth.get_auth_store().initialize()
    assert (await client.get("/api/v1/auth/credits")).json()["balance"] == 7


def test_old_auth_database_migrates_without_repeated_grants(tmp_path):
    path = tmp_path / "legacy-auth.sqlite"
    user_id = str(uuid4())
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, created_at REAL)")
        connection.execute("INSERT INTO users VALUES (?, ?, ?)", (user_id, "legacy@example.test", time.time()))
    store = auth.AuthStore(path, "test-only")
    store.initialize()
    with store.connect() as connection:
        assert connection.execute("SELECT balance FROM credit_accounts").fetchone()[0] == 20
        connection.execute("UPDATE credit_accounts SET balance = 17")
    store.initialize()
    with store.connect() as connection:
        assert tuple(connection.execute("SELECT balance, granted FROM credit_accounts").fetchone()) == (17, 20)
        assert connection.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 1


async def test_all_main_ai_http_flows_preserve_402(hosted, monkeypatch, provider):
    from app.routers import career, enrichment, resume_wizard, resumes
    from tests.integration.test_career_api import seed

    client, mailbox, app = hosted
    for routes in (career, enrichment, resume_wizard, resumes):
        app.include_router(routes.router, prefix="/api/v1")
    monkeypatch.setattr(career.career_ai, "model_info", lambda: {"configured": True})
    signed_in, _ = await login(client, mailbox)
    with auth.get_auth_store().connect() as connection:
        connection.execute("UPDATE credit_accounts SET balance = 0 WHERE user_id = ?", (signed_in.json()["user"]["id"],))
    resume, job, match = await seed(client)
    identifiers = {"resume_id": resume["id"], "job_id": job["job_id"]}
    requests = [
        ("/career/jobs/parse", {"text": "Python and SQL experience required", "use_ai": True}),
        ("/career/matches", {**identifiers, "use_ai": True}),
        ("/career/directions", {"resume_id": resume["id"], "use_ai": True}),
        ("/career/rewrites", {"match_id": match["id"], "section_id": match["evidence"][0]["id"], "use_ai": True}),
        ("/career/market/analyze", {"question": "分析数据岗位要求", "use_ai": True, "include_demo": True}),
        ("/resumes/improve", identifiers),
        ("/resumes/improve/preview", identifiers),
        (f"/enrichment/analyze/{resume['id']}", {}),
        ("/enrichment/regenerate", {"resume_id": resume["id"], "items": [{"item_id": "skills", "item_type": "skills", "title": "Skills", "current_content": ["SQL"]}], "instruction": "润色", "output_language": "zh"}),
        ("/resume-wizard/turn", {"state": {}, "action": "answer", "answer": {"text": "我有 Python 实习经历"}}),
    ]
    for path, payload in requests:
        result = await client.post("/api/v1" + path, json=payload)
        assert result.status_code == 402, (path, result.text)
    provider.assert_not_awaited()


async def test_manual_application_quota_failure_does_not_create_card(hosted, provider):
    from app.routers import applications

    client, mailbox, app = hosted
    app.include_router(applications.router, prefix="/api/v1")
    signed_in, _ = await login(client, mailbox)
    user_id = signed_in.json()["user"]["id"]
    token = current_user_id.set(user_id)
    try:
        resume = await applications.db.create_resume(
            filename="synthetic.txt", content="Synthetic applicant"
        )
    finally:
        current_user_id.reset(token)
    with auth.get_auth_store().connect() as connection:
        connection.execute(
            "UPDATE credit_accounts SET balance = 0 WHERE user_id = ?", (user_id,)
        )
    result = await client.post(
        "/api/v1/applications",
        json={"resume_id": resume["resume_id"], "job_description": "Python engineer"},
    )
    assert result.status_code == 402, result.text
    token = current_user_id.set(user_id)
    try:
        assert await applications.db.list_applications() == []
        assert (await applications.db.get_stats())["total_jobs"] == 0
    finally:
        current_user_id.reset(token)
    provider.assert_not_awaited()
