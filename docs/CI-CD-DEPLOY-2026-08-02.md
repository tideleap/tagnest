# TagNest 自动化部署流水线说明

- **日期:** 2026-08-02
- **触发入口:** GitHub Actions push 到 `main` / PR / 手动 `workflow_dispatch`
- **部署目标:** 生产 `https://tagnest.pages.dev`（Cloudflare Pages，Functions + D1）
- **质量门禁:** 并行 CI + 部署前 dist 校验 + 部署后健康检查 + 自动回滚

---

## 1. 触发时机（零人工干预）

| 触发 | 事件 | 结果 |
|---|---|---|
| 推送/合并到 `main` | `push: branches: [main]`（含 PR merge → GitHub 会产生一次到 main 的 push） | **自动部署到生产** |
| 打开/更新 Pull Request | `pull_request` | **自动部署到预览** `pr-N.tagnest.pages.dev`（不触生产） |
| 手动重跑 | `workflow_dispatch`（Actions ⚙ → Run workflow） | 可指定是否重跑 D1 迁移 |
| 串行保护 | `concurrency: group: deploy-${{ github.ref }}, cancel-in-progress: true` | 快速连续推送不会并发竞争 |

> **关键保障**：`push: branches: [main]` 意味着"合并 PR 到 main"这一动作本身就会触发生产部署——不需要任何人手动点击，完全符合"合并请求合并后即部署"。

---

## 2. 完整部署流程（任一步失败即中止）

```
[触发] push main / PR / manual
   │
   ▼
[checkout]  actions/checkout@v4
[setup-node] actions/setup-node@v4 (Node 22, npm 缓存)
[npm ci]     精确安装（按 lockfile）
   │
   ▼ 质量门禁（ci.yml 并行跑，任一失败阻断合并/部署）
[typecheck] [lint] [unit test] [UI test] [theme check] [backlog check]
   │
   ▼ 构建与校验（deploy.yml）
[npm run build]        tsc -b && vite build
[Validate dist]        index.html / _headers / CSP / HSTS 齐全，缺即 fail
[Check CF creds]       CLOUDFLARE_API_TOKEN 或 key+email 存在？
[Probe D1 scope]       token 有 D1 权限？无则降级跳过迁移
[Apply migrations]     生产才执行；D1 可达时"迁移失败 = 中止发布"
   │
   ▼
[Deploy production]    wrangler pages deploy dist --branch=main
   │
   ▼
[Post-deploy health]   /api/health 轮询 8 次 × 8s = 64s 窗口
   │            ├── 成功 → ✅ 发布完成
   │            └── 失败 → ⬇ 自动回滚（见 §4）
   ▼
[Deployment summary]   输出 commit/branch/target/迁移/健康/链接
```

**失败即中止的机制**：
- 每个 `run:` 步骤非零退出码 = GitHub Actions 默认 `set -e`，**立即终止整个 job 并标红**。
- 关键防线各自独立：`dist 校验`（缺头颅/页面即 fail）、`迁移`（D1 可达时硬失败 = hold release）、`健康检查`（部署后起不来 = fail）。
- 任何一步失败，Actions 页面会给出明确的红色步骤名 + 该步日志，可直接定位。

---

## 3. 环境与目标 + 部署后健康确认

| 环境 | 分支 | 目标 URL | 何时 |
|---|---|---|---|
| **生产** | `--branch=main` | `https://tagnest.pages.dev` | push 到 main / 手动 |
| **预览** | `--branch=pr-${{ PR }}` | `https://pr-N.tagnest.pages.dev` | 每个 PR |

**部署后健康检查**（新增 `scripts/health-check.mjs`）：
- 请求 `https://tagnest.pages.dev/api/health`（带 `?_cb=时间戳` 破缓存）。
- 轮询 **8 次 × 8s = 64 秒窗口**，容忍 Cloudflare 冷启动/边缘传播。
- 仅当返回 `{"status":"ok"}` 才视为**发布真成功**；否则该步 fail → 触发回滚。

---

## 4. 自动回滚机制（健康检查失败时）

新增 `scripts/rollback.mjs`，由 workflow 的 **"Automatic rollback"** 步骤调用：

```mermaid
health-check 失败
   -> 目标 ref = github.event.before  (= main 上一次稳定的 commit)
   -> git worktree add --detach <ref>   # 干净检出，不动当前工作区
   -> npm ci && npm run build           # 在那次提交上重建
   -> wrangler pages deploy dist --branch=main
   -> health-check.mjs 再验一次         # 只有旧版也健康才算回滚成功
   -> 写 ROLLBACK_DONE=yes 到 summary
```

- **选回滚点**：`github.event.before` = push 事件中"分支改动前"的 SHA，即**上一个已上线且通过健康的生产提交**。
- **健壮性**：若无可回滚提交（`0000…` 或 manual 触发无 before）→ 跳过并记录 `ROLLBACK_DONE=none`，不假成功。
- **失败记录**：每次回滚在 Actions 日志独立成步，带时间戳；summary 明确标注"自动回滚已触发，恢复到 X commit"。
- **工作区安全**：用 `git worktree` 而非 `git checkout`，开发者本地目录不受部署影响。

---

## 5. 进度可见（部署结果 / 日志摘要 / 访问链接）

每次部署结束，Actions 页面的 **step summary**（Deployment summary）自动输出：

```
## Deploy summary
- Commit:    <sha>
- Branch:    refs/heads/main
- Target:    production (https://tagnest.pages.dev)
- DB migrations: applied
- Health check:   ✅ passed
🌐 访问链接: https://tagnest.pages.dev
📋 日志摘要: 详见下方各步骤日志…
```

- **结果**：Commit / Branch / Target / 迁移状态 / 健康检查 ✅/❌
- **日志摘要**：每一步独立步骤名 + 时间戳；回滚时有独立章节
- **访问链接**：直接可点的 `https://tagnest.pages.dev`（或预览 `pr-N`）
- 健康检查失败且回滚成功时，summary 追加"⚠️ 自动回滚已触发"，一眼看出发生了回滚。

---

## 6. 所需配置与前置（首次使用需确认）

### GitHub → Cloudflare 密钥（已在仓库 Secrets，若缺需补）
| Secret | 用途 | 建议 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Pages + D1 部署 | 推荐用 token（含 `Account > Pages > Edit`；若要自动迁移再加 `Account > D1 > Edit`） |
| `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL` | 备选认证（token 缺失时） | 可选 |
| `CLOUDFLARE_ACCOUNT_ID` | D1 迁移 / Pages 归属 | 必填 |
| `JWT_SECRET` | 生产运行时解密（`wrangler pages secret put`） | 生产必需（本仓库已设置） |

### 本地可重复执行
```bash
# 完整生产发布（构建+校验+部署），含质量门禁
node scripts/deploy.mjs

# 部署后健康探测（CI 复用）
node scripts/health-check.mjs --base=https://tagnest.pages.dev

# D1 迁移（本地/远程幂等）
node scripts/migrate.mjs

# 手动回滚到某提交（CI 自动模式之外也可手跑）
node scripts/rollback.mjs --ref=<sha> --project=tagnest --branch=main
```

---

## 7. 新增/改动文件清单

| 文件 | 类型 | 作用 |
|---|---|---|
| `.github/workflows/deploy.yml` | 修改 | 新增「Post-deploy health check」「Automatic rollback」步骤 + summary 输出健康/回滚/链接 |
| `scripts/health-check.mjs` | 新增 | 部署后 poll `/api/health`，产出结构化结果与退出码 |
| `scripts/rollback.mjs` | 新增 | worktree 检出上稳定 commit → rebuild → deploy → 再验健康 |
| `scripts/ci.yml` | 保留 | 独立质量门禁不变 |

---

## 8. 测试与验证手段

### 本沙箱可实测的部分
```bash
node --check scripts/health-check.mjs   # 语法
node scripts/health-check.mjs --base=https://tagnest.pages.dev --retries=1  # ✔ 对当前绿色生产实测
node scripts/rollback.mjs               # 缺 --ref → exit 2（守卫生效）
```

### 需在真实 GitHub 上验证的动作（工作流只有 push 才真正触发）
1. push 一个 commit 到 `main` → Actions 应自动跑 ci.yml（门禁）+ deploy.yml（构建→迁移→部署→健康→summary）。
2. 人为把 `--retries=8` 改小或对接一个会失败的 health URL，观察是否触发 Automatic rollback 且 summary 标注。
3. 开一个 PR → 应只部署预览 `pr-N`，不触生产。

> **注意**：workflow 与密钥本仓库已就绪，但**真正触发依赖代码推送到 GitHub**。当前本地代码仍 uncommitted（此前的部署走 `--commit-dirty` 直传）；要让 CI/CD 自动化接手，需先把当前改动 commit + push 到 `origin/main`。
