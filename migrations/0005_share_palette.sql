-- 0005_share_palette.sql
--
-- Let a share author choose which of the app's color palettes (light / dark /
-- aurora / blossom / starlight) the public share page renders with.
--
-- The layout (default / compact / cards) already lives in `shares.theme`; this
-- adds a separate `palette` column holding a ResolvedTheme key. The share page
-- sets <html data-theme> to this value while rendering, so a colorful, on-brand
-- share matches the author's app instead of always following the viewer's OS.
ALTER TABLE shares ADD COLUMN palette TEXT NOT NULL DEFAULT 'light';
