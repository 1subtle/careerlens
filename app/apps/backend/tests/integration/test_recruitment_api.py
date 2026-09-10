"""Exercise public-source contracts without network traffic or personal data."""

import asyncio
from collections.abc import AsyncIterator

import httpx
import pytest
from app.main import app
from app.models import Job
from app.routers import career
from app.services import career_ai, recruitment
from httpx import ASGITransport, AsyncClient, MockTransport, Request, Response
from sqlalchemy import select

PREFIX = "/api/v1/career/live"
POST_ID = "2051914911923224576"


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        params={"provider": "tencent"},
    ) as value:
        yield value


@pytest.fixture
def tencent(monkeypatch: pytest.MonkeyPatch):
    def install(handler):
        monkeypatch.setattr(
            recruitment.httpx,
            "AsyncClient",
            lambda **kwargs: AsyncClient(transport=MockTransport(handler), **kwargs),
        )

    return install


def post(post_id: str = POST_ID, **overrides) -> dict:
    return {
        "PostId": post_id,
        "RecruitPostName": "测试数据分析师",
        "LocationName": "广州",
        "CategoryName": "技术",
        "Responsibility": "负责分析问卷结果。",
        "LastUpdateTime": "2026年09月03日",
        **overrides,
    }


def success(data: dict) -> Response:
    return Response(200, json={"Code": 200, "Data": data})


async def stored_jobs(database) -> list[Job]:
    async with database._session() as session:
        return list((await session.scalars(select(Job))).all())


async def test_full_jd_pagination_dates_and_search_does_not_write(
    client: AsyncClient, tencent, isolated_backend_state
) -> None:
    requests = []

    def upstream(request: Request) -> Response:
        requests.append(request)
        assert request.url.host == "careers.tencent.com"
        assert request.url.params["language"] == "zh-cn"
        if request.url.path.endswith("Query"):
            assert dict(request.url.params) == {
                "keyword": "数据分析",
                "pageIndex": "2",
                "pageSize": "10",
                "area": "cn",
                "language": "zh-cn",
            }
            return success({"Count": 26, "Posts": [post()]})
        assert request.url.params["postId"] == POST_ID
        return success(post(Requirement="熟练使用 SQL 和 Python。"))

    tencent(upstream)
    result = await client.get(
        f"{PREFIX}/jobs", params={"keyword": "数据分析", "page": 2}
    )
    assert result.status_code == 200, result.text
    data = result.json()
    job = data["jobs"][0]
    assert (data["total"], data["page"], data["page_size"]) == (26, 2, 10)
    assert data["provider"] == "tencent" and data["source_name"] == "腾讯招聘"
    assert data["fetched_at"] and len(requests) == 2
    assert job["external_id"] == POST_ID and job["job_id"] == f"tencent-{POST_ID}"
    assert job["description_complete"] is True
    assert "任职要求\n熟练使用 SQL 和 Python。" in job["content"]
    assert job["source_updated_at"] == "2026-09-03" and job["published_at"] is None
    assert job["source_url"].startswith("https://careers.tencent.com/jobdesc.html?")
    assert {skill["name"] for skill in data["summary"]["skills"]} == {"SQL", "Python"}
    assert data["summary"]["count"] == 1 and data["warnings"] == []
    assert await stored_jobs(isolated_backend_state) == []


@pytest.mark.parametrize("missing_requirement", [False, True])
async def test_partial_details_excluded_from_stats_and_cannot_be_remembered(
    client: AsyncClient, tencent, isolated_backend_state, missing_requirement: bool
) -> None:
    second_id = "2051914911923224577"

    def upstream(request: Request) -> Response:
        if request.url.path.endswith("Query"):
            return success(
                {
                    "Count": 2,
                    "Posts": [post(), post(second_id, Responsibility="使用 Java。")],
                }
            )
        if request.url.params["postId"] == second_id:
            if missing_requirement:
                return success(post(second_id))
            return Response(503, text="upstream internal diagnostics")
        return success(post(Requirement="熟练使用 SQL。"))

    tencent(upstream)
    data = (await client.get(f"{PREFIX}/jobs")).json()
    assert len(data["jobs"]) == 2 and data["jobs"][1]["description_complete"] is False
    assert data["summary"]["count"] == 1 and data["warnings"]
    assert {s["name"] for s in data["summary"]["skills"]} == {"SQL"}
    failed = await client.post(f"{PREFIX}/jobs/{second_id}/remember")
    assert failed.status_code == 502 and "diagnostics" not in failed.text
    assert await stored_jobs(isolated_backend_state) == []


async def test_remember_is_idempotent_and_preserves_existing_version(
    client: AsyncClient, tencent, isolated_backend_state
) -> None:
    changed = False

    def upstream(request: Request) -> Response:
        return success(
            post(
                request.url.params["postId"],
                Requirement="熟练使用 Python。" if changed else "熟练使用 SQL。",
                LastUpdateTime="2026年09月08日" if changed else "2026年09月03日",
            )
        )

    tencent(upstream)
    first = await client.post(f"{PREFIX}/jobs/{POST_ID}/remember")
    assert first.status_code == 200, first.text
    original = first.json()
    assert original["source_type"] == "api" and original["source_name"] == "腾讯招聘"
    assert original["source_updated_at"] == "2026-09-03"
    changed = True
    repeated = await asyncio.gather(
        *(client.post(f"{PREFIX}/jobs/{POST_ID}/remember") for _ in range(2))
    )
    assert all(result.status_code == 200 for result in repeated)
    assert all(result.json() == original for result in repeated)
    assert len(await stored_jobs(isolated_backend_state)) == 1
    # Distinct upstream IDs stay distinct even if their descriptions are identical.
    changed = False
    other = await client.post(f"{PREFIX}/jobs/2051914911923224577/remember")
    assert other.status_code == 200 and other.json()["job_id"] != original["job_id"]
    assert len(await stored_jobs(isolated_backend_state)) == 2


async def test_detail_enrichment_never_exceeds_three_requests(
    client: AsyncClient, tencent
) -> None:
    active, maximum, searches = 0, 0, 0

    async def upstream(request: Request) -> Response:
        nonlocal active, maximum, searches
        if request.url.path.endswith("Query"):
            searches += 1
            return success(
                {"Count": 800, "Posts": [post(str(i)) for i in range(1, 11)]}
            )
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(0.001)
        active -= 1
        return success(post(request.url.params["postId"], Requirement="熟练使用 SQL。"))

    tencent(upstream)
    result = await client.get(f"{PREFIX}/jobs")
    assert result.status_code == 200 and len(result.json()["jobs"]) == 10
    assert maximum == 3 and searches == 1


@pytest.mark.parametrize(
    "failure,status", [("timeout", 504), ("http", 502), ("json", 502)]
)
async def test_upstream_failures_are_sanitized(
    client: AsyncClient, tencent, failure: str, status: int
) -> None:
    def upstream(request: Request) -> Response:
        if failure == "timeout":
            raise httpx.ReadTimeout("upstream internal diagnostics", request=request)
        if failure == "http":
            return Response(429, text="upstream internal diagnostics")
        return Response(200, text="upstream internal diagnostics")

    tencent(upstream)
    result = await client.get(f"{PREFIX}/jobs")
    assert result.status_code == status and "diagnostics" not in result.text
    assert "腾讯招聘" in result.json()["detail"]


async def test_live_analysis_uses_only_supplied_sample_and_validates_limits(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def forbidden_database_read():
        raise AssertionError("Live analysis must not read remembered jobs")

    calls = []

    async def answer(prompt):
        calls.append(prompt)
        return {"advice": "补充项目中的 SQL 应用证据。"}

    monkeypatch.setattr(career, "all_jobs", forbidden_database_read)
    monkeypatch.setattr(career_ai, "ask_json", answer)
    sample = {
        "title": "样本分析师",
        "text": "熟练使用 SQL。",
        "source_type": "api",
        "source_name": "腾讯招聘",
        "external_id": POST_ID,
        "description_complete": True,
    }
    result = await client.post(
        f"{PREFIX}/analyze", json={"jobs": [sample], "use_ai": True}
    )
    assert result.status_code == 200, result.text
    assert result.json()["summary"]["count"] == 1
    assert result.json()["job_ids"] == [f"tencent-{POST_ID}"]
    assert result.json()["mode"] == "ai" and len(calls) == 1
    empty = await client.post(f"{PREFIX}/analyze", json={"jobs": [], "use_ai": True})
    assert empty.status_code == 200 and empty.json()["summary"]["count"] == 0
    assert empty.json()["mode"] == "rules" and len(calls) == 1
    for body in (
        {"jobs": [sample] * 11},
        {"jobs": [{**sample, "description_complete": False}]},
    ):
        assert (await client.post(f"{PREFIX}/analyze", json=body)).status_code == 422
    for params in ({"page": 0}, {"page": 101}, {"keyword": "a" * 101}):
        assert (await client.get(f"{PREFIX}/jobs", params=params)).status_code == 422
    assert (await client.post(f"{PREFIX}/jobs/not-a-post/remember")).status_code == 422


async def test_live_request_has_an_overall_deadline(
    client: AsyncClient, tencent, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_timeout = asyncio.timeout
    monkeypatch.setattr(asyncio, "timeout", lambda seconds: real_timeout(0.005))

    async def upstream(request: Request) -> Response:
        await asyncio.sleep(0.05)
        return success({"Count": 0, "Posts": []})

    tencent(upstream)
    result = await client.get(f"{PREFIX}/jobs")
    assert result.status_code == 504 and "超时" in result.json()["detail"]
