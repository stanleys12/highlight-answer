// Highlight Answer — background worker. Page scripts cannot reach the local helper (the page's own security
// policy governs their requests), so the request goes through here. It only ever talks to 127.0.0.1:8799.
const HELPER = 'http://127.0.0.1:8799';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'answer') return false;
  fetch(HELPER + '/answer', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Highlight-Answer': '1' }, body: JSON.stringify(msg.data) })
    .then((r) => r.json()).then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: 'helper not running on 127.0.0.1:8799 (' + String(e.message || e).slice(0, 60) + ')' }));
  return true;
});

// the toolbar button turns it on and off
async function badge() {
  const { enabled = true } = await chrome.storage.sync.get('enabled');
  await chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: '#777' });
}
chrome.action.onClicked.addListener(async () => {
  const { enabled = true } = await chrome.storage.sync.get('enabled');
  await chrome.storage.sync.set({ enabled: !enabled }); badge();
});
// ── right-click backup: "Answer with Highlight Answer" on any selection ─────────────────────────────────
// 1) the page's own script answers it (and can still click the option / fill the box);
// 2) the page has no script yet (a tab opened before the extension was installed / reloaded): put it there, retry;
// 3) Chrome does not let extensions into the page (PDF viewer, chrome:// pages, the Web Store): a small window answers.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => chrome.contextMenus.create({ id: 'answer', title: 'Answer with Highlight Answer', contexts: ['selection'] }));
});
async function force(tab, info) {
  const to = { frameId: info.frameId || 0 };
  const send = () => chrome.tabs.sendMessage(tab.id, { type: 'force', text: info.selectionText }, to);
  try { const r = await send(); if (r && r.ok) return; } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [to.frameId] }, files: ['content.js'] });
      const r = await send(); if (r && r.ok) return;
    } catch {}
  }
  const u = chrome.runtime.getURL('answer.html') + '?' + new URLSearchParams({ text: info.selectionText || '', url: tab.url || info.pageUrl || '', title: tab.title || '' });
  chrome.windows.create({ url: u, type: 'popup', width: 460, height: 360, focused: true });
}
// The address bar is Chrome's own — no page script can see a highlight there. Instead: type "ask", space, question, ⏎.
function answerWindow(text, url, title) {
  const u = chrome.runtime.getURL('answer.html') + '?' + new URLSearchParams({ text: text || '', url: url || '', title: title || '', typed: '1' });
  chrome.windows.create({ url: u, type: 'popup', width: 460, height: 360, focused: true });
}
chrome.omnibox.setDefaultSuggestion({ description: 'Answer with Highlight Answer: %s' });
chrome.omnibox.onInputEntered.addListener((text) => { if (text.trim()) answerWindow(text.trim(), '', 'Chrome address bar'); });
chrome.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === 'answer' && tab) force(tab, info); });
chrome.runtime.onInstalled.addListener(badge);
chrome.runtime.onStartup.addListener(badge);
