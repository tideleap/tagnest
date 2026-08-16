# B-8 智能集合（保存的搜索）— 设计文档

> 日期：2026-08-16 ｜ 基线：`82d5658`（B-7 已推送）｜ 任务 #193
> 关联：《TagNest-优化后待办清单》B-8（S3/K2 智能集合）、`shared/types.ts`、`functions/_lib/db.ts`、`functions/api/collections/*`

## 1. 目标

把「搜索条件」固化为一个**动态集合**：保存后，集合的成员随书签库的变更实时重算，始终与原始搜索一致。用户可在搜索结果页一键「保存为智能集合」，之后在集合列表/详情页像普通集合一样浏览，但成员由查询驱动、不可手动增删。

完成标准（源自待办清单）：保存搜索 → 集合成员实时一致。

## 2. 范围决策：扩展 `collections` 而非新建 `saved_searches` 表

待办清单原文写「saved_searches 表 + 查询序列化 + 集合页动态成员」。经调研现有代码，作如下收敛决策并说明理由：

- **现状**：`collections` 已是完整的「命名书签聚合」原语——后端 `collections`/`collections/[id]`/`collections/[id]/bookmarks` 三端点 + 前端 `CollectionsPage`/`CollectionDetail` + hooks（`useCollections`/`useCollection`/`useCreateCollection`/…）齐备；成员通过 `collection_bookmarks` 连接表存储。
- **决策**：在 `collections` 表增加 `kind`（`manual`|`smart`）与 `query`（JSON 序列化搜索条件）两列；`smart` 集合**不复用** `collection_bookmarks`，其成员由 `listBookmarks` 实时计算。
- **理由**：
  1. 完成标准要求「集合成员实时一致」，即智能集合要融入集合页 → 复用集合原语天然满足，无需为 saved search 另建一整套页面/导航/分享/卡片。
  2. 避免查询序列化逻辑与 `listBookmarks` 分裂成两套（saved_searches 表若独立，仍需调用 `listBookmarks`，反而多一层映射）。
  3. 分享（`shares` 已支持 `collectionId`）、报告、侧边栏入口全部自动惠及智能集合，无额外编码。
- **对外契约**：`Collection` 增加 `kind: CollectionKind`、`query: SavedSearchQuery | null` 两个字段。手动集合返回 `kind:'manual', query:null`。

> 注：此为非破坏性扩展（迁移加列带默认值），既有手动集合行为零改动。

## 3. 数据模型

### 3.1 迁移 `migrations/0021_collections_smart.sql`

```sql
ALTER TABLE collections ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE collections ADD COLUMN query TEXT;  -- JSON: SavedSearchQuery，manual 为 NULL
```

- `kind` 取值约束在应用层校验（`manual`|`smart`）；不依赖 SQLite CHECK（D1 对 CHECK 支持不一致，应用层校验更稳）。
- `query` 为 TEXT 存 JSON 字符串；解析失败视为无效（创建/更新时即校验，落库前保证合法）。

### 3.2 类型（`shared/types.ts`）

```typescript
export type CollectionKind = 'manual' | 'smart';

/** 可序列化的搜索条件，与 listBookmarks(ListParams) 对齐。 */
export interface SavedSearchQuery {
  q: string | null;          // 关键词，最长 200
  tagIds: string[];          // 标签 id，最多 20
  matchAllTags: boolean;     // 与/或语义
  scope: BookmarkScope;      // inbox|all|favorites|archive|trash
  sort: BookmarkSort;        // created_desc|created_asc|updated_desc|title_asc|visits_desc|manual
}

// Collection 增加：
//   kind: CollectionKind;
//   query: SavedSearchQuery | null;
```

## 4. 后端契约

### 4.1 `GET /api/collections`（列表）

- 现有 LEFT JOIN 计数对 manual 集合有效；smart 集合改为按 `query` 经 `countBookmarks` 实时计数。
- 返回每个 `Collection` 含 `kind` 与 `query`（query 原样回传，供前端展示/编辑）。

### 4.2 `POST /api/collections`（创建）

请求体新增可选字段：

```jsonc
{
  "name": "设计参考",
  "colorIndex": 3,            // 可选
  "kind": "smart",            // 可选，默认 manual
  "query": {                  // kind=smart 时必填且须合法
    "q": "design system",
    "tagIds": ["id1","id2"],
    "matchAllTags": false,
    "scope": "all",
    "sort": "created_desc"
  }
}
```

- `kind` 缺失 → 视为 `manual`（向后兼容旧调用）。
- `kind='smart'` 但 `query` 缺失/非法 → `400`。
- `query` 落库前经 `validateSavedSearchQuery` 校验与裁剪（q 截 200、tagIds 截 20、scope/sort 取枚举合法值，否则回退默认）。
- 名称唯一性、长度限制沿用现有逻辑。

### 4.3 `GET /api/collections/:id`（详情 + 成员）

- `kind='manual'`：行为不变（JOIN `collection_bookmarks`）。
- `kind='smart'`：用 `listBookmarks(env, { userId, ...deserialize(query), limit })` 计算成员；`collection.count` 以 `listBookmarks` 返回的 `total` 覆盖。私密过滤沿用 `PRIVATE_BOOKMARK_CLAUSE`（listBookmarks 已内置）。

### 4.4 `PUT /api/collections/:id`（编辑）

- 允许改 `name`/`colorIndex`（沿用）。
- `kind='smart'` 时允许改 `query`（同样经 `validateSavedSearchQuery`）；`kind` 字段本身不可改（避免 manual↔smart 互转带来的成员语义混乱；如需转换，先删后建）。
- 若请求体带 `kind` 且与现有不符 → `400`。

### 4.5 `DELETE /api/collections/:id`（删除）

- 行为不变：级联删 `collection_bookmarks`。smart 集合无 `collection_bookmarks` 行，级联为空操作，安全。

### 4.6 `POST/DELETE /api/collections/:id/bookmarks`（成员增删）

- `kind='smart'` 时手动增删无意义 → 返回 `409 conflict`（「智能集合成员由搜索自动维护」）。
- `kind='manual'` 行为不变。

### 4.7 新增 `functions/_lib/db.ts` 导出

`countBookmarks(env, p: ListParams): Promise<number>` —— 复用 `buildWhere` 仅取 `COUNT(*)`，供 smart 集合列表计数与详情计数复用，避免重复 WHERE 构造。

## 5. 前端集成

### 5.1 类型与 hooks

- `shared/types.ts`：`CollectionKind`、`SavedSearchQuery`、`Collection` 加字段。
- `src/hooks/queries/collections.ts`：
  - `useCreateCollection` 入参扩展 `{ name; colorIndex?; kind?; query? }`。
  - `useRenameCollection` 入参 `patch` 加 `query?`（smart 编辑用）。
  - 其他 hook 不变。

### 5.2 LibraryPage：保存为智能集合入口

- 在搜索结果 `PageHeader` 区（排序 `Select` 旁）增加「保存为智能集合」按钮（图标 `BookmarkPlus`/`Save`）。
- 点击打开 `SaveSmartCollectionDialog`：预填名称（默认用当前搜索摘要，如 `搜索：design system` 或 `3 个标签`），展示当前过滤条件摘要（q / 标签数 / 范围 / 排序），确认后 `useCreateCollection.mutate({ name, kind:'smart', query:{ q, tagIds, matchAllTags:false, scope, sort } })`，成功后 toast 并可选跳转 `/collections/:id`。
- 仅在存在有效过滤（`q` 非空或 `tagIds` 非空）时按钮可用；纯 `scope=all` 无过滤时禁用并提示「先设置搜索条件」。

### 5.3 CollectionsPage：种类徽章

- 集合卡片增加「智能」徽章（`kind==='smart'`，用 `Badge tone="positive"` 或信息色），manual 不显示。
- 智能集合卡片副标题展示查询摘要（如 `q + 2 标签 · all`）。

### 5.4 CollectionDetail：智能集合只读成员

- `kind==='smart'` 时：
  - 隐藏「添加书签」按钮与每条目的「从集合移除」（成员由查询驱动）。
  - `PageHeader` 描述显示「智能集合 · 实时匹配 N 个书签」，并展示查询条件摘要（可展开）。
  - 条目列表复用现有渲染（仅去掉移除按钮）。
  - 编辑菜单保留「重命名/改色」，并在编辑弹窗展示查询摘要（只读），不提供成员编辑。

### 5.5 组件 API 复用注意

- `Select` 用 `options={SelectOption[]}` 属性（非 `<option>` 子元素）——前几轮已踩坑，本任务新写 `Select` 一律遵守。
- `useMutation` 的 `mutationFn` 即便参数标 `?` 可选，`mutate()` 仍报 TS2554 → 智能集合保存用 `mutate(input)` 显式传参。

## 6. 测试策略

### 6.1 后端契约（`tests/smart-collections.test.ts`，dbMock 扩展）

1. 创建 manual 集合（无 kind）→ 默认 `kind:'manual', query:null`。
2. 创建 smart 集合（带合法 query）→ 返回 `kind:'smart'` 且 `query` 回显一致。
3. 创建 smart 集合但缺 query → `400`。
4. smart 集合详情成员 == 按相同 query 调 listBookmarks 的结果（实时一致）；成员数 == total。
5. 新增书签命中查询条件后，smart 集合成员数 +1（验证实时性）。
6. smart 集合计数不含私密书签（PRIVATE_BOOKMARK_CLAUSE 生效）。
7. 多租户隔离：A 的智能集合 B 不可见、不可 DELETE（404）。
8. 向 smart 集合 POST 成员 → `409`。
9. 列表计数：smart 集合 count == 实时 total（非 collection_bookmarks 计数）。
10. `query` 越界裁剪：tagIds 超 20 截断、q 超 200 截断、非法 scope/sort 回退默认。

### 6.2 前端组件（含在 `CollectionDetail.test.tsx` 扩展或独立）

- 智能集合详情不渲染「添加书签」按钮；手动集合渲染。
- LibraryPage 保存对话框：无过滤时按钮禁用；有过滤时点击调用 `useCreateCollection` 且 `kind:'smart'`。

## 7. 已知限制

- `kind` 不可 manual↔smart 互转（先删后建），避免成员语义歧义。
- smart 集合成员上限受 `listBookmarks` `MAX_LIMIT=100` 约束（详情分页用 cursor，列表计数用 total，无截断风险；但单页展示上限 100，足够）。
- 标签被删除后，其 id 不再匹配，smart 集合自动少对应书签（符合预期）。
- 搜索不支持保存 `matchAllTags` 之外的复杂布尔（与 LibraryPage 现有能力一致）。

## 8. 门禁与交付

- 全量门禁：typecheck / ESLint / 后端测试 / UI 测试 / `NODE_OPTIONS="--use-system-ca" npm run build` / 含中文文件 UTF-8。
- 分两组提交：后端（迁移 + 类型 + collections 端点 + db.countBookmarks + 测试）与前端（hooks + LibraryPage/CollectionsPage/CollectionDetail 集成 + 测试）。
- 推送后 loose-ref 校正；更新 `TagNest-优化后待办清单.md` 与当日 memory。
- backlog.json 登记 B-8 并过 `npm run backlog:check`。
