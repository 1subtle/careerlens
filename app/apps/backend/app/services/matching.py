"""Small, deterministic Chinese/English matching rules. No model assigns scores."""

import hashlib
import html
import json
import re
from collections import Counter, defaultdict
from datetime import UTC, datetime
from typing import Any

from app.schemas.models import ResumeData

RULE_VERSION = "career-1.0"
# ponytail: a curated vocabulary covers the teaching dataset; grow it from reviewed JD errors.
SKILLS = {
    "Python": ["python"],
    "SQL": ["sql"],
    "Excel": ["excel"],
    "Tableau": ["tableau"],
    "Power BI": ["power bi", "powerbi"],
    "数据可视化": ["数据可视化", "可视化", "data visualization"],
    "数据分析": ["数据分析", "data analysis"],
    "数据清洗": ["数据清洗", "data cleaning"],
    "A/B Testing": ["a/b testing", "a/b test", "a/b测试", "ab测试", "ab testing"],
    "机器学习": ["机器学习", "machine learning"],
    "统计分析": ["统计分析", "statistics"],
    "Pandas": ["pandas"],
    "NumPy": ["numpy"],
    "Matplotlib": ["matplotlib"],
    "Java": ["java"],
    "JavaScript": ["javascript", "js"],
    "TypeScript": ["typescript", "ts"],
    "C++": ["c++"],
    "C#": ["c#"],
    "R": ["r"],
    "React": ["react", "react.js"],
    "Vue": ["vue", "vue.js", "vue3"],
    "HTML": ["html", "html5"],
    "CSS": ["css", "css3"],
    "Node.js": ["node.js", "nodejs"],
    "FastAPI": ["fastapi"],
    "Django": ["django"],
    "Spring": ["spring", "spring boot"],
    "MySQL": ["mysql"],
    "PostgreSQL": ["postgresql", "postgres"],
    "Redis": ["redis"],
    "Git": ["git"],
    "Linux": ["linux"],
    "Docker": ["docker"],
    "Figma": ["figma"],
    "需求分析": ["需求分析", "requirements analysis"],
    "用户研究": ["用户研究", "用户访谈", "user research"],
    "原型设计": ["原型设计", "prototyping"],
    "产品设计": ["产品设计", "product design"],
    "项目管理": ["项目管理", "project management"],
    "沟通协作": ["沟通协作", "沟通能力", "团队协作", "communication"],
}


def plain(value: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", value)).strip()


def fingerprint(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
    ).hexdigest()


def skill_pattern(name: str) -> re.Pattern[str]:
    aliases = SKILLS.get(name, [name])
    # ASCII boundaries preserve Chinese adjacency while distinguishing Java/JavaScript and R/React.
    return re.compile(
        "|".join(r"(?<![a-z0-9])" + re.escape(a) + r"(?![a-z0-9+#])" for a in aliases),
        re.IGNORECASE,
    )


def skills_in(text: str) -> list[str]:
    return [name for name in SKILLS if skill_pattern(name).search(text)]


def clauses(text: str) -> list[str]:
    return [
        part.strip() for part in re.split(r"[\n。；;，]+", plain(text)) if part.strip()
    ]


def requirements_from_text(text: str) -> list[dict[str, str]]:
    found: dict[str, dict[str, str]] = {}
    for part in clauses(text):
        for name in skills_in(part):
            priority = (
                "preferred"
                if re.search(
                    r"优先|加分|preferred|nice.to.have|a plus", part, re.IGNORECASE
                )
                else "required"
            )
            if name not in found or priority == "required":
                found[name] = {
                    "id": "q-" + fingerprint(name)[:10],
                    "name": name,
                    "source_text": part,
                    "priority": priority,
                }
    return list(found.values())


def parse_resume_local(text: str) -> dict[str, Any]:
    """Conservative heading parser. Unclassified material is kept for human editing."""
    data = ResumeData().model_dump(mode="json")
    lines = [
        plain(line).strip("# \t") for line in text.splitlines() if plain(line).strip()
    ]
    if not lines:
        return data
    first = re.sub(r"^(姓名|name)\s*[:：]\s*", "", lines[0], flags=re.IGNORECASE)
    if len(first) <= 20 and not re.search(
        r"简历|resume|经历|教育", first, re.IGNORECASE
    ):
        data["personalInfo"]["name"] = first
        lines = lines[1:]
    section = "summary"
    headings = {
        "教育": "education",
        "education": "education",
        "技能": "skills",
        "skills": "skills",
        "项目": "personalProjects",
        "projects": "personalProjects",
        "实习": "workExperience",
        "工作": "workExperience",
        "experience": "workExperience",
        "简介": "summary",
        "summary": "summary",
    }
    summaries: list[str] = []
    for line in lines:
        if re.fullmatch(
            r"(?:教育(?:背景|经历)?|专业?技能|技能(?:清单)?|项目(?:经历|经验)?|个人项目|实习(?:经历|经验)?|工作(?:经历|经验)?|个人简介|简介|education|skills|projects|experience|summary)[:：]?",
            line,
            re.IGNORECASE,
        ):
            section = next(
                value for token, value in headings.items() if token in line.lower()
            )
            continue
        email = re.search(r"[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}", line)
        phone = re.search(r"(?<!\d)1[3-9]\d{9}(?!\d)", line)
        if email or phone:
            if email:
                data["personalInfo"]["email"] = email.group()
            if phone:
                data["personalInfo"]["phone"] = phone.group()
            continue
        if section == "skills":
            data["additional"]["technicalSkills"].extend(skills_in(line) or [line])
        elif section == "education":
            degree = next(
                (d for d in ["博士", "硕士", "本科", "大专"] if d in line), ""
            )
            data["education"].append(
                {
                    "id": len(data["education"]) + 1,
                    "institution": line,
                    "degree": degree,
                    "years": "",
                }
            )
        elif section in ("personalProjects", "workExperience"):
            items = data[section]
            if not items or (
                len(line) <= 40 and re.search(r"项目$|实习$|\d{4}.*\d{4}", line)
            ):
                item: dict[str, Any] = {
                    "id": len(items) + 1,
                    "years": "",
                    "description": [],
                }
                item.update(
                    {"name": line, "role": ""}
                    if section == "personalProjects"
                    else {"title": line, "company": ""}
                )
                items.append(item)
            else:
                items[-1]["description"].append(line.lstrip("-• "))
        else:
            summaries.append(line)
    data["summary"] = "\n".join(summaries)
    data["additional"]["technicalSkills"] = list(
        dict.fromkeys(data["additional"]["technicalSkills"])
    )
    return ResumeData.model_validate(data).model_dump(mode="json")


def evidence_from_resume(data: dict[str, Any]) -> list[dict[str, Any]]:
    evidence: list[dict[str, Any]] = []
    for section in ("personalProjects", "workExperience"):
        for i, item in enumerate(data.get(section, [])):
            title = item.get("name") or item.get("title") or "未命名经历"
            for j, text in enumerate(item.get("description", [])):
                if plain(text):
                    evidence.append(
                        {
                            "id": f"{section}:{i}:{j}",
                            "section_id": f"{section}:{i}:{j}",
                            "title": title,
                            "text": plain(text),
                            "kind": "experience",
                            "path": [section, i, "description", j],
                        }
                    )
    for i, text in enumerate(data.get("additional", {}).get("technicalSkills", [])):
        evidence.append(
            {
                "id": f"skill:{i}",
                "section_id": f"skill:{i}",
                "title": "技能自述",
                "text": plain(text),
                "kind": "skill",
                "path": ["additional", "technicalSkills", i],
            }
        )
    if plain(data.get("summary", "")):
        evidence.append(
            {
                "id": "summary:0",
                "section_id": "summary:0",
                "title": "个人简介",
                "text": plain(data["summary"]),
                "kind": "summary",
                "path": ["summary"],
            }
        )
    for item in evidence:
        item["source_hash"] = fingerprint(item["text"])
    return evidence


def evidence_value(name: str, item: dict[str, Any]) -> float:
    pattern = skill_pattern(name)
    values = []
    for part in clauses(item["text"]):
        match = pattern.search(part)
        if not match:
            continue
        before = part[: match.start()]
        negative = re.search(
            r"未|没有|不会|不熟悉|计划|准备学习|希望学习|no experience|not familiar|plan to|learning",
            before[-35:],
            re.IGNORECASE,
        )
        after = part[match.end() :]
        if negative or re.search(r"^(?:\s)*(?:尚未|不会|未掌握|待学习)", after):
            values.append(0.0)
        elif item["kind"] == "experience" and re.search(
            r"使用|利用|完成|实现|开发|构建|分析|设计|负责|搭建|清洗|编写|built|developed|used|implemented|analy[sz]ed",
            part,
            re.IGNORECASE,
        ):
            values.append(1.0)
        else:
            values.append(0.5)
    return max(values, default=0.0)


def score_details(details: list[dict[str, Any]]) -> float | None:
    total = sum(item["weight"] for item in details)
    for item in details:
        item["contribution"] = (
            100 * item["weight"] * item["value"] / total if total else 0
        )
    return round(sum(item["contribution"] for item in details), 1) if total else None


def match_requirements(
    requirements: list[dict[str, Any]], evidence: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], float | None]:
    details = []
    for requirement in requirements:
        candidates = [
            (evidence_value(requirement["name"], item), item) for item in evidence
        ]
        value = max((v for v, _ in candidates), default=0)
        ids = [item["id"] for v, item in candidates if v == value and v > 0]
        status = (
            "supported" if value == 1 else "mentioned" if value == 0.5 else "pending"
        )
        reason = {
            "supported": "经历中有具体应用描述，可查看原文。",
            "mentioned": "材料提及这项技能，建议补充实际应用。",
            "pending": "当前材料尚无支持证据，请确认是否有相关经历。",
        }[status]
        details.append(
            {
                **requirement,
                "weight": 1 if requirement["priority"] == "preferred" else 2,
                "value": value,
                "evidence_ids": ids,
                "status": status,
                "reason": reason,
            }
        )
    return details, score_details(details)


def work_months(data: dict[str, Any]) -> int:
    months: set[int] = set()
    for item in data.get("workExperience", []):
        dates = re.findall(r"(20\d{2})[./年-](\d{1,2})", item.get("years", ""))
        if len(dates) != 2:
            continue
        (y1, m1), (y2, m2) = [(int(y), int(m)) for y, m in dates]
        if not (1 <= m1 <= 12 and 1 <= m2 <= 12):
            continue
        start, end = y1 * 12 + m1, y2 * 12 + m2
        if 0 <= end - start <= 600:
            months.update(range(start, end + 1))
    return len(months)


def conditions_for(data: dict[str, Any], text: str) -> list[dict[str, str]]:
    levels = {"大专": 1, "本科": 2, "硕士": 3, "博士": 4}
    degree_clauses = [
        part
        for part in clauses(text)
        if not re.search(r"优先|加分|preferred", part, re.IGNORECASE)
    ]
    required = next(
        (
            level
            for level in reversed(levels)
            if any(level in part for part in degree_clauses)
        ),
        None,
    )
    education = " ".join(item.get("degree", "") for item in data.get("education", []))
    actual = max(
        (rank for level, rank in levels.items() if level in education), default=0
    )
    status = (
        "not_stated"
        if not required
        else "unknown"
        if not actual
        else "met"
        if actual >= levels[required]
        else "unmet"
    )
    result = [
        {
            "name": "学历要求",
            "requirement": required or "JD 未说明",
            "status": status,
            "observed": education or "简历未填写学历",
        }
    ]
    years = re.search(r"(\d+)\s*年(?:以上)?[^\n。]{0,8}(?:经验|经历)", text)
    months = work_months(data)
    result.append(
        {
            "name": "经验要求",
            "requirement": years.group() if years else "JD 未说明明确年限",
            "status": "unknown" if years else "not_stated",
            "observed": f"明确工作区间去重后 {months} 个月；岗位相关性需确认",
        }
    )
    onsite = re.search(r"[^\n。]*(?:每周.{0,8}天|到岗|实习.{0,8}个月)[^\n。]*", text)
    result.append(
        {
            "name": "到岗与实习时长",
            "requirement": onsite.group() if onsite else "JD 未说明",
            "status": "unknown" if onsite else "not_stated",
            "observed": "由本人根据课程和时间安排确认",
        }
    )
    return result


def parse_salary(text: str) -> dict[str, Any]:
    currency = "USD" if "$" in text or "USD" in text.upper() else "CNY"
    period = (
        "day"
        if re.search(r"/天|/日|日薪", text)
        else "year"
        if re.search(r"/年|年薪", text)
        else "month"
        if re.search(r"[kK]|/月|月薪", text)
        else None
    )
    match = re.search(
        r"(\d+(?:\.\d+)?)\s*([kKwW万]?)\s*[-~—–至]\s*(\d+(?:\.\d+)?)\s*([kKwW万]?)",
        text,
    )
    result: dict[str, Any] = {
        "raw": text,
        "currency": currency,
        "period": period,
        "min": None,
        "max": None,
        "mid": None,
    }
    if match and period:
        low, unit1, high, unit2 = match.groups()
        units = {"": 1, "k": 1000, "w": 10000, "万": 10000}
        low_value = float(low) * units[(unit1 or unit2).lower()]
        high_value = float(high) * units[(unit2 or unit1).lower()]
        if 0 < low_value <= high_value:
            result.update(
                min=low_value, max=high_value, mid=(low_value + high_value) / 2
            )
    return result


def market_summary(
    jobs: list[dict[str, Any]], filters: dict[str, Any]
) -> dict[str, Any]:
    seen: set[str] = set()
    selected = []
    for job in jobs:
        if not filters.get("include_demo") and job.get("source_type") == "synthetic":
            continue
        if filters.get("category") and job.get("category") != filters["category"]:
            continue
        if filters.get("city") and job.get("city") != filters["city"]:
            continue
        if filters.get("since") and (
            not job.get("published_at")
            or str(job["published_at"]) < str(filters["since"])
        ):
            continue
        key = fingerprint([job.get("company", ""), re.sub(r"\s+", "", job["content"])])
        if key not in seen:
            selected.append(job)
            seen.add(key)
    skills: Counter[str] = Counter()
    categories: dict[str, list[dict[str, Any]]] = defaultdict(list)
    salaries = []
    for job in selected:
        names = {
            r["name"]
            for r in job.get("requirements", requirements_from_text(job["content"]))
        }
        skills.update(names)
        categories[job.get("category", "其他")].append(job)
        salary = parse_salary(job.get("salary_text", ""))
        if salary["mid"] is not None:
            salaries.append(
                {
                    **salary,
                    "job_id": job["job_id"],
                    "category": job.get("category", "其他"),
                    "title": job.get("title", "未命名"),
                }
            )
    skill_data = [
        {
            "name": name,
            "value": count,
            "job_ids": [
                j["job_id"]
                for j in selected
                if name
                in {
                    r["name"]
                    for r in j.get("requirements", requirements_from_text(j["content"]))
                }
            ],
        }
        for name, count in skills.most_common(30)
    ]
    distribution = []
    for category, items in categories.items():
        counts: Counter[str] = Counter()
        for job in items:
            counts.update(
                {
                    r["name"]
                    for r in job.get(
                        "requirements", requirements_from_text(job["content"])
                    )
                }
            )
        distribution.append(
            {
                "category": category,
                "count": len(items),
                "skills": [
                    {
                        "name": name,
                        "count": count,
                        "percent": round(100 * count / len(items), 1),
                    }
                    for name, count in counts.most_common()
                ],
            }
        )
    return {
        "count": len(selected),
        "skills": skill_data,
        "salaries": salaries,
        "salary_missing": len(selected) - len(salaries),
        "distribution": distribution,
        "filters": filters,
        "dataset_hash": fingerprint(selected),
        "job_ids": [j["job_id"] for j in selected],
        "demo_count": sum(j.get("source_type") == "synthetic" for j in selected),
        "date": datetime.now(UTC).date().isoformat(),
    }
