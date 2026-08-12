# 私密书签 · 零知识加密保险库

> 实现日期：2026-08-09 · 迁移：`0014_private_bookmarks.sql`

把"不便公开"的书签变成一条服务端也读不懂的密文，并让它从产品的每一个可见面
彻底消失，只有本人解锁后才能在专属区域看到。

---

## 1. 威胁模型：这套设计防的是什么

| 场景 | 是否防护 | 说明 |
| --- | --- | --- |
| 同事/家人借用你已登录的浏览器随手翻书签 | ✅ | 私密书签不在任何列表、搜索、标签树、分享页、导出文件里；保险库默认锁定 |
| 服务端数据库被拖库 | ✅ | 落库的只有 AES-GCM 密文与公开 salt，没有密钥 |
| 运维/开发者直接查 D1 | ✅ | 同上，服务端从未持有明文或密钥 |
| 分享链接被猜到 / 导出文件外泄 | ✅ | 私密行在生成分享与导出的 SQL 里就被排除 |
| 攻击者已拿到你的**密码本身** | ❌ | 密码即密钥，这是零知识方案的固有前提 |
| 解锁状态下被人接管当前标签页 | ❌ | 密钥在内存中，需手动锁定或刷新页面 |

**明确不承诺的事**：私密书签的**存在与条数**对服务端不是秘密（行仍在 `bookmarks`
表里，只是内容为密文）。侧边栏入口也刻意不显示计数，避免旁人一眼看出你有多少条。

---

## 2. 密码学设计

```
用户密码 ──PBKDF2-SHA256(salt, 250,000 iters)──▶ AES-256-GCM 密钥 (CryptoKey, 仅内存)
                                                      │
                              ┌───────────────────────┼───────────────────────┐
                              ▼                       ▼                       ▼
                     verifier = E(常量)      encrypted_blob = E(书签明文)    解锁校验
```

- 实现：`src/lib/vault-crypto.ts`，只依赖全局 Web Crypto（浏览器与 Node 20+ 通用，
  因此加解密往返可以在纯 Node 下做单元测试）。
- **密钥永不序列化**：存放在 `src/stores/vault.ts` 的模块级变量 `vaultKey` 里，
  不进 zustand state、不进 localStorage、不进任何请求体。
- localStorage 只留 `{ salt, verifier }`（键名 `tagnest.vault`），两者都是公开值；
  该键已加入 `ACCOUNT_SCOPED_KEYS`，退出登录时一并清除。
- 密文线格式：`{ v: 1, iv: <base64 12B>, ct: <base64> }`，整体 `JSON.stringify`
  后作为 `encrypted_blob` 存储。
- **一次性设置**：v1 不支持改密码——换密钥会让所有既有密文变成永久乱码。

---

## 3. 隐私隔离：为什么"藏不住"是不可能的

隔离不是在前端过滤，而是在**数据访问层**强制：

```ts
// functions/_lib/db.ts
export const PRIVATE_BOOKMARK_CLAUSE =
  `b.is_private = 0 AND NOT EXISTS (
     SELECT 1 FROM bookmark_tags bt_pv
     JOIN tags t_pv ON t_pv.id = bt_pv.tag_id
     WHERE bt_pv.bookmark_id = b.id AND t_pv.user_id = b.user_id AND t_pv.is_private = 1)`;
function buildWhere(...) {
  const where = ['b.user_id = ?', PRIVATE_BOOKMARK_CLAUSE];  // 默认就带上
  ...
}
```

该条件被注入到全部普通查询：书签列表 / 全文搜索 / 单条读取 / 统计
（`/api/stats`）/ AI 概览 / 批量打标签 / 分享内容 / 导出与导出预览。它隐藏两类私密书签：

1. **单书签私密**（零知识加密）：`is_private = 1`，明文已清空，服务端只存密文（见下文 §2）。
2. **类别私密**（仅隐藏不加密）：书签本身带着某个 `is_private = 1` 的标签。

第 2 类用 `NOT EXISTS` 在 SQL 层**派生**隐藏，因此实时——给书签打上私密标签立刻消失，
取消标签立刻回来，且**不改写任何书签行**。只有 `functions/api/private/*` 下的端点绕过它
（含下方 §8 的 `GET /api/private/tags`，供本人查看与恢复）。

转私密时（`setBookmarkPrivate`）还会**主动破坏可读性**，而不只是加一个标记位：

- `url` / `title` 置空，`description` / `favicon_url` / `cover_url` / `note` 置 NULL；
- `url_key` 改写为 `private:<id>`，让它退出唯一索引的竞争，也不会被 URL 查重命中；
- 删除全部 `bookmark_tags` 关联 —— 否则标签计数和标签树会泄漏它的存在；
- `is_favorite` / `is_archived` / `created_at` 保留，用于还原后维持原状。

还原时（`clearBookmarkPrivate`）由客户端回传解密后的字段，服务端重新校验 URL
（`canonicalUrl` 失败即 400）、检查是否与现有书签撞 URL（撞则 409），再按名称
重建标签关联。

---

## 4. 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/private/vault` | 返回 `{ configured, salt, verifier }`（salt/verifier 均为公开值） |
| POST | `/api/private/vault` | 一次性创建保险库；已存在返回 409 |
| GET | `/api/private/bookmarks` | 列出全部密文行（不含任何明文） |
| POST | `/api/private/bookmarks` | 直接在保险库内新建一条私密书签 |
| GET | `/api/private/bookmarks/:id` | 读取单条密文 |
| PATCH | `/api/private/bookmarks/:id` | 用新密文覆盖（前端改完重新加密） |
| DELETE | `/api/private/bookmarks/:id` | 永久删除（非软删除） |
| PATCH | `/api/bookmarks/:id` | `{ isPrivate: true, encryptedBlob }` 转私密；`{ isPrivate: false, ...明文字段 }` 还原 |
| GET | `/api/private/tags` | 列出本人全部私密标签及其隐藏的明文书签（按标签分组），供在 `/private` 查看与取消类别私密 |

转私密/还原刻意复用普通书签端点：它是同一条记录的状态变化，拆成独立端点会让
"这条书签现在归谁管"变得含糊。

---

## 5. 前端入口

- **侧边栏**：`私密保险库`（锁形图标）。解锁期间右侧出现一个小圆点作为安全提示
  ——提醒你现在是打开状态。刻意不显示条数。
- **书签卡片菜单**：`设为私密`。未解锁时会提示并跳转到 `/private`，因为没有密钥
  就没有东西可以加密。执行前有二次确认（书签会从所有列表消失）。
- **编辑弹窗**：底部「私密书签 / 移入保险库」。加密的是**已保存**的记录，不是
  未提交的表单值 —— 否则会静默丢弃用户还没保存的修改。
- **命令面板**：`私密保险库`（前往）；仅在已解锁时额外出现 `锁定私密保险库`。
- **`/private` 页面**：未设置 → 创建面板；已设置未解锁 → 解锁面板；解锁 →
  列表 + 新建 / 编辑 / 移出 / 永久删除。

---

## 6. 数据库

```sql
ALTER TABLE bookmarks ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookmarks ADD COLUMN encrypted_blob TEXT;

CREATE TABLE IF NOT EXISTS private_vault (
  user_id    TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  salt       TEXT NOT NULL,
  verifier   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bm_user_private
  ON bookmarks (user_id, is_private, deleted_at);
```

部署时由 `.github/workflows/deploy.yml` 的 D1 迁移步骤自动应用。

---

## 7. 测试

`tests/private.test.ts`（18 个用例）覆盖：

- 加解密往返、错误密钥必须失败、不同 salt 派生出不同密钥；
- `buildWhere` 一定带上 `PRIVATE_BOOKMARK_CLAUSE`；列表与单条读取都看不到私密行；
- 转私密后可读列被清空、标签关联被删除，只能通过保险库读取；
- 还原后字段恢复、标签按名重建、URL 冲突返回 409；
- 三个 `/api/private/*` 端点的正常路径与 400 / 404 / 409 分支。

`tests/category-private.test.ts`（7 个用例）覆盖类别私密：

- `PRIVATE_BOOKMARK_CLAUSE` 的 `NOT EXISTS` 确实排除带私密标签的书签；
- `listBookmarks` / `loadBookmark` 看不到类别私密书签，而 `listPrivateTagsWithBookmarks`
  把它们以明文列出；
- `setTagPrivate` 用递归 CTE **级联整棵子树**（父 + 全部后代）翻转 `is_private`；
- 取消类别私密后书签重新出现在所有列表；
- `listPrivateTagsWithBookmarks` 不把"已单独加密"的书签当作明文成员泄漏。

后端全量：**517 passed**。

---

## 8. 类别私密（仅隐藏，不加密）

与 §2 的零知识加密保险库**并存但独立**。适用场景：把一整个大类（如"成人视频"）整体藏起来，
不用逐条加密，也不用逐条设置。

### 工作机制

- `tags` 表新增 `is_private` 标记（迁移 `0015_tag_private.sql`）。
- 在标签页把某标签「设为私密」→ `PATCH /api/tags/:id` 带 `{ isPrivate: true }`
  → 服务端用一条 `WITH RECURSIVE` CTE 把**该标签及其整棵子树**的 `is_private` 一次性翻转。
  因为可见性是 SQL 派生（`PRIVATE_BOOKMARK_CLAUSE` 的 `NOT EXISTS`），**不触碰任何书签行**，
  所以实时生效、取消即恢复。
- 普通用户（非本人）在所有列表 / 搜索 / 分享 / 导出 / AI 处理中都看不到这些书签；
  本人可在 `/private` 页面的「类别私密」区块查看被隐藏的成员，并一键「取消私密」。

### 与零知识保险库的区别

| 维度 | 单书签私密（§2） | 类别私密（本节） |
| --- | --- | --- |
| 服务端是否存明文 | 否（仅密文） | 是（仅隐藏） |
| 受拖库保护 | ✅ | ❌（运维直接查 D1 可见明文） |
| 适用范围 | 单条书签 | 一个标签及其全部子标签下的所有书签 |
| 实现 | `is_private=1` + `encrypted_blob` | `tags.is_private=1` 派生隐藏 |
| 实时性 | 转/还原需改写书签行 | 标签标记即时生效，零书签改写 |

> 类别私密是"对**其他用户**完全隐藏"的轻量方案，不是"对服务端保密"。若需服务端也读不到，
> 请用 §2 的零知识保险库逐条加密。

### 前端入口

- **标签页**：私密标签带锁形角标 + 「私密」字样；卡片菜单新增「设为私密 / 取消私密」开关。
- **`/private` 页面**：解锁区下方新增「类别私密」区块，按标签分组列出被隐藏的明文书签，
  每条标签可一键「取消私密」（带二次确认）。
