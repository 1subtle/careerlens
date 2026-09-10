"""Market sample denominators and conservative source-title categories."""

import pytest

from app.services.matching import category_from_title, market_summary
from app.services.ncss import _job_view
from app.services.recruitment import job_view


def posting(number, **fields):
    return {
        "job_id": str(number),
        "external_id": str(number),
        "title": "数据分析实习生",
        "content": "Python；Python；SQL。",
        "company": "测试公司",
        "category": "人工校对类别",
        "city": "北京",
        "source_type": "api",
        "source_name": "测试来源",
        **fields,
    }


def test_date_coverage_uses_filtered_deduplicated_sample_and_publication_only():
    recent = posting(1, published_at="2026-09-01", salary_text="8-12k/月")
    jobs = [
        recent,
        {**recent, "job_id": "duplicate"},
        posting(2, published_at="2026-08-30"),
        posting(3, source_updated_at="2026-09-10", created_at="2026-09-10"),
        posting(4, category="其他"),
        posting(5, city="上海"),
        posting(6, source_type="synthetic"),
    ]
    filters = {"category": "人工校对类别", "city": "北京", "since": "2026-09-01"}
    summary = market_summary(jobs, filters)
    assert summary["job_ids"] == ["1"]
    assert summary["coverage"] == {
        "sample_count": 3,
        "published_count": 2,
        "published_missing": 1,
        "published_min": "2026-08-30",
        "published_max": "2026-09-01",
        "date_basis": "published_at",
        "date_excluded_count": 2,
        "demo_excluded_count": 1,
        "duplicates_removed": 1,
        "unknown_category_count": 0,
    }
    assert summary["salaries"][0]["mid"] == 10000
    assert summary["distribution"][0]["category"] == "人工校对类别"
    assert all(skill["value"] == 1 for skill in summary["skills"])
    assert all(
        skill["percent"] == 100 for skill in summary["distribution"][0]["skills"]
    )
    all_dates = market_summary(jobs, {**filters, "since": None})
    assert all_dates["count"] == 3
    assert all_dates["salary_missing"] == 2
    assert all_dates["coverage"]["date_excluded_count"] == 0


def test_unknown_dates_and_categories_remain_available_without_date_filter():
    jobs = [posting(1, category="其他"), posting(2, category="")]
    summary = market_summary(jobs, {"category": "其他"})
    assert summary["count"] == summary["coverage"]["unknown_category_count"] == 2
    assert summary["coverage"]["published_count"] == 0
    assert summary["coverage"]["published_min"] is None
    assert summary["coverage"]["published_max"] is None
    assert market_summary(jobs, {"since": "2026-09-01"})["count"] == 0
    assert market_summary([], {})["coverage"]["sample_count"] == 0


@pytest.mark.parametrize(
    ("title", "category"),
    [
        ("数据工程师", "数据分析"),
        ("小学英语老师", "教育培训"),
        ("26届新媒体运营实习生", "运营"),
        ("学习规划师（课程顾问）", "市场销售"),
        ("预算分析师", "财务金融"),
        ("后厨实习生", "餐饮服务"),
        ("Senior Software Engineer", "软件研发"),
        ("无人机事业部主管", "其他"),
        ("实习生", "其他"),
    ],
)
def test_title_categories_require_explicit_occupational_words(title, category):
    assert category_from_title(title) == category


def test_source_adapters_fill_missing_category_and_preserve_source_category():
    source = {"jobId": "one", "jobName": "小学英语老师", "recName": "测试公司"}
    assert _job_view(source, "2026-09-10")["category"] == "教育培训"
    source = {
        "PostId": "1",
        "RecruitPostName": "数据分析师",
        "Responsibility": "分析业务数据",
        "Requirement": "熟悉 SQL",
        "CategoryName": "来源专有类别",
    }
    assert job_view(source, complete=True)["category"] == "来源专有类别"
    assert (
        job_view({**source, "CategoryName": ""}, complete=True)["category"] == "数据分析"
    )
