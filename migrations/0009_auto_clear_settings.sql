-- 0009_auto_clear_settings.sql
--
-- "自动清空" (auto-clear on idle) preferences. Two independent modules each get
-- an enable flag + a delay-in-seconds:
--
--   search_auto_clear_enabled INTEGER NOT NULL DEFAULT 1   -- search box auto-clear on
--   search_auto_clear_delay   INTEGER NOT NULL DEFAULT 15  -- idle seconds before clearing search
--   tags_auto_clear_enabled   INTEGER NOT NULL DEFAULT 1   -- tag-filter auto-clear on
--   tags_auto_clear_delay     INTEGER NOT NULL DEFAULT 30  -- idle seconds before clearing tags
--
-- Defaults are ON (1) per the spec; users can flip each switch off or change the
-- delay. A delay of 0 means "never clear" from the caller's perspective, though
-- the UI nudges it to a sensible minimum.
--
-- The existing `user_settings` row is created lazily by the settings endpoint's
-- upsert; these columns use NOT NULL DEFAULT so any read path works even before
-- a row exists (GET falls back to defaults when absent).
ALTER TABLE user_settings ADD COLUMN search_auto_clear_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_settings ADD COLUMN search_auto_clear_delay   INTEGER NOT NULL DEFAULT 15;
ALTER TABLE user_settings ADD COLUMN tags_auto_clear_enabled  INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_settings ADD COLUMN tags_auto_clear_delay    INTEGER NOT NULL DEFAULT 30;
