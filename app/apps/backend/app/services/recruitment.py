"""Fetch one page of public Tencent vacancies and its complete descriptions."""

import asyncio
import re
from datetime import UTC, date, datetime
from typing import Any

import httpx
from fastapi import HTTPException

from app.schemas.career import JobInput
from app.services.matching import (
    category_from_title,
    market_summary,
    requirements_from_text,
)

API_URL = "https://careers.tencent.com/tencentcareer/api/post/"
SOURCE_URL = "https://careers.tencent.com/"
SOURCE_NAME = "腾讯招聘"
PAGE_SIZE = 10


async def request_data(
    client: httpx.AsyncClient, endpoint: str, params: dict[str, Any]
) -> dict[str, Any]:
    try:
        response = await client.get(
            API_URL + endpoint, params={"language": "zh-cn", **params}
        )
        response.raise_for_status()
        payload = response.json()
        if (
            not isinstance(payload, dict)
            or payload.get("Code") != 200
            or not isinstance(payload.get("Data"), dict)
        ):
            raise ValueError("Invalid recruitment response")
        return payload["Data"]
    except httpx.TimeoutException:
        raise HTTPException(504, "腾讯招聘响应超时，请稍后重试。") from None
    except (httpx.HTTPError, ValueError):
        raise HTTPException(502, "腾讯招聘暂时无法提供岗位数据，请稍后重试。") from None


def job_view(post: dict[str, Any], complete: bool) -> dict[str, Any]:
    """Keep upstream update dates distinct from unknown publication dates."""
    try:
        post_id = str(post.get("PostId", ""))
        if not re.fullmatch(r"[0-9]{1,30}", post_id):
            raise ValueError("Invalid post ID")
        responsibility = post.get("Responsibility", "")
        requirement = post.get("Requirement", "") if complete else ""
        if not isinstance(responsibility, str) or not responsibility.strip():
            raise ValueError("Missing responsibility")
        if complete and (not isinstance(requirement, str) or not requirement.strip()):
            raise ValueError("Missing requirement")
        updated = None
        raw_date = post.get("LastUpdateTime", "")
        if isinstance(raw_date, str) and raw_date:
            parts = re.fullmatch(r"(\d{4})[年-](\d{1,2})[月-](\d{1,2})日?", raw_date)
            if parts:
                try:
                    updated = date(*map(int, parts.groups()))
                except ValueError:
                    pass
        content = "岗位职责\n" + responsibility.strip()
        if complete:
            content += "\n\n任职要求\n" + requirement.strip()
        request = JobInput(
            title=post.get("RecruitPostName", ""),
            text=content,
            company="腾讯",
            category=post.get("CategoryName")
            or category_from_title(post.get("RecruitPostName", "")),
            city=post.get("LocationName") or "",
            source_type="api",
            source_name=SOURCE_NAME,
            source_url=f"{SOURCE_URL}jobdesc.html?postId={post_id}",
            external_id=post_id,
            source_updated_at=updated,
        )
    except (ValueError, TypeError):
        raise HTTPException(
            502, "腾讯岗位详情不完整，暂时无法用于统计或记住。"
        ) from None
    fetched_at = datetime.now(UTC).isoformat()
    return {
        **request.model_dump(mode="json", exclude={"text", "use_ai"}),
        "job_id": f"tencent-{post_id}",
        "content": request.text,
        "role": request.title,
        "created_at": fetched_at,
        "collected_at": fetched_at,
        "requirements": requirements_from_text(request.text) if complete else [],
        "description_complete": complete,
    }


async def fetch_job(client: httpx.AsyncClient, post_id: str) -> dict[str, Any]:
    data = await request_data(client, "ByPostId", {"postId": post_id})
    if str(data.get("PostId", "")) != post_id:
        raise HTTPException(502, "腾讯招聘返回的岗位编号不一致，请稍后重试。")
    return job_view(data, complete=True)


async def search_jobs(keyword: str, page: int) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=10) as client:
        data = await request_data(
            client,
            "Query",
            {
                "keyword": keyword,
                "pageIndex": page,
                "pageSize": PAGE_SIZE,
                "area": "cn",
            },
        )
        posts, total = data.get("Posts"), data.get("Count")
        if (
            not isinstance(posts, list)
            or type(total) is not int
            or total < 0
            or any(not isinstance(post, dict) for post in posts)
        ):
            raise HTTPException(502, "腾讯招聘返回的岗位列表格式异常，请稍后重试。")
        # Only enrich the requested page; no hidden walk through the vacancy board.
        previews = [job_view(post, complete=False) for post in posts[:PAGE_SIZE]]
        semaphore = asyncio.Semaphore(3)

        async def enrich(preview: dict[str, Any]) -> dict[str, Any]:
            async with semaphore:
                try:
                    return await fetch_job(client, preview["external_id"])
                except HTTPException:
                    return preview

        jobs = await asyncio.gather(*(enrich(preview) for preview in previews))
    complete = [job for job in jobs if job["description_complete"]]
    missing = len(jobs) - len(complete)
    return {
        "provider": "tencent",
        "source_name": SOURCE_NAME,
        "source_url": SOURCE_URL,
        "fetched_at": datetime.now(UTC).isoformat(),
        "cached": False,
        "total": total,
        "total_kind": "platform",
        "coverage": "腾讯 · 官方招聘",
        "update_note": "按需读取官网，仅覆盖腾讯自身招聘；来源更新时间与发布日期分别展示。",
        "page": page,
        "page_size": PAGE_SIZE,
        "jobs": jobs,
        "summary": market_summary(complete, {}),
        "warnings": [f"{missing} 个岗位未取得完整任职要求，已排除统计，暂时不能记住。"]
        if missing
        else [],
    }
