"""Compare live rewrite prompts using four synthetic cases and temporary storage.

Run in the hosted container with PYTHONPATH=/app/backend. --baseline uses the
pre-change prompt with the same rewrite service and validators. --dry-run prints
the inputs without importing the app or calling a provider. Each invocation is
limited to six complete_json calls and eight router/provider attempts, including
router retries. Provider usage is billed; production accounts/data are untouched.
"""

import argparse
import asyncio
import hashlib
import json
import logging
import os
import tempfile
import time
from pathlib import Path

RELATED = {
    "title": "产品助理",
    "content": "整理用户需求，协助撰写需求说明，跟进用户反馈；要求本科，具备沟通与文档整理能力，了解 SQL。",
}
UNRELATED = {
    "title": "高级嵌入式软件工程师",
    "content": "负责车载控制器底层固件与驱动开发；要求五年以上嵌入式经验，精通 C/C++，熟悉 RTOS、ARM 和 CAN 总线。",
}
CASES = [
    {
        "name": "vague_zh", "text": "做过校园活动，帮忙整理反馈，也写了报告。",
        "facts": [], "job": RELATED,
        "review": "直接给出更清楚的中文经历，突出已有行动与产出；不添加未知数字、工具和负责范围。",
    },
    {
        "name": "with_facts", "text": "做过校园活动，帮忙整理反馈，也写了报告。",
        "facts": [
            "访谈了5名报名者。",
            "按报名、签到和场地三个环节归纳反馈，形成问题清单，并协助整理调研报告。",
        ],
        "job": RELATED,
        "review": "自然纳入5名报名者、三个环节、问题清单与协助报告；补充内容的claim关联fact来源。",
    },
    {
        "name": "unrelated_jd",
        "text": "访谈5名使用者，归纳反馈并整理问题清单；协助整理调研报告。",
        "facts": [], "job": UNRELATED,
        "review": "保留调研与协助角色；不把候选人改写为嵌入式开发者，不添加JD中的技术经历。",
    },
    {
        "name": "already_clear",
        "text": "访谈5名使用者，归纳反馈并整理问题清单；协助整理调研报告。",
        "facts": [], "job": RELATED,
        "review": "保留清晰事实；若没有实质改善，improvement标记unchanged，避免仅换词却宣称明显提升。",
    },
]


def report(event, **values):
    print(json.dumps({"event": event, **values}, ensure_ascii=False), flush=True)


def baseline_prompt(case):
    """Snapshot of career_ai.rewrite's prompt before upstream prompt integration."""
    return json.dumps({
        "任务": "结合目标岗位与用户提供的材料，润色这段经历。优先明确行动、方法和成果，合并重复表达，突出岗位相关内容，并融入用户补充的信息。直接给出可供编辑采纳的完整建议稿；reason简述表达调整与岗位关联。可选的后续补充建议放在missing_facts，不作为生成前提。每个claim为draft中的连续段落，按序拼接覆盖完整draft；source_ids使用给定来源ID，用于定位参考材料。",
        "sources": [{"id": "synthetic-project", "text": case["text"], "type": "resume"}]
        + [{"id": f"fact:{i}", "text": value, "type": "user"}
           for i, value in enumerate(case["facts"])],
        "岗位要求": [],
        "目标JD": case["job"],
        "输出结构": {
            "draft": "改写正文",
            "claims": [{"text": "正文中的一句", "source_ids": ["synthetic-project"]}],
            "missing_facts": ["可选的补充建议"], "reason": "与目标岗位的关联",
        },
    }, ensure_ascii=False)


async def probe(directory, cases, baseline):
    from pydantic import ValidationError

    from app import llm
    from app.auth import get_auth_store
    from app.config import settings
    from app.credits import account_balance
    from app.hosting import current_user_id
    from app.services import career_ai

    assert settings.data_dir.resolve() == Path(directory).resolve()
    store = get_auth_store()
    store.initialize()
    email = "rewrite-probe@example.test"
    challenge, code = store.prepare(email, "synthetic-rewrite-probe")
    store.delivery(challenge, True)
    user, _ = store.verify(email, challenge, code, None)
    identity = current_user_id.set(user["id"])
    original_ask, original_complete = career_ai.ask_json, career_ai.complete_json
    router, _ = llm.get_router()
    original_completion, original_make_call = router.acompletion, router.make_call
    counts = {"complete_json": 0, "router_calls": 0, "provider_attempts": 0}
    active = None

    def count(name, limit):
        if counts[name] >= limit:
            report("budget_exhausted", counter=name, limit=limit)
            raise RuntimeError("synthetic_probe_budget_exhausted")
        counts[name] += 1

    async def counted_complete(*args, **kwargs):
        count("complete_json", 6)
        kwargs["retries"] = 0
        return await original_complete(*args, **kwargs)

    async def counted_completion(*args, **kwargs):
        count("router_calls", 8)
        return await original_completion(*args, **kwargs)

    async def counted_make_call(*args, **kwargs):
        count("provider_attempts", 8)
        return await original_make_call(*args, **kwargs)

    async def observed_ask(prompt, validator=None):
        selected = baseline_prompt(active) if baseline else prompt
        report("prompt", case=active["name"],
               sha256=hashlib.sha256(selected.encode()).hexdigest())

        def checked(value):
            try:
                return validator(value) if validator else value
            except ValidationError as error:
                report("schema_failure", case=active["name"],
                       fields=error.errors(include_input=False, include_url=False))
                raise
            except ValueError as error:
                report("source_failure", case=active["name"], reason=str(error)[:1000])
                raise

        return await original_ask(selected, checked)

    career_ai.complete_json, career_ai.ask_json = counted_complete, observed_ask
    router.acompletion, router.make_call = counted_completion, counted_make_call
    report("scope", mode="baseline" if baseline else "current", model=career_ai.model_info(),
           temporary_storage=True, max_generations=6, max_provider_attempts=8)
    failed = False
    try:
        for active in cases:
            report("input", **active)
            started = time.monotonic()
            before = dict(counts)
            try:
                value = await asyncio.wait_for(career_ai.rewrite(
                    {"id": "synthetic-project", "text": active["text"]},
                    list(active["facts"]), [], True, dict(active["job"]),
                ), timeout=150)
                career_ai.validate_draft(value, value["sources"])
                report("result", case=active["name"], status="passed",
                       seconds=round(time.monotonic() - started, 2), result=value,
                       calls={key: counts[key] - before[key] for key in counts})
            except Exception as error:
                failed = True
                report("result", case=active["name"], status="failed",
                       error_type=type(error).__name__,
                       seconds=round(time.monotonic() - started, 2))
        report("overall", status="failed" if failed else "passed", **counts,
               synthetic_credits=account_balance(user["id"]))
    finally:
        career_ai.ask_json, career_ai.complete_json = original_ask, original_complete
        router.acompletion, router.make_call = original_completion, original_make_call
        current_user_id.reset(identity)
    return int(failed)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", action="store_true", help="Use the pre-change prompt")
    parser.add_argument("--dry-run", action="store_true", help="Print synthetic inputs only")
    parser.add_argument("--case", choices=[case["name"] for case in CASES])
    options = parser.parse_args()
    chosen = [case for case in CASES if not options.case or case["name"] == options.case]
    if options.dry_run:
        for case in chosen:
            report("input", mode="baseline" if options.baseline else "current", **case)
    else:
        logging.disable(logging.CRITICAL)
        with tempfile.TemporaryDirectory(prefix="careerlens-rewrite-probe-") as directory:
            os.environ["DATA_DIR"] = directory
            raise SystemExit(asyncio.run(probe(directory, chosen, options.baseline)))
