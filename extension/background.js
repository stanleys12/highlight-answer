// Highlight Answer — background worker. Page scripts cannot reach the local helper (the page's own security
// policy governs their requests), so the request goes through here. It only ever talks to 127.0.0.1:8799.
const HELPER = 'http://127.0.0.1:8799';

const H = { 'Content-Type': 'application/json', 'X-Highlight-Answer': '1' };
const down = (e) => 'helper not running on 127.0.0.1:8799 (' + String(e.message || e).slice(0, 60) + ')';
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'answer') {
    fetch(HELPER + '/answer', { method: 'POST', headers: H, body: JSON.stringify(msg.data) })
      .then((r) => r.json()).then(sendResponse).catch((e) => sendResponse({ ok: false, error: down(e) }));
    return true;
  }
  if (msg.type === 'lang') { chrome.i18n.detectLanguage(msg.text || '', (r) => sendResponse(r || null)); return true; }   // Chrome's own detector, on this computer
  if (msg.type === 'metric') { fetch(HELPER + '/metric', { method: 'POST', headers: H, body: JSON.stringify(msg.data) }).catch(() => {}); return false; }
  if (msg.type === 'stats') { fetch(HELPER + '/stats?days=' + (msg.days || 7), { headers: H }).then((r) => r.json()).then(sendResponse).catch((e) => sendResponse({ ok: false, error: down(e) })); return true; }
  return false;
});

// Streaming answers: the page opens a port, gets {type:'delta',text} as the answer is written, then {type:'final',…}.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'answer') return;
  let alive = true; port.onDisconnect.addListener(() => { alive = false; });
  port.onMessage.addListener(async (data) => {
    let fin = false;
    const post = (m) => { if (m && m.type === 'final') fin = true; if (alive) try { port.postMessage(m); } catch {} };
    const line = (l) => { if (l.trim()) try { post(JSON.parse(l)); } catch {} };
    try {
      const res = await fetch(HELPER + '/answer', { method: 'POST', headers: H, body: JSON.stringify({ ...data, stream: true }) });
      if (!res.ok) { const j = await res.json().catch(() => null); return post({ type: 'final', ok: false, error: (j && j.error) || 'helper answered HTTP ' + res.status }); }
      const rd = res.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { done, value } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true }); let i;
        while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
      line(buf + dec.decode());
      // without a final message the page would show "Thinking…" forever
      if (!fin) post({ type: 'final', ok: false, error: 'the helper ended the answer early' });
    } catch (e) { post({ type: 'final', ok: false, error: down(e) }); }
  });
});

// the toolbar button opens the preset picker (popup.html); the badge shows the preset — F / B / A — or OFF
const PRESETS = ['fast', 'balanced', 'accurate'];
async function badge() {
  const { enabled = true, preset = 'balanced' } = await chrome.storage.sync.get(['enabled', 'preset']);
  await chrome.action.setBadgeText({ text: !enabled ? 'OFF' : { fast: 'F', balanced: 'B', accurate: 'A' }[preset] || 'B' });
  await chrome.action.setBadgeBackgroundColor({ color: !enabled ? '#777' : { fast: '#d08770', balanced: '#5e81ac', accurate: '#a3be8c' }[preset] || '#5e81ac' });
}
chrome.storage.onChanged.addListener((ch) => { if (ch.preset || ch.enabled) badge(); });
// ⌥⇧A (change it at chrome://extensions/shortcuts): Fast → Balanced → Accurate → Fast
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'cycle-preset') return;
  const { preset = 'balanced' } = await chrome.storage.sync.get('preset');
  await chrome.storage.sync.set({ preset: PRESETS[(PRESETS.indexOf(preset) + 1) % PRESETS.length], enabled: true });
});
// ── right-click backup: "Answer with Highlight Answer" on any selection ─────────────────────────────────
// 1) the page's own script answers it (and can still click the option / fill the box);
// 2) the page has no script yet (a tab opened before the extension was installed / reloaded): put it there, retry;
// 3) Chrome does not let extensions into the page (PDF viewer, chrome:// pages, the Web Store): a small window answers.
// On install / update / reload: put the page script into every tab that is already open. Otherwise those tabs keep
// the old copy, which the reload cut off from the extension — highlights there did nothing until a right-click.
async function injectOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.map((t) => chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['content.js'] }).catch(() => {})));
}
chrome.runtime.onInstalled.addListener(injectOpenTabs);
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
