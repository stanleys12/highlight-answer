// The answer window: the address bar's "ask …" and the right-click fallback on pages extensions can't enter (PDFs,
// chrome:// pages). Same two lanes as on a page: the quick answer (Haiku, ~½ s) first, then the double-check from
// the chosen model (✓, or a correction with its explanation). The answer can't be put into such a page: Copy.
const P = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
$('q').textContent = P.get('text') || '';
const t0 = Date.now();
const nrm = (v) => String(v || '').toLowerCase().replace(/[^\p{L}\p{N}.]+/gu, ' ').trim();
const textOf = (r) => (r.kind === 'choice' ? r.picks.join('; ') + (r.why ? '\n\n' + r.why : '') : r.kind === 'free' ? r.answer
  : r.kind === 'needs_info' ? 'Needs info about you: ' + (r.missing || '') + '\n(Add it under “About me” in the extension options.)' : 'That does not read as a question.');
let fast = null, check = null, fastOnly = false;
chrome.storage.sync.get({ preset: 'balanced' }, (v) => { fastOnly = v.preset === 'fast'; });
function render() {
  const s = Math.round((Date.now() - t0) / 1000);
  let main, note = '';
  if (check && check.ok) {
    main = textOf(check);
    if (fast && fast.ok && fast.kind === 'free' && check.kind === 'free') {
      const a = nrm(fast.answer), b = nrm(check.answer), nums = a.match(/\d+(\.\d+)?/g) || [];
      note = b.includes(a) || a.includes(b) || (nums.length && nums.every((n) => b.includes(n))) ? '✓ double-checked' : '⚠ corrected — the quick answer said “' + fast.answer + '”';
    }
  } else if (fast && fast.ok && fast.kind !== 'none') { main = textOf(fast); note = check ? 'could not double-check: ' + (check.error || '') : fastOnly ? '' : 'double-checking… ' + s + 's'; }
  else if (check && !check.ok) main = 'Error: ' + (check.error || 'no answer');
  else if (fast && fastOnly) main = fast.ok ? textOf(fast) : 'Error: ' + (fast.error || 'no answer');
  else main = 'Thinking… ' + s + 's';
  $('a').textContent = main; $('n').textContent = note;
  const r = check && check.ok ? check : fast && fast.ok ? fast : null;
  if (r && (r.kind === 'free' || r.kind === 'choice')) { const c = $('copy'); c.hidden = false; c.onclick = () => navigator.clipboard.writeText(r.kind === 'free' ? r.answer : r.picks.join('; ')).then(() => { c.textContent = 'Copied'; }); }
}
const tick = setInterval(render, 500);
chrome.storage.sync.get({ model: 'opus', think: true, aboutMe: '', preset: 'balanced' }, (cfg) => {
  const { preset, ...rest } = cfg;
  const base = { selection: P.get('text') || '', choices: [], target: null, url: P.get('url') || '', title: P.get('title') || '', context: '', ...rest, force: true, typed: P.get('typed') === '1' };
  // the speed preset, as on a page: fast = quick answer only; accurate = Opus only; balanced = both
  const checkOver = preset === 'accurate' ? { model: 'opus', think: true, effort: 'high' } : {};
  if (preset !== 'accurate') chrome.runtime.sendMessage({ type: 'answer', data: { ...base, lane: 'fast' } }, (r) => { fast = r || { ok: false }; if (preset === 'fast') clearInterval(tick); render(); });
  if (preset !== 'fast') chrome.runtime.sendMessage({ type: 'answer', data: { ...base, ...checkOver, lane: 'check' } }, (r) => { check = r || { ok: false }; clearInterval(tick); render(); });
});
