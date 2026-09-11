# CareerLens

CareerLens 是一个开源的 AI 简历诊断与岗位匹配系统，将简历编辑、岗位分析、经历改写和文档导出放在同一个工作区，帮助求职者梳理经历，并针对目标岗位准备简历。

[在线使用](https://careerlens.cc) · [运行指南](docs/系统运行说明.md) · [网站部署](docs/网站部署指南.md) · [配置与依赖](docs/配置与依赖说明.md)

## 主要功能

- **简历管理**：新建简历，导入 PDF、Word 或文本，编辑结构化内容，管理照片、章节和多个版本。
- **岗位匹配**：保存 JD，逐项关联已有经历，展示匹配理由和待补充信息，支持多个岗位横向比较。
- **AI 诊断与改写**：分析适合的岗位方向，直接生成可采用的经历正文，展示修改差异，采纳后创建独立定向版。
- **模板与导出**：提供 10 种可选版式，调整字体、字号和间距，按内容自动排版，导出 PDF 或可编辑 Word。预览时可整体收起上方工具栏。
- **岗位搜索与统计**：接入国内校招、国际远程及企业招聘来源，查看完整 JD、技能与薪资分布，并保存分析历史。
- **账户与数据管理**：本地模式无需账号；网站模式支持邮箱验证码登录、账号数据隔离、积分流水和个人设置。

AI 功能使用配置的模型服务。关闭 AI 后，仍可编辑简历、进行规则匹配、管理版本和导出文档。实时招聘数据来自外部平台，查询结果以来源页面为准。

## 快速启动

### Docker

安装 Docker Engine 或 Docker Desktop，并启用 Docker Compose v2：

```bash
git clone https://github.com/1subtle/careerlens.git
cd careerlens
docker compose up --build -d
```

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)。首次构建会下载依赖、字体、Chromium 和语义检索模型，需要联网。容器内包含前端、后端与 PDF 运行环境，数据保存在 Docker 卷中。

### 本地源码

准备 **Python 3.13、Node.js 22、npm 和 uv 0.12.10**，在项目根目录执行：

```bash
bash scripts/setup.sh
bash scripts/dev.sh
```

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)；API 文档位于 [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)。按 Ctrl+C 停止服务。Linux 系统依赖、Windows WSL2、端口调整和故障处理见[运行指南](docs/系统运行说明.md)。

本地 AI 配置入口为侧栏“模型设置”。网站部署由运营者通过环境变量配置模型、邮件和认证服务，参见[网站部署指南](docs/网站部署指南.md)。

## 使用流程

1. 创建或导入简历，核对内容后保存。
2. 粘贴目标 JD，或从实时岗位中选择并保存。
3. 查看匹配分析，补充相关经历，选择段落直接改写。
4. 审阅并采纳正文，生成针对目标岗位的新版本。
5. 选择模板、调整排版，导出简历。

## 技术组成

| 部分 | 技术 |
| --- | --- |
| 前端 | Next.js、React、TypeScript、Tailwind CSS、Tiptap、ECharts |
| 后端 | FastAPI、Pydantic、SQLAlchemy、SQLite |
| AI 接入 | LiteLLM，支持多个云端提供商及兼容接口 |
| 语义检索 | multilingual-e5-small、ONNX Runtime，本地推理 |
| 文档导出 | Playwright / Chromium PDF、python-docx |
| 部署 | Docker Compose、Caddy HTTPS |

前端以 `package-lock.json`、后端以 `uv.lock` 固定依赖。精确版本与配置项见[配置与依赖说明](docs/配置与依赖说明.md)。

## 项目结构

```text
careerlens/
├── app/apps/frontend/     # 前端源码、静态资源与测试
├── app/apps/backend/      # 后端源码、数据库迁移与测试
├── app/docker/            # 容器启动与启动流程检查
├── app/Dockerfile         # 从源码构建完整应用
├── scripts/               # 安装、启动、验证和源码打包脚本
├── data/examples/         # 可用于验证的虚构示例数据
├── deploy/                # HTTPS 反向代理配置
├── docs/                  # 运行、部署、配置、架构与验证说明
├── licenses/              # 第三方许可
├── compose.yaml           # 本地容器运行
└── compose.hosted.yaml    # 网站模式部署
```

## 开发与交付

运行测试和生产构建的方法见[验证说明](docs/验证说明.md)。生成与 Git 提交一致的源码压缩包：

```bash
python3 scripts/package_source.py
```

输出位于 `dist/`，包含源码、配置示例、依赖锁文件、运行文档及文件校验清单。实际密钥、个人数据库、已安装依赖和缓存不进入源码包；安装步骤会根据锁文件准备运行环境。

## 许可与来源

项目采用 [Apache-2.0](LICENSE) 许可。部分基础能力来自 Resume Matcher，其他复用与参考项目见[来源说明](UPSTREAM.md)。
