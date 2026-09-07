"""Fictional fixtures for exploring the workflow, never real market observations."""

from typing import Any

DEMO_RESUME = """林同学（虚构示例）
demo@example.com
个人简介
信息管理专业本科生，希望从事数据分析相关实习。
教育背景
示例大学 信息管理与信息系统 本科 2023—2027
项目经历
校园活动数据分析项目
使用 Python 和 Pandas 清洗校园活动报名数据，完成重复记录与缺失值检查。
使用 Excel 整理报名渠道数据，并制作每周统计表。
技能
Python、Pandas、SQL、Excel
"""


def demo_jobs() -> list[dict[str, Any]]:
    records = [
        (
            "数据分析实习生",
            "数据分析",
            "上海",
            "180-220元/天",
            "使用 Python 清洗数据；掌握 SQL；使用 Excel 制作分析表；熟悉 Tableau 优先。本科及以上。每周到岗 3 天，实习 3 个月。",
        ),
        (
            "商业分析实习生",
            "数据分析",
            "北京",
            "200-250元/天",
            "使用 SQL 分析业务数据；掌握 Excel 和数据可视化；熟悉 Python 优先。本科及以上。",
        ),
        (
            "数据运营助理",
            "数据分析",
            "上海",
            "7-10K/月",
            "负责数据分析与数据清洗；掌握 SQL 和 Excel；使用 Power BI 优先。",
        ),
        (
            "数据分析助理",
            "数据分析",
            "杭州",
            "8-12K/月·13薪",
            "使用 Python、Pandas 与 SQL 完成数据分析；熟悉统计分析。",
        ),
        (
            "前端开发实习生",
            "前端开发",
            "上海",
            "180-250元/天",
            "使用 React 与 TypeScript 开发页面；掌握 HTML、CSS 和 Git。",
        ),
        (
            "Web 开发实习生",
            "前端开发",
            "杭州",
            "150-200元/天",
            "使用 Vue 与 JavaScript 实现页面；熟悉 HTML、CSS；有 Node.js 经验优先。",
        ),
        (
            "初级前端工程师",
            "前端开发",
            "北京",
            "10-16K/月",
            "使用 React、TypeScript 和 CSS 构建应用；掌握 Git；熟悉 Figma 优先。",
        ),
        (
            "产品实习生",
            "产品设计",
            "上海",
            "150-200元/天",
            "负责需求分析和用户研究；使用 Figma 完成原型设计；具备沟通协作能力。",
        ),
        (
            "产品助理",
            "产品设计",
            "北京",
            "8-12K/月",
            "完成需求分析与产品设计；掌握 Excel；具有项目管理经验优先。",
        ),
        (
            "用户研究实习生",
            "产品设计",
            "杭州",
            "面议",
            "负责用户研究；完成数据分析与统计分析；使用 Excel；具备沟通能力。",
        ),
        (
            "海外分析练习岗位",
            "数据分析",
            "远程",
            "$2000-3000/月",
            "使用 SQL 和 Tableau 分析业务；掌握 Python。",
        ),
        (
            "产品设计校招",
            "产品设计",
            "上海",
            "12-18万元/年",
            "使用 Figma 完成原型设计；负责产品设计和用户研究。",
        ),
    ]
    return [
        {
            "title": title,
            "category": category,
            "city": city,
            "salary_text": salary,
            "text": content,
            "company": f"虚构示例机构 {i + 1:02}",
            "source_type": "synthetic",
            "source_url": "",
            "published_at": None,
        }
        for i, (title, category, city, salary, content) in enumerate(records)
    ]
