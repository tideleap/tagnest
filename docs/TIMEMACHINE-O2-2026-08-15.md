# B-2 设计决策：O2 时光机（快照产品化 + 一键回滚）（2026-08-15）

任务 #203（B-2a 调研）产出。基于代码证据。

## 1. 快照语义（关键结论）

TagNest 快照是**网页截图历史**（WebP，R2 存储），不是书签元数据版本：

- 键格式 `snapshots/{userId}/{bookmarkId}-{tsMs}.webp`（snapshots.ts:69）
- `bookmarks.snapshot_key` = 当前展示版本；`snapshot_keys` = 保留历史（oldest→newest JSON 数组）
- retention：`user_settings.snapshot_retention_limit`（默认 5，-1 不限），超限自动删最旧（planRetention 纯函数）
- 服务路由 `/api/snapshots/:key`（base64url 编码键，KEY_PATTERN 白名单防穿越，无鉴权但键即令牌）

**因此「一键回滚」的正确语义 = 把指定历史版本设为当前展示快照**（swap `snapshot_key`），不涉及书签元数据恢复。这与方案 O2「列出快照点、一键回滚」一致；「diff 预览」降级为缩略图并排对比（截图 diff 无实际价值）。

## 2. 现状盘点

| 能力 | 现状 |
|---|---|
| 版本列表端点 | ✅ GET /api/bookmarks/:id/snapshots（key/url/isLatest/capturedAt，newest first） |
| 单书签捕获 | ✅ POST /api/bookmarks/:id/snapshot（capture→R2→retention→DB） |
| 状态端点 | ✅ GET /api/bookmarks/:id/snapshot/status（三态 none/expired/fresh） |
| 前端历史查看器 | ✅ BookmarkCard 菜单「查看快照历史」→ Modal 缩略图网格 |
| **回滚端点** | ❌ 缺失 |
| **前端恢复入口** | ❌ Modal 只读，无恢复按钮 |
| 设置页保留策略 | ✅ SnapshotsSection 已有说明与选项 |

## 3. 实施清单

### 后端（零迁移）
1. `POST /api/bookmarks/:id/snapshots/restore`（新文件 `functions/api/bookmarks/[id]/snapshots/restore.ts`）：
   - body `{ key: string }`；loadBookmark 校验所有权（404）
   - loadSnapshotState 取保留列表；key 不在列表 → 400（防伪造/已清理键）
   - updateBookmarkSnapshots(env, userId, id, key, 原列表)——只换 snapshot_key
   - 幂等：key 已是当前 → 200 返回同键
2. dbMock 补两个处理器：loadSnapshotState 的 SELECT、updateBookmarkSnapshots 的 UPDATE

### 前端
3. `useRestoreSnapshot` mutation（snapshots.ts）：POST restore，成功 invalidate snapshots/status/bookmarks + toast
4. BookmarkCard 快照历史 Modal：每项加「恢复到此版本」按钮（isLatest 隐藏），恢复前确认（直接 toast 反馈，操作本身可再次恢复，无需重确认对话框——恢复是无损的指针切换）
5. Modal 标题改「时光机」，文案说明版本语义

### 文档
6. SnapshotsSection 功能说明补一句时光机入口指引

## 4. 边界与风险

- restore 不触碰 R2 对象，纯 DB 指针切换，天然幂等、零数据风险
- 已清理（retention 删除）的键不在 snapshot_keys 中，restore 直接 400，不会指向幽灵对象
- 私密书签：loadBookmark 走 PRIVATE_BOOKMARK_CLAUSE，私密/类别私密书签无法 restore（404），与现有端点一致
- 分享页读 snapshot_key 派生 URL，restore 后即时生效（完成标准）
