"""Explicit source and request limits; oversized input is rejected, not cut."""

import json
from typing import Any

from fastapi import HTTPException

MAX_SOURCE_CHARACTERS = 200_000
MAX_TEXT_INPUT_CHARACTERS = 300_000
MAX_SAVED_SOURCE_CHARACTERS = 3_000_000
MAX_REQUIREMENT_SOURCE_CHARACTERS = 3_000
MAX_JOB_CHARACTERS = 100_000
MAX_PROMPT_CHARACTERS = 512_000
MAX_ITEM_WORKERS = 4


class PromptSizeError(ValueError):
    """A rendered provider prompt exceeds the supported request size."""


def without_resume_photo(value: Any) -> Any:
    """Copy AI text input without embedded resume photos; leave stored data intact."""
    if isinstance(value, str):
        # Stored resume.content may itself be a JSON serialization of ResumeData.
        if '"photo"' not in value:
            return value
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            return value
        if isinstance(parsed, (dict, list)):
            return json.dumps(without_resume_photo(parsed), ensure_ascii=False)
        return value
    if isinstance(value, list):
        return [without_resume_photo(item) for item in value]
    if isinstance(value, dict):
        return {
            key: {
                field: without_resume_photo(item)
                for field, item in child.items()
                if field != "photo"
            }
            if key == "personalInfo" and isinstance(child, dict)
            else without_resume_photo(child)
            for key, child in value.items()
        }
    return value


def validate_prompt_size(value: str) -> None:
    """Reject a rendered prompt with a client-actionable exception type."""
    if len(value) > MAX_PROMPT_CHARACTERS:
        raise PromptSizeError(
            f"AI prompt exceeds the {MAX_PROMPT_CHARACTERS}-character limit"
        )


def validate_source_size(value: Any, limit: int = MAX_SOURCE_CHARACTERS) -> None:
    """Validate JSON/text source size for schemas and service boundaries."""
    value = without_resume_photo(value)
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    if len(text) > limit:
        raise ValueError(f"AI source exceeds the {limit}-character limit")


def require_source_size(value: Any, limit: int = MAX_SOURCE_CHARACTERS) -> None:
    """Reject oversized stored input before starting an AI stage."""
    try:
        validate_source_size(value, limit)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
