"""Account-owned preferences, session controls and portable workspace data."""

import asyncio
import json
import sqlite3
import time
from datetime import UTC, datetime
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException, Path, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select, text

from app.auth import _session_hash, get_auth_store
from app.database import db
from app.hosting import current_session_cookie, current_user_id, is_hosted
from app.models import (
    Application,
    DirectionHistory,
    Improvement,
    Job,
    MarketHistory,
    MatchRecord,
    Resume,
    ResumeSnapshot,
    RewriteRecord,
    TailoringPreview,
)

router = APIRouter(prefix="/account", tags=["Account"])
Language = Literal["en", "es", "zh", "ja", "pt", "fr", "ko"]


def identity():
    user_id = current_user_id.get()
    if not is_hosted() or user_id is None:
        raise HTTPException(401, "请先登录")
    return user_id


def _auth_action(action):
    try:
        with get_auth_store().connect() as connection:
            return action(connection)
    except sqlite3.Error:
        raise HTTPException(503, "账户服务暂不可用，请稍后重试") from None


def _profile(connection, user_id):
    row = connection.execute(
        "SELECT users.id,users.email,users.created_at,display_name,ui_language,"
        "content_language,timezone FROM users JOIN account_preferences "
        "ON account_preferences.user_id=users.id WHERE users.id=?", (user_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(401, "请重新登录")
    return dict(row)


class ProfilePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: str | None = Field(default=None, max_length=80)
    ui_language: Language | None = None
    content_language: Language | None = None
    timezone: str | None = Field(default=None, min_length=1, max_length=64)

    @field_validator("display_name", "ui_language", "content_language", "timezone", mode="before")
    @classmethod
    def nonnull(cls, value):
        if value is None:
            raise ValueError("账户偏好不能设为空值")
        return value

    @field_validator("display_name")
    @classmethod
    def clean_name(cls, value):
        value = value.strip()
        if any(ord(character) < 32 or ord(character) == 127 for character in value):
            raise ValueError("显示名称不能包含控制字符")
        return value

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value):
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("请选择有效的时区") from None
        return value


@router.get("/profile")
async def profile():
    user_id = identity()
    return await asyncio.to_thread(_auth_action, lambda connection: _profile(connection, user_id))


@router.patch("/profile")
async def update_profile(payload: ProfilePatch):
    user_id = identity()
    values = payload.model_dump(exclude_unset=True)

    def update(connection):
        connection.execute("BEGIN IMMEDIATE")
        if values:
            # Column names come solely from the validated, closed input model.
            assignments = ",".join(f"{name}=?" for name in values)
            connection.execute(
                f"UPDATE account_preferences SET {assignments} WHERE user_id=?",
                (*values.values(), user_id),
            )
        return _profile(connection, user_id)

    return await asyncio.to_thread(_auth_action, update)


def _current_token_hash():
    cookie = current_session_cookie.get()
    if cookie is None:
        raise HTTPException(401, "请重新登录")
    return _session_hash(cookie[1])


@router.get("/sessions")
async def sessions():
    user_id, token_hash = identity(), _current_token_hash()

    def read(connection):
        rows = connection.execute(
            "SELECT public_id AS id,created_at,expires_at,user_agent,"
            "token_hash=? AS current FROM sessions WHERE user_id=? AND expires_at>? "
            "ORDER BY current DESC,created_at DESC", (token_hash, user_id, time.time()),
        ).fetchall()
        return {"items": [{**dict(row), "current": bool(row["current"])} for row in rows]}

    return await asyncio.to_thread(_auth_action, read)


@router.delete("/sessions/{session_id}", status_code=204)
async def revoke_session(session_id: str = Path(pattern=r"^[0-9a-f]{32}$")):
    user_id, token_hash = identity(), _current_token_hash()

    def revoke(connection):
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT token_hash FROM sessions WHERE public_id=? AND user_id=? AND expires_at>?",
            (session_id, user_id, time.time()),
        ).fetchone()
        if row is None:
            raise HTTPException(404, "登录会话不存在")
        if row["token_hash"] == token_hash:
            raise HTTPException(409, "请使用退出登录结束当前会话")
        connection.execute("DELETE FROM sessions WHERE public_id=? AND user_id=?", (session_id, user_id))

    await asyncio.to_thread(_auth_action, revoke)
    return Response(status_code=204)


@router.post("/sessions/revoke-others")
async def revoke_other_sessions():
    user_id, token_hash = identity(), _current_token_hash()

    def revoke(connection):
        return {"revoked": connection.execute(
            "DELETE FROM sessions WHERE user_id=? AND token_hash<>?", (user_id, token_hash),
        ).rowcount}

    return await asyncio.to_thread(_auth_action, revoke)


@router.get("/export")
async def export_account():
    user_id = identity()
    account = await asyncio.to_thread(_auth_action, lambda connection: _profile(connection, user_id))
    workspace = {}
    # Explicit model allowlist excludes the provider key store and future tables.
    async with db._session() as session:
        await session.execute(text("BEGIN"))
        for model in (Resume, Job, Improvement, Application, ResumeSnapshot,
                      MatchRecord, RewriteRecord, DirectionHistory, MarketHistory, TailoringPreview):
            columns = [column for column in model.__table__.columns
                       if column.name not in {"processing_token", "claim_token"}]
            rows = await session.execute(select(*columns))
            workspace[model.__tablename__] = [dict(row) for row in rows.mappings()]
    now = datetime.now(UTC)
    content = json.dumps({"exported_at": now.isoformat(), "profile": account, "workspace": workspace},
                         ensure_ascii=False, allow_nan=False)
    return Response(content, media_type="application/json", headers={
        "Content-Disposition": f'attachment; filename="careerlens-export-{now:%Y-%m-%d}.json"',
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    })
