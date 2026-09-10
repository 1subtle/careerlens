"""Jobicy feed tests isolate both public HTTP traffic and the in-memory cache."""

import asyncio
from collections.abc import AsyncIterator

import httpx
import pytest
from httpx import ASGITransport, AsyncClient, MockTransport, Request, Response
from sqlalchemy import select

from app.main import app
from app.models import Job
from app.services import jobicy

PREFIX = "/api/v1/career/live"


@pytest.fixture
async def client(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[AsyncClient]:
    monkeypatch.setattr(jobicy, "_cache", {})
    monkeypatch.setattr(jobicy, "_cache_lock", asyncio.Lock())
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        params={"provider": "jobicy"},
    ) as value:
        yield value


@pytest.fixture
def upstream(monkeypatch: pytest.MonkeyPatch):
    def install(handler):
        monkeypatch.setattr(
            jobicy.httpx,
            "AsyncClient",
            lambda **kwargs: AsyncClient(transport=MockTransport(handler), **kwargs),
        )

    return install


def post(post_id: int = 1, **changes) -> dict:
    return {
        "id": post_id,
        "url": f"https://jobicy.com/jobs/{post_id}-data-engineer",
        "jobTitle": "Data Engineer",
        "companyName": f"Company {post_id}",
        "jobGeo": "USA",
        "jobIndustry": ["Data Science & Analytics"],
        "jobDescription": "<h2>Requirements</h2><p>Use <strong>Python</strong> &amp; SQL.</p><ul><li>Build reports.</li><li>Work with colleagues.</li></ul><script>secretScript()</script><style>.secretStyle {color:red}</style>",
        "pubDate": "2026-09-08T05:10:08+00:00",
        "salaryMin": 100000,
        "salaryMax": 120000,
        "salaryCurrency": "EUR",
        "salaryPeriod": "yearly",
        **changes,
    }


def feed(jobs: list[dict]) -> Response:
    return Response(
        200,
        json={"success": True, "statusCode": 200, "jobCount": len(jobs), "jobs": jobs},
    )


async def stored_jobs(database) -> list[Job]:
    async with database._session() as session:
        return list((await session.scalars(select(Job))).all())


async def test_default_source_pagination_and_metadata_are_real_sample_semantics(
    client: AsyncClient, upstream, isolated_backend_state
) -> None:
    requests = []

    def respond(request: Request) -> Response:
        requests.append(request)
        assert request.url.host == "jobicy.com"
        assert dict(request.url.params) == {
            "count": "200",
            "tag": "python",
            "geo": "usa",
        }
        return feed([post(i) for i in range(1, 16)])

    upstream(respond)
    first = await client.get(
        f"{PREFIX}/jobs", params={"keyword": "Python", "geo": "usa"}
    )
    assert first.status_code == 200, first.text
    data = first.json()
    assert data["provider"] == "jobicy" and data["source_name"] == "Jobicy"
    assert data["total"] == 15 and data["total_kind"] == "sample"
    assert data["cached"] is False and data["coverage"] and data["update_note"]
    assert len(data["jobs"]) == 10 and data["summary"]["count"] == 10
    assert len({job["company"] for job in data["jobs"]}) == 10
    job = data["jobs"][0]
    assert job["job_id"] == "jobicy-1" and job["external_id"] == "1"
    assert job["source_type"] == "api" and job["description_complete"] is True
    assert job["published_at"] == "2026-09-08" and job["source_updated_at"] is None
    assert job["created_at"] == data["fetched_at"] == job["collected_at"]
    assert job["salary_text"] == "" and data["summary"]["salaries"] == []
    assert job["salary_display"] == "100000–120000 EUR/年"
    assert "100000–120000 EUR/年" in job["content"]
    assert "Python & SQL." in job["content"] and "\n" in job["content"]
    assert (
        "<" not in job["content"]
        and "secretScript" not in job["content"]
        and "secretStyle" not in job["content"]
    )
    assert "USA" in job["content"]
    second = (
        await client.get(
            f"{PREFIX}/jobs", params={"keyword": " python ", "geo": "usa", "page": 2}
        )
    ).json()
    assert second["cached"] is True and len(second["jobs"]) == 5
    assert second["fetched_at"] == data["fetched_at"] and len(requests) == 1
    assert second["jobs"][0]["external_id"] == "11"
    assert await stored_jobs(isolated_backend_state) == []


async def test_cache_single_fetch_ttl_and_bounded_query_capacity(
    client: AsyncClient, upstream, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = 0
    clock = [1000.0]
    monkeypatch.setattr(jobicy, "monotonic", lambda: clock[0])
    monkeypatch.setattr(jobicy, "MAX_CACHE_ENTRIES", 2)

    async def respond(request: Request) -> Response:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.005)
        return feed([post(calls)])

    upstream(respond)
    replies = await asyncio.gather(*(client.get(f"{PREFIX}/jobs") for _ in range(3)))
    assert calls == 1 and all(reply.status_code == 200 for reply in replies)
    assert sum(reply.json()["cached"] for reply in replies) == 2
    clock[0] += 3599
    assert (await client.get(f"{PREFIX}/jobs", params={"geo": "all"})).json()[
        "cached"
    ] is True
    assert calls == 1
    assert (
        await client.get(f"{PREFIX}/jobs", params={"geo": "china"})
    ).status_code == 200
    assert (
        await client.get(f"{PREFIX}/jobs", params={"geo": "usa"})
    ).status_code == 429
    assert calls == 2 and len(jobicy._cache) == 2
    clock[0] += 2
    refreshed = await client.get(f"{PREFIX}/jobs")
    assert refreshed.status_code == 200 and refreshed.json()["cached"] is False
    assert calls == 3 and len(jobicy._cache) == 2


async def test_remember_requires_server_cache_and_keeps_sources_independent(
    client: AsyncClient,
    upstream,
    isolated_backend_state,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = [1000.0]
    monkeypatch.setattr(jobicy, "monotonic", lambda: clock[0])
    calls = []

    def respond(request: Request) -> Response:
        calls.append(request)
        return feed([post()])

    upstream(respond)
    missing = await client.post(
        f"{PREFIX}/jobs/1/remember", json={"text": "Invented official JD"}
    )
    assert missing.status_code == 409 and calls == []
    await client.get(f"{PREFIX}/jobs", params={"geo": "china", "keyword": "python"})
    assert (await client.post(f"{PREFIX}/jobs/1/remember")).status_code == 409
    params = {"geo": "china", "keyword": "python"}
    assert (
        await client.post(f"{PREFIX}/jobs/2/remember", params=params)
    ).status_code == 404
    results = await asyncio.gather(
        *(
            client.post(
                f"{PREFIX}/jobs/1/remember",
                params=params,
                json={"text": "Invented official JD"},
            )
            for _ in range(2)
        )
    )
    assert all(result.status_code == 200 for result in results), [
        r.text for r in results
    ]
    assert results[0].json() == results[1].json()
    saved = results[0].json()
    assert "Invented" not in saved["content"] and saved["source_name"] == "Jobicy"
    assert saved["source_url"] == "https://jobicy.com/jobs/1-data-engineer"
    assert saved["published_at"] == "2026-09-08" and len(calls) == 1
    assert len(await stored_jobs(isolated_backend_state)) == 1
    other_source = await client.post(
        "/api/v1/career/jobs",
        json={
            "title": "Another source",
            "text": saved["content"],
            "company": saved["company"],
            "source_type": "api",
            "source_name": "腾讯招聘",
            "external_id": "1",
        },
    )
    assert (
        other_source.status_code == 200
        and other_source.json()["job_id"] != saved["job_id"]
    )
    assert len(await stored_jobs(isolated_backend_state)) == 2
    clock[0] += 3601
    assert (
        await client.post(f"{PREFIX}/jobs/1/remember", params=params)
    ).status_code == 409
    assert len(calls) == 1


async def test_invalid_sources_are_excluded_and_empty_batches_remain_empty(
    client: AsyncClient, upstream
) -> None:
    def respond(request: Request) -> Response:
        if request.url.params.get("geo") == "europe":
            return Response(
                200, json={"success": True, "statusCode": 200, "jobCount": 0}
            )
        return feed(
            [
                post(),
                post(),
                post(2, jobDescription="<script>noJob()</script>"),
                post(3, url="https://unrelated.example/jobs/3"),
                post(4, jobDescription=None),
            ]
        )

    upstream(respond)
    data = (await client.get(f"{PREFIX}/jobs")).json()
    assert data["total"] == 1 and len(data["jobs"]) == 1 and data["warnings"]
    empty = await client.get(f"{PREFIX}/jobs", params={"geo": "europe"})
    assert (
        empty.status_code == 200
        and empty.json()["total"] == 0
        and empty.json()["summary"]["count"] == 0
    )
    for params in (
        {"provider": "private-source"},
        {"geo": "invented"},
        {"keyword": "a" * 51},
        {"keyword": "ab"},
    ):
        assert (await client.get(f"{PREFIX}/jobs", params=params)).status_code == 422


@pytest.mark.parametrize(
    "error,status", [("http", 502), ("timeout", 504), ("invalid_json", 502)]
)
async def test_errors_are_explicit_and_never_cached(
    client: AsyncClient, upstream, error: str, status: int
) -> None:
    def respond(request: Request) -> Response:
        if error == "timeout":
            raise httpx.ReadTimeout("private diagnostics", request=request)
        return Response(500 if error == "http" else 200, text="private diagnostics")

    upstream(respond)
    result = await client.get(f"{PREFIX}/jobs")
    assert result.status_code == status and "diagnostics" not in result.text
    assert "Jobicy" in result.json()["detail"] and not jobicy._cache


async def test_analysis_has_distinct_provider_ids(client: AsyncClient) -> None:
    jobs = [
        {
            "title": "Data",
            "text": "SQL",
            "source_type": "api",
            "external_id": "1",
            "source_name": source,
        }
        for source in ["腾讯招聘", "Jobicy"]
    ]
    result = await client.post(f"{PREFIX}/analyze", json={"jobs": jobs})
    assert result.status_code == 200, result.text
    assert result.json()["summary"]["count"] == 2
    assert result.json()["job_ids"] == ["tencent-1", "jobicy-1"]
