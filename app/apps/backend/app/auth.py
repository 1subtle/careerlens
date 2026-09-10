"""Email OTP login, revocable opaque sessions, and hosted request protection."""

import asyncio
import hashlib
import hmac
import re
import secrets
import smtplib
import sqlite3
import ssl
import time
import uuid
from contextlib import contextmanager
from email.message import EmailMessage
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.types import ASGIApp, Receive, Scope, Send

from app.config import settings
from app.hosting import (
    current_session_cookie,
    current_user_id,
    get_hosting_settings,
)

OTP_SECONDS = 600
RESEND_SECONDS = 60
MAX_ATTEMPTS = 5
SESSION_SECONDS = 7 * 86400
EMAIL_PATTERN = re.compile(
    r"[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}"
)


class EmailInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(min_length=3, max_length=254)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        value = value.strip().lower()
        local = value.partition("@")[0]
        if (
            not EMAIL_PATTERN.fullmatch(value)
            or len(local) > 64
            or local.startswith(".")
            or local.endswith(".")
            or ".." in value
        ):
            raise ValueError("请输入有效的邮箱地址")
        return value


class VerifyInput(EmailInput):
    challenge_id: str = Field(min_length=32, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    code: str = Field(pattern=r"^[0-9]{6}$")


class AuthStore:
    def __init__(self, path: Path, secret: str):
        self.path = path
        self.secret = secret.encode()

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("PRAGMA busy_timeout=10000")
            with connection:
                yield connection
        finally:
            connection.close()

    def initialize(self) -> None:
        from app.credits import grant_signup
        from app.migrations import migrate

        migrate(self.path, "auth")
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            grant = get_hosting_settings().signup_credits
            missing = connection.execute(
                "SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM credit_accounts)"
            ).fetchall()
            for user in missing:
                grant_signup(connection.execute, user["id"], grant)

    def digest(self, value: str) -> str:
        return hmac.new(self.secret, value.encode(), hashlib.sha256).hexdigest()

    def prepare(self, email: str, ip: str) -> tuple[str, str]:
        now = time.time()
        challenge = secrets.token_urlsafe(32)
        code = f"{secrets.randbelow(1_000_000):06d}"
        ip_hash = self.digest("ip:" + ip)
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "DELETE FROM send_events WHERE created_at < ?", (now - 86400,)
            )
            connection.execute(
                "DELETE FROM challenges WHERE expires_at < ?", (now - 86400,)
            )
            connection.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
            last = connection.execute(
                "SELECT MAX(created_at) FROM send_events WHERE email = ?", (email,)
            ).fetchone()[0]
            retry = (
                max(1, int(RESEND_SECONDS - (now - last)) + 1)
                if last is not None
                else 0
            )
            if last is not None and now - last < RESEND_SECONDS:
                raise HTTPException(
                    429,
                    "验证码发送过于频繁，请稍后重试",
                    headers={"Retry-After": str(retry)},
                )
            for column, value, hour_limit, day_limit in (
                ("email", email, 5, 10),
                ("ip_hash", ip_hash, 20, 100),
            ):
                counts = connection.execute(
                    f"SELECT COUNT(*), SUM(created_at > ?) FROM send_events WHERE {column} = ?",
                    (now - 3600, value),
                ).fetchone()
                if counts[0] >= day_limit or (counts[1] or 0) >= hour_limit:
                    raise HTTPException(
                        429,
                        "今日或本小时发送次数已达上限，请稍后重试",
                        headers={"Retry-After": "3600"},
                    )
            connection.execute(
                "INSERT INTO send_events VALUES (?, ?, ?)", (email, ip_hash, now)
            )
            connection.execute(
                "INSERT INTO challenges(id,email,code_hash,created_at,expires_at) VALUES (?,?,?,?,?)",
                (
                    challenge,
                    email,
                    self.digest(f"otp:{challenge}:{email}:{code}"),
                    now,
                    now + OTP_SECONDS,
                ),
            )
        return challenge, code

    def delivery(self, challenge: str, success: bool) -> None:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT email, created_at FROM challenges WHERE id = ?", (challenge,)
            ).fetchone()
            if row is None:
                return
            if success:
                # A newer request supersedes older codes even if SMTP completes out of order.
                connection.execute(
                    "UPDATE challenges SET consumed = 1 WHERE email = ? AND created_at < ?",
                    (row["email"], row["created_at"]),
                )
                connection.execute(
                    "UPDATE challenges SET delivered = 1 WHERE id = ?", (challenge,)
                )
            else:
                connection.execute(
                    "UPDATE challenges SET consumed = 1 WHERE id = ?", (challenge,)
                )

    def verify(
        self, email: str, challenge: str, code: str, previous: str | None,
        user_agent: str = "",
    ) -> tuple[dict, str]:
        now = time.time()
        token = secrets.token_urlsafe(32)
        user = None
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM challenges WHERE id = ? AND email = ?",
                (challenge, email),
            ).fetchone()
            if (
                row
                and row["delivered"]
                and not row["consumed"]
                and row["expires_at"] > now
                and row["attempts"] < MAX_ATTEMPTS
            ):
                connection.execute(
                    "UPDATE challenges SET attempts = attempts + 1 WHERE id = ?",
                    (challenge,),
                )
                if hmac.compare_digest(
                    row["code_hash"], self.digest(f"otp:{challenge}:{email}:{code}")
                ):
                    connection.execute(
                        "UPDATE challenges SET consumed = 1 WHERE email = ?", (email,)
                    )
                    connection.execute(
                        "INSERT OR IGNORE INTO users VALUES (?, ?, ?)",
                        (str(uuid.uuid4()), email, now),
                    )
                    record = connection.execute(
                        "SELECT id, email FROM users WHERE email = ?", (email,)
                    ).fetchone()
                    user = dict(record)
                    connection.execute(
                        "INSERT OR IGNORE INTO account_preferences(user_id) VALUES (?)", (user["id"],)
                    )
                    grant = get_hosting_settings().signup_credits
                    from app.credits import grant_signup
                    grant_signup(connection.execute, user["id"], grant)
                    user["credits"] = connection.execute(
                        "SELECT balance FROM credit_accounts WHERE user_id = ?",
                        (user["id"],),
                    ).fetchone()[0]
                    if previous:
                        connection.execute(
                            "DELETE FROM sessions WHERE token_hash = ?",
                            (_session_hash(previous),),
                        )
                    connection.execute(
                        "INSERT INTO sessions(token_hash,user_id,expires_at,public_id,created_at,user_agent) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        (_session_hash(token), user["id"], now + SESSION_SECONDS,
                         uuid.uuid4().hex, now, _device_label(user_agent)),
                    )
        # Failed attempts must commit, rather than roll back with the HTTP error.
        if user is None:
            raise HTTPException(400, "验证码无效、已过期或尝试次数已用完，请重新获取")
        return user, token

    def session(self, token: str | None) -> dict | None:
        if not token or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
            return None
        with self.connect() as connection:
            row = connection.execute(
                "SELECT users.id, users.email, credit_accounts.balance AS credits "
                "FROM sessions JOIN users ON users.id = sessions.user_id "
                "JOIN credit_accounts ON credit_accounts.user_id = users.id "
                "WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
                (_session_hash(token), time.time()),
            ).fetchone()
        if row is None:
            return None
        try:
            if str(uuid.UUID(row["id"])) != row["id"]:
                return None
        except ValueError:
            return None
        return dict(row)

    def logout(self, token: str | None) -> None:
        if token:
            with self.connect() as connection:
                connection.execute(
                    "DELETE FROM sessions WHERE token_hash = ?", (_session_hash(token),)
                )


def _session_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _device_label(user_agent: str) -> str:
    """Keep a coarse device label rather than storing raw request metadata."""
    value = user_agent[:512].lower()
    browser = next((name for marker, name in (
        ("micromessenger", "WeChat"), ("edg", "Edge"), ("firefox", "Firefox"),
        ("chrome", "Chrome"), ("safari", "Safari"),
    ) if marker in value), "Browser")
    device = next((name for marker, name in (
        ("ipad", "iPad"), ("iphone", "iPhone"), ("android", "Android"),
        ("windows", "Windows"), ("macintosh", "Mac"), ("linux", "Linux"),
    ) if marker in value), "Unknown device")
    return f"{browser} · {device}"


def get_auth_store() -> AuthStore:
    return AuthStore(
        settings.data_dir / "auth.sqlite",
        get_hosting_settings().auth_secret.get_secret_value(),
    )


def send_code(email: str, code: str) -> None:
    """SMTP submission only; never print message bodies, credentials, or OTPs."""
    options = get_hosting_settings()
    message = EmailMessage()
    message["Subject"] = "CareerLens 登录验证码"
    message["From"] = options.smtp_from
    message["To"] = email
    message.set_content(
        f"你的 CareerLens 登录验证码是：{code}\n\n10 分钟内有效。请勿向他人透露验证码。\n若非本人操作，请忽略此邮件。"
    )
    context = ssl.create_default_context()
    if options.smtp_security == "ssl":
        client = smtplib.SMTP_SSL(
            options.smtp_host, options.smtp_port, timeout=15, context=context
        )
    else:
        client = smtplib.SMTP(options.smtp_host, options.smtp_port, timeout=15)
    with client:
        if options.smtp_security == "starttls":
            client.starttls(context=context)
        if options.smtp_username:
            client.login(
                options.smtp_username, options.smtp_password.get_secret_value()
            )
        refused = client.send_message(message)
        if refused:
            raise smtplib.SMTPRecipientsRefused(refused)


def session_view(user: dict | None = None) -> dict:
    options = get_hosting_settings()
    return {
        "mode": options.mode,
        "user": user,
        "email_login_available": options.email_login_available,
        "github_url": options.github_url,
    }


class AuthRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def safe_validation(request: Request):
            try:
                return await handler(request)
            except RequestValidationError:
                # FastAPI's default 422 includes rejected input, which can expose OTPs.
                raise HTTPException(422, "邮箱、验证码或登录请求格式不正确") from None
            except sqlite3.Error:
                raise HTTPException(503, "登录服务暂不可用，请稍后重试") from None

        return safe_validation


router = APIRouter(prefix="/auth", tags=["Authentication"], route_class=AuthRoute)


@router.get("/session")
async def session(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return session_view(getattr(request.state, "auth_user", None))


@router.get("/credits")
async def credits(response: Response):
    from app.credits import credit_balance

    user_id = current_user_id.get()
    if user_id is None:
        raise HTTPException(401, "请先登录")
    response.headers["Cache-Control"] = "no-store"
    return await asyncio.to_thread(credit_balance, user_id)


@router.post("/email/start")
async def start(payload: EmailInput, request: Request, response: Response):
    options = get_hosting_settings()
    if not options.email_login_available:
        raise HTTPException(503, "邮箱登录暂未配置，请联系网站管理员")
    store = get_auth_store()
    # Uvicorn resolves forwarded IPs only from its configured trusted proxy peers.
    ip = request.client.host if request.client else "unknown"
    challenge, code = await asyncio.to_thread(store.prepare, payload.email, ip)
    try:
        async with asyncio.timeout(45):
            await asyncio.to_thread(send_code, payload.email, code)
    except (smtplib.SMTPException, OSError, ValueError):
        await asyncio.to_thread(store.delivery, challenge, False)
        raise HTTPException(503, "验证码邮件发送失败，请稍后重试") from None
    await asyncio.to_thread(store.delivery, challenge, True)
    response.headers["Cache-Control"] = "no-store"
    return {
        "challenge_id": challenge,
        "email": payload.email,
        "retry_after_seconds": RESEND_SECONDS,
        "expires_in_seconds": OTP_SECONDS,
    }


@router.post("/email/verify")
async def verify(payload: VerifyInput, request: Request, response: Response):
    options = get_hosting_settings()
    if not options.hosted:
        raise HTTPException(404, "本地模式无需登录")
    user, token = await asyncio.to_thread(
        get_auth_store().verify,
        payload.email,
        payload.challenge_id,
        payload.code,
        request.cookies.get(options.cookie_name),
        request.headers.get("user-agent", ""),
    )
    response.set_cookie(
        options.cookie_name,
        token,
        max_age=SESSION_SECONDS,
        secure=options.secure_cookie,
        httponly=True,
        samesite="lax",
        path="/",
    )
    response.headers["Cache-Control"] = "no-store"
    return session_view(user)


@router.post("/logout")
async def logout(request: Request, response: Response):
    options = get_hosting_settings()
    if options.hosted:
        await asyncio.to_thread(
            get_auth_store().logout, request.cookies.get(options.cookie_name)
        )
    response.delete_cookie(
        options.cookie_name,
        path="/",
        secure=options.secure_cookie,
        httponly=True,
        samesite="lax",
    )
    response.headers["Cache-Control"] = "no-store"
    return session_view()


class HostingAuthMiddleware:
    """One default-deny boundary; identity remains set for the entire ASGI call."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "websocket" and get_hosting_settings().hosted:
            await send({"type": "websocket.close", "code": 1008})
            return
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        identity = current_user_id.set(None)
        cookie_context = current_session_cookie.set(None)
        try:
            options = get_hosting_settings()
            if not options.hosted:
                await self.app(scope, receive, send)
                return
            request = Request(scope)
            path = scope["path"].rstrip("/")
            payment_notify = path == "/api/v1/billing/wechat/notify" and request.method == "POST"
            error = None
            if path in {"/docs", "/redoc", "/openapi.json"} or path.startswith(
                "/docs/"
            ):
                error = (404, "页面不存在")
            api = path == "/api/v1" or path.startswith("/api/v1/")
            if (
                api
                and not payment_notify
                and request.method not in {"GET", "HEAD", "OPTIONS"}
                and request.headers.get("origin") != options.public_origin
            ):
                error = (403, "请求来源无效，请从本站页面操作")
            if api and request.method == "OPTIONS":
                if request.headers.get("origin") != options.public_origin:
                    error = (403, "请求来源无效")
                elif error is None:
                    await self.app(scope, receive, send)
                    return
            user = None
            cookie = request.cookies.get(options.cookie_name)
            if error is None and api and path != "/api/v1/health":
                try:
                    user = await asyncio.to_thread(get_auth_store().session, cookie)
                except sqlite3.Error:
                    error = (503, "登录服务暂不可用，请稍后重试")
                public = payment_notify or path in {
                    "/api/v1/health",
                    "/api/v1/auth/session",
                    "/api/v1/auth/email/start",
                    "/api/v1/auth/email/verify",
                    "/api/v1/auth/logout",
                }
                if not public and user is None and error is None:
                    error = (401, "请先登录")
                if (
                    (path == "/api/v1/config" or path.startswith("/api/v1/config/"))
                    and not (
                        request.method == "GET" and path == "/api/v1/config/language"
                    )
                    and error is None
                ):
                    error = (403, "网站模式的系统配置由管理员统一管理")
            if error:
                await JSONResponse(
                    {"detail": error[1]},
                    status_code=error[0],
                    headers={"Cache-Control": "no-store"},
                )(scope, receive, send)
                return
            scope.setdefault("state", {})["auth_user"] = user
            if user:
                current_user_id.set(user["id"])
                current_session_cookie.set((options.cookie_name, cookie))

            async def private_send(message):
                if message["type"] == "http.response.start" and api:
                    message["headers"] = [
                        (key, value)
                        for key, value in message.get("headers", [])
                        if key.lower() != b"cache-control"
                    ]
                    message["headers"].append((b"cache-control", b"no-store"))
                await send(message)

            await self.app(scope, receive, private_send)
        finally:
            current_session_cookie.reset(cookie_context)
            current_user_id.reset(identity)
