# 数据与示例

`schema.sql` 是业务表结构快照，用于阅读数据模型。应用自动初始化数据库并执行版本迁移；认证与积分使用独立认证库，不通过此快照升级。

`examples/resume.synthetic.txt` 是虚构简历，`examples/jobs.synthetic.json` 包含 12 条虚构岗位，覆盖数据分析、前端开发和产品设计，以及不同薪资单位与薪资缺失情况。材料用于功能验证，机构与经历不代表真实个人或市场记录。

示例与后端 `app/services/demo.py` 保持一致，可在后端目录运行以下命令重新导出：

```bash
uv run --frozen python -m app.scripts.career_data export-demo ../../../data/examples
```

岗位导入格式示例：

```json
[
  {
    "title": "岗位名称",
    "company": "机构名称",
    "category": "数据分析",
    "city": "上海",
    "text": "完整 JD 原文",
    "salary_text": "来源披露的薪资原文",
    "source_url": "",
    "source_type": "manual",
    "published_at": null
  }
]
```

手动材料使用 `manual`，虚构材料使用 `synthetic`。`published_at` 使用 `YYYY-MM-DD`，未知时为 `null`；采集时间由系统另行记录。传入岗位要求时，`source_text` 必须逐字出现在 JD 原文中；省略要求则由规则抽取，空数组表示暂未提供有效要求。

安装与验证操作见[运行指南](../docs/系统运行说明.md)。
