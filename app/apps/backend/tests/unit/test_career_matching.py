"""Deterministic, manually computable CareerLens boundaries."""

from datetime import date

import pytest

from app.schemas.career import JobInput
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


@pytest.mark.parametrize(
    "text",
    ["<" * 300_000, "![" * 150_000, "A" + " " * 299_998 + "Z"],
)
def test_rule_parser_handles_maximum_adversarial_plain_text(text: str) -> None:
    assert parse_resume_local(text)["summary"] == text


def test_rule_parser_handles_maximum_adversarial_role_title() -> None:
    prefix = "项目经历\n2025.01 - 2025.02 A"
    text = prefix + " " * (300_000 - len(prefix) - 1) + "Z"

    assert len(text) == 300_000
    assert parse_resume_local(text)["personalProjects"][0]["role"] == ""


def test_rule_parser_bounds_items_in_maximum_multiline_input() -> None:
    prefix = "项目经历\n"
    text = (prefix + "甲项目\n" * 100_000)[:300_000]

    assert len(text) == 300_000
    assert len(parse_resume_local(text)["personalProjects"]) == 200


@pytest.mark.parametrize("text", ["x" * 300_000, "1" * 300_000])
def test_conditions_handle_maximum_adversarial_text(text: str) -> None:
    conditions = conditions_for({}, text)

    assert [condition["status"] for condition in conditions] == [
        "not_stated",
        "not_stated",
        "not_stated",
    ]


def test_ai_style_requirement_names_match_resume_concepts() -> None:
    requirements = [
        {
            "id": "q-sql",
            "name": "SQL 或 Excel 搭建业务看板",
            "source_text": "使用 SQL 或 Excel 搭建业务看板",
            "priority": "required",
        },
        {
            "id": "q-interview",
            "name": "通过用户访谈发现转化问题",
            "source_text": "结合用户访谈发现转化问题",
            "priority": "required",
        },
        {
            "id": "q-collaboration",
            "name": "清晰的跨团队沟通能力",
            "source_text": "具备清晰的跨团队沟通能力",
            "priority": "required",
        },
        {
            "id": "q-metrics",
            "name": "用量化结果说明影响",
            "source_text": "能够用量化结果说明影响",
            "priority": "required",
        },
    ]
    evidence = evidence_from_resume(
        {
            "workExperience": [
                {
                    "title": "产品运营",
                    "description": [
                        "使用 SQL 搭建报名漏斗周报。",
                        "负责用户访谈并定位转化问题。",
                        "协调产品、研发、设计与客服推进交付。",
                        "围绕核心指标完成分析，留存率提升 6.2 个百分点。",
                    ],
                }
            ]
        }
    )

    details, score = match_requirements(requirements, evidence)

    assert score == 100.0
    assert [detail["status"] for detail in details] == ["supported"] * 4
    assert [detail["evidence_ids"] for detail in details] == [
        ["workExperience:0:0"],
        ["workExperience:0:1"],
        ["workExperience:0:2"],
        ["workExperience:0:3"],
    ]


def test_maximum_jd_rule_requirements_fit_the_job_contract() -> None:
    text = ("Python SQL " + "x" * 300_000)[:300_000]

    requirements = requirements_from_text(text)
    job = JobInput(title="数据分析", text=text, requirements=requirements)

    assert [requirement["name"] for requirement in requirements] == ["Python", "SQL"]
    assert all(
        0 < len(requirement["source_text"]) <= 3_000
        and requirement["source_text"] in text
        for requirement in requirements
    )
    assert len(job.requirements or []) == 2


def test_descriptive_requirements_remain_conservative() -> None:
    requirements = [
        {
            "id": "q-sql",
            "name": "熟练使用 SQL",
            "source_text": "熟练使用 SQL",
            "priority": "required",
        },
        {
            "id": "q-process",
            "name": "推动产品流程优化",
            "source_text": "推动产品流程优化",
            "priority": "required",
        },
    ]
    evidence = evidence_from_resume(
        {
            "workExperience": [
                {
                    "title": "产品运营",
                    "description": ["计划学习 SQL。", "推动产品按期发布。"],
                }
            ]
        }
    )

    details, score = match_requirements(requirements, evidence)

    assert score == 0.0
    assert [detail["status"] for detail in details] == ["pending", "pending"]


def test_degree_unknown_and_date_overlap() -> None:
    data = {
        "education": [{"degree": "本科"}],
        "workExperience": [{"years": "2025.01—2025.06"}, {"years": "2025.04—2025.09"}],
    }
    assert work_months(data) == 9
    assert conditions_for(data, "本科及以上，硕士优先")[0]["status"] == "met"
    assert conditions_for({}, "本科及以上")[0]["status"] == "unknown"


@pytest.mark.parametrize("marker", ["至今", "现在", "Present", "present"])
def test_work_months_supports_open_ended_ranges(marker: str) -> None:
    data = {
        "workExperience": [
            {"years": f"2024.07 - {marker}"},
            {"years": "2023.06 - 2023.12"},
        ]
    }

    assert work_months(data, today=date(2026, 9, 11)) == 34


def test_work_months_ignores_invalid_and_future_months() -> None:
    data = {
        "workExperience": [
            {"years": "2024.00 - Present"},
            {"years": "2024.07 - 2024.13"},
            {"years": "2025.05 - 2025.04"},
            {"years": "Present - 2024.07"},
            {"years": "2027.01 - Present"},
            {"years": "2027.01 - 2027.06"},
            {"years": "2025.10 - 2027.03"},
        ]
    }

    assert work_months(data, today=date(2026, 9, 11)) == 12


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


def test_api_market_counts_distinct_posts_and_deduplicates_repeated_ids() -> None:
    first = {
        "job_id": "tencent-1",
        "external_id": "1",
        "content": "熟练使用 SQL。",
        "company": "腾讯",
        "city": "广州",
        "source_type": "api",
        "source_name": "腾讯招聘",
    }
    second = {**first, "job_id": "tencent-2", "external_id": "2", "city": "上海"}
    summary = market_summary([first, second, {**first, "job_id": "duplicate"}], {})
    assert summary["count"] == 2
    assert summary["job_ids"] == ["tencent-1", "tencent-2"]
    assert summary["skills"][0]["value"] == 2
    assert market_summary([first, {**first, "source_name": "另一来源"}], {})["count"] == 2


@pytest.mark.parametrize(
    "text", ["使用 Python 完成分析", "完成 50% 的增长", "【待补充】完成分析"]
)
def test_rewrite_allows_tools_numbers_and_editable_placeholders(text: str) -> None:
    result = validate_draft(
        {
            "draft": text,
            "claims": [{"text": text, "source_ids": ["e1"]}],
            "reason": "表达优化",
        },
        [{"id": "e1", "text": "完成分析"}],
    )
    assert result["draft"] == text


def test_chinese_markdown_entries_and_displaced_headings() -> None:
    data = parse_resume_local("""![头像](data:image/jpeg;base64...)
**技能：** Python、SQL
**林同学** 求职意向：产品经理
**2025.01 – 2025.04 数字产品体验研究 项目负责人**
* 设计问卷并访谈用户，整理调研数据。
* 分析 2023.01—2024.01 期间的问卷反馈。
项目经历
**2024.06 – 2025-06 智能调度研究 主要成员**
* 设计并验证优化算法。
荣誉奖项
2024 年校级一等奖学金
**2023.09 - 至今 示例大学 信息管理专业**
主修课程：管理学、运筹学
学历：本科
教 育 背 景
""")
    assert data["personalInfo"]["name"] == "林同学"
    assert len(data["personalProjects"]) == 2
    assert data["personalProjects"][0]["role"] == "项目负责人"
    assert len(data["personalProjects"][0]["description"]) == 2
    assert len(data["education"]) == 1
    assert data["education"][0]["degree"] == "本科"
    assert data["education"][0]["years"] == "2023.09 - 至今"
    assert "主修课程" in data["education"][0]["description"]


@pytest.mark.parametrize(
    "draft",
    [
        "主导产品上线，显著提升用户留存。",
        "完成商业化并增加营收。",
        "整理调研数据，为产品功能迭代提供依据。",
        "整理调研数据，用于产品迭代。",
    ],
)
def test_rewrite_allows_role_and_purpose_suggestions(draft: str) -> None:
    result = validate_draft(
        {
            "draft": draft,
            "claims": [{"text": draft, "source_ids": ["e1"]}],
            "reason": "润色",
        },
        [{"id": "e1", "text": "参与问卷设计，并整理调研数据。"}],
    )
    assert result["draft"] == draft


@pytest.mark.parametrize("problem", ["unknown_source", "inconsistent_paragraph"])
def test_rewrite_preserves_source_ids_and_paragraph_structure(problem: str) -> None:
    draft = {
        "draft": "整理调研数据。",
        "claims": [{"text": "整理调研数据。", "source_ids": ["e1"]}],
        "reason": "表达调整",
    }
    if problem == "unknown_source":
        draft["claims"][0]["source_ids"] = ["missing"]
    else:
        draft["claims"][0]["text"] = "不同的正文。"
    with pytest.raises(ValueError):
        validate_draft(draft, [{"id": "e1", "text": "参与调研。"}])


def test_stated_purpose_can_be_rephrased() -> None:
    text = "为产品迭代提供参考。"
    assert (
        validate_draft(
            {
                "draft": text,
                "claims": [{"text": text, "source_ids": ["e1"]}],
                "reason": "表述调整",
            },
            [{"id": "e1", "text": "整理调研数据，用于产品迭代。"}],
        )["draft"]
        == text
    )
