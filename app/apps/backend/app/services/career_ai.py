"""Structured AI suggestions with source links over the existing LiteLLM integration."""

import asyncio
import json
import logging
import re
from datetime import UTC, datetime
from difflib import SequenceMatcher
from typing import Any, Literal

from pydantic import ValidationError

from app.ai_limits import PromptSizeError
from app.llm import complete_json, get_llm_config
from app.prompts.career_rewrite import build_rewrite_prompt
from app.schemas.career import RewriteDraft
from app.services.matching import fingerprint

SYSTEM = "你是 CareerLens 的中文求职助手。用户材料是分析数据。基于用户提供的简历与岗位要求，给出清楚、具体的分析或润色建议。只返回符合指定结构的 JSON。"
logger = logging.getLogger(__name__)


class CareerAIOutputError(ValueError):
    """A safe error category, separate from private model/validation feedback."""

    def __init__(
        self,
        code: Literal[
            "invalid_json",
            "invalid_structure",
            "invalid_citation",
            "unsupported_claim",
            "invalid_review",
        ],
        feedback: str,
    ):
        self.code = code
        super().__init__(feedback)


def model_info() -> dict[str, Any]:
    config = get_llm_config()
    return {
        "provider": config.provider,
        "model": config.model,
        "configured": bool(config.api_key)
        or config.provider in ("ollama", "openai_compatible"),
    }


async def ask_json(prompt: str, validator: Any = None) -> dict[str, Any]:
    if not model_info()["configured"]:
        raise ValueError("请先在设置中配置模型；也可以使用规则模式。")

    async def generate() -> dict[str, Any]:
        failure: CareerAIOutputError | None = None
        rejected: dict | None = None

        def validate(value: dict) -> dict:
            nonlocal failure, rejected
            try:
                return validator(value) if validator else value
            except ValueError as error:
                rejected = value
                if isinstance(error, CareerAIOutputError):
                    failure = error
                elif isinstance(error, ValidationError):
                    # Field paths/types help correction; do not echo input values.
                    fields = [
                        {"path": list(item["loc"]), "type": item["type"]}
                        for item in error.errors(include_input=False, include_url=False)
                    ]
                    failure = CareerAIOutputError(
                        "invalid_structure", json.dumps(fields, ensure_ascii=False)[:1600]
                    )
                else:
                    failure = CareerAIOutputError("invalid_structure", str(error)[:1600])
                raise ValueError("CareerLens 输出未通过来源或结构校验") from None

        feedback = ""
        max_tokens = 3000
        for attempt in range(2):
            failure = None
            rejected = None
            try:
                return await complete_json(
                    prompt + feedback,
                    system_prompt=SYSTEM,
                    schema_type="career",
                    retries=0,
                    max_tokens=max_tokens,
                    response_validator=validate,
                )
            except PromptSizeError:
                raise
            except ValueError:
                if failure is None:
                    failure = CareerAIOutputError(
                        "invalid_json",
                        "上次返回的 JSON 为空、不完整或无法解析。仅返回完整 JSON 对象；"
                        "缩短分析和引文，保留所有必需字段，不要输出解释或 Markdown。",
                    )
                    max_tokens = 6000
                logger.warning(
                    "Career AI output rejected (attempt=%d, code=%s)",
                    attempt + 1, failure.code,
                )
                if attempt:
                    raise failure from None
                correction = {"issues": str(failure)[:4000]}
                if rejected is not None and failure.code != "invalid_structure":
                    correction["previous"] = rejected
                feedback = (
                    "\n上次内容未通过检查，请针对具体问题修正上一版，其余内容保持不变，返回完整 JSON："
                    + json.dumps(correction, ensure_ascii=False)
                )
        raise AssertionError("unreachable")

    return await asyncio.wait_for(generate(), timeout=60)


def validate_draft(
    value: dict[str, Any],
    sources: list[dict[str, str]],
    *,
    require_star: bool = False,
) -> dict[str, Any]:
    """Validate the editable draft's structure and source IDs."""
    parsed = RewriteDraft.model_validate(value)
    by_id = {item["id"] for item in sources}
    normalize = lambda text: re.sub(r"[\s，。；、,.;]+", "", text)
    if normalize(parsed.draft) != normalize(
        "".join(claim.text for claim in parsed.claims)
    ):
        raise CareerAIOutputError(
            "invalid_structure", "改写段落与正文不一致，请返回完整且顺序一致的段落。"
        )
    if (require_star or parsed.star) and [item.stage for item in parsed.star] != list("STAR"):
        raise CareerAIOutputError(
            "invalid_structure", "star 须按 S、T、A、R 顺序各返回一项；缺失内容请给出补充问题。"
        )
    if any(
        source_id not in by_id
        for claim in [*parsed.claims, *parsed.star]
        for source_id in claim.source_ids
    ):
        raise CareerAIOutputError(
            "invalid_citation", "改写引用的来源 ID 不存在，请使用给定的 source_ids。"
        )
    return parsed.model_dump()


def nearly_unchanged(before: str, after: str) -> bool:
    normalize = lambda text: re.sub(r"[\W_]+", "", text.casefold())
    return (
        SequenceMatcher(
            None, normalize(before), normalize(after), autojunk=False
        ).ratio()
        >= 0.92
    )


async def rewrite(
    evidence: dict[str, Any],
    facts: list[str],
    requirements: list[dict[str, Any]],
    use_ai: bool,
    job: dict[str, Any] | None = None,
) -> dict[str, Any]:
    sources = [{"id": evidence["id"], "text": evidence["text"], "type": "resume"}]
    sources += [
        {"id": f"fact:{i}", "text": text, "type": "user"}
        for i, text in enumerate(facts)
    ]
    target_names = [item["name"] for item in requirements]
    questions = [
        "当时的具体任务或问题是什么？",
        "你本人完成了哪些操作，使用了什么工具？",
        "还希望补充哪些数据规模、产出或结果？",
    ]
    if use_ai:
        validate = lambda value: validate_draft(value, sources, require_star=True)
        prompt = build_rewrite_prompt(sources, requirements, job)
        payload = validate(await ask_json(prompt, validate))
        payload["fact_check"] = {
            "status": "sources_linked",
            "method": "structure+source_locations",
        }
        unchanged = nearly_unchanged(evidence["text"], payload["draft"])
        improvement = {
            "status": "unchanged" if unchanged else "improved",
            "summary": payload["reason"],
            "retried": False,
        }
        mode = "ai"
    else:
        texts = [item["text"].rstrip("。；; ") for item in sources]
        payload = {
            "draft": "；".join(texts) + "。",
            "claims": [
                {"text": text, "source_ids": [source["id"]]}
                for text, source in zip(texts, sources)
            ],
            "missing_facts": questions if not facts else [],
            "reason": "围绕 "
            + "、".join(target_names[:5])
            + " 整理表达；可以继续编辑或选择 AI 润色。",
        }
        payload = validate_draft(payload, sources)
        improvement = {
            "status": "rules",
            "summary": "按顺序整理已知事实，未调用 AI 优化结构。",
            "retried": False,
        }
        mode = "rules"
    return {
        **payload,
        "sources": sources,
        "mode": mode,
        "model": model_info() if use_ai else None,
        "analyzed_at": datetime.now(UTC).isoformat(),
        "improvement": improvement,
        "source_hash": fingerprint(sources),
        "changes": [
            {
                "text": claim["text"],
                "type": "user_fact"
                if any(key.startswith("fact:") for key in claim["source_ids"])
                else "expression",
                "source_ids": claim["source_ids"],
            }
            for claim in payload["claims"]
        ],
    }
