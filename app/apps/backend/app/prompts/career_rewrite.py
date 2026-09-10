"""CareerLens single-passage adaptation of Resume-Matcher's diff prompt.

Source: srbhr/Resume-Matcher, commit 0932418cf694de227fd5ca030ddbc0d1f40b1bef,
apps/backend/app/prompts/templates.py (DIFF_IMPROVE_PROMPT), Apache-2.0.
Changes: Chinese instructions, candidate-supplied facts, one selected passage,
and CareerLens's editable draft/source-link schema instead of JSON path diffs.
The upstream strategy instructions are imported unchanged at runtime.

STAR guidance adapts the narrative framework, targeted questions and measurement
paths in itMrBoy/resumePolice, commit 86e64f2e6c15dfd746f088cbb1cb546bb58e9e0a,
prompt/resume_police_Zh.md, lines 84-88 and 111-120 (MIT, 2025 itMrBoy).
Changes: four source-linked fields, separate questions instead of placeholders,
and the candidate's actual responsibility level, deliverables and outcomes.
"""

import json
from typing import Any

from app.prompts.templates import DIFF_STRATEGY_INSTRUCTIONS


STAR_GUIDANCE = [
    "按 STAR 分析同一段候选人材料：S 为实际背景或待解决的问题，T 为本人承担的任务或目标，"
    "A 为本人采取的行动、方法或工具，R 为实际产物、结果或影响。S 与 T 分开识别，"
    "只用原文和用户补充已有内容；目标岗位的职责不能充当候选人经历。",
    "识别已有要素时不过度要求额外信息：原文明确本人做的工作可作为 T，具体方法可作为 A；"
    "完成报告、整理清单等实际产物本身就是 R，不要求必须有量化提升或业务影响。"
    "例如‘帮忙整理反馈，也写了报告’的 T 可引用‘帮忙整理反馈’，R 可引用‘写了报告’。"
    "产物的用途或规模可放入量化建议，不因此把已有的 R 标为缺失。",
    "star 按 S、T、A、R 顺序各输出一项。已有内容的 evidence 选取 sources 中简短的直接引文，"
    "source_ids 标明出处，question 留空；没有依据时 evidence 留空、source_ids 返回空数组，"
    "question 针对这段经历提出一个具体问题。已提供的信息不要再次追问。",
    "改写结合已有的背景、任务、行动和结果，合并成自然简洁的句子，无需在正文标注 STAR 字母。"
    "只有行动也可据实优化表达；不要为补齐四项而推测背景、职责或效果。个人简介按已有经历"
    "识别四项，并让补充问题引导提供实际例子，保留简介的概括形式。",
    "quantification_suggestions 最多 4 条，针对已有行动提出可回忆或核实的衡量方式，"
    "如处理规模、工作频次、投入时长、交付数量或前后结果。已有指标可建议补充口径、期间"
    "或比较基准；没有数字也可明确实际交付物或可观察结果。问题只用于补充材料，"
    "不预设改善方向、业务价值或增长幅度，不给示例数值，也不改动已有指标。",
    "keyword_suggestions 最多 6 条，keyword 仅选目标 JD 原文或岗位要求中真实出现的词。"
    "suggestion 说明已有行动如何自然体现该词；材料没有相应经验时，只问是否做过相关工作"
    "及可补充的实际例子，不将缺失技能写入正文。没有目标 JD 或岗位要求时返回空数组。",
    "missing_facts 仅保留 STAR 缺项和量化建议均未涉及的必要补充问题（最多 2 条），"
    "没有额外问题时返回空数组。各条证据、问题和建议保持简短，不重复展开 reason。",
]


def build_rewrite_prompt(
    sources: list[dict[str, str]],
    requirements: list[dict[str, Any]],
    job: dict[str, Any] | None,
) -> str:
    targeted = bool(requirements or (job and job.get("content", "").strip()))
    return json.dumps(
        {
            "任务": "你是简历编辑。只润色所选经历或个人简介，输出可供预览、编辑和采纳的完整建议稿。"
            "使用简体中文，保留技术名称与缩写的原有大小写。",
            "改写策略": DIFF_STRATEGY_INSTRUCTIONS["keywords" if targeted else "nudge"],
            "STAR建议": STAR_GUIDANCE,
            "编辑准则": [
                "sources 中的原文和用户补充共同构成候选人材料；目标 JD 与岗位要求只用于选择重点和术语。",
                "优先将相关的用户补充融入正文，已提供的事实不再列为 missing_facts。",
                "优先将已有行动、使用的方法和实际产出写清楚，以具体行动起句、合并重复表达。"
                "已有经历能体现岗位要求时，用该岗位的表达方式等义重述，避免堆砌关键词。",
                "保留材料中的实际参与程度、技能、数据、成果与资历；例如协助仍表达为协助。"
                "人名、公司、学校、学位和日期保持原样。新增细节须来自用户补充。",
                "责任程度按原义表达：帮忙或协助写为协助，参与写为参与；独立、负责、主导仅在"
                "材料明确时使用。产物名称及用途也按原义保留，周报仍是周报。"
                "材料仅说完成文档时，正文就写完成该文档；它是否用于决策、优化或产生影响留作可选问题。",
                "只在确有改善时调整。原文已清楚且符合岗位重点、也没有待融入的补充事实时，"
                "draft 可以原样返回，并在 reason 说明已具备的优势。",
                "与岗位无关的经历仍按其实际内容润色。缺失的工具、指标、职责或成果可放在"
                "missing_facts 中作为与这段经历有关的可选补充问题（最多 3 条），"
                "正文使用已有材料，不放待填占位符。",
                "每个 claim 对应 draft 中的连续段落，按顺序拼接覆盖完整正文；"
                "source_ids 只填写实际参考的给定来源 ID。",
                "reason 用不超过 120 字简述具体改了什么，以及已有行动对应哪项岗位要求；没有直接对应时如实说明。"
                "无目标岗位时按通用表达质量润色，只说明表达上的改善。",
            ],
            "sources": sources,
            "岗位要求": [
                {
                    key: item.get(key)
                    for key in ("name", "source_text", "priority", "status")
                }
                for item in requirements
            ],
            "目标JD": {
                "title": job.get("title", ""),
                "content": job.get("content", ""),
            }
            if job
            else None,
            "输出结构": {
                "draft": "完整改写正文",
                "claims": [{"text": "正文中的连续段落", "source_ids": [sources[0]["id"]]}],
                "missing_facts": ["可选的补充问题，没有则返回空数组"],
                "reason": "具体表达调整与岗位关联，或保留原文的理由",
                "star": [
                    {
                        "stage": stage,
                        "evidence": "已有内容的简短直接引文；缺失时为空",
                        "question": "缺失时的具体补充问题；已有内容时为空",
                        "source_ids": [sources[0]["id"]],
                    }
                    for stage in "STAR"
                ],
                "keyword_suggestions": [
                    {"keyword": "JD 或岗位要求原词", "suggestion": "已有事实的表达建议或具体补充问题"}
                ],
                "quantification_suggestions": ["针对已有行动、产物或指标的具体量化补充问题"],
            },
        },
        ensure_ascii=False,
    )
