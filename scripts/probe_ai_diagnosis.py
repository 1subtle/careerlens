"""Exercise real diagnosis/directions with synthetic materials and temporary data.

Run in the hosted container: PYTHONPATH=/app/backend python /tmp/probe_ai_diagnosis.py
Optional CAREERLENS_PROBE_ONLY=match or directions selects one operation.
Uses the configured model (billed by the provider). No production accounts,
resumes, databases, email deliveries or saved matches are read or changed.
"""

import asyncio
import json
import logging
import os
import re
import tempfile
import time

logging.disable(logging.CRITICAL)


def report(event, **data):
    print(json.dumps({"event": event, **data}, ensure_ascii=False), flush=True)


async def probe():
    from pydantic import ValidationError

    from app.auth import get_auth_store
    from app.credits import credit_balance
    from app.hosting import current_user_id
    from app.services import career_ai, career_diagnosis

    store = get_auth_store()
    store.initialize()
    email = "diagnosis-probe@example.test"
    challenge, code = store.prepare(email, "synthetic-probe")
    store.delivery(challenge, True)
    user, _ = store.verify(email, challenge, code, None)
    identity = current_user_id.set(user["id"])
    real_complete = career_ai.complete_json
    call_count = 0

    async def observed_complete(prompt, **kwargs):
        nonlocal call_count
        call_count += 1
        call = call_count
        before = time.monotonic()
        validator = kwargs.get("response_validator")

        def observed_validate(value):
            try:
                return validator(value) if validator else value
            except ValueError as error:
                report("validation_failure", call=call,
                       error_type=type(error).__name__)
                raise

        kwargs["response_validator"] = observed_validate
        try:
            value = await real_complete(prompt, **kwargs)
            report("generation", call=call, status="passed",
                   seconds=round(time.monotonic() - before, 2))
            return value
        except Exception as error:
            report("generation", call=call, status="failed",
                   error_type=type(error).__name__,
                   seconds=round(time.monotonic() - before, 2))
            raise

    # Observe the service validators before ask_json sanitizes their exception.
    real_ask = career_ai.ask_json

    async def observed_ask(prompt, validator=None):
        def checked(value):
            try:
                return validator(value) if validator else value
            except ValidationError as error:
                report("schema_failure", fields=[
                    {"path": list(item["loc"]), "type": item["type"]}
                    for item in error.errors(include_input=False, include_url=False)
                ])
                raise
            except ValueError as error:
                # Only our synthetic materials enter these application validators.
                report("source_failure", reason=str(error)[:600])
                def inspect(node):
                    if isinstance(node, dict):
                        for key, item in node.items():
                            if key in {"detail", "summary", "reason"} and isinstance(item, str):
                                if re.search(r"独立|主导|牵头|领导|负责人", item):
                                    report("synthetic_role_context", text=item)
                            else:
                                inspect(item)
                    elif isinstance(node, list):
                        for item in node:
                            inspect(item)
                inspect(value)
                raise
        return await real_ask(prompt, checked)

    career_ai.complete_json = observed_complete
    career_ai.ask_json = observed_ask
    evidence = career_diagnosis.diagnosis_evidence({
        "summary": "信息管理专业本科生，参与用户访谈与反馈整理项目。",
        "education": [{"degree": "信息管理本科", "institution": "虚构示例大学"}],
        "personalProjects": [{"name": "校园服务调研", "description": [
            "访谈5名使用者，归纳反馈并整理问题清单。",
            "协助整理调研报告，尚未使用 SQL 分析数据。",
        ]}],
    })
    job = {"job_id": "synthetic-product-assistant", "title": "产品助理", "content":
           "工作职责：整理用户需求，协助撰写需求说明，跟进用户反馈。任职要求：本科，"
           "具备沟通与文档整理能力，了解 SQL。独立完成用户调研者优先。"}
    report("model", **career_ai.model_info())
    failed = False
    try:
        for name, operation, arguments in (
            ("match", career_diagnosis.analyze_match, (evidence, job)),
            ("directions", career_diagnosis.recommend_directions, (evidence, [job])),
        ):
            if os.environ.get("CAREERLENS_PROBE_ONLY", name) != name:
                continue
            before = time.monotonic()
            try:
                result = await asyncio.wait_for(operation(*arguments), timeout=150)
                assert result["fact_check"]["status"] == "sources_linked"
                report(name, status="passed", seconds=round(time.monotonic() - before, 2))
            except Exception as error:
                failed = True
                report(name, status="failed", error_type=type(error).__name__,
                       seconds=round(time.monotonic() - before, 2))
        report("overall", status="failed" if failed else "passed", generations=call_count,
               synthetic_credit_balance=credit_balance(user["id"])["balance"])
    finally:
        current_user_id.reset(identity)
        career_ai.complete_json = real_complete
        career_ai.ask_json = real_ask
    return int(failed)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="careerlens-diagnosis-probe-") as directory:
        os.environ["DATA_DIR"] = directory
        raise SystemExit(asyncio.run(probe()))
