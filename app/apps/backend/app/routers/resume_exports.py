"""Editable document downloads from saved resume content and print settings."""

import asyncio
import re
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import ValidationError

from app.database import db
from app.schemas.models import ResumeData
from app.schemas.template_settings import TemplateSettings
from app.services.resume_docx import render_resume_docx

router = APIRouter(prefix="/resumes", tags=["resumes"])


@router.get("/{resume_id}/docx")
async def download_resume_docx(
    resume_id: str, lang: str = Query("zh", pattern="^[a-z]{2}(-[A-Z]{2})?$")
) -> Response:
    resume = await db.get_resume(resume_id)
    if not resume:
        raise HTTPException(404, "简历不存在")
    if not resume.get("processed_data"):
        raise HTTPException(422, "简历尚无可导出的结构化正文，请先完成编辑并保存。")
    try:
        data = ResumeData.model_validate(resume["processed_data"])
        settings = TemplateSettings.model_validate(
            resume.get("template_settings") or {}
        )
        content = await asyncio.to_thread(render_resume_docx, data, settings, lang=lang)
    except (ValidationError, ValueError):
        raise HTTPException(
            422, "正文、照片或排版设置无效，请检查后重新保存。"
        ) from None
    filename = (
        re.sub(
            r'[\x00-\x1f\x7f/\\:*?"<>|]',
            "",
            resume.get("title") or data.personalInfo.name or "简历",
        )[:100]
        or "简历"
    )
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={
            "Content-Disposition": f"attachment; filename=\"resume.docx\"; filename*=UTF-8''{quote(filename + '.docx')}",
            "Cache-Control": "no-store",
        },
    )
