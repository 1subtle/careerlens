"""Official public-page contracts, with synthetic JDs and an isolated database."""

import asyncio
from collections.abc import AsyncIterator
from datetime import datetime

import pytest
from httpx import ASGITransport, AsyncClient, MockTransport, Request, Response
from sqlalchemy import select

from app.main import app
from app.models import Job
from app.services import ncss

PREFIX = "/api/v1/career/live"


@pytest.fixture
async def client(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[AsyncClient]:
    monkeypatch.setattr(ncss, "_cache", {})
    monkeypatch.setattr(ncss, "_cache_lock", asyncio.Lock())
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as value:
        yield value


@pytest.fixture
def upstream(monkeypatch: pytest.MonkeyPatch):
    def install(handler):
        monkeypatch.setattr(
            ncss.httpx,
            "AsyncClient",
            lambda **kwargs: AsyncClient(transport=MockTransport(handler), **kwargs),
        )

    return install


def post(post_id="abc123", **changes):
    return {
        "jobId": post_id,
        "jobName": "数据工程师",
        "recName": f"测试公司 {post_id}",
        "areaCodeName": "北京",
        "degreeName": "本科及以上",
        "major": "计算机",
        "lowMonthPay": 8,
        "highMonthPay": 12,
        "sourcesName": None,
        "publishDate": int(
            datetime.fromisoformat("2026-09-01T23:30:00+08:00").timestamp() * 1000
        ),
        "updateDate": int(
            datetime.fromisoformat("2026-09-08T00:30:00+08:00").timestamp() * 1000
        ),
        **changes,
    }


def listing(posts, page=1, total=100):
    return Response(
        200,
        json={
            "flag": True,
            "data": {
                "list": posts,
                "pagenation": {"count": total, "limit": 10, "offset": page},
            },
        },
    )


def detail(post_id="abc123", content="熟练使用 Python 和 SQL。", title="数据工程师"):
    return Response(
        200,
        text=f'<li id="jobName">{title}</li><pre class="mainContent">{content}</pre><input name="jobId" value="{post_id}"><footer>导航内容不应成为 JD</footer>',
    )


async def stored(database):
    async with database._session() as session:
        return list((await session.scalars(select(Job))).all())


async def test_default_domestic_search_pagination_dates_full_jd_and_read_only(
    client, upstream, isolated_backend_state
):
    requests = []

    def handle(request: Request):
        requests.append(request)
        assert request.url.host == "www.ncss.cn"
        if request.url.path.endswith("ajax/"):
            assert dict(request.url.params) == {
                "jobName": "数据",
                "offset": "2",
                "limit": "10",
                "sourcesName": "0",
                "recruitType": "0",
            }
            return listing([post()], page=2)
        return detail(
            content="<p>掌握 Python &amp; SQL。<br/>保留换行。</p><script>steal()</script><p>第二段要求</p>"
        )

    upstream(handle)
    data = (
        await client.get(f"{PREFIX}/jobs", params={"keyword": " 数据 ", "page": 2})
    ).json()
    assert data["provider"] == "ncss" and data["total_kind"] == "capped"
    assert data["total"] == 100 and data["page"] == 2 and not data["has_more"]
    job = data["jobs"][0]
    assert job["description_complete"] and job["external_id"] == "abc123"
    assert job["category"] == "数据分析"
    assert (
        job["published_at"] == "2026-09-01" and job["source_updated_at"] == "2026-09-08"
    )
    assert job["salary_text"] == "8-12k/月" and "第二段要求" in job["content"]
    assert "导航" not in job["content"] and "steal" not in job["content"]
    assert {item["name"] for item in data["summary"]["skills"]} == {"Python", "SQL"}
    assert data["summary"]["count"] == 1 and await stored(isolated_backend_state) == []
    again = (
        await client.get(f"{PREFIX}/jobs", params={"keyword": "数据", "page": 2})
    ).json()
    assert (
        again["cached"]
        and len(requests) == 2
        and again["fetched_at"] == data["fetched_at"]
    )


@pytest.mark.parametrize("bad_detail", ["missing", "wrong_id", "wrong_title", "http"])
async def test_incomplete_details_cannot_be_counted_or_remembered(
    client, upstream, isolated_backend_state, bad_detail
):
    def handle(request):
        if request.url.path.endswith("ajax/"):
            return listing([post()])
        return {
            "missing": detail(content=""),
            "wrong_id": detail(post_id="other"),
            "wrong_title": detail(title="另一个岗位"),
            "http": Response(403, text="blocked internal"),
        }[bad_detail]

    upstream(handle)
    data = (await client.get(f"{PREFIX}/jobs")).json()
    assert not data["jobs"][0]["description_complete"] and data["summary"]["count"] == 0
    assert data["warnings"]
    remembered = await client.post(f"{PREFIX}/jobs/abc123/remember")
    assert remembered.status_code == 409 and await stored(isolated_backend_state) == []


async def test_remember_requires_valid_cache_and_preserves_user_changes(
    client, upstream, isolated_backend_state, monkeypatch
):
    clock = [0]
    monkeypatch.setattr(ncss, "monotonic", lambda: clock[0])
    upstream(lambda r: listing([post()]) if r.url.path.endswith("ajax/") else detail())
    assert (await client.post(f"{PREFIX}/jobs/abc123/remember")).status_code == 409
    await client.get(f"{PREFIX}/jobs", params={"keyword": "数据"})
    params = {"keyword": "数据"}
    first = (await client.post(f"{PREFIX}/jobs/abc123/remember", params=params)).json()
    assert first["category"] == "数据分析"
    changed = await client.put(
        f"/api/v1/career/jobs/{first['job_id']}",
        json={
            **first,
            "expected_version": first["version"],
            "title": "我的岗位备注",
            "category": "人工确认的岗位类别",
            "text": first["content"] + "\n我补充的内容",
            "requirements": None,
        },
    )
    assert changed.status_code == 200
    again = (await client.post(f"{PREFIX}/jobs/abc123/remember", params=params)).json()
    assert again["title"] == "我的岗位备注" and again["job_id"] == first["job_id"]
    assert again["category"] == "人工确认的岗位类别"
    assert len(await stored(isolated_backend_state)) == 1
    assert (
        await client.post(f"{PREFIX}/jobs/abc123/remember", params={"keyword": "其他"})
    ).status_code == 409
    clock[0] = 301
    assert (
        await client.post(f"{PREFIX}/jobs/abc123/remember", params=params)
    ).status_code == 409


async def test_page_bound_cache_and_empty_page_stop(client, upstream, monkeypatch):
    clock = [0]
    monkeypatch.setattr(ncss, "monotonic", lambda: clock[0])
    monkeypatch.setattr(ncss, "MAX_CACHE_ENTRIES", 2)

    def handle(request):
        if request.url.path.endswith("ajax/"):
            page = int(request.url.params["offset"])
            return listing(
                [post(f"id{i}") for i in range(10)] if page == 1 else [], page=page
            )
        return detail(request.url.path.split("/")[-2])

    upstream(handle)
    first = (await client.get(f"{PREFIX}/jobs")).json()
    assert first["has_more"] and len(first["jobs"]) == 10
    second = (await client.get(f"{PREFIX}/jobs", params={"page": 2})).json()
    assert second["jobs"] == [] and not second["has_more"]
    assert (await client.get(f"{PREFIX}/jobs", params={"page": 3})).status_code == 429
    clock[0] = 301
    assert (await client.get(f"{PREFIX}/jobs", params={"page": 3})).status_code == 200


@pytest.mark.parametrize(
    "response",
    [
        Response(403, text="upstream debug"),
        Response(200, json={"flag": False, "global": [{"des": "请登录后查看"}]}),
        Response(
            200,
            json={
                "flag": True,
                "data": {
                    "list": [],
                    "pagenation": {"count": 100, "limit": 10, "offset": 9},
                },
            },
        ),
    ],
)
async def test_upstream_failures_are_explicit_and_not_cached(
    client, upstream, response
):
    upstream(lambda r: response)
    result = await client.get(f"{PREFIX}/jobs")
    assert result.status_code == 502 and "debug" not in result.text and not ncss._cache


async def test_invalid_provider_ids_and_regions_do_not_request_upstream(
    client, upstream
):
    def handle(request):
        raise AssertionError("Invalid input must not reach a provider")

    upstream(handle)
    assert (
        await client.get(f"{PREFIX}/jobs", params={"geo": "usa"})
    ).status_code == 422
    assert (
        await client.post(
            f"{PREFIX}/jobs/abc123/remember", params={"provider": "tencent"}
        )
    ).status_code == 422
