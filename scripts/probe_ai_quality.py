"""Check live diagnosis quality using synthetic inputs in temporary storage.

Run inside the hosted container with PYTHONPATH=/app/backend. This uses the
configured model, with at most five generation requests, and never accesses
production accounts, resumes, credits, or payment APIs.
"""

import asyncio
import json
import logging
import os
import tempfile
import time
from pathlib import Path

logging.disable(logging.CRITICAL)


def report(event, **values):
    print(json.dumps({"event": event, **values}, ensure_ascii=False), flush=True)


async def probe(directory):
    from pydantic import ValidationError

    from app.auth import get_auth_store
    from app.config import settings
    from app.credits import account_balance
    from app.hosting import current_user_id
    from app.services import career_ai, career_diagnosis

    assert settings.data_dir.resolve() == Path(directory).resolve()
    store = get_auth_store()
    store.initialize()
    email = "ai-quality-probe@example.test"
    challenge, code = store.prepare(email, "synthetic-quality-probe")
    store.delivery(challenge, True)
    user, _ = store.verify(email, challenge, code, None)
    identity = current_user_id.set(user["id"])
    original_complete = career_ai.complete_json
    original_ask = career_ai.ask_json
    generations = 0

    async def observed_ask(prompt, validator=None):
        def checked(value):
            try:
                return validator(value) if validator else value
            except ValidationError as error:
                report("schema_failure", fields=error.errors(include_input=False, include_url=False))
                raise
            except ValueError as error:
                report("source_failure", reason=str(error)[:1000])
                raise

        return await original_ask(prompt, checked)

    async def counted_complete(*args, **kwargs):
        nonlocal generations
        if generations >= 5:
            raise RuntimeError("synthetic_generation_limit")
        generations += 1
        validate = kwargs.get("response_validator")

        def observed_validate(value):
            try:
                return validate(value) if validate else value
            except ValueError:
                # All model content in this probe comes from the synthetic inputs below.
                report("rejected_synthetic_output", generation=generations, result=value)
                raise

        kwargs["response_validator"] = observed_validate
        return await original_complete(*args, **kwargs)

    career_ai.complete_json = counted_complete
    career_ai.ask_json = observed_ask
    resume = {
        "summary": "信息管理专业应届本科生，参与用户访谈与反馈整理项目。",
        "education": [{"degree": "信息管理本科", "institution": "虚构示例大学"}],
        "personalProjects": [{"name": "校园服务调研", "description": [
            "访谈5名使用者，归纳反馈并整理问题清单。",
            "协助整理调研报告，尚未使用 SQL 分析数据。",
        ]}],
    }
    evidence = career_diagnosis.diagnosis_evidence(resume)
    related = {
        "job_id": "synthetic-product-assistant", "title": "产品助理",
        "content": "工作职责：整理用户需求，协助撰写需求说明，跟进用户反馈。任职要求："
        "本科，具备沟通与文档整理能力，了解 SQL。独立完成用户调研者优先。",
    }
    unrelated = {
        "job_id": "synthetic-senior-embedded", "title": "高级嵌入式软件工程师",
        "content": "负责车载控制器底层固件与设备驱动开发、实时系统性能优化。任职要求："
        "计算机或电子专业本科，五年以上嵌入式开发经验，精通 C/C++，熟悉 RTOS、"
        "ARM 芯片及 CAN 总线，具备量产故障排查经验。",
    }
    report("scope", model=career_ai.model_info(), synthetic_resume=resume,
           jobs=[related, unrelated], temporary_storage=True, max_generations=5)
    failed = False
    try:
        for name, operation, args in (
            ("related_match", career_diagnosis.analyze_match, (evidence, related)),
            ("unrelated_match", career_diagnosis.analyze_match, (evidence, unrelated)),
            ("rewrite", career_ai.rewrite, (
                {"id": "synthetic-project", "text": "访谈5名使用者，归纳反馈并整理问题清单；协助整理调研报告。"},
                [], [], True, related,
            )),
        ):
            selected = os.environ.get("CAREERLENS_PROBE_ONLY")
            if selected and selected != name:
                continue
            started = time.monotonic()
            try:
                value = await asyncio.wait_for(operation(*args), timeout=150)
                assert value["fact_check"]["status"] == "sources_linked"
                report(name, status="passed", seconds=round(time.monotonic() - started, 2),
                       result=value)
            except Exception as error:
                failed = True
                report(name, status="failed", error_type=type(error).__name__,
                       seconds=round(time.monotonic() - started, 2))
        report("overall", status="failed" if failed else "passed", generations=generations,
               synthetic_credits=account_balance(user["id"]))
    finally:
        career_ai.complete_json = original_complete
        career_ai.ask_json = original_ask
        current_user_id.reset(identity)
    return int(failed)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="careerlens-ai-quality-") as directory:
        os.environ["DATA_DIR"] = directory
        raise SystemExit(asyncio.run(probe(directory)))
