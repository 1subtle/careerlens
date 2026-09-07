"""CareerLens workflow. Existing Resume Matcher endpoints remain available."""

import asyncio
import copy
import json
import logging
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException, UploadFile
from sqlalchemy import select

from app.database import db
from app.models import (
    Improvement,
    Job,
    MatchRecord,
    Resume,
    ResumeSnapshot,
    RewriteRecord,
)
from app.schemas.career import (
    ApplyInput,
    JobInput,
    MarketFilter,
    MarketQuestion,
    MatchInput,
    ResumeInput,
    ReviewInput,
    RewriteInput,
    TextInput,
)
from app.schemas.models import ResumeData
from app.services import career_ai
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
        "data": data,
        "hash": fingerprint(data),
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
        "job": row.job_snapshot,
        "job_hash": row.job_hash,
        "details": row.details,
        "conditions": row.conditions,
        "score": row.score,
        "rule_version": row.rule_version,
        "created_at": row.created_at,
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
        "rule_version": RULE_VERSION,
    }


@router.post("/resumes/parse")
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
    except Exception as error:  # noqa: BLE001 - sanitize arbitrary provider/document errors at the HTTP boundary
        logger.warning("Career resume parsing failed (%s)", type(error).__name__)
        raise HTTPException(
            502, "AI 解析未完成，原文已保留。可重试或切换规则解析。"
        ) from None


@router.post("/resumes/file")
async def parse_file(file: UploadFile) -> dict[str, Any]:
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
        request = TextInput(text=text)
    except Exception as error:  # noqa: BLE001 - sanitize arbitrary provider/document errors at the HTTP boundary
        logger.warning("Career file parsing failed (%s)", type(error).__name__)
        raise HTTPException(
            422, "无法提取文本，请改用粘贴文本；扫描件需先转成文字。"
        ) from None
    return await parse_resume(request)


@router.post("/resumes")
async def create_resume(request: ResumeInput) -> dict[str, Any]:
    data = request.data.model_dump(mode="json")
    created = await db.create_resume_atomic_master(
        content=request.source_text or json.dumps(data, ensure_ascii=False),
        processed_data=data,
        processing_status="ready",
        title=request.title,
        original_markdown=request.source_text or None,
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
        if (
            request.expected_hash
            and fingerprint(resume_data(row)) != request.expected_hash
        ):
            raise HTTPException(409, "简历已在其他页面修改，请重新载入后保存。")
        row.processed_data = request.data.model_dump(mode="json")
        row.title, row.updated_at = request.title, now()
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
        except Exception as error:  # noqa: BLE001 - sanitize arbitrary provider/document errors at the HTTP boundary
            logger.warning("Career JD parsing failed (%s)", type(error).__name__)
            raise HTTPException(
                502, "AI 要求抽取未完成，可改用规则抽取后校对。"
            ) from None
    return {"requirements": requirements, "mode": "ai" if request.use_ai else "rules"}


async def save_job(request: JobInput, job_id: str | None = None) -> dict[str, Any]:
    metadata = request.model_dump(mode="json", exclude={"text", "use_ai"})
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
        if row is None:
            candidates = (
                await session.scalars(select(Job).where(Job.content == request.text))
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
        await session.commit()
        return job_view(row)


@router.post("/jobs")
async def create_job(request: JobInput) -> dict[str, Any]:
    return await save_job(request)


@router.put("/jobs/{job_id}")
async def update_job(job_id: str, request: JobInput) -> dict[str, Any]:
    return await save_job(request, job_id)


@router.delete("/jobs/{job_id}")
async def remove_job(job_id: str) -> dict[str, bool]:
    async with db._write_session() as session:
        row = await session.get(Job, job_id)
        if row is None:
            raise HTTPException(404, "岗位不存在")
        await session.delete(row)
        await session.commit()
    return {"deleted": True}


@router.post("/matches")
async def calculate_match(request: MatchInput) -> dict[str, Any]:
    async with db._write_session() as session:
        resume = await session.get(Resume, request.resume_id)
        job = await session.get(Job, request.job_id)
        if resume is None or job is None:
            raise HTTPException(404, "简历或岗位不存在")
        data, job_data = resume_data(resume), job_view(job)
        evidence = evidence_from_resume(data)
        snapshot = ResumeSnapshot(
            id=str(uuid4()),
            resume_id=resume.resume_id,
            content_hash=fingerprint(data),
            data=data,
            evidence=evidence,
            created_at=now(),
        )
        requirements = job_data.get("requirements", requirements_from_text(job.content))
        details, score = match_requirements(requirements, evidence)
        record = MatchRecord(
            id=str(uuid4()),
            snapshot_id=snapshot.id,
            job_id=job.job_id,
            job_snapshot=job_data,
            job_hash=fingerprint(job_data),
            details=details,
            conditions=conditions_for(data, job.content),
            score=score,
            rule_version=RULE_VERSION,
            created_at=now(),
        )
        session.add(snapshot)
        await session.flush()
        session.add(record)
        await session.commit()
        return match_view(record, snapshot)


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
        payload = await career_ai.rewrite(
            evidence, request.facts, match.details, request.use_ai
        )
    except Exception as error:  # noqa: BLE001 - sanitize arbitrary provider/document errors at the HTTP boundary
        logger.warning("Career rewrite rejected (%s)", type(error).__name__)
        raise HTTPException(
            502,
            "建议未通过事实检查，或模型服务未完成请求。原文未修改，可补充事实后重试。",
        ) from None
    async with db._write_session() as session:
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
    return market_summary(await all_jobs(), request.model_dump(mode="json"))


@router.post("/market/analyze")
async def analyze_market(request: MarketQuestion) -> dict[str, Any]:
    try:
        async with asyncio.timeout(60):
            return await _analyze_market(request)
    except TimeoutError:
        raise HTTPException(
            504, "市场解读超时，统计数据仍可查看。请稍后重试。"
        ) from None


async def _analyze_market(request: MarketQuestion) -> dict[str, Any]:
    jobs = await all_jobs()
    filters = request.model_dump(mode="json", exclude={"question", "use_ai"})
    if request.use_ai:
        try:
            parsed = await career_ai.ask_json(
                json.dumps(
                    {
                        "任务": "将问题转换成岗位筛选条件。只输出 category、city，未指定则为空字符串。",
                        "问题": request.question,
                        "允许类别": list({j.get("category", "其他") for j in jobs}),
                        "允许城市": list({j.get("city", "") for j in jobs}),
                    },
                    ensure_ascii=False,
                )
            )
            for key in ("category", "city"):
                value = parsed.get(key, "")
                if value and value not in {j.get(key) for j in jobs}:
                    raise ValueError("Unknown filter")
                if value:
                    filters[key] = value
        except Exception as error:  # noqa: BLE001 - sanitize arbitrary provider/document errors at the HTTP boundary
            logger.warning("Career market filter failed (%s)", type(error).__name__)
            raise HTTPException(
                502, "未能理解筛选条件，请使用页面筛选后重试。"
            ) from None
    summary = market_summary(jobs, filters)
    points = [
        f"当前范围共 {summary['count']} 个岗位；有可比较薪资的岗位 {len(summary['salaries'])} 个。"
    ]
    for item in summary["skills"][:3]:
        points.append(f"{item['name']} 出现在 {item['value']} 个岗位中。")
    advice = "结合岗位要求补充已有项目的应用证据，并按币种与薪资周期分别比较。"
    if request.use_ai and summary["count"]:
        try:
            response = await career_ai.ask_json(
                json.dumps(
                    {
                        "任务": "依据统计提出一条简洁的学习或求职建议。不要输出数字、增长趋势或概率。仅输出 advice 字段。",
                        "问题": request.question,
                        "统计": summary,
                    },
                    ensure_ascii=False,
                )
            )
            advice = str(response.get("advice", ""))
            if (
                not advice
                or len(advice) > 1200
                or any(c.isdigit() for c in advice)
                or any(word in advice for word in ("增长", "下降", "上升", "概率"))
            ):
                raise ValueError("Unsupported market claim")
        except Exception as error:  # noqa: BLE001 - sanitize arbitrary provider/document errors at the HTTP boundary
            logger.warning(
                "Career market interpretation failed (%s)", type(error).__name__
            )
            raise HTTPException(502, "市场解读未通过检查，图表统计仍可查看。") from None
    return {
        "summary": summary,
        "points": points,
        "advice": advice,
        "mode": "ai" if request.use_ai else "rules",
        "job_ids": summary["job_ids"],
    }
