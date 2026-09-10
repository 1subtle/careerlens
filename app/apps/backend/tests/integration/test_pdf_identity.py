"""A fresh print page receives only its authenticated user's scoped identity."""

import asyncio
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from playwright.async_api import Error as PlaywrightError
from playwright.async_api import async_playwright

from app import hosting
from app.config import settings
from app.pdf import (
    PDFRenderError,
    _authenticate_print_page,
    _launch_browser,
    _render_page_to_pdf,
)


@pytest.fixture
def hosted_pdf(monkeypatch):
    monkeypatch.setattr(hosting, "is_hosted", lambda: True)
    monkeypatch.setattr(settings, "frontend_base_url", "http://127.0.0.1:3001")
    identity = hosting.current_user_id.set(str(uuid4()))
    cookie = hosting.current_session_cookie.set(
        ("__Host-careerlens_session", "user-A-session")
    )
    yield
    hosting.current_session_cookie.reset(cookie)
    hosting.current_user_id.reset(identity)


def route_for(url, status=200):
    return SimpleNamespace(
        request=SimpleNamespace(
            url=url, headers={"accept": "text/html", "cookie": "other=private"}
        ),
        fetch=AsyncMock(
            return_value=SimpleNamespace(
                status=status, headers={"content-type": "text/html"}
            )
        ),
        fulfill=AsyncMock(),
        abort=AsyncMock(),
        continue_=AsyncMock(),
    )


async def handler_for(url="http://127.0.0.1:3001/print/resumes/owned-id"):
    page = SimpleNamespace(route=AsyncMock())
    await _authenticate_print_page(page, url, asyncio.get_running_loop().time() + 30)
    return page.route.await_args.args[1]


async def test_cookie_is_scoped_to_its_page_and_never_forwarded_off_origin(hosted_pdf):
    handler = await handler_for()
    # A second concurrent request changes its own context, not the existing route closure.
    token = hosting.current_session_cookie.set(
        ("__Host-careerlens_session", "user-B-session")
    )
    try:
        for path in (
            "/print/resumes/owned-id",
            "/print/cover-letter/owned-id",
            "/api/v1/resumes",
        ):
            route = route_for(f"http://127.0.0.1:3001{path}")
            await handler(route)
            assert (
                route.fetch.await_args.kwargs["headers"]["cookie"]
                == "__Host-careerlens_session=user-A-session"
            )
            assert route.fetch.await_args.kwargs["max_redirects"] == 0
            route.fulfill.assert_awaited_once()
        external = route_for("https://third-party.example/font.woff2")
        await handler(external)
        external.abort.assert_awaited_once()
        external.fetch.assert_not_called()
        external.continue_.assert_not_called()
        static = route_for("http://127.0.0.1:3001/_next/static/fonts/font.woff2")
        await handler(static)
        static.fetch.assert_not_called()
        static.continue_.assert_awaited_once_with()
    finally:
        hosting.current_session_cookie.reset(token)


async def test_cookie_cannot_follow_redirect_or_untrusted_print_destination(hosted_pdf):
    handler = await handler_for()
    redirect = route_for("http://127.0.0.1:3001/print/resumes/owned-id", 302)
    await handler(redirect)
    redirect.abort.assert_awaited_once()
    redirect.fulfill.assert_not_called()
    failed = route_for("http://127.0.0.1:3001/print/resumes/owned-id")
    failed.fetch.side_effect = PlaywrightError(
        "request headers: cookie=private-session"
    )
    await handler(failed)
    failed.abort.assert_awaited_once()
    with pytest.raises(PDFRenderError, match="destination"):
        await handler_for("https://third-party.example/print/resumes/owned-id")
    token = hosting.current_session_cookie.set(None)
    try:
        with pytest.raises(PDFRenderError, match="session"):
            await handler_for()
    finally:
        hosting.current_session_cookie.reset(token)


async def test_real_chromium_can_authenticate_secure_named_cookie_on_internal_http(
    hosted_pdf,
    monkeypatch,
):
    received = []

    class PrintServer(BaseHTTPRequestHandler):
        def do_GET(self):
            received.append(self.headers.get("Cookie"))
            authorized = received[-1] == "__Host-careerlens_session=user-A-session"
            self.send_response(200 if authorized else 401)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(
                b'<html><body><div class="resume-print">Synthetic private resume</div></body></html>'
                if authorized
                else b"Unauthenticated"
            )

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), PrintServer)
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
    )
    thread.start()
    origin = f"http://127.0.0.1:{server.server_port}"
    monkeypatch.setattr(settings, "frontend_base_url", origin)
    try:
        async with async_playwright() as playwright:
            try:
                browser = await _launch_browser(playwright)
            except (PlaywrightError, PDFRenderError) as error:
                if "executable" in str(error).lower():
                    pytest.skip("Chromium unavailable")
                raise
            try:
                page = await browser.new_page()
                document = await _render_page_to_pdf(
                    page,
                    f"{origin}/print/resumes/owned-id",
                    ".resume-print",
                    "A4",
                    {},
                )
                assert document.startswith(b"%PDF")
                assert received == ["__Host-careerlens_session=user-A-session"]
                await page.close()
            finally:
                await browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=1)
