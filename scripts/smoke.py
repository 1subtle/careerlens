"""Run an isolated HTTP workflow against a running local CareerLens service.

Creates clearly fictional temporary rows and removes only those rows on exit.
PDFs and the result report are retained in the chosen artifact directory.
"""

import argparse
import copy
import json
import time
import urllib.request
from pathlib import Path
from typing import Any
from uuid import uuid4


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--artifacts", default=".local/qa")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    output = Path(args.artifacts)
    output.mkdir(parents=True, exist_ok=True)
    base = args.base_url.rstrip("/") + "/api/v1"

    def request(method: str, path: str, data: Any = None) -> Any:
        body = json.dumps(data, ensure_ascii=False).encode() if data is not None else None
        req = urllib.request.Request(base + path, data=body, method=method, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=130) as response:
            content = response.read()
            return content if "application/pdf" in response.headers.get("Content-Type", "") else json.loads(content)

    resumes: list[str] = []
    jobs: list[str] = []
    report: dict[str, Any] = {"fixture": "explicitly synthetic", "checks": {}}
    try:
        parsed = request("POST", "/career/resumes/parse", {"text": (root / "data/examples/resume.synthetic.txt").read_text(), "use_ai": False})
        resume = request("POST", "/career/resumes", {"title": "自动化流程测试 · 虚构", "data": parsed["data"], "source_text": parsed["source_text"]})
        resumes.append(resume["id"])
        job_data = json.loads((root / "data/examples/jobs.synthetic.json").read_text())[0]
        job_data["company"] = f"自动化测试机构 {uuid4()}"
        job = request("POST", "/career/jobs", job_data)
        jobs.append(job["job_id"])
        start = time.perf_counter()
        match = request("POST", "/career/matches", {"resume_id": resume["id"], "job_id": job["job_id"]})
        report["match_ms"] = round((time.perf_counter() - start) * 1000, 1)
        assert match["score"] == 71.4
        rewrite = request("POST", "/career/rewrites", {"match_id": match["id"], "section_id": match["evidence"][0]["id"], "facts": ["测试用虚构事实：使用 SQL 对 120 条记录进行重复检查。"], "use_ai": False})
        accepted = request("POST", f"/career/rewrites/{rewrite['id']}/apply", {"confirmed": True})
        result_id = accepted["resume"]["id"]
        resumes.append(result_id)
        replay = request("POST", f"/career/rewrites/{rewrite['id']}/apply", {"confirmed": True})
        assert replay["resume"]["id"] == result_id
        after = request("POST", "/career/matches", {"resume_id": result_id, "job_id": job["job_id"]})
        assert after["score"] == 85.7
        assert request("GET", f"/career/matches/{match['id']}")["resume_data"] == resume["data"]
        report["checks"].update(parse=True, match=True, accepted_version=True, idempotency=True, original_unchanged=True, before=71.4, after=85.7)
        pdf = request("GET", f"/resumes/{result_id}/pdf?template=swiss-single&pageSize=A4&lang=zh")
        assert pdf.startswith(b"%PDF")
        (output / "resume-short.pdf").write_bytes(pdf)
        long_data = copy.deepcopy(resume["data"])
        original = long_data["personalProjects"][0]
        long_data["personalProjects"] = [{**original, "id": i + 1, "name": f"分页验证项目 {i + 1}（虚构）", "description": [f"分页验证第 {i + 1} 项。使用 Python 和 Pandas 清洗校园活动报名数据，完成重复记录与缺失值检查；保留数据处理过程，整理项目说明和复核记录。", "使用 Excel 整理报名渠道数据，并制作每周统计表。"]} for i in range(12)]
        long_resume = request("POST", "/career/resumes", {"title": "自动化分页测试 · 虚构", "data": long_data})
        resumes.append(long_resume["id"])
        long_pdf = request("GET", f"/resumes/{long_resume['id']}/pdf?template=swiss-single&pageSize=A4&lang=zh")
        assert long_pdf.startswith(b"%PDF")
        (output / "resume-long.pdf").write_bytes(long_pdf)
        report["checks"]["pdf_http"] = True
        report["pdf_bytes"] = [len(pdf), len(long_pdf)]
    finally:
        for resume_id in reversed(resumes):
            request("DELETE", f"/career/resumes/{resume_id}")
        for job_id in jobs:
            request("DELETE", f"/career/jobs/{job_id}")
    (output / "smoke-result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
