// TagNest extension background service worker (MV3 module).
import { captureWindow } from './capture-window.js';
import { ensureBookmark } from './api.js';
import { loadConfig, isConfigured } from './config.js';

// Keyboard shortcut: Ctrl+Shift+T -> capture current window.
chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture-window') {
    void runCaptureAndUpdateBadge(chrome.windows.WINDOW_ID_CURRENT);
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
      try {
        const cfg = await loadConfig();
        if (!isConfigured(cfg)) {
          sendResponse({ ok: false, notConfigured: true, message: '请先在设置中填写 TagNest 服务器与 API 密钥' });
          return;
        }
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 20_000);
        try {
          const { id, existed } = await ensureBookmark(cfg, { url: msg.url, title: msg.title }, ac.signal);
          sendResponse({ ok: true, id, existed, saved: existed ? 0 : 1 });
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        sendResponse({ ok: false, message: err?.message || '收藏失败' });
      }
    })();
    return true; // async response
  }
});

async function runCaptureAndUpdateBadge(windowId) {
  const result = await captureWindow(windowId);
  await updateBadge(result);
}

async function updateBadge(result) {
  // Surface the outcome on the toolbar badge — no extra permissions needed.
  void chrome.action.setBadgeBackgroundColor({ color: '#b98a2f' });
  if (result.failed === 0 && (result.saved > 0 || result.existed > 0)) {
    await chrome.action.setBadgeText({ text: `+${result.saved || result.existed}` });
    // Badges persist; clear it with a slight delay so it reads as a flash.
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
  } else {
    await chrome.action.setBadgeText({ text: '' });
    if (result.openOptions) {
      chrome.runtime.openOptionsPage();
    }
  }
}
