"""Hosted smoke: synthetic email identities, credits, a real rewrite and exports.

Run inside the deployed container with its normal environment and data mount:
  PYTHONPATH=/app/backend:/tmp/careerlens-qa-deps python /tmp/qa_hosted.py
Optional CAREERLENS_QA_BASE changes the loopback API URL (includes /api/v1).
Runtime dependencies: the backend, requests and pypdf. No SMTP mail is sent.

One rewrite uses the operator's configured DeepSeek API, normally one generation.
CAREERLENS_QA_DIAGNOSIS=1 also exercises one AI match and one direction analysis.
Failed provider retries can still incur provider costs; no real payment is made.
Artifacts remain under /tmp/careerlens-qa/<run-id>. Only this run's synthetic
identities, auth records, credit accounts and tenant directories are removed.
"""

import io
import json
import logging
import os
import re
import shutil
import sqlite3
import sys
import time
import uuid
import zipfile
from contextlib import closing
from pathlib import Path
from urllib.parse import urlsplit
from xml.etree import ElementTree

logging.disable(logging.CRITICAL)

import requests
from pypdf import PdfReader

from app.auth import get_auth_store
from app.config import settings
from app.hosting import get_hosting_settings
from app.migrations import status as migration_status
from app.schemas.career import ResumeInput
from app.services.career_ai import validate_draft

BASE = os.environ.get("CAREERLENS_QA_BASE", "http://127.0.0.1:3000/api/v1").rstrip("/")
RESUME = {
    "personalInfo": {
        "name": "部署验收同学",
        "title": "产品助理",
        "email": "synthetic@example.test",
        "location": "上海",
    },
    "summary": "信息管理专业本科生，参与用户访谈与反馈整理项目。",
    "education": [{
        "institution": "虚构示例大学",
        "degree": "信息管理本科",
        "years": "2022–2026",
        "description": "完成数据分析与用户研究课程。",
    }],
    "personalProjects": [{
        "name": "校园服务用户调研",
        "role": "项目成员",
        "years": "2025",
        "description": [
            "我在这个项目中是项目成员，我做了用户访谈。我一共访谈了5名使用者。"
            "访谈之后，我把他们说的反馈进行了归纳，然后把问题整理成了一份问题清单。",
            "使用Excel整理20条问卷反馈，提交一份调研报告。",
        ],
    }],
    "additional": {"technicalSkills": ["Excel", "用户访谈", "需求整理"]},
}
JOB = {
    "title": "合成测试岗位：产品助理",
    "company": "虚构示例机构",
    "text": "参与用户访谈，归纳反馈，整理问题清单；使用Excel整理问卷反馈，提交调研报告。",
    "category": "产品",
    "source_type": "synthetic",
    "use_ai": False,
}


def main() -> int:
    started = time.monotonic()
    started_at = time.time()
    options = get_hosting_settings()
    store = None
    run_id = uuid.uuid4().hex
    emails = [f"deployment-check-{run_id}-{label}@example.test" for label in "ab"]
    planned = []
    clients = []
    results = []
    step = "preflight"
    failed = False
    output = Path("/tmp/careerlens-qa") / run_id

    def report(name, **metrics):
        event = {"check": name, **metrics}
        results.append(event)
        print(json.dumps(event), flush=True)

    def check(condition, name, **metrics):
        if not condition:
            raise AssertionError(name)
        report(name, status="passed", **metrics)

    def request(client, method, path, expected=(200,), **kwargs):
        before = time.monotonic()
        response = client.request(
            method, BASE + path, timeout=(10, 210), allow_redirects=False, **kwargs
        )
        report(step, http_status=response.status_code,
               seconds=round(time.monotonic() - before, 2))
        if response.status_code not in expected:
            raise AssertionError("unexpected_http_status")
        return response

    def verify_email(client, email):
        challenge, code = store.prepare(email, f"deployment-check-{run_id}")
        store.delivery(challenge, True)
        response = request(client, "POST", "/auth/email/verify", json={
            "email": email, "challenge_id": challenge, "code": code,
        })
        token = response.cookies.get(options.cookie_name)
        check(bool(token) and "HttpOnly" in response.headers.get("set-cookie", "")
              and (not options.secure_cookie or "Secure" in response.headers["set-cookie"]),
              "verified_session_cookie")
        # The secure public cookie must be forwarded explicitly to container HTTP.
        client.headers["Cookie"] = f"{options.cookie_name}={token}"
        return response.json()["user"]

    def credits(client):
        value = request(client, "GET", "/auth/credits").json()
        check(type(value.get("balance")) is int and value["balance"] >= 0
              and value.get("cost_per_generation") == 1, "credits_contract")
        return value

    def reset_synthetic_resend(email):
        # Touch only this run's synthetic address; no SMTP or waiting.
        if email not in planned:
            raise AssertionError("unexpected_synthetic_email")
        with store.connect() as connection:
            connection.execute("DELETE FROM send_events WHERE email = ? AND created_at >= ?",
                               (email, started_at))

    def private_export(value):
        if isinstance(value, dict):
            return not set(value).intersection({
                "api_keys", "ciphertext", "token_hash", "code_hash", "processing_token", "claim_token",
            }) and all(private_export(item) for item in value.values())
        if isinstance(value, list):
            return all(private_export(item) for item in value)
        return True

    try:
        address = urlsplit(BASE)
        check(address.scheme in {"http", "https"}
              and address.hostname in {"127.0.0.1", "localhost", "::1"}
              and not address.username and not address.password
              and not address.query and not address.fragment, "loopback_api_only")
        check(options.hosted and bool(options.public_origin)
              and (settings.data_dir / "auth.sqlite").is_file(), "hosted_preflight")
        store = get_auth_store()
        schema = migration_status(settings.data_dir / "auth.sqlite", "auth")
        check(schema["version"] == schema["latest"] and schema["pending"] == 0,
              "auth_schema_current", version=schema["version"])
        output.mkdir(mode=0o700, parents=True, exist_ok=False)
        report("artifacts", directory=str(output))
        with store.connect() as connection:
            check(not connection.execute(
                "SELECT 1 FROM users WHERE email IN (?, ?)", emails
            ).fetchone(), "identities_are_new")

        users = []
        for email in emails:
            planned.append(email)
            client = requests.Session()
            client.trust_env = False
            client.headers["Origin"] = options.public_origin
            clients.append(client)
            step = "synthetic_email_verification"
            user = verify_email(client, email)
            users.append(user)
            session = request(client, "GET", "/auth/session").json()
            check(session.get("user") == user, "session_identity")
            account = credits(client)
            check(account["balance"] == account["signup_grant"]
                  == options.signup_credits and user.get("credits") == account["balance"]
                  and account["balance"] >= 4, "signup_credit_grant",
                  balance=account["balance"])

        a, b = clients
        initial_balance = credits(a)["balance"]
        step = "anonymous_account_boundary"
        with requests.Session() as anonymous:
            anonymous.trust_env = False
            anonymous.headers["Origin"] = options.public_origin
            for method, path in (("GET", "/profile"), ("PATCH", "/profile"),
                                 ("GET", "/sessions"), ("DELETE", "/sessions/" + "a" * 32),
                                 ("POST", "/sessions/revoke-others"), ("GET", "/export")):
                request(anonymous, method, "/account" + path, expected=(401,))
        check(True, "anonymous_account_routes_rejected")

        step = "account_profile_preferences"
        original_profile = request(a, "GET", "/account/profile").json()
        other_profile = request(b, "GET", "/account/profile").json()
        check(original_profile["id"] == users[0]["id"]
              and original_profile["email"] == emails[0]
              and original_profile["created_at"] >= started_at, "account_profile_identity")
        preferences = {"display_name": "部署验收用户", "ui_language": "en",
                       "content_language": "en", "timezone": "Europe/London"}
        changed = request(a, "PATCH", "/account/profile", json=preferences).json()
        check(changed == {**original_profile, **preferences}
              and request(a, "GET", "/account/profile").json() == changed,
              "account_preferences_persist_on_reload")
        request(a, "PATCH", "/account/profile", json={"id": users[1]["id"]}, expected=(422,))
        check(request(a, "GET", "/account/profile").json() == changed
              and request(b, "GET", "/account/profile").json() == other_profile,
              "account_preferences_isolated_and_identity_immutable")

        step = "account_session_controls"
        second = requests.Session()
        second.trust_env = False
        second.headers["Origin"] = options.public_origin
        clients.append(second)
        reset_synthetic_resend(emails[0])
        check(verify_email(second, emails[0])["id"] == users[0]["id"],
              "second_session_same_account")
        check(request(second, "GET", "/account/profile").json() == changed,
              "account_preferences_persist_on_new_login")
        sessions_response = request(a, "GET", "/account/sessions")
        sessions = sessions_response.json()["items"]
        with store.connect() as connection:
            hashes = [row[0] for row in connection.execute(
                "SELECT token_hash FROM sessions WHERE user_id=?", (users[0]["id"],)
            )]
        check(len(sessions) == 2 and sum(item["current"] is True for item in sessions) == 1
              and all(re.fullmatch(r"[0-9a-f]{32}", item["id"])
                      and started_at <= item["created_at"] < item["expires_at"] for item in sessions)
              and "token_hash" not in sessions_response.text
              and all(value not in sessions_response.text for value in hashes),
              "session_ids_are_opaque_and_tokens_private", sessions=len(sessions))
        other_login = next(item for item in sessions if not item["current"])
        request(b, "DELETE", f"/account/sessions/{other_login['id']}", expected=(404,))
        revoked = request(a, "POST", "/account/sessions/revoke-others").json()
        check(revoked.get("revoked") == 1, "other_session_revoked")
        request(second, "GET", "/account/profile", expected=(401,))
        check(request(a, "GET", "/account/profile").json() == changed
              and request(b, "GET", "/account/profile").json() == other_profile
              and len(request(a, "GET", "/account/sessions").json()["items"]) == 1,
              "revocation_preserves_current_and_other_account_sessions")
        check(request(a, "PATCH", "/account/profile", json={
            "ui_language": "zh", "content_language": "zh", "timezone": "Asia/Shanghai",
        }).json()["content_language"] == "zh", "synthetic_profile_restored_to_chinese")

        step = "create_chinese_resume"
        payload = ResumeInput(title=f"部署验收-{run_id}", data=RESUME).model_dump(mode="json")
        resume = request(a, "POST", "/career/resumes", json=payload).json()
        resume_id = str(uuid.UUID(resume["id"]))
        step = "owner_state"
        owner = request(a, "GET", "/career/state").json()
        check(any(row["id"] == resume_id for row in owner["resumes"]), "owner_sees_resume")
        model = owner["model"]
        check(model.get("configured") is True and model.get("provider") == "deepseek"
              and bool(model.get("model")), "deepseek_configured")
        step = "create_synthetic_job"
        job = request(a, "POST", "/career/jobs", json=JOB).json()
        step = "rules_match"
        match = request(a, "POST", "/career/matches", json={
            "resume_id": resume_id, "job_id": job["job_id"],
            "use_ai": False, "use_semantic": False,
        }).json()
        evidence = next(item for item in match["evidence"] if item.get("path")
                        == ["personalProjects", 0, "description", 0])
        check(credits(a)["balance"] == initial_balance, "non_ai_actions_are_free")

        step = "other_user_isolation"
        other = request(b, "GET", "/career/state").json()
        check(not other["resumes"] and not other["jobs"] and not other["matches"],
              "tenant_isolation", resumes=0, jobs=0, matches=0)
        request(b, "GET", f"/career/matches/{match['id']}", expected=(403, 404))
        request(b, "GET", "/resumes", params={"resume_id": resume_id}, expected=(404,))
        request(b, "GET", f"/jobs/{job['job_id']}", expected=(404,))
        request(b, "PUT", f"/career/resumes/{resume_id}", json=payload, expected=(404,))
        request(b, "POST", "/career/matches", json={
            "resume_id": resume_id, "job_id": job["job_id"],
            "use_ai": False, "use_semantic": False,
        }, expected=(404,))
        for path in (f"/career/resumes/{resume_id}", f"/resumes/{resume_id}",
                     f"/career/jobs/{job['job_id']}"):
            request(b, "DELETE", path, expected=(404,))
        request(a, "GET", "/config", expected=(403,))
        request(a, "POST", "/config/reset", expected=(403,))
        unchanged = request(a, "GET", "/career/state").json()
        check(next(row for row in unchanged["resumes"] if row["id"] == resume_id)["data"]
              == resume["data"] and any(row["job_id"] == job["job_id"]
                                        for row in unchanged["jobs"]),
              "cross_account_writes_rejected_and_owner_data_unchanged")
        workspace_paths = [settings.data_dir / "users" / str(uuid.UUID(user["id"]))
                           / "workspace.sqlite" for user in users]
        check(all(path.is_file() for path in workspace_paths)
              and not workspace_paths[0].samefile(workspace_paths[1]),
              "distinct_physical_workspace_databases")
        for index, path in enumerate(workspace_paths):
            schema = migration_status(path, "business")
            check(schema["version"] == schema["latest"] and schema["pending"] == 0,
                  "workspace_schema_current", version=schema["version"])
            with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as connection:
                connection.execute("PRAGMA query_only=ON")
                check(connection.execute("PRAGMA quick_check").fetchall() == [("ok",)],
                      "synthetic_workspace_integrity")
                counts = [connection.execute(sql, (value,)).fetchone()[0] for sql, value in (
                    ("SELECT COUNT(*) FROM resumes WHERE resume_id=?", resume_id),
                    ("SELECT COUNT(*) FROM jobs WHERE job_id=?", job["job_id"]),
                    ("SELECT COUNT(*) FROM match_records WHERE id=?", match["id"]),
                )]
                check(counts == ([1, 1, 1] if index == 0 else [0, 0, 0]),
                      "synthetic_records_exist_only_in_owner_database")
        step = "account_data_export"
        exported_response = request(a, "GET", "/account/export")
        exported = exported_response.json()
        export_workspace = exported["workspace"]
        check(exported_response.headers.get("content-type", "").startswith("application/json")
              and exported_response.headers.get("content-disposition", "").startswith("attachment;")
              and exported_response.headers.get("cache-control") == "no-store"
              and exported["profile"]["id"] == users[0]["id"]
              and {row["resume_id"] for row in export_workspace["resumes"]} == {resume_id}
              and {row["job_id"] for row in export_workspace["jobs"]} == {job["job_id"]}
              and all(isinstance(rows, list) for rows in export_workspace.values())
              and private_export(exported), "account_export_is_owned_json_without_internal_secrets",
              tables=len(export_workspace), records=sum(len(rows) for rows in export_workspace.values()))
        other_export = request(b, "GET", "/account/export").json()
        check(other_export["profile"]["id"] == users[1]["id"]
              and all(not rows for rows in other_export["workspace"].values())
              and private_export(other_export), "account_export_cannot_read_other_workspace")
        for suffix in ("docx", "pdf"):
            request(b, "GET", f"/resumes/{resume_id}/{suffix}", expected=(403, 404))

        step = "real_ai_rewrite"
        ai = request(a, "POST", "/career/rewrites", json={
            "match_id": match["id"], "section_id": evidence["id"],
            "facts": [], "use_ai": True,
        }).json()
        check(ai.get("mode") == "ai" and ai.get("status") == "draft"
              and ai.get("model") == model and bool(ai.get("analyzed_at"))
              and ai.get("section_id") == evidence["id"], "ai_rewrite_metadata")
        validate_draft(ai, ai["sources"])
        check(ai["fact_check"].get("status") == "sources_linked",
              "ai_source_locations_valid", claims=len(ai["claims"]))
        check(bool(ai["draft"]), "ai_resume_suggestion_present")
        expected_cost = 1
        remaining = credits(a)["balance"]
        check(initial_balance - remaining == expected_cost, "successful_generations_debit",
              before=initial_balance, after=remaining, charged=expected_cost)
        check(credits(b)["balance"] == initial_balance, "other_account_balance_unchanged")

        step = "apply_ai_rewrite"
        request(b, "POST", f"/career/rewrites/{ai['id']}/apply",
                json={"confirmed": True}, expected=(403, 404))
        applied = request(a, "POST", f"/career/rewrites/{ai['id']}/apply",
                          json={"confirmed": True}).json()
        result = applied["resume"]
        result_id = str(uuid.UUID(result["id"]))
        check(result_id != resume_id and result.get("parent_id") == resume_id
              and result["data"]["personalProjects"][0]["description"][0] == ai["draft"],
              "rewrite_saved_as_new_resume")
        replay = request(a, "POST", f"/career/rewrites/{ai['id']}/apply",
                         json={"confirmed": True}).json()
        check(replay["resume"]["id"] == result_id, "apply_is_idempotent")
        state = request(a, "GET", "/career/state").json()
        check(next(row for row in state["resumes"] if row["id"] == resume_id)["data"]
              == resume["data"], "original_resume_unchanged")

        step = "owner_docx"
        docx = request(a, "GET", f"/resumes/{result_id}/docx", params={"lang": "zh"})
        check(docx.headers.get("content-type", "").startswith(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ), "word_content_type")
        with zipfile.ZipFile(io.BytesIO(docx.content)) as archive:
            document = ElementTree.fromstring(archive.read("word/document.xml"))
            namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
            word_text = "".join(item.text or "" for item in document.iter(namespace + "t"))
            check("部署验收同学" in word_text
                  and "".join(ai["draft"].split()) in "".join(word_text.split())
                  and not list(document.iter(namespace + "altChunk")),
                  "native_word_contains_rewrite", text_characters=len(word_text), bytes=len(docx.content))
        (output / "resume-polished.docx").write_bytes(docx.content)

        step = "owner_pdf"
        pdf = request(a, "GET", f"/resumes/{result_id}/pdf", params={"lang": "zh"})
        check(pdf.headers.get("content-type", "").startswith("application/pdf")
              and pdf.content.startswith(b"%PDF-"), "pdf_content_type")
        pages = PdfReader(io.BytesIO(pdf.content)).pages
        page_texts = [page.extract_text() or "" for page in pages]
        pdf_text = "".join("".join(page_texts).split())
        check(len(pages) > 0 and all(text.strip() for text in page_texts)
              and "部署验收同学" in pdf_text and "".join(ai["draft"].split()) in pdf_text,
              "pdf_chinese_contains_rewrite", pages=len(pages),
              text_characters=len(pdf_text), bytes=len(pdf.content))
        (output / "resume-polished.pdf").write_bytes(pdf.content)
        for suffix in ("docx", "pdf"):
            request(b, "GET", f"/resumes/{result_id}/{suffix}", expected=(403, 404))
        check(credits(a)["balance"] == remaining, "apply_and_exports_are_free")

        step = "repeat_email_login"
        reset_synthetic_resend(emails[0])
        repeated_user = verify_email(a, emails[0])
        check(repeated_user["id"] == users[0]["id"]
              and repeated_user.get("credits") == remaining
              and credits(a)["balance"] == remaining, "login_does_not_repeat_signup_grant")
        if os.environ.get("CAREERLENS_QA_DIAGNOSIS") == "1":
            step = "real_ai_match"
            diagnosis = request(a, "POST", "/career/matches", json={
                "resume_id": resume_id, "job_id": job["job_id"],
                "use_ai": True, "use_semantic": False,
            }).json()
            check(diagnosis["ai_analysis"]["fact_check"]["status"] == "sources_linked",
                  "ai_match_sources_linked")
            saved = request(a, "GET", f"/career/matches/{diagnosis['id']}").json()
            check(saved["ai_analysis"] == diagnosis["ai_analysis"], "ai_match_persisted")
            request(b, "GET", f"/career/matches/{diagnosis['id']}", expected=(403, 404))
            step = "real_ai_directions"
            directions = request(a, "POST", "/career/directions", json={
                "resume_id": resume_id, "use_ai": True,
            }).json()
            check(directions["fact_check"]["status"] == "sources_linked"
                  and bool(directions["directions"]), "ai_directions_sources_linked")
            check(credits(b)["balance"] == initial_balance,
                  "diagnosis_other_account_balance_unchanged")
            (output / "diagnosis.json").write_text(
                json.dumps({"match": diagnosis, "directions": directions}, ensure_ascii=False),
                encoding="utf-8",
            )
        step = "version_and_history_contracts"
        versioned = request(a, "POST", "/career/jobs", json={
            "title": "Synthetic version check", "company": run_id, "text": "SQL Python",
        }).json()
        version_path = f"/career/jobs/{versioned['job_id']}"
        updated = request(a, "PUT", version_path, json={
            "title": "Updated synthetic JD", "text": "SQL Python",
            "expected_version": versioned["version"],
        }).json()
        check(updated["version"] == versioned["version"] + 1, "jd_version_increments")
        request(a, "PUT", version_path, expected=(409,), json={
            "title": "Stale editor", "text": "SQL", "expected_version": versioned["version"],
        })
        check(request(a, "GET", version_path).json()["title"] == updated["title"], "stale_jd_does_not_overwrite")
        request(b, "GET", version_path, expected=(404,))
        market = request(a, "POST", "/career/market/analyze", json={"question": "查看 SQL 岗位", "use_ai": False}).json()
        market_path = f"/career/market/history/{market['history_id']}"
        saved_market = request(a, "GET", market_path).json()
        request(b, "GET", market_path, expected=(404,))
        request(a, "DELETE", version_path)
        check(request(a, "GET", market_path).json() == saved_market, "market_history_survives_deleted_jd")
        if os.environ.get("CAREERLENS_QA_DIAGNOSIS") == "1":
            direction_path = f"/career/directions/history/{directions['history_id']}"
            saved_direction = request(a, "GET", direction_path).json()
            request(b, "GET", direction_path, expected=(404,))
            request(a, "DELETE", f"/career/resumes/{resume_id}")
            check(request(a, "GET", direction_path).json() == saved_direction, "direction_history_survives_deleted_resume")
        summary = request(a, "GET", "/billing/summary").json()
        check(summary["reserved"] == 0, "no_unsettled_credit_reservations")
        ledger = request(a, "GET", "/billing/ledger").json()["items"]
        check(sum(item["kind"] == "spend" for item in ledger) == (3 if os.environ.get("CAREERLENS_QA_DIAGNOSIS") == "1" else 1), "each_generation_has_ledger_entry")
        check(not request(b, "GET", "/billing/orders").json()["items"], "other_account_orders_private")
        (output / "rewrite.json").write_text(
            json.dumps(ai, ensure_ascii=False, indent=2), encoding="utf-8")
    except BaseException as error:
        failed = True
        report(step, status="failed", error_type=type(error).__name__)
    finally:
        for client in clients:
            client.close()
        try:
            removed_users = []
            removed_credits = 0
            removed_preferences = 0
            for email in planned:
                with store.connect() as connection:
                    row = connection.execute(
                        "SELECT id FROM users WHERE email = ? AND created_at >= ?", (email, started_at)
                    ).fetchone()
                    if row:
                        user_id = str(uuid.UUID(row["id"]))
                        for table in ("credit_ledger", "credit_generations", "credit_operations", "payment_orders"):
                            connection.execute(f"DELETE FROM {table} WHERE user_id = ?", (user_id,))
                        if connection.execute(
                            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='credit_accounts'"
                        ).fetchone():
                            removed_credits += connection.execute(
                                "DELETE FROM credit_accounts WHERE user_id = ?", (user_id,)
                            ).rowcount
                        connection.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
                        if connection.execute(
                            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_preferences'"
                        ).fetchone():
                            removed_preferences += connection.execute(
                                "DELETE FROM account_preferences WHERE user_id = ?", (user_id,)
                            ).rowcount
                        connection.execute("DELETE FROM users WHERE id = ? AND email = ?", (user_id, email))
                        removed_users.append(user_id)
                    connection.execute("DELETE FROM challenges WHERE email = ? AND created_at >= ?",
                                       (email, started_at))
                    connection.execute("DELETE FROM send_events WHERE email = ? AND created_at >= ?",
                                       (email, started_at))
            users_root = (settings.data_dir / "users").resolve()
            removed_directories = 0
            for user_id in removed_users:
                directory = users_root / user_id
                if directory.exists():
                    if directory.is_symlink() or directory.resolve().parent != users_root:
                        raise AssertionError("unexpected_tenant_directory")
                    shutil.rmtree(directory)
                    removed_directories += 1
            report("cleanup", status="passed", users=len(removed_users),
                   credit_accounts=removed_credits, preferences=removed_preferences,
                   directories=removed_directories)
        except Exception as error:
            failed = True
            report("cleanup", status="failed", error_type=type(error).__name__)
        report("overall", status="failed" if failed else "passed", checks=len(results),
               seconds=round(time.monotonic() - started, 2))
        if output.exists():
            (output / "summary.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    return int(failed)


if __name__ == "__main__":
    os.umask(0o077)
    sys.exit(main())
