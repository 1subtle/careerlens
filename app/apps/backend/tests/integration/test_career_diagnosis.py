"""AI suggestion structure, source links and persistence against isolated SQLite."""

import asyncio
import copy
import json

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.services import career_ai, career_diagnosis
from app.services.matching import requirements_from_text

RESUME_TEXT = "访谈5名使用者，归纳反馈并整理问题清单。"
JD_TEXT = "工作职责：整理用户需求。任职要求：SQL，本科。"


@pytest.fixture
async def client():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client



@pytest.fixture
async def materials(client):
    resume = await client.post(
        "/api/v1/career/resumes",
        json={
            "title": "虚构测试简历",
            "data": {
                "personalInfo": {
                    "name": "不应发送的姓名",
                    "email": "private@example.test",
                    "phone": "123456789",
                },
                "personalProjects": [
                    {"name": "用户访谈", "description": [RESUME_TEXT]}
                ],
                "education": [{"degree": "信息管理本科", "institution": "测试学校"}],
                "additional": {"languages": ["英语CET-6"], "awards": ["校级奖学金"]},
                "customSections": {
                    "volunteer": {"sectionType": "text", "text": "整理志愿者活动记录。"}
                },
            },
        },
    )
    assert resume.status_code == 200, resume.text
    job = await client.post(
        "/api/v1/career/jobs",
        json={
            "title": "产品助理",
            "company": "已保存的测试公司",
            "text": JD_TEXT,
            "source_url": "https://example.test/real-saved-job",
            "source_type": "manual",
        },
    )
    assert job.status_code == 200, job.text
    return resume.json(), job.json()



@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setattr(
        career_ai,
        "model_info",
        lambda: {"configured": True, "provider": "mock", "model": "contract-model"},
    )



def assessment():
    refs = [{"evidence_id": "personalProjects:0:0", "quote": RESUME_TEXT}]
    jd_refs = [{"quote": "整理用户需求"}]
    return {
        "requirement_matches": [{
            "requirement_id": r["id"], "status": "missing", "reason": "简历尚未体现 SQL 应用。",
            "resume_refs": [], "suggestion": "在项目经历中补充实际使用 SQL 的查询任务。",
        } for r in requirements_from_text(JD_TEXT)],
        "fit_score": 55,
        "summary": "有访谈与反馈整理经验，可迁移至需求整理；当前材料未提供 SQL 应用证据。",
        "strengths": [
            {
                "title": "反馈整理",
                "detail": "问题清单表明有整理反馈的实践，可作为需求整理的相关经验。",
                "resume_refs": refs,
                "jd_refs": jd_refs,
            }
        ],
        "gaps": [
            {
                "title": "SQL应用证据",
                "detail": "当前材料未提供 SQL 应用证据，不能判断掌握程度。",
                "resume_refs": [],
                "jd_refs": [{"quote": "SQL"}],
            }
        ],
        "actions": [
            {
                "title": "前置已知交付",
                "detail": "将已完成的问题清单与访谈过程按行动和交付组织。",
                "action_type": "expression",
                "resume_refs": refs,
                "jd_refs": jd_refs,
            }
        ],
    }



def directions(job_id=None):
    return {
        "summary": "可以先探索用户研究与产品支持方向。",
        "directions": [
            {
                "title": "产品助理",
                "reason": "已有用户访谈和问题整理的经历，可探索需求整理职责。",
                "resume_refs": [
                    {"evidence_id": "personalProjects:0:0", "quote": RESUME_TEXT}
                ],
                "next_steps": ["先确认是否实际撰写过需求说明，再决定是否补充到简历。"],
            }
        ],
        "saved_jobs": []
        if job_id is None
        else [
            {
                "job_id": job_id,
                "reason": "访谈问题清单与该 JD 的需求整理职责相关。",
                "resume_refs": [
                    {"evidence_id": "personalProjects:0:0", "quote": RESUME_TEXT}
                ],
                "jd_refs": [{"quote": "整理用户需求"}],
            }
        ],
    }



def source_review(prompt):
    material = json.loads(prompt.split("材料：", 1)[1])
    return {
        "valid": True,
        "issues": [],
        "checks": [
            {"path": path, "source_quotes": quotes}
            for path, quotes in material["required_checks"].items()
        ],
    }



def install_llm(monkeypatch, answer):
    calls = []

    async def complete(prompt, **kwargs):
        calls.append(prompt)
        value = (
            source_review(prompt)
            if prompt.startswith("独立核验 CareerLens")
            else copy.deepcopy(answer)
        )
        return kwargs["response_validator"](value)

    monkeypatch.setattr(career_ai, "complete_json", complete)
    return calls



async def test_ai_match_calls_configured_llm_separates_rule_score_and_preserves_history(
    client, materials, configured, monkeypatch
):
    resume, job = materials
    calls = install_llm(monkeypatch, assessment())
    result = await client.post(
        "/api/v1/career/matches",
        json={"resume_id": resume["id"], "job_id": job["job_id"], "use_ai": True},
    )
    assert result.status_code == 200, result.text
    match = result.json()
    assert len(calls) == 1
    assert match["score"] == 0
    assert match["ai_analysis"]["fit_score"] == 55
    assert match["ai_analysis"]["provider"] == "mock"
    assert match["ai_analysis"]["model"] == "contract-model"
    assert match["ai_analysis"]["analyzed_at"]
    assert "_ai_analysis" not in match["job"]
    assert any(
        e["text"] == "信息管理本科" and e["kind"] == "background"
        for e in match["evidence"]
    )
    for text in ("信息管理本科", "英语CET-6", "校级奖学金", "整理志愿者活动记录。"):
        assert text in calls[0]
    for private in ("private@example.test", "123456789", "不应发送的姓名"):
        assert private not in calls[0]
    stored = (await client.get(f"/api/v1/career/matches/{match['id']}")).json()
    assert stored["ai_analysis"] == match["ai_analysis"]
    assert stored["stale"] is False
    review = await client.post(
        f"/api/v1/career/matches/{match['id']}/review",
        json={
            "requirement_id": match["details"][0]["id"],
            "status": "gap",
            "evidence_ids": [],
        },
    )
    assert review.status_code == 200, review.text
    assert review.json()["ai_analysis"] == match["ai_analysis"]
    condition = await client.post(
        f"/api/v1/career/matches/{match['id']}/conditions",
        json={"name": "学历要求", "status": "met", "observed": "已确认本科"},
    )
    assert condition.status_code == 200, condition.text
    assert condition.json()["ai_analysis"] == match["ai_analysis"]



async def test_rule_mode_never_calls_llm(client, materials, configured, monkeypatch):
    calls = install_llm(monkeypatch, assessment())
    resume, job = materials
    result = await client.post(
        "/api/v1/career/matches",
        json={"resume_id": resume["id"], "job_id": job["job_id"], "use_ai": False},
    )
    assert result.status_code == 200
    assert result.json()["ai_analysis"] is None
    assert calls == []



@pytest.mark.parametrize(
    "exception,status",
    [(RuntimeError("private credential should not leak"), 502), (TimeoutError(), 504)],
)
async def test_ai_failure_is_explicit_and_does_not_save_fake_result(
    client, materials, configured, monkeypatch, exception, status
):
    async def fail(*args, **kwargs):
        raise exception

    monkeypatch.setattr(career_ai, "complete_json", fail)
    resume, job = materials
    result = await client.post(
        "/api/v1/career/matches",
        json={"resume_id": resume["id"], "job_id": job["job_id"], "use_ai": True},
    )
    assert result.status_code == status
    assert "private credential" not in result.text
    assert (await client.get("/api/v1/career/state")).json()["matches"] == []



async def test_missing_configuration_does_not_fall_back_to_rules(
    client, materials, monkeypatch
):
    monkeypatch.setattr(career_ai, "model_info", lambda: {"configured": False})
    resume, job = materials
    result = await client.post(
        "/api/v1/career/matches",
        json={"resume_id": resume["id"], "job_id": job["job_id"], "use_ai": True},
    )
    assert result.status_code == 422



async def test_directions_require_no_selected_jd_and_bind_only_saved_job_metadata(
    client, materials, configured, monkeypatch
):
    resume, job = materials
    calls = install_llm(monkeypatch, directions(job["job_id"]))
    result = await client.post(
        "/api/v1/career/directions", json={"resume_id": resume["id"]}
    )
    assert result.status_code == 200, result.text
    value = result.json()
    assert len(calls) == 1
    assert value["resume_id"] == resume["id"]
    assert value["resume_hash"] == resume["hash"]
    assert value["saved_jobs"][0]["company"] == job["company"]
    assert value["saved_jobs"][0]["source_url"] == job["source_url"]
    assert "source_url" not in value["directions"][0]
    assert "不是" not in value["directions"][0]["title"]
    assert (await client.get("/api/v1/career/state")).json()["matches"] == []
    assert (
        await client.post(
            "/api/v1/career/directions",
            json={"resume_id": resume["id"], "use_ai": False},
        )
    ).status_code == 422
    await client.delete(f"/api/v1/career/jobs/{job['job_id']}")
    install_llm(monkeypatch, directions())
    no_jobs = await client.post(
        "/api/v1/career/directions", json={"resume_id": resume["id"]}
    )
    assert no_jobs.status_code == 200
    assert no_jobs.json()["saved_jobs"] == []



@pytest.mark.parametrize(
    "corruption", ["invented_id", "company_field"]
)
async def test_directions_reject_invented_recruitment_sources(
    client, materials, configured, monkeypatch, corruption
):
    resume, job = materials
    answer = directions(job["job_id"])
    if corruption == "invented_id":
        answer["saved_jobs"][0]["job_id"] = "fictional-company-job"
    else:
        answer["directions"][0]["company"] = "虚构公司"
    install_llm(monkeypatch, answer)
    result = await client.post(
        "/api/v1/career/directions", json={"resume_id": resume["id"]}
    )
    assert result.status_code == 502



async def test_ai_comparison_bounds_concurrency_and_keeps_one_resume_snapshot(
    client, materials, configured, monkeypatch
):
    resume, job = materials
    jobs = [job]
    for index in range(4):
        created = await client.post(
            "/api/v1/career/jobs",
            json={"title": f"候选{index}", "company": f"公司{index}", "text": JD_TEXT},
        )
        jobs.append(created.json())
    active = maximum = calls = 0

    async def complete(prompt, **kwargs):
        nonlocal active, maximum, calls
        calls += 1
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(0.01)
        active -= 1
        return kwargs["response_validator"](
            source_review(prompt)
            if prompt.startswith("独立核验 CareerLens")
            else assessment()
        )

    monkeypatch.setattr(career_ai, "complete_json", complete)
    result = await client.post(
        "/api/v1/career/matches/compare",
        json={
            "resume_id": resume["id"],
            "job_ids": [j["job_id"] for j in jobs],
            "use_ai": True,
        },
    )
    assert result.status_code == 200, result.text
    assert calls == 5
    assert maximum == 3
    assert len({m["snapshot_id"] for m in result.json()["matches"]}) == 1



def test_ai_background_does_not_create_editable_or_rule_evidence():
    data = {
        "education": [{"degree": "本科"}],
        "personalInfo": {"name": "隐藏", "email": "hidden@test"},
    }
    result = career_diagnosis.diagnosis_evidence(data)
    assert len(result) == 1
    assert result[0]["kind"] == "background"
    assert result[0]["text"] == "本科"



async def test_failed_comparison_cancels_remaining_model_requests(
    client, materials, configured, monkeypatch
):
    resume, first = materials
    second = (
        await client.post(
            "/api/v1/career/jobs",
            json={"title": "第二岗位", "company": "另一测试公司", "text": JD_TEXT},
        )
    ).json()
    started = asyncio.Event()
    cancelled = False

    async def analyze(evidence, job):
        nonlocal cancelled
        if job["job_id"] == first["job_id"]:
            await started.wait()
            raise RuntimeError("provider unavailable")
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled = True
            raise

    monkeypatch.setattr(career_diagnosis, "analyze_match", analyze)
    result = await client.post(
        "/api/v1/career/matches/compare",
        json={
            "resume_id": resume["id"],
            "job_ids": [first["job_id"], second["job_id"]],
            "use_ai": True,
        },
    )
    assert result.status_code == 502
    assert cancelled
    assert (await client.get("/api/v1/career/state")).json()["matches"] == []


@pytest.mark.parametrize("operation", ["match", "directions"])
async def test_suggestions_use_one_generation_and_locate_paraphrased_references(
    client, materials, configured, monkeypatch, operation
):
    resume, job = materials
    answer = assessment() if operation == "match" else directions(job["job_id"])
    advice = "突出独立完成的调研工作和3项成果，说明报告如何用于服务优化。"
    if operation == "match":
        answer["actions"][0]["detail"] = advice
        answer["actions"][0]["action_type"] = "verify_fact"
        groups = ("strengths", "gaps", "actions")
        endpoint = "/api/v1/career/matches"
        request = {"resume_id": resume["id"], "job_id": job["job_id"], "use_ai": True}
    else:
        answer["directions"][0]["reason"] = advice
        groups = ("directions", "saved_jobs")
        endpoint = "/api/v1/career/directions"
        request = {"resume_id": resume["id"]}
    for group in groups:
        for item in answer[group]:
            for ref in item["resume_refs"]:
                ref["quote"] = "访谈用户并汇总反馈"
            for ref in item.get("jd_refs", []):
                ref["quote"] = "整理需求并应用SQL"
    calls = install_llm(monkeypatch, answer)
    response = await client.post(endpoint, json=request)
    assert response.status_code == 200, response.text
    result = response.json()["ai_analysis"] if operation == "match" else response.json()
    assert len(calls) == 1
    assert result["fact_check"]["status"] == "sources_linked"
    assert result["fact_check"]["method"] == "structure+source_locations"
    for group in groups:
        for item in result[group]:
            assert all(ref["quote"] in RESUME_TEXT for ref in item["resume_refs"])
            assert all(ref["quote"] in JD_TEXT for ref in item.get("jd_refs", []))
    if operation == "match":
        assert result["actions"][0]["detail"] == advice
        assert result["actions"][0]["title"].startswith("补充建议")
    else:
        assert result["directions"][0]["reason"] == advice
        assert result["saved_jobs"][0]["source_url"] == job["source_url"]
    for instruction in ("独立核验", "先核实事实", "不得补造", "编造"):
        assert instruction not in calls[0]


@pytest.mark.parametrize("context", ["job", "requirements", "none"])
async def test_rewrite_uses_upstream_strategy_and_candidate_facts(
    configured, monkeypatch, context
):
    from app.prompts.templates import DIFF_STRATEGY_INSTRUCTIONS

    original = "参与用户调研，整理反馈。"
    fact = "访谈 5 名使用者，用 Excel 归纳 12 条反馈。"
    draft = "参与用户调研，访谈 5 名使用者，用 Excel 归纳 12 条反馈。"
    calls = install_llm(monkeypatch, {
        "draft": draft,
        "claims": [{"text": draft, "source_ids": ["e1", "fact:0"]}],
        "missing_facts": [],
        "reason": "明确调研行动与反馈产出。",
        "star": [
            {"stage": "S", "evidence": "", "question": "调研针对什么实际问题？", "source_ids": []},
            {"stage": "T", "evidence": "用户调研", "question": "", "source_ids": ["e1"]},
            {"stage": "A", "evidence": "访谈 5 名使用者", "question": "", "source_ids": ["fact:0"]},
            {"stage": "R", "evidence": "12 条反馈", "question": "", "source_ids": ["fact:0"]},
        ],
    })
    strategy = "nudge" if context == "none" else "keywords"
    requirements = [{"name": "用户调研", "source_text": "整理用户需求"}] if context == "requirements" else []
    # Ensure the visible rewrite path consumes the shared upstream strategy.
    monkeypatch.setitem(DIFF_STRATEGY_INSTRUCTIONS, strategy, "shared-upstream-strategy")
    result = await career_ai.rewrite(
        {"id": "e1", "text": original}, [fact], requirements, True,
        {"title": "产品助理", "content": JD_TEXT} if context == "job" else None,
    )
    assert len(calls) == 1
    prompt = json.loads(calls[0])
    assert prompt["改写策略"] == "shared-upstream-strategy"
    assert prompt["sources"] == result["sources"] == [
        {"id": "e1", "text": original, "type": "resume"},
        {"id": "fact:0", "text": fact, "type": "user"},
    ]
    assert prompt["目标JD"] == (
        {"title": "产品助理", "content": JD_TEXT} if context == "job" else None
    )
    assert [item["name"] for item in prompt["岗位要求"]] == [item["name"] for item in requirements]
    assert result["draft"] == draft
    assert result["changes"][0]["type"] == "user_fact"
    assert [item["stage"] for item in result["star"]] == list("STAR")
    assert result["star"][2]["source_ids"] == ["fact:0"]


@pytest.mark.parametrize("group,status", [("strengths", 200), ("actions", 200), ("gaps", 502)])
async def test_unrelated_strengths_and_actions_do_not_require_fabricated_jd_links(
    client, materials, configured, monkeypatch, group, status
):
    answer = assessment()
    answer[group][0]["jd_refs"] = []
    calls = install_llm(monkeypatch, answer)
    resume, job = materials
    response = await client.post(
        "/api/v1/career/matches",
        json={"resume_id": resume["id"], "job_id": job["job_id"], "use_ai": True},
    )
    assert response.status_code == status, response.text
    if status == 200:
        assert len(calls) == 1
        assert response.json()["ai_analysis"][group][0]["jd_refs"] == []
    else:
        assert (await client.get("/api/v1/career/state")).json()["matches"] == []


async def test_unknown_resume_source_id_still_rejects_without_saving(
    client, materials, configured, monkeypatch
):
    answer = assessment()
    answer["strengths"][0]["resume_refs"][0]["evidence_id"] = "unknown-source"
    calls = install_llm(monkeypatch, answer)
    resume, job = materials
    response = await client.post(
        "/api/v1/career/matches",
        json={"resume_id": resume["id"], "job_id": job["job_id"], "use_ai": True},
    )
    assert response.status_code in (422, 502), response.text
    assert len(calls) == 2
    assert (await client.get("/api/v1/career/state")).json()["matches"] == []


@pytest.mark.parametrize("changed", [True, False])
async def test_rewrite_returns_linked_suggestion_without_secondary_review(
    configured, monkeypatch, changed
):
    original = "参与调研，整理问题清单。"
    draft = "主导3项Python分析，为服务优化提供依据。" if changed else original
    calls = install_llm(
        monkeypatch,
        {
            "draft": draft,
            "claims": [{"text": draft, "source_ids": ["e1"]}],
            "missing_facts": [],
            "reason": "调整经历表达和岗位重点。",
            "star": [
                {"stage": "S", "evidence": "", "question": "调研针对什么实际问题？", "source_ids": []},
                {"stage": "T", "evidence": "", "question": "你承担哪一部分调研任务？", "source_ids": []},
                {"stage": "A", "evidence": "参与调研", "question": "", "source_ids": ["e1"]},
                {"stage": "R", "evidence": "问题清单", "question": "", "source_ids": ["e1"]},
            ],
        },
    )
    if not changed:
        with pytest.raises(career_ai.CareerAIOutputError, match="正文仍与原文一致"):
            await career_ai.rewrite({"id": "e1", "text": original}, [], [], True, {"content": JD_TEXT})
        assert len(calls) == 2
        return
    result = await career_ai.rewrite(
        {"id": "e1", "text": original}, [], [], True, {"content": JD_TEXT}
    )
    assert result["draft"] == draft
    assert len(calls) == 1
    assert result["fact_check"] == {
        "status": "sources_linked",
        "method": "structure+source_locations",
    }
    assert result["improvement"]["retried"] is False
    assert result["improvement"]["status"] == ("improved" if changed else "unchanged")
    assert result["sources"] == [{"id": "e1", "text": original, "type": "resume"}]
    assert json.loads(calls[0])["目标JD"]["content"] == JD_TEXT
    for instruction in ("独立核验", "先核实事实", "不得补造", "编造"):
        assert instruction not in calls[0]


@pytest.mark.parametrize('corruption', ['omitted', 'unknown_id', 'no_source', 'no_suggestion'])
async def test_requirement_mapping_rejects_incomplete_or_unlinked_results(
    client, materials, configured, monkeypatch, corruption
):
    answer = assessment()
    item = answer['requirement_matches'][0]
    if corruption == 'omitted':
        answer['requirement_matches'] = []
    elif corruption == 'unknown_id':
        item['requirement_id'] = 'not-in-this-jd'
    elif corruption == 'no_source':
        item['status'] = 'partial'
    else:
        item['suggestion'] = ''
    install_llm(monkeypatch, answer)
    resume, job = materials
    result = await client.post('/api/v1/career/matches', json={
        'resume_id': resume['id'], 'job_id': job['job_id'], 'use_ai': True,
    })
    assert result.status_code == 502
    assert (await client.get('/api/v1/career/state')).json()['matches'] == []


async def test_requirement_mapping_links_transferable_experience_without_keyword_overlap(
    client, materials, configured, monkeypatch
):
    resume, _ = materials
    job = (await client.post('/api/v1/career/jobs', json={
        'title': '产品调研实习生', 'text': '需求调研与功能设计',
        'requirements': [{'id': 'transferable', 'name': '需求调研与功能设计',
                          'source_text': '需求调研与功能设计', 'priority': 'required'}],
    })).json()
    answer = assessment()
    answer['requirement_matches'] = [{
        'requirement_id': 'transferable', 'status': 'partial',
        'reason': '访谈与反馈归纳对应需求调研，功能设计尚未体现。',
        'resume_refs': [{'evidence_id': 'personalProjects:0:0', 'quote': RESUME_TEXT}],
        'suggestion': '在用户访谈项目中补充是否参与功能方案，以及实际输出的文档。',
    }]
    install_llm(monkeypatch, answer)
    result = await client.post('/api/v1/career/matches', json={
        'resume_id': resume['id'], 'job_id': job['job_id'], 'use_ai': True,
    })
    assert result.status_code == 200, result.text
    saved = (await client.get('/api/v1/career/matches/' + result.json()['id'])).json()
    assert saved['ai_analysis']['requirement_matches'] == answer['requirement_matches']
    assert saved['score'] == 0
