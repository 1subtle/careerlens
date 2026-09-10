"""Durable per-generation credit reservations and operation settlement."""

import asyncio
import logging
import sqlite3
import time
from contextvars import ContextVar
from dataclasses import dataclass, field
from functools import wraps
from uuid import uuid4

from fastapi import HTTPException

from app.hosting import current_user_id, is_hosted

LEASE_SECONDS = 1800
HEARTBEAT_SECONDS = 60
logger = logging.getLogger(__name__)


class CreditError(HTTPException):
    """Credit failures survive optional AI fallbacks and HTTP sanitizers."""


@dataclass
class _GenerationScope:
    id: str
    user_id: str
    running: set[asyncio.Task] = field(default_factory=set)
    closed: bool = False


current_operation: ContextVar[_GenerationScope | None] = ContextVar(
    "credit_operation", default=None
)


def _prefix(schema):
    if schema not in {"main", "billing"}:
        raise ValueError("Unsupported billing schema")
    return schema + "."


def _transaction(action):
    from app.auth import get_auth_store

    try:
        with get_auth_store().connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            return action(connection.execute)
    except sqlite3.Error:
        raise CreditError(503, "积分服务暂不可用，请稍后重试") from None


def record_ledger(execute, user_id, event_key, kind, balance_delta, reserved_delta,
                  *, operation_id=None, generation_id=None, order_id=None, schema="main"):
    prefix = _prefix(schema)
    row = execute(
        f"SELECT balance, reserved FROM {prefix}credit_accounts WHERE user_id=?", (user_id,)
    ).fetchone()
    if row is None:
        raise CreditError(401, "请重新登录")
    execute(
        f"INSERT INTO {prefix}credit_ledger "
        "(event_key,user_id,operation_id,generation_id,order_id,kind,balance_delta,"
        "reserved_delta,balance_after,reserved_after,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (event_key, user_id, operation_id, generation_id, order_id, kind,
         balance_delta, reserved_delta, row[0], row[1], time.time()),
    )


def grant_signup(execute, user_id: str, amount: int, schema="main") -> bool:
    prefix = _prefix(schema)
    created = execute(
        f"INSERT OR IGNORE INTO {prefix}credit_accounts (user_id,balance,granted,reserved) "
        "VALUES (?,?,?,0)", (user_id, amount, amount),
    ).rowcount
    if created:
        record_ledger(execute, user_id, "signup:" + user_id, "grant", amount, 0, schema=schema)
    return bool(created)


def account_balance(user_id: str) -> dict:
    from app.auth import get_auth_store

    try:
        with get_auth_store().connect() as connection:
            row = connection.execute(
                "SELECT balance, granted, reserved FROM credit_accounts WHERE user_id=?", (user_id,)
            ).fetchone()
    except sqlite3.Error:
        raise CreditError(503, "积分服务暂不可用，请稍后重试") from None
    if row is None:
        raise CreditError(401, "请重新登录")
    return {"balance": row[0], "signup_grant": row[1], "reserved": row[2], "cost_per_generation": 1}


def credit_balance(user_id: str) -> dict:
    value = account_balance(user_id)
    value.pop("reserved")
    return value


def _change_credits(user_id: str, amount: int) -> None:
    """Internal adjustments keep the existing helper and now leave an audit entry."""
    if type(amount) is not int or amount == 0:
        raise ValueError("Credit adjustment must be a nonzero integer")

    def change(execute):
        if not execute(
            "UPDATE credit_accounts SET balance=balance+? WHERE user_id=? AND balance+?>=0",
            (amount, user_id, amount),
        ).rowcount:
            raise CreditError(402, "积分不足")
        record_ledger(execute, user_id, "adjust:" + uuid4().hex, "adjustment", amount, 0)

    _transaction(change)


def _new_operation(user_id):
    identifier, now = uuid4().hex, time.time()

    def create(execute):
        if execute("SELECT 1 FROM credit_accounts WHERE user_id=?", (user_id,)).fetchone() is None:
            raise CreditError(401, "请重新登录")
        execute(
            "INSERT INTO credit_operations(id,user_id,status,created_at,updated_at,lease_expires_at) "
            "VALUES (?,?,'pending',?,?,?)", (identifier, user_id, now, now, now + LEASE_SECONDS),
        )
    _transaction(create)
    return _GenerationScope(identifier, user_id)


def _operation_row(execute, operation_id, schema="main"):
    return execute(
        f"SELECT user_id,status,lease_expires_at FROM {_prefix(schema)}credit_operations WHERE id=?",
        (operation_id,),
    ).fetchone()


def _reserve_generation(scope, generation_id):
    now = time.time()

    def reserve(execute):
        previous = execute(
            "SELECT operation_id,user_id,status FROM credit_generations WHERE id=?", (generation_id,)
        ).fetchone()
        if previous:
            if previous[0] == scope.id and previous[1] == scope.user_id and previous[2] in {"held", "completed", "settled"}:
                return
            raise CreditError(409, "本次 AI 生成已释放或属于其他操作")
        operation = _operation_row(execute, scope.id)
        if operation is None or operation[0] != scope.user_id or operation[1] != "pending":
            raise CreditError(409, "本次 AI 操作已结束，请重新操作")
        if operation[2] <= now:
            raise CreditError(409, "本次 AI 操作已过期，请重新操作")
        if not execute(
            "UPDATE credit_accounts SET balance=balance-1,reserved=reserved+1 "
            "WHERE user_id=? AND balance>=1", (scope.user_id,),
        ).rowcount:
            raise CreditError(402, "积分已用完，暂时无法继续使用 AI 功能")
        execute(
            "INSERT INTO credit_generations(id,operation_id,user_id,status,created_at,updated_at) "
            "VALUES (?,?,?,'held',?,?)", (generation_id, scope.id, scope.user_id, now, now),
        )
        execute("UPDATE credit_operations SET updated_at=?,lease_expires_at=? WHERE id=?",
                (now, now + LEASE_SECONDS, scope.id))
        record_ledger(execute, scope.user_id, "hold:" + generation_id, "hold", -1, 1,
                      operation_id=scope.id, generation_id=generation_id)
    _transaction(reserve)


def _complete_generation(scope, generation_id):
    def complete(execute):
        previous = execute("SELECT status FROM credit_generations WHERE id=? AND operation_id=?", (generation_id, scope.id)).fetchone()
        if previous and previous[0] in {"completed", "settled"}:
            return
        operation = _operation_row(execute, scope.id)
        if operation is None or operation[1] != "pending" or operation[2] <= time.time():
            raise CreditError(409, "本次 AI 操作已结束，请重新操作")
        if not execute(
            "UPDATE credit_generations SET status='completed',updated_at=? "
            "WHERE id=? AND operation_id=? AND status='held'",
            (time.time(), generation_id, scope.id),
        ).rowcount:
            raise CreditError(409, "本次 AI 生成已结算或释放，请重新操作")
    _transaction(complete)


def _release_generation(execute, operation_id, generation_id, schema="main"):
    prefix = _prefix(schema)
    row = execute(
        f"SELECT user_id,status FROM {prefix}credit_generations WHERE id=? AND operation_id=?",
        (generation_id, operation_id),
    ).fetchone()
    if row is None or row[1] not in {"held", "completed"}:
        return
    if not execute(
        f"UPDATE {prefix}credit_accounts SET balance=balance+1,reserved=reserved-1 "
        "WHERE user_id=? AND reserved>=1", (row[0],),
    ).rowcount:
        raise CreditError(503, "积分预留记录不一致，请联系管理员")
    execute(f"UPDATE {prefix}credit_generations SET status='released',updated_at=? WHERE id=?",
            (time.time(), generation_id))
    record_ledger(execute, row[0], "release:" + generation_id, "release", 1, -1,
                  operation_id=operation_id, generation_id=generation_id, schema=schema)


def _settle_operation(execute, operation_id, user_id, schema="main"):
    prefix = _prefix(schema)
    operation = _operation_row(execute, operation_id, schema)
    if operation is None or operation[0] != user_id:
        raise CreditError(409, "本次积分操作不存在")
    if operation[1] == "settled":
        return
    if operation[1] != "pending":
        raise CreditError(409, "本次 AI 操作已释放，请重新操作")
    if operation[2] <= time.time():
        raise CreditError(409, "本次 AI 操作已过期，请重新操作")
    if execute(
        f"SELECT 1 FROM {prefix}credit_generations WHERE operation_id=? AND status='held' LIMIT 1",
        (operation_id,),
    ).fetchone():
        raise CreditError(409, "AI 生成仍在进行，暂不能保存结果")
    generations = execute(
        f"SELECT id FROM {prefix}credit_generations WHERE operation_id=? AND status='completed' ORDER BY created_at,id",
        (operation_id,),
    ).fetchall()
    for generation in generations:
        if not execute(
            f"UPDATE {prefix}credit_accounts SET reserved=reserved-1 WHERE user_id=? AND reserved>=1",
            (user_id,),
        ).rowcount:
            raise CreditError(503, "积分预留记录不一致，请联系管理员")
        execute(f"UPDATE {prefix}credit_generations SET status='settled',updated_at=? WHERE id=?",
                (time.time(), generation[0]))
        record_ledger(execute, user_id, "spend:" + generation[0], "spend", 0, -1,
                      operation_id=operation_id, generation_id=generation[0], schema=schema)
    execute(f"UPDATE {prefix}credit_operations SET status='settled',updated_at=? WHERE id=?",
            (time.time(), operation_id))


def settle_current_operation(execute, schema="billing") -> None:
    """Called before business COMMIT, on its attached auth database transaction."""
    scope = current_operation.get()
    if scope is None:
        return
    if current_user_id.get() != scope.user_id:
        raise CreditError(403, "积分操作与当前账号不一致")
    _settle_operation(execute, scope.id, scope.user_id, schema)


def _release_operation(execute, operation_id, schema="main"):
    prefix = _prefix(schema)
    operation = _operation_row(execute, operation_id, schema)
    # A business transaction that already committed must keep its settled charge.
    if operation is None or operation[1] != "pending":
        return
    generations = execute(
        f"SELECT id FROM {prefix}credit_generations WHERE operation_id=? AND status IN ('held','completed')",
        (operation_id,),
    ).fetchall()
    for generation in generations:
        _release_generation(execute, operation_id, generation[0], schema)
    execute(f"UPDATE {prefix}credit_operations SET status='released',updated_at=? WHERE id=?",
            (time.time(), operation_id))


def recover_expired_operations(limit=100) -> int:
    """Reclaim abandoned leases under the same lock used to renew and reserve."""
    def recover(execute):
        rows = execute(
            "SELECT id FROM credit_operations WHERE status='pending' AND lease_expires_at<=? "
            "ORDER BY lease_expires_at LIMIT ?", (time.time(), limit),
        ).fetchall()
        for row in rows:
            _release_operation(execute, row[0])
        return len(rows)
    return _transaction(recover)


async def _heartbeat(scope):
    while True:
        await asyncio.sleep(HEARTBEAT_SECONDS)
        try:
            def renew(execute):
                now = time.time()
                return execute(
                    "UPDATE credit_operations SET updated_at=?,lease_expires_at=? "
                    "WHERE id=? AND status='pending' AND lease_expires_at>?",
                    (now, now + LEASE_SECONDS, scope.id, now),
                ).rowcount
            if not await asyncio.to_thread(_transaction, renew):
                return
        except CreditError:
            logger.warning("Credit lease renewal delayed")


async def _finish_uninterrupted(awaitable):
    cleanup = asyncio.create_task(awaitable)
    while not cleanup.done():
        try:
            await asyncio.shield(cleanup)
        except asyncio.CancelledError:
            continue
    return cleanup.result()


def refund_failed_generations(function):
    @wraps(function)
    async def settled(*args, **kwargs):
        if not is_hosted() or current_operation.get() is not None:
            return await function(*args, **kwargs)
        user_id = current_user_id.get()
        if user_id is None:
            raise CreditError(401, "请先登录")
        scope = _new_operation(user_id)
        token = current_operation.set(scope)
        heartbeat = asyncio.create_task(_heartbeat(scope))
        try:
            result = await function(*args, **kwargs)
            while scope.running:
                await asyncio.gather(*scope.running)
            _transaction(lambda execute: _settle_operation(execute, scope.id, scope.user_id))
            return result
        except BaseException:
            scope.closed = True

            async def release():
                running = tuple(scope.running)
                for task in running:
                    task.cancel()
                if running:
                    await asyncio.gather(*running, return_exceptions=True)
                _transaction(lambda execute: _release_operation(execute, scope.id))
            await _finish_uninterrupted(release())
            raise
        finally:
            scope.closed = True
            heartbeat.cancel()
            async def stop_heartbeat():
                await asyncio.gather(heartbeat, return_exceptions=True)
            await _finish_uninterrupted(stop_heartbeat())
            current_operation.reset(token)
    return settled


def charge_generation(function):
    @wraps(function)
    async def charged(*args, **kwargs):
        if not is_hosted():
            return await function(*args, **kwargs)
        scope = current_operation.get()
        if scope is None:
            return await standalone(*args, **kwargs)
        if scope.closed:
            raise asyncio.CancelledError("AI operation has already settled")
        if current_user_id.get() != scope.user_id:
            raise CreditError(403, "AI 操作与当前账号不一致")
        generation_id = uuid4().hex
        _reserve_generation(scope, generation_id)
        task = asyncio.current_task()
        scope.running.add(task)
        try:
            result = await function(*args, **kwargs)
            _complete_generation(scope, generation_id)
            return result
        except BaseException:
            _transaction(lambda execute: _release_generation(execute, scope.id, generation_id))
            raise
        finally:
            scope.running.discard(task)
    standalone = refund_failed_generations(charged)
    return charged
