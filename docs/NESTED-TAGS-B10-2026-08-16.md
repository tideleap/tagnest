# B-10 嵌套标签（层级标签树）— 设计文档

> 状态：已实现 · 目标 commit 基线 `7088ccb`（B-9 之后，尚未推送 origin/main）
> 日期：2026-08-16
> 关联：会话路线图 B-x；`src/components/tags/buildTagTree.ts`、`src/pages/TagsPage.tsx`、`src/components/layout/Sidebar.tsx`、后端 `functions/api/tags/*` + `functions/_lib/db.ts`（`validateTagParent` / `setTagPrivate`）

## 1. 背景与目标

标签是 TagNest 找回书签的核心词汇表。用户希望把标签组织成层级——例如「前端」下挂「React」「Vue」，点「前端」就能看到整组的书签。

调研发现：**数据模型与后端早已完整支持层级**，本项只是把前端能力补齐：

- `tags.parent_id` 列存在，`Tag` 类型带 `parentId` / `isPrivate`；
- `POST /api/tags` 与 `PATCH /api/tags/:id` 都接受 `parentId`，并调用 `validateTagParent` 做存在性 + 归属 + 环检测（深度上限 64，防损坏数据死循环）；
- `setTagPrivate` 用递归 CTE 把私密标志级联到整棵子树；
- 侧栏 `TagTree` 与 Tags 页已用 `buildTagTree` 渲染树形结构。

**真正缺失的两点**（即用户描述的「建/改标签可选父级」「点父标签按子树过滤」）：

1. 新建/编辑标签时没有「父级」选择器——`TagFormDialog` 只传 `name` + `colorIndex`；
2. 点击父标签只按该标签自身过滤，不展开子树。

## 2. 范围决策

- **纯前端实现**，不新增端点、不新增迁移、不改数据模型。子树过滤通过把子树 id 平铺进现有的多标签 `?tagIds`（OR）过滤实现，后端零改动。
- **子树过滤落点**：侧栏标签树 + Tags 页「浏览」入口两点（分类浏览的主入口）。Library 内书签上的标签 chip 仍按单标签精确过滤（保留既有细化行为，避免交互歧义），属有意的范围取舍。
- **TagPicker（书签编辑器内联打标签）不在此轮加父级选择**——内联场景以「快速按名添加」为主，层级在 Tags 页统一管理更清晰。已知限制，后续可补。

## 3. 算法：子树展开（客户端）

`buildTagTree.ts` 新增两个纯函数：

- `subtreeIds(tags, rootId)`：返回 `rootId` 及其全部后代 id（基于 `parentId` 邻接表做 DFS，去重）。确定性强、可单测。
- `candidateParents(tags, excludeId?)`：返回「父级」下拉选项，排除 `excludeId` 及其整棵子树（与后端 `validateTagParent` 双保险防环），子级标签按深度缩进显示。

过滤语义：`?tagIds=a,b,c` 在 `listBookmarks` 中是 `EXISTS (... WHERE tag_id IN (a,b,c))` 的 OR 过滤。因此把子树所有 id 平铺进 `?tagIds` 即等价于「按子树过滤」，无需后端配合。

## 4. 前端改动

| 文件 | 改动 |
| --- | --- |
| `src/components/tags/buildTagTree.ts` | 新增 `subtreeIds` + `candidateParents`（纯函数） |
| `src/pages/TagsPage.tsx` | `TagFormDialog` 增加「父级」`Select`（候选排除自身+后代）；提交时把 `parentId` 传入 `useCreateTag`/`useUpdateTag`；`goToTag` 改为导航到子树 `?tagIds` |
| `src/components/layout/Sidebar.tsx` | `toggleTag` 改为按子树展开/收起（点击父标签浏览整组） |

## 5. 隐私

既有 `PRIVATE_BOOKMARK_CLAUSE` 在 SQL 层隐藏私密标签及其书签；`setTagPrivate` 已级联整棵子树。嵌套标签复用同一套机制，私密子树不会跨隐私边界泄漏，无需额外处理。

## 6. 测试策略

- `buildTagTree.test.ts`：单测 `subtreeIds`（根+后代、叶子、排除兄弟）与 `candidateParents`（排除自身+子树、缩进标签）。
- `TagsPage.test.tsx`：组件测试——打开新建对话框断言存在「父级」选择器；选择父级并提交，断言 `createTag` 收到 `{ name, parentId }`；默认父级为「（顶级标签）」即 `parentId = null`。
- 全量门禁：typecheck / lint / build / 后端 647 / 前端（含新增 8 项）/ UTF-8 校验全绿。

## 7. 完成标准

- 在 Tags 页新建标签可选父级，保存后侧栏与 Tags 页树形正确呈现层级；
- 点击父标签（侧栏或 Tags 页）进入 Library 看到整棵子树的书签；
- 私密子树不跨隐私边界泄漏；
- 结果确定性可测（纯函数单测覆盖）。

## 8. 已知限制

- TagPicker 内联打标签暂不提供父级选择（在 Tags 页统一管理）。
- Library 书签上的标签 chip 维持单标签精确过滤（非子树），属有意取舍。
