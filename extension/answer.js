// The right-click fallback for pages the extension cannot enter (PDFs, chrome:// pages): answer the selected text
// in this small window. The answer cannot be put into the page there, so it is shown with Copy.
const P = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
$('q').textContent = P.get('text') || '';
const t0 = Date.now();
const tick = setInterval(() => { $('a').textContent = 'Thinking… ' + Math.round((Date.now() - t0) / 1000) + 's'; }, 1000);
chrome.storage.sync.get({ model: 'opus', think: true, aboutMe: '' }, (cfg) => {
  const data = { selection: P.get('text') || '', choices: [], target: null, url: P.get('url') || '', title: P.get('title') || '', context: '', ...cfg, force: true };
  chrome.runtime.sendMessage({ type: 'answer', data }, (r) => {
    clearInterval(tick);
    let out;
    if (!r || !r.ok) out = 'Error: ' + ((r && r.error) || 'no answer');
    else if (r.kind === 'free') out = r.answer;
    else if (r.kind === 'choice') out = r.picks.join('; ') + (r.why ? '\n\n' + r.why : '');
    else if (r.kind === 'needs_info') out = 'Needs info about you: ' + (r.missing || '') + '\n(Add it under “About me” in the extension options.)';
    else out = 'That does not read as a question.';
    $('a').textContent = out;
    if (r && r.ok && (r.kind === 'free' || r.kind === 'choice')) { const c = $('copy'); c.hidden = false; c.onclick = () => navigator.clipboard.writeText(r.kind === 'free' ? r.answer : r.picks.join('; ')).then(() => { c.textContent = 'Copied'; }); }
  });
});
