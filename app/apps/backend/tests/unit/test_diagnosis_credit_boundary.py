"""Exercise diagnosis failures through real validation, credit settlement and SQLite."""

import asyncio
import json

import pytest
from sqlalchemy import func, select

from app.credits import charge_generation, credit_balance, refund_failed_generations
from app.hosting import current_user_id
from app.models import MatchRecord, ResumeSnapshot
from app.routers import career
from app.services import career_ai
from tests.integration.test_career_diagnosis import JD_TEXT, RESUME_TEXT, assessment
from tests.integration.test_hosted_auth import hosted, isolated_hosting, login  # noqa: F401
from tests.integration.test_hosted_credits import provider, response  # noqa: F401


@pytest.mark.parametrize(
    "failure,expected_calls,expected_cost",
    [
        ("unknown_source", 2, 0),
        ("invalid_json", 2, 0),
        ("provider_error", 1, 0),
    ],
)
async def test_failed_diagnosis_settlement_preserves_resume_and_matching_history(
    hosted, provider, monkeypatch, failure, expected_calls, expected_cost
):
    client, mailbox, app = hosted
    app.include_router(career.router, prefix="/api/v1")
    monkeypatch.setattr(
        career_ai, "model_info",
        lambda: {"configured": True, "provider": "mock", "model": "credit-test"},
    )
    signed_in, _ = await login(client, mailbox)
    user_id = signed_in.json()["user"]["id"]
    original_balance = credit_balance(user_id)["balance"]
    resume = (await client.post(
        "/api/v1/career/resumes",
        json={"title": "Synthetic credit boundary", "data": {
            "personalProjects": [{"name": "用户访谈", "description": [RESUME_TEXT]}],
        }},
    )).json()
    job = (await client.post(
        "/api/v1/career/jobs",
        json={"title": "产品助理", "company": "测试公司", "text": JD_TEXT},
    )).json()
    payload = {"resume_id": resume["id"], "job_id": job["job_id"], "use_ai": False}
    existing = await client.post("/api/v1/career/matches", json=payload)
    assert existing.status_code == 200, existing.text
    before = (await client.get("/api/v1/career/state")).json()
    calls = []

    async def generate(**kwargs):
        prompt = kwargs["messages"][-1]["content"]
        calls.append(prompt)
        if failure == "provider_error":
            raise RuntimeError("synthetic provider failure")
        if failure == "invalid_json":
            return response("not valid JSON")
        value = assessment()
        value["strengths"][0]["resume_refs"][0]["evidence_id"] = "missing-source"
        return response(json.dumps(value, ensure_ascii=False))

    provider.side_effect = generate
    failed = await client.post("/api/v1/career/matches", json={**payload, "use_ai": True})
    assert failed.status_code in (422, 502), failed.text
    assert len(calls) == expected_calls
    assert credit_balance(user_id)["balance"] == original_balance - expected_cost
    after = (await client.get("/api/v1/career/state")).json()
    for key in ("resumes", "jobs", "matches"):
        assert after[key] == before[key]
    token = current_user_id.set(user_id)
    try:
        async with career.db._session() as session:
            for model in (ResumeSnapshot, MatchRecord):
                assert await session.scalar(select(func.count()).select_from(model)) == 1
    finally:
        current_user_id.reset(token)


@pytest.fixture
async def account(hosted):
    client, mailbox, _ = hosted
    signed_in, _ = await login(client, mailbox)
    user_id = signed_in.json()["user"]["id"]
    token = current_user_id.set(user_id)
    try:
        yield user_id
    finally:
        current_user_id.reset(token)


@charge_generation
async def generate(fail=False):
    if fail:
        raise ValueError("generation failed")
    return "generated"


@pytest.mark.parametrize("fail,expected_cost", [(False, 3), (True, 0)])
async def test_nested_scopes_keep_success_cost_and_refund_failure_once(account, fail, expected_cost):
    before = credit_balance(account)["balance"]

    @refund_failed_generations
    async def inner():
        await generate()
        return await generate(fail)

    @refund_failed_generations
    async def operation():
        await generate()
        return await inner()

    if fail:
        with pytest.raises(ValueError):
            await operation()
    else:
        assert await operation() == "generated"
    assert credit_balance(account)["balance"] == before - expected_cost


async def test_failed_scope_does_not_refund_other_concurrent_operation(account):
    before = credit_balance(account)["balance"]
    ready, release = asyncio.Event(), asyncio.Event()

    @refund_failed_generations
    async def successful():
        await generate()
        ready.set()
        await release.wait()
        return "saved"

    @refund_failed_generations
    async def failing():
        await ready.wait()
        await generate()
        release.set()
        raise ValueError("save failed")

    results = await asyncio.gather(successful(), failing(), return_exceptions=True)
    assert results[0] == "saved" and isinstance(results[1], ValueError)
    assert credit_balance(account)["balance"] == before - 1


async def test_repeated_cancellation_waits_for_child_refund_before_settlement(account):
    before = credit_balance(account)["balance"]
    started, cancelling, finish = asyncio.Event(), asyncio.Event(), asyncio.Event()
    children = []

    @charge_generation
    async def pending():
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelling.set()
            await finish.wait()
            raise

    @refund_failed_generations
    async def operation():
        await generate()
        children.append(asyncio.create_task(pending()))
        await started.wait()
        await asyncio.Event().wait()

    worker = asyncio.create_task(operation())
    await started.wait()
    assert credit_balance(account)["balance"] == before - 2
    worker.cancel()
    await cancelling.wait()
    worker.cancel()
    await asyncio.sleep(0)
    assert not worker.done()
    finish.set()
    with pytest.raises(asyncio.CancelledError):
        await worker
    assert all(child.done() and child.cancelled() for child in children)
    assert credit_balance(account)["balance"] == before


async def test_late_inherited_child_cannot_charge_after_failed_scope(account):
    before = credit_balance(account)["balance"]
    release = asyncio.Event()
    children = []

    async def delayed():
        await release.wait()
        return await generate()

    @refund_failed_generations
    async def operation():
        await generate()
        children.append(asyncio.create_task(delayed()))
        raise ValueError("operation failed")

    with pytest.raises(ValueError):
        await operation()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await children[0]
    assert credit_balance(account)["balance"] == before
