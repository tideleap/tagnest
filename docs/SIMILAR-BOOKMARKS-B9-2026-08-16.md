# B-9 相似书签推荐（A2）

> 状态：设计中 · 目标 commit 基线 `3aed7e9`（B-8 之后）
> 日期：2026-08-16

## 1. 背景与目标

用户查看/编辑某条书签时，常想知道「还有哪些书签和这条相关」——同一主题的合集、同站点的多篇、标题/正文近似的重复或延伸阅读。B-9 在书签编辑器内提供一个「相似书签」面板，给出按相似度排序的相关书签，点击即可跳转。

完成标准：打开任一书签 → 编辑器内看到按相似度排序的相关书签；私密书签不跨隐私边界泄漏；结果确定性可测。

## 2. 范围决策

**不引入 AI 嵌入 / 向量库。** 产品是单用户、离线优先、隐私零知识（私密书签服务端只见密文），引入模型嵌入既增加外部依赖又破坏私密隔离。采用**多信号启发式相似度**，与既有「模型优先 + 域名兜底」纯函数哲学一致，且确定性强（同输入同输出，便于契约测试）。

**不新建表 / 不新建迁移。** 完全复用既有 `bookmarks` + `bookmark_tags` 数据，候选池由一次带 `PRIVATE_BOOKMARK_CLAUSE` 的查询取出，打分在 JS 内完成（单用户库规模小，足够快）。

## 3. 相似度算法（`functions/_lib/similarity.ts`，纯函数）

对每条候选书签与源书签计算 0~1 综合分，三路信号加权：

| 信号 | 计算 | 权重 |
| --- | --- | --- |
| 标签重合 | Jaccard(`source.tagIds`, `cand.tagIds`) | 0.60 |
| 同域名 | 归一化 host 相等 → 1，否则 0 | 0.25 |
| 文本相似 | Dice 系数 over tokenize(标题+描述+备注+URL 词) | 0.15 |

- `tokenize(text)`：CJK 按字、拉丁按词（去标点小写、去停用虚词如「的/the/and」可选省略），返回 token 多重集。
- `dice(a, b) = 2·|A∩B| / (|A|+|B|)`（空集返回 0）。
- `hostOf(url)`：安全解析，失败返回 `''`。
- `scoreBookmarkSimilarity(source, cand)`：上述加权求和，截断 0~1。
- 综合分 `> 0` 才进入候选（至少一路信号命中）；排序降序取 top `limit`。

## 4. 后端端点

**`GET /api/bookmarks/:id/similar?limit=8`**（默认 8，上限 30）

- `functions/_lib/db.ts` 新增 `similarBookmarks(env, userId, sourceId, { limit })`：
  1. `loadBookmark(env, userId, sourceId)`；不存在（含被隐私子句隐藏）→ 返回 `null`，端点抛 404。
  2. 取候选池：`SELECT id, title, description, url_key, note, ai_summary FROM bookmarks b WHERE user_id=? AND PRIVATE_BOOKMARK_CLAUSE AND deleted_at IS NULL AND is_archived=0 AND id<>?`，绑定 `[userId, sourceId]`。
  3. `attachTags(env, userId, ids)` 取候选标签桥。
  4. 逐候选 `scoreBookmarkSimilarity`，过滤 `>0`，降序，`slice(0, limit)`，用 `mapBookmark` 水合成完整 `Bookmark`。
  5. 返回 `{ items: Bookmark[]; total: number }`（`total` = 过滤后命中数，非仅返回条数）。
- 新文件 `functions/api/bookmarks/[id]/similar.ts`：`requireUserId` → 校验 `limit`（缺省 8，越界回退默认/上限）→ `similarBookmarks` → `null` 抛 `notFound` → `json(result)`。
- **私密隔离**：候选池查询带 `PRIVATE_BOOKMARK_CLAUSE`，私密书签天然不进入他人/非私密源的相关集；私密源自身能加载（同子句），但其相似集只在非私密书签中计算（私密书签彼此不互推）。与全局隐私模型一致，记为已知限制。

## 5. 前端集成

- `shared/types.ts`：`SimilarBookmarks = { items: Bookmark[]; total: number }`。
- `src/hooks/queries/bookmarks.ts`：新增 `useSimilarBookmarks(id, limit=8)`（`useQuery`，`keys.similar(id)`，`api.get<SimilarBookmarks>(/bookmarks/${id}/similar?limit=)`，`enabled: Boolean(id)`）。
- `src/hooks/queries/keys.ts`：新增 `similar: (id) => ['similar', id]`。
- 新组件 `src/components/bookmark/SimilarBookmarks.tsx`：紧凑列表（favicon + 标题 + host + 匹配原因徽章），空态「暂无相似书签」，加载态骨架。
- `src/components/bookmark/BookmarkEditor.tsx`：书签加载后，在表单下方渲染 `<SimilarBookmarks id={id} />`；点击条目 `setEditingBookmarkId(similar.id)` 跳转打开相似书签（复用编辑态）。

## 6. 测试策略

- 后端 `tests/similar-bookmarks.test.ts`（dbMock）：
  - 共享标签 > 同域名-only（排序正确性）
  - 自身不出现在结果（排除 `id<>`）
  - 私密书签不泄漏进非私密源的相似集（隐私子句）
  - `limit` 上限裁剪
  - 源不存在 → 404
  - 无命中 → `items:[]`、`total:0`
- 前端 `src/components/bookmark/SimilarBookmarks.test.tsx`：渲染条目、空态、加载态。

## 7. 已知限制

- 相似度为启发式，非语义理解（无嵌入）；长尾弱相关可能不命中（阈值 `>0` 已宽松）。
- 私密书签的相似集不含其他私密书签（隐私隔离），仅基于非私密库计算。
- 候选池为全量实时查询，单用户规模足够；超大规模（万级）再考虑预计算/分桶。
- 不跨集合/分享计算（仅用户自有库）。
