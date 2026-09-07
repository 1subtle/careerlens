# 开源来源与复用说明

CareerLens 基于 [srbhr/Resume-Matcher](https://github.com/srbhr/Resume-Matcher) 的固定提交 `0932418cf694de227fd5ca030ddbc0d1f40b1bef` 构建。源码于 2026-09-07 导入 `app/`，根 Git 提交 `6fd8b18` 保存了完整基线，便于逐文件比较自主改动。

上游采用 Apache-2.0；原许可、署名和文档保留在 [app/LICENSE](app/LICENSE) 及原工程中。本轮新增文件与修改按同一 Apache-2.0 许可提供。第三方组件的许可仍分别适用。

| 范围 | 处理 |
| --- | --- |
| Next.js 框架、简历表单、富文本编辑、模板与 Chromium PDF | 复用上游；新增中文工作区并调用原编辑器、导出接口 |
| FastAPI、SQLAlchemy、SQLite、密钥加密、LiteLLM 接入 | 复用上游；保持已有接口与数据格式兼容 |
| 简历、岗位、历史快照、证据评分、条件检查 | 新增 CareerLens 业务接口和规则实现 |
| 单段草稿、事实引用、拒绝和采纳、独立版本 | 新增事务流程；复用上游简历记录及修改记录 |
| 词云、薪资散点图、技能占比热力图、限定统计解读 | 新增 ECharts 5.6.0 与 echarts-wordcloud 2.1.0 集成 |
| 初始化、样本、接口说明、验证脚本 | 本轮新增 |

CareerLens 的主评分依据要求级证据计算。上游 ATS、投递追踪、面试准备等旧页面和接口仍保留在源码中，未计入本轮自主功能验收。

上游使用 `.gitignore` 排除了 `uv.lock`。本工程新增并跟踪实际生成的锁文件；Docker 后端安装同步改为 `uv sync --frozen --no-dev`。前端使用 `npm ci` 固定依赖。
