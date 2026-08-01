# CI/CD & 部署

TagNest 跑在 **Cloudflare Pages + D1** 上。本文档说明当前可用的部署路径，以及如何在
拥有正确权限后启用 GitHub Actions 自动部署。

## 当前状态：两套部署路径并存

- **脚本化手动部署（随时可用）**：`scripts/deploy.mjs` 作为不依赖 Actions 的等效流水线，
  在本机依次运行与 CI 完全相同的质量门禁，再部署到 Cloudflare Pages。生产站点
  https://tagnest.pages.dev 即由此路径上线（本地 OAuth 登录）。
- **GitHub Actions（已激活）**：工作流文件 `.github/workflows/ci.yml` 与 `deploy.yml` 已推送到
  `main`（2026-08-01，提交 `fbc41d1`），GitHub 侧均显示 `state: active`。
  - **CI（`ci.yml`）已验证通过**：首次推送触发 run #1，`Typecheck / Lint / Test` 结论 `success`
    —— 证明 `npm run build`（`tsc -b && vite build`）在 CI runner 上也能正常产出 `dist`。
  - **部署（`deploy.yml`）当前失败**：run #1 结论 `failure`，wrangler-action 发布的
    “Cloudflare Pages” 检查显示 “🚫 Build failed”。说明部署作业**已执行**（即
    `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 两个 Secret 已存在），但在 Cloudflare
    部署步骤鉴权/授权失败。根因几乎确定是 `CLOUDFLARE_API_TOKEN` 无效、过期或缺少
    `Cloudflare Pages: Edit` 权限（账户 ID Secret 指向的正是正确账户
    `335886786d5a9656e7aba4692bc85b14`）。修复该 Token 后重新运行工作流即可。

### 可用命令（`package.json`）

| 命令 | 作用 |
| --- | --- |
| `npm run deploy` | 门禁 → 构建 → 部署到 `main`（生产） |
| `npm run deploy:preview` | 部署到 `preview` 分支 |
| `npm run deploy:check` | 仅门禁 + 构建，不上传（`--dry-run`） |
| `npm run release` | `git push` + 部署到 `main` |
| `npm run hooks:install` | 启用 `pre-push` 钩子（推送前跑 typecheck + test） |

门禁顺序：`typecheck` → `lint` → `test` → `build`（`TN_KEEP_DIST=1` 规避本地递归删除拦截）→
产物校验（`index.html` + `_headers` 含 CSP/HSTS）→ `wrangler pages deploy`。

### 部署前置

- 已通过 `wrangler` OAuth 登录（`wrangler whoami` 可见账号）。
- `JWT_SECRET` 已通过 `wrangler pages secret put JWT_SECRET` 设置（否则运行时回退到开发密钥）。
- KV 命名空间 `SHARE_CACHE`（可选，公开分享缓存）如已绑定则自动启用，缺失时静默降级。

### 数据库迁移

迁移文件位于 `migrations/`，已写成幂等形式（`CREATE ... IF NOT EXISTS`、`CREATE TRIGGER
IF NOT EXISTS`）。常规迁移命令：

```bash
npx wrangler d1 migrations apply tagnest-db --remote
```

> 注意：`wrangler` 3.x 的 `migrations apply` 对含 FTS5 虚表 / 触发器的文件存在语句切分
> 解析缺陷（报 “SQL code did not contain a statement”）。若遇到，可改用按文件执行：
> `npx wrangler d1 execute tagnest-db --remote --file=migrations/0001_init.sql`，
> 幂等写法保证已存在的对象被跳过。已应用的迁移记录在 `d1_migrations` 表中，重复执行为无操作。

## GitHub Actions 启用状态与剩余修复

工作流已推送到 `main`（提交 `fbc41d1`）并激活；PAT（带 `repo`+`workflow`）与 GCM 凭据
均已就绪。下面记录已完成项与当前唯一阻塞。

### 已完成

- **PAT 换发（带 `workflow` scope）**：新 PAT 已通过 GitHub API 验证，具备
  `repo` / `workflow` 等权限；本地 GCM 凭据已更新为令牌 `tideleap`，并成功
  `git push origin main`（首次推送即触发 CI 与 Deploy 两个 run）。
- **工作流激活**：GitHub 侧 `ci.yml` / `deploy.yml` 均 `state: active`。

### 当前阻塞 —— `CLOUDFLARE_API_TOKEN` 部署鉴权失败

部署作业已运行（run #1 `failure`），wrangler-action 发布 “Cloudflare Pages / Build failed”。
说明两个 Cloudflare Secret 已存在，但 **`CLOUDFLARE_API_TOKEN` 无效、过期或缺少
`Cloudflare Pages: Edit` 权限**。账户 ID Secret 指向正确账户 `335886786d5a9656e7aba4692bc85b14`。
注意：`cloudflare/wrangler-action@v3` 接收的 `CLOUDFLARE_API_TOKEN` 必须是 **Cloudflare API Token**
（非 GitHub PAT，也非 Global API Key）。

### 修复步骤（Cloudflare 侧，需在 Cloudflare 后台操作）

1. Cloudflare 后台 → My Profile → API Tokens → Create Token。
2. 使用模板 **Cloudflare Pages**（或自定义：权限 `Account > Cloudflare Pages > Edit`），
   账户选 `god in 劲仔`（`335886786d5a9656e7aba4692bc85b14`）。
3. 复制新 Token，到 GitHub 仓库 → Settings → Secrets and variables → Actions，
   将 `CLOUDFLARE_API_TOKEN` 的值更新为该 Token（如尚未创建则新建）。
4. 回到仓库 → Actions → 选 “Deploy” 工作流 → Re-run jobs（或推送任意改动触发）。
   成功后每次 push 到 `main` 即自动部署生产，PR 部署到 `pr-<编号>` 预览。

> 排查提示：若 GitHub Actions 日志中仍报错，常见为
> `Invalid API token` / `token does not have access to account` / `Missing permission
> pages:edit`。把红色报错贴回对话即可精准定位。另：若此前在 Cloudflare Pages 后台把仓库
> 直接连过 GitHub（Cloudflare 原生构建），会与本 Actions 双触发，建议停用其一以免重复构建。

### 激活后行为（修复 Token 后即生效）

- **CI（`ci.yml`）**：每次 PR 与 push 到 `main` 运行 `typecheck` / `lint` / `test`（已验证通过）。
- **部署（`deploy.yml`）**：作业在**同时检测到 `CLOUDFLARE_API_TOKEN` 与
  `CLOUDFLARE_ACCOUNT_ID` 两个 Secret 时**才运行；否则自动跳过（不报错）。
  push 到 `main` 时自动 `npm run build` 并 `wrangler pages deploy dist
  --project-name=tagnest --branch=main` 部署到生产；PR 部署到 `pr-<编号>` 预览分支。
- **迁移不自动跑**：工作流不执行 D1 迁移（沿用 `migrations apply` 手动流程），与现有
  运维约定一致。

## 安全提醒

- **公开注册**：`wrangler.toml` 中 `DISABLE_SIGNUP` 当前为 `false`。如需关闭开放注册，
  改为 `true` 并重新部署。
- **密钥不下发**：`api_keys` 仅存储令牌摘要，明文令牌仅创建时返回一次；`ai_settings.api_key`
  经 AES-256-GCM 加密存储，后端绝不回传明文。
- **PAT 轮换**：任何曾暴露于对话 / 日志的 PAT 都应视为已泄露并立即撤销。
