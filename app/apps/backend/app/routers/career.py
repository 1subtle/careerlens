"""CareerLens workflow. Existing Resume Matcher endpoints remain available."""

import asyncio
import copy
import json
import logging
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Form, HTTPException, Query, UploadFile
from sqlalchemy import select

from app.ai_limits import PromptSizeError
from app.credits import CreditError, refund_failed_generations
from app.database import db
from app.models import (
    Improvement,
    DirectionHistory,
    Job,
    MarketHistory,
    MatchRecord,
    Resume,
    ResumeSnapshot,
    RewriteRecord,
)
from app.schemas.career import (
    ApplyInput,
    CompareInput,
    ConditionReviewInput,
    DirectionsInput,
    JobInput,
    JobUpdateInput,
    MarketFilter,
    MarketQuestion,
    MatchInput,
    ResumeInput,
    ReviewInput,
    RewriteInput,
    TextInput,
)
from app.schemas.models import ResumeData
from app.services import career_ai, career_diagnosis, semantic
from app.services.matching import (
    RULE_VERSION,
    conditions_for,
    evidence_from_resume,
    fingerprint,
    market_summary,
    match_requirements,
    parse_resume_local,
    requirements_from_text,
    score_details,
)
from app.services.parser import parse_document, parse_resume_to_json

router = APIRouter(prefix="/career", tags=["CareerLens"])
logger = logging.getLogger(__name__)


@router.post("/demo")
async def load_demo() -> dict[str, Any]:
    """Explicit, additive and idempotent; never replace personal material."""
    from app.services.demo import DEMO_RESUME, demo_jobs

    async with db._session() as session:
        count = len((await session.scalars(select(Resume.resume_id))).all())
    if count == 0:
        await create_resume(
            ResumeInput(
                title="虚构示例 · 林同学",
                data=ResumeData.model_validate(parse_resume_local(DEMO_RESUME)),
                source_text=DEMO_RESUME,
            )
        )
    for job in demo_jobs():
        await save_job(JobInput.model_validate(job))
    return await state()


def now() -> str:
    return datetime.now(UTC).isoformat()


def resume_data(row: Resume) -> dict[str, Any]:
    return ResumeData.model_validate(row.processed_data or {}).model_dump(mode="json")


def resume_view(row: Resume) -> dict[str, Any]:
    data = resume_data(row)
    return {
        "id": row.resume_id,
        "title": row.title or "我的简历",
        "template_settings": row.template_settings,
        "data": data,
        "hash": fingerprint([data, row.content, row.title]),
        "revision": fingerprint([data, row.content, row.title, row.template_settings]),
        "is_master": row.is_master,
        "parent_id": row.parent_id,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "source_text": row.content,
    }


def job_view(row: Job) -> dict[str, Any]:
    return {
        **(row.metadata_json or {}),
        "job_id": row.job_id,
        "content": row.content,
        "created_at": row.created_at,
        "version": row.version,
    }


def match_view(row: MatchRecord, snapshot: ResumeSnapshot) -> dict[str, Any]:
    return {
        "id": row.id,
        "resume_id": snapshot.resume_id,
        "snapshot_id": snapshot.id,
        "resume_hash": snapshot.content_hash,
        "resume_data": snapshot.data,
        "evidence": snapshot.evidence,
        "job_id": row.job_id,
        "job": {
            key: value
            for key, value in row.job_snapshot.items()
            if key != "_ai_analysis"
        },
        "ai_analysis": row.job_snapshot.get("_ai_analysis"),
        "job_hash": row.job_hash,
        "details": row.details,
        "conditions": row.conditions,
        "score": row.score,
        "rule_version": row.rule_version,
        "created_at": row.created_at,
        "retrieval": next(
            (d["retrieval"] for d in row.details if "retrieval" in d), {"mode": "off"}
        ),
    }


@router.get("/state")
async def state() -> dict[str, Any]:
    async with db._session() as session:
        resumes = (
            await session.scalars(select(Resume).order_by(Resume.created_at.desc()))
        ).all()
        jobs = (
            await session.scalars(select(Job).order_by(Job.created_at.desc()))
        ).all()
        matches = (
            await session.scalars(
                select(MatchRecord).order_by(MatchRecord.created_at.desc()).limit(100)
            )
        ).all()
    return {
        "resumes": [resume_view(r) for r in resumes],
        "jobs": [job_view(j) for j in jobs],
        "matches": [
            {
                "id": m.id,
                "score": m.score,
                "job_id": m.job_id,
                "created_at": m.created_at,
            }
            for m in matches
        ],
        "model": career_ai.model_info(),
        "semantic": semantic.status(),
        "rule_version": RULE_VERSION,
    }


@router.post("/resumes/parse")
@refund_failed_generations
async def parse_resume(request: TextInput) -> dict[str, Any]:
    if not request.use_ai:
        return {
            "data": parse_resume_local(request.text),
            "source_text": request.text,
            "mode": "rules",
        }
    if not career_ai.model_info()["configured"]:
        raise HTTPException(422, "请先配置模型，或选择规则解析。")
    try:
        data = await asyncio.wait_for(parse_resume_to_json(request.text), timeout=60)
        return {
            "data": ResumeData.model_validate(data).model_dump(mode="json"),
            "source_text": request.text,
            "mode": "ai",
        }
    except CreditError:
        raise
    except Exception as error:  # noqa: BLE001 - sanitize arbitrary provider/document errors at the HTTP boundary
        logger.warning("Career resume parsing failed (%s)", type(error).__name__)
        raise HTTPException(
            502, "AI 解析未完成，原文已保留。可重试或切换规则解析。"
        ) from None


@router.post("/resumes/file")
async def parse_file(file: UploadFile, use_ai: bool = Form(False)) -> dict[str, Any]:
    filename = file.filename or ""
    if not filename.lower().endswith((".pdf", ".docx", ".txt", ".md")):
        raise HTTPException(422, "支持 PDF、DOCX、TXT 和 Markdown 文件。")
    content = await file.read(5 * 1024 * 1024 + 1)
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(413, "文件请控制在 5 MB 以内。")
    try:
        text = (
            content.decode("utf-8")
            if filename.lower().endswith((".txt", ".md"))
            else await parse_document(content, filename)
        )
        request = TextInput(text=text, use_ai=use_ai)
    except Exception as error:  # noqa: BLE001 - sanitize arbitrary provider/document errors at the HTTP boundary
        logger.warning("Career file parsing failed (%s)", type(error).__name__)
        raise HTTPException(
            422, "无法提取文本，请改用粘贴文本；扫描件需先转成文字。"
        ) from None
    try:
        return await parse_resume(request)
    except HTTPException as error:
        if not use_ai or isinstance(error, CreditError):
            raise
        return {
            "data": parse_resume_local(request.text),
            "source_text": request.text,
            "mode": "rules",
            "warning": f"{error.detail} 已用规则整理并保留文件原文，请校对或重试 AI 解析。",
        }


@router.post("/resumes")
async def create_resume(request: ResumeInput) -> dict[str, Any]:
    data = request.data.model_dump(mode="json")
    created = await db.create_resume_atomic_master(
        content=request.source_text or json.dumps(data, ensure_ascii=False),
        processed_data=data,
        processing_status="ready",
        title=request.title,
        original_markdown=request.source_text or None,
        template_settings=request.template_settings.model_dump()
        if request.template_settings
        else None,
    )
    async with db._session() as session:
        row = await session.get(Resume, created["resume_id"])
        return resume_view(row)


@router.put("/resumes/{resume_id}")
async def update_resume(resume_id: str, request: ResumeInput) -> dict[str, Any]:
    async with db._write_session() as session:
        row = await session.get(Resume, resume_id)
        if row is None:
            raise HTTPException(404, "简历不存在")
        current = resume_view(row)
        if (
            request.expected_revision is not None
            and current["revision"] != request.expected_revision
        ) or (
            request.expected_revision is None
            and request.expected_hash
            and current["hash"] != request.expected_hash
        ):
            raise HTTPException(409, "简历已在其他页面修改，请重新载入后保存。")
        row.processed_data = request.data.model_dump(mode="json")
        if "source_text" in request.model_fields_set:
            row.content = request.source_text
            row.original_markdown = request.source_text
        row.title, row.updated_at = request.title, now()
        if "template_settings" in request.model_fields_set:
            row.template_settings = (
                request.template_settings.model_dump()
                if request.template_settings
                else None
            )
        await session.commit()
        return resume_view(row)


@router.delete("/resumes/{resume_id}")
async def remove_resume(resume_id: str) -> dict[str, bool]:
    # Upstream delete handles previews; database FKs cascade all CareerLens personal records.
    found = await db.delete_resume(resume_id)
    if not found:
        raise HTTPException(404, "简历不存在")
    return {"deleted": True}


@router.post("/jobs/parse")
@refund_failed_generations
async def parse_job(request: TextInput) -> dict[str, Any]:
    requirements = requirements_from_text(request.text)
    if request.use_ai:
        from app.schemas.career import Requirement

        def validate(value: dict[str, Any]) -> dict[str, Any]:
            items = [
                Requirement.model_validate(r).model_dump()
                for r in value.get("requirements", [])
            ]
            if len(items) > 60 or any(
                r["source_text"] not in request.text for r in items
            ):
                raise ValueError("Invalid requirement sources")
            if len({r["name"].casefold() for r in items}) != len(items) or len(
                {r["id"] for r in items}
            ) != len(items):
                raise ValueError("Duplicate requirements")
            return {"requirements": items}

        try:
            value = await career_ai.ask_json(
                json.dumps(
                    {
                        "任务": "抽取去重的技能和具体任务要求，不要抽取福利。source_text 必须逐字引用 JD 原文。priority 仅 required 或 preferred。",
                        "JD": request.text,
                        "输出结构": {
                            "requirements": [
                                {
                                    "id": "q1",
                                    "name": "SQL",
                                    "source_text": "原文片段",
                                    "priority": "required",
                                }
                            ]
                        },
                    },
                    ensure_ascii=False,
                ),
                validate,
            )
            requirements = value["requirements"]
        except CreditError:
            raise
        except Exception as error:  # noqa: BLE001 - sanitize arbitrary provider/document errors at the HTTP boundary
            logger.warning("Career JD parsing failed (%s)", type(error).__name__)
            raise HTTPException(
                502, "AI 要求抽取未完成，可改用规则抽取后校对。"
            ) from None
    return {"requirements": requirements, "mode": "ai" if request.use_ai else "rules"}


async def save_job(request: JobInput, job_id: str | None = None) -> dict[str, Any]:
    metadata = request.model_dump(mode="json", exclude={"text", "use_ai", "expected_version"})
    metadata["requirements"] = (
        metadata["requirements"]
        if metadata["requirements"] is not None
        else requirements_from_text(request.text)
    )
    metadata["collected_at"] = now()
    metadata["role"] = request.title
    async with db._write_session() as session:
        row = await session.get(Job, job_id) if job_id else None
        if job_id and row is None:
            raise HTTPException(404, "岗位不存在")
        if row is not None and (
            not isinstance(request, JobUpdateInput)
            or row.version != request.expected_version
        ):
            raise HTTPException(409, "这份 JD 已在其他页面修改。当前编辑已保留，请读取最新版本后合并。")
        if row is None:
            if (
                request.source_type == "api"
                and request.source_name
                and request.external_id
            ):
                existing = await session.scalar(
                    select(Job).where(
                        Job.metadata_json["source_type"].as_string() == "api",
                        Job.metadata_json["source_name"].as_string()
                        == request.source_name,
                        Job.metadata_json["external_id"].as_string()
                        == request.external_id,
                    )
                )
                if existing is not None:
                    return job_view(existing)
            else:
                candidates = (
                    await session.scalars(
                        select(Job).where(Job.content == request.text)
                    )
                ).all()
                row = next(
                    (
                        j
                        for j in candidates
                        if (j.metadata_json or {}).get("company", "") == request.company
                    ),
                    None,
                )
                if row is not None:
                    return job_view(row)
            row = Job(
                job_id=str(uuid4()),
                content=request.text,
                created_at=now(),
                metadata_json=metadata,
            )
            session.add(row)
        else:
            row.content, row.metadata_json = request.text, metadata
            row.version += 1
        await session.commit()
        return job_view(row)


@router.post("/jobs")
async def create_job(request: JobInput) -> dict[str, Any]:
    return await save_job(request)


@router.put("/jobs/{job_id}")
async def update_job(job_id: str, request: JobUpdateInput) -> dict[str, Any]:
    return await save_job(request, job_id)


@router.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict[str, Any]:
    async with db._session() as session:
        row = await session.get(Job, job_id)
        if row is None:
            raise HTTPException(404, "岗位不存在")
        return job_view(row)


@router.delete("/jobs/{job_id}")
async def remove_job(job_id: str) -> dict[str, bool]:
    if not await db.delete_job(job_id):
        raise HTTPException(404, "岗位不存在")
    return {"deleted": True}


@router.post("/matches")
async def calculate_match(request: MatchInput) -> dict[str, Any]:
    return (
        await calculate_matches(
            request.resume_id, [request.job_id], request.use_semantic, request.use_ai
        )
    )[0]


@router.post("/matches/compare")
async def compare_matches(request: CompareInput) -> dict[str, Any]:
    matches = await calculate_matches(
        request.resume_id, request.job_ids, request.use_semantic, request.use_ai
    )
    return {
        "resume_id": request.resume_id,
        "resume_hash": matches[0]["resume_hash"],
        "snapshot_id": matches[0]["snapshot_id"],
        "rule_version": RULE_VERSION,
        "matches": matches,
    }


@refund_failed_generations
async def calculate_matches(
    resume_id: str, job_ids: list[str], use_semantic: bool, use_ai: bool = False
) -> list[dict[str, Any]]:
    async with db._session() as session:
        resume = await session.get(Resume, resume_id)
        jobs = {
            j.job_id: j
            for j in (
                await session.scalars(select(Job).where(Job.job_id.in_(job_ids)))
            ).all()
        }
        if resume is None or len(jobs) != len(job_ids):
            raise HTTPException(404, "简历或岗位不存在")
        data = resume_data(resume)
        job_data = [job_view(jobs[job_id]) for job_id in job_ids]
    evidence = evidence_from_resume(data)
    ai_evidence = career_diagnosis.diagnosis_evidence(data) if use_ai else evidence
    analyses: list[dict | None] = [None] * len(job_data)
    if use_ai:
        require_ai(ai_evidence)

        async def analyze_all() -> list[dict]:
            semaphore = asyncio.Semaphore(3)

            async def analyze(job: dict) -> dict:
                async with semaphore:
                    return await career_diagnosis.analyze_match(ai_evidence, job)

            tasks = [asyncio.create_task(analyze(job)) for job in job_data]
            try:
                return await asyncio.gather(*tasks)
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

        analyses = await run_diagnosis(
            analyze_all, timeout=180 if len(job_data) > 1 else 150
        )
    grouped = [
        j.get("requirements", requirements_from_text(j["content"])) for j in job_data
    ]
    requirements = [r for group in grouped for r in group]
    retrieved: list[list[dict]] = [[] for _ in requirements]
    retrieval = {"mode": "off"}
    if use_semantic:
        retrieval = {"mode": "vector", **semantic.status()}
        try:
            retrieved = await asyncio.wait_for(
                asyncio.to_thread(semantic.retrieve, requirements, evidence), timeout=30
            )
        except Exception as error:  # noqa: BLE001 - optional local model failures retain the rule result
            logger.warning(
                "Career evidence retrieval unavailable (%s)", type(error).__name__
            )
            retrieval.update(
                mode="unavailable",
                message="语义检索暂不可用，已保留关键词诊断；可重试或手动核对证据。",
            )
    snapshot = ResumeSnapshot(
        id=str(uuid4()),
        resume_id=resume_id,
        content_hash=fingerprint(data),
        data=data,
        evidence=ai_evidence,
        created_at=now(),
    )
    records = []
    offset = 0
    for job, group, analysis in zip(job_data, grouped, analyses):
        details, score = match_requirements(group, evidence)
        for i, detail in enumerate(details):
            detail["candidates"] = [
                c
                for c in retrieved[offset + i]
                if c["evidence_id"] not in detail["evidence_ids"]
            ]
            if detail["status"] == "pending" and detail["candidates"]:
                detail["reason"] = (
                    "找到表述相关的经历，请核对是否支持本项要求；确认后计入覆盖度。"
                )
            detail["retrieval"] = retrieval
        offset += len(group)
        records.append(
            MatchRecord(
                id=str(uuid4()),
                snapshot_id=snapshot.id,
                job_id=job["job_id"],
                job_snapshot={**job, "_ai_analysis": analysis} if analysis else job,
                job_hash=fingerprint(job),
                details=details,
                conditions=conditions_for(data, job["content"]),
                score=score,
                rule_version=RULE_VERSION,
                created_at=now(),
            )
        )
    async with db._account_session() as session:
        current = await session.get(Resume, resume_id)
        current_jobs = {
            j.job_id: job_view(j)
            for j in (
                await session.scalars(select(Job).where(Job.job_id.in_(job_ids)))
            ).all()
        }
        if (
            current is None
            or fingerprint(resume_data(current)) != snapshot.content_hash
            or any(
                fingerprint(current_jobs.get(j["job_id"])) != fingerprint(j)
                for j in job_data
            )
        ):
            raise HTTPException(409, "诊断期间简历或岗位已改变，请重新诊断。")
        session.add(snapshot)
        await session.flush()
        session.add_all(records)
        await session.commit()
        return [match_view(record, snapshot) for record in records]


def require_ai(evidence: list[dict]) -> None:
    if not career_ai.model_info()["configured"]:
        raise HTTPException(422, "请先在 AI 设置中配置可用模型，再运行 AI 分析。")
    if not evidence:
        raise HTTPException(422, "请先填写经历、技能或教育背景，再运行 AI 分析。")


async def run_diagnosis(operation: Any, *args: Any, timeout: int = 150) -> Any:
    try:
        return await asyncio.wait_for(operation(*args), timeout=timeout)
    except TimeoutError:
        raise HTTPException(
            504, "AI 服务响应超时，本次未保存分析结果，请稍后重试。"
        ) from None
    except CreditError:
        raise
    except PromptSizeError:
        raise HTTPException(
            422, "本次分析材料过长，请减少同时分析的岗位或缩短材料后重试。"
        ) from None
    except career_ai.CareerAIOutputError as error:
        logger.warning(
            "Career AI diagnosis failed (operation=%s, code=%s)",
            operation.__name__, error.code,
        )
        detail = {
            "invalid_json": "AI 返回内容不完整，自动重试后仍无法解析。请重新分析。",
            "invalid_structure": "AI 返回内容不符合所需结构，自动重试后仍未通过检查。请重新分析。",
            "invalid_citation": "AI 引用无法定位到参考材料，请重新分析。",
            "unsupported_claim": "AI 分析未完成，请重新分析。",
            "invalid_review": "AI 分析结果格式不完整，请重新分析。",
        }[error.code]
        raise HTTPException(502, detail + "本次未保存 AI 结果。") from None
    except Exception as error:  # noqa: BLE001 - provider errors must not expose configuration
        logger.warning("Career AI diagnosis failed (%s)", type(error).__name__)
        raise HTTPException(
            502,
            "AI 服务暂未能完成分析，请稍后重试。本次未保存 AI 结果。",
        ) from None


@router.post("/directions")
@refund_failed_generations
async def recommend_directions(request: DirectionsInput) -> dict[str, Any]:
    if not request.use_ai:
        raise HTTPException(
            422, "岗位方向分析需要开启 AI；关闭时可使用目标 JD 的规则覆盖度诊断。"
        )
    async with db._session() as session:
        resume = await session.get(Resume, request.resume_id)
        if resume is None:
            raise HTTPException(404, "简历不存在")
        data = resume_data(resume)
        resume_snapshot = resume_view(resume)
        version_hash = resume_snapshot["hash"]
        candidates = (
            await session.scalars(select(Job).order_by(Job.created_at.desc()))
        ).all()
        jobs = [
            job_view(row)
            for row in candidates
            if (row.metadata_json or {}).get("source_type")
            not in ("course", "synthetic")
        ][:20]
    evidence = career_diagnosis.diagnosis_evidence(data)
    require_ai(evidence)
    result = await run_diagnosis(career_diagnosis.recommend_directions, evidence, jobs)
    response = {
        **result,
        "resume_id": request.resume_id,
        "resume_hash": version_hash,
        "evidence": evidence,
    }
    inputs = {"resume": resume_snapshot, "jobs": jobs, "use_ai": request.use_ai}
    async with db._account_session() as session:
        current = await session.get(Resume, request.resume_id)
        current_jobs = {
            j.job_id: job_view(j)
            for j in (
                await session.scalars(
                    select(Job).where(Job.job_id.in_([j["job_id"] for j in jobs]))
                )
            ).all()
        }
        if (
            current is None
            or resume_view(current)["hash"] != version_hash
            or any(
                fingerprint(current_jobs.get(job["job_id"])) != fingerprint(job)
                for job in jobs
            )
        ):
            raise HTTPException(409, "分析期间简历或候选 JD 已改变，请重新分析。")
        history = DirectionHistory(
            id=str(uuid4()), resume_id=request.resume_id, resume_hash=version_hash,
            input_snapshot=inputs, input_hash=fingerprint(inputs), result=response,
            created_at=now(),
        )
        session.add(history)
        await session.commit()
        return {**response, "history_id": history.id, "created_at": history.created_at,
                "input_snapshot": inputs, "input_hash": history.input_hash}


@router.get("/directions/history")
async def list_direction_history(limit: int = Query(100, ge=1, le=100)) -> list[dict[str, Any]]:
    async with db._session() as session:
        rows = (await session.scalars(select(DirectionHistory).order_by(
            DirectionHistory.created_at.desc(), DirectionHistory.id.desc()
        ).limit(limit))).all()
        return [{
            "id": row.id, "resume_id": row.resume_id,
            "resume_title": row.input_snapshot["resume"].get("title", "简历"),
            "summary": row.result.get("summary", ""), "created_at": row.created_at,
        } for row in rows]


@router.get("/directions/history/{history_id}")
async def get_direction_history(history_id: str) -> dict[str, Any]:
    async with db._session() as session:
        row = await session.get(DirectionHistory, history_id)
        if row is None:
            raise HTTPException(404, "方向分析记录不存在")
        return {**row.result, "id": row.id, "history_id": row.id,
                "input_snapshot": row.input_snapshot, "input_hash": row.input_hash,
                "created_at": row.created_at}


@router.delete("/directions/history/{history_id}")
async def delete_direction_history(history_id: str) -> dict[str, bool]:
    async with db._write_session() as session:
        row = await session.get(DirectionHistory, history_id)
        if row is None:
            raise HTTPException(404, "方向分析记录不存在")
        await session.delete(row)
        await session.commit()
    return {"deleted": True}


@router.get("/matches/{match_id}")
async def get_match(match_id: str) -> dict[str, Any]:
    async with db._session() as session:
        record = await session.get(MatchRecord, match_id)
        if record is None:
            raise HTTPException(404, "分析记录不存在")
        snapshot = await session.get(ResumeSnapshot, record.snapshot_id)
        current = await session.get(Resume, snapshot.resume_id)
        job = await session.get(Job, record.job_id)
        rewrites = (
            await session.scalars(
                select(RewriteRecord)
                .where(RewriteRecord.match_id == match_id)
                .order_by(RewriteRecord.created_at.desc())
            )
        ).all()
        return {
            **match_view(record, snapshot),
            "stale": fingerprint(resume_data(current)) != snapshot.content_hash
            or fingerprint(job_view(job)) != record.job_hash,
            "rewrites": [rewrite_view(r) for r in rewrites],
        }


@router.post("/matches/{match_id}/review")
async def review_match(match_id: str, request: ReviewInput) -> dict[str, Any]:
    async with db._write_session() as session:
        previous = await session.get(MatchRecord, match_id)
        if previous is None:
            raise HTTPException(404, "分析记录不存在")
        snapshot = await session.get(ResumeSnapshot, previous.snapshot_id)
        current = await session.get(Resume, snapshot.resume_id)
        job = await session.get(Job, previous.job_id)
        details = copy.deepcopy(previous.details)
        item = next((d for d in details if d["id"] == request.requirement_id), None)
        by_id = {e["id"]: e for e in snapshot.evidence}
        if item is None or any(i not in by_id for i in request.evidence_ids):
            raise HTTPException(422, "要求或证据引用无效")
        if request.status in ("supported", "mentioned") and not request.evidence_ids:
            raise HTTPException(422, "确认匹配时请选择支持的原文证据")
        if request.status == "supported" and not any(
            by_id[i]["kind"] == "experience" for i in request.evidence_ids
        ):
            raise HTTPException(422, "具体证据需要选择项目或工作经历")
        if (
            fingerprint(resume_data(current)) != snapshot.content_hash
            or fingerprint(job_view(job)) != previous.job_hash
        ):
            raise HTTPException(409, "材料已经改变，请重新诊断后核对证据。")
        item.update(
            status=request.status,
            value={"supported": 1, "mentioned": 0.5, "pending": 0, "gap": 0}[
                request.status
            ],
            evidence_ids=request.evidence_ids
            if request.status in ("supported", "mentioned")
            else [],
            reason="用户核对原始材料后确认；此判断保存在独立版本中。",
        )
        record = MatchRecord(
            id=str(uuid4()),
            snapshot_id=previous.snapshot_id,
            job_id=previous.job_id,
            job_snapshot=copy.deepcopy(previous.job_snapshot),
            job_hash=previous.job_hash,
            details=details,
            conditions=copy.deepcopy(previous.conditions),
            score=score_details(details),
            rule_version=previous.rule_version,
            created_at=now(),
        )
        session.add(record)
        await session.commit()
        return match_view(record, snapshot)


@router.post("/matches/{match_id}/conditions")
async def review_condition(
    match_id: str, request: ConditionReviewInput
) -> dict[str, Any]:
    async with db._write_session() as session:
        previous = await session.get(MatchRecord, match_id)
        if previous is None:
            raise HTTPException(404, "分析记录不存在")
        snapshot = await session.get(ResumeSnapshot, previous.snapshot_id)
        current = await session.get(Resume, snapshot.resume_id)
        job = await session.get(Job, previous.job_id)
        if (
            fingerprint(resume_data(current)) != snapshot.content_hash
            or fingerprint(job_view(job)) != previous.job_hash
        ):
            raise HTTPException(409, "材料已经改变，请重新诊断后确认条件。")
        conditions = copy.deepcopy(previous.conditions)
        item = next((c for c in conditions if c["name"] == request.name), None)
        if item is None or item["status"] == "not_stated":
            raise HTTPException(422, "JD 未明确此条件，无需确认。")
        item.update(
            status=request.status,
            observed=request.observed,
            confirmed_by="user",
            confirmed_at=now(),
        )
        record = MatchRecord(
            id=str(uuid4()),
            snapshot_id=previous.snapshot_id,
            job_id=previous.job_id,
            job_snapshot=copy.deepcopy(previous.job_snapshot),
            job_hash=previous.job_hash,
            details=copy.deepcopy(previous.details),
            conditions=conditions,
            score=previous.score,
            rule_version=previous.rule_version,
            created_at=now(),
        )
        session.add(record)
        await session.commit()
        return match_view(record, snapshot)


def rewrite_view(row: RewriteRecord) -> dict[str, Any]:
    return {
        "id": row.id,
        "match_id": row.match_id,
        "section_id": row.section_id,
        "facts": row.facts,
        **row.payload,
        "status": row.status,
        "result_resume_id": row.result_resume_id,
        "created_at": row.created_at,
    }


@router.post("/rewrites")
@refund_failed_generations
async def create_rewrite(request: RewriteInput) -> dict[str, Any]:
    async with db._session() as session:
        match = await session.get(MatchRecord, request.match_id)
        if match is None:
            raise HTTPException(404, "分析记录不存在")
        snapshot = await session.get(ResumeSnapshot, match.snapshot_id)
        evidence = next(
            (
                e
                for e in snapshot.evidence
                if e["id"] == request.section_id
                and e["kind"] in ("experience", "summary")
            ),
            None,
        )
        if evidence is None:
            raise HTTPException(422, "请选择一段项目、实习经历或个人简介")
    try:
        payload = await asyncio.wait_for(
            career_ai.rewrite(
                evidence,
                request.facts,
                match.details,
                request.use_ai,
                match.job_snapshot,
            ),
            timeout=150,
        )
    except TimeoutError:
        raise HTTPException(
            504, "AI 改写超过 150 秒，原文未修改，请稍后重试。"
        ) from None
    except CreditError:
        raise
    except Exception as error:  # noqa: BLE001 - sanitize arbitrary provider/document errors at the HTTP boundary
        logger.warning("Career rewrite rejected (%s)", type(error).__name__)
        raise HTTPException(
            502,
            "修改建议暂未生成完成。原文已保留，请稍后重试。",
        ) from None
    async with db._account_session() as session:
        if await session.get(MatchRecord, request.match_id) is None:
            raise HTTPException(409, "分析记录已被删除，请重新分析")
        record = RewriteRecord(
            id=str(uuid4()),
            match_id=match.id,
            section_id=request.section_id,
            facts=request.facts,
            payload=payload,
            created_at=now(),
            status="draft",
        )
        session.add(record)
        await session.commit()
        return rewrite_view(record)


@router.post("/rewrites/{rewrite_id}/apply")
async def apply_rewrite(rewrite_id: str, request: ApplyInput) -> dict[str, Any]:
    async with db._write_session() as session:
        rewrite = await session.get(RewriteRecord, rewrite_id)
        if rewrite is None:
            raise HTTPException(404, "建议不存在")
        if rewrite.status == "accepted":
            result = (
                await session.get(Resume, rewrite.result_resume_id)
                if rewrite.result_resume_id
                else None
            )
            if result is None:
                raise HTTPException(409, "已采纳的版本已被删除，不会重复创建")
            return {"resume": resume_view(result), "rewrite": rewrite_view(rewrite)}
        if rewrite.status != "draft":
            raise HTTPException(409, "该建议已被拒绝")
        try:
            career_ai.validate_draft(
                rewrite.payload,
                rewrite.payload.get("sources", []),
            )
        except ValueError:
            raise HTTPException(
                409, "建议格式或参考材料不完整，请重新生成。"
            ) from None
        match = await session.get(MatchRecord, rewrite.match_id)
        snapshot = await session.get(ResumeSnapshot, match.snapshot_id)
        source = await session.get(Resume, snapshot.resume_id)
        job = await session.get(Job, match.job_id)
        if (
            fingerprint(resume_data(source)) != snapshot.content_hash
            or fingerprint(job_view(job)) != match.job_hash
        ):
            raise HTTPException(409, "原简历或 JD 已改变，请重新分析和生成建议")
        data = copy.deepcopy(snapshot.data)
        evidence = next(e for e in snapshot.evidence if e["id"] == rewrite.section_id)
        target: Any = data
        for part in evidence["path"][:-1]:
            target = target[part]
        target[evidence["path"][-1]] = rewrite.payload["draft"]
        data = ResumeData.model_validate(data).model_dump(mode="json")
        result = Resume(
            resume_id=str(uuid4()),
            content=json.dumps(data, ensure_ascii=False),
            processed_data=data,
            processing_status="ready",
            is_master=False,
            parent_id=source.resume_id,
            template_settings=copy.deepcopy(source.template_settings),
            title=f"{job.metadata_json.get('title', '目标岗位')} · 定向版",
            created_at=now(),
            updated_at=now(),
        )
        session.add(result)
        await session.flush()
        session.add(
            Improvement(
                request_id=str(uuid4()),
                original_resume_id=source.resume_id,
                tailored_resume_id=result.resume_id,
                job_id=job.job_id,
                improvements=[
                    {
                        "before": evidence["text"],
                        "after": rewrite.payload["draft"],
                        "sources": rewrite.payload["sources"],
                    }
                ],
                created_at=now(),
            )
        )
        rewrite.status, rewrite.result_resume_id = "accepted", result.resume_id
        await session.commit()
        return {"resume": resume_view(result), "rewrite": rewrite_view(rewrite)}


@router.post("/rewrites/{rewrite_id}/reject")
async def reject_rewrite(rewrite_id: str) -> dict[str, Any]:
    async with db._write_session() as session:
        row = await session.get(RewriteRecord, rewrite_id)
        if row is None:
            raise HTTPException(404, "建议不存在")
        if row.status == "accepted":
            raise HTTPException(409, "已采纳的建议不能拒绝")
        row.status = "rejected"
        await session.commit()
        return rewrite_view(row)


async def all_jobs() -> list[dict[str, Any]]:
    async with db._session() as session:
        return [job_view(row) for row in (await session.scalars(select(Job))).all()]


@router.post("/market/summary")
async def get_market(request: MarketFilter) -> dict[str, Any]:
    jobs = await all_jobs()
    filters = request.model_dump(mode="json")
    summary = market_summary(jobs, filters)
    stored = await save_market_history(
        {"summary": summary, "points": [], "advice": "", "mode": "rules", "job_ids": summary["job_ids"]},
        {"jobs": jobs, "filters": filters, "question": "", "use_ai": False},
        "saved",
    )
    return {**summary, "history_id": stored["history_id"], "created_at": stored["created_at"]}


@router.post("/market/analyze")
@refund_failed_generations
async def analyze_market(request: MarketQuestion) -> dict[str, Any]:
    try:
        async with asyncio.timeout(60):
            return await _analyze_market(request)
    except TimeoutError:
        raise HTTPException(
            504, "市场解读超时，统计数据仍可查看。请稍后重试。"
        ) from None


@refund_failed_generations
async def _analyze_market(
    request: MarketQuestion, jobs: list[dict[str, Any]] | None = None, source: str = "saved"
) -> dict[str, Any]:
    if jobs is None:
        jobs = await all_jobs()
    filters = request.model_dump(mode="json", exclude={"question", "use_ai"})
    summary = market_summary(jobs, filters)
    points = [
        f"当前范围共 {summary['count']} 个岗位；有可比较薪资的岗位 {len(summary['salaries'])} 个。"
    ]
    for item in summary["skills"][:3]:
        points.append(f"{item['name']} 出现在 {item['value']} 个岗位中。")
    advice = (
        "结合岗位要求补充已有项目的应用证据，并按币种与薪资周期分别比较。"
        if summary["count"]
        else "当前筛选范围没有可统计的岗位。请放宽类别、城市或日期条件，或先选择并记住完整岗位 JD 后再分析。"
    )
    if request.use_ai and summary["count"]:
        try:
            response = await career_ai.ask_json(
                json.dumps(
                    {
                        "任务": "依据已确定的本次岗位样本回答用户问题，并给出可执行的学习和求职路径。仅输出 advice 字段，内容不超过 700 字。",
                        "统计口径": [
                            "筛选范围已由页面确定，问题只用于解读，不得改动筛选条件、样本数量和统计结果。",
                            "count、job_ids、skills、distribution、salaries 是筛选后去重样本；技能每个岗位只计一次，类别技能占比以该类别岗位总数为分母。",
                            "coverage 是日期筛选前、其他筛选及去重后的日期覆盖；近期仅按 published_at，未知发布日期不能用采集或更新日期代替。",
                            "薪资仅覆盖 salaries 中的岗位，按币种和周期分别比较；缺失薪资不估算，不跨币种或周期直接平均。",
                            "不同薪资周期仅并列报告原始区间。样本未提供工作天数、工时和福利时，不假设每月 21.75 天或其他天数换算，不据此判断日薪与月薪哪个更高，也不建议优先选择某个计薪周期。",
                            "先概括当前样本的岗位与技能特点，再给出优先学习内容、可验证的项目产出和求职下一步；不要把样本解释为全市场趋势。",
                            "若问题涉及样本未覆盖的城市、类别或时期，说明当前范围不足以比较，并指出需要补充的岗位样本。",
                        ],
                        "问题": request.question,
                        "统计": summary,
                    },
                    ensure_ascii=False,
                )
            )
            advice = response.get("advice")
            if not isinstance(advice, str) or not advice.strip() or len(advice) > 1200:
                raise ValueError("Invalid market advice format")
            advice = advice.strip()
        except CreditError:
            raise
        except Exception as error:  # noqa: BLE001 - sanitize arbitrary provider/document errors at the HTTP boundary
            logger.warning(
                "Career market interpretation failed (%s)", type(error).__name__
            )
            raise HTTPException(502, "市场解读暂未完成，图表统计仍可查看。") from None
    result = {
        "summary": summary,
        "points": points,
        "advice": advice,
        "mode": "ai" if request.use_ai and summary["count"] else "rules",
        "job_ids": summary["job_ids"],
    }
    return await save_market_history(
        result,
        {"jobs": jobs, "filters": filters, "question": request.question, "use_ai": request.use_ai},
        source,
    )


async def save_market_history(result: dict[str, Any], inputs: dict[str, Any], source: str) -> dict[str, Any]:
    row = MarketHistory(
        id=str(uuid4()), source=source, input_snapshot=inputs,
        input_hash=fingerprint(inputs), result=result, created_at=now(),
    )
    async with db._account_session() as session:
        session.add(row)
        await session.commit()
    return {**result, "history_id": row.id, "created_at": row.created_at,
            "input_snapshot": inputs, "input_hash": row.input_hash, "source": source}


@router.get("/market/history")
async def list_market_history(limit: int = Query(100, ge=1, le=100)) -> list[dict[str, Any]]:
    async with db._session() as session:
        rows = (await session.scalars(select(MarketHistory).order_by(
            MarketHistory.created_at.desc(), MarketHistory.id.desc()
        ).limit(limit))).all()
        return [{
            "id": row.id, "source": row.source, "created_at": row.created_at,
            "question": row.input_snapshot.get("question", ""),
            "count": row.result["summary"]["count"], "mode": row.result.get("mode", "rules"),
        } for row in rows]


@router.get("/market/history/{history_id}")
async def get_market_history(history_id: str) -> dict[str, Any]:
    async with db._session() as session:
        row = await session.get(MarketHistory, history_id)
        if row is None:
            raise HTTPException(404, "岗位统计记录不存在")
        return {**row.result, "id": row.id, "history_id": row.id, "source": row.source,
                "input_snapshot": row.input_snapshot, "input_hash": row.input_hash,
                "created_at": row.created_at}


@router.delete("/market/history/{history_id}")
async def delete_market_history(history_id: str) -> dict[str, bool]:
    async with db._write_session() as session:
        row = await session.get(MarketHistory, history_id)
        if row is None:
            raise HTTPException(404, "岗位统计记录不存在")
        await session.delete(row)
        await session.commit()
    return {"deleted": True}
