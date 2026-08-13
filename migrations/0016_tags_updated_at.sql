-- Tags 表缺少 updated_at，setTagPrivate 的递归 CTE 在更新子树时会引用该列，
-- 导致线上 PATCH /tags/:id {isPrivate} 报 "no such column: updated_at"。
-- SQLite ALTER TABLE 的 DEFAULT 必须是常量，不能用 datetime('now')。
ALTER TABLE tags ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z';
