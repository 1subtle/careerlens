"""One-hour snapshots from Jobicy's public, multi-company remote jobs API."""

import asyncio
import copy
import math
import re
from datetime import UTC, datetime
from html.parser import HTMLParser
from time import monotonic
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException

from app.schemas.career import JobInput
from app.services.matching import (
    category_from_title,
    market_summary,
    requirements_from_text,
)

API_URL = "https://jobicy.com/api/v2/remote-jobs"
SOURCE_NAME = "Jobicy"
SOURCE_URL = "https://jobicy.com/jobs-rss-feed"
PAGE_SIZE = 10
CACHE_SECONDS = 3600
MAX_CACHE_ENTRIES = 32
# These location slugs were checked against the public ?get=locations response.
Geography = Literal["", "all", "china", "usa", "europe"]
_cache: dict[tuple[str, str], dict[str, Any]] = {}
_cache_lock = asyncio.Lock()


class _DescriptionText(HTMLParser):
    """Extract display text; scripts/styles never become job evidence."""

    blocks = frozenset(
        {
            "p",
            "div",
            "br",
            "li",
            "ul",
            "ol",
            "section",
            "article",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "table",
            "tr",
            "td",
        }
    )

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.hidden = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in {"script", "style", "iframe", "template", "noscript"}:
            self.hidden += 1
        elif not self.hidden and tag in self.blocks:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "iframe", "template", "noscript"}:
            self.hidden = max(0, self.hidden - 1)
        elif not self.hidden and tag in self.blocks:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.hidden:
            self.parts.append(data)


def description_text(value: str) -> str:
    parser = _DescriptionText()
    parser.feed(value)
    parser.close()
    lines = [
        re.sub(r"[^\S\n]+", " ", line).strip()
        for line in "".join(parser.parts).splitlines()
    ]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def query_key(keyword: str, geo: str) -> tuple[str, str]:
    keyword = keyword.strip().casefold()
    if keyword and not 3 <= len(keyword) <= 50:
        raise HTTPException(422, "Jobicy 关键词需为 3–50 个字符，也可以留空浏览。")
    if geo not in ("", "all", "china", "usa", "europe"):
        raise HTTPException(422, "请选择支持的远程工作地区。")
    return keyword, "" if geo == "all" else geo


def salary_display(post: dict[str, Any]) -> str:
    currency, period = post.get("salaryCurrency"), post.get("salaryPeriod")
    if not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency):
        return ""
    bounds = [post.get("salaryMin"), post.get("salaryMax")]
    values = [
        value
        if type(value) in (int, float) and math.isfinite(value) and value > 0
        else None
        for value in bounds
    ]
    low, high = values
    if low is not None and high is not None:
        if low > high:
            return ""
        amount = f"{low:g}–{high:g}" if low != high else f"{low:g}"
    elif low is not None:
        amount = f"至少 {low:g}"
    elif high is not None:
        amount = f"至多 {high:g}"
    else:
        return ""
    intervals = {
        "hourly": "小时",
        "daily": "天",
        "weekly": "周",
        "monthly": "月",
        "yearly": "年",
    }
    return f"{amount} {currency}" + (
        f"/{intervals[period]}"
        if isinstance(period, str) and period in intervals
        else "（周期未说明）"
    )


def job_view(post: dict[str, Any], fetched_at: str) -> dict[str, Any]:
    post_id = str(post.get("id", ""))
    raw_description = post.get("jobDescription")
    if not re.fullmatch(r"[0-9]{1,30}", post_id) or not isinstance(
        raw_description, str
    ):
        raise ValueError("Missing source identity or full description")
    description = description_text(raw_description)
    if not description:
        raise ValueError("Missing full description")
    url = post.get("url", "")
    parsed_url = urlsplit(url)
    if (
        parsed_url.scheme != "https"
        or parsed_url.netloc != "jobicy.com"
        or not parsed_url.path.startswith("/jobs/")
    ):
        raise ValueError("Invalid canonical source URL")
    region = description_text(post.get("jobGeo") or "")
    category = post.get("jobIndustry") or []
    published = None
    try:
        published = datetime.fromisoformat(post.get("pubDate", "")).date()
    except (ValueError, TypeError):
        pass
    salary = salary_display(post)
    content = (
        (f"远程工作地区要求：{region}\n\n" if region else "")
        + (f"来源薪资：{salary}\n\n" if salary else "")
        + description
    )
    request = JobInput(
        title=description_text(post.get("jobTitle", "")),
        company=description_text(post.get("companyName", "")),
        text=content,
        category=category[0]
        if isinstance(category, list) and category
        else category_from_title(description_text(post.get("jobTitle", ""))),
        city=region if len(region) <= 60 else "跨地区远程",
        # Do not feed mixed currencies into the existing CNY-oriented salary parser.
        salary_text="",
        source_type="api",
        source_name=SOURCE_NAME,
        source_url=url,
        external_id=post_id,
        published_at=published,
    )
    if not request.company:
        raise ValueError("Missing company")
    return {
        **request.model_dump(mode="json", exclude={"text", "use_ai"}),
        "job_id": f"jobicy-{post_id}",
        "content": request.text,
        "role": request.title,
        "created_at": fetched_at,
        "collected_at": fetched_at,
        "requirements": requirements_from_text(request.text),
        "description_complete": True,
        "remote_scope": region,
        "salary_display": salary,
    }


async def _fetch(key: tuple[str, str]) -> dict[str, Any]:
    keyword, geo = key
    params: dict[str, Any] = {"count": 200}
    if keyword:
        params["tag"] = keyword
    if geo:
        params["geo"] = geo
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(API_URL, params=params)
        response.raise_for_status()
        payload = response.json()
        if (
            not isinstance(payload, dict)
            or payload.get("success") is False
            or payload.get("statusCode", 200) != 200
        ):
            raise ValueError("Invalid job feed")
        posts = payload.get("jobs")
        if posts is None and payload.get("jobCount") == 0:
            posts = []
        if not isinstance(posts, list):
            raise TypeError("Missing jobs")
    except httpx.TimeoutException:
        raise HTTPException(504, "Jobicy 响应超时，请稍后重试。") from None
    except (httpx.HTTPError, ValueError, TypeError):
        raise HTTPException(502, "Jobicy 暂时无法提供岗位数据，请稍后重试。") from None
    fetched_at = datetime.now(UTC).isoformat()
    jobs: dict[str, dict[str, Any]] = {}
    rejected = 0
    for post in posts[:200]:
        try:
            if not isinstance(post, dict):
                raise TypeError("Invalid job")
            job = job_view(post, fetched_at)
            jobs.setdefault(job["external_id"], job)
        except (ValueError, TypeError, AttributeError):
            rejected += 1
    return {
        "jobs": list(jobs.values()),
        "fetched_at": fetched_at,
        "expires_at": monotonic() + CACHE_SECONDS,
        "warnings": [f"{rejected} 条岗位缺少完整描述或来源信息，已排除。"]
        if rejected
        else [],
    }


async def search_jobs(keyword: str, page: int, geo: str = "") -> dict[str, Any]:
    key = query_key(keyword, geo)
    # ponytail: serialize cache misses; use per-query locks if concurrent demand grows.
    async with _cache_lock:
        snapshot = _cache.get(key)
        cached = snapshot is not None and snapshot["expires_at"] > monotonic()
        if not cached:
            for old_key in [
                k for k, value in _cache.items() if value["expires_at"] <= monotonic()
            ]:
                del _cache[old_key]
            if len(_cache) >= MAX_CACHE_ENTRIES:
                raise HTTPException(429, "查询缓存已满，请使用已有搜索结果或稍后重试。")
            snapshot = await _fetch(key)
            _cache[key] = snapshot
    assert snapshot is not None
    jobs = copy.deepcopy(snapshot["jobs"][(page - 1) * PAGE_SIZE : page * PAGE_SIZE])
    return {
        "provider": "jobicy",
        "source_name": SOURCE_NAME,
        "source_url": SOURCE_URL,
        "fetched_at": snapshot["fetched_at"],
        "cached": cached,
        "total": len(snapshot["jobs"]),
        "total_kind": "sample",
        "coverage": "多公司 · 国际远程",
        "update_note": "查询结果保留 1 小时；总数为本批最多 200 条可用岗位。地区条件表示远程适用范围，非国内岗位市场；薪资按原币种见 JD，尚未纳入图表。",
        "page": page,
        "page_size": PAGE_SIZE,
        "jobs": jobs,
        "summary": market_summary(jobs, {}),
        "warnings": list(snapshot["warnings"]),
    }


def remembered_job(post_id: str, keyword: str, geo: str = "") -> dict[str, Any]:
    snapshot = _cache.get(query_key(keyword, geo))
    if snapshot is None or snapshot["expires_at"] <= monotonic():
        raise HTTPException(409, "这批岗位的缓存已失效，请重新搜索后记住 JD。")
    job = next(
        (item for item in snapshot["jobs"] if item["external_id"] == post_id), None
    )
    if job is None:
        raise HTTPException(404, "这批搜索结果中没有该岗位，请重新搜索。")
    return copy.deepcopy(job)
