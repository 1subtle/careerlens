# 开源来源与许可

CareerLens 基于 [srbhr/Resume-Matcher](https://github.com/srbhr/Resume-Matcher) 的提交 `0932418cf694de227fd5ca030ddbc0d1f40b1bef` 扩展。原始基线导入提交为 `6fd8b18`。上游采用 Apache-2.0，许可保留在 [app/LICENSE](app/LICENSE)，CareerLens 使用相同的[根许可](LICENSE)。

复用范围包括 Next.js 简历编辑、富文本、模板与 PDF 基础能力，以及 FastAPI、SQLAlchemy、SQLite、密钥加密和 LiteLLM 接入。CareerLens 在此基础上增加中文工作区、要求级匹配、经历改写与独立版本、实时岗位与统计、语义检索、照片和排版、Word 导出，以及网站账户和积分服务。

段落改写提示词复用 Resume-Matcher 的 `DIFF_STRATEGY_INSTRUCTIONS`，并适配其最小局部改写、关键词融入和事实约束。STAR 叙事与补充问题参考并复用 [itMrBoy/resumePolice](https://github.com/itMrBoy/resumePolice) 提交 `86e64f2e6c15dfd746f088cbb1cb546bb58e9e0a` 的内容，完整 MIT 声明保留在 [licenses/resumePolice-MIT.txt](licenses/resumePolice-MIT.txt)。对应实现位于 `app/apps/backend/app/prompts/career_rewrite.py` 和 `app/apps/backend/app/services/career_ai.py`。

岗位统计方法参考 Job_Market_Analysis、job_posting_analytics 和 Data-Jobs-Market-Analysis 的去重、样本分母及薪资覆盖思路，由 CareerLens 独立实现，未复制这些项目的源码。简历排版参考 Reactive Resume 与 OpenResume 的展示方式，具体组件在现有模板体系中独立实现。

其他依赖的版权与许可证由各自权利人保留，依赖名称和精确版本见前后端锁文件。
