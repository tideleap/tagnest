# CI/CD & 部署

TagNest 跑在 **Cloudflare Pages + D1** 上。本文档说明当前可用的部署路径，以及如何在
拥有正确权限后启用 GitHub Actions 自动部署。

## 当前状态：脚本化手动部署

由于推送所用的 Personal Access Token（PAT）缺少 `workflow` 作用域，GitHub Actions
工作流无法被激活。因此当前采用 **`scripts/deploy.mjs`** 作为不依赖 Actions 的等效流水线——
它在本机依次运行与 CI 完全相同的质量门禁，再部署到 Cloudflare Pages。

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

需要满足两个条件，才能把 `ci-workflows` 分支上的工作流真正跑起来：

1. **换发带 `workflow` 作用域的 PAT**
   - 旧 PAT 明文曾出现在对话中，建议先在 GitHub 撤销并重新生成。
   - 新 PAT 需勾选 `repo` 与 `workflow`。
2. **配置仓库 Secrets**
   - `CLOUDFLARE_API_TOKEN`：具有 `Cloudflare Pages` 编辑权限的 API Token。
   - `CLOUDFLARE_ACCOUNT_ID`：账户 ID。

配置完成后，将 `ci-workflows` 分支合并 / 推送到 `main`，或直接在仓库 Actions 页面手动
启用工作流，之后每次推送到 `main` 即自动构建并部署。

## 安全提醒

- **公开注册**：`wrangler.toml` 中 `DISABLE_SIGNUP` 当前为 `false`。如需关闭开放注册，
  改为 `true` 并重新部署。
- **密钥不下发**：`api_keys` 仅存储令牌摘要，明文令牌仅创建时返回一次；`ai_settings.api_key`
  经 AES-256-GCM 加密存储，后端绝不回传明文。
- **PAT 轮换**：任何曾暴露于对话 / 日志的 PAT 都应视为已泄露并立即撤销。
