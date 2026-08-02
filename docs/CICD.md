# TagNest CI/CD 与自动化部署手册

> 目标：**代码推送到 `main` → 自动构建 → 自动应用 D1 迁移 → 自动部署到 Cloudflare Pages → 无需人工干预**。本文档从零到可长期维护地描述整条链路。最后更新：2026-08-02。

---

## 1. 项目结构 & 配置文件清单

流水线相关的文件，一图看清：

```
tagnest/                              ← GitHub 仓库根
├─ .github/
│  └─ workflows/
│     ├─ ci.yml                       CI：typecheck / lint / test / backlog
│     └─ deploy.yml                   CD：build → 迁移 → Pages 部署（主要交付物）
├─ src/                               React 前端源码
├─ functions/                         Cloudflare Pages Functions（API 后端）
│  ├─ _lib/                           auth / db / urlkey / import-parsers / ids …
│  └─ api/                            路由（auth、bookmarks、tags、import、stats…）
├─ public/                            favicon.svg、_headers、manifest.webmanifest、sw.js、PWA 图标
├─ migrations/
│  ├─ 0001_init.sql                   表结构（幂等）
│  ├─ 0002_keys_order_shares.sql      密钥 / 排序 / 分享（幂等）
│  └─ 0003_tab_groups.sql             标签页组（幂等）
├─ scripts/
│  ├─ deploy.mjs                      手动部署流水线（门禁+构建+上传）
│  └─ migrate.mjs                     D1 逐文件幂等迁移（新增，供 CI/手动复用）
├─ shared/types.ts                    前后端共享类型
├─ package.json                       依赖清单 & scripts（下方列出）
├─ wrangler.toml                      Pages + D1 + KV 绑定、构建输出目录、兼容性
├─ vitest.backend.config.ts           测试配置（node 环境）
├─ .gitignore                         dist/、node_modules/、.wrangler/、.workbuddy/ 等
└─ docs/
   ├─ CICD.md                         （本文档）
   └─ backlog.json / BACKLOG.md       需求台账（被 CI 校验）
```

### 依赖清单（package.json scripts，与流水线相关）

| 命令 | 作用 | 谁在用 |
| --- | --- | --- |
| `npm run typecheck` / `lint` / `test` | 质量门禁 | CI + deploy.mjs |
| `npm run build` | `tsc -b && vite build`，产出 `dist/` | CI + deploy.mjs |
| `npm run backlog:check` | 需求台账一致性校验 | CI |
| `npm run db:migrate:all` | **逐文件幂等迁移（推荐）** | deploy.yml + 手动 |
| `npm run deploy` / `deploy:preview` / `deploy:check` | 手动部署流水线 | 手动 |
| `npm run hooks:install` | 启用推送前门禁钩子 | 本地 |

`wrangler.toml` 关键配置：`pages_build_output_dir = "dist"`、D1 `DB`（`tagnest-db`）、KV `SHARE_CACHE`、`compatibility_date`、变量 `DISABLE_SIGNUP` / `ALLOWED_EMAILS`。`JWT_SECRET` 属敏感信息，**用 Secret 注入，不进仓库**。

---

## 2. GitHub 仓库初始化、上传与提交规范

### 2.1 分支模型

- **`main`**：唯一生产分支。**提交合并到 `main` 触发生产部署**。
- 功能开发在 `feature/*` 或 `fix/*` 分支，通过 **Pull Request** 进 `main`；PR 同时触发 CI 与 Pages **预览部署**（`pr-<编号>.tagnest.pages.dev`），可在合并前预览。

### 2.2 提交规范

- **消息格式**（约定式提交，保持可追溯）：
  `type(scope): 描述`，如 `feat(import): live progress`、`fix(auth): …`、`chore(deps): …`。
- **每个提交应通过本地门禁**（推荐装钩子：`npm run hooks:install` 会在 push 前跑 typecheck+test）。
- **不要提交** `dist/`、`node_modules/`、`.wrangler/`、`.dev.vars`、`.workbuddy/`（已在 `.gitignore`）。
- **不要提交任何密钥**：`JWT_SECRET` 用 `wrangler pages secret put`；`CLOUDFLARE_*` 只放 GitHub Secrets。

### 2.3 新仓库初始化（首次）

```bash
git init
git remote add origin https://github.com/<org>/tagnest.git
git add -A && git commit -m "feat: initial import"
git branch -M main
git push -u origin main
```

### 2.4 将工作流推送后启用

推送到 `main` 后，GitHub Actions 会自动识别 `.github/workflows/*.yml`。到仓库 **Actions** 页确认 `CI` 与 `Deploy` 均 `state: active`。

---

## 3. Cloudflare 与 GitHub 的自动关联

### 3.1 一次性配置（Cloudflare 后台）

1. Cloudflare → **My Profile → API Tokens → Create Token**。
2. 用模板 **Cloudflare Pages**（或自定义：`Account > Cloudflare Pages > Edit`），账户选定本项目所属账户。
3. 复制 token。

### 3.2 配置 GitHub Secrets

仓库 → **Settings → Secrets and variables → Actions → New repository secret**，添加：

| Secret 名 | 是否必需 | 值 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | 推荐 | 第 3.1 步的 Cloudflare API Token（注意：是 CF 的 Token，非 GitHub PAT） |
| `CLOUDFLARE_ACCOUNT_ID` | 可选（多账户时必需） | 账户 ID `335886786d5a9656e7aba4692bc85b14` |
| `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL` | 备选认证方式 | 用 Global API Key 时的替代（与上面二选一） |

> 只有一个账户时，`CLOUDFLARE_API_TOKEN` 即可，wrangler 自动推断账户。

### 3.3 关联后的行为（`deploy.yml`）

- **push 到 `main`**：装依赖 → typecheck → lint → build → 校验 `dist/index.html` + `_headers` → **应用 D1 迁移** → `wrangler pages deploy dist --branch=main` → 生产 `https://tagnest.pages.dev`。
- **PR**：同样构建，但跳过生产迁移与生产部署，改为部署预览 `pr-<编号>`。
- **手动**：Actions → Deploy → Run workflow，可用开关 `run_db_migrations` 控制是否顺带抢跑迁移（默认 `true`，仅影响生产）。

### 3.4 触发条件（`deploy.yml` 的 `on:`）

```
on:
  push:      { branches: [main] }        # 推送到 main → 生产
  pull_request: { branches: [main] }     # PR → 预览
  workflow_dispatch:                      # 手动触发（带迁移开关）
concurrency:
  group: deploy-${{ github.ref }}         # 同 ref 串行，防止快速连续推送竞态
```

---

## 4. 端到端无人工部署流程

```
git push origin main
   │
   ▼  (GitHub Actions: Deploy)
[checkout] → [setup-node 22] → [npm ci]
   → [build: tsc && vite build]
   → [validate dist: index.html + _headers/CSP/HSTS]
   → [Check Cloudflare credentials]  (无凭据则跳过部署，不报错)
   → [Apply D1 migrations (production)]  → scripts/migrate.mjs（幂等、逐文件，非阻塞）
   → [wrangler pages deploy dist --branch=main]  → live on https://tagnest.pages.dev
```

质量门禁（typecheck / lint / test / backlog）由 **`ci.yml` 独立 job** 把关，deploy job 专注构建与发布，互不拖慢。

同时 `ci.yml` 也作为独立守卫对每次 PR/push 跑 **typecheck/lint/test/backlog:check**，二重保险。

**首次部署前还需**（一次性）：
```bash
npx wrangler d1 create tagnest-db                 # 若无此库
npx wrangler pages secret put JWT_SECRET          # 线上运行时密钥
```
（项目已具备 `tagnest-db`，见 `wrangler.toml` 的 `database_id`。）

---

## 5. 数据库迁移如何自动化

`migrations/` 里的文件**全部幂等**（`CREATE ... IF NOT EXISTS`、`CREATE TRIGGER IF NOT EXISTS`）。`scripts/migrate.mjs` 会：

1. 建幂等登记表 `_d1_migrations(name, applied_at)`；
2. 读取 `migrations/` 全部 `0NN_*.sql`；
3. 对每个**未登记**的文件执行 `wrangler d1 execute tagnest-db --remote --file=<file>`，成功后 `INSERT OR IGNORE` 登记；
4. 已登记的跳过 → **重跑安全、中途失败可续跑**。

> 为什么不用 `wrangler d1 migrations apply`？它对含注释/FTS5 虚表/触发器的多语句文件存在切分解析缺陷（“SQL code did not contain a statement”）。逐文件执行 + 幂等写法规避之。

本地预览：`npm run db:migrate:all:local`；强制执行前预览：`npm run db:migrate:all:dry`。

---

## 6. 部署失败排查（按概率排序）

| 现象 / 日志 | 根因 | 解决 |
| --- | --- | --- |
| `Invalid API token` / `token does not have access to account` | `CLOUDFLARE_API_TOKEN` 无效/过期/权限不足 | 后台重建 Cloudflare API Token（`Cloudflare Pages: Edit`），替换 Secret |
| `Missing permission: pages:edit` | Token 缺少 Pages 编辑权限 | Token 增加 `Account > Cloudflare Pages > Edit` |
| 生产没部署但有 CI 成功 | `CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID` 未设 | 补 Secret；或单账户只需 `API_TOKEN` |
| 迁移步骤失败 / 「SQL code did not contain a statement」 | 直接调 `migrations apply` | 用 `scripts/migrate.mjs`（逐文件）；含非幂等改动的迁移需人工核对 |
| `npm run build` 在 Actions 失败 | 类型错误 / 依赖 | 看日志中 `tsc`/`vite` 具体报错后修复 |
| 线上 `_headers` 生效但 CSP 报错 | `public/_headers` 与内联脚本 | 保留 `script-src 'unsafe-inline'`（首屏主题脚本需要） |
| 双触发重复构建 | 同时连了 Cloudflare 原生构建 + Actions | 在 Cloudflare Pages 停用其一（建议保留 Actions） |
| 迁移步骤失败但部署继续 | Cloudflare token 缺 `Account > D1 > Edit` | 给 token 加 D1 权限后 Re-run 迁移/部署；迁移步骤是**非阻塞**的（`continue-on-error`），失败会写入 Deploy 的 summary 提示 |
| 预览分支 `pr-x` 访问不了 | PR 已关 / 分支被清 | 用新的 PR 重新触发 |

**通用做法**：看 **Actions → Deploy → 失败 job → 日志**，把红色报错贴回对话即可精准定位。

---

## 7. 回滚方案

Cloudflare Pages 保留每次部署的快照，回滚无需改代码、秒级生效：

1. Cloudflare 后台 → **Workers & Pages → 选择 `tagnest` → Deployments**。
2. 找到要退回的上一个**成功**部署，点其右侧 **• • • → Rollback to this deployment**（新版本归档，生产 URL 立即回退）。
3. 代码层面若需连带回退，再 `git revert <bad-sha>` 并 push（会自动再触发一次部署）。

**数据（D1）回滚**：D1 有自动备份与时间点恢复（Cloudflare 控制台 → D1 → Backup/Restore）。迁移若已执行且业务异常，优先用 `scripts/migrate.mjs` 修正后重跑，或按需从备份恢复——**迁移文件须保持幂等，避免依赖顺序回滚**。

---

## 8. 长期可维护性约定

- **升级 Node/wrangler 版本**：改 `deploy.yml` 的 `NODE_VERSION` 与 `package.json` 的 engines，合并进 PR，CI 验证后再合入 `main`。
- **新增迁移**：新建 `migrations/000N_描述.sql`（幂等写法）→ 本地 `npm run db:migrate:all:local` 自测 → 随代码一起 push，CI 自动应用到生产。
- **密钥轮换**：任何暴露过的 PAT / Token 立即在 GitHub / Cloudflare 撤销并重建，更新 Secret 后 Re-run 一次部署验证。
- **门禁不放松**：CI 的四项（typecheck/lint/test/backlog）都是部署前的硬门禁；`dist/_headers` 的 CSP/HSTS 校验兜底安全头不回退。
- **改文档即更新**：本文档随流水线改动同步维护，保持「从零可复现」。
