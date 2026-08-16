# TagNest 导出格式与 AI 数据边界

`GET /api/export?format=json` 产出一份全量书签库的可流式 JSON 导出，信封如下：

```json
{
  "application": "TagNest",
  "version": 1,
  "exportedAt": "2026-08-16T00:00:00.000Z",
  "bookmarks": [ { "url": "...", "title": "...", "tags": [...], "...": "..." } ],
  "collections": [ { "name": "...", "colorIndex": 0, "createdAt": "...", "urls": [...] } ]
}
```

机器可读的结构说明文件见 **`public/tagnest-export.schema.json`**（部署后可通过站点根路径
`/tagnest-export.schema.json` 访问，亦随仓库提交）。导入流程（`/api/import`）仅接受
`application === "TagNest"` 的文件，URL 作为去重主键，集合成员以 URL 引用以便内部 id 变更后仍能还原。

## 导出选项

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `format` | `json` | `json` / `html`（Netscape 书签格式）/ `csv` |
| `includeTrash` | `1` | 是否包含软删（回收站）书签 |
| `includeTags` | `1` | 是否内嵌每个书签的标签 |
| `includeMetadata` | `1` | 是否内嵌 `note` / `description` / `aiSummary` |
| `includeVisits` | `1` | 是否内嵌 `visitCount` / `lastVisitedAt` |
| `pretty` | `0` | 是否美化打印 JSON |

## 快照引用（Y4）

JSON 导出会为每条书签附带快照引用，使 TagNest→TagNest 迁移（Y4）能保留它们：

- `snapshotKey` (`string | null`)：最新一次 R2 快照对象键，用于卡片预览。
- `snapshotKeys` (`string[]`)：该书签保留的全部快照 R2 对象键（旧→新），存为 JSON 数组。

这两个字段**无条件**随 JSON 导出（不受 `includeMetadata` 控制），因为快照引用是书签身份的一部分；无快照的书签导出为 `null` / `[]`。导入流程（`/api/import`）解析后写回 `bookmarks.snapshot_key` / `snapshot_keys`，从而完成跨实例迁移。

**边界**：R2 中的快照二进制 blob **不**包含在 JSON 包内——迁移包只携带引用（键）。迁入目标实例后，若目标 R2 桶中没有对应对象，打开快照会回退（应用已有 404 回退 / 按需重抓逻辑），但引用本身已正确迁移。如需完整快照二进制随迁，需单独做 R2 桶复制，超出 JSON 迁移包范围。

## AI 数据边界（A4）

导出文件是**用户数据边界**的清晰表达——AI 功能（自动摘要、相似书签、标签建议、周报）只
可能读取书签库内的字段，且受以下约束：

- **私密保险库（private / vault）标签下的书签永远不会进入导出**，也不会被任何 AI 流程读取。
  私密书签只存在于保险库解锁之后，且永远不会出现在分享页、搜索或导出中。
- **`aiSummary` 是 AI 产出物**，仅当相应用户启用过 AI 功能时才存在；它不是训练输入，而是
  缓存结果。导出它只是为了让你在迁移后不必重新生成。
- 导出**不含**任何账户凭据、访问令牌或分享页密码哈希——它只是书签内容本身。

如果你要用导出文件驱动自己的外部 AI 流程，请以上述边界为准：只处理你有权处理的书签内容，
不要假定 `aiSummary` 的语义稳定，且应把私密标签排除在你的处理范围之外。
