"""On-demand vacancies; persist a JD only when the user remembers it."""

import asyncio
import re
from typing import Annotated, Any, Literal

import httpx
from fastapi import APIRouter, HTTPException, Path, Query

from app.routers import career
from app.schemas.career import JobInput, LiveMarketQuestion, MarketQuestion
from app.services import jobicy, ncss, recruitment
from app.services.matching import fingerprint, requirements_from_text

router = APIRouter(prefix="/career/live", tags=["CareerLens"])
Provider = Literal["ncss", "jobicy", "tencent"]


@router.get("/jobs")
async def live_jobs(
    keyword: Annotated[str, Query(max_length=100)] = "",
    page: Annotated[int, Query(ge=1, le=100)] = 1,
    provider: Provider = "ncss",
    geo: jobicy.Geography = "",
) -> dict[str, Any]:
    try:
        async with asyncio.timeout(60):
            if provider == "ncss":
                return await ncss.search_jobs(keyword, page, geo)
            if provider == "jobicy":
                return await jobicy.search_jobs(keyword, page, geo)
            if geo not in ("", "all"):
                raise HTTPException(422, "腾讯招聘暂不支持地区筛选，请选择全部地区。")
            return await recruitment.search_jobs(keyword.strip(), page)
    except TimeoutError:
        raise HTTPException(504, "实时岗位读取超时，请稍后重试。") from None


@router.post("/jobs/{post_id}/remember")
async def remember_job(
    post_id: Annotated[str, Path(pattern=r"^[A-Za-z0-9]{1,64}$")],
    provider: Provider = "ncss",
    keyword: Annotated[str, Query(max_length=100)] = "",
    geo: jobicy.Geography = "",
) -> dict[str, Any]:
    try:
        async with asyncio.timeout(60):
            if provider != "ncss" and not re.fullmatch(r"[0-9]{1,30}", post_id):
                raise HTTPException(422, "岗位编号格式不正确。")
            if provider == "ncss":
                job = ncss.remembered_job(post_id, keyword, geo)
            elif provider == "jobicy":
                job = jobicy.remembered_job(post_id, keyword, geo)
            else:
                async with httpx.AsyncClient(timeout=10) as client:
                    job = await recruitment.fetch_job(client, post_id)
            return await career.save_job(
                JobInput.model_validate({**job, "text": job["content"]})
            )
    except TimeoutError:
        raise HTTPException(504, "记住岗位超时，请稍后重试。") from None


@router.post("/analyze")
async def analyze_live_jobs(request: LiveMarketQuestion) -> dict[str, Any]:
    jobs = []
    for sample in request.jobs:
        data = sample.model_dump(mode="json", exclude={"text", "use_ai"})
        source = {
            "腾讯招聘": "tencent",
            "Jobicy": "jobicy",
            ncss.SOURCE_NAME: "ncss",
        }.get(sample.source_name)
        jobs.append(
            {
                **data,
                "job_id": f"{source}-{sample.external_id}"
                if source and sample.external_id
                else "sample-"
                + fingerprint([sample.source_name, sample.external_id, sample.text])[
                    :16
                ],
                "content": sample.text,
                "requirements": requirements_from_text(sample.text),
            }
        )
    try:
        async with asyncio.timeout(60):
            return await career._analyze_market(
                MarketQuestion(question=request.question, use_ai=request.use_ai),
                jobs=jobs,
                source="live",
            )
    except TimeoutError:
        raise HTTPException(504, "实时岗位解读超时，统计仍可查看。") from None
