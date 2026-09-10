"""Resume photos stay local while all text-generation paths retain actual evidence."""

import copy
import json
from unittest.mock import AsyncMock

import pytest

from app.ai_limits import validate_source_size, without_resume_photo
from app.routers import enrichment, resumes
from app.schemas.models import ResumeData
from app.schemas.resume_wizard import ResumeWizardState
from app.services import cover_letter, improver, interview_prep, refiner, resume_wizard

PHOTO = "data:image/png;base64," + "PRIVATE_PHOTO_BYTES" * 20_000
PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
)


def source(photo=PHOTO):
    return {
        "personalInfo": {"name": "Synthetic Candidate", "photo": photo},
        "summary": "Built Python services from documented requirements.",
        "workExperience": [
            {
                "id": 1,
                "title": "Engineer",
                "company": "Example",
                "years": "2025-01 - 2026-01",
                "description": ["Delivered a Python service."],
            }
        ],
        "education": [],
        "personalProjects": [],
        "additional": {"technicalSkills": ["Python"]},
    }


def assert_text_only(prompt):
    assert "PRIVATE_PHOTO_BYTES" not in prompt and "data:image" not in prompt
    assert '"photo"' not in prompt and "Synthetic Candidate" in prompt
    assert "Python" in prompt


def test_nested_and_serialized_resume_limits_ignore_only_photo_without_mutation():
    resume = source()
    original = copy.deepcopy(resume)
    validate_source_size(resume)
    validate_source_size(json.dumps(resume))
    wrapped = {"resume_data": resume, "history": [{"resume_data_before": resume}]}
    cleaned = without_resume_photo(wrapped)
    assert "photo" not in cleaned["resume_data"]["personalInfo"]
    assert "photo" not in cleaned["history"][0]["resume_data_before"]["personalInfo"]
    assert_text_only(without_resume_photo(json.dumps(resume)))
    assert resume == original
    with pytest.raises(ValueError):
        validate_source_size({"summary": "x" * 200_001})
    with pytest.raises(ValueError):
        validate_source_size({"customSections": {"photo": "x" * 200_001}})
    resumes._validate_ai_sources(
        {"content": json.dumps(resume), "processed_data": resume}
    )
    assert resume["personalInfo"]["photo"] == PHOTO


@pytest.mark.parametrize(
    "operation", ["generate_cover_letter", "generate_outreach_message"]
)
@pytest.mark.parametrize("custom", [False, True])
async def test_letters_keep_photo_out_of_default_and_custom_prompts(
    monkeypatch, operation, custom
):
    resume = source()
    complete = AsyncMock(return_value="Generated text")
    monkeypatch.setattr(cover_letter, "complete", complete)
    monkeypatch.setattr(
        cover_letter,
        "load_config_file",
        lambda: {
            "cover_letter_prompt": "{resume_data} {job_description}" if custom else "",
            "outreach_message_prompt": "{resume_data} {job_description}"
            if custom
            else "",
        },
    )
    await getattr(cover_letter, operation)(resume, "Python role")
    assert_text_only(complete.await_args.kwargs["prompt"])
    assert resume["personalInfo"]["photo"] == PHOTO


def test_interview_photo_cannot_trigger_truncation_of_text_evidence():
    resume = source()
    result = interview_prep._serialize_resume_data_for_prompt(resume)
    assert_text_only(result)
    assert "truncated" not in result and "Delivered a Python service." in result
    assert resume["personalInfo"]["photo"] == PHOTO


@pytest.mark.parametrize("operation", ["generate_resume_diffs", "improve_resume"])
@pytest.mark.parametrize("structured", ["month", "year", "none"])
async def test_improve_structured_and_json_fallback_prompts_exclude_photo(
    monkeypatch, operation, structured
):
    resume = source()
    if structured == "year":
        resume["workExperience"][0]["years"] = "2025 - 2026"
    response = (
        {"changes": [], "strategy_notes": ""}
        if operation == "generate_resume_diffs"
        else without_resume_photo(resume)
    )
    complete = AsyncMock(return_value=response)
    monkeypatch.setattr(improver, "complete_json", complete)
    await getattr(improver, operation)(
        json.dumps(resume),
        "Python role",
        {},
        original_resume_data=None if structured == "none" else resume,
    )
    assert_text_only(complete.await_args.kwargs["prompt"])
    assert resume["personalInfo"]["photo"] == PHOTO


async def test_skill_planner_and_refiner_do_not_send_or_lose_photo(monkeypatch):
    resume = source()
    planner = AsyncMock(return_value={"target_skills": [], "strategy_notes": ""})
    monkeypatch.setattr(improver, "complete_json", planner)
    await improver.generate_skill_target_plan(resume, "Python role", {})
    assert_text_only(planner.await_args.kwargs["prompt"])
    writer = AsyncMock(return_value=without_resume_photo(resume))
    monkeypatch.setattr(refiner, "complete_json", writer)
    result = await refiner.inject_keywords(resume, ["Python"], resume, "Python role")
    assert_text_only(writer.await_args.kwargs["prompt"])
    assert result["personalInfo"]["photo"] == PHOTO
    assert resume["personalInfo"]["photo"] == PHOTO


async def test_wizard_keeps_photo_in_state_but_not_prompt(monkeypatch):
    resume = ResumeData.model_validate(source(PNG))
    state = ResumeWizardState(resume_data=resume)
    complete = AsyncMock(
        return_value={
            "resume_data": {"personalInfo": {"name": "Synthetic Candidate"}},
            "next_question": {
                "text": "Describe your work",
                "section": "workExperience",
            },
        }
    )
    monkeypatch.setattr(resume_wizard, "complete_json", complete)
    result = await resume_wizard.run_ai_turn(
        state, "My name is Synthetic Candidate", skip=False
    )
    assert_text_only(complete.await_args.args[0])
    assert result.resume_data.personalInfo.photo == PNG
    assert state.resume_data.personalInfo.photo == PNG


async def test_enrichment_analysis_does_not_send_photo_or_reject_valid_text(
    monkeypatch,
):
    resume = source()
    monkeypatch.setattr(
        enrichment.db, "get_resume", AsyncMock(return_value={"processed_data": resume})
    )
    complete = AsyncMock(
        return_value={
            "items_to_enrich": [],
            "questions": [],
            "analysis_summary": "Clear",
        }
    )
    monkeypatch.setattr(enrichment, "complete_json", complete)
    result = await enrichment.analyze_resume("synthetic-only")
    assert result.items_to_enrich == []
    assert_text_only(complete.await_args.args[0])
    assert resume["personalInfo"]["photo"] == PHOTO
