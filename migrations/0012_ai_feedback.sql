-- Phase 2: 用户反馈记忆
--
-- 记录用户对每条标签建议的接受/忽略/修改行为，使 AI 整理形成「越用越准」
-- 的个性化闭环。feedbackBoost 在 scoring.ts 中根据 (标签, 域名) 的历史接受
-- 率修正置信度：常被接受的标签被提升、常被忽略的被降权或丢弃；用户曾把 A
-- 改成 B 时，未来同类书签优先推荐 B。

-- 反馈流水表。CREATE 用 IF NOT EXISTS 以便幂等重跑；变更列用 ALTER（见下）。
CREATE TABLE IF NOT EXISTS ai_feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  bookmark_id TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  action TEXT NOT NULL,        -- accepted / rejected / modified
  final_tag_id TEXT,           -- modified 时指向用户改用的目标标签
  source TEXT,                 -- model / heuristic / taxonomy
  confidence REAL,
  domain TEXT,                 -- 书签域名，用于 (标签, 域名) 级反馈
  context TEXT,                -- 标题/域名/主题摘要；modified 时存放改用后的标签名
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_feedback_user_tag ON ai_feedback(user_id, tag_name);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_user_domain ON ai_feedback(user_id, domain);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_user_created ON ai_feedback(user_id, created_at);

-- tag_suggestions 增加「是否由反馈提升」标记，供前端展示「已学习」徽标。
-- ALTER 不可 IF NOT EXISTS，幂等由 migrate.mjs 的探针保证。
ALTER TABLE tag_suggestions ADD COLUMN feedback_boosted INTEGER NOT NULL DEFAULT 0;
