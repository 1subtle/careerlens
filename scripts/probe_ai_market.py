"""Probe market advice and history using synthetic jobs and temporary accounts.

Run with PYTHONPATH=app/apps/backend (or /app/backend in the hosted container).
--dry-run prints inputs without importing the app. --mock exercises the real
analysis, JSON parsing, credit and history paths with a stubbed provider and
blocked network. Without --mock, the configured model is used and provider
usage is billed. Each case permits at most three provider attempts, six total.
All account, credit and history files are created inside a temporary DATA_DIR.
"""

import argparse
import asyncio
import hashlib
import json
import logging
import os
import secrets
import tempfile
import time
from contextlib import ExitStack
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch


def report(event, **values):
    print(json.dumps({"event": event, **values}, ensure_ascii=False), flush=True)


def cases(today=None):
    today = today or date.today()
    month = today.replace(day=1)
    old = month - timedelta(days=1)
    jobs = []
    rows = [
        ("month", "数据分析", "上海", month, "8-12K/月", "SQL、Python、数据分析"),
        ("day", "数据分析", "上海", today, "150-200元/天", "SQL、Excel、数据清洗"),
        ("undated", "数据分析", "上海", None, "", "Python、Tableau、数据可视化"),
        ("beijing", "数据分析", "北京", today, "20-30K/月", "SQL、Python、机器学习"),
        ("old", "数据分析", "上海", old, "12-18K/月", "SQL、Excel、统计分析"),
        ("product", "产品设计", "上海", today, "", "Figma、用户研究、需求分析"),
    ]
    for name, category, city, published, salary, skills in rows:
        jobs.append({
            "job_id": f"probe-{name}", "title": f"合成{category}岗位-{name}",
            "company": f"虚构验证机构-{name}", "category": category, "city": city,
            "content": f"合成验证 JD：工作需要使用 {skills}。", "salary_text": salary,
            "source_type": "synthetic", "source_name": "市场分析隔离验证样本",
            "published_at": published.isoformat() if published else None,
            "source_updated_at": today.isoformat(), "created_at": today.isoformat(),
        })
    return [
        {
            "name": "filtered_recent", "jobs": jobs,
            "request": {
                "category": "数据分析", "city": "上海", "since": month.isoformat(),
                "include_demo": True, "use_ai": True,
                "question": "这些岗位与北京的数据分析岗位相比怎么样？请比较薪资并给出求职建议。",
            },
            "expected_ids": ["probe-month", "probe-day"],
            "expected_sample_count": 4, "expected_date_missing": 1,
            "expected_date_excluded": 2,
            "review": "仅解读上海本月两岗位，说明缺少北京对照；月薪与日薪分别比较，未知日期岗位不进入近期样本。",
        },
        {
            "name": "learning_route", "jobs": jobs,
            "request": {
                "include_demo": True, "use_ai": True,
                "question": "根据全部岗位的技能要求，为准备求职的学生安排两周学习路线，说明优先技能、可展示的项目产出和投递下一步。",
            },
            "expected_ids": [job["job_id"] for job in jobs],
            "expected_sample_count": 6, "expected_date_missing": 1,
            "expected_date_excluded": 0,
            "review": "用六个合成岗位给出有优先级的学习、作品和投递行动；保持技能分母与薪资周期，不推断整个市场趋势。",
        },
    ]


async def probe(directory, selected, mock=False):
    from app.config import settings

    root = Path(directory).resolve()
    assert settings.data_dir.resolve() == root, "Probe requires a fresh temporary DATA_DIR"

    from litellm import ModelResponse

    from app import llm
    from app.auth import get_auth_store
    from app.credits import account_balance
    from app.hosting import current_user_id, is_hosted
    from app.routers import career
    from app.schemas.career import MarketQuestion
    from app.services import career_ai

    assert is_hosted(), "Probe requires an isolated hosted account"
    store = get_auth_store()
    assert store.path.resolve().parent == root
    store.initialize()
    email = "market-probe@example.test"
    challenge, code = store.prepare(email, "synthetic-market-probe")
    store.delivery(challenge, True)
    user, _ = store.verify(email, challenge, code, None)
    identity = current_user_id.set(user["id"])
    database = career.db._database()
    assert database.db_path.resolve() == root / "users" / user["id"] / "workspace.sqlite"
    database._ensure_initialized()
    original_ask, original_complete = career_ai.ask_json, career_ai.complete_json
    router, _ = llm.get_router()
    original_completion, original_make_call = router.acompletion, router.make_call
    counts = dict.fromkeys(("ask_json", "complete_json", "router_calls", "provider_attempts"), 0)
    active_counts = dict(counts)
    active = None

    def count(name, per_case=3, total=6):
        if active_counts[name] >= per_case or counts[name] >= total:
            report("budget_exhausted", case=active["name"], counter=name,
                   case_limit=per_case, total_limit=total)
            raise RuntimeError("synthetic_probe_budget_exhausted")
        active_counts[name] += 1
        counts[name] += 1

    async def counted_complete(*args, **kwargs):
        count("complete_json")
        kwargs["retries"] = 0
        return await original_complete(*args, **kwargs)

    async def counted_completion(*args, **kwargs):
        count("router_calls")
        return await original_completion(*args, **kwargs)

    async def counted_make_call(*args, **kwargs):
        count("provider_attempts")
        if mock:
            return ModelResponse(choices=[{
                "message": {"role": "assistant", "content": json.dumps({
                    "advice": "先练习 SQL 查询和数据清洗，完成可复现的分析报告，再针对目标岗位整理作品并投递。当前样本的月薪与日薪需分别比较。",
                }, ensure_ascii=False)}, "finish_reason": "stop",
            }])
        return await original_make_call(*args, **kwargs)

    async def observed_ask(prompt, validator=None):
        count("ask_json", per_case=1, total=2)
        report("prompt", case=active["name"], sha256=hashlib.sha256(prompt.encode()).hexdigest())
        return await original_ask(prompt, validator)

    career_ai.ask_json, career_ai.complete_json = observed_ask, counted_complete
    router.acompletion, router.make_call = counted_completion, counted_make_call
    report("scope", mode="mock" if mock else "live", model=career_ai.model_info(),
           temporary_storage=True, max_provider_attempts_per_case=3,
           max_provider_attempts_total=6)
    failed = False
    try:
        assert await career.all_jobs() == []
        for active in selected:
            active_counts = dict.fromkeys(counts, 0)
            report("input", **active)
            started = time.monotonic()
            try:
                request = MarketQuestion.model_validate(active["request"])
                filters = request.model_dump(mode="json", exclude={"question", "use_ai"})
                value = await asyncio.wait_for(
                    career._analyze_market(request, jobs=active["jobs"]), timeout=120,
                )
                summary = value["summary"]
                assert value["mode"] == "ai" and value["advice"].strip()
                assert value["job_ids"] == summary["job_ids"] == active["expected_ids"]
                assert summary["count"] == len(active["expected_ids"])
                assert summary["filters"] == filters
                coverage = summary["coverage"]
                assert coverage["sample_count"] == active["expected_sample_count"]
                assert coverage["published_missing"] == active["expected_date_missing"]
                assert coverage["date_excluded_count"] == active["expected_date_excluded"]
                assert coverage["date_basis"] == "published_at"
                assert {item["period"] for item in summary["salaries"]} == {"day", "month"}
                assert {item["currency"] for item in summary["salaries"]} == {"CNY"}
                assert value["input_snapshot"]["jobs"] == active["jobs"]
                assert value["input_snapshot"]["filters"] == filters
                history = await career.get_market_history(value["history_id"])
                for field in ("summary", "job_ids", "advice", "input_snapshot", "input_hash"):
                    assert history[field] == value[field], f"History mismatch: {field}"
                assert active_counts["ask_json"] == 1
                assert 1 <= active_counts["provider_attempts"] <= 3
                report("result", case=active["name"], status="passed",
                       seconds=round(time.monotonic() - started, 2), calls=active_counts,
                       result=value)
            except Exception as error:
                failed = True
                report("result", case=active["name"], status="failed",
                       error_type=type(error).__name__, calls=active_counts,
                       seconds=round(time.monotonic() - started, 2))
        assert await career.all_jobs() == []
        report("overall", status="failed" if failed else "passed", **counts,
               synthetic_credits=account_balance(user["id"]))
    finally:
        career_ai.ask_json, career_ai.complete_json = original_ask, original_complete
        router.acompletion, router.make_call = original_completion, original_make_call
        await career.db.close()
        current_user_id.reset(identity)
    return int(failed)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Print synthetic inputs only")
    parser.add_argument("--mock", action="store_true", help="Use a local stub and block all network")
    parser.add_argument("--case", choices=[case["name"] for case in cases()])
    options = parser.parse_args()
    selected = [case for case in cases() if not options.case or case["name"] == options.case]
    if options.dry_run:
        for case in selected:
            report("input", **case)
    else:
        logging.disable(logging.CRITICAL)
        with tempfile.TemporaryDirectory(prefix="careerlens-market-probe-") as directory, ExitStack() as guards:
            os.environ["DATA_DIR"] = directory
            os.environ["CAREERLENS_MODE"] = "hosted"
            os.environ["CAREERLENS_AUTH_SECRET"] = secrets.token_urlsafe(32)
            os.environ["CAREERLENS_SIGNUP_CREDITS"] = "20"
            if options.mock:
                os.environ.update(LLM_PROVIDER="openai", LLM_MODEL="gpt-4o-mini",
                                  LLM_API_KEY="synthetic-not-a-provider-key")
                for target in ("socket.create_connection", "socket.socket.connect", "socket.socket.connect_ex"):
                    guards.enter_context(patch(target, side_effect=RuntimeError("mock_probe_network_blocked")))
            raise SystemExit(asyncio.run(probe(directory, selected, options.mock)))
