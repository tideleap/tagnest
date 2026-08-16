// TagNest extension background service worker (MV3 module).
import { captureWindow } from './capture-window.js';
import { ensureBookmark, appendNote } from './api.js';
import { loadConfig, isConfigured } from './config.js';
import { runSync, rollbackSync } from './reconcile.js';

// Keyboard shortcuts: Ctrl+Shift+S saves the active tab (selected text becomes
// the note), Ctrl+Shift+T captures the whole window.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'capture-window') {
    void runCaptureAndUpdateBadge(chrome.windows.WINDOW_ID_CURRENT);
    return;
  }
  if (command === 'save-page') {
    void saveActiveTab(tab);
  }
});

// The popup sends ops here so the heavy work never blocks the UI thread.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'capture-window') {
    (async () => {
      const result = await captureWindow(msg.windowId);
      await updateBadge(result);
      sendResponse(result);
    })();
    return true; // async response back to the popup
  }

  if (msg.type === 'save-page') {
    (async () => {
      sendResponse(await savePage(msg.url, msg.title, msg.note));
    })();
    return true; // async response
  }

  // B-12 Phase B — bidirectional sync. The background worker owns chrome.bookmarks
  // access; the sync tab sends an intent and renders the summary it gets back.
  if (msg.type === 'run-sync') {
    (async () => {
      const cfg = await loadConfig();
      if (!isConfigured(cfg)) {
        sendResponse({ ok: false, notConfigured: true });
        return;
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 90_000);
      try {
        const result = await runSync(cfg, { direction: msg.direction || 'upload', signal: ac.signal });
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, message: err?.message || '同步失败' });
      } finally {
        clearTimeout(timer);
      }
    })();
    return true; // async response
  }

  if (msg.type === 'rollback-sync') {
    (async () => {
      try {
        sendResponse(await rollbackSync());
      } catch (err) {
        sendResponse({ ok: false, message: err?.message || '恢复失败' });
      }
    })();
    return true;
  }
});

/**
 * Save one page. When the URL already exists (409) and a note was supplied,
 * the note is appended to the existing bookmark instead of being dropped.
 * Returns a popup-friendly result object.
 */
async function savePage(url, title, note) {
  try {
    const cfg = await loadConfig();
    if (!isConfigured(cfg)) {
      return { ok: false, notConfigured: true, message: '请先在设置中填写 TagNest 服务器与 API 密钥' };
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20_000);
    try {
      const cleanNote = typeof note === 'string' ? note.trim() : '';
      const { id, existed } = await ensureBookmark(cfg, { url, title, note: cleanNote || null }, ac.signal);
      let noteAppended = false;
      if (existed && cleanNote) {
        // The URL was already bookmarked — keep the new note by appending it.
        noteAppended = await appendNote(cfg, id, cleanNote, ac.signal);
      }
      return { ok: true, id, existed, noteAppended, saved: existed ? 0 : 1 };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, message: err?.message || '收藏失败' };
  }
}

/** Command entry: grab the active tab's selection (if any), then save it. */
async function saveActiveTab(fallbackTab) {
  let tab = fallbackTab;
  if (!tab?.url) {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    await flashBadge('');
    return;
  }
  const selection = await readSelection(tab.id);
  const result = await savePage(tab.url, tab.title || '', selection);
  await flashBadge(result.ok ? `+${result.saved || (result.noteAppended ? '✓' : result.existed ? 0 : 1)}` : '');
}

/**
 * Read the current text selection from a tab. Uses chrome.scripting under the
 * activeTab grant (the command gesture counts), so no broad host permissions
 * are needed. Any failure (restricted page, frame issues) yields ''.
 */
async function readSelection(tabId) {
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.getSelection()?.toString() ?? '',
    });
    return String(frames?.[0]?.result ?? '').trim();
  } catch {
    return '';
  }
}

async function runCaptureAndUpdateBadge(windowId) {
  const result = await captureWindow(windowId);
  await updateBadge(result);
}

/** Flash the toolbar badge text briefly, then clear it. */
async function flashBadge(text) {
  void chrome.action.setBadgeBackgroundColor({ color: '#b98a2f' });
  await chrome.action.setBadgeText({ text });
  if (text) setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
}

async function updateBadge(result) {
  // Surface the outcome on the toolbar badge — no extra permissions needed.
  if (result.failed === 0 && (result.saved > 0 || result.existed > 0)) {
    await flashBadge(`+${result.saved || result.existed}`);
  } else {
    await flashBadge('');
    if (result.openOptions) {
      chrome.runtime.openOptionsPage();
    }
  }
}
