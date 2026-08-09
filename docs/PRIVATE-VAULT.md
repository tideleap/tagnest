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
export const PRIVATE_BOOKMARK_CLAUSE = 'b.is_private = 0';
function buildWhere(...) {
  const where = ['b.user_id = ?', PRIVATE_BOOKMARK_CLAUSE];  // 默认就带上
  ...
}
```

该条件被注入到全部 8 处普通查询：书签列表 / 全文搜索 / 单条读取 / 统计
（`/api/stats`）/ AI 概览 / 批量打标签 / 分享内容 / 导出与导出预览。
只有 `functions/api/private/*` 下的三个端点绕过它。

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

后端全量：**510 passed**。
