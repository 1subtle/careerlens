# CareerLens

面向学生求职的简历诊断与岗位匹配系统。基于 Resume Matcher 固定版本构建，使用 Next.js、FastAPI 和 SQLite。

目前可完成：空白创建或粘贴简历、文件导入、结构化编辑、JD 要求校对、证据匹配、单段建议审阅、独立定向版本、前后对比、中文 PDF 导出，以及三类岗位统计图表。AI 解析、STAR 改写和市场解读已接入现有模型配置；本次未提供模型凭据，实际模型质量验收尚待完成。

## 本机运行

访问 **http://127.0.0.1:3000**。接口文档在 **http://127.0.0.1:8000/docs**。

本轮构建已在 macOS Apple Silicon 上运行，实际环境为 Python 3.13.15、Node.js 24.19.0、npm 11.6.2、uv 0.12.10。依赖由 `app/apps/backend/uv.lock` 和 `app/apps/frontend/package-lock.json` 固定。

重新安装或在新机器启动，需要先准备 Python 3.13、Node.js 22 或 24、npm 和 uv。Node.js 22 是上游 Docker 基础版本，本机验证使用 24。安装依赖前先停止正在运行的开发服务。

```bash
cd /path/to/careerlens
bash scripts/setup.sh
bash scripts/dev.sh
```

`setup.sh` 安装前后端依赖及 PDF 导出所需的 Chromium，初始化空数据库。首次安装需要网络；前端构建会下载 Google Fonts。Linux 导出中文时需安装 Noto CJK 字体和 Playwright 的系统依赖。`dev.sh` 将服务绑定到本机，按 Ctrl+C 停止。

启动日志保存在 `.local/logs/backend.log` 和 `.local/logs/frontend.log`，可在另一个终端运行 `tail -f .local/logs/backend.log .local/logs/frontend.log` 查看。首次启动等后端日志出现 `Application startup complete`、前端日志出现 `Ready` 后打开页面。端口固定为 8000 和 3000；启动失败时先查看日志及端口占用。

本次机器缺少全局 Node.js、npm 和 uv，已使用本机现有运行环境，并在忽略目录 `.local/runtime.env` 中配置了启动脚本所需路径。该文件不进入 Git，新机器按常规方式安装以上工具即可。

也可以在两个终端分别启动：

```bash
# 终端一
cd app/apps/backend
uv run --frozen python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

```bash
# 终端二，从工程根目录开始
cd app/apps/frontend
npm run dev -- --hostname 127.0.0.1
```

## 模型配置

在页面右上角进入“配置模型”，选择提供商，填写模型标识、API Key；自定义兼容接口填写 Base URL。保存并使用设置页的连接测试，再返回首页启用“使用 AI 辅助”。复用上游的加密密钥存储，凭据不会出现在诊断 JSON 中。

未启用 AI 时，规则匹配、编辑、事实整理、版本管理、统计和 PDF 导出正常工作。页面明确显示“规则与事实整理模式”。启用远程模型后，所选材料会发送给配置的服务；只录入获准用于该服务的材料。

AI 草稿提供逐句引用，并检查新增数字、词表内技能和占位符。角色、因果关系及成果含义仍须本人核对，采纳前有事实确认步骤。缺失信息不会自动补写为个人经历。

## 首次体验

1. 点击“试用虚构示例”，载入一份虚构简历和 12 条虚构岗位；已有个人简历不会被覆盖。
2. 在“我的简历”中查看或编辑，再到“目标岗位”选择“数据分析实习生”。
3. 进入“诊断与优化”，选择基础简历和该岗位，点击“开始诊断”。示例覆盖度为 **71.4**；SQL 仅有技能自述，Tableau 为待确认。
4. 选择一段经历，填写本人可以确认的事实，审阅来源。采纳后生成独立定向版，可比较同一 JD 下的覆盖度并导出 PDF。
5. 在“市场观察”中勾选“包含虚构示例”体验图表。默认统计排除虚构数据。

继续优化第二个段落时，选择刚生成的定向版重新诊断，再生成下一条建议。同一基础版上的多条建议各自生成独立版本。

## 数据与初始化

数据库自动创建在 `app/apps/backend/data/resume_matcher.db`。SQLite 数据库、原始个人材料、密钥、缓存和 `.env` 均被 Git 忽略。请将整个后端 `data/` 目录作为本机数据备份；备份时停止服务，使数据库和密钥文件保持一致。

```bash
cd app/apps/backend
# 幂等初始化；去掉 --demo 即为空库初始化
uv run --frozen python -m app.scripts.career_data init --demo
# 导入 JSON 岗位数组，逐条校验来源与要求引用
uv run --frozen python -m app.scripts.career_data import-jobs /absolute/path/jobs.json
# 从实际 ORM 重新生成建表 SQL
uv run --frozen python -m app.scripts.career_data schema /absolute/path/schema.sql
```

格式见 [示例数据说明](data/README.md)。岗位删除会清理对应诊断与建议；简历删除会清理对应快照、诊断、建议和修改记录。其他独立简历版本保留，删除前页面会说明范围。整个工作区重置入口沿用设置页。

这是本地个人工作区，不含多人账号隔离。课程中的不同学生案例使用各自的 `DATA_DIR` 启动测试，避免混入同一个人的简历版本。

## 验证与构建

```bash
cd app/apps/backend
uv run --frozen --extra dev pytest
```

```bash
cd app/apps/frontend
npm run lint
npm run typecheck
npm test
npm run build
```

服务启动后，在根目录运行 `python3 scripts/smoke.py`，可通过真实 HTTP 接口验证解析、匹配、采纳、重复请求、复评及一页／多页 PDF 导出。脚本只清理自己创建的虚构测试记录，输出保存在 `.local/qa/`。实际结果与已保存截图见 [验证记录](docs/验证记录.md)。

## Docker

根目录提供本项目的源码构建配置，不拉取上游应用成品镜像：

```bash
docker compose up --build -d
```

数据持久化在 `careerlens-data` 卷，访问本机 3000 端口。本轮环境没有可用的 Docker Compose／守护进程，因此容器构建与重建持久化尚未实测；当前已验证的是本地进程运行方式。

## Git 与工程说明

根目录采用一个 Git 仓库，`app/` 是导入的上游源码，没有嵌套仓库。`main` 上按方案、基线、后端、前端及交付文件分阶段提交。`upstream` 指向原项目，尚未设置个人 GitHub 远程仓库。

本次本地提交作者为 `Codex <codex@localhost>`，仅设置在此仓库。团队后续可以通过 `git config user.name` 和 `git config user.email` 设置自己的提交身份。密钥和个人简历不随提交共享。

- [开源来源与改动范围](UPSTREAM.md)
- [架构、数据库与接口](docs/架构与接口.md)
- [实际验证结果及剩余验收](docs/验证记录.md)
- [AI 辅助开发过程记录](docs/AI使用记录.md)
- [原构建计划与当前状态](CareerLens_构建计划.md)

课程调研中的真实 JD、经同意使用的学生简历、招聘 APP 体验记录，以及个人报告和演示视频，需要团队继续提供并完成。仓库中的虚构数据用于软件验证，不替代这些课程材料。
