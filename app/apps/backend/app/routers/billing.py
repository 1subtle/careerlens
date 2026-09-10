"""Authenticated billing APIs and one independently verified Wechat webhook."""

import asyncio
import io
import time
from typing import Annotated, Literal

import segno
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from app import billing
from app.hosting import current_user_id, is_hosted
from app.payment import PaymentError, get_wechat_pay

router = APIRouter(prefix="/billing", tags=["Billing"])


def identity():
    user_id = current_user_id.get()
    if not is_hosted() or user_id is None:
        raise HTTPException(401, "请先登录")
    return user_id


class OrderInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    package_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    idempotency_key: str = Field(pattern=r"^[A-Za-z0-9_-]{16,100}$")


@router.get("/summary")
async def summary():
    return await asyncio.to_thread(billing.billing_summary, identity())


def period(
    since: float | None = Query(default=None, alias="from", ge=0, le=253402300799),
    until: float | None = Query(default=None, alias="to", ge=0, le=253402300799),
):
    if since is not None and until is not None and since >= until:
        raise HTTPException(422, "开始时间必须早于结束时间")
    return {"since": since, "until": until}


LedgerKind = Literal["opening", "grant", "hold", "spend", "release", "purchase", "adjustment"]
Period = Annotated[dict, Depends(period)]


@router.get("/ledger")
async def ledger(
    dates: Period,
    before_id: int | None = Query(default=None, gt=0),
    limit: int = Query(default=30, ge=1, le=100),
    kind: LedgerKind | None = None,
):
    return await asyncio.to_thread(billing.ledger_page, identity(), before_id, limit, kind=kind, **dates)


@router.get("/ledger/export")
async def export_ledger(dates: Period, kind: LedgerKind | None = None):
    content = await asyncio.to_thread(billing.ledger_csv, identity(), kind=kind, **dates)
    return Response(content, media_type="text/csv", headers={
        "Content-Disposition": 'attachment; filename="CareerLens-credit-usage.csv"',
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    })


@router.get("/orders")
async def orders(
    dates: Period,
    before_id: str | None = Query(default=None, pattern=r"^[A-Za-z0-9_-]{1,64}$"),
    limit: int = Query(default=50, ge=1, le=100),
    status: Literal["created", "pending", "paid", "closed"] | None = None,
    search: str | None = Query(default=None, min_length=1, max_length=100),
):
    return await asyncio.to_thread(billing.list_orders, identity(), before_id, limit,
                                   status=status, search=search, **dates)


@router.post("/orders")
async def new_order(payload: OrderInput):
    return await billing.create_order(identity(), payload.package_id, payload.idempotency_key)


@router.get("/orders/{order_id}")
async def order(order_id: str):
    return await asyncio.to_thread(billing.get_order, identity(), order_id)


@router.post("/orders/{order_id}/refresh")
async def refresh(order_id: str):
    return await billing.refresh_order(identity(), order_id)


@router.get("/orders/{order_id}/qr.svg")
async def order_qr(order_id: str):
    order = await asyncio.to_thread(billing.get_order, identity(), order_id)
    if order["status"] != "pending" or order["expires_at"] <= time.time() or not order["code_url"]:
        raise HTTPException(409, "此订单当前没有可用的付款二维码，请刷新订单状态")
    output = io.BytesIO()
    segno.make_qr(order["code_url"]).save(output, kind="svg", scale=6, border=4, light="white")
    return Response(output.getvalue(), media_type="image/svg+xml", headers={
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    })


@router.post("/wechat/notify")
async def wechat_notify(request: Request):
    if not is_hosted():
        raise HTTPException(404, "页面不存在")
    payment = get_wechat_pay(require_packages=False)
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > 131072:
            raise PaymentError(413, "支付通知过大")
        body.extend(chunk)
    transaction = payment.decrypt_notification(request.headers, bytes(body))
    await asyncio.to_thread(billing.apply_payment, transaction)
    return Response(status_code=204)
