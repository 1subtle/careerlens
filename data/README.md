# 数据与建表脚本

`schema.sql` 为早期从 SQLAlchemy 模型导出的9张业务表结构及索引、外键。2026-09-09文档核对发现，该文件尚缺当前`resumes.template_settings`字段，也不包含独立认证与积分库的5张表。应用启动按当前模型及迁移逻辑初始化；实际结构、认证初始化与重新导出DDL的方法见[后端与数据库设计](../docs/后端与数据库设计文档.md)。最终提交前需同步该静态SQL，不能将它作为当前完整结构的唯一依据。

`examples/resume.synthetic.txt` 为一份完全虚构的学生简历。`examples/jobs.synthetic.json` 为 12 条完全虚构的岗位，覆盖数据分析、前端开发、产品设计三类，并包括日薪、月薪、年薪、外币及薪资缺失案例。机构、经历和薪资均不是真实市场观察，`source_type` 固定为 `synthetic`，发布日期未知，不填写伪造来源链接。

该数据与 `app/apps/backend/app/services/demo.py` 一致，可用 `career_data export-demo` 重新导出。API 的示例载入和初始化命令均不会覆盖已有个人材料。

真实岗位的导入格式如下。每条 `source_text` 必须逐字出现在对应 `text` 中。省略 `requirements` 时按规则抽取；传入空数组表示目前没有有效要求。

```json
[
  {
    "title": "从真实来源填写岗位名称",
    "company": "从真实来源填写机构名称",
    "category": "数据分析",
    "city": "上海",
    "text": "此处粘贴完整 JD 原文",
    "salary_text": "保留薪资原文，未披露时留空",
    "source_url": "",
    "source_type": "manual",
    "published_at": null
  }
]
```

`published_at` 使用 `YYYY-MM-DD`，未知时为 `null`。`source_type` 为 `manual`、`course` 或 `synthetic`。岗位保存时自动记录 `collected_at`；实际发布时间不能用采集时间代替。

课程真实数据尚待团队整理：5份真实JD、3份经同意使用的脱敏简历及gap分析。项目设计15组人工对照，前10组可用于规则调整、后5组在冻结规则后验证；15组与10/5划分是本项目评价方法。登记表、授权状态、两款APP体验与对照示例见[竞品体验与样本差距分析](../docs/竞品体验与样本差距分析.md)。当前自动化测试结果不作为这组人工评估的精确率或召回率。
