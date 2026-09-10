"""Malformed model output has bounded correction and safe failure categories."""

import json

import pytest
from fastapi import HTTPException
from pydantic import BaseModel

from app.ai_limits import PromptSizeError
from app.routers.career import run_diagnosis
from app.services import career_ai


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    monkeypatch.setattr(career_ai, "model_info", lambda: {"configured": True})


async def test_malformed_json_gets_one_larger_bounded_retry(monkeypatch):
    calls = []

    async def complete(prompt, **kwargs):
        calls.append((prompt, kwargs))
        if len(calls) == 1:
            raise json.JSONDecodeError("truncated", '{"private":', 11)
        return kwargs["response_validator"]({"answer": "complete"})

    monkeypatch.setattr(career_ai, "complete_json", complete)
    assert await career_ai.ask_json("synthetic") == {"answer": "complete"}
    assert [call[1]["max_tokens"] for call in calls] == [3000, 6000]
    assert all(call[1]["retries"] == 0 for call in calls)
    assert "完整 JSON" in calls[1][0]
    assert "private" not in calls[1][0]


async def test_repeated_malformed_output_has_safe_category(monkeypatch, caplog):
    calls = 0

    async def complete(*args, **kwargs):
        nonlocal calls
        calls += 1
        raise ValueError("private model response and secret")

    monkeypatch.setattr(career_ai, "complete_json", complete)
    with pytest.raises(career_ai.CareerAIOutputError) as caught:
        await career_ai.ask_json("synthetic")
    assert calls == 2
    assert caught.value.code == "invalid_json"
    assert "private" not in str(caught.value) + caplog.text
    assert "secret" not in caplog.text


async def test_validator_category_and_feedback_survive_retry(monkeypatch, caplog):
    prompts = []

    async def complete(prompt, **kwargs):
        prompts.append(prompt)
        return kwargs["response_validator"]({"answer": "synthetic"})

    def validate(value):
        raise career_ai.CareerAIOutputError("invalid_citation", "synthetic private quote")

    monkeypatch.setattr(career_ai, "complete_json", complete)
    with pytest.raises(career_ai.CareerAIOutputError) as caught:
        await career_ai.ask_json("synthetic", validate)
    assert len(prompts) == 2
    assert "synthetic private quote" in prompts[1]
    assert caught.value.code == "invalid_citation"
    assert "synthetic private quote" not in caplog.text


async def test_schema_feedback_contains_field_but_not_input(monkeypatch):
    class Result(BaseModel):
        count: int

    prompts = []

    async def complete(prompt, **kwargs):
        prompts.append(prompt)
        return kwargs["response_validator"]({"count": "PRIVATE_INPUT"})

    monkeypatch.setattr(career_ai, "complete_json", complete)
    with pytest.raises(career_ai.CareerAIOutputError) as caught:
        await career_ai.ask_json("synthetic", Result.model_validate)
    assert caught.value.code == "invalid_structure"
    assert "count" in prompts[1] and "int_parsing" in prompts[1]
    assert "PRIVATE_INPUT" not in prompts[1]


async def test_last_attempt_error_does_not_reuse_previous_category(monkeypatch):
    calls = 0

    async def complete(prompt, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return kwargs["response_validator"]({})
        raise ValueError("malformed JSON")

    def validate(value):
        raise career_ai.CareerAIOutputError("invalid_citation", "wrong quote")

    monkeypatch.setattr(career_ai, "complete_json", complete)
    with pytest.raises(career_ai.CareerAIOutputError) as caught:
        await career_ai.ask_json("synthetic", validate)
    assert caught.value.code == "invalid_json"


async def test_prompt_limit_is_not_retried_as_model_output(monkeypatch):
    calls = 0

    async def complete(*args, **kwargs):
        nonlocal calls
        calls += 1
        raise PromptSizeError("too long")

    monkeypatch.setattr(career_ai, "complete_json", complete)
    with pytest.raises(HTTPException) as caught:
        await run_diagnosis(career_ai.ask_json, "synthetic")
    assert calls == 1
    assert caught.value.status_code == 422


@pytest.mark.parametrize("code", [
    "invalid_json", "invalid_structure", "invalid_citation",
    "unsupported_claim", "invalid_review",
])
async def test_route_exposes_only_safe_error_category(code, caplog):
    async def analysis():
        raise career_ai.CareerAIOutputError(code, "PRIVATE_RESUME_AND_KEY")

    with pytest.raises(HTTPException) as caught:
        await run_diagnosis(analysis)
    assert caught.value.status_code == 502
    assert "本次未保存 AI 结果" in caught.value.detail
    assert "PRIVATE_RESUME_AND_KEY" not in caught.value.detail + caplog.text
    assert code in caplog.text
