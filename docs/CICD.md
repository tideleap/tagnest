# CI/CD & 部署

TagNest 跑在 **Cloudflare Pages + D1** 上。本文档说明当前可用的部署路径，以及如何在
拥有正确权限后启用 GitHub Actions 自动部署。

## 当前状态：两套部署路径并存

- **脚本化手动部署（随时可用）**：`scripts/deploy.mjs` 作为不依赖 Actions 的等效流水线，
  在本机依次运行与 CI 完全相同的质量门禁，再部署到 Cloudflare Pages。生产站点
  https://tagnest.pages.dev 即由此路径上线。
- **GitHub Actions（已就绪，待激活）**：工作流文件 `.github/workflows/ci.yml` 与
  `deploy.yml` 已写入本地 `main`（提交 `c71186d`），但**尚未推送到远端**——因为推送所用的
  Personal Access Token（PAT）缺少 `workflow` 作用域，GitHub 拒绝接收触碰
  `.github/workflows/*` 的提交。修复 PAT 后即可 `git push origin main` 激活。

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

## 启用 GitHub Actions 自动部署

工作流文件已经合并进本地 `main`（提交 `c71186d`），只需补齐账号侧配置即可激活。

### 步骤 1 —— 换发带 `workflow` 作用域的 PAT

1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
   → Generate new token（经典令牌）。
2. 勾选 **`repo`**（完整仓库控制）与 **`workflow`**（更新 GitHub Actions 工作流）。
3. 生成后复制新 PAT。**旧 PAT 明文曾出现在对话中，建议先在 GitHub 撤销。**

### 步骤 2 —— 更新本机 Git 凭据（Git Credential Manager）

本机 git 使用 **Git Credential Manager（`manager`）** 缓存凭据，旧 PAT 仍会被自动使用，
导致即使换新 PAT，push 仍会以旧令牌失败。需替换缓存：

- **方式 A（推荐，Windows）**：打开「控制面板 → 凭据管理器 → Windows 凭据」，找到
  `git:https://github.com`，编辑并把「密码」替换为**新 PAT**。
- **方式 B（命令行）**：先清除旧凭据，下一次 push 时由 GCM 交互式提示输入新 PAT：
  ```bash
  printf 'protocol=https\nhost=github.com\n' | git credential reject
  ```
- 凭据更新后，重新执行 `git push origin main` 即可通过，工作流随即激活。
  （也可由你在自己的机器上完成此 push。）

### 步骤 3 —— 配置仓库 Secrets

GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret：

- **`CLOUDFLARE_API_TOKEN`**：在 Cloudflare 后台生成的 API Token，权限模板选
  **Cloudflare Pages**（需含 `Account > Cloudflare Pages > Edit`）。
- **`CLOUDFLARE_ACCOUNT_ID`**：`335886786d5a9656e7aba4692bc85b14`
  （即当前 `wrangler whoami` 登录的账户「god in 劲仔」，tagnest 项目归属该账户）。

### 激活后行为

- **CI（`ci.yml`）**：push 成功即生效，每次 PR 与 push 到 `main` 运行
  `typecheck` / `lint` / `test`。无需任何 Secret。
- **部署（`deploy.yml`）**：作业在**同时检测到 `CLOUDFLARE_API_TOKEN` 与
  `CLOUDFLARE_ACCOUNT_ID` 两个 Secret 时**才运行；否则自动跳过（不报错）。
  配置好 Secrets 后，push 到 `main` 即自动 `npm run build` 并
  `wrangler pages deploy dist --project-name=tagnest --branch=main` 部署到生产；
  PR 则部署到 `pr-<编号>` 预览分支。
- **迁移不自动跑**：工作流不执行 D1 迁移（沿用 `migrations apply` 手动流程），与现有
  运维约定一致。

## 安全提醒

- **公开注册**：`wrangler.toml` 中 `DISABLE_SIGNUP` 当前为 `false`。如需关闭开放注册，
  改为 `true` 并重新部署。
- **密钥不下发**：`api_keys` 仅存储令牌摘要，明文令牌仅创建时返回一次；`ai_settings.api_key`
  经 AES-256-GCM 加密存储，后端绝不回传明文。
- **PAT 轮换**：任何曾暴露于对话 / 日志的 PAT 都应视为已泄露并立即撤销。
