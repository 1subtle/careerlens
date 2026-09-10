"""STAR advice extends saved drafts without adding another model review."""

import copy
import json

import pytest

from app.prompts.career_rewrite import build_rewrite_prompt
from app.services.career_ai import CareerAIOutputError, rewrite, validate_draft


SOURCES = [{"id": "e1", "text": "协助整理 Excel 周报。", "type": "resume"}]
DRAFT = {
    "draft": SOURCES[0]["text"],
    "claims": [{"text": SOURCES[0]["text"], "source_ids": ["e1"]}],
    "missing_facts": ["周报对应哪个业务场景？"],
    "reason": "保留实际职责与周报产物。",
}
STAR = [
    {"stage": "S", "evidence": "", "question": "周报对应哪个业务场景？", "source_ids": []},
    {"stage": "T", "evidence": "", "question": "你被分配了周报的哪部分任务？", "source_ids": []},
    {"stage": "A", "evidence": "协助整理 Excel 周报", "question": "", "source_ids": ["e1"]},
    {"stage": "R", "evidence": "周报", "question": "", "source_ids": ["e1"]},
]


def test_saved_legacy_draft_defaults_new_advice_to_empty():
    result = validate_draft(DRAFT, SOURCES)
    assert result["draft"] == DRAFT["draft"]
    assert result["star"] == result["keyword_suggestions"] == result["quantification_suggestions"] == []


def test_star_keeps_missing_questions_separate_from_sourced_content():
    result = validate_draft({**DRAFT, "star": STAR}, SOURCES, require_star=True)
    assert result["star"] == STAR
    assert result["draft"] == "协助整理 Excel 周报。"


@pytest.mark.parametrize("problem", ["missing", "duplicate", "unknown_source", "unlinked_evidence", "missing_question"])
def test_star_contract_rejects_incomplete_or_unlinked_advice(problem):
    value = {**DRAFT, "star": copy.deepcopy(STAR)}
    if problem == "missing":
        value.pop("star")
    elif problem == "duplicate":
        value["star"][1]["stage"] = "S"
    elif problem == "unknown_source":
        value["star"][2]["source_ids"] = ["unknown"]
    elif problem == "unlinked_evidence":
        value["star"][2]["source_ids"] = []
    else:
        value["star"][0]["question"] = ""
    with pytest.raises(ValueError) as caught:
        validate_draft(value, SOURCES, require_star=True)
    if problem == "unknown_source":
        assert isinstance(caught.value, CareerAIOutputError)
        assert caught.value.code == "invalid_citation"


async def test_rules_mode_stays_compatible_without_paid_star_analysis():
    result = await rewrite(SOURCES[0], [], [], False)
    assert result["mode"] == "rules"
    assert result["star"] == []
    assert result["claims"][0]["source_ids"] == ["e1"]


async def test_missing_star_uses_existing_single_structure_correction(monkeypatch):
    from app.services import career_ai

    monkeypatch.setattr(career_ai, "model_info", lambda: {"configured": True})
    calls = []

    async def complete(prompt, **kwargs):
        calls.append((prompt, kwargs))
        value = DRAFT if len(calls) == 1 else {**DRAFT, "star": STAR}
        return kwargs["response_validator"](value)

    monkeypatch.setattr(career_ai, "complete_json", complete)
    result = await career_ai.rewrite(SOURCES[0], [], [], True)
    assert result["star"] == STAR
    assert len(calls) == 2
    assert [kwargs["max_tokens"] for _, kwargs in calls] == [3000, 3000]
    assert all(kwargs["retries"] == 0 for _, kwargs in calls)


def test_prompt_uses_adapted_star_guidance_at_runtime(monkeypatch):
    from app.prompts import career_rewrite

    monkeypatch.setattr(career_rewrite, "STAR_GUIDANCE", ["source-adapted-star-guidance"])
    result = json.loads(build_rewrite_prompt(SOURCES, [], None))
    assert result["STAR建议"] == ["source-adapted-star-guidance"]
    assert [item["stage"] for item in result["输出结构"]["star"]] == list("STAR")
