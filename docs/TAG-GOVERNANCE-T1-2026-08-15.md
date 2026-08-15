# T1 标签治理面板 — 设计决策（B-5a）

日期：2026-08-15 · 状态：已定稿，进入实施

## 现状盘点（调研结论）

| 能力 | 现状 | 缺口 |
|---|---|---|
| 合并端点 | `POST /api/tags/merge`（sourceIds≤50，INSERT OR IGNORE 重指向 + 级联删源标签） | **无审计记录**；一次只能一个目标 |
| 健康检查 | `GET /api/ai/taxonomy` 返回重复簇（≤50）+ 未使用标签（count=0，≤100） | 无**低频**（count=1）维度 |
| 别名建议 | `GET/POST /api/ai/taxonomy/aliases`（离线 + 模型，apply 只增不删） | 无 |
| 前端 | OrganizePage「体检」tab 的 TaxonomyPanel：重复簇逐个合并、未使用逐个删除、AliasSuggestions | 无**一键全并**、无**批量清理**、无**合并历史** |
| 测试 | taxonomy.test.ts 为纯算法单测；merge 端点**零契约测试** | 需补 |

## 关键决策

### D1：治理界面落在 OrganizePage「体检」tab，不在设置页复制区块

任务原文写「设置页新增标签治理区块」，但 TaxonomyPanel 已是事实上的治理中心（重复/孤儿/别名三合一）。在设置页再建一个同功能区块会把同一特性拆成两个入口、两套失效逻辑。**决策**：增强 TaxonomyPanel 为唯一治理界面；设置页不重复建设。这是对任务措辞的有意偏离，理由记录在此。

### D2：合并审计表 `tag_merge_log`（迁移 0019）

```sql
CREATE TABLE IF NOT EXISTS tag_merge_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  target_tag_id TEXT NOT NULL,
  target_tag_name TEXT NOT NULL,      -- 快照：目标标签日后可能被删
  source_tag_names TEXT NOT NULL,     -- JSON 数组快照：源标签合并后即删除，名字必须自含
  merged_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tag_merge_log_user ON tag_merge_log (user_id, created_at DESC);
```

**名字必须快照**：源标签在合并时被删除、目标标签日后也可能被删，审计记录若只存 id 将变成一串无法解读的 UUID。快照使每条记录自含可读。

### D3：merge 端点扩展 `clusters` 批量模式

现有 `{ sourceIds, targetId }` 保留不变；新增可选 `clusters: Array<{ sourceIds, targetId }>`（与单组参数互斥，≤20 组，每组源 ≤50）。全部语句进一个 D1 batch，每组写一条审计。**一键全并 = 单请求**，避免前端串行 N 次调用的部分失败与 N 次缓存失效。返回 `{ merged, clusters: n, logIds }`。

### D4：低频标签 = count === 1

`GET /api/ai/taxonomy` 的 AiTaxonomyAudit 增加 `lowUsage: Array<{id, name, count}>`（≤100，按名字排序）。count=0 已在 unused；count=1 是「只用过一次」的治理候选——提示用户合并或删除，但**不提供一键全删**（每个都挂着 1 个书签，误删代价不对称）。

### D5：孤儿批量清理 `POST /api/tags/bulk-delete`

`{ ids: string[] }`（≤100），单条 `DELETE FROM tags WHERE user_id = ? AND id IN (...)`，返回 `{ deleted }`。仅删标签本身，不动书签（与单个 DELETE 语义一致）。前端「全部清理」只针对 unused 列表，ConfirmDialog 明示数量与不可撤销。

### D6：合并历史 `GET /api/tags/merge-log`

返回最近 50 条（按 created_at DESC），mapMergeLog 只暴露快照字段。前端 TaxonomyPanel 底部展示，使「合并产生审计记录」对用户可见可追溯。

## 隐私与安全

- 所有新端点 requireUserId + user_id 隔离；merge/bulk-delete 的标签所有权在 SQL WHERE 层强制。
- 审计表不含书签内容，只含标签名快照。
- 私密标签（is_private=1）可被合并/删除——治理是所有者对自己标签库的操作，与 PRIVATE_BOOKMARK_CLAUSE 的书签隐私是两层问题；但审计快照会记录私密标签名，这是所有者自己的数据，可接受。

## 测试计划

- `tests/tag-governance.test.ts`（新）：merge 单组（重指向 + 删源 + 审计落库）、merge clusters 批量、merge 目标不存在 404、bulk-delete（含他人标签不可删）、merge-log 返回与隔离、taxonomy audit 含 lowUsage。
- dbMock 扩展：bookmark_tags repoint 的 INSERT...SELECT、DELETE FROM TAGS IN、TAG_MERGE_LOG 的 INSERT/SELECT、loadVocabulary 已有。
- 前端：TaxonomyPanel 交互测试（一键全并按钮、批量清理确认、历史展示）。

## 已知限制

- 合并不可撤销（与现状一致）；审计记录提供追溯但不提供回滚。
- clusters 批量在 D1 batch 内非事务性回滚（D1 batch 语义为尽力执行）；每组语句幂等（INSERT OR IGNORE），重复调用安全。
