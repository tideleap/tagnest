# TagNest

> 中文文档 ｜ [English abstract](#english-abstract)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Ftideleap%2Ftagnest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/tideleap/tagnest/actions/workflows/ci.yml/badge.svg)](https://github.com/tideleap/tagnest/actions/workflows/ci.yml)

**TagNest** 是一个「快、键盘优先」的书签管理器，构建在现代 Cloudflare 技术栈之上
（Pages Functions + D1 + R2 + KV）。它把你散落各处的网址、标签页和收藏，整理成一个
可搜索、可标签化、可分享的私人知识库。

---

## 一键部署（推荐）

不想敲命令？点一下按钮，剩下的全自动：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Ftideleap%2Ftagnest)

三步即可拥有你**自己账户下**的独立实例：

1. **点按钮 → 授权**
   点击上方按钮，用 GitHub / Cloudflare 登录授权。Cloudflare 会**自动 Fork 本仓库**，
   并在你的账户下创建 Pages 项目（构建命令 `npm run build`、输出目录 `dist`、生产分支 `main`）。
2. **填一个 Token（仅此一次）**
   在你 Fork 出的仓库中进入 **Settings → Secrets and variables → Actions → New repository secret**，添加：
   - `CLOUDFLARE_API_TOKEN`：具备 `Cloudflare Pages:Edit`、`D1:Edit`、`R2:Edit`、`Workers KV:Edit` 权限的 API Token
   - `CLOUDFLARE_ACCOUNT_ID`：你的 Cloudflare 账户 ID
3. **运行工作流**
   进入仓库 **Actions → Deploy → Run workflow**。工作流会自动完成：
   - 创建 **D1 数据库** + **R2 存储桶**（网站快照）+ **KV 命名空间**（分享页缓存）
   - 生成强随机 **JWT_SECRET** 并写入 Pages 密钥（已存在则跳过，不会使现有会话失效）
   - 执行数据库迁移（幂等）
   - 构建并发布到生产

完成后站点即上线。脚本会把新的绑定 id 写回 `wrangler.toml` 并提交，因此 Fork 后的仓库
**完全自包含**，后续维护无需回到上游。

> 说明：出于 Cloudflare 的安全模型，创建工作区资源必须有一个授权 Token，所以这一步无法被
> 按钮本身代劳——这是整个流程里**唯一**需要你手动操作的地方。除此之外，环境变量、数据库、
> 构建与发布全部自动化，无需逐项填写设置、无需命令行。

---

## 项目简介

TagNest 是某款书签管理器产品理念的独立清洁室实现（clean-room reimplementation），
从零设计、使用 MIT 许可证，可自由自托管或商用。它面向「重度书签用户」：

- **为搜索而生**：D1/SQLite 的 `fts5` 触发器分词，让中文子串和拉丁文词中匹配都准确可用。
- **键盘优先**：Vim 风格导航、即时命令面板、键集分页，规模再大也顺滑。
- **导入即整理**：Netscape / JSON / CSV 多源导入，文件夹自动变标签，重复网址自动去重。
- **可观测**：每次请求输出结构化日志，关键业务事件可查询，健康检查端点可直接接入监控。

---

## 功能特性

**搜索与整理**
- 中文友好的全文搜索（`fts5` 触发器分词；短于 3 字自动回退 `LIKE`）。
- 文件夹即标签：导入时把书签文件夹层级转成标签，按归一化 URL（去除 `utm_*`/`gclid` 等追踪参数）去重。
- 多源导入：Netscape HTML、JSON（TagNest / 数组 / `{bookmarks}` / `{items}`）、CSV，导入前可预览。
- 实时导入进度：大批量导入按批次流式回传进度，页面显示真实进度条。
- 作用域与批量操作：收件箱 / 全部 / 收藏 / 归档 / 回收站，支持批量打标签、软删除、恢复、彻底清除。
- 拖拽排序：手动排列书签顺序，与按时间/标题/访问量排序共存。

**私密书签（零知识加密保险库）**
- 任意书签都能「设为私密」：明文在**浏览器内**用 PBKDF2-SHA256（250k 次迭代）+ AES-256-GCM 加密，服务端只拿到密文，永远不持有密钥、也无法解密。
- 隐私隔离是在 SQL 层强制的，不是靠前端隐藏：`b.is_private = 0` 由 `functions/_lib/db.ts` 的 `PRIVATE_BOOKMARK_CLAUSE` 注入到每一条列表 / 搜索 / 统计 / 分享 / 导出查询；转为私密时同步清空可读列并断开全部标签关联，因此它不会出现在任何标签视图、分享页或导出文件中。
- 专属 `/private` 区域：解锁后才在本地解密渲染；可新增、编辑、移出（还原为普通书签，自动按名称重建标签）或永久删除。锁定只需清空内存中的密钥，刷新页面即自动上锁。
- 密码只用于派生密钥，从不上传；服务端仅保存公开的 salt 与一段验证密文（verifier），因此能校验密码是否正确，却无法恢复密码或内容。详见 [`docs/PRIVATE-VAULT.md`](docs/PRIVATE-VAULT.md)。

**网站实时快照**
- 书签卡片自身即「网站截图」：Grid 视图顶部大图、List/Compact 视图左侧缩略图，无需额外区域。
- 截图优先走 Cloudflare Browser Run（自托管、无第三方），也可接入外部截图 API；二者皆缺时优雅降级到 favicon，不报错。
- 快照按策略留存与自动刷新，过期后前端自动重新抓取。

**AI 整理（两轨引擎）**
- 模型 + 本地启发式规则引擎（始终免费运行）双轨产出标签与摘要，对照你现有标签体系归一化，避免同义标签堆积。
- 每条建议带置信度与来源（`model` / `heuristic` / `taxonomy`），进入可审阅队列，完全可逆；无 API Key 也能用启发式产出。
- **整理即分级**：AI 整理跑完的最后一刻自动执行「三级分组」——按标签把书签归并成 `一级大类 → 二级子类 → 三级具体标签` 的层级树（改写标签 `parent_id`），与标签整理同步完成、无需手动点「自动建组」。未命中分类规则或已位于三级深处的标签保持原状，分组结果完全可逆。
- **按层级审阅**：建议审阅页新增「按层级」视图，按 大类 → 子类 归并同一标签下的书签，支持整类忽略 / 整类应用；侧边栏标签树改为可折叠的三级层级展示，点击叶子标签即筛选对应书签。
- **标签治理**（T1）：AI 整理「体检」页集中治理标签词汇表——疑似重复簇可逐个或**一键全部合并**（单请求批量，避免半途失败），未使用标签支持单个删除或确认后**全部清理**，低频标签（仅 1 个书签）单独列出供合并决策；每次合并写入审计表（`tag_merge_log`，快照标签名），面板底部展示**合并历史**，治理动作全程可追溯。
- **书签三级 ML 分类**（新）：基于朴素贝叶斯 + IDF 重加权的文本分类器（`functions/_lib/ai/classifier.ts`），直接对**书签内容**（标题 / URL / 描述 / 已有标签）做三级归类，而不只是对标签名归类。层级结构在 `taxonomy-ml.ts` 中集中定义（13 个一级大类、各含二级子类、每类配特征词）；分类的输入输出格式、置信度阈值、内容安全隔离与批量稳定性约束如下：
  - **层级结构**：`一级大类 → 二级子类 → 三级具体标签`。三级具体标签取自书签自身的标签或子类名（叶子）。
  - **输入** `BookmarkClassInput`：`{ id, title, url, description?, tags? }`。**输出** `BookmarkClassPrediction`：`{ category, subcategory, suggestedTag, confidence, engine, needsReview, quarantined, reason }`。
  - **置信度阈值**：`confidenceThreshold`（默认 0.5）作为自动归类的门槛；低于阈值落到 `needsReview`（`category`/`subcategory` 置空，不写入层级）。置信度由「胜出类相对亚军类的边际」经 sigmoid 校准，并经 IDF 强化稀有特征、压制通用词（如 `文档`、`教程`），避免被通用词带偏。
  - **内容安全**：命中成人/NSFW 词表的书签直接 `quarantined` 隔离待人工确认，绝不进入生产力三级体系。
  - **批量稳定**：`classifyBatch` 确定性产出（同输入同输出），模型只训练一次并共享于整批；返回聚合统计（按类计数、置信度直方图、`needsReview`/`quarantined` 数量），便于大规模书签处理时核对结果稳定可靠。
  - **API**：`POST /api/ai/classify`，`mode` 可为 `report`（只读报告，默认）/ `apply`（把自动归类的书签挂到其一级/二级标签，幂等）/ `revert`（按确定性重分类删除自动链接，可回滚）。
  - **设计规范**：完整层级表、I/O 字段说明、置信度阈值约束与批量稳定性保证见 [`docs/AI-HIERARCHY.md`](docs/AI-HIERARCHY.md)。
- 支持 OpenAI / Anthropic / Gemini / 任意 OpenAI 兼容 `custom` 端点；密钥以 AES-256-GCM 加密后存储。

**分享与扩展**
- 公开分享页：以短链 `/s/:slug` 发布可筛选的实时书签视图，支持过期时间、主题与边缘缓存；可设置**访问密码**（密码保护的分享绕过边缘缓存，防止跨访客泄露），也可以**整个集合**为范围分享（按集合内顺序展示，与标签模式互斥）。
- 浏览器扩展（Manifest V3）：一键保存当前页或把整个窗口捕获进标签组（Ctrl+Shift+T），通过作用域化的个人 API Key 通信。
- 标签组（Tab groups）：把已有书签策展成有序、带颜色的组，一键重开整组；扩展的「捕获窗口」会一键保存当前窗口标签页为书签，并自动归入一个标签组。

**账户与安全**
- 认证：WebCrypto PBKDF2-HMAC-SHA256 + HS256 JWT 访问令牌，配合可轮转的 httpOnly 刷新 Cookie。
- 多租户隔离：每条查询按 `user_id` 隔离，越权访问在数据层即被拒绝。
- 个人 API Key：可生成 `read`/`write` 作用域的令牌（仅存 SHA-256 摘要），随时吊销，且不能用于再签发 Key。
- 字段级加密：AI 提供方密钥入库前以 AES-256-GCM 密封，D1 导出不含明文凭据。
- 登录限流：失败登录/注册按 IP 与邮箱限流，抵御暴力破解。
- 注册控制：`DISABLE_SIGNUP` 可关闭公开注册；`ALLOWED_EMAILS` 支持邮箱/域名白名单（`*@corp.dev`）。

**体验**
- 可安装、可离线（PWA）：应用外壳离线可用，静态资源后台刷新；书签 API 永不缓存，避免看到他人会话的陈旧数据。离线时顶部横幅提示，恢复网络自动消失。
- 移动端收集（Web Share Target）：Android 系统分享菜单可直接「分享到 TagNest」，链接进收件箱，分享文字自动存为笔记。
- 仪表盘：登录落地页一览你的书签、标签、最近新增与收藏，以及待整理计数（未标签/已归档/回收站）。

---

## 技术栈

| 层 | 选型 |
|----|------|
| 前端 | React 18 · TypeScript · Vite 6 · Tailwind CSS v4 · Zustand · TanStack Query / Virtual |
| 后端 | Cloudflare Pages Functions（Workers 运行时）· TypeScript |
| 数据库 | Cloudflare D1（SQLite）+ `fts5` 触发器全文索引 |
| 存储 | Cloudflare R2（网站快照）· KV（分享页边缘缓存）|
| 认证 | WebCrypto PBKDF2 + HMAC-SHA256（JWT）|
| 截图 | Cloudflare Browser Run（或外部截图 API）|
| 测试 | Vitest（后端逻辑单测 + 前端组件测试）|

---

## 目录结构

```
tagnest/
├─ src/                     # React 前端（Vite + TS）
│  ├─ components/           # UI 组件：bookmark / command / layout / organize / tags / ui
│  ├─ pages/                # 路由页面（含 settings）
│  ├─ hooks/queries/        # TanStack Query 数据请求
│  ├─ stores/               # zustand 状态
│  ├─ lib/                  # 工具（API 客户端、类名合并等）
│  ├─ styles/               # 主题（theme.css，明/暗色 token）
│  └─ test/                 # 前端测试辅助
├─ functions/               # Cloudflare Pages Functions（后端）
│  ├─ _lib/                 # 共享后端逻辑：auth / db / snapshots / import / ai …
│  └─ api/                  # 路由处理器：auth / bookmarks / tags / import / export /
│                           #   shares / ai / snapshots / tab-groups / collections / keys / public
├─ migrations/              # D1 schema（0001_init … 0013_prompt_version，全部幂等）
├─ shared/                  # 前后端共享类型与工具（types.ts / snapshotUrl.ts）
├─ extension/               # 浏览器扩展（Manifest V3），见 extension/README.md
├─ scripts/                 # 部署 / 迁移 / 健康检查 / 基础设施配置
│                           #   deploy.mjs · migrate.mjs · setup-infra.mjs · health-check.mjs …
├─ docs/                    # 设计 / 部署 / 评审文档（BACKLOG.md 等）
├─ public/                  # 静态资源（_headers 安全头、图标、PWA manifest）
├─ tests/                   # Vitest 单测（后端逻辑 + 前端组件）
├─ wrangler.toml           # Pages + D1 / KV / R2 / Browser 绑定
└─ package.json
```

---

## 本地运行

前置条件：Node 22+，`wrangler` 已作为开发依赖安装。

```bash
npm install

# 启动前端（Vite 开发服务器 :5173，并把 /api 代理到 :8788）
npm run dev

# 另开一个终端，本地运行 API + D1（Miniflare）
npm run dev:api

# 把 D1 schema 应用到本地库（幂等）
npm run db:migrate:local

# 后端逻辑单测
npm test

# 前端组件测试
npm run test:ui

# 需求台账：把 docs/backlog.json 里声明状态与代码逐一核对
npm run backlog:check

# 端到端冒烟测试（需先运行 npm run dev:api 于 :8788）
bash scripts/smoke.sh
```

> **本地密钥**：未设置 `JWT_SECRET` 时会回退到一个不安全的开发密钥（并打印警告）。
> 部署前请用 `wrangler pages secret put JWT_SECRET` 设置一个真实密钥。

---

## 部署到 Cloudflare Pages

### 方式一：一键部署（Deploy to Cloudflare 按钮）

见上方「一键部署」小节——Fork、建库、建桶、写密钥、迁移、发布全部自动完成，
只需在 Fork 出的仓库里填一个 `CLOUDFLARE_API_TOKEN` 即可。

### 方式二：手动 / CLI 部署

适合在自己机器上控制发布节奏：

```bash
# 1. 建 D1 库（记下 database id），并写入 wrangler.toml
npm run db:create

# 2. 在 Cloudflare 仪表盘创建 R2 桶 tagnest-media、KV 命名空间 SHARE_CACHE，
#    并把对应 id 填进 wrangler.toml

# 3. 应用远程 schema
npm run db:migrate

# 4. 设置 JWT 密钥
wrangler pages secret put JWT_SECRET

# 5. 质量门禁 + 构建 + 部署（也可 npm run release 自动推送后部署）
npm run deploy
```

`wrangler.toml` 把数据库绑定为 `DB`，并设置 `DISABLE_SIGNUP`（默认 `false`）。
部署完成后建议把 `DISABLE_SIGNUP` 改为 `true` 关闭公开注册；或保留开放、用
`ALLOWED_EMAILS` 做白名单。

### 环境变量与注册控制

`wrangler.toml` 的 `[vars]` 段与 Pages 密钥共同决定运行行为：

| 名称 | 类型 | 说明 |
|------|------|------|
| `JWT_SECRET` | **密钥** | HS256 签名密钥，用 `wrangler pages secret put` 设置，切勿提交。 |
| `DISABLE_SIGNUP` | 变量 | `true` 关闭公开注册；默认 `false`。 |
| `ALLOWED_EMAILS` | 变量 | 逗号分隔的邮箱/域名白名单（`*@corp.dev`）；`DISABLE_SIGNUP=true` 时忽略。 |
| `SNAPSHOT_API_URL` / `SNAPSHOT_API_KEY` | 变量 | 外部截图 API；设置后优先于 Browser Run。 |
| `LOG_LEVEL` | 变量 | 日志最低级别 `debug`→`info`→`warn`→`error`，默认 `info`。 |

---

## 可观测性

- 每次请求输出单行 JSON 日志（前缀 `[tagnest]`），携带 `ts / level / event / rid / props`，
  关键业务事件（`user.signup`、`bookmark.create`、`share.create` 等）可直接用于漏斗分析。
- `GET /api/health` 返回 `{ status, checks: { database, shareCache, auth }, timestamp }`，
  接入你的 uptime 监控，对 `status !== "ok"` 告警即可。
- 生产部署后工作流会自动做健康检查，失败则回滚到上一个健康提交。

---

## 路线图与需求追踪

每个需求（已实现 / 进行中 / 已放弃 / 受阻）都集中在一个机器可校验的台账：

- [`docs/BACKLOG.md`](./docs/BACKLOG.md) — 完成定义、排序规则与生成的状态表。
- `docs/backlog.json` — 唯一事实来源。
- `npm run backlog:check` — 从仓库重新推导每个状态，若声明与代码不符或在 CI 中失败，
  因此路线图不会与代码悄悄脱节。

---

## 清洁室实现声明

TagNest 是某款书签管理器产品理念的独立清洁室实现（clean-room reimplementation），并非该项目的分支、Fork 或直接复制。我们对两者的全部源代码做了结构化比对，结论如下：

- **无直接源代码关联**：两个仓库相互独立，分别托管在各自的独立仓库中，不存在共享子模块、共享私有包或文件级复制。
- **零文件级重复**：对 308 个 TagNest 源文件与 373 个上游源文件做 SHA-256 内容比对，
  **没有任何内容相同的非空文件**。
- **零残留引用**：在 `src/`、`functions/`、`shared/`、`migrations/` 中检索，未发现任何指向该上游项目的残留引用（命中数 **0**）；早期提交（`b1c3323`）已主动清除所有上游相关字面值。
- **仅存间接（概念 / 架构）渊源**：两者都基于同一套公开、标准的 Cloudflare Pages 技术栈
  （Pages Functions + D1 + R2 + KV + React + Vite + Tailwind v4），并沿用类似的模块划分
  （如 `functions/_lib` 对应 `functions/lib`、`shared/types.ts`）。但同一用途的实现方式完全不同
——例如敏感凭证保护：TagNest 将 AI 提供方密钥以 AES-256-GCM（HKDF 派生密钥）密封后再入库，
  用户密码则独立使用 PBKDF2-HMAC-SHA256 派生；两种机制在用途与实现层均独立设计。

> TagNest 不复用任何上游项目的源码、素材、文案或布局，以独立的 **MIT** 许可证发布，
> 可自由自托管或商用。完整合规分析与许可证对比见 [`COMPLIANCE.md`](./COMPLIANCE.md) 与
> [`docs/COMPLIANCE-REVIEW-2026-08-02.md`](./docs/COMPLIANCE-REVIEW-2026-08-02.md)。

---

## 优化变更记录

- **2026-08-09 · 源代码关联审计与仓库整理**
  - 全量比对 TagNest 与上游项目源码：确认**无直接源代码关联**，仅存间接的清洁室概念 / 架构渊源。
  - 验证并确认代码库与上游**零耦合**（无共享模块、无私有依赖、无残留字面值），无需额外解耦改造。
  - 清理仓库根目录遗留的构建 / 调试产物（`*.log`、`parser.bundle.mjs`、`_tmp_test_parser.mjs` 等），
    统一目录结构，保持工作区整洁（均已被 `.gitignore` 忽略，不进入版本库）。
  - 完善本文档：新增「清洁室实现声明」专节，明确清洁室声明与比对证据；优化结构描述与关系标注，
    确保文档与代码状态一致。

---

## English abstract

**TagNest** is a fast, keyboard-first bookmark manager built on a modern Cloudflare stack
(Pages Functions + D1 + R2 + KV) with a React/TypeScript front end. It features Chinese-friendly
full-text search (`fts5` trigram), folder-to-tag import with URL de-duplication, live import
progress, multi-tenant isolation, scoped personal API keys, field-level AES-256-GCM encryption,
AI tagging (two-track: model + heuristic, fully reversible), public share pages, a Manifest V3
browser extension, live website snapshots, and an offline-capable PWA.

**One-click deploy:** click the *Deploy to Cloudflare* button to fork the repo and create a Pages
project, add a `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secret once, then run the
`Deploy` workflow — it provisions D1/R2/KV, generates `JWT_SECRET`, runs migrations, and publishes.
No dashboard form-filling, no CLI.

Local dev: `npm install && npm run dev` (front end) + `npm run dev:api` (Miniflare) +
`npm run db:migrate:local`. See the Chinese sections above for full details.
