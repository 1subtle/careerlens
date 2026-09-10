"""Exercise real SQLite transactions through the CareerLens HTTP contracts."""

import asyncio
import json
from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.services import career_ai


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as value:
        yield value


async def seed(client: AsyncClient) -> tuple[dict, dict, dict]:
    response = await client.post("/api/v1/career/demo")
    assert response.status_code == 200, response.text
    data = response.json()
    resume, job = (
        data["resumes"][0],
        next(j for j in data["jobs"] if j["title"] == "数据分析实习生"),
    )
    response = await client.post(
        "/api/v1/career/matches",
        json={"resume_id": resume["id"], "job_id": job["job_id"]},
    )
    assert response.status_code == 200, response.text
    return resume, job, response.json()


async def test_atomic_apply_and_immutable_history(client: AsyncClient) -> None:
    resume, _job, match = await seed(client)
    assert match["score"] == 71.4
    response = await client.post(
        "/api/v1/career/rewrites",
        json={
            "match_id": match["id"],
            "section_id": match["evidence"][0]["id"],
            "facts": ["最终整理了 120 条记录。"],
        },
    )
    assert response.status_code == 200, response.text
    draft = response.json()
    results = await asyncio.gather(
        *(
            client.post(
                f"/api/v1/career/rewrites/{draft['id']}/apply", json={"confirmed": True}
            )
            for _ in range(2)
        )
    )
    assert all(r.status_code == 200 for r in results), [r.text for r in results]
    assert results[0].json()["resume"]["id"] == results[1].json()["resume"]["id"]
    current = (await client.get("/api/v1/career/state")).json()
    assert len(current["resumes"]) == 2
    assert (
        next(r for r in current["resumes"] if r["id"] == resume["id"])["data"]
        == resume["data"]
    )
    assert (await client.get(f"/api/v1/career/matches/{match['id']}")).json()[
        "resume_data"
    ] == resume["data"]


async def test_stale_review_and_delete_cascade(client: AsyncClient) -> None:
    resume, _job, match = await seed(client)
    draft = (
        await client.post(
            "/api/v1/career/rewrites",
            json={"match_id": match["id"], "section_id": match["evidence"][0]["id"]},
        )
    ).json()
    resume["data"]["summary"] = "已修改简介"
    saved = await client.put(
        f"/api/v1/career/resumes/{resume['id']}",
        json={
            "data": resume["data"],
            "title": resume["title"],
            "expected_hash": resume["hash"],
        },
    )
    assert saved.status_code == 200
    assert (await client.get(f"/api/v1/career/matches/{match['id']}")).json()[
        "stale"
    ] is True
    assert (
        await client.post(
            f"/api/v1/career/rewrites/{draft['id']}/apply", json={"confirmed": True}
        )
    ).status_code == 409
    assert (
        await client.post(
            f"/api/v1/career/matches/{match['id']}/review",
            json={
                "requirement_id": match["details"][0]["id"],
                "status": "supported",
                "evidence_ids": ["fabricated"],
            },
        )
    ).status_code == 422
    assert (
        await client.delete(f"/api/v1/career/resumes/{resume['id']}")
    ).status_code == 200
    assert (
        await client.get(f"/api/v1/career/matches/{match['id']}")
    ).status_code == 404


async def test_demo_idempotency_market_and_invalid_job(client: AsyncClient) -> None:
    await seed(client)
    state = (await client.post("/api/v1/career/demo")).json()
    assert len(state["jobs"]) == 12
    assert len(state["resumes"]) == 1
    assert (await client.post("/api/v1/career/market/summary", json={})).json()[
        "count"
    ] == 0
    summary = (
        await client.post("/api/v1/career/market/summary", json={"include_demo": True})
    ).json()
    assert summary["count"] == 12
    assert summary["salary_missing"] == 1
    response = await client.post(
        "/api/v1/career/jobs",
        json={
            "title": "岗位",
            "text": "SQL",
            "requirements": [
                {
                    "id": "1",
                    "name": "Python",
                    "source_text": "Python",
                    "priority": "required",
                }
            ],
        },
    )
    assert response.status_code == 422


async def test_review_creates_record_and_retains_old_judgment(
    client: AsyncClient,
) -> None:
    _, _, match = await seed(client)
    pending = next(item for item in match["details"] if item["status"] == "pending")
    result = await client.post(
        f"/api/v1/career/matches/{match['id']}/review",
        json={"requirement_id": pending["id"], "status": "gap", "evidence_ids": []},
    )
    assert result.status_code == 200
    assert result.json()["id"] != match["id"]
    old = (await client.get(f"/api/v1/career/matches/{match['id']}")).json()
    assert (
        next(item for item in old["details"] if item["id"] == pending["id"])["status"]
        == "pending"
    )


async def test_invalid_source_keeps_material_and_rejects_unknown_reference(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    resume, _, match = await seed(client)
    monkeypatch.setattr(
        career_ai,
        "model_info",
        lambda: {"configured": True, "model": "contract-test", "provider": "mock"},
    )

    async def fabricated(*args, **kwargs):
        text = "使用 Tableau 提升 90% 的业务收入。"
        return kwargs["response_validator"](
            {
                "draft": text,
                "claims": [{"text": text, "source_ids": ["unknown-source"]}],
                "reason": "虚构的模型输出",
            }
        )

    monkeypatch.setattr(career_ai, "complete_json", fabricated)
    response = await client.post(
        "/api/v1/career/rewrites",
        json={
            "match_id": match["id"],
            "section_id": match["evidence"][0]["id"],
            "use_ai": True,
        },
    )
    assert response.status_code == 502
    old = (await client.get(f"/api/v1/career/matches/{match['id']}")).json()
    assert old["rewrites"] == []
    assert old["resume_data"] == resume["data"]


async def test_job_change_and_rejected_draft_cannot_apply(client: AsyncClient) -> None:
    _, job, match = await seed(client)
    draft = (
        await client.post(
            "/api/v1/career/rewrites",
            json={"match_id": match["id"], "section_id": match["evidence"][0]["id"]},
        )
    ).json()
    await client.put(
        f"/api/v1/career/jobs/{job['job_id']}",
        json={
            "expected_version": job["version"],
            "title": "修改后的岗位",
            "text": "Java 与 SQL",
            "company": job["company"],
        },
    )
    assert (
        await client.post(
            f"/api/v1/career/rewrites/{draft['id']}/apply", json={"confirmed": True}
        )
    ).status_code == 409
    assert (
        await client.post(f"/api/v1/career/rewrites/{draft['id']}/reject", json={})
    ).status_code == 200
    assert (
        await client.post(
            f"/api/v1/career/rewrites/{draft['id']}/apply", json={"confirmed": True}
        )
    ).status_code == 409


async def test_ai_market_preserves_explicit_filters_and_generates_once(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    await seed(client)
    jobs = (await client.get("/api/v1/career/state")).json()["jobs"]
    expected_ids = {
        job["job_id"] for job in jobs
        if job["category"] == "产品设计" and job["city"] == "上海"
    }
    prompts = []

    async def advice(prompt):
        prompts.append(json.loads(prompt))
        return {"advice": "完成一个用户研究项目，并整理访谈和原型产出。", "city": "北京"}

    monkeypatch.setattr(career_ai, "ask_json", advice)
    response = await client.post(
        "/api/v1/career/market/analyze",
        json={
            "use_ai": True,
            "include_demo": True,
            "category": "产品设计",
            "city": "上海",
            "question": "只分析北京的数据岗位，并比较最近的招聘趋势",
        },
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert len(prompts) == 1 and result["mode"] == "ai"
    assert result["summary"]["filters"] == {
        "category": "产品设计", "city": "上海", "since": None, "include_demo": True,
    }
    assert set(result["summary"]["job_ids"]) == set(result["job_ids"]) == expected_ids
    assert prompts[0]["统计"] == result["summary"]
    assert result["input_snapshot"]["filters"] == result["summary"]["filters"]
    assert {job["job_id"] for job in result["input_snapshot"]["jobs"]} == {
        job["job_id"] for job in jobs
    }
    history = (await client.get(
        f"/api/v1/career/market/history/{result['history_id']}"
    )).json()
    assert history["input_snapshot"] == result["input_snapshot"]
    assert history["summary"] == result["summary"]


async def test_empty_market_stays_rules_without_calling_ai(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    await seed(client)

    async def forbidden(*args, **kwargs):
        raise AssertionError("An empty sample must not call AI")

    monkeypatch.setattr(career_ai, "ask_json", forbidden)
    response = await client.post(
        "/api/v1/career/market/analyze",
        json={"use_ai": True, "include_demo": True, "since": "2026-09-01"},
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["mode"] == "rules" and result["summary"]["count"] == 0
    assert result["summary"]["coverage"]["date_excluded_count"] == 12
    assert "没有可统计的岗位" in result["advice"]


async def test_source_only_edit_roundtrip_and_conflict(client: AsyncClient) -> None:
    resume, _, match = await seed(client)
    original = resume["source_text"]
    body = {
        "title": resume["title"],
        "data": resume["data"],
        "source_text": "修订后的原文",
        "expected_hash": resume["hash"],
    }
    response = await client.put(f"/api/v1/career/resumes/{resume['id']}", json=body)
    assert response.status_code == 200
    assert response.json()["source_text"] == "修订后的原文"
    assert response.json()["hash"] != resume["hash"]
    assert (
        await client.put(f"/api/v1/career/resumes/{resume['id']}", json=body)
    ).status_code == 409
    state = (await client.get("/api/v1/career/state")).json()
    assert state["resumes"][0]["source_text"] != original
    assert (await client.get(f"/api/v1/career/matches/{match['id']}")).json()[
        "resume_data"
    ] == resume["data"]
    # Omitting the source field preserves it; explicitly clearing it is supported.
    body.pop("source_text")
    body["expected_hash"] = response.json()["hash"]
    assert (
        await client.put(f"/api/v1/career/resumes/{resume['id']}", json=body)
    ).json()["source_text"] == "修订后的原文"


async def test_layout_revision_blocks_old_window_without_invalidating_evidence(
    client: AsyncClient,
) -> None:
    resume, _, match = await seed(client)
    url = f"/api/v1/career/resumes/{resume['id']}"
    body = {
        "title": resume["title"],
        "data": resume["data"],
        "source_text": resume["source_text"],
        "expected_hash": resume["hash"],
        "expected_revision": resume["revision"],
        "template_settings": {"margins": {"top": 18}},
    }
    response = await client.put(url, json=body)
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["hash"] == resume["hash"]
    assert saved["revision"] != resume["revision"]
    assert (await client.get(f"/api/v1/career/matches/{match['id']}")).json()[
        "stale"
    ] is False

    # An older window still has a matching content hash but stale layout settings.
    stale_body = {
        **body,
        "data": {**resume["data"], "summary": "旧窗口尚未保存的编辑"},
        "template_settings": None,
    }
    for revision in (resume["revision"], ""):
        stale_body["expected_revision"] = revision
        response = await client.put(url, json=stale_body)
        assert response.status_code == 409, response.text
    state = (await client.get("/api/v1/career/state")).json()
    actual = next(r for r in state["resumes"] if r["id"] == resume["id"])
    assert actual["data"] == saved["data"]
    assert actual["template_settings"] == saved["template_settings"]
    assert actual["revision"] == saved["revision"]

    # New clients use revision; expected_hash remains a legacy-client fallback.
    response = await client.put(
        url,
        json={
            **body,
            "expected_revision": saved["revision"],
            "expected_hash": "obsolete-content-hash",
            "template_settings": {"margins": {"top": 20}},
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["hash"] == resume["hash"]
    assert response.json()["revision"] != saved["revision"]


async def test_file_ai_switch_and_failure_preserves_extracted_text(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.routers import career

    text = "林同学\n教育背景\n示例大学 本科\n项目经历\n问卷研究项目\n设计问卷收集用户反馈。"
    monkeypatch.setattr(career_ai, "model_info", lambda: {"configured": True})

    async def parsed(source):
        assert source == text
        return {"personalInfo": {"name": "AI 识别姓名"}}

    monkeypatch.setattr(career, "parse_resume_to_json", parsed)
    response = await client.post(
        "/api/v1/career/resumes/file",
        files={"file": ("简历.txt", text.encode(), "text/plain")},
        data={"use_ai": "true"},
    )
    assert response.status_code == 200
    assert response.json()["mode"] == "ai"
    assert response.json()["data"]["personalInfo"]["name"] == "AI 识别姓名"

    async def failed(source):
        raise RuntimeError("provider secret must not be exposed")

    monkeypatch.setattr(career, "parse_resume_to_json", failed)
    response = await client.post(
        "/api/v1/career/resumes/file",
        files={"file": ("简历.txt", text.encode(), "text/plain")},
        data={"use_ai": "true"},
    )
    assert response.json()["source_text"] == text
    assert response.json()["mode"] == "rules"
    assert response.json()["warning"] and "secret" not in response.text


async def test_compare_reuses_snapshot_and_validates_entire_batch(
    client: AsyncClient,
) -> None:
    resume, _, _ = await seed(client)
    state = (await client.get("/api/v1/career/state")).json()
    ids = [j["job_id"] for j in state["jobs"][:5]]
    response = await client.post(
        "/api/v1/career/matches/compare",
        json={"resume_id": resume["id"], "job_ids": ids},
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert len(result["matches"]) == 5
    assert {m["snapshot_id"] for m in result["matches"]} == {result["snapshot_id"]}
    assert {m["resume_hash"] for m in result["matches"]} == {result["resume_hash"]}
    assert [m["job_id"] for m in result["matches"]] == ids
    for invalid in [ids[:1], [ids[0], ids[0]], ids + [state["jobs"][5]["job_id"]]]:
        assert (
            await client.post(
                "/api/v1/career/matches/compare",
                json={"resume_id": resume["id"], "job_ids": invalid},
            )
        ).status_code == 422
    before = len((await client.get("/api/v1/career/state")).json()["matches"])
    assert (
        await client.post(
            "/api/v1/career/matches/compare",
            json={"resume_id": resume["id"], "job_ids": [ids[0], "missing"]},
        )
    ).status_code == 404
    assert len((await client.get("/api/v1/career/state")).json()["matches"]) == before


async def test_semantic_candidates_do_not_assign_scores_and_fallback(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.services import semantic

    resume, job, initial = await seed(client)
    monkeypatch.setattr(
        semantic,
        "retrieve",
        lambda reqs, evidence: [
            [{"evidence_id": evidence[0]["id"], "similarity": 0.91}] for _ in reqs
        ],
    )
    body = {"resume_id": resume["id"], "job_id": job["job_id"], "use_semantic": True}
    response = (await client.post("/api/v1/career/matches", json=body)).json()
    assert response["score"] == initial["score"]
    pending = next(d for d in response["details"] if d["status"] == "pending")
    assert pending["candidates"] and pending["value"] == 0
    async_review = await client.post(
        f"/api/v1/career/matches/{response['id']}/review",
        json={
            "requirement_id": pending["id"],
            "status": "supported",
            "evidence_ids": [pending["candidates"][0]["evidence_id"]],
        },
    )
    assert async_review.json()["score"] > initial["score"]

    def unavailable(*args):
        raise FileNotFoundError()

    monkeypatch.setattr(semantic, "retrieve", unavailable)
    fallback = (await client.post("/api/v1/career/matches", json=body)).json()
    assert fallback["score"] == initial["score"]
    assert fallback["retrieval"]["mode"] == "unavailable"


async def test_condition_confirmation_persists_without_rewriting_history(
    client: AsyncClient,
) -> None:
    _, _, match = await seed(client)
    response = await client.post(
        f"/api/v1/career/matches/{match['id']}/conditions",
        json={
            "name": "到岗与实习时长",
            "status": "met",
            "observed": "每周可到岗 4 天，连续实习 6 个月。",
        },
    )
    assert response.status_code == 200
    saved = (await client.get(f"/api/v1/career/matches/{response.json()['id']}")).json()
    assert saved["conditions"][-1]["confirmed_by"] == "user"
    assert saved["conditions"][-1]["status"] == "met"
    assert saved["score"] == match["score"]
    old = (await client.get(f"/api/v1/career/matches/{match['id']}")).json()
    assert old["conditions"][-1]["status"] == "unknown"


async def test_suggestions_are_saved_without_independent_truth_review(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, match = await seed(client)
    evidence = match["evidence"][0]
    checked = []

    async def fake(prompt, validator=None):
        if "独立核验" in prompt:
            checked.append(True)
            value = {
                "verdicts": [
                    {"index": 0, "supported": False, "reason": "原文没有说明该用途"}
                ]
            }
        else:
            text = "整理数据，形成用户需求洞察。"
            value = {
                "draft": text,
                "claims": [{"text": text, "source_ids": [evidence["id"]]}],
                "reason": "定向润色",
                "star": [
                    {"stage": "S", "evidence": "", "question": "这项工作对应什么实际问题？", "source_ids": []},
                    {"stage": "T", "evidence": "", "question": "你被分配了哪些具体任务？", "source_ids": []},
                    {"stage": "A", "evidence": evidence["text"], "question": "", "source_ids": [evidence["id"]]},
                    {"stage": "R", "evidence": "", "question": "这项工作实际交付了什么？", "source_ids": []},
                ],
                "keyword_suggestions": [{"keyword": "SQL", "suggestion": "如果实际使用过 SQL，可补充具体查询任务。"}],
                "quantification_suggestions": ["这项工作处理了多少条记录？"],
            }
        return validator(value) if validator else value

    monkeypatch.setattr(career_ai, "ask_json", fake)
    response = await client.post(
        "/api/v1/career/rewrites",
        json={"match_id": match["id"], "section_id": evidence["id"], "use_ai": True},
    )
    assert response.status_code == 200, response.text
    assert checked == []
    assert len((await client.get(f"/api/v1/career/matches/{match['id']}")).json()[
        "rewrites"
    ]) == 1
