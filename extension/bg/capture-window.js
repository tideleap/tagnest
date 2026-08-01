// "一键收纳当前窗口" orchestration.
//
// Sequence (all idempotent / fails-safe):
//   1. collect the current window's bookmarkable tabs
//   2. for each, ensure a bookmark exists (POST /api/bookmarks; a 409 reuses
//      the existing record so re-running never duplicates)
//   3. create one tab group named after the batch
//   4. add every bookmark to the group
// Any step that needs auth throws ApiError up to the caller (popup / service
// worker) so it can surface a clear message instead of a generic hard error.
import { loadConfig, isConfigured } from './config.js';
import { collectBookmarkableTabs, windowGroupName } from './tabs.js';
import { ensureBookmark, createGroup, addGroupItem } from './api.js';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ERRORS = 5; // stop a window capture after this many failures

/**
 * @returns {Promise<{group?:string, saved:number, existed:number, skipped:number, failed:number, errors:string[], notConfigured:boolean}>}
 */
export async function captureWindow(windowId) {
  const cfg = await loadConfig();
  if (!isConfigured(cfg)) {
    return { group: null, saved: 0, existed: 0, skipped: 0, failed: 0, errors: [], notConfigured: true, openOptions: true };
  }

  const tabs = await collectBookmarkableTabs(windowId ?? chrome.windows.WINDOW_ID_CURRENT);
  if (tabs.length === 0) {
    return {
      group: null, saved: 0, existed: 0, skipped: 0, failed: 0, errors: [],
      message: '当前窗口没有可收藏的网址（仅支持 http/https）',
    };
  }

  const results = { saved: 0, existed: 0, failed: 0, errors: [] };
  const bookmarkIds = [];

  for (let i = 0; i < tabs.length && results.failed < MAX_ERRORS; i++) {
    const tab = tabs[i];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const { id, existed } = await ensureBookmark(cfg, { url: tab.url, title: tab.title }, ac.signal);
      bookmarkIds.push(id);
      if (existed) results.existed += 1;
      else results.saved += 1;
    } catch (err) {
      results.failed += 1;
      results.errors.push(`${tab.title || tab.url}: ${err?.message || err}`);
    } finally {
      clearTimeout(timer);
    }
  }

  if (bookmarkIds.length === 0) {
    return { group: null, saved: 0, existed: 0, skipped: 0, failed: 0, errors: results.errors,
      message: '未能收藏任何标签页' };
  }

  let groupId = null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  try {
    const group = await createGroup(cfg, { name: windowGroupName(bookmarkIds.length), colorIndex: 2 }, ac.signal);
    groupId = group?.id ?? null;
  } catch (err) {
    // Group creation is a convenience; a failure here shouldn't discard the saves.
    results.errors.push(`创建分组失败：${err?.message || err}`);
  } finally {
    clearTimeout(timer);
  }

  if (groupId) {
    for (const bid of bookmarkIds) {
      const ac2 = new AbortController();
      const timer2 = setTimeout(() => ac2.abort(), REQUEST_TIMEOUT_MS);
      try {
        await addGroupItem(cfg, groupId, bid, ac2.signal);
      } catch (err) {
        results.errors.push(`加入分组失败（书签 ${bid}）：${err?.message || err}`);
      } finally {
        clearTimeout(timer2);
      }
    }
  }

  return {
    group: groupId ? windowGroupName(bookmarkIds.length) : null,
    groupId,
    saved: results.saved,
    existed: results.existed,
    failed: results.failed,
    errors: results.errors,
  };
}
