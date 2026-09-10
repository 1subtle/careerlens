# CareerLens API 接口文档

版本：v1.2；核对日期：2026-09-09。本文按当前路由与 Pydantic schema 编写，对应实训第 3 天 API 规划、第 4 天接口联调和第 5 天闭环验收。接口示例采用虚构材料与示意 ID，不是运行结果。

## 1. 通用约定

业务基路径统一为 **`/api/v1`**。后文路径均已包含该前缀；HTTP 根路径 `/` 另返回服务名称、版本和文档入口。浏览器使用同源转发；JSON 请求设置 `Content-Type: application/json`，文件导入使用 multipart，PDF/DOCX 响应为二进制附件。当前没有统一的 `code/data/message` 包装，CareerLens 多数接口直接返回对象，上游接口按其 response model 包装。

本地模式在后端 `/docs`、`/redoc` 和 `/openapi.json` 查看运行契约；网站模式关闭上述三个入口并返回 404。完整路由索引见第 8 节，可复用联调脚本见第 9 节，字段最终依据为 [career schema](../app/apps/backend/app/schemas/career.py)、[通用 schema](../app/apps/backend/app/schemas/models.py) 和对应路由实现。分层、事务及持久化设计见 [后端与数据库设计文档](后端与数据库设计文档.md)。

本文覆盖的已注册业务接口成功均使用 **HTTP 200**，包括创建和删除；没有统一改用 201 或 204。错误根据具体条件返回第 1.2 节状态。除说明的文件外，响应媒体类型为 `application/json`；本地和网站使用同一业务契约，但权限和积分规则不同。

### 1.1 网站身份与来源

网站模式使用邮箱验证码与 Cookie 会话，业务身份由服务端会话决定，请求不传 `user_id` 或数据库位置。仅 `/health`、`/auth/session`、`/auth/email/start`、`/auth/email/verify`、`/auth/logout` 为公开接口；其他 API（包括 `/auth/credits`）需要有效登录，否则返回 401。所有非 GET/HEAD/OPTIONS API 请求必须携带与 `CAREERLENS_PUBLIC_URL` 规范化来源一致的 `Origin`，错误来源返回 403。浏览器同源请求会自动处理该头部；直接使用客户端联调时须显式提供来源和保存的 Cookie。

网站 `/api/v1/config/*` 由管理员统一管理，普通网站请求返回 403；唯一例外是已登录用户可 `GET /api/v1/config/language`。网站 API 响应使用 `Cache-Control:no-store`。本地模式无需登录。

### 1.2 错误契约

表 1-1 HTTP 错误与处理约定

| 状态 | 常见触发条件 | 调用端处理 |
| --- | --- | --- |
| 400 | 验证码无效/过期、操作缺少确认标识 | 修正请求或重新获取验证码 |
| 401 | 网站会话缺失/失效，或无当前账号时读取积分 | 返回登录流程；local 不读取账号积分 |
| 402 | 网站积分不足，不能开始下一次模型生成 | 刷新积分；保留材料，停止自动重试，可主动选择规则功能 |
| 403 | Origin 不符；网站配置接口受限 | 从本站操作，配置由运营方处理 |
| 404 | 当前用户工作区无目标记录；网站文档入口关闭 | 刷新列表或检查路径 |
| 409 | 编辑版本变化、分析材料变化、草稿冲突、缓存过期 | 重载材料，再诊断或生成建议 |
| 413 | Career 文件超过 5 MiB | 压缩文件或粘贴文本 |
| 422 | schema、引用、图片、格式、AI 前提不合法 | 显示字段错误并保留输入 |
| 429 | 验证码频控或招聘缓存容量限制 | 遵循 Retry-After（如提供） |
| 502 | 模型输出/来源核验或外部岗位服务失败 | 按功能重试或切换规则模式 |
| 503 | SQLite 写竞争、SMTP/登录服务或 PDF 渲染暂不可用 | 稍后重试；写竞争附 Retry-After:1 |
| 504 | 明确映射为超时的 AI/招聘操作期限用尽 | 结束加载，重试或减少输入 |
| 500 | 上游保留接口未归类的服务异常 | 保存请求上下文并查日志，不能当成成功 |

典型业务错误为 `{"detail":"简历已在其他页面修改，请重新载入后保存。"}`。Pydantic 通常返回 `detail` 数组，部分配置接口使用对象；认证校验统一返回简短字符串以避免回显验证码。上游上传操作若已保存简历，错误响应可能另外包含 `resume_id`、`is_master`，前端应使用该身份恢复处理，不因失败再次创建重复材料。

### 1.3 主流程的失败与恢复

表 1-2 接口级失败分支

| 操作 | 特有失败与保存结果 | 恢复方式 |
| --- | --- | --- |
| 文本简历 AI 解析 | 未配置模型 422；模型失败及 60 秒外层超时统一 502；不保存简历 | 保留客户端原文，可主动改 rules |
| 文件解析 | 超限 413，类型/解码/无法提取文字 422；非积分 AI 错误返回 200+rules+warning；CreditError 原样返回 | 保留文件；检查 warning，校对规则草稿再保存 |
| JD AI 抽取 | 结果、引用或模型失败 502；积分错误原样传播；不保存 JD | 改规则抽取，人工校对 requirements |
| 单岗/多岗诊断 | 材料不存在 404，无可分析证据/模型未配置 422，AI失败502、预算150/180秒超时504、保存前变更409 | 失败不保存这一批诊断；重新读材料，刷新积分后由用户决定重试 |
| 语义候选 | 本地模型未准备或30秒期限失败 | 仍可200返回规则结果，retrieval.mode=unavailable，不将候选自动计分 |
| 证据/条件核对 | 404；引用、无来源支持或JD未声明条件422；材料变化409 | 保留旧记录，重新诊断后核对 |
| 方向推荐 | use_ai=false/前提不足422，材料变化409，模型502，150秒超时504 | 不持久化独立推荐历史，重新读取材料后再分析 |
| 生成改写 | 无诊断404、非经历/简介证据422、核验或模型失败502、150秒超时504、分析记录在生成中删除409 | 失败不保存草稿；原文保留，补充事实或重读诊断 |
| 采纳/拒绝 | 状态不允许、材料过期、旧AI草稿未核验、结果已删除409 | 不重复创建；重新诊断生成，或读取已采纳结果 |
| 实时查询/记住 | 上游502/504、参数422、缓存满429、记住缓存失效409 | 保持原查询 keyword/provider/geo 再搜索，详情完整后记住 |
| 市场解读 | 筛选理解/建议检查502、60秒超时504、积分错误原样返回 | 单独调用 market/summary 或保留 live/jobs.summary；错误响应本身不附成功统计 |
| 业务复合写 | SQLite 竞争503，Retry-After:1 | 完成中的读/分析可能已耗时或积分；勿无条件重复全部AI操作 |

所有 hosted 业务操作还受 401/403 身份与来源检查；调用模型时还可能出现 402/503 积分错误。整个业务请求失败与某次模型调用退款是两个判断层次，详见第 2.1 节。幂等只适用于明确说明的操作，当前没有通用 Idempotency-Key 请求头支持。

## 2. 认证与积分接口

表 2-1 认证与积分契约（成功均为 HTTP 200）

| 方法与路径 | 请求与身份 | 成功响应 | 主要失败与重试语义 |
| --- | --- | --- | --- |
| `GET /api/v1/auth/session` | 无；公开 | `Session`，匿名 `user=null` | 503 认证库暂不可用；重复读取无副作用 |
| `GET /api/v1/auth/credits` | 无；须当前账号 | `CreditBalance` | 401 无身份、503 积分服务异常；local 也返回 401 |
| `POST /api/v1/auth/email/start` | `EmailInput`；公开但 hosted 检查 Origin | `EmailChallenge` | 422 格式、429 频控、503 邮件未配置或发送失败；发送操作不是幂等操作 |
| `POST /api/v1/auth/email/verify` | `VerifyInput`；公开但 hosted 检查 Origin | `Session` 并设置 Cookie | 400 无效/过期/耗尽、422 格式、local 为 404；挑战消费后不能重复验证 |
| `POST /api/v1/auth/logout` | 无 body；可匿名 | `Session`，user=null，删除 Cookie | 已退出时再次调用仍返回匿名状态；不删除工作区 |

表 2-2 认证请求字段

| 模型/字段 | 类型 | 必填 | 默认与限制 |
| --- | --- | --- | --- |
| EmailInput.email | string | 是 | 3—254 字符；去首尾空格、转小写；邮箱本地部分最多 64；校验邮箱格式 |
| VerifyInput.email | string | 是 | 与 EmailInput 相同 |
| VerifyInput.challenge_id | string | 是 | 32—64；`^[A-Za-z0-9_-]+$`；必须来自本次 start 响应 |
| VerifyInput.code | string | 是 | `^[0-9]{6}$`，保留可能的前导零 |

认证请求禁止额外字段，错误 422 不回显输入。验证码有效 600 秒，每个挑战最多尝试 5 次；同邮箱间隔 60 秒、每小时最多 5 次、每日最多 10 次，IP 摘要每小时最多 20 次、每日最多 100 次。成功送达的新挑战使更旧挑战失效，成功验证消费该邮箱的有效挑战。

表 2-3 认证响应对象

| 对象 | 字段与类型 |
| --- | --- |
| Session | `mode:"local"/"hosted"`；`user:null` 或 `{id:string,email:string,credits:integer}`；`email_login_available:boolean`；`github_url:string/null` |
| EmailChallenge | `challenge_id:string,email:string,retry_after_seconds:integer,expires_in_seconds:integer`；默认后两者 60、600 |
| CreditBalance | `balance:integer,signup_grant:integer,cost_per_generation:integer`；当前单次生成成本 1 |

登录成功设置 7 天不透明会话。HTTPS Cookie 名为 `__Host-careerlens_session`，本机 HTTP 测试使用 `careerlens_session`；属性为 HttpOnly、SameSite=Lax、Path=/，HTTPS 加 Secure。Cookie jar 应交由 HTTP 客户端管理，不把 Cookie 值作为业务参数。`github_url` 是项目外链，不是 GitHub OAuth。

完整 session 示意响应（非实测）：

```json
{
  "mode": "hosted",
  "user": {
    "id": "00000000-0000-4000-8000-000000000001",
    "email": "student@example.com",
    "credits": 20
  },
  "email_login_available": true,
  "github_url": null
}
```

积分查询示意响应为 `{"balance":18,"signup_grant":20,"cost_per_generation":1}`。初始赠送由 `CAREERLENS_SIGNUP_CREDITS` 配置，默认 20；账号首次验证及旧账号迁移使用一次性赠送，重新登录或重启不会补满。当前没有购买、充值或管理员增发的 HTTP 接口。

### 2.1 积分计费与错误传播

网站模式在 `complete` / `complete_json` 开始时预扣 1 积分，该次调用成功返回即保留扣款，内部重试包括在这一次中；该次调用抛错或取消时退回预扣。一个页面操作可能顺序或并行执行多次独立生成：例如改写生成和独立事实核验通常需要两次；重新生成、再次核验、多岗比较或市场两阶段解读可能增加次数。**不能把一次 HTTP 请求解释为固定扣 1 积分，也不能把请求失败解释为整笔退费。** 已成功步骤保留扣款，下一阶段余额不足时返回 402，未必产生最终业务记录。

```json
{"detail":"免费积分已用完，暂时无法继续使用 AI 功能"}
```

余额为零时规则诊断、本地语义候选、材料读写、采纳已保存草稿及文档导出仍可使用。纯规则路径不计积分；local 模式不计账号积分。CareerLens AI 接口将 CreditError 原样传播，文件 AI 解析遇积分不足也返回 402，不自动伪装为规则解析成功。业务接口成功响应不统一附余额，页面应在 AI 操作后重新读取 `/auth/credits` 或 `/auth/session`。

## 3. 材料接口

### 3.1 简历与工作区

表 3-1 简历主流程（成功均为 HTTP 200）

| 方法与路径 | 请求与限制 | 成功响应 |
| --- | --- | --- |
| `GET /api/v1/career/state` | 无 | `resumes,jobs,matches,model,semantic,rule_version`；诊断摘要最多 100 条 |
| `POST /api/v1/career/demo` | 无 | 显式载入虚构示例后的 state；不覆盖个人材料 |
| `POST /api/v1/career/resumes/parse` | `text` 1—30,000 字符、非纯空白；`use_ai=false` | `{data,source_text,mode}`；返回草稿，不入库 |
| `POST /api/v1/career/resumes/file` | multipart `file,use_ai=false`；PDF/DOCX/TXT/MD，5 MiB | 同 parse；非积分 AI 失败可返回 rules + warning；积分错误直接返回 |
| `POST /api/v1/career/resumes` | `ResumeInput` | 创建后的简历对象 |
| `PUT /api/v1/career/resumes/{resume_id}` | `ResumeInput`，建议带 `expected_revision` | 更新后的简历对象；冲突 409 |
| `DELETE /api/v1/career/resumes/{resume_id}` | 无 | `{"deleted":true}`；不存在 404 |

state 的 `resumes` 为 Resume[]，`jobs` 为 Job[]，均按创建时间倒序；`matches` 为最多 100 个 `{id,score,job_id,created_at}` 摘要，不含完整证据。`model` 为 `{provider:string,model:string,configured:boolean}`；`semantic` 为 `{ready:boolean,model:string,revision:string}`；`rule_version` 为当前规则版本。GET state 不运行模型。demo 仅在简历列表为空时增加示例简历，并按岗位去重规则追加示例 JD；重复调用不覆盖现有个人材料。

表 3-2 解析与简历保存请求字段

| 模型/字段 | 类型 | 必填 | 默认、上限与语义 |
| --- | --- | --- | --- |
| TextInput.text | string | 是 | 1—30,000；去首尾空格，拒绝纯空白；用于简历/JD 解析 |
| TextInput.use_ai | boolean | 否 | false；true 调用模型，网站计积分 |
| 文件 file | binary / multipart | 是 | 文件名扩展 PDF/DOCX/TXT/MD；最大 5×1024×1024 字节；TXT/MD 以 UTF-8 解码 |
| 文件 use_ai | boolean / multipart | 否 | false；不要把文件改用 JSON Base64 提交 |
| ResumeInput.title | string | 否 | “我的简历”；1—120 字符 |
| ResumeInput.data | ResumeData | 是 | 完整结构化对象；缺少章节按其 schema 补默认 |
| ResumeInput.source_text | string | 否 | 空字符串；最多 30,000；创建时空值改用序列化结构正文保存，更新时显式空值会清空原文 |
| ResumeInput.expected_hash | string/null | 否 | null；更新兼容条件；不包含版式；无长度上限声明 |
| ResumeInput.expected_revision | string/null | 否 | null；更新时优先；覆盖版式；无长度上限声明 |
| ResumeInput.template_settings | TemplateSettings/null | 否 | null；创建时不提供则存 null，更新省略则保留，显式 null 清除 |

`ResumeInput` 包含 `title`（1—120，默认“我的简历”）、`data:ResumeData`、可选 `source_text`（最多 30,000）、`expected_hash`、`expected_revision` 和 `template_settings`。更新时 `expected_revision` 优先于 `expected_hash`；前者覆盖排版，后者不包含排版。两个条件都省略时不检查这一编辑冲突。更新时省略原文或排版则保留，显式 `template_settings:null` 则清空已存排版。

`ResumeData` 包括 `personalInfo,summary,workExperience,education,personalProjects,additional,sectionMeta,customSections`，未提供的章节按 schema 默认值填充。照片字段 `personalInfo.photo` 仅接收有效 PNG/JPEG data URL，解码后上限 1 MiB，最长边 1,600，总像素 200 万；无独立“上传照片”后端路由。

表 3-3 ResumeData 嵌套结构

| 字段 | 默认与子字段 |
| --- | --- |
| personalInfo | 默认对象；`name,title,email,phone,location` 默认空字符串，`website,linkedin,github,photo` 可为 null |
| summary | string，默认空字符串 |
| workExperience[] | 默认 []；每项 `id:integer=0,title:string="",company:string="",location:string/null,years:string="",description:string[]=[],descriptionStyles:(bullet/plain)[]=[]` |
| education[] | 默认 []；每项 `id:integer=0,institution,degree,years` 默认空字符串，`description:string/null` |
| personalProjects[] | 默认 []；每项 `id:integer=0,name,role,years` 默认空字符串，`github,website:string/null`，`description:string[]`、`descriptionStyles` 默认 [] |
| additional | 默认对象；`technicalSkills,languages,certificationsTraining,awards` 均默认 [] |
| sectionMeta[] | 默认 []；非空项需 `id,key,displayName,sectionType`；`isDefault=true,isVisible=true,order=0` |
| customSections | 默认 {}；字典值为 CustomSection，按 `sectionType` 保存 text/strings/items，详见 [models.py](../app/apps/backend/app/schemas/models.py) |

描述行样式与描述数组由模型规范化对齐。上述大多文字字段没有单独的 max_length 声明，不能将 30,000 字符的原文限制推定为整个嵌套 JSON 的统一限制；通用 AI 层另检查提示词大小。Career 常规模型默认忽略未知字段，TemplateSettings 与认证模型明确禁止额外字段。

创建请求示例：

```json
{
  "title": "数据分析求职简历",
  "data": {
    "personalInfo": {"name": "林同学", "email": "student@example.com"},
    "summary": "参与课程数据分析项目，使用 Python 清洗数据并整理图表。",
    "additional": {"technicalSkills": ["Python", "SQL"]}
  },
  "source_text": "林同学，参与课程数据分析项目。",
  "template_settings": {"template": "swiss-single", "pageSize": "A4"}
}
```

解析 `{data,source_text,mode}` 中 `mode` 为 rules/ai；仅文件的可恢复失败会额外出现 `warning`，草稿不因此入库。创建简历每次成功生成新 ID，不具备重复请求去重；主简历标记由服务端当前工作区状态决定。

简历成功响应字段为 `id,title,data,template_settings,hash,revision,is_master,parent_id,created_at,updated_at,source_text`。以下为摘录：

```json
{
  "id": "r-example",
  "title": "数据分析求职简历",
  "hash": "<服务端内容指纹>",
  "revision": "<服务端完整编辑指纹>",
  "is_master": true,
  "parent_id": null
}
```

### 3.2 JD 录入与校对

表 3-4 JD 接口（成功均为 HTTP 200）

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `POST /api/v1/career/jobs/parse` | `text,use_ai=false` | `{requirements,mode}`；不保存岗位 |
| `POST /api/v1/career/jobs` | `JobInput` | 岗位对象，来源重复时复用既有记录 |
| `PUT /api/v1/career/jobs/{job_id}` | `JobInput` | 更新后的岗位；当前无版本条件参数 |
| `DELETE /api/v1/career/jobs/{job_id}` | 无 | `{"deleted":true}` |

表 3-5 JobInput 完整字段

| 字段 | 类型 | 必填 | 默认与限制 |
| --- | --- | --- | --- |
| text | string | 是 | 1—30,000，去首尾空格、拒绝空白；响应改名 content |
| title | string | 是 | 1—120 |
| use_ai | boolean | 否 | false；为继承字段，保存本身不据此调用 AI，应先调用 jobs/parse |
| company | string | 否 | 空字符串，最多 120 |
| category | string | 否 | “其他”，最多 60 |
| city | string | 否 | 空字符串，最多 60 |
| salary_text | string | 否 | 空字符串，最多 120 |
| source_url | string | 否 | 空字符串，最多 2,000；schema 为字符串而非 URL 类型 |
| source_type | enum | 否 | manual；manual/course/synthetic/api |
| source_name | string | 否 | 空字符串，最多 120 |
| external_id | string | 否 | 空字符串，最多 100 |
| source_updated_at / published_at | date/null | 否 | null；JSON 用 YYYY-MM-DD |
| requirements | Requirement[]/null | 否 | null，最多 60；null/省略则规则抽取，[] 则保持空要求 |

表 3-6 Requirement 字段

| 字段 | 类型 | 必填 | 默认与限制 |
| --- | --- | --- | --- |
| id | string | 是 | 1—100，在同份 JD 内唯一 |
| name | string | 是 | 1—100，去首尾空格、常见技能别名归一，归一后名称唯一 |
| source_text | string | 是 | 1—3,000，必须为本份 text 的连续子串 |
| priority | enum | 否 | required；仅 required/preferred |

`JobInput` 必填 `title,text`，可选 `company,category,city,salary_text,source_url,source_type,source_name,external_id,source_updated_at,published_at,requirements,use_ai`。`source_type` 为 `manual/course/synthetic/api`；日期是 `YYYY-MM-DD` 或 null。要求最多 60 项，ID 和规范化名称不得重复，`source_text` 必须是正文连续子串，`priority` 为 `required/preferred`。省略 requirements 时后端按规则生成；提交空数组表示当前没有有效要求。

```json
{
  "title": "数据分析实习生",
  "text": "使用 Python 清洗数据，掌握 SQL，了解 Tableau 者优先。",
  "company": "示例企业",
  "category": "数据分析",
  "source_type": "manual",
  "requirements": [
    {"id": "q1", "name": "Python", "source_text": "使用 Python 清洗数据", "priority": "required"},
    {"id": "q2", "name": "SQL", "source_text": "掌握 SQL", "priority": "required"},
    {"id": "q3", "name": "Tableau", "source_text": "了解 Tableau 者优先", "priority": "preferred"}
  ]
}
```

岗位响应使用 `job_id` 和 `content`，不是请求的 `text`；其余已保存属性从 `metadata_json` 展开，并包含创建时间。保存另生成 `collected_at` 并设置 `role=title`。source_type=api 且 source_name、external_id 均非空时按二者去重；其余材料按相同正文和公司去重，重复创建返回已有 JD，不覆盖已有校对内容。更新是全对象保存，未提交可选元数据将使用 schema 默认，不是 PATCH；当前没有 expected_hash/revision。来源查询的 fetched_at 不在 JobInput 中，保存后不会自动保留；published_at、source_updated_at、collected_at 分别是发布、来源更新和保存时间。数据关系见 [后端与数据库设计文档](后端与数据库设计文档.md)。

## 4. 诊断、方向和人工核对

表 4-1 诊断接口（成功均为 HTTP 200）

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `POST /api/v1/career/matches` | `{resume_id,job_id,use_semantic:false,use_ai:false}` | 一条完整诊断 |
| `POST /api/v1/career/matches/compare` | `{resume_id,job_ids,use_semantic:false,use_ai:false}`；2—5 个不同 ID | `snapshot_id,resume_hash,matches[]` |
| `GET /api/v1/career/matches/{match_id}` | 无 | 完整诊断 + `stale,rewrites[]` |
| `POST /api/v1/career/matches/{match_id}/review` | `{requirement_id,status,evidence_ids:[]}` | 新诊断；原记录保留 |
| `POST /api/v1/career/matches/{match_id}/conditions` | `{name,status,observed}` | 新诊断，规则分值不因条件确认改变 |
| `POST /api/v1/career/directions` | `{resume_id,use_ai:true}` | `directions,saved_jobs,summary,evidence,resume_hash,scope_note` 及模型信息 |

表 4-2 诊断与核对请求字段

| 模型/字段 | 类型 | 必填 | 默认与限制 |
| --- | --- | --- | --- |
| MatchInput.resume_id / job_id | string | 是 | 当前工作区已保存 ID；未额外声明格式或长度 |
| MatchInput.use_semantic / use_ai | boolean | 否 | 均 false；二者独立开关 |
| CompareInput.resume_id | string | 是 | 同上 |
| CompareInput.job_ids | string[] | 是 | 2—5 个且互不重复 |
| CompareInput.use_semantic / use_ai | boolean | 否 | 均 false |
| ReviewInput.requirement_id | string | 是 | 来自当前诊断 details[].id |
| ReviewInput.status | enum | 是 | supported/mentioned/pending/gap |
| ReviewInput.evidence_ids | string[] | 否 | []，最多 20，全部属于本快照；支持/提及须非空 |
| ConditionReviewInput.name | enum | 是 | 学历要求/经验要求/到岗与实习时长 |
| ConditionReviewInput.status | enum | 是 | met/unmet/unknown |
| ConditionReviewInput.observed | string | 是 | 1—1,000，去首尾空格、拒绝空白 |
| DirectionsInput.resume_id | string | 是 | 当前工作区已保存 ID |
| DirectionsInput.use_ai | boolean | 否 | true；显式 false 返回 422 |

诊断响应字段为 `id,resume_id,snapshot_id,resume_hash,resume_data,evidence,job_id,job,job_hash,details,conditions,score,rule_version,created_at,retrieval,ai_analysis`。`score` 为规则覆盖度，空要求时 null；AI `fit_score` 在 `ai_analysis` 内，二者语义不同。禁用 AI 时 `ai_analysis=null`。多岗比较共用快照并整体提交；输入变化返回 409。

表 4-3 Match 与 Evidence 响应结构

| 对象 | 字段与约束 |
| --- | --- |
| Match 标识 | `id,resume_id,snapshot_id,resume_hash,job_id,job_hash,rule_version,created_at` 均为 string |
| Match 冻结内容 | `resume_data:ResumeData,evidence:Evidence[],job:Job,details:Detail[],conditions:Condition[]` |
| Match 计算结果 | `score:number/null,ai_analysis:Assessment/null,retrieval:object`；GET 详情另加 `stale:boolean,rewrites:Rewrite[]`，POST 响应不含这两个字段 |
| Compare 响应 | `resume_id,resume_hash,snapshot_id,rule_version,matches[]`；所有记录共用一次快照，顺序跟随 job_ids |
| Evidence | `id,section_id,title,text,kind,source_hash` 为 string；`path` 为 string/integer 组成的数组；规则 kind 为 experience/skill/summary，AI 还可增加 background |
| Detail | Requirement 字段，加 `weight:number,value:number,contribution:number,status,evidence_ids:string[],reason:string,candidates:object[],retrieval:object` |
| Candidate | `evidence_id:string,similarity:number`；用于展示候选，不能据此自动改分 |
| Condition | `name,requirement,status,observed`；status 为 met/unmet/unknown/not_stated；人工确认另加 `confirmed_by:"user",confirmed_at:string` |
| retrieval | mode 为 off/vector/unavailable；启用语义时还含模型准备状态与版本信息；失败时含 message，规则诊断仍可成功 |

要求状态为 `supported/mentioned/pending/gap`。确认 `supported` 必须至少选择一条当前快照经历证据；`mentioned` 同样须有引用。`evidence_ids` 最多 20 项，不能引用其他诊断材料。条件名仅为“学历要求”“经验要求”“到岗与实习时长”，状态为 `met/unmet/unknown`，`observed` 为 1—1,000 字符且非纯空白。JD 未声明的条件不能强行确认。

请求示例：

```json
{"resume_id":"r-example","job_id":"j-example","use_semantic":false,"use_ai":false}
```

响应中一项规则明细的结构示例（数值仅用于说明单项满分场景）：

```json
{
  "score": 100.0,
  "rule_version": "career-1.1",
  "ai_analysis": null,
  "details": [{
    "id": "q1", "name": "Python", "source_text": "使用 Python 清洗数据",
    "priority": "required", "weight": 2, "value": 1, "contribution": 100.0,
    "status": "supported", "evidence_ids": ["e-example"],
    "reason": "经历中提供了应用证据", "candidates": [], "retrieval": {"mode": "off"}
  }]
}
```

诊断快照的 resume_hash 仅覆盖规范化的结构化正文；JD 的 job_hash 覆盖当时的 job_view（含来源/时间等元数据），不包括内部保存的 `_ai_analysis`。接口把 `_ai_analysis` 拆为顶层 ai_analysis，job 中不暴露这个内部键。与此不同，方向推荐的 resume_hash 使用编辑 hash，覆盖结构化正文、原文、标题，仍不包含版式。

人工核对和条件确认每次成功都会新建诊断 ID，共用原快照，复制原 AI 结论而不再次运行 AI；调用方应选中响应的新 ID。supported/mentioned 之外的状态会清空 evidence_ids。分析、核对与采纳比较的是结构化正文/JD；只改标题、原文或版式不自动使旧匹配 stale，但方向推荐会检查标题与原文变化。只改版式仍可采纳，结果继承源简历的当前版式。

表 4-4 AI 诊断与方向响应子对象

| 对象 | 结构与上限 |
| --- | --- |
| Assessment | `fit_score:number[0,100],summary:string≤2000,strengths:Finding[]≤5,gaps:Finding[]≤5,actions:Action[1..5],fact_check,mode,provider,model,analyzed_at,score_note` |
| Finding | `title:string[1..120],detail:string[1..1600],resume_refs:ResumeRef[]≤8,jd_refs:JDRef[1..8]`；优势还须有简历引用 |
| ResumeRef / JDRef | `{evidence_id,quote}` / `{quote}`；quote 1—3,000，服务端检查为对应原文连续子串 |
| Action | Finding 加 `action_type:expression/verify_fact/practice`；标题由服务端增加类型标签 |
| AI fact_check | `status:"checked",method:"quotes+source_review",checks:[{path,source_quotes[]}]` |
| Directions 响应 | `summary,directions[1..4],saved_jobs[0..5],fact_check,mode,provider,model,analyzed_at,scope_note,resume_id,resume_hash,evidence[]` |
| Direction | `title:string[1..80],reason:string[1..1600],resume_refs[1..8],next_steps[1..4]` |
| SavedJob | `job_id,reason,resume_refs,jd_refs`，再由服务端补齐 `title,company,source_url` |

照片可存在于已保存简历与返回的完整快照中；Career 诊断、方向和段落改写的模型输入取文字证据，不把照片作为经历或能力依据。

AI 输出使用 [career_diagnosis.py](../app/apps/backend/app/services/career_diagnosis.py) 中禁止额外字段的模型校验。规则 S 按加权证据值计算并保留一位小数；AI fit_score 是独立模型判断，不能由规则数值推导或当作录用概率。

方向推荐必须启用 AI 且存在可分析材料。具体岗位仅从当前用户最新 20 条非 course/synthetic JD 中选取并回填来源，不生成任意招聘链接；当前不保存独立推荐历史。

### 4.1 完整规则诊断响应示意

以下示例展示一次单要求诊断的全部顶层结构，姓名、ID、时间及哈希为示意；这不是服务器实测输出。客户端应读取服务返回的 ID 和证据列表，不通过数组位置自行推定可改写 ID。

```json
{
  "id": "match-example",
  "resume_id": "resume-example",
  "snapshot_id": "snapshot-example",
  "resume_hash": "<结构化正文指纹>",
  "resume_data": {
    "personalInfo": {"name": "林同学", "title": "", "email": "student@example.com", "phone": "", "location": "", "website": null, "linkedin": null, "github": null},
    "summary": "",
    "workExperience": [],
    "education": [],
    "personalProjects": [{"id": 1, "name": "课程数据分析", "role": "团队成员", "years": "", "github": null, "website": null, "description": ["使用 Python 清洗课程问卷数据并绘制图表。"], "descriptionStyles": ["bullet"]}],
    "additional": {"technicalSkills": [], "languages": [], "certificationsTraining": [], "awards": []},
    "sectionMeta": [],
    "customSections": {}
  },
  "evidence": [{
    "id": "personalProjects:0:0",
    "section_id": "personalProjects:0:0",
    "title": "课程数据分析",
    "text": "使用 Python 清洗课程问卷数据并绘制图表。",
    "kind": "experience",
    "path": ["personalProjects", 0, "description", 0],
    "source_hash": "<该句正文指纹>"
  }],
  "job_id": "job-example",
  "job": {
    "job_id": "job-example", "content": "使用 Python 清洗数据。",
    "title": "数据分析实习生", "company": "示例企业", "category": "数据分析", "city": "",
    "salary_text": "", "source_url": "", "source_type": "manual", "source_name": "", "external_id": "",
    "source_updated_at": null, "published_at": null,
    "requirements": [{"id": "q1", "name": "Python", "source_text": "使用 Python 清洗数据", "priority": "required"}],
    "collected_at": "2026-09-09T00:00:00+00:00", "role": "数据分析实习生", "created_at": "2026-09-09T00:00:00+00:00"
  },
  "ai_analysis": null,
  "job_hash": "<完整job_view指纹>",
  "details": [{
    "id": "q1", "name": "Python", "source_text": "使用 Python 清洗数据", "priority": "required",
    "weight": 2, "value": 1.0, "contribution": 100.0, "status": "supported",
    "evidence_ids": ["personalProjects:0:0"], "reason": "<服务端规则说明>", "candidates": [], "retrieval": {"mode": "off"}
  }],
  "conditions": [
    {"name": "学历要求", "requirement": "<规则提取说明>", "status": "not_stated", "observed": "<规则说明>"},
    {"name": "经验要求", "requirement": "<规则提取说明>", "status": "not_stated", "observed": "<规则说明>"},
    {"name": "到岗与实习时长", "requirement": "<规则提取说明>", "status": "not_stated", "observed": "<规则说明>"}
  ],
  "score": 100.0,
  "rule_version": "career-1.1",
  "created_at": "2026-09-09T00:00:00+00:00",
  "retrieval": {"mode": "off"}
}
```

GET 此记录时才增加 stale 与 rewrites；POST review/conditions 返回新记录的同一基本结构。ai_analysis 非 null 时，使用表 4-4 的完整 Assessment 子结构，不把模型字段拼入规则 details。

## 5. 改写接口

表 5-1 改写与采纳契约（成功均为 HTTP 200）

| 方法与路径 | 请求 | 成功响应与状态 |
| --- | --- | --- |
| `POST /api/v1/career/rewrites` | `{match_id,section_id,facts:[],use_ai:false}` | 建议对象，初始 `status=draft` |
| `POST /api/v1/career/rewrites/{rewrite_id}/apply` | `{"confirmed":true}` | `{resume,rewrite}`，建议 accepted；重复请求返回同一结果 |
| `POST /api/v1/career/rewrites/{rewrite_id}/reject` | 无 | 建议对象，状态 rejected |

表 5-2 改写请求与响应子字段

| 字段 | 类型 | 必填/默认与上限 |
| --- | --- | --- |
| RewriteInput.match_id / section_id | string | 必填；当前诊断 ID 和该快照中可改写的 evidence.id |
| RewriteInput.facts | string[] | 默认 []；最多 8，每项最多 1,000；去空白、去重 |
| RewriteInput.use_ai | boolean | 默认 false |
| ApplyInput.confirmed | boolean literal | 必填且只能 true；false/省略不合法 |
| Rewrite 基本信息 | object | `id,match_id,section_id,facts,status,result_resume_id,created_at`；结果 ID 在采纳前或结果删除后为 null |
| draft / reason / missing_facts | string/string/string[] | draft 1—5,000，reason≤2,000，missing_facts 最多 8；来自已校验草稿 |
| claims[] | object[] | 1—20；每项 `text` 1—2,000、`source_ids` 1—10 |
| sources[] | object[] | `{id,text,type}`，type 为 resume/user；本人事实 ID 使用 fact:索引 |
| model / mode / analyzed_at | object/null，enum，string | model 在 rules 为 null，在 ai 为 `{provider,model,configured}`；mode 为 rules/ai |
| improvement | object | `{status:rules/improved/unchanged,summary:string,retried:boolean}` |
| changes[] | object[] | `{text,type:expression/user_fact,source_ids[]}`，只要引用本人事实就标 user_fact |
| source_hash | string | 本次 sources 指纹，不等于简历编辑 hash |
| fact_check（AI） | object | `status:"checked",method:"rules+source_review",model,verdicts[],improvement`；规则模式不要求该字段 |
| fact_check.verdicts[] | object[] | `{index:integer,supported:boolean,source_quotes:string[],reason:string}`；每句覆盖且均受来源支持 |
| fact_check.improvement | object | `{meaningful:boolean,reason:string}`，区别于顶层 improvement |

`section_id` 实际填写诊断 `evidence[]` 中可改写条目的 `id`，限经历或简介。`facts` 最多 8 条，每条最多 1,000 字符，去除空白项并去重。建议响应将 `payload` 展开为顶层：包含 `id,match_id,section_id,facts,draft,claims,sources,reason,missing_facts,status,result_resume_id,created_at`，AI 模式还提供事实核验和改善结果。

```json
{
  "match_id": "m-example",
  "section_id": "e-example",
  "facts": ["本人负责数据清洗，课程项目没有上线。"],
  "use_ai": true
}
```

`claims` 每项包含 `text,source_ids[]`，引用必须覆盖整个草稿。只有通过当前检查的 draft 可采纳；材料变化、已拒绝、历史 AI 草稿未核验返回 409。采纳不会覆盖原简历，而创建带 `parent_id` 的独立定向版；已采纳结果被删除后重复操作返回 409，不重复造回已删除版本。生成建议 POST 本身不幂等，多次调用会新建多个草稿且 AI 模式分别计费；只有 apply 对同一个 rewrite_id 幂等。拒绝 draft 或 rejected 返回 rejected，拒绝 accepted 返回 409。对过期历史诊断可以生成草稿，但采纳阶段仍校验当前材料；页面应先检查 GET match 的 stale 以避免无效生成。

### 5.1 规则改写响应示意

以下展示顶层 payload 展开关系；AI 模式额外包含表 5-2 的 fact_check，不能用该规则示例冒充完成 AI 核验。

```json
{
  "id": "rewrite-example", "match_id": "match-example", "section_id": "personalProjects:0:0", "facts": [],
  "draft": "使用 Python 清洗课程问卷数据并绘制图表。",
  "claims": [{"text": "使用 Python 清洗课程问卷数据并绘制图表", "source_ids": ["personalProjects:0:0"]}],
  "missing_facts": ["当时的具体任务或问题是什么？", "你本人完成了哪些操作，使用了什么工具？", "有哪些可以确认的数据规模、产出或结果？"],
  "reason": "<服务端按目标要求生成的整理说明>",
  "sources": [{"id": "personalProjects:0:0", "text": "使用 Python 清洗课程问卷数据并绘制图表。", "type": "resume"}],
  "mode": "rules", "model": null, "analyzed_at": "2026-09-09T00:00:00+00:00",
  "improvement": {"status": "rules", "summary": "按顺序整理已知事实，未调用 AI 优化结构。", "retried": false},
  "source_hash": "<sources指纹>",
  "changes": [{"text": "使用 Python 清洗课程问卷数据并绘制图表", "type": "expression", "source_ids": ["personalProjects:0:0"]}],
  "status": "draft", "result_resume_id": null, "created_at": "2026-09-09T00:00:00+00:00"
}
```

采纳返回 `{resume:Resume,rewrite:Rewrite}`，其中 rewrite.status=accepted，rewrite.result_resume_id 与 resume.id 相同，resume.parent_id 指向原简历；其他字段见第 3 节。采纳响应的简历 data 已替换目标句，原快照与原简历不变。

## 6. 实时岗位与市场统计

表 6-1 招聘来源和样本接口（成功均为 HTTP 200）

| 方法与路径 | 参数 | 成功响应 |
| --- | --- | --- |
| `GET /api/v1/career/live/jobs` | query `keyword="",page=1,provider=ncss,geo=""` | `jobs,summary,total,total_kind,cached,fetched_at,warnings` 等，来源可能有扩展字段 |
| `POST /api/v1/career/live/jobs/{post_id}/remember` | query `provider=ncss,keyword="",geo=""` | 保存后的 JD |
| `POST /api/v1/career/live/analyze` | `jobs[],question,use_ai=false` | 本页 `summary,points,advice,mode,job_ids` 等 |
| `POST /api/v1/career/market/summary` | `category="",city="",since=null,include_demo=false` | `count,skills,salaries,distribution,dataset_hash,job_ids` 等 |
| `POST /api/v1/career/market/analyze` | 同筛选，增加 `question,use_ai=false` | `summary,points,advice,mode,job_ids` 等 |

表 6-2 招聘与市场请求字段

| 请求字段 | 类型 | 必填 | 默认与限制 |
| --- | --- | --- | --- |
| live/jobs.keyword | string/query | 否 | 空字符串；最多 100，来源层去首尾空格 |
| live/jobs.page | integer/query | 否 | 1；1—100 |
| provider | enum/query | 否 | ncss；ncss/jobicy/tencent |
| geo | enum/query | 否 | 空字符串；空/all/china/usa/europe；NCSS 限空/all/china，腾讯限空/all |
| remember.post_id | string/path | 是 | 1—64 位字母数字；非 NCSS 还须 1—30 位数字 |
| remember.keyword / geo | 同查询 | 否 | 与取得该岗位的查询匹配；记住接口无 page 字段 |
| MarketFilter.category / city | string | 否 | 空字符串；各最多 60，非空按精确值过滤 |
| MarketFilter.since | date/null | 否 | null；JSON 使用 YYYY-MM-DD |
| MarketFilter.include_demo | boolean | 否 | false；仅控制 synthetic，不自动排除 course |
| MarketQuestion.question | string | 否 | “这些岗位有哪些共同要求？”；1—1,000 |
| MarketQuestion.use_ai | boolean | 否 | false |
| LiveMarketQuestion.jobs | LiveJobInput[] | 是 | 0—10，空数组合法；每项 JobInput 加 description_complete |
| LiveJobInput.description_complete | boolean literal | 否 | true；false 被拒绝 |
| LiveMarketQuestion.question / use_ai | 同上 | 否 | 同上；本页分析不接收 category/city/since/include_demo 筛选字段 |

`provider` 为 `ncss/jobicy/tencent`；关键词最多 100 字符，页码 1—100，`geo` 为 `""/all/china/usa/europe`，腾讯只接受空值或 all。记住岗位 ID 为 1—64 位字母数字；非 NCSS ID 还需为 1—30 位数字。NCSS/Jobicy 的记住操作使用匹配查询条件的有效缓存，失效时重新检索。

本页分析最多 10 条 `LiveJobInput`，每项继承 JobInput 并要求 `description_complete:true`。问题 1—1,000 字符，默认“这些岗位有哪些共同要求？”。市场默认排除 synthetic，设置 since 后排除日期未知样本。薪资不做币种或周期强制折算。`dataset_hash` 是当前样本标识，不是可恢复的统计数据库记录。

表 6-3 招聘查询响应

| 字段 | 类型与来源差异 |
| --- | --- |
| provider/source_name/source_url | string，来源标识与公开来源链接 |
| fetched_at/cached | string/boolean；缓存命中保留原抓取时间，不改成此次点击时间 |
| total/total_kind | integer；NCSS capped、Jobicy sample、腾讯 platform，分别表示来源计数上限、当前批次样本、单平台范围 |
| page/page_size/jobs | integer/integer/LiveJob[]；当前每页 10 条 |
| has_more | boolean，仅 NCSS 明确返回；不能要求其他来源一定有此字段 |
| coverage/update_note/warnings | string/string/string[]，解释来源覆盖与缺失详情 |
| summary | MarketSummary，仅按已取得完整 JD 的本页岗位计算 |
| LiveJob | Job 元数据及 content、job_id、external_id、description_complete、来源时间等；字段随来源扩展，不能将全部字段原样当作 JobInput.text |

NCSS 缓存 300 秒，按关键词和页码索引；Jobicy 缓存 3,600 秒，按关键词和地区保存最多 200 条样本再分页；两者缓存项最多 32。腾讯按需请求详情。NCSS/Jobicy 记住必须命中有效完整详情缓存，缺失/过期通常 409，Jobicy 同批次内不存在 ID 返回 404。腾讯记住重新拉取详情。一次查询的 total 与 summary.count 不应比较为同一分母。

表 6-4 MarketSummary 响应

| 字段 | 类型与含义 |
| --- | --- |
| count/salary_missing/demo_count | integer；去重后岗位数、无可比较薪资数、其中 synthetic 数 |
| skills[] | `{name:string,value:integer,job_ids:string[]}`，总体最多 30 项，按岗位计数 |
| salaries[] | `{raw,currency,period,min,max,mid,job_id,category,title}`；仅包含可靠解析结果，period 为 day/month/year |
| distribution[] | `{category,count,skills:[{name,count,percent}]}`，类别内分母为该类别岗位数；percent 保留一位小数 |
| filters | object，实际使用的筛选；live/jobs 的 summary 通常传空对象，market 传补齐默认值后的筛选 |
| dataset_hash/job_ids/date | string/string[]/YYYY-MM-DD；当前样本指纹、岗位标识和统计 UTC 日期 |

Market analyze 返回 `{summary,points:string[],advice:string,mode:rules/ai,job_ids}`。AI 可将 question 映射到已有 category/city 并覆盖原筛选，其他过滤条件保留，最终以 summary.filters 为准；所有计数来自确定性统计。本页分析会根据 text 重算 requirements，即使客户端传入过要求也不会直接照用；临时 job_id 根据来源/外部编号构造，不等于数据库 JD ID。

```http
GET /api/v1/career/live/jobs?provider=ncss&keyword=Python&page=1
```

## 7. 导出与基础能力

表 7-1 导出契约（成功均为 HTTP 200）

| 路径 | 关键参数与响应 |
| --- | --- |
| `GET /api/v1/resumes/{resume_id}/pdf` | query `template,pageSize,marginTop,marginBottom,marginLeft,marginRight,sectionSpacing,itemSpacing,lineHeight,fontSize,headerScale,headerFont,bodyFont,compactMode,showContactIcons,accentColor,lang`；返回 application/pdf |
| `GET /api/v1/resumes/{resume_id}/docx` | query `lang=zh`，读取已保存正文/照片/排版；返回 Word MIME 附件 |
| `GET /api/v1/resumes/{resume_id}/cover-letter/pdf` | 求职信 PDF，参数以第 8 节路由为准 |

表 7-2 PDF 查询字段（除 resume_id 外均可省略）

| 字段 | 类型 | 默认 | 校验 |
| --- | --- | --- | --- |
| resume_id | string/path | 必填 | 当前工作区存在记录 |
| template | string | swiss-single | 路由为普通 str；客户端应限定为 TemplateSettings 支持的 7 个模板，不能声称该 query 已做枚举校验 |
| pageSize | string | A4 | A4/LETTER |
| marginTop/Bottom/Left/Right | integer | 10 | 各 5—25，单位 mm |
| sectionSpacing/itemSpacing | integer | 3/2 | 1—5 |
| lineHeight/fontSize/headerScale | integer | 3/3/3 | 1—5 |
| headerFont/bodyFont | string | serif/sans-serif | serif/sans-serif/mono |
| compactMode/showContactIcons | boolean | false/false | 布尔查询值 |
| accentColor | string | blue | blue/green/orange/red |
| lang | string/null | null | `^[a-z]{2}(-[A-Z]{2})?$`；建议中文导出显式 zh |

TemplateSettings 支持 swiss-single、swiss-two-column、modern、modern-two-column、latex、clean、vivid。保存设置默认：template=swiss-single、pageSize=A4；margins 四边14；spacing.section=4、item=3、lineHeight=4；fontSize.base=4、headerScale=3、headerFont/bodyFont=sans-serif；compactMode/showContactIcons=false、accentColor=blue。设置对象及其子对象禁止额外字段。

PDF 页边距为 5—25 mm，间距与字号等级为 1—5，页面 A4/LETTER，字体 serif/sans-serif/mono，颜色 blue/green/orange/red。PDF 路由默认 margin 为 10、sectionSpacing=3、itemSpacing=2、lineHeight=3、fontSize=3；保存排版的 `TemplateSettings` 有自己的默认值，因此前端需把已保存参数显式传给 PDF。DOCX 从存储设置读取，唯一 query 为 `lang:string=zh`，使用相同语言格式校验；缺少正文或图片/排版无效返回 422，记录不存在返回 404。Word MIME 为 `application/vnd.openxmlformats-officedocument.wordprocessingml.document`，Content-Disposition 同时提供 ASCII 文件名和编码后的 UTF-8 标题，响应 no-store。PDF 为 application/pdf，文件名 resume_ID.pdf，渲染失败 503。`cover-letter/pdf` 只接收 `pageSize=A4,lang=null`，无求职信或简历为 404，渲染失败 503。

导出读取服务端已保存正文，不接收未保存的 data JSON。PDF 版式取查询参数，DOCX 版式取已保存 template_settings，前端/联调需显式映射参数以保持一致。网站 PDF 为当前请求创建隔离打印上下文，仅向内部打印来源传递当前 Cookie，不绕过身份检查。照片与身份实现见 [后端与数据库设计文档](后端与数据库设计文档.md)。

配置接口在本地模式管理模型与密钥。`PUT /config/llm-api-key` 保存提供商、模型、Base URL 和推理参数，不持久化该请求中的 api_key；密钥使用 `POST /config/api-keys` 单独保存。删除全部密钥需 query `confirm=CLEAR_ALL_KEYS`，重置需 body `{"confirm":"RESET_ALL_DATA"}`。`GET /health` 只做存活检查；`GET /status` 在 local 探测 LLM，在 hosted 只检查模型是否配置及本账号数据库摘要，不调用付费模型。hosted 的 llm_healthy=false 表示未做实时探测，不等于模型已故障；status=ready 的条件为模型已配置且有主简历。返回 `{status,llm_configured,llm_healthy,has_master_resume,database_stats}`，摘要包含 total_resumes/total_jobs/total_improvements/has_master_resume。

上游 `/resumes/improve*` 是整份优化流程，`/career/rewrites*` 是当前证据驱动的单段改写流程，两者契约不同。简历向导、增强、投递追踪、求职信及面试准备继续通过已保留接口提供。完整覆盖见下节，不以主工作区菜单是否显示决定路由是否存在。

### 7.1 页面与资源映射

表 7-3 页面动作与接口资源

| 页面/操作 | 使用接口 | 状态处理 |
| --- | --- | --- |
| 登录与积分展示 | auth/session、email/start、email/verify、auth/credits、logout | 保留挑战与重发倒计时；401清空账号状态，402刷新余额 |
| 我的简历 | career/state、resumes/parse/file、POST/PUT career/resumes | 解析草稿由用户确认，保存后刷新 id/hash/revision |
| 目标岗位/JD记忆 | jobs/parse、POST/PUT/DELETE career/jobs | 记住后使用 job_id，不把实时临时 job_id 当数据库ID |
| 诊断与比较 | matches、matches/compare、GET matches/{id} | 保留 snapshot_id，GET获取stale和草稿历史 |
| 证据/条件核对 | matches/{id}/review、conditions | 成功切换到新match_id；旧结果保留 |
| 段落优化与版本对照 | rewrites、apply、reject | 生成并非幂等；采纳后选中响应resume.id并复评 |
| 实时岗位与本页统计 | live/jobs、remember、live/analyze | 保留provider/keyword/geo；显示来源差异与完整性 |
| 版式、预览与导出 | PUT career/resumes、resumes/{id}/pdf、docx | 保存revision；PDF传版式参数，DOCX读已存设置 |
| 上游编辑/增强/追踪 | 第8节的resumes、enrichment、applications等 | 按各自模型，不套用CareerLens扁平响应 |

上游保留接口仍属于实际 API 覆盖范围。`POST /jobs/upload` 用 JobUploadRequest 批量建立JD；`POST /resumes/upload` 可能先建立处理中的简历，须保留响应身份；`/resumes/improve/preview` 与 `/confirm` 使用服务返回的预览状态，不等同于 Career 单段采纳。`/enrichment/apply-regenerated/{id}` 的 body 是 RegeneratedItem 数组，不是带 regenerated_items 的外层对象。投递状态采用 saved/applied/no_response/response/interview/accepted/rejected，批量操作返回 message 与 affected。完整入参模型见各路由链接及 [schemas](../app/apps/backend/app/schemas/)。

## 8. 当前全部业务路由索引

下表从当前 main.py 注册的 11 组路由逐项核对。成功码为当前路由默认值；类型声明和实现可定位到源码。框架 Request/Response 对象不属于客户端参数。主流程详细字段、失败与状态语义见前七节，表中上游模型由 [schemas](../app/apps/backend/app/schemas/) 定义。
### 8.1 认证与积分

表 8-1 认证与积分路由

| 方法与完整路径 | 成功码 | 客户端入参 | 响应声明 | 实现 |
| --- | --- | --- | --- | --- |
| `GET /api/v1/auth/session` | 200 | 无 | `JSON对象` | [session](../app/apps/backend/app/auth.py#L361) |
| `GET /api/v1/auth/credits` | 200 | 无 | `JSON对象` | [credits](../app/apps/backend/app/auth.py#L367) |
| `POST /api/v1/auth/email/start` | 200 | `payload: EmailInput` | `JSON对象` | [start](../app/apps/backend/app/auth.py#L378) |
| `POST /api/v1/auth/email/verify` | 200 | `payload: VerifyInput` | `JSON对象` | [verify](../app/apps/backend/app/auth.py#L403) |
| `POST /api/v1/auth/logout` | 200 | 无 | `JSON对象` | [logout](../app/apps/backend/app/auth.py#L428) |

### 8.2 CareerLens 核心

表 8-2 CareerLens 核心路由

| 方法与完整路径 | 成功码 | 客户端入参 | 响应声明 | 实现 |
| --- | --- | --- | --- | --- |
| `POST /api/v1/career/demo` | 200 | 无 | `dict[str, Any]` | [load_demo](../app/apps/backend/app/routers/career.py#L58) |
| `GET /api/v1/career/state` | 200 | 无 | `dict[str, Any]` | [state](../app/apps/backend/app/routers/career.py#L139) |
| `POST /api/v1/career/resumes/parse` | 200 | `request: TextInput` | `dict[str, Any]` | [parse_resume](../app/apps/backend/app/routers/career.py#L171) |
| `POST /api/v1/career/resumes/file` | 200 | `file: UploadFile`<br>`use_ai: bool` | `dict[str, Any]` | [parse_file](../app/apps/backend/app/routers/career.py#L197) |
| `POST /api/v1/career/resumes` | 200 | `request: ResumeInput` | `dict[str, Any]` | [create_resume](../app/apps/backend/app/routers/career.py#L230) |
| `PUT /api/v1/career/resumes/{resume_id}` | 200 | `resume_id: str`<br>`request: ResumeInput` | `dict[str, Any]` | [update_resume](../app/apps/backend/app/routers/career.py#L248) |
| `DELETE /api/v1/career/resumes/{resume_id}` | 200 | `resume_id: str` | `dict[str, bool]` | [remove_resume](../app/apps/backend/app/routers/career.py#L279) |
| `POST /api/v1/career/jobs/parse` | 200 | `request: TextInput` | `dict[str, Any]` | [parse_job](../app/apps/backend/app/routers/career.py#L288) |
| `POST /api/v1/career/jobs` | 200 | `request: JobInput` | `dict[str, Any]` | [create_job](../app/apps/backend/app/routers/career.py#L400) |
| `PUT /api/v1/career/jobs/{job_id}` | 200 | `job_id: str`<br>`request: JobInput` | `dict[str, Any]` | [update_job](../app/apps/backend/app/routers/career.py#L405) |
| `DELETE /api/v1/career/jobs/{job_id}` | 200 | `job_id: str` | `dict[str, bool]` | [remove_job](../app/apps/backend/app/routers/career.py#L410) |
| `POST /api/v1/career/matches` | 200 | `request: MatchInput` | `dict[str, Any]` | [calculate_match](../app/apps/backend/app/routers/career.py#L417) |
| `POST /api/v1/career/matches/compare` | 200 | `request: CompareInput` | `dict[str, Any]` | [compare_matches](../app/apps/backend/app/routers/career.py#L426) |
| `POST /api/v1/career/directions` | 200 | `request: DirectionsInput` | `dict[str, Any]` | [recommend_directions](../app/apps/backend/app/routers/career.py#L586) |
| `GET /api/v1/career/matches/{match_id}` | 200 | `match_id: str` | `dict[str, Any]` | [get_match](../app/apps/backend/app/routers/career.py#L637) |
| `POST /api/v1/career/matches/{match_id}/review` | 200 | `match_id: str`<br>`request: ReviewInput` | `dict[str, Any]` | [review_match](../app/apps/backend/app/routers/career.py#L661) |
| `POST /api/v1/career/matches/{match_id}/conditions` | 200 | `match_id: str`<br>`request: ConditionReviewInput` | `dict[str, Any]` | [review_condition](../app/apps/backend/app/routers/career.py#L713) |
| `POST /api/v1/career/rewrites` | 200 | `request: RewriteInput` | `dict[str, Any]` | [create_rewrite](../app/apps/backend/app/routers/career.py#L769) |
| `POST /api/v1/career/rewrites/{rewrite_id}/apply` | 200 | `rewrite_id: str`<br>`request: ApplyInput` | `dict[str, Any]` | [apply_rewrite](../app/apps/backend/app/routers/career.py#L827) |
| `POST /api/v1/career/rewrites/{rewrite_id}/reject` | 200 | `rewrite_id: str` | `dict[str, Any]` | [reject_rewrite](../app/apps/backend/app/routers/career.py#L911) |
| `POST /api/v1/career/market/summary` | 200 | `request: MarketFilter` | `dict[str, Any]` | [get_market](../app/apps/backend/app/routers/career.py#L929) |
| `POST /api/v1/career/market/analyze` | 200 | `request: MarketQuestion` | `dict[str, Any]` | [analyze_market](../app/apps/backend/app/routers/career.py#L934) |

### 8.3 实时岗位

表 8-3 实时岗位路由

| 方法与完整路径 | 成功码 | 客户端入参 | 响应声明 | 实现 |
| --- | --- | --- | --- | --- |
| `GET /api/v1/career/live/jobs` | 200 | `keyword: str`<br>`page: int`<br>`provider: Provider`<br>`geo: jobicy.Geography` | `dict[str, Any]` | [live_jobs](../app/apps/backend/app/routers/recruitment.py#L20) |
| `POST /api/v1/career/live/jobs/{post_id}/remember` | 200 | `post_id: str`<br>`provider: Provider`<br>`keyword: str`<br>`geo: jobicy.Geography` | `dict[str, Any]` | [remember_job](../app/apps/backend/app/routers/recruitment.py#L40) |
| `POST /api/v1/career/live/analyze` | 200 | `request: LiveMarketQuestion` | `dict[str, Any]` | [analyze_live_jobs](../app/apps/backend/app/routers/recruitment.py#L65) |

### 8.4 健康状态

表 8-4 健康状态路由

| 方法与完整路径 | 成功码 | 客户端入参 | 响应声明 | 实现 |
| --- | --- | --- | --- | --- |
| `GET /api/v1/health` | 200 | 无 | `HealthResponse` | [health_check](../app/apps/backend/app/routers/health.py#L27) |
| `GET /api/v1/status` | 200 | 无 | `StatusResponse` | [get_status](../app/apps/backend/app/routers/health.py#L36) |

### 8.5 模型与配置

表 8-5 模型与配置路由

| 方法与完整路径 | 成功码 | 客户端入参 | 响应声明 | 实现 |
| --- | --- | --- | --- | --- |
| `GET /api/v1/config/llm-api-key` | 200 | 无 | `LLMConfigResponse` | [get_llm_config_endpoint](../app/apps/backend/app/routers/config.py#L115) |
| `PUT /api/v1/config/llm-api-key` | 200 | `request: LLMConfigRequest`<br>`background_tasks: BackgroundTasks` | `LLMConfigResponse` | [update_llm_config](../app/apps/backend/app/routers/config.py#L131) |
| `POST /api/v1/config/llm-test` | 200 | `request: LLMConfigRequest \| None` | `dict` | [test_llm_connection](../app/apps/backend/app/routers/config.py#L216) |
| `GET /api/v1/config/features` | 200 | 无 | `FeatureConfigResponse` | [get_feature_config](../app/apps/backend/app/routers/config.py#L259) |
| `PUT /api/v1/config/features` | 200 | `request: FeatureConfigRequest` | `FeatureConfigResponse` | [update_feature_config](../app/apps/backend/app/routers/config.py#L271) |
| `GET /api/v1/config/language` | 200 | 无 | `LanguageConfigResponse` | [get_language_config](../app/apps/backend/app/routers/config.py#L298) |
| `PUT /api/v1/config/language` | 200 | `request: LanguageConfigRequest` | `LanguageConfigResponse` | [update_language_config](../app/apps/backend/app/routers/config.py#L313) |
| `GET /api/v1/config/prompts` | 200 | 无 | `PromptConfigResponse` | [get_prompt_config](../app/apps/backend/app/routers/config.py#L351) |
| `PUT /api/v1/config/prompts` | 200 | `request: PromptConfigRequest` | `PromptConfigResponse` | [update_prompt_config](../app/apps/backend/app/routers/config.py#L367) |
| `GET /api/v1/config/feature-prompts` | 200 | 无 | `FeaturePromptsResponse` | [get_feature_prompts](../app/apps/backend/app/routers/config.py#L399) |
| `PUT /api/v1/config/feature-prompts` | 200 | `request: FeaturePromptsRequest` | `FeaturePromptsResponse` | [update_feature_prompts](../app/apps/backend/app/routers/config.py#L416) |
| `GET /api/v1/config/api-keys` | 200 | 无 | `ApiKeyStatusResponse` | [get_api_keys_status](../app/apps/backend/app/routers/config.py#L496) |
| `POST /api/v1/config/api-keys` | 200 | `request: ApiKeysUpdateRequest` | `ApiKeysUpdateResponse` | [update_api_keys](../app/apps/backend/app/routers/config.py#L519) |
| `DELETE /api/v1/config/api-keys` | 200 | `confirm: str \| None` | `dict` | [delete_all_api_keys](../app/apps/backend/app/routers/config.py#L602) |
| `DELETE /api/v1/config/api-keys/{provider}` | 200 | `provider: str` | `dict` | [delete_api_key](../app/apps/backend/app/routers/config.py#L628) |
| `POST /api/v1/config/reset` | 200 | `request: ResetDatabaseRequest` | `dict` | [reset_database_endpoint](../app/apps/backend/app/routers/config.py#L650) |

### 8.6 上游简历

表 8-6 上游简历路由

| 方法与完整路径 | 成功码 | 客户端入参 | 响应声明 | 实现 |
| --- | --- | --- | --- | --- |
| `POST /api/v1/resumes/upload` | 200 | `file: UploadFile` | `ResumeUploadResponse` | [upload_resume](../app/apps/backend/app/routers/resumes.py#L910) |
| `GET /api/v1/resumes` | 200 | `resume_id: str` | `ResumeFetchResponse` | [get_resume](../app/apps/backend/app/routers/resumes.py#L1055) |
| `GET /api/v1/resumes/list` | 200 | `include_master: bool` | `ResumeListResponse` | [list_resumes](../app/apps/backend/app/routers/resumes.py#L1109) |
| `POST /api/v1/resumes/improve/preview` | 200 | `request: ImproveResumeRequest` | `ImproveResumeResponse` | [improve_resume_preview_endpoint](../app/apps/backend/app/routers/resumes.py#L1135) |
| `POST /api/v1/resumes/improve/confirm` | 200 | `request: ImproveResumeConfirmRequest` | `ImproveResumeResponse` | [improve_resume_confirm_endpoint](../app/apps/backend/app/routers/resumes.py#L1475) |
| `POST /api/v1/resumes/improve` | 200 | `request: ImproveResumeRequest` | `ImproveResumeResponse` | [improve_resume_endpoint](../app/apps/backend/app/routers/resumes.py#L1636) |
| `PATCH /api/v1/resumes/{resume_id}` | 200 | `resume_id: str`<br>`resume_data: ResumeData` | `ResumeFetchResponse` | [update_resume_endpoint](../app/apps/backend/app/routers/resumes.py#L1906) |
| `GET /api/v1/resumes/{resume_id}/pdf` | 200 | `resume_id`；完整query见表7-2 | `Response` | [download_resume_pdf](../app/apps/backend/app/routers/resumes.py#L1963) |
| `DELETE /api/v1/resumes/{resume_id}` | 200 | `resume_id: str` | `dict` | [delete_resume](../app/apps/backend/app/routers/resumes.py#L2046) |
| `POST /api/v1/resumes/{resume_id}/retry-processing` | 200 | `resume_id: str` | `ResumeUploadResponse` | [retry_processing](../app/apps/backend/app/routers/resumes.py#L2055) |
| `PATCH /api/v1/resumes/{resume_id}/cover-letter` | 200 | `resume_id: str`<br>`request: UpdateCoverLetterRequest` | `dict` | [update_cover_letter](../app/apps/backend/app/routers/resumes.py#L2154) |
| `PATCH /api/v1/resumes/{resume_id}/outreach-message` | 200 | `resume_id: str`<br>`request: UpdateOutreachMessageRequest` | `dict` | [update_outreach_message](../app/apps/backend/app/routers/resumes.py#L2167) |
| `PATCH /api/v1/resumes/{resume_id}/title` | 200 | `resume_id: str`<br>`request: UpdateTitleRequest` | `dict` | [update_title](../app/apps/backend/app/routers/resumes.py#L2180) |
| `POST /api/v1/resumes/{resume_id}/generate-cover-letter` | 200 | `resume_id: str` | `GenerateContentResponse` | [generate_cover_letter_endpoint](../app/apps/backend/app/routers/resumes.py#L2194) |
| `POST /api/v1/resumes/{resume_id}/generate-outreach` | 200 | `resume_id: str` | `GenerateContentResponse` | [generate_outreach_endpoint](../app/apps/backend/app/routers/resumes.py#L2268) |
| `POST /api/v1/resumes/{resume_id}/generate-interview-prep` | 200 | `resume_id: str` | `GenerateInterviewPrepResponse` | [generate_interview_prep_endpoint](../app/apps/backend/app/routers/resumes.py#L2345) |
| `GET /api/v1/resumes/{resume_id}/job-description` | 200 | `resume_id: str` | `dict` | [get_job_description_for_resume](../app/apps/backend/app/routers/resumes.py#L2412) |
| `GET /api/v1/resumes/{resume_id}/cover-letter/pdf` | 200 | `resume_id: str`<br>`pageSize: str`<br>`lang: str \| None` | `Response` | [download_cover_letter_pdf](../app/apps/backend/app/routers/resumes.py#L2454) |

### 8.7 Word 导出

表 8-7 Word 导出路由

| 方法与完整路径 | 成功码 | 客户端入参 | 响应声明 | 实现 |
| --- | --- | --- | --- | --- |
| `GET /api/v1/resumes/{resume_id}/docx` | 200 | `resume_id: str`<br>`lang: str` | `Response` | [download_resume_docx](../app/apps/backend/app/routers/resume_exports.py#L20) |

### 8.8 上游 JD

表 8-8 上游 JD路由

| 方法与完整路径 | 成功码 | 客户端入参 | 响应声明 | 实现 |
| --- | --- | --- | --- | --- |
| `POST /api/v1/jobs/upload` | 200 | `request: JobUploadRequest` | `JobUploadResponse` | [upload_job_descriptions](../app/apps/backend/app/routers/jobs.py#L15) |
| `GET /api/v1/jobs/{job_id}` | 200 | `job_id: str` | `dict` | [get_job](../app/apps/backend/app/routers/jobs.py#L54) |

### 8.9 经历增强

表 8-9 经历增强路由

| 方法与完整路径 | 成功码 | 客户端入参 | 响应声明 | 实现 |
| --- | --- | --- | --- | --- |
| `POST /api/v1/enrichment/analyze/{resume_id}` | 200 | `resume_id: str` | `AnalysisResponse` | [analyze_resume](../app/apps/backend/app/routers/enrichment.py#L151) |
| `POST /api/v1/enrichment/enhance` | 200 | `request: EnhanceRequest` | `EnhancementPreview` | [generate_enhancements](../app/apps/backend/app/routers/enrichment.py#L246) |
| `POST /api/v1/enrichment/apply/{resume_id}` | 200 | `resume_id: str`<br>`request: ApplyEnhancementsRequest` | `dict` | [apply_enhancements](../app/apps/backend/app/routers/enrichment.py#L436) |
| `POST /api/v1/enrichment/regenerate` | 200 | `request: RegenerateRequest` | `RegenerateResponse` | [regenerate_items](../app/apps/backend/app/routers/enrichment.py#L601) |
| `POST /api/v1/enrichment/apply-regenerated/{resume_id}` | 200 | `resume_id: str`<br>`regenerated_items: list[RegeneratedItem]` | `dict` | [apply_regenerated_items](../app/apps/backend/app/routers/enrichment.py#L673) |

### 8.10 投递追踪

表 8-10 投递追踪路由

| 方法与完整路径 | 成功码 | 客户端入参 | 响应声明 | 实现 |
| --- | --- | --- | --- | --- |
| `GET /api/v1/applications` | 200 | 无 | `ApplicationListResponse` | [list_applications](../app/apps/backend/app/routers/applications.py#L47) |
| `POST /api/v1/applications` | 200 | `request: ManualApplicationCreate` | `ApplicationResponse` | [create_application](../app/apps/backend/app/routers/applications.py#L60) |
| `GET /api/v1/applications/{application_id}` | 200 | `application_id: str` | `ApplicationDetailResponse` | [get_application_detail](../app/apps/backend/app/routers/applications.py#L99) |
| `PATCH /api/v1/applications/bulk` | 200 | `request: BulkStatusUpdate` | `ApplicationActionResponse` | [bulk_update_applications](../app/apps/backend/app/routers/applications.py#L125) |
| `PATCH /api/v1/applications/{application_id}` | 200 | `application_id: str`<br>`request: ApplicationUpdate` | `ApplicationResponse` | [update_application](../app/apps/backend/app/routers/applications.py#L138) |
| `DELETE /api/v1/applications/{application_id}` | 200 | `application_id: str` | `ApplicationActionResponse` | [delete_application](../app/apps/backend/app/routers/applications.py#L157) |
| `POST /api/v1/applications/bulk-delete` | 200 | `request: BulkDelete` | `ApplicationActionResponse` | [bulk_delete_applications](../app/apps/backend/app/routers/applications.py#L172) |

### 8.11 简历向导

表 8-11 简历向导路由

| 方法与完整路径 | 成功码 | 客户端入参 | 响应声明 | 实现 |
| --- | --- | --- | --- | --- |
| `POST /api/v1/resume-wizard/turn` | 200 | `request: ResumeWizardTurnRequest` | `ResumeWizardTurnResponse` | [resume_wizard_turn](../app/apps/backend/app/routers/resume_wizard.py#L65) |
| `POST /api/v1/resume-wizard/finalize` | 200 | `request: ResumeWizardFinalizeRequest` | `ResumeWizardFinalizeResponse` | [finalize_resume_wizard](../app/apps/backend/app/routers/resume_wizard.py#L104) |

以上共 **83 个方法与路径组合**，含本轮已实现的 `GET /api/v1/auth/credits`；不包括根路径和 FastAPI 自动文档路由。

## 9. 可复用 curl 联调示例

以下是**未执行的示例脚本**，用于具备 curl、jq 和 Bash 的联调环境。运行后会创建虚构简历、JD、诊断与改写记录，并下载到临时目录；本文编写没有运行这些请求、发送邮件或调用真实模型。建议先启动隔离数据目录的测试实例，再逐段执行。local 与 hosted 二选一完成初始化，然后共用第 9.3 节业务链路。

### 9.1 local 初始化

在 Bash 中执行。测试后端应已运行于 127.0.0.1:8000，且使用独立 DATA_DIR；本例不启动或重置任何服务。

```bash
set -euo pipefail
career_base='http://127.0.0.1:8000'
career_example_dir="$(mktemp -d)"
career_cookie="$career_example_dir/cookies.txt"
touch "$career_cookie"

career_call() {
  local method="$1" resource="$2"
  shift 2
  curl --fail-with-body --silent --show-error --max-time 240 \
    --cookie "$career_cookie" --cookie-jar "$career_cookie" \
    --request "$method" \
    "$career_base/api/v1$resource" "$@"
}

career_call GET /health
career_call GET /auth/session
```

local session 应为 mode=local、user=null；不调用 `/auth/credits`，该接口在 local 没有账号上下文。

### 9.2 hosted 初始化与验证码登录

与第 9.1 节二选一，在 Bash 中执行。将示例网站替换为**本人控制的测试站点**，邮箱替换为本人可收信的邮箱；执行 start 才会真实发送验证码。career_origin 必须严格等于站点来源，包含协议和非默认端口，但不含路径或尾部斜线。

```bash
set -euo pipefail
career_base='https://your-test-domain.example'
career_origin="$career_base"
career_email='student@example.com'
career_example_dir="$(mktemp -d)"
career_cookie="$career_example_dir/cookies.txt"
touch "$career_cookie"
career_headers=(-H "Origin: $career_origin")

career_call() {
  local method="$1" resource="$2"
  shift 2
  curl --fail-with-body --silent --show-error --max-time 240 \
    --cookie "$career_cookie" --cookie-jar "$career_cookie" \
    "${career_headers[@]}" --request "$method" \
    "$career_base/api/v1$resource" "$@"
}

career_call GET /health
career_call POST /auth/email/start -H 'Content-Type: application/json' \
  --data-binary "$(jq -n --arg email "$career_email" '{email:$email}')" \
  > "$career_example_dir/challenge.json"
career_challenge="$(jq -er '.challenge_id' "$career_example_dir/challenge.json")"
read -r -s -p '输入本人收到的六位验证码：' career_code
printf '\n'
career_call POST /auth/email/verify -H 'Content-Type: application/json' \
  --data-binary "$(jq -n --arg email "$career_email" \
    --arg challenge "$career_challenge" --arg code "$career_code" \
    '{email:$email,challenge_id:$challenge,code:$code}')" \
  > "$career_example_dir/session.json"
unset career_code
jq '{mode,user}' "$career_example_dir/session.json"
career_call GET /auth/credits
```

示例不从响应中提取或打印 Cookie，curl 会维护会话文件。start 遇 429 时遵循 Retry-After，不循环重发；verify 遇 400 时获取新挑战，不重复消费旧挑战。

### 9.3 创建 → 诊断 → 读取证据 ID → 改写 → 采纳

本段接续上面已初始化的同一个 Bash 会话，默认全程 use_ai=false，不消耗网站模型积分。每个后续请求均使用前一步服务实际返回的 ID；不要直接复制第 4—5 节示意 ID。

```bash
cat > "$career_example_dir/resume-input.json" <<'JSON'
{
  "title": "接口联调虚构简历",
  "data": {
    "personalInfo": {"name": "林同学", "email": "student@example.com"},
    "personalProjects": [{
      "id": 1,
      "name": "课程数据分析",
      "role": "团队成员",
      "description": ["使用 Python 清洗课程问卷数据并绘制图表。"]
    }]
  },
  "source_text": "虚构示例：使用 Python 清洗课程问卷数据并绘制图表。",
  "template_settings": {"template": "swiss-single", "pageSize": "A4"}
}
JSON
career_call POST /career/resumes -H 'Content-Type: application/json' \
  --data-binary "@$career_example_dir/resume-input.json" \
  > "$career_example_dir/resume.json"
career_resume_id="$(jq -er '.id' "$career_example_dir/resume.json")"

cat > "$career_example_dir/job-input.json" <<'JSON'
{
  "title": "接口联调数据分析岗位",
  "text": "使用 Python 清洗数据。",
  "company": "虚构企业",
  "category": "数据分析",
  "source_type": "synthetic",
  "requirements": [{
    "id": "q1", "name": "Python", "source_text": "使用 Python 清洗数据", "priority": "required"
  }]
}
JSON
career_call POST /career/jobs -H 'Content-Type: application/json' \
  --data-binary "@$career_example_dir/job-input.json" \
  > "$career_example_dir/job.json"
career_job_id="$(jq -er '.job_id' "$career_example_dir/job.json")"

career_call POST /career/matches -H 'Content-Type: application/json' \
  --data-binary "$(jq -n --arg r "$career_resume_id" --arg j "$career_job_id" \
    '{resume_id:$r,job_id:$j,use_semantic:false,use_ai:false}')" \
  > "$career_example_dir/match.json"
career_match_id="$(jq -er '.id' "$career_example_dir/match.json")"
career_evidence_id="$(jq -er '[.evidence[] | select(.kind == "experience")][0].id' \
  "$career_example_dir/match.json")"
jq '{id,snapshot_id,score,evidence,details}' "$career_example_dir/match.json"

career_call POST /career/rewrites -H 'Content-Type: application/json' \
  --data-binary "$(jq -n --arg m "$career_match_id" --arg e "$career_evidence_id" \
    '{match_id:$m,section_id:$e,facts:[],use_ai:false}')" \
  > "$career_example_dir/rewrite.json"
career_rewrite_id="$(jq -er '.id' "$career_example_dir/rewrite.json")"
jq '{id,draft,claims,sources,status}' "$career_example_dir/rewrite.json"
```

在读取并确认上一步草稿和来源后继续采纳。本例按原文整理，不代表进行了 AI 表达优化。

```bash
career_call POST "/career/rewrites/$career_rewrite_id/apply" \
  -H 'Content-Type: application/json' --data-binary '{"confirmed":true}' \
  > "$career_example_dir/applied.json"
career_result_id="$(jq -er '.resume.id' "$career_example_dir/applied.json")"
jq '{resume_id:.resume.id,parent_id:.resume.parent_id,status:.rewrite.status}' \
  "$career_example_dir/applied.json"

# 只重复同一条 apply，用返回 ID 核对幂等；不重复生成草稿。
career_call POST "/career/rewrites/$career_rewrite_id/apply" \
  -H 'Content-Type: application/json' --data-binary '{"confirmed":true}' \
  > "$career_example_dir/applied-again.json"
test "$career_result_id" = \
  "$(jq -er '.resume.id' "$career_example_dir/applied-again.json")"

career_call GET "/career/matches/$career_match_id" \
  > "$career_example_dir/history.json"
jq '{id,stale,rewrites:[.rewrites[]|{id,status,result_resume_id}]}' \
  "$career_example_dir/history.json"
```

本地规则即使没有改变表达，也可以产生独立版本，这验证的是状态与持久化链路。创建、诊断和生成草稿没有通用请求幂等；网络中断后先读取 state/history 确认记录，不要盲目整段重跑。

### 9.4 按已保存版式导出 PDF 和 Word

接续第 9.3 节，PDF query 从 apply 返回的完整 template_settings 映射，避免使用 PDF 路由默认值覆盖已保存排版。成功后 headers 文件应分别包含 PDF/Word 的 Content-Type，下载失败时不得把 JSON 错误页当成文件。

```bash
career_pdf_query="$(jq -er '
  .resume.template_settings as $s |
  {
    template:$s.template, pageSize:$s.pageSize,
    marginTop:$s.margins.top, marginBottom:$s.margins.bottom,
    marginLeft:$s.margins.left, marginRight:$s.margins.right,
    sectionSpacing:$s.spacing.section, itemSpacing:$s.spacing.item,
    lineHeight:$s.spacing.lineHeight, fontSize:$s.fontSize.base,
    headerScale:$s.fontSize.headerScale, headerFont:$s.fontSize.headerFont,
    bodyFont:$s.fontSize.bodyFont, compactMode:$s.compactMode,
    showContactIcons:$s.showContactIcons, accentColor:$s.accentColor, lang:"zh"
  } | to_entries | map("\(.key)=\(.value | tostring | @uri)") | join("&")
' "$career_example_dir/applied.json")"
career_call GET "/resumes/$career_result_id/pdf?$career_pdf_query" \
  --dump-header "$career_example_dir/pdf.headers" \
  --output "$career_example_dir/resume.pdf"
career_call GET "/resumes/$career_result_id/docx?lang=zh" \
  --dump-header "$career_example_dir/docx.headers" \
  --output "$career_example_dir/resume.docx"
printf '本次示例文件目录：%s\n' "$career_example_dir"
```

### 9.5 完整 revision 保存与冲突恢复

PUT 不是部分字段 PATCH。以下先取得第 9.3 节简历的完整响应字段，再带服务返回 revision 提交标题修改，避免遗失正文与排版：

```bash
jq '{title:(.title + "（已校对）"),data,source_text,template_settings,
     expected_revision:.revision}' "$career_example_dir/resume.json" \
  > "$career_example_dir/resume-update.json"
career_call PUT "/career/resumes/$career_resume_id" \
  -H 'Content-Type: application/json' \
  --data-binary "@$career_example_dir/resume-update.json" \
  > "$career_example_dir/resume-updated.json"
jq '{id,title,hash,revision}' "$career_example_dir/resume-updated.json"
```

再次提交旧 revision 预期 409。恢复时重新 `GET /career/state`，找到目标简历的最新 data/revision，与本地编辑比较后决定合并内容；不要仅移除 expected_revision 强行覆盖。标题修改会更新编辑 hash/revision，但不会仅因此使规则诊断 stale。

### 9.6 AI 与积分的可选检查

只有确需验证真实 AI 时，另以同样返回 ID 构造 `use_ai:true` 的请求，并在操作前后 `GET /auth/credits`。不要给 AI POST 加通用自动重试。用户端看到 402、502、504 后先检查余额和历史，再决定是否重新生成；主流程的每一次成功模型步骤可能已扣款。

已有网站部署及线上链路验证见 [Azure 部署记录](Azure部署记录.md)，其中保留积分版本的 246 项后端回归及公网 69 条检查/事件证据。这些是已有记录；本文只更新接口说明并核对静态路由、示例语法和引用，没有重跑线上业务或应用回归。

## 10. 文档维护与验收口径

接口变更应同时核对路由、schema、前端调用和本文件。新增成功字段更新子对象定义；新增状态码更新恢复行为；调整计费流程则说明一次操作可能包含哪些模型步骤。模型服务的成功、业务记录持久化和用户最终采纳分别记录，不合并为一个“成功”标志。

本版核对依据为当前 [main.py](../app/apps/backend/app/main.py)、[auth.py](../app/apps/backend/app/auth.py)、[credits.py](../app/apps/backend/app/credits.py)、[routers](../app/apps/backend/app/routers/) 与 [schemas](../app/apps/backend/app/schemas/)。设计总说明使用 [后端与数据库设计文档](后端与数据库设计文档.md)，页面行为使用 [原型与交互设计](原型与交互设计.md)。历史验收结果引用其带日期的记录，示意 JSON 和 curl 示例均不记为已通过测试。

本轮文档静态验证：10 个 JSON 围栏、2 个 JSON heredoc 可解析，6 个 Bash 围栏通过 bash -n；13 次当前 Pydantic 请求/数据对象校验通过，PDF 参数映射经离线 jq 检查；83 个路由与源码 AST 一致，表号顺序及相对链接检查通过。上述验证未执行 curl 示例或应用业务测试。
