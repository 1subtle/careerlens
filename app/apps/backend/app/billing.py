"""Account-owned billing reads and atomically credited Wechat payment orders."""

import csv
import io
import time
from datetime import UTC, datetime
from uuid import uuid4

from app.credits import CreditError, _transaction, record_ledger
from app.payment import (
    PaymentError,
    get_payment_settings,
    get_wechat_pay,
    payment_catalog,
)


def _read(action):
    import sqlite3

    from app.auth import get_auth_store
    try:
        with get_auth_store().connect() as connection:
            return action(connection)
    except sqlite3.Error:
        raise CreditError(503, "账单服务暂不可用，请稍后重试") from None


def billing_summary(user_id):
    def read(connection):
        connection.execute("BEGIN")
        account = connection.execute(
            "SELECT balance,granted,reserved FROM credit_accounts WHERE user_id=?", (user_id,)
        ).fetchone()
        if account is None:
            raise CreditError(401, "请重新登录")
        totals = connection.execute(
            "SELECT COALESCE(SUM(CASE WHEN kind='spend' THEN -reserved_delta ELSE 0 END),0),"
            "COALESCE(SUM(CASE WHEN kind='purchase' THEN balance_delta ELSE 0 END),0) "
            "FROM credit_ledger WHERE user_id=?", (user_id,)
        ).fetchone()
        paid = connection.execute(
            "SELECT COALESCE(SUM(amount_fen),0) FROM payment_orders WHERE user_id=? AND status='paid'",
            (user_id,),
        ).fetchone()[0]
        return {"balance": account[0], "signup_grant": account[1], "reserved": account[2],
                "cost_per_generation": 1, "total_spent": totals[0],
                "total_purchased": totals[1], "total_paid_fen": paid}
    return {**_read(read), **payment_catalog()}


def _ledger_rows(connection, user_id, before_id, limit, kind, since, until):
    return connection.execute(
        "SELECT id,kind,operation_id,generation_id,order_id,balance_delta,reserved_delta,"
        "balance_after,reserved_after,created_at FROM credit_ledger "
        "WHERE user_id=? AND (? IS NULL OR id<?) AND (? IS NULL OR kind=?) "
        "AND (? IS NULL OR created_at>=?) AND (? IS NULL OR created_at<?) ORDER BY id DESC LIMIT ?",
        (user_id, before_id, before_id, kind, kind, since, since, until, until, limit),
    ).fetchall()


def ledger_page(user_id, before_id=None, limit=30, *, kind=None, since=None, until=None):
    def read(connection):
        rows = _ledger_rows(connection, user_id, before_id, limit + 1, kind, since, until)
        return {"items": [dict(row) for row in rows[:limit]],
                "next_before_id": rows[limit - 1]["id"] if len(rows) > limit else None}
    return _read(read)


def ledger_csv(user_id, *, kind=None, since=None, until=None):
    rows = _read(lambda connection: _ledger_rows(connection, user_id, None, 10_001, kind, since, until))
    if len(rows) > 10_000:
        raise PaymentError(413, "所选范围超过 10,000 条，请缩小日期范围后导出")
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(["id", "kind", "available_change", "reserved_change", "available_after",
                     "reserved_after", "created_at_utc", "operation_id", "generation_id", "order_id"])
    def safe(value):
        text = str(value or "")
        return "'" + text if text.startswith(("=", "+", "-", "@", "\t", "\r")) else text
    for row in rows:
        writer.writerow([row["id"], safe(row["kind"]), row["balance_delta"], row["reserved_delta"],
                         row["balance_after"], row["reserved_after"],
                         datetime.fromtimestamp(row["created_at"], UTC).isoformat(),
                         *[safe(row[key]) for key in ("operation_id", "generation_id", "order_id")]])
    return "\ufeff" + output.getvalue()


def order_view(order):
    fields = ("id", "package_id", "description", "amount_fen", "currency", "credits", "status",
              "created_at", "updated_at", "expires_at", "paid_at")
    return {**{key: order[key] for key in fields},
            "code_url": order["code_url"] if order["status"] == "pending" and order["expires_at"] > time.time() else None}


def get_order(user_id, order_id, *, public=True):
    def read(connection):
        row = connection.execute("SELECT * FROM payment_orders WHERE id=? AND user_id=?", (order_id, user_id)).fetchone()
        if row is None:
            raise PaymentError(404, "充值订单不存在")
        return order_view(row) if public else dict(row)
    return _read(read)


def list_orders(user_id, before_id=None, limit=50, *, status=None, since=None, until=None, search=None):
    def read(connection):
        stamp = None
        if before_id:
            cursor = connection.execute(
                "SELECT created_at FROM payment_orders WHERE id=? AND user_id=?", (before_id, user_id)
            ).fetchone()
            if cursor is None:
                raise PaymentError(400, "分页位置已失效，请刷新订单")
            stamp = cursor[0]
        rows = connection.execute(
            "SELECT * FROM payment_orders WHERE user_id=? "
            "AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) "
            "AND (? IS NULL OR status=?) AND (? IS NULL OR created_at>=?) "
            "AND (? IS NULL OR created_at<?) "
            "AND (? IS NULL OR instr(id,?)>0 OR instr(description,?)>0) "
            "ORDER BY created_at DESC,id DESC LIMIT ?",
            (user_id, stamp, stamp, stamp, before_id, status, status, since, since,
             until, until, search, search, search, limit + 1),
        ).fetchall()
        return {"items": [order_view(row) for row in rows[:limit]],
                "next_before_id": rows[limit - 1]["id"] if len(rows) > limit else None}
    return _read(read)


def _prepare_order(user_id, package, idempotency_key, options):
    def prepare(execute):
        existing = execute(
            "SELECT id,package_id FROM payment_orders WHERE user_id=? AND idempotency_key=?",
            (user_id, idempotency_key),
        ).fetchone()
        if existing:
            if existing[1] != package.id:
                raise PaymentError(409, "本次订单请求已用于另一套餐，请刷新后重试")
            return existing[0]
        now, identifier = time.time(), uuid4().hex
        if execute("SELECT 1 FROM credit_accounts WHERE user_id=?", (user_id,)).fetchone() is None:
            raise PaymentError(401, "请重新登录")
        if execute(
            "SELECT COUNT(*) FROM payment_orders WHERE user_id=? AND status IN ('created','pending') AND expires_at>?",
            (user_id, now),
        ).fetchone()[0] >= 10:
            raise PaymentError(429, "待支付订单过多，请先查看已有订单")
        execute(
            "INSERT INTO payment_orders (id,user_id,idempotency_key,package_id,description,amount_fen,currency,"
            "credits,mchid,appid,status,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,'created',?,?,?)",
            (identifier, user_id, idempotency_key, package.id, "CareerLens " + package.name,
             package.amount_fen, package.currency, package.credits, options.mchid, options.appid,
             now, now, now + 1800),
        )
        return identifier
    return _transaction(prepare)


def apply_payment(transaction: dict) -> dict:
    """Verified Wechat data changes order, account and ledger in one auth transaction."""
    def apply(execute):
        row = execute("SELECT * FROM payment_orders WHERE id=?", (transaction.get("out_trade_no"),)).fetchone()
        if row is None:
            raise PaymentError(404, "充值订单不存在")
        # This function uses auth sqlite3 connections; cross-database settlement
        # is handled separately by credits.settle_current_operation.
        order = dict(row)
        if transaction.get("mchid") != order["mchid"] or transaction.get("appid") != order["appid"]:
            raise PaymentError(400, "支付商户或应用信息不一致")
        state = transaction.get("trade_state")
        if state == "SUCCESS":
            amount = transaction.get("amount")
            transaction_id = transaction.get("transaction_id")
            if (not isinstance(amount, dict) or type(amount.get("total")) is not int
                    or amount["total"] != order["amount_fen"] or amount.get("currency") != order["currency"]
                    or transaction.get("trade_type") != "NATIVE"
                    or not isinstance(transaction_id, str) or not 6 <= len(transaction_id) <= 64):
                raise PaymentError(400, "支付金额、币种或交易信息不一致")
            try:
                paid_at = datetime.fromisoformat(transaction["success_time"].replace("Z", "+00:00"))
                if paid_at.tzinfo is None:
                    raise ValueError("Missing payment timezone")
            except (KeyError, TypeError, AttributeError, ValueError):
                raise PaymentError(400, "支付完成时间无效") from None
            if order["status"] == "paid":
                if order["transaction_id"] != transaction_id:
                    raise PaymentError(400, "支付交易号与已到账订单不一致")
                return order_view(order)
            if order["status"] == "closed":
                raise PaymentError(409, "已关闭订单需要人工核对")
            if execute("SELECT id FROM payment_orders WHERE transaction_id=?", (transaction_id,)).fetchone():
                raise PaymentError(400, "支付交易号已绑定其他订单")
            now = time.time()
            execute("UPDATE payment_orders SET status='paid',transaction_id=?,paid_at=?,updated_at=? WHERE id=?",
                    (transaction_id, paid_at.timestamp(), now, order["id"]))
            if not execute("UPDATE credit_accounts SET balance=balance+? WHERE user_id=?",
                           (order["credits"], order["user_id"])).rowcount:
                raise PaymentError(409, "到账账户不存在，请联系管理员")
            record_ledger(execute, order["user_id"], "purchase:" + order["id"], "purchase", order["credits"], 0,
                          order_id=order["id"])
            order.update(status="paid", paid_at=paid_at.timestamp(), updated_at=now)
        elif state in {"CLOSED", "REVOKED", "PAYERROR"}:
            if order["status"] != "paid":
                execute("UPDATE payment_orders SET status='closed',updated_at=? WHERE id=?", (time.time(), order["id"]))
                order["status"] = "closed"
        elif state not in {"NOTPAY", "USERPAYING"}:
            raise PaymentError(409, "订单状态需要管理员核对")
        return order_view(order)
    return _transaction(apply)


async def refresh_order(user_id, order_id):
    order = get_order(user_id, order_id, public=False)
    if order["status"] in {"paid", "closed"}:
        return order_view(order)
    payment = get_wechat_pay(require_packages=False)
    return apply_payment(await payment.query(order))


async def create_order(user_id, package_id, idempotency_key):
    payment = get_wechat_pay()
    packages = get_payment_settings().packages()
    package = next((item for item in packages if item.id == package_id), None)
    if package is None:
        raise PaymentError(422, "充值套餐不存在或已调整，请刷新后重试")
    order_id = _prepare_order(user_id, package, idempotency_key, payment.options)
    order = get_order(user_id, order_id, public=False)
    if order["status"] in {"paid", "closed"} or order["code_url"]:
        return order_view(order)
    if order["expires_at"] <= time.time():
        raise PaymentError(409, "本次充值订单已过期，请重新创建订单")
    try:
        code_url = await payment.create_native(order)
    except PaymentError:
        # A lost create response is uncertain, not proof of an unpaid order.
        try:
            reconciled = apply_payment(await payment.query(order))
            if reconciled["status"] == "paid":
                return reconciled
        except PaymentError:
            pass
        raise
    def save_code(execute):
        execute("UPDATE payment_orders SET code_url=?,status='pending',updated_at=? "
                "WHERE id=? AND status IN ('created','pending')", (code_url, time.time(), order_id))
    _transaction(save_code)
    return get_order(user_id, order_id)
