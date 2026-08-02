# TagNest — Cloudflare Git 集成部署手册（91vault 式 push-to-deploy）

把 TagNest 切到「GitHub push 即自动部署到 Cloudflare」的方式，与 91vault 一致：
由 **Cloudflare Pages 官方 Git 集成**负责从 GitHub 拉取代码、自动构建、自动部署，
替代/收敛当前「GitHub Actions 边跑一套，Cloudflare 又跑一套」的双写局面。

> 结论先行：**代码侧已全部就绪**（`npm run build` 可生成 `dist`、lockfile 齐全、
> `_headers` 安全头在、Functions 会被 CF 自动上传）。完成本手册需要**一次 Cloudflare
> Dashboard 配置**，其余自动化由 CF 接管。

---

## 1. 当前状态（为什么之前一直失败）

- `tagnest` 这个 Cloudflare Pages 项目**已经连接 GitHub**（Git Provider = Yes）。
- 但 CF 原生构建读 `wrangler.toml` 时只看到 `pages_build_output_dir = "dist"`，
  **没有 build command**（wrangler.toml 不承载 build command，必须在 Dashboard 配）。
- 于是 CF 原生构建 `Skipping build step`，而 `dist/` 又被 gitignore（仓库里没有），
  最终报 `Error: Output directory "dist" not found`。
- 线上站点目前仍由 **GitHub Actions 的 `7bfc5ca7`**（db419bd）正常服务（HTTP 200），
  但因为 CF 原生构建在失败，两套机制同时在跑。

---

## 2. Dashboard 配置（关键一步，约 1 分钟）

登录 Cloudflare Dashboard → **Workers & Pages** → 打开项目 **`tagnest`** →
**Settings（设置）→ Build configurations / 构建设置**，填写：

| 字段 | 值 |
|------|-----|
| **Framework preset** | `React`（或选 Vite，二选一即可） |
| **Build command** | `npm run build` |
| **Build output directory** | `dist` |
| **Root directory** | 留空（仓库根） |
| **Production branch** | `main` |

保存后，触发一次 push（或点 Deploy），CF 原生构建就会：
1. 克隆仓库
2. `npm install`（用 package-lock.json）
3. `npm run build`（= `tsc -b && vite build`，生成 `dist`）
4. 上传 `dist` + 自动打包 `functions/`
5. 部署到生产分支（Production）

> 备注：纯前端构建**不需要数据库连接**。D1/KV 绑定由 `wrangler.toml` 声明，
> 由 CF 在部署 Functions 时按声明注入；构建过程本身不碰远程 D1。

---

## 3. D1 数据库迁移（Git 集成模式下唯一要单独管的点）

CF 原生构建**不会自动跑数据库迁移**（91vault 是纯静态站所以没这个问题）。
TagNest 有 D1 schema。两条处理路径，按需选一：

### 路径 A（推荐）— 保留一个「仅迁移」的 GitHub Actions 工作流
新增/保留一个 workflow，只在 `migrations/` 有变更或手动触发时跑迁移，
页面构建/部署完全交给 CF Git 集成，二者职责分离、互不冲突。

### 路径 B — 把迁移并进 build command
在 Dashboard 的 Build command 里写成：
```
npm run db:migrate:all && npm run build
```
并在 Dashboard 的 **Settings → Environment variables** 里为构建注入：
- `CLOUDFLARE_API_TOKEN`（拥有 `Account > D1 > Edit` 权限）

这样每次 push 先迁移再构建。缺点：每次都会碰一次远程库（迁移脚本幂等，无害）。

> 推荐先走 **路径 A**，风险更低、更可审计。

---

## 4. 收敛双写（配好 Git 集成后必须做）

一旦 CF Git 集成能成功部署，**停用 GitHub Actions 的 `deploy.yml` 页面部署**
（否则每次 push 会有两套机制往同一 production 写，虽然产物一致但会造成重复构建、
Dashboard 记录混乱、偶发竞争）。

做法二选一：
- **关闭自动触发**：在 GitHub 仓库 → Settings → Actions → General → 把 `deploy.yml`
  从 push 自动触发改为仅 `workflow_dispatch`（手动）。
- **改为仅迁移**：把 `deploy.yml` 精简成只跑 D1 迁移（对应第 3 节路径 A）。

---

## 5. 验证清单

- [ ] Dashboard build command 已配置为 `npm run build`、输出 `dist`
- [ ] push 到 `main` → CF 原生构建显示 Success
- [ ] `https://tagnest.pages.dev` 强刷（Ctrl+F5）后新资源生效
- [ ] D1 迁移路径已明确（路径 A 或 B）
- [ ] Actions 的页面部署已停用，双写已收敛
