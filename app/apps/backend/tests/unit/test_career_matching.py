"""Deterministic, manually computable CareerLens boundaries."""

import pytest

from app.services.career_ai import validate_draft
from app.services.demo import DEMO_RESUME
from app.services.matching import (
    conditions_for,
    evidence_from_resume,
    market_summary,
    match_requirements,
    parse_resume_local,
    parse_salary,
    requirements_from_text,
    skills_in,
    work_months,
)


def test_weighted_evidence_and_missing_requirement() -> None:
    requirements = requirements_from_text("Python；SQL；Excel；Tableau 优先。Python。")
    evidence = evidence_from_resume(parse_resume_local(DEMO_RESUME))
    details, score = match_requirements(requirements, evidence)
    assert score == 71.4
    assert len(details) == 4
    assert [d["value"] for d in details] == [1, 0.5, 1, 0]
    assert round(sum(d["contribution"] for d in details), 1) == score
    assert match_requirements([], evidence) == ([], None)


def test_boundaries_negation_and_skill_statement() -> None:
    assert set(skills_in("使用C++、C#、R与A/B Testing")) == {
        "C++",
        "C#",
        "R",
        "A/B Testing",
    }
    assert "Java" not in skills_in("JavaScript")
    assert "R" not in skills_in("React")
    req = requirements_from_text("SQL；Python；Tableau")
    data = {"summary": "计划学习 SQL。未使用 Tableau。熟悉 Python。"}
    details, score = match_requirements(req, evidence_from_resume(data))
    assert [d["value"] for d in details] == [0, 0.5, 0]
    assert score == 16.7


def test_degree_unknown_and_date_overlap() -> None:
    data = {
        "education": [{"degree": "本科"}],
        "workExperience": [{"years": "2025.01—2025.06"}, {"years": "2025.04—2025.09"}],
    }
    assert work_months(data) == 9
    assert conditions_for(data, "本科及以上，硕士优先")[0]["status"] == "met"
    assert conditions_for({}, "本科及以上")[0]["status"] == "unknown"


def test_salary_units_dedup_and_demo_exclusion() -> None:
    assert parse_salary("8-12K/月·13薪")["mid"] == 10000
    assert parse_salary("150-200元/天")["period"] == "day"
    assert parse_salary("12-18万元/年")["mid"] == 150000
    assert parse_salary("面议")["mid"] is None
    jobs = [
        {
            "job_id": "a",
            "content": "SQL",
            "company": "甲",
            "salary_text": "100-200元/天",
            "source_type": "manual",
        },
        {"job_id": "b", "content": " SQL ", "company": "甲"},
        {"job_id": "c", "content": "Python", "source_type": "synthetic"},
    ]
    summary = market_summary(jobs, {})
    assert summary["count"] == 1
    assert summary["skills"][0]["value"] == 1
    assert market_summary(jobs, {"include_demo": True})["count"] == 2


@pytest.mark.parametrize(
    "text", ["使用 Python 完成分析", "完成 50% 的增长", "【待补充】完成分析"]
)
def test_rewrite_rejects_unfounded_tools_numbers_placeholders(text: str) -> None:
    with pytest.raises(ValueError):
        validate_draft(
            {
                "draft": text,
                "claims": [{"text": text, "source_ids": ["e1"]}],
                "reason": "表达优化",
            },
            [{"id": "e1", "text": "完成分析"}],
        )
