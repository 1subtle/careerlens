"""Hosted identities isolate every existing database entry point and export."""

import asyncio
import sys
from contextlib import contextmanager
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.pool import NullPool

from app import auth, hosting
from app.config import settings
from app.database import Database
from app.main import app
from app.models import Job, Resume
from app.preview import PreviewValidationError, job_fingerprint, resume_fingerprint
from app.routers import resumes
from app.tenant_database import TenantContextError, TenantDatabaseProxy


@contextmanager
def identity(user_id):
    token = hosting.current_user_id.set(user_id)
    try:
        yield
    finally:
        hosting.current_user_id.reset(token)


@pytest.fixture
async def hosted(monkeypatch, isolated_backend_state, tmp_path):
    options = hosting.HostingSettings(
        mode="hosted", public_url="https://careerlens.example", auth_secret="x" * 40
    )
    monkeypatch.setattr(hosting, "get_hosting_settings", lambda: options)
    monkeypatch.setattr(auth, "get_hosting_settings", lambda: options)
    store = auth.AuthStore(tmp_path / "auth.sqlite", "test-auth-secret")
    store.initialize()
    monkeypatch.setattr(auth, "get_auth_store", lambda: store)
    proxy = TenantDatabaseProxy(isolated_backend_state, Database, max_cached=2)
    for name, module in tuple(sys.modules.items()):
        if (
            name.startswith("app.")
            and getattr(module, "db", None) is isolated_backend_state
        ):
            monkeypatch.setattr(module, "db", proxy)
    accounts = []
    for email in ("a@example.test", "b@example.test"):
        challenge, code = store.prepare(email, "127.0.0.1")
        store.delivery(challenge, True)
        user, session = store.verify(email, challenge, code, None)
        accounts.append((user["id"], {"Cookie": f"{options.cookie_name}={session}"}))
    yield proxy, accounts, isolated_backend_state
    await proxy.close()


async def test_hosted_http_routes_and_exports_never_cross_workspaces(
    hosted, monkeypatch
):
    proxy, (a, b), operator = hosted
    # Simulate existing local documents. Neither hosted user inherits them.
    for index in range(7):
        await operator.create_resume(content=f"local-only-{index}")
    pdf = AsyncMock(return_value=b"%PDF-synthetic")
    monkeypatch.setattr(resumes, "render_resume_pdf", pdf)
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="https://careerlens.example",
        headers={"Origin": "https://careerlens.example"},
    ) as client:
        for account in (a, b):
            state = (
                await client.get("/api/v1/career/state", headers=account[1])
            ).json()
            assert state["resumes"] == [] and state["jobs"] == []
        assert (await client.get("/api/v1/career/state")).status_code == 401
        assert (await client.get("/api/v1/config", headers=a[1])).status_code == 403
        assert (
            await client.post("/api/v1/config/reset", headers=a[1])
        ).status_code == 403
        created = await client.post(
            "/api/v1/career/resumes",
            headers=a[1],
            json={
                "title": "A private resume",
                "data": {
                    "personalInfo": {"name": "User A"},
                    "summary": "A private evidence",
                },
            },
        )
        assert created.status_code == 200, created.text
        resume = created.json()
        created = await client.post(
            "/api/v1/career/jobs",
            headers=a[1],
            json={"title": "A private JD", "text": "Python岗位要求与A私人笔记"},
        )
        assert created.status_code == 200, created.text
        job = created.json()
        result = await client.post(
            "/api/v1/career/matches",
            headers=a[1],
            json={"resume_id": resume["id"], "job_id": job["job_id"]},
        )
        assert result.status_code == 200, result.text
        match = result.json()
        for path in (
            f"/api/v1/resumes?resume_id={resume['id']}",
            f"/api/v1/jobs/{job['job_id']}",
            f"/api/v1/career/matches/{match['id']}",
            f"/api/v1/resumes/{resume['id']}/pdf",
            f"/api/v1/resumes/{resume['id']}/docx",
        ):
            response = await client.get(path, headers=b[1])
            assert response.status_code == 404, (path, response.text)
            assert (await client.get(path)).status_code == 401
        pdf.assert_not_called()
        cross_match = await client.post(
            "/api/v1/career/matches",
            headers=b[1],
            json={"resume_id": resume["id"], "job_id": job["job_id"]},
        )
        assert cross_match.status_code == 404
        overwrite = await client.put(
            f"/api/v1/career/resumes/{resume['id']}",
            headers=b[1],
            json={"title": "B overwrite", "data": {}},
        )
        assert overwrite.status_code == 404
        for path in (
            f"/api/v1/career/resumes/{resume['id']}",
            f"/api/v1/resumes/{resume['id']}",
            f"/api/v1/career/jobs/{job['job_id']}",
        ):
            assert (await client.delete(path, headers=b[1])).status_code == 404
        assert (await client.get("/api/v1/resumes/list", headers=b[1])).json()[
            "data"
        ] == []
        assert (
            await client.get(f"/api/v1/resumes/{resume['id']}/pdf", headers=a[1])
        ).status_code == 200
        assert (
            await client.get(f"/api/v1/resumes/{resume['id']}/docx", headers=a[1])
        ).status_code == 200
        assert (await client.get(f"/api/v1/jobs/{job['job_id']}", headers=a[1])).json()[
            "content"
        ] == job["content"]
        assert (
            await client.get(f"/api/v1/career/matches/{match['id']}", headers=a[1])
        ).status_code == 200
    assert hosting.current_user_id.get() is None
    assert hosting.current_session_cookie.get() is None
    assert (await operator.get_stats())["total_resumes"] == 7
    with identity(a[0]):
        assert proxy.db_path == settings.data_dir / "users" / a[0] / "workspace.sqlite"


async def test_context_survives_background_work_threads_and_lru_eviction(hosted):
    proxy, (a, b), _operator = hosted
    with pytest.raises(TenantContextError):
        await proxy.get_stats()
    with identity("../../operator"), pytest.raises(TenantContextError):
        await proxy.get_stats()
    ready, release = asyncio.Event(), asyncio.Event()

    async def background():
        ready.set()
        await release.wait()
        thread_path = await asyncio.to_thread(lambda: proxy.db_path)
        created = await proxy.create_resume(content="A background private")
        return thread_path, created

    with identity(a[0]):
        task = asyncio.create_task(background())
        bound_create = proxy.create_resume
        async with proxy._session() as active:
            await active.execute(text("SELECT 1"))
            await ready.wait()
            with identity(b[0]):
                assert (await proxy.get_stats())["total_resumes"] == 0
                # Bound facade calls keep their originating tenant.
                await bound_create(content="A bound private")
            with identity(str(uuid4())):
                await proxy.get_stats()
            assert len(proxy._tenants) == 2
            assert await active.scalar(text("SELECT count(*) FROM resumes")) == 1
        release.set()
    path, _created = await task
    assert a[0] in str(path)
    with identity(a[0]):
        assert (await proxy.get_stats())["total_resumes"] == 2
        assert isinstance(proxy._async_engine.pool, NullPool)
        assert isinstance(proxy._sync_engine.pool, NullPool)
    with identity(b[0]):
        assert (await proxy.get_stats())["total_resumes"] == 0


async def test_local_mode_and_tenant_reset_keep_operator_and_other_uploads(
    hosted, monkeypatch
):
    proxy, (a, b), operator = hosted
    await operator.create_resume(content="local private")
    local_uploads = operator.db_path.parent / "uploads"
    local_uploads.mkdir()
    (local_uploads / "local.txt").write_text("local private")
    with identity(a[0]):
        await proxy.create_resume(content="A private")
        a_uploads = proxy.db_path.parent / "uploads"
        a_uploads.mkdir()
        (a_uploads / "a.txt").write_text("A private")
        with identity(b[0]):
            await proxy.create_resume(content="B private")
            b_uploads = proxy.db_path.parent / "uploads"
            b_uploads.mkdir()
            (b_uploads / "b.txt").write_text("B private")
        await proxy.reset_database()
        assert list(a_uploads.iterdir()) == []
    assert (b_uploads / "b.txt").read_text() == "B private"
    assert (local_uploads / "local.txt").read_text() == "local private"
    with identity(b[0]):
        assert (await proxy.get_stats())["total_resumes"] == 1
    monkeypatch.setattr(hosting, "is_hosted", lambda: False)
    assert proxy.db_path == operator.db_path
    assert (await proxy.get_stats())["total_resumes"] == 1


@pytest.mark.parametrize("endpoint", ["/api/v1/jobs/upload", "/api/v1/applications"])
async def test_foreign_resume_reference_cannot_create_orphan_jobs_or_cards(hosted, endpoint):
    proxy, (a, b), _operator = hosted
    with identity(a[0]):
        private = await proxy.create_resume(content="Synthetic A document")
    with identity(b[0]):
        own = await proxy.create_resume(content="Synthetic B document")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="https://careerlens.example",
        headers={"Origin": "https://careerlens.example"},
    ) as client:
        payload = (
            {"job_descriptions": ["Synthetic role"]}
            if endpoint.endswith("upload")
            else {"job_description": "Synthetic role", "company": "Example", "role": "Engineer"}
        )
        for forbidden in (private["resume_id"], str(uuid4())):
            result = await client.post(
                endpoint, headers={**b[1], "X-User-ID": a[0]},
                json={**payload, "resume_id": forbidden},
            )
            assert result.status_code == 404, result.text
        with identity(b[0]):
            assert (await proxy.get_stats())["total_jobs"] == 0
            assert await proxy.list_applications() == []
        assert (await client.post(
            endpoint, headers=b[1], json={**payload, "resume_id": own["resume_id"]},
        )).status_code == 200
        with identity(a[0]):
            assert (await proxy.get_stats())["total_jobs"] == 0
            assert (await proxy.get_resume(private["resume_id"]))["content"] == "Synthetic A document"


async def test_rewrite_and_tracker_mutations_cannot_target_another_workspace(hosted):
    from tests.integration.test_career_api import seed

    _proxy, (a, b), _operator = hosted
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="https://careerlens.example",
        headers={"Origin": "https://careerlens.example", **a[1]},
    ) as client:
        resume, job, match = await seed(client)
        created = await client.post("/api/v1/career/rewrites", json={
            "match_id": match["id"], "section_id": match["evidence"][0]["id"],
        })
        assert created.status_code == 200, created.text
        rewrite = created.json()
        created = await client.post("/api/v1/applications", json={
            "resume_id": resume["id"], "job_description": "Synthetic role",
            "company": "Example", "role": "Engineer", "notes": "Synthetic private note",
        })
        assert created.status_code == 200, created.text
        card_id = created.json()["application_id"]
        attempts = [
            ("GET", f"/api/v1/applications/{card_id}", None),
            ("PATCH", f"/api/v1/applications/{card_id}", {"notes": "Unauthorized edit"}),
            ("DELETE", f"/api/v1/applications/{card_id}", None),
            ("POST", f"/api/v1/career/rewrites/{rewrite['id']}/apply", {"confirmed": True}),
            ("POST", f"/api/v1/career/rewrites/{rewrite['id']}/reject", None),
            ("POST", "/api/v1/career/rewrites", {"match_id": match["id"], "section_id": match["evidence"][0]["id"]}),
            ("POST", f"/api/v1/career/matches/{match['id']}/review", {"requirement_id": "q1", "status": "gap"}),
            ("POST", "/api/v1/resumes/improve/confirm", {"resume_id": resume["id"], "job_id": job["job_id"], "improved_data": resume["data"], "improvements": []}),
            ("POST", f"/api/v1/resumes/{resume['id']}/retry-processing", None),
            ("PATCH", f"/api/v1/resumes/{resume['id']}/title", {"title": "Unauthorized title"}),
        ]
        for method, path, payload in attempts:
            result = await client.request(method, path, headers=b[1], json=payload)
            assert result.status_code == 404, (path, result.text)
        for path, payload in (
            ("/api/v1/applications/bulk", {"application_ids": [card_id], "status": "rejected"}),
            ("/api/v1/applications/bulk-delete", {"application_ids": [card_id]}),
        ):
            result = await client.request(
                "PATCH" if path.endswith("/bulk") else "POST", path, headers=b[1], json=payload,
            )
            assert result.status_code == 200 and result.json()["affected"] == 0
        assert (await client.get(f"/api/v1/applications/{card_id}")).json()["notes"] == "Synthetic private note"
        own_match = (await client.get(f"/api/v1/career/matches/{match['id']}")).json()
        assert own_match["rewrites"][0]["status"] == "draft"
        assert (await client.post(f"/api/v1/career/rewrites/{rewrite['id']}/apply", json={"confirmed": True})).status_code == 200


async def test_same_ids_concurrent_reads_preview_replay_and_cleanup_stay_scoped(hosted):
    proxy, (a, b), _operator = hosted
    resume_id, job_id = str(uuid4()), str(uuid4())
    # Identical IDs defeat any accidental result cache keyed only by document ID.
    for account, marker in ((a, "Synthetic A"), (b, "Synthetic B")):
        with identity(account[0]):
            async with proxy._write_session() as session:
                session.add(Resume(resume_id=resume_id, content=marker, processed_data={"summary": marker}, processing_status="processing"))
                session.add(Job(job_id=job_id, content=marker))
                await session.commit()
    proxy._max_cached = 1
    with identity(a[0]):
        preview = await proxy.register_preview(
            source_id=resume_id, job_id=job_id, payload_hash="synthetic-payload",
            source_hash=resume_fingerprint("Synthetic A", {"summary": "Synthetic A"}, None),
            job_hash=job_fingerprint("Synthetic A"), prompt_id="test", ttl_seconds=60,
        )
        parameters = dict(preview_id=preview["preview_id"], source_id=resume_id, job_id=job_id, payload_hash="synthetic-payload", lease_seconds=60)
        claim = await proxy.claim_preview(**parameters)
        await proxy.complete_preview(claim=claim, resume_fields={"content": "Synthetic A result"}, response_data={"request_id": str(uuid4()), "private": "Synthetic A result"}, improvements=[])
        processing = await proxy.claim_resume_processing(resume_id)
        assert processing is not None
        cleanup = asyncio.create_task(resumes._retire_processing_attempt(resume_id, processing))
    with identity(b[0]):
        with pytest.raises(PreviewValidationError):
            await proxy.claim_preview(**parameters)
        assert "preview_hash" not in await proxy.get_job(job_id)
        await cleanup
        assert (await proxy.get_resume(resume_id))["processing_status"] == "processing"
    with identity(a[0]):
        assert (await proxy.claim_preview(**parameters)).response["private"] == "Synthetic A result"
        assert (await proxy.get_resume(resume_id))["processing_status"] == "failed"
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="https://careerlens.example",
    ) as client:
        async def check(account, marker):
            for _ in range(3):
                result = await client.get("/api/v1/resumes", headers=account[1], params={"resume_id": resume_id})
                assert result.status_code == 200, result.text
                assert result.json()["data"]["raw_resume"]["content"] == marker
                result = await client.get(f"/api/v1/jobs/{job_id}", headers=account[1])
                assert result.json()["content"] == marker
        await asyncio.gather(check(a, "Synthetic A"), check(b, "Synthetic B"))


async def test_deleting_job_removes_its_private_preview_without_touching_other_users(hosted):
    proxy, (a, b), _operator = hosted
    job_id = str(uuid4())
    previews = {}
    for account, marker in ((a, "Synthetic A"), (b, "Synthetic B")):
        with identity(account[0]):
            resume = await proxy.create_resume(content=marker)
            async with proxy._write_session() as session:
                session.add(Job(job_id=job_id, content=marker))
                await session.commit()
            previews[account[0]] = await proxy.register_preview(
                source_id=resume["resume_id"], job_id=job_id,
                payload_hash="synthetic-payload",
                source_hash=resume_fingerprint(marker, None, None),
                job_hash=job_fingerprint(marker), prompt_id="test", ttl_seconds=60,
                improvements=[{"description": marker}],
            )
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="https://careerlens.example",
        headers={"Origin": "https://careerlens.example", **a[1]},
    ) as client:
        deleted = await client.delete(f"/api/v1/career/jobs/{job_id}")
        assert deleted.status_code == 200, deleted.text
        assert (await client.delete(f"/api/v1/career/jobs/{job_id}")).status_code == 404
    for account in (a, b):
        with identity(account[0]):
            async with proxy._session() as session:
                remaining = await session.scalar(text(
                    "SELECT count(*) FROM tailoring_previews WHERE preview_id = :id"
                ), {"id": previews[account[0]]["preview_id"]})
            assert remaining == (0 if account == a else 1)
            assert (await proxy.get_job(job_id) is not None) == (account == b)
