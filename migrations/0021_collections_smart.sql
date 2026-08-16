-- B-8 智能集合（保存的搜索）
-- 在 collections 表增加 kind（manual|smart）与 query（JSON 序列化搜索条件）。
-- smart 集合成员由 listBookmarks 实时计算，不依赖 collection_bookmarks。

ALTER TABLE collections ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE collections ADD COLUMN query TEXT;
