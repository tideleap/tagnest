# B-12 浏览器书签双向同步 · 本地验证清单

> 配套设计文档：[`docs/SYNC-Y3-B12-2026-08-16.md`](./SYNC-Y3-B12-2026-08-16.md)
> 适用代码：`extension/`（MV3，纯 JS 无构建步骤）+ 后端 `functions/api/bookmarks/sync-{keys,pull,push}.ts`
> 前提：你的 TagNest 实例已部署含 B-12 端点的版本（`origin/main` ≥ `12fa986`，Phase B 已推送并触发部署）。

本清单覆盖**真实浏览器**下的端到端行为。协议层（三路合并、字段级 LWW、跨语言 `urlKey` 一致）已由 `tests/sync-*.test.ts`（共 45+ 例）覆盖，无需在浏览器里重复验证。

---

## 0. 前置条件

- 一个**可达**的 TagNest 部署（推荐直接用已上线的 HTTPS 实例；或本地 `npm run dev:api` + 前端）。
- 一个 **write（读写）** 权限的个人 API 密钥（`tnk_...`）：网站 **设置 → API 密钥 → 新建（write）** 后复制。
- Chromium 内核浏览器（Chrome / Edge / Brave），开启「开发者模式」。

> 为什么需要读写密钥：`sync-push` 上传浏览器变更走写权限；只读密钥会在 `POST /sync-push` 返回 403。

---

## 1. 加载扩展（开发者模式）

1. 打开 `chrome://extensions`（或 `edge://extensions`）。
2. 右上角开启「开发者模式」。
3. 「加载已解压的扩展程序」→ 选择仓库的 `extension/` 目录。
4. 确认清单权限（`extension/manifest.json`）：
   - 固定权限：`activeTab` / `tabs` / `storage` / `scripting`
   - `optional_permissions: ["bookmarks"]` —— **按需授权**，安装时不会弹窗（规避 R1 权限弹窗流失）。

---

## 2. 配置连接（`extension/README.md` 配置 章节）

1. 点击扩展图标 → 右下角「设置」。
2. 服务器地址填 `https://你的实例.pages.dev`（**无尾斜杠**）；本地调试填 `http://localhost:8788`。
3. 粘贴 `tnk_...` 读写密钥 → 保存 → 点「测试连接」应显示已连接。
4. 关闭设置页。

> 本地调试注意：扩展在浏览器侧用 `fetch` 直连 `baseUrl`。若指向本地 Miniflare（`:8788`），跨域可能被 CORS 拦截。最简验证路径是**直接指向已上线的 HTTPS 实例**。

---

## 3. 触发 `run-sync`

**入口**：扩展弹窗 → 「双向同步」按钮（`popup.js` 的 `openTwoWaySync`）→ 新标签页打开 `extension/sync.html`。
（另：弹窗「同步对账」→ `reconcile.html` 为只读三态 diff，不改变写浏览器，可先用来确认两端数据。）

在 `sync.html`：

1. **方向开关**：默认「仅上传」(`upload`)；要验证写回浏览器请选「双向」(`two-way`)。
2. 点「开始同步」。
3. **首次会弹** `chrome.permissions.request({ permissions: ['bookmarks'] })` → 必须点「允许」。两端都会读浏览器书签树，缺权限则同步无法开始。
4. 后台 `runSync`（`service-worker.js` 监听 `run-sync` 消息，90s 超时）按序执行：
   - 读浏览器书签树 `chrome.bookmarks.getTree`；
   - 自 `lastSyncedAt` 水印拉 `GET /api/bookmarks/sync-pull`（首次为空 → 全量 changelog，含 `deletedAt` 软删行）；
   - `planSync` 三路合并（共同祖先 = 上次快照）；
   - `two-way` 模式：先备份受影响节点 → 把 TagNest 状态写回书签栏「TagNest」文件夹（建/改/删）；
   - `POST /api/bookmarks/sync-push` 上传本地变更（`url_key` 去重、软删行 revive、字段级 LWW）；
   - 持久化 `{ lastSyncedAt, snapshot }` 到 `chrome.storage.local`（`tagnestSync.v0`）。
5. 结果面板显示：浏览器书签数、TagNest 变更数、已上传/失败；`two-way` 额外显示写回（建/改/删）。

---

## 4. 验证断言（逐项勾选）

- [ ] **upload 上行**：浏览器书签栏/其他文件夹里的书签，在 TagNest 网页「收件箱 / 全部」出现（按 `url_key` 去重，不产生重复）。
- [ ] **two-way 写回 · 新增**：TagNest 有、浏览器没有的书签，出现在书签栏「TagNest」文件夹。
- [ ] **two-way 写回 · 删除传播**：在 TagNest 软删某书签 → 再次 `two-way` 同步 → 该书签从「TagNest」文件夹消失（删除经 `deletedAt` 传播；注意：TagNest 侧仍可恢复，浏览器侧是真删）。
- [ ] **two-way 写回 · 标题**：TagNest 侧改标题 → `two-way` 同步 → 「TagNest」文件夹内标题更新（浏览器书签无标签字段，仅标题写回）。
- [ ] **水印增量**：首次全量后，`chrome.storage.local` 的 `tagnestSync.v0.lastSyncedAt` 已写入；做少量改动后再同步，仅增量传输（拉取 `since=水印`）。
- [ ] **幂等**：连跑两次同一方向，书签数 / 「TagNest」文件夹节点数稳定，无重复创建。
- [ ] **冲突解决**：同一 URL 两端各改标题 → `two-way` 出现「需要人工解决的冲突」列表；点「采用 TagNest」把 TN 版本写入文件夹；「保留浏览器」维持浏览器版（已上传）。
- [ ] **快照回滚**：`two-way` 同步产生写回后，页面出现「快照恢复」面板；点「恢复上次快照」→ `rollbackSync` 还原受影响节点（恢复被删的、还原被改标题的、删掉新建的）→ 浏览器树回到同步前状态。

---

## 5. 后端交叉核对（可选）

- `GET /api/bookmarks/sync-keys` → `{ items:[{id,urlKey,updatedAt,title}], cursor, hasMore }`，`Cache-Control: no-store`。
- `GET /api/bookmarks/sync-pull?since=<ISO>` → 含 `deletedAt` 的轻量对象，游标 `(updated_at, id)`；`since` 含边界（`>=`）。
- `POST /api/bookmarks/sync-push` body `{ changes:[{ op:'upsert'|'delete', url, title?, tagNames? }] }` → `{ applied, failed, errors:[{index,code,message}] }`，逐条错误不中断。

---

## 6. 常见失败与排查

| 现象 | 原因 | 处理 |
|------|------|------|
| 「需要『书签』权限才能读取浏览器书签树」 | 未在弹窗点允许 | 弹窗点「允许」；或 `chrome://extensions` → 该扩展「权限」→ 授予 `bookmarks` |
| `请先在设置中配置服务器与密钥` | 未填 `baseUrl`/密钥 | 设置页补全 |
| `API 密钥无效或已过期` (401) / `该密钥没有写入权限` (403) | 密钥错或只读 | 重建 **write** 密钥 |
| `无法连接 TagNest，请检查网络与服务器地址` | `baseUrl` 错 / `dev:api` 未起 / 本地 CORS 拦截 | 改用已上线 HTTPS 实例验证 |
| 写回浏览器没生效 | 方向选了「仅上传」 | 改选「双向」（`upload` 不会写回浏览器） |
| 同步卡住无响应 | 后台 Service Worker 休眠 / 90s 超时 | 重新打开扩展面板再点「开始同步」 |

---

## 7. 说明

- 回滚**仅恢复浏览器侧**：TagNest 侧的 `sync-push` 已落地，重新同步会从还原后的浏览器树重新推导正确状态。
- `two-way` 写回一律落到书签栏「TagNest」文件夹（首次同步自动创建），不会改动你原有的其他书签文件夹。
- 删除传播是单向不可逆的浏览器侧动作（TagNest 软删可恢复），验证前建议先备份浏览器书签或用一个测试书签。
