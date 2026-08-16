-- B-11 RSS 订阅（自动拉取收藏）
-- feeds 表保存用户的 RSS/Atom 订阅源。每次手动刷新或定时刷新时，
-- 解析源里的条目并通过 url_key 去重写入 bookmarks，同时按 tag_names 自动打标签。
--
-- cadence 描述理想刷新频率（无 cron 触发器时由「刷新全部」按钮 / 未来调度触发）：
--   off   不自动刷新（仅手动）
--   hourly 每小时
--   daily  每天
--   weekly 每周
--
-- tag_names 存 JSON 数组，保证「订阅源级别的默认标签」可被前端直接读取，
-- 也避免为多对多关系再开一张表（订阅源数量远小于书签数量）。

CREATE TABLE IF NOT EXISTS feeds (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  url            TEXT NOT NULL,
  tag_names      TEXT NOT NULL DEFAULT '[]',
  cadence        TEXT NOT NULL DEFAULT 'off',
  last_fetched_at TEXT,
  last_status    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feeds_user ON feeds(user_id);
