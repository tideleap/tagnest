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

## TagNest项目简介

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

**网站实时快照**
- 书签卡片自身即「网站截图」：Grid 视图顶部大图、List/Compact 视图左侧缩略图，无需额外区域。
- 截图优先走 Cloudflare Browser Run（自托管、无第三方），也可接入外部截图 API；二者皆缺时优雅降级到 favicon，不报错。
- 快照按策略留存与自动刷新，过期后前端自动重新抓取。

**AI 整理（两轨引擎）**
- 模型 + 本地启发式规则引擎（始终免费运行）双轨产出标签与摘要，对照你现有标签体系归一化，避免同义标签堆积。
- 每条建议带置信度与来源（`model` / `heuristic` / `taxonomy`），进入可审阅队列，完全可逆；无 API Key 也能用启发式产出。
- 支持 OpenAI / Anthropic / Gemini / 任意 OpenAI 兼容 `custom` 端点；密钥以 AES-256-GCM 加密后存储。

**分享与扩展**
- 公开分享页：以短链 `/s/:slug` 发布可筛选的实时书marks 视图，支持过期时间、主题与边缘缓存。
- 浏览器扩展（Manifest V3）：一键保存当前页或把整个窗口捕获进标签组（Ctrl+Shift+T），通过作用域化的个人 API Key 通信。
- 标签组（Tab groups）：把已有书签策展成有序、带颜色的组，一键重开整组；扩展的「捕获窗口」会自动归档。

**账户与安全**
- 认证：WebCrypto PBKDF2-HMAC-SHA256 + HS256 JWT 访问令牌，配合可轮转的 httpOnly 刷新 Cookie。
- 多租户隔离：每条查询按 `user_id` 隔离，越权访问在数据层即被拒绝。
- 个人 API Key：可生成 `read`/`write` 作用域的令牌（仅存 SHA-256 摘要），随时吊销，且不能用于再签发 Key。
- 字段级加密：AI 提供方密钥入库前以 AES-256-GCM 密封，D1 导出不含明文凭据。
- 登录限流：失败登录/注册按 IP 与邮箱限流，抵御暴力破解。
- 注册控制：`DISABLE_SIGNUP` 可关闭公开注册；`ALLOWED_EMAILS` 支持邮箱/域名白名单（`*@corp.dev`）。

**体验**
- 可安装、可离线（PWA）：应用外壳离线可用，静态资源后台刷新；书签 API 永不缓存，避免看到他人会话的陈旧数据。
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
