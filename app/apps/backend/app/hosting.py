"""Explicit deployment mode and request-scoped, authenticated identity."""

from contextvars import ContextVar
from functools import lru_cache
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

current_user_id: ContextVar[str | None] = ContextVar("current_user_id", default=None)
current_session_cookie: ContextVar[tuple[str, str] | None] = ContextVar(
    "current_session_cookie", default=None
)


class HostingSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="CAREERLENS_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    mode: Literal["local", "hosted"] = "local"
    public_url: str = ""
    auth_secret: SecretStr = SecretStr("")
    smtp_host: str = ""
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_username: str = ""
    smtp_password: SecretStr = SecretStr("")
    smtp_from: str = ""
    smtp_security: Literal["starttls", "ssl", "plain"] = "starttls"
    github_url: str | None = None
    signup_credits: int = Field(default=20, ge=0, le=100_000)

    @property
    def hosted(self) -> bool:
        return self.mode == "hosted"

    @property
    def public_origin(self) -> str:
        address = urlsplit(self.public_url)
        if not address.hostname:
            return ""
        host = address.hostname.encode("idna").decode("ascii")
        if ":" in host:
            host = f"[{host}]"
        port = address.port
        if port is not None and (address.scheme, port) not in {
            ("https", 443),
            ("http", 80),
        }:
            host += f":{port}"
        return f"{address.scheme}://{host}"

    @property
    def secure_cookie(self) -> bool:
        return urlsplit(self.public_url).scheme == "https"

    @property
    def cookie_name(self) -> str:
        return (
            "__Host-careerlens_session" if self.secure_cookie else "careerlens_session"
        )

    @property
    def email_login_available(self) -> bool:
        return self.hosted and bool(self.smtp_host and self.smtp_from)


@lru_cache(maxsize=1)
def get_hosting_settings() -> HostingSettings:
    return HostingSettings()


def is_hosted() -> bool:
    return get_hosting_settings().hosted


def validate_hosting_settings() -> None:
    """Reject unsafe hosted deployments before any persistent startup work."""
    options = get_hosting_settings()
    if not options.hosted:
        return
    address = urlsplit(options.public_url)
    loopback = address.hostname in {"localhost", "127.0.0.1", "::1"}
    if (
        not address.hostname
        or address.scheme not in {"http", "https"}
        or (address.scheme != "https" and not loopback)
        or address.username
        or address.password
        or address.path not in {"", "/"}
        or address.query
        or address.fragment
        or address.port == 0
    ):
        raise ValueError(
            "CAREERLENS_PUBLIC_URL 必须为 HTTPS 网站地址；仅本机测试可用 HTTP"
        )
    if len(options.auth_secret.get_secret_value()) < 32:
        raise ValueError("hosted 模式需要至少 32 字符的 CAREERLENS_AUTH_SECRET")
    smtp_any = any(
        [
            options.smtp_host,
            options.smtp_from,
            options.smtp_username,
            options.smtp_password.get_secret_value(),
        ]
    )
    if smtp_any and not (options.smtp_host and options.smtp_from):
        raise ValueError("SMTP 配置必须同时提供 CAREERLENS_SMTP_HOST 和 SMTP_FROM")
    if bool(options.smtp_username) != bool(options.smtp_password.get_secret_value()):
        raise ValueError("SMTP 用户名和密码必须同时提供")
    if options.smtp_security == "plain" and options.smtp_host not in {
        "localhost",
        "127.0.0.1",
        "::1",
        "",
    }:
        raise ValueError("明文 SMTP 仅允许本机测试收件箱")
    if options.smtp_from and any(c in options.smtp_from for c in "\r\n"):
        raise ValueError("SMTP_FROM 不能包含换行")
    if options.github_url:
        github = urlsplit(options.github_url)
        if (
            github.scheme != "https"
            or github.hostname != "github.com"
            or github.username
        ):
            raise ValueError("CAREERLENS_GITHUB_URL 必须为 GitHub HTTPS 地址")
