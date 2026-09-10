"""Real SQLite files verify durable billing and tenant-result transaction boundaries."""

import asyncio
import time
from uuid import uuid4

import pytest

from app import auth, credits
from app.config import settings
from app.database import Database
from app.hosting import current_user_id
from app.models import Resume
from app.tenant_database import TenantContextError
from tests.integration.test_hosted_auth import hosted, isolated_hosting, login  # noqa: F401


@pytest.fixture
async def account_database(hosted):
    client, mailbox, _ = hosted
    signed_in, _ = await login(client, mailbox)
    user_id = signed_in.json()["user"]["id"]
    database = Database(settings.data_dir / "users" / user_id / "workspace.sqlite", pooled=False)
    token = current_user_id.set(user_id)
    try:
        yield user_id, database
    finally:
        current_user_id.reset(token)
        await database.close()


@credits.charge_generation
async def generate():
    return "synthetic generated content"


def billing_rows(user_id):
    with auth.get_auth_store().connect() as connection:
        return [dict(row) for row in connection.execute(
            "SELECT * FROM credit_ledger WHERE user_id=? ORDER BY id", (user_id,)
        )]


def assert_account(user_id, balance, reserved=0):
    account = credits.account_balance(user_id)
    assert (account["balance"], account["reserved"]) == (balance, reserved)
    entries = billing_rows(user_id)
    assert sum(row["balance_delta"] for row in entries) == balance
    assert sum(row["reserved_delta"] for row in entries) == reserved
    assert (entries[-1]["balance_after"], entries[-1]["reserved_after"]) == (balance, reserved)


@pytest.mark.parametrize("failure", [None, "before_commit", "during_settlement", "after_commit"])
async def test_result_and_billing_commit_or_rollback_together(account_database, monkeypatch, failure):
    user_id, database = account_database
    resume_id = uuid4().hex
    original_ledger = credits.record_ledger

    def record(*args, **kwargs):
        original_ledger(*args, **kwargs)
        if args[3] == "spend" and failure == "during_settlement":
            raise RuntimeError("synthetic ledger write failure after spend")

    monkeypatch.setattr(credits, "record_ledger", record)

    @credits.refund_failed_generations
    async def operation():
        content = await generate()
        assert_account(user_id, 19, 1)
        async with database._account_session() as session:
            session.add(Resume(resume_id=resume_id, content=content))
            await session.flush()
            if failure == "before_commit":
                raise RuntimeError("synthetic business failure after flush")
            await session.commit()
        if failure == "after_commit":
            raise RuntimeError("synthetic response failure after durable commit")

    if failure:
        with pytest.raises(RuntimeError, match="synthetic"):
            await operation()
    else:
        await operation()
    committed = failure in (None, "after_commit")
    assert (await database.get_resume(resume_id) is not None) is committed
    assert_account(user_id, 19 if committed else 20)
    assert [row["kind"] for row in billing_rows(user_id)] == [
        "grant", "hold", "spend" if committed else "release"
    ]
    with auth.get_auth_store().connect() as connection:
        assert connection.execute("SELECT status FROM credit_operations").fetchone()[0] == (
            "settled" if committed else "released"
        )


async def test_wrong_tenant_file_cannot_receive_result_or_charge(account_database):
    user_id, _ = account_database
    wrong = Database(settings.data_dir / "users" / str(uuid4()) / "workspace.sqlite")

    @credits.refund_failed_generations
    async def operation():
        await generate()
        async with wrong._account_session() as session:
            session.add(Resume(resume_id="wrong-tenant", content="private result"))
            await session.commit()

    try:
        with pytest.raises(TenantContextError):
            await operation()
        assert not wrong.db_path.exists()
        assert_account(user_id, 20)
    finally:
        await wrong.close()


async def test_cancelled_business_transaction_rolls_back_and_releases(account_database):
    user_id, database = account_database
    flushed = asyncio.Event()

    @credits.refund_failed_generations
    async def operation():
        await generate()
        async with database._account_session() as session:
            session.add(Resume(resume_id="cancelled", content="private result"))
            await session.flush()
            flushed.set()
            await asyncio.Event().wait()

    task = asyncio.create_task(operation())
    await flushed.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert await database.get_resume("cancelled") is None
    assert_account(user_id, 20)


async def test_commit_refuses_unfinished_generation_and_waits_for_cancellation(account_database):
    user_id, database = account_database
    entered, exited = asyncio.Event(), asyncio.Event()

    @credits.charge_generation
    async def unfinished():
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0)
            exited.set()

    @credits.refund_failed_generations
    async def operation():
        asyncio.create_task(unfinished())
        await entered.wait()
        async with database._account_session() as session:
            session.add(Resume(resume_id="unfinished", content="partial"))
            await session.commit()

    with pytest.raises(credits.CreditError) as error:
        await operation()
    assert error.value.status_code == 409
    assert exited.is_set()
    assert await database.get_resume("unfinished") is None
    assert_account(user_id, 20)


async def test_expired_holds_recover_once_and_leave_live_operations_alone(account_database):
    user_id, _ = account_database
    expired, active = credits._new_operation(user_id), credits._new_operation(user_id)
    for scope in (expired, active):
        credits._reserve_generation(scope, scope.id)
        credits._complete_generation(scope, scope.id)
    with auth.get_auth_store().connect() as connection:
        connection.execute("UPDATE credit_operations SET lease_expires_at=? WHERE id=?", (time.time() - 1, expired.id))
    assert credits.recover_expired_operations() == 1
    assert credits.recover_expired_operations() == 0
    assert_account(user_id, 19, 1)
    with pytest.raises(credits.CreditError):
        credits._transaction(lambda execute: credits._settle_operation(execute, expired.id, user_id))
    credits._transaction(lambda execute: credits._settle_operation(execute, active.id, user_id))
    assert_account(user_id, 19)
    assert [row["kind"] for row in billing_rows(user_id)].count("release") == 1


async def test_reserve_complete_settle_and_release_are_idempotent(account_database):
    user_id, _ = account_database
    operation = credits._new_operation(user_id)
    for _ in range(2):
        credits._reserve_generation(operation, "generation-one")
    for _ in range(2):
        credits._complete_generation(operation, "generation-one")
    for _ in range(2):
        credits._transaction(lambda execute: credits._settle_operation(execute, operation.id, user_id))
        credits._transaction(lambda execute: credits._release_operation(execute, operation.id))
    assert_account(user_id, 19)
    assert [row["kind"] for row in billing_rows(user_id)] == ["grant", "hold", "spend"]


async def test_parallel_reservations_never_overdraw_or_lose_ledger(account_database):
    user_id, _ = account_database
    credits._change_credits(user_id, -17)
    scopes = [credits._new_operation(user_id) for _ in range(12)]
    results = await asyncio.gather(*[
        asyncio.to_thread(credits._reserve_generation, scope, scope.id) for scope in scopes
    ], return_exceptions=True)
    assert sum(result is None for result in results) == 3
    assert sum(isinstance(result, credits.CreditError) and result.status_code == 402 for result in results) == 9
    assert_account(user_id, 0, 3)
    for scope in scopes:
        credits._transaction(lambda execute, scope=scope: credits._release_operation(execute, scope.id))
    assert_account(user_id, 3)


async def test_expired_pending_operation_cannot_settle_before_recovery(account_database):
    user_id, _ = account_database
    scope = credits._new_operation(user_id)
    credits._reserve_generation(scope, scope.id)
    credits._complete_generation(scope, scope.id)
    with auth.get_auth_store().connect() as connection:
        connection.execute("UPDATE credit_operations SET lease_expires_at=0 WHERE id=?", (scope.id,))
    with pytest.raises(credits.CreditError) as error:
        credits._transaction(lambda execute: credits._settle_operation(execute, scope.id, user_id))
    assert error.value.status_code == 409
    assert credits.recover_expired_operations() == 1
    assert_account(user_id, 20)
