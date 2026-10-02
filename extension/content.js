// Highlight Answer — highlight text with the mouse; when the mouse is released:
//   not a question               → nothing happens
//   question + answer choices    → the right option is clicked
//   free-response question + box → the answer is typed into the box
//   question with no box         → the answer is shown, with Copy
// A small chip near the highlight says what was done and offers Undo (Esc undoes too).
(() => {
  if (window.__highlightAnswer) return; window.__highlightAnswer = true;
  const MIN = 4, MAX = 4000, SETTLE = 350, HIDE_MS = 8000;
  let timer = null, lastKey = '', lastAt = 0, undo = null, gen = 0;
  let cfg = { enabled: true, model: 'sonnet', aboutMe: '' };
  chrome.storage.sync.get(cfg, (v) => { cfg = { ...cfg, ...v }; });
  chrome.storage.onChanged.addListener((ch) => { for (const k in ch) cfg[k] = ch[k].newValue; });

  // ── chip ───────────────────────────────────────────────────────────────────────────────────────
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    .c{position:fixed;z-index:2147483647;max-width:380px;font:12.5px/1.4 -apple-system,system-ui,sans-serif;color:#eceff4;background:#1e222b;border:1px solid #3b4252;border-radius:9px;padding:7px 10px;box-shadow:0 6px 24px rgba(0,0,0,.35);display:none;gap:8px;align-items:flex-start}
    .c.on{display:flex}.c b{color:#88c0d0;font-weight:600}.c small{color:#9aa3b2}.t{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word;max-height:12em;overflow:auto}
    button{all:unset;cursor:pointer;color:#88c0d0;padding:2px 6px;border-radius:5px;font-size:12px}button:hover{background:#2e3440}
    .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#88c0d0;margin-right:4px;animation:p 1s infinite}@keyframes p{50%{opacity:.25}}
  </style><div class="c"><div class="t"></div><div class="a"></div></div>`;
  const chip = root.querySelector('.c'), tEl = root.querySelector('.t'), aEl = root.querySelector('.a');
  let hideT = null;
  function show(html, actions, x, y, sticky) {
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    tEl.innerHTML = html; aEl.innerHTML = '';
    for (const [label, fn] of actions || []) { const b = document.createElement('button'); b.textContent = label; b.onclick = (e) => { e.stopPropagation(); fn(); }; aEl.appendChild(b); }
    chip.classList.add('on');
    chip.style.left = Math.max(8, Math.min(innerWidth - chip.offsetWidth - 8, x)) + 'px';
    chip.style.top = Math.max(8, Math.min(innerHeight - chip.offsetHeight - 8, y)) + 'px';
    clearTimeout(hideT); if (!sticky) hideT = setTimeout(hide, HIDE_MS);
  }
  const hide = () => chip.classList.remove('on');
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  // ── reading the highlight and the controls that belong to it ──────────────────────────────────────
  const vis = (el) => { const r = el.getBoundingClientRect(); return (r.width > 0 || r.height > 0) && getComputedStyle(el).visibility !== 'hidden'; };
  const txt = (el) => (el ? (el.innerText || el.textContent || '') : '').replace(/\s+/g, ' ').trim();
  function labelOf(el) {
    const al = el.getAttribute('aria-label'); if (al) return al.trim();
    const lb = el.getAttribute('aria-labelledby'); if (lb) { const s = lb.split(/\s+/).map((i) => txt(document.getElementById(i))).filter(Boolean).join(' '); if (s) return s; }
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return txt(l); }
    const wrap = el.closest('label'); if (wrap) return txt(wrap);
    if (el.matches('[role=option],[role=radio],[role=checkbox],[role=menuitemradio]')) return txt(el);
    let n = el.nextSibling, s = '';                    // the text right after the control: "<input> Yes"
    while (n && !s && (n.nodeType === 3 || (n.nodeType === 1 && !n.matches('input,select,textarea,button')))) { s = (n.textContent || '').replace(/\s+/g, ' ').trim(); n = n.nextSibling; }
    return s;
  }
  const CHOICE_SEL = 'input[type=radio],input[type=checkbox],[role=radio],[role=checkbox],[role=option],[role=menuitemradio]';
  const BOX_SEL = 'textarea,input[type=text],input[type=search],input[type=url],input[type=email],input[type=tel],input[type=number],input:not([type]),[contenteditable=""],[contenteditable=true],[role=textbox]';
  const elOf = (node) => node && (node.nodeType === 1 ? node : node.parentElement);
  function collect(range) {
    const sel = range.toString();
    let scope = elOf(range.commonAncestorContainer) || document.body;
    // climb to the block around the highlight, but only while that block is still ABOUT the highlight — never
    // up to a whole form, or a highlighted sentence would borrow the next question's box
    const cap = sel.length * 4 + 300;
    for (let i = 0; i < 5 && scope.parentElement && scope.parentElement !== document.body && !scope.querySelector(CHOICE_SEL + ',' + BOX_SEL + ',select') && txt(scope.parentElement).length <= cap; i++) scope = scope.parentElement;
    const choices = [], low = sel.toLowerCase();
    for (const el of scope.querySelectorAll(CHOICE_SEL)) {
      if (!vis(el)) continue;
      const lab = labelOf(el); if (!lab) continue;
      if (range.intersectsNode(el) || (lab.length >= 2 && low.includes(lab.toLowerCase()))) choices.push({ el, label: lab });
    }
    for (const s of scope.querySelectorAll('select')) if (vis(s) && (range.intersectsNode(s) || [...(s.labels || [])].some((l) => range.intersectsNode(l))))
      for (const o of s.options) if (o.value !== '' && txt(o)) choices.push({ el: o, select: s, label: txt(o) });
    const boxes = [...scope.querySelectorAll(BOX_SEL)].filter((el) => vis(el) && !el.disabled && !el.readOnly && el.type !== 'password');
    // a control just after the highlight belongs to it only if almost nothing is written in between
    // (a helper line like "Optional" is fine; another question's text is not)
    const follows = (el) => (range.endContainer.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && Math.abs(el.getBoundingClientRect().top - range.getBoundingClientRect().bottom) < 320;
    const between = (el) => { try { const r = document.createRange(); r.setStart(range.endContainer, range.endOffset); r.setEndBefore(el); return r.toString().replace(/\s+/g, ' ').trim().length; } catch { return 1e9; } };
    let target = boxes.find((b) => range.intersectsNode(b)) || boxes.find((b) => follows(b) && between(b) <= 24);
    if (!choices.length && !target) {                  // options right under a highlighted question, not themselves highlighted
      const near = [...scope.querySelectorAll(CHOICE_SEL)].filter((el) => vis(el) && follows(el));
      if (near[0] && between(near[0]) <= 24) {
        const grp = near[0].name ? near.filter((e) => e.name === near[0].name) : near.slice(0, 12);
        for (const el of grp) { const lab = labelOf(el); if (lab) choices.push({ el, label: lab }); }
      }
    }
    const seen = new Set();
    return { choices: choices.filter((c) => { const k = c.label.toLowerCase(); return !seen.has(k) && seen.add(k); }), target, scope };
  }
  const kindOf = (el) => (!el ? null : el.tagName === 'TEXTAREA' ? 'textarea' : el.isContentEditable || el.getAttribute('role') === 'textbox' ? 'multiline' : 'text');
  // is it worth asking at all? (no choices and no box → only an obvious question goes to the model)
  const QWORD = /^\s*(please\s+)?(describe|explain|tell (us|me)|list|provide|summari[sz]e|write|give|calculate|compute|solve|find|define|compare|identify|what|why|how|when|where|which|who|whom|whose|do|does|did|is|are|was|were|will|would|can|could|should|has|have)\b/i;
  const looksAsked = (t) => /\?/.test(t) || QWORD.test(t);
  function contextOf(scope) {                          // the text around the highlight, for the model to read the question in
    let el = scope; while (el.parentElement && el.parentElement !== document.body && txt(el).length < 1200) el = el.parentElement;
    return txt(el).slice(0, 2500);
  }

  // ── applying the answer ─────────────────────────────────────────────────────────────────────────
  function setValue(el, v) {
    el.focus();
    if (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT') {          // contenteditable / role=textbox
      const before = el.innerText;
      const selectAll = () => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); };
      selectAll(); if (!document.execCommand('insertText', false, v)) el.textContent = v;
      return () => { el.focus(); selectAll(); if (!document.execCommand('insertText', false, before)) el.textContent = before; };
    }
    const before = el.value;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;   // setter React notices
    const set = (x) => { Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, x); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    set(v); return () => set(before);
  }
  function choose(choices, picks) {
    const undos = [];
    for (const p of picks) {
      const c = choices.find((x) => x.label === p); if (!c) continue;
      if (c.select) { const s = c.select, before = s.value; s.value = c.el.value; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); undos.push(() => { s.value = before; s.dispatchEvent(new Event('change', { bubbles: true })); }); continue; }
      const el = c.el, on = () => el.checked === true || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true', was = on();
      if (!was) { el.click(); if (el.matches('input') && !el.checked) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); } }
      undos.push(() => { if (el.matches('input[type=radio]')) { el.checked = was; el.dispatchEvent(new Event('change', { bubbles: true })); } else if (!was && on()) el.click(); });
    }
    return undos.length ? () => undos.forEach((u) => u()) : null;
  }
  function doUndo() { if (!undo) return; try { undo(); } catch {} undo = null; show('Undone.', [], parseFloat(chip.style.left), parseFloat(chip.style.top)); }

  // ── mouse released on a highlight → ask → act ───────────────────────────────────────────────────
  async function run() {
    if (!cfg.enabled) return;
    const s = getSelection(); if (!s || s.isCollapsed || !s.rangeCount) return;
    const range = s.getRangeAt(0), text = range.toString().replace(/\s+/g, ' ').trim();
    if (text.length < MIN || text.length > MAX) return;
    const a = elOf(range.commonAncestorContainer); if (!a || a.closest('input,textarea,[contenteditable=""],[contenteditable=true]')) return;   // selecting inside a box you are typing in
    const key = location.href + '|' + text; if (key === lastKey && Date.now() - lastAt < 15000) return; lastKey = key; lastAt = Date.now();
    const { choices, target, scope } = collect(range);
    if (!choices.length && !target && !looksAsked(text)) return;        // plain prose: nothing happens, nothing is sent
    const my = ++gen;                                                    // a newer highlight supersedes this one
    const rb = range.getBoundingClientRect(), x = rb.right + 8, y = rb.bottom + 6;
    show('<span class="dot"></span>Reading…', [], x, y, true);
    const data = { selection: text, choices: choices.map((c) => c.label),
                   target: target ? { kind: kindOf(target), label: labelOf(target), maxlength: target.maxLength > 0 ? target.maxLength : 0 } : null,
                   url: location.href, title: document.title, context: contextOf(scope), model: cfg.model, aboutMe: cfg.aboutMe };
    let r; try { r = await chrome.runtime.sendMessage({ type: 'answer', data }); } catch (e) { r = { ok: false, error: String(e.message || e) }; }
    if (my !== gen) return;
    if (!r || !r.ok) return show('<b>Highlight Answer</b> ' + esc((r && r.error) || 'no answer'), [], x, y);
    if (r.kind === 'none') return hide();
    if (r.kind === 'needs_info') return show('<b>Needs info about you</b><br>' + esc(r.missing || '') + '<br><small>Add it under “About me” in the extension options.</small>', [], x, y);
    if (r.kind === 'choice') {
      undo = choose(choices, r.picks);
      return show('<b>Chose</b> ' + esc(r.picks.join('; ')) + (r.why ? '<br><small>' + esc(r.why) + '</small>' : ''), undo ? [['Undo', doUndo]] : [], x, y);
    }
    if (r.kind === 'free' && target) {
      undo = setValue(target, r.answer);
      return show('<b>Filled</b><br>' + esc(r.answer).slice(0, 700), [['Undo', doUndo]], x, y);
    }
    if (r.kind === 'free') return show('<b>Answer</b><br>' + esc(r.answer), [['Copy', () => navigator.clipboard.writeText(r.answer)], ['×', hide]], x, y, true);
    hide();
  }
  document.addEventListener('mouseup', (e) => { if (e.composedPath().includes(host)) return; clearTimeout(timer); timer = setTimeout(run, SETTLE); }, true);
  document.addEventListener('mousedown', (e) => { if (!e.composedPath().includes(host)) hide(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (undo) doUndo(); else hide(); } }, true);
})();
