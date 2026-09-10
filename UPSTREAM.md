# 开源来源与复用说明

CareerLens 基于 [srbhr/Resume-Matcher](https://github.com/srbhr/Resume-Matcher) 的固定提交 `0932418cf694de227fd5ca030ddbc0d1f40b1bef` 构建。源码于 2026-09-07 导入 `app/`，根 Git 提交 `6fd8b18` 保存了完整基线，便于逐文件比较自主改动。

上游采用 Apache-2.0；原许可、署名和文档保留在 [app/LICENSE](app/LICENSE) 及原工程中。本轮新增文件与修改按同一 Apache-2.0 许可提供。第三方组件的许可仍分别适用。

| 范围 | 处理 |
| --- | --- |
| Next.js 框架、简历表单、富文本编辑、模板与 Chromium PDF | 复用上游；新增中文工作区并调用原编辑器、导出接口 |
| FastAPI、SQLAlchemy、SQLite、密钥加密、LiteLLM 接入 | 复用上游；保持已有接口与数据格式兼容 |
| 简历、岗位、历史快照、证据评分、条件检查 | 新增 CareerLens 业务接口和规则实现 |
| 单段草稿、事实引用、拒绝和采纳、独立版本 | 新增事务流程；复用上游简历记录及修改记录。2026-09-10 起主润色入口直接复用上游 `DIFF_STRATEGY_INSTRUCTIONS`，并将 `DIFF_IMPROVE_PROMPT` 核心规则适配为中文单段模板 |
| 词云、薪资散点图、技能占比热力图、限定统计解读 | 新增 ECharts 5.6.0 与 echarts-wordcloud 2.1.0 集成 |
| 初始化、样本、接口说明、验证脚本 | 本轮新增 |
| 邮箱验证码、会话与账号独立业务库 | CareerLens 网站模式新增；同时适配既有接口与打印身份 |
| 本地语义候选、AI 目标诊断与方向建议、实时岗位来源 | 在既有模型封装之上新增业务服务与约束 |
| 简历照片、独立版式、可编辑 Word 导出 | 在上游编辑与打印能力上扩展照片/版式持久化，新增 Word 生成 |

以上范围按2026-09-10当前工作区核对，包含基线导入后的提交及未提交修改。课程设计与逐日成果见[实训文档总览](docs/README.md)，不以文件的生成工具或提交作者代替学生个人贡献说明。

主流程的提示词位于 `app/apps/backend/app/prompts/career_rewrite.py`，由 `services/career_ai.py` 调用；并非只保留未启用的上游模板。它保留上游的定向关键词融合、最小局部改写、已对齐内容保留和实际经历约束，适配用户补充材料及 `draft/claims/missing_facts/reason` 输出。上游整份简历的技能目标规划、JSON 路径差异和可选二次补写不用于这个单段入口。逐项来源、调用链与质量对照见 [GitHub 提示词接入记录](docs/GitHub提示词接入与复测_2026-09-10.md)。

CareerLens 的主评分依据要求级证据计算。上游 ATS、投递追踪、面试准备等旧页面和接口仍保留在源码中，未计入本轮自主功能验收。

上游使用 `.gitignore` 排除了 `uv.lock`。本工程新增并跟踪实际生成的锁文件；Docker 后端安装同步改为 `uv sync --frozen --no-dev`。前端使用 `npm ci` 固定依赖。

2026-09-10 的 Level 2 / Level 3 扩展继续沿用上述前后端、模型封装和历史快照架构。STAR 改写直接复用 Resume-Matcher 的策略常量，并适配 `itMrBoy/resumePolice@86e64f2e6c15dfd746f088cbb1cb546bb58e9e0a` 的 STAR 叙事、补充问题与量化建议内容；后者的完整 MIT 声明保存在 [licenses/resumePolice-MIT.txt](licenses/resumePolice-MIT.txt)。

岗位市场分析参考 `luckisalive/Job_Market_Analysis`、`mar1-k/job_posting_analytics` 和 `Fazazhar/Data-Jobs-Market-Analysis` 的去重、样本范围、技能分母及薪资覆盖方法，由 CareerLens 原有聚合服务独立实现。该部分未复制上述项目源码，也未移植其 Streamlit、Spark、BigQuery 或 SQL 分析框架。固定提交、实际来源文件、许可和本地适配范围见 [Level 2 / Level 3 开源参考记录](docs/Level23开源参考记录.md)。
