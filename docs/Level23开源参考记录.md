# Level 2 / Level 3 开源参考记录

核查日期：2026-09-10。本文记录简历 STAR 改写和岗位市场分析使用的开源来源、固定提交、实际文件及适配范围。项目按 GitHub 搜索、提交树、实际源码和许可文件逐项核对；下文区分直接复用代码、适配提示词与参考统计方法。

## Level 2：STAR 改写

| 来源 | 固定提交与许可 | 实际来源文件 | CareerLens 的处理 |
| --- | --- | --- | --- |
| [srbhr/Resume-Matcher](https://github.com/srbhr/Resume-Matcher/tree/0932418cf694de227fd5ca030ddbc0d1f40b1bef) | `0932418cf694de227fd5ca030ddbc0d1f40b1bef`；[Apache-2.0](https://github.com/srbhr/Resume-Matcher/blob/0932418cf694de227fd5ca030ddbc0d1f40b1bef/LICENSE) | [apps/backend/app/prompts/templates.py](https://github.com/srbhr/Resume-Matcher/blob/0932418cf694de227fd5ca030ddbc0d1f40b1bef/apps/backend/app/prompts/templates.py#L486-L558)，`DIFF_STRATEGY_INSTRUCTIONS` 与 `DIFF_IMPROVE_PROMPT` | 直接导入已有策略常量，按有无目标岗位选择 `keywords` 或 `nudge`；将最小局部改写、等义术语融合、已有指标和责任程度保留等规则适配为中文单段输出。 |
| [itMrBoy/resumePolice](https://github.com/itMrBoy/resumePolice/tree/86e64f2e6c15dfd746f088cbb1cb546bb58e9e0a) | `86e64f2e6c15dfd746f088cbb1cb546bb58e9e0a`；[MIT](https://github.com/itMrBoy/resumePolice/blob/86e64f2e6c15dfd746f088cbb1cb546bb58e9e0a/LICENSE)，Copyright (c) 2025 itMrBoy | [prompt/resume_police_Zh.md](https://github.com/itMrBoy/resumePolice/blob/86e64f2e6c15dfd746f088cbb1cb546bb58e9e0a/prompt/resume_police_Zh.md#L78-L131)，叙事框架、STAR/CAR 公式、针对性问题和衡量方式 | 适配为 `STAR_GUIDANCE`：分别识别背景、任务、行动和结果；已有内容提供短引文与来源 ID，缺项提供具体问题，另列岗位关键词和量化补充建议。 |

本地入口为 [career_rewrite.py](../app/apps/backend/app/prompts/career_rewrite.py)，由 [career_ai.py](../app/apps/backend/app/services/career_ai.py) 的改写服务调用。原有草稿与来源引用字段继续使用，新增 STAR、关键词和量化建议字段。完成报告、清单等实际产物可以作为结果，缺失的数字与效果以问题形式请用户补充。

`resumePolice` 的提示词内容经过单段任务适配，没有移植其整份简历评审流程或应用框架。原项目的审判式语气、职位偏见和示例数字占位符未纳入本地提示词。该来源的完整 MIT 声明保存在 [licenses/resumePolice-MIT.txt](../licenses/resumePolice-MIT.txt)；Resume-Matcher 的原许可保存在 [app/LICENSE](../app/LICENSE)。

## Level 3：岗位市场分析

以下三个项目用于参考统计方法。本地聚合代码沿用并扩展 CareerLens 的 `market_summary`，没有复制这些项目的 SQL、Python 源码或部署框架。

| 来源 | 固定提交与许可 | 核对的实际代码 | 采用的方法 |
| --- | --- | --- | --- |
| [luckisalive/Job_Market_Analysis](https://github.com/luckisalive/Job_Market_Analysis/tree/22c9c9263b51c66623d72bdb7949f66a7620a1c4) | `22c9c9263b51c66623d72bdb7949f66a7620a1c4`；[MIT](https://github.com/luckisalive/Job_Market_Analysis/blob/22c9c9263b51c66623d72bdb7949f66a7620a1c4/LICENSE)，Copyright (c) 2026 Lalit Negi | [notebooks/analysis.ipynb](https://github.com/luckisalive/Job_Market_Analysis/blob/22c9c9263b51c66623d72bdb7949f66a7620a1c4/notebooks/analysis.ipynb)，代码 cell 4、6、10、16、30、32、38 | 岗位 ID 去重；日期转换与样本时期展示；类别内岗位总数作为技能占比分母；标题类别规则；日期和薪资覆盖率。 |
| [mar1-k/job_posting_analytics](https://github.com/mar1-k/job_posting_analytics/tree/ec4c0df784ece072750b7b9857742a5cc8ee0028) | `ec4c0df784ece072750b7b9857742a5cc8ee0028`；[MIT](https://github.com/mar1-k/job_posting_analytics/blob/ec4c0df784ece072750b7b9857742a5cc8ee0028/LICENSE)，Copyright (c) 2024 mar1 | [streamlit_dashboard/dashboard.py](https://github.com/mar1-k/job_posting_analytics/blob/ec4c0df784ece072750b7b9857742a5cc8ee0028/streamlit_dashboard/dashboard.py)，`fetch_skills_data`、`fetch_companies_data`；[transform_data_spark.py](https://github.com/mar1-k/job_posting_analytics/blob/ec4c0df784ece072750b7b9857742a5cc8ee0028/infra/airflow/dags/transform_data_spark.py) | 同一筛选样本驱动技能、公司与岗位明细，明确样本采集时期。 |
| [Fazazhar/Data-Jobs-Market-Analysis](https://github.com/Fazazhar/Data-Jobs-Market-Analysis/tree/562fa5e038ba5048100828c02a088249a50b8e21) | `562fa5e038ba5048100828c02a088249a50b8e21`；[MIT](https://github.com/Fazazhar/Data-Jobs-Market-Analysis/blob/562fa5e038ba5048100828c02a088249a50b8e21/LICENSE)，Copyright (c) 2024 Farrel Azhar (AZ) | [1_top_paying_jobs.sql](https://github.com/Fazazhar/Data-Jobs-Market-Analysis/blob/562fa5e038ba5048100828c02a088249a50b8e21/queries/1_top_paying_jobs.sql)、[3_top_demanded_skills.sql](https://github.com/Fazazhar/Data-Jobs-Market-Analysis/blob/562fa5e038ba5048100828c02a088249a50b8e21/queries/3_top_demanded_skills.sql)、[4_top_paying_skills.sql](https://github.com/Fazazhar/Data-Jobs-Market-Analysis/blob/562fa5e038ba5048100828c02a088249a50b8e21/queries/4_top_paying_skills.sql) | 先按类别和地点确定岗位样本；薪资分析使用有明确薪资的子样本，技能需求按岗位计数。 |

本地对应实现位于 [matching.py](../app/apps/backend/app/services/matching.py) 的 `market_summary`、`category_from_title`，以及 [career.py](../app/apps/backend/app/routers/career.py) 的市场统计与建议接口。界面筛选确定唯一统计范围，模型问题用于解读该范围；历史保存原始岗位池、实际筛选条件与统计结果。

具体口径为：同一岗位内的技能只计一次；近期筛选仅使用 `published_at`；来源更新时间和采集时间分别保留；缺失发布日期在日期筛选中排除并计数；薪资按已有币种和周期分组。`coverage` 的样本数、已知日期数和日期范围对应日期筛选前的已去重样本，最终岗位 ID 对应应用全部条件后的结果。

NCSS 的公开列表没有岗位类别字段，因此仅在标题含有明确职业词时给出可校对的类别；腾讯与 Jobicy 已提供的类别优先保留。无法明确归类的标题仍为“其他”，保存后人工校对的类别不重新覆盖。以上规则为本地适配，没有采用参考项目中将未知标题固定归为某一职业的默认做法。

## 核对后未采用的来源

| 项目与提交 | 处理依据 |
| --- | --- |
| `jellydn/smart-resume-matcher@ce791fd16c3e1fa533a2f4d8a04618e7c8b9e523`、`Admiralgm/cv-writing-guide@6196be5082bae18941eb233bddfdae14d747d33a`、`Sumukhmg/resume-optimizer-claude-skill@68917dce3bd29071728025bcc29ca37e3120677d` | 核对了 MIT 许可，未选作 STAR 提示词来源。 |
| `ShoafzalDataAnalyst/HeadHunter-Vacancy-Collector@ae40ca8298fbce253f6e39538e62fe943db0f556` | 未找到明确的仓库 LICENSE，未复用代码。 |
| `JonahKunzler/job-market-analytics-dashboard@9bc593b7d176c5669888acda074008c198e8d122` | 未找到明确的仓库 LICENSE，未复用代码。 |
| `aftabdayer/jobmarket-backend@74684a95a74ba258cb5bcc0b09b8c4ccdc22d4fb` | 未找到明确的仓库 LICENSE，未复用代码。 |
| `lukebarousse/SQL_Project_Data_Job_Analysis@ff272240ac3d7952b9c512e308b213a8b2a263fe` | 未找到明确的仓库 LICENSE，未复用代码；统计方法核对采用上表中有明确 MIT 声明的相关项目。 |
| `LukeBarousse/Data_Analyst_Bootcamp` | 核查时 GitHub API 返回 404。 |
