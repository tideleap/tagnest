// Tab collection helpers for the TagNest extension.
//
// We only read what MV3 `tabs` grants us: url + title for each tab. Internal
// schemes (chrome://, edge://, about:, devtools, extension pages) can't be
// bookmarked — filter them out before anything hits the API.

const BOOKMARKABLE = /^(https?:\/\/)/i;

/** @returns {{id:number,url:string,title:string}[]} tabs worth saving. */
export async function collectBookmarkableTabs(windowId) {
  const query = { windowId, discarded: false };
  const tabs = await chrome.tabs.query(query);
  return tabs
    .filter((t) => t.id != null && typeof t.url === 'string' && BOOKMARKABLE.test(t.url))
    .map((t) => ({
      id: t.id,
      url: t.url,
      title: (t.title || '').trim().slice(0, 300),
    }));
}

/** title for the auto-created window group. */
export function windowGroupName(count) {
  if (count <= 1) return '标签页';
  return `${count} 个标签页`;
}
