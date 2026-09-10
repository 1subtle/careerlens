"""Read requested pages from the official graduate employment site's public search."""

import asyncio
import copy
import math
import re
from datetime import UTC, datetime, timedelta, timezone
from html.parser import HTMLParser
from time import monotonic
from typing import Any

import httpx
from fastapi import HTTPException

from app.schemas.career import JobInput
from app.services.jobicy import description_text
from app.services.matching import (
    category_from_title,
    market_summary,
    requirements_from_text,
)

SOURCE_NAME = "国家大学生就业服务平台"
SOURCE_URL = "https://www.ncss.cn/student/jobs/index.html"
API_URL = "https://www.ncss.cn/student/jobs/jobslist/ajax/"
PAGE_SIZE = 10
CACHE_SECONDS = 300
MAX_CACHE_ENTRIES = 32
ID_PATTERN = r"[A-Za-z0-9]{1,64}"
_cache: dict[tuple[str, int], dict[str, Any]] = {}
_cache_lock = asyncio.Lock()


class _JobDetail(HTMLParser):
    """Extract only the official title, ID and JD, excluding page navigation."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.fields: dict[str, list[str]] = {"title": [], "description": []}
        self.ids: set[str] = set()
        self.active: str | None = None
        self.depth = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        data = dict(attrs)
        if tag == "input" and data.get("name") == "jobId" and data.get("value"):
            self.ids.add(data["value"])
        if self.active:
            self.fields[self.active].append(self.get_starttag_text())
            if tag not in {"br", "img", "input", "hr", "meta", "link", "wbr"}:
                self.depth += 1
        elif data.get("id") == "jobName":
            self.active, self.depth = "title", 1
        elif "mainContent" in (data.get("class") or "").split():
            self.active, self.depth = "description", 1

    def handle_endtag(self, tag: str) -> None:
        if tag in {"br", "img", "input", "hr", "meta", "link", "wbr"}:
            return
        if self.active:
            self.depth -= 1
            if self.depth == 0:
                self.active = None
            else:
                self.fields[self.active].append(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        if self.active:
            self.fields[self.active].append(data)

    def handle_entityref(self, name: str) -> None:
        self.handle_data(f"&{name};")

    def handle_charref(self, name: str) -> None:
        self.handle_data(f"&#{name};")


def _source_date(value: Any) -> str | None:
    if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
        return None
    try:
        return (
            datetime.fromtimestamp(value / 1000, tz=timezone(timedelta(hours=8)))
            .date()
            .isoformat()
        )
    except (ValueError, OverflowError, OSError):
        return None


def _salary(post: dict[str, Any]) -> str:
    low, high = post.get("lowMonthPay"), post.get("highMonthPay")
    if (
        all(type(v) in (int, float) and math.isfinite(v) and v > 0 for v in (low, high))
        and low <= high
    ):
        return f"{low:g}-{high:g}k/月"
    return ""


def _job_view(post: dict[str, Any], fetched_at: str) -> dict[str, Any]:
    post_id = post.get("jobId", "")
    if not isinstance(post_id, str) or not re.fullmatch(ID_PATTERN, post_id):
        raise ValueError("Invalid job ID")
    # sourcesName=0 requests the platform's own listings, not partner snippets.
    if post.get("sourcesName") not in (None, "", "0", 0):
        raise ValueError("Unexpected partner listing")
    salary = _salary(post)
    context = [
        f"学历要求：{post['degreeName']}" if post.get("degreeName") else "",
        f"专业要求：{post['major']}" if post.get("major") else "",
        f"来源薪资：{salary}" if salary else "",
    ]
    request = JobInput(
        title=post.get("jobName", ""),
        category=category_from_title(post.get("jobName", "")),
        company=post.get("recName", ""),
        text="\n".join(item for item in context if item) or "岗位详情暂未取得。",
        city=post.get("areaCodeName") or "",
        salary_text=salary,
        source_type="api",
        source_name=SOURCE_NAME,
        source_url=f"https://www.ncss.cn/student/jobs/{post_id}/detail.html",
        external_id=post_id,
        published_at=_source_date(post.get("publishDate")),
        source_updated_at=_source_date(post.get("updateDate")),
    )
    if not request.company:
        raise ValueError("Missing employer")
    return {
        **request.model_dump(mode="json", exclude={"text", "use_ai"}),
        "job_id": f"ncss-{post_id}",
        "content": request.text,
        "role": request.title,
        "created_at": fetched_at,
        "collected_at": fetched_at,
        "requirements": [],
        "description_complete": False,
        "salary_display": salary,
    }


async def _detail(client: httpx.AsyncClient, job: dict[str, Any]) -> dict[str, Any]:
    response = await client.get(job["source_url"])
    response.raise_for_status()
    parser = _JobDetail()
    parser.feed(response.text)
    title = description_text("".join(parser.fields["title"]))
    content = description_text("".join(parser.fields["description"]))
    if job["external_id"] not in parser.ids or title != job["title"] or not content:
        raise ValueError("Missing or mismatched job details")
    if job["content"] != "岗位详情暂未取得。":
        content = job["content"] + "\n\n" + content
    # Apply the same JD size and metadata validation as manually remembered jobs.
    request = JobInput.model_validate({**job, "text": content, "requirements": None})
    return {
        **job,
        "content": request.text,
        "description_complete": True,
        "requirements": requirements_from_text(request.text),
    }


async def _fetch(keyword: str, page: int) -> dict[str, Any]:
    fetched_at = datetime.now(UTC).isoformat()
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(
                API_URL,
                params={
                    "jobName": keyword,
                    "offset": page,
                    "limit": PAGE_SIZE,
                    "sourcesName": "0",
                    "recruitType": "0",
                },
            )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict) or payload.get("flag") is not True:
                raise ValueError("Search unavailable")
            data = payload["data"]
            posts, paging = data["list"], data["pagenation"]
            total = paging["count"]
            if (
                not isinstance(posts, list)
                or type(total) is not int
                or total < 0
                or paging.get("offset") != page
                or paging.get("limit") != PAGE_SIZE
            ):
                raise ValueError("Invalid pagination")
            previews = []
            rejected = 0
            for post in posts[:PAGE_SIZE]:
                try:
                    if not isinstance(post, dict):
                        raise TypeError("Invalid job")
                    previews.append(_job_view(post, fetched_at))
                except (ValueError, TypeError):
                    rejected += 1
            semaphore = asyncio.Semaphore(3)

            async def enrich(job: dict[str, Any]) -> dict[str, Any]:
                async with semaphore:
                    try:
                        return await _detail(client, job)
                    except (httpx.HTTPError, ValueError, TypeError):
                        return job

            jobs = await asyncio.gather(*(enrich(job) for job in previews))
    except httpx.TimeoutException:
        raise HTTPException(
            504, "国家大学生就业服务平台响应超时，请稍后重试。"
        ) from None
    except (httpx.HTTPError, ValueError, TypeError, KeyError):
        raise HTTPException(
            502, "国家大学生就业服务平台暂时无法提供岗位，请稍后重试。"
        ) from None
    missing = sum(not job["description_complete"] for job in jobs)
    warnings = []
    if missing:
        warnings.append(f"{missing} 个岗位未取得完整 JD，已排除统计，暂时不能记住。")
    if rejected:
        warnings.append(f"{rejected} 条岗位缺少有效来源信息，已排除。")
    return {
        "jobs": jobs,
        "total": total,
        "has_more": len(posts) >= PAGE_SIZE and page * PAGE_SIZE < total,
        "fetched_at": fetched_at,
        "warnings": warnings,
        "expires_at": monotonic() + CACHE_SECONDS,
    }


def _keyword(keyword: str, geo: str) -> str:
    if geo not in ("", "all", "china"):
        raise HTTPException(422, "该来源仅提供国内岗位，请选择全部地区或中国。")
    return keyword.strip()


async def search_jobs(keyword: str, page: int, geo: str = "") -> dict[str, Any]:
    keyword = _keyword(keyword, geo)
    key = (keyword, page)
    # ponytail: serialize misses for a bounded local tool, not a background crawler.
    async with _cache_lock:
        snapshot = _cache.get(key)
        cached = snapshot is not None and snapshot["expires_at"] > monotonic()
        if not cached:
            for old_key in [
                k for k, v in _cache.items() if v["expires_at"] <= monotonic()
            ]:
                del _cache[old_key]
            if len(_cache) >= MAX_CACHE_ENTRIES:
                raise HTTPException(429, "查询缓存已满，请使用已有结果或稍后重试。")
            snapshot = await _fetch(keyword, page)
            _cache[key] = snapshot
    assert snapshot is not None
    jobs = copy.deepcopy(snapshot["jobs"])
    return {
        "provider": "ncss",
        "source_name": SOURCE_NAME,
        "source_url": SOURCE_URL,
        "fetched_at": snapshot["fetched_at"],
        "cached": cached,
        "total": snapshot["total"],
        "total_kind": "capped",
        "has_more": snapshot["has_more"],
        "coverage": "中国大陆 · 多雇主 · 高校毕业生就业",
        "update_note": "国内毕业生岗位；查询结果保留 5 分钟。",
        "page": page,
        "page_size": PAGE_SIZE,
        "jobs": jobs,
        "summary": market_summary([j for j in jobs if j["description_complete"]], {}),
        "warnings": list(snapshot["warnings"]),
    }


def remembered_job(post_id: str, keyword: str, geo: str = "") -> dict[str, Any]:
    keyword = _keyword(keyword, geo)
    for (query, _page), snapshot in reversed(list(_cache.items())):
        if query != keyword or snapshot["expires_at"] <= monotonic():
            continue
        for job in snapshot["jobs"]:
            if job["external_id"] == post_id:
                if not job["description_complete"]:
                    raise HTTPException(409, "该岗位尚未取得完整 JD，请打开官网查看。")
                return copy.deepcopy(job)
    raise HTTPException(409, "岗位查询已失效或不含该岗位，请重新搜索后记住 JD。")
