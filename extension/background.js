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
chrome.runtime.onInstalled.addListener(badge);
chrome.runtime.onStartup.addListener(badge);
