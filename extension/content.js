// Highlight Answer — highlight a question, then click the small "Answer" button beside it (or hold Option while
// highlighting to answer at once; "Automatic" in the options answers every question-looking highlight):
//   not a question               → no button, nothing happens
//   question + answer choices    → the right option is clicked
//   free-response question + box → the answer is typed into the box
//   question with no box         → the answer is shown, with Copy
// A small chip near the highlight says what was done and offers Undo (Esc undoes too).
(() => {
  if (window.__highlightAnswer) return; window.__highlightAnswer = true;
  const MIN = 4, MAX = 8000, SETTLE = 350, HIDE_MS = 8000;
  let timer = null, undo = null, gen = 0, lastMouseUp = 0;
  let cfg = { enabled: true, mode: 'button', model: 'opus', think: true, aboutMe: '' };
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
    let el = scope; while (el.parentElement && el.parentElement !== document.body && txt(el).length < 3000) el = el.parentElement;
    return txt(el).slice(0, 6000);
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

  // ── highlight → (Answer button | Option-held / automatic) → ask → act ─────────────────────────
  // A plain highlight never changes the page and sends nothing: at most a small "Answer" button appears beside it,
  // and it goes away on the next click, key (⌘C included), scroll, or window switch. Copying is untouched.
  // force (the right-click menu): no "does it look like a question" filter — he asked for it explicitly. When the
  // page selection cannot be read (text inside a box, a canvas-drawn page), Chrome's own copy of it is used alone.
  // Text he TYPED and then highlighted inside a search bar / text field / editor. The page selection never shows text
  // inside a box, so it is read from the box itself. Typed-and-highlighted is deliberate, so any such text gets the
  // Answer button (automatic mode still wants it to look like a question).
  function deepActive() { let el = document.activeElement; while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; return el; }
  const TEXTISH = /^(text|search|url|email|tel|)$/i;
  function typedSelection() {
    const el = deepActive(); if (!el || host.contains(el)) return null;
    if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TEXTISH.test(el.getAttribute('type') || ''))) {
      let s, e; try { s = el.selectionStart; e = el.selectionEnd; } catch { return null; }
      if (s == null || e <= s) return null;
      return { el, text: el.value.slice(s, e), start: s, end: e, field: true };
    }
    const sel = getSelection();
    if (el.isContentEditable && sel && !sel.isCollapsed && sel.rangeCount && el.contains(sel.anchorNode)) return { el, text: sel.toString(), range: sel.getRangeAt(0) };
    return null;
  }
  function typedPrep(ty, force) {
    const text = ty.text.replace(/\s+/g, ' ').trim();
    if (text.length < (force ? 1 : MIN) || text.length > MAX) return null;
    if (!force && cfg.mode === 'auto' && !looksAsked(text)) return null;
    const rb = (ty.range || ty.el).getBoundingClientRect();
    const where = [ty.el.getAttribute('aria-label'), ty.el.getAttribute('placeholder'), ty.el.getAttribute('name'), ty.el.getAttribute('role')].filter(Boolean).join(' / ');
    return { typed: ty, choices: [], target: null, x: rb.left, y: rb.bottom + 6,
      data: { selection: text, typed: true, choices: [], target: null, url: location.href, title: document.title,
              context: 'Typed into a text field' + (where ? ' (' + where + ')' : '') + ' on this page.', model: cfg.model, think: cfg.think, aboutMe: cfg.aboutMe } };
  }
  function replaceTyped(ty, v) {                       // put the answer in place of the highlighted text; Undo restores it
    const el = ty.el, before = el.value;
    el.focus(); el.setSelectionRange(ty.start, ty.end);
    if (!document.execCommand('insertText', false, v)) { el.setRangeText(v, ty.start, ty.end, 'end'); el.dispatchEvent(new Event('input', { bubbles: true })); }
    return () => { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, before); el.dispatchEvent(new Event('input', { bubbles: true })); };
  }
  function prepare(force, fallback) {
    const ty = typedSelection(); if (ty) return typedPrep(ty, force);
    const s = getSelection();
    const live = s && !s.isCollapsed && s.rangeCount ? s.getRangeAt(0) : null;
    const liveText = live ? live.toString().replace(/\s+/g, ' ').trim() : '';
    if (!live || !liveText) return force && fallback ? bare(fallback) : null;
    const range = live, text = liveText;
    if (text.length < (force ? 1 : MIN) || text.length > MAX) return null;
    const a = elOf(range.commonAncestorContainer);
    if (!a || a.closest('input,textarea,[contenteditable=""],[contenteditable=true]')) return force ? bare(text) : null;   // selecting inside a box you are typing in
    const { choices, target, scope } = collect(range);
    if (!force && !choices.length && !target && !looksAsked(text)) return null;   // plain prose: no button, nothing sent
    const rb = range.getBoundingClientRect();
    return { choices, target, x: rb.right + 8, y: rb.bottom + 6,
      data: { selection: text, choices: choices.map((c) => c.label),
              target: target ? { kind: kindOf(target), label: labelOf(target), maxlength: target.maxLength > 0 ? target.maxLength : 0 } : null,
              url: location.href, title: document.title, context: contextOf(scope), model: cfg.model, think: cfg.think, aboutMe: cfg.aboutMe } };
  }
  let offered = false;
  function offer(prep) {
    offered = true;
    show('', [['Answer', () => { offered = false; answer(prep); }]], prep.x, prep.y, false);
    clearTimeout(hideT); hideT = setTimeout(() => { if (offered) { offered = false; hide(); } }, 6000);
  }
  function withdraw() { if (offered) { offered = false; hide(); } }
  async function answer({ choices, target, typed, x, y, data }) {
    const my = ++gen;                                                    // a newer request supersedes this one
    const t0 = Date.now();
    const tick = setInterval(() => { if (my === gen) show('<span class="dot"></span>Thinking… ' + Math.round((Date.now() - t0) / 1000) + 's', [], x, y, true); }, 1000);
    show('<span class="dot"></span>Thinking…', [], x, y, true);
    let r; try { r = await chrome.runtime.sendMessage({ type: 'answer', data: { ...data, model: cfg.model, think: cfg.think } }); } catch (e) { r = { ok: false, error: String(e.message || e) }; }
    clearInterval(tick);
    if (my !== gen) return;
    if (!r || !r.ok) return show('<b>Highlight Answer</b> ' + esc((r && r.error) || 'no answer'), [], x, y);
    if (r.kind === 'none') return show('Not a question — nothing to do.', [], x, y);
    if (r.kind === 'needs_info') return show('<b>Needs info about you</b><br>' + esc(r.missing || '') + '<br><small>Add it under “About me” in the extension options.</small>', [], x, y);
    if (r.kind === 'choice') {
      undo = choose(choices, r.picks);
      return show('<b>Chose</b> ' + esc(r.picks.join('; ')) + (r.why ? '<br><small>' + esc(r.why) + '</small>' : ''), undo ? [['Undo', doUndo]] : [], x, y);
    }
    if (r.kind === 'free' && target) {
      undo = setValue(target, r.answer);
      return show('<b>Filled</b><br>' + esc(r.answer).slice(0, 700), [['Undo', doUndo]], x, y);
    }
    // a question he typed into a box: the answer is shown, never typed over his text unless he asks (Replace)
    const acts = [['Copy', () => navigator.clipboard.writeText(r.answer)]];
    if (r.kind === 'free' && typed && typed.field) acts.push(['Replace', () => { undo = replaceTyped(typed, r.answer); show('<b>Replaced</b><br>' + esc(r.answer).slice(0, 700), [['Undo', doUndo]], x, y); }]);
    if (r.kind === 'free') return show('<b>Answer</b><br>' + esc(r.answer), [...acts, ['×', hide]], x, y, true);
    hide();
  }
  document.addEventListener('mouseup', (e) => {
    if (e.composedPath().includes(host) || !cfg.enabled) return;
    const alt = e.altKey; clearTimeout(timer); lastMouseUp = Date.now();
    timer = setTimeout(() => {
      const prep = prepare(); if (!prep) return;
      if (alt || cfg.mode === 'auto') answer(prep); else offer(prep);
    }, SETTLE);
  }, true);
  document.addEventListener('mousedown', (e) => { if (!e.composedPath().includes(host)) { clearTimeout(timer); withdraw(); if (!undo) hide(); } }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (undo) doUndo(); else { offered = false; hide(); } return; }
    withdraw();                                                          // ⌘C or any typing: the button gets out of the way
  }, true);
  // keyboard selection inside a box (⌘A, ⇧+arrows): the box fires "select"
  document.addEventListener('select', (e) => {
    if (!cfg.enabled || e.composedPath().includes(host) || Date.now() - lastMouseUp < 1000) return;   // a mouse selection: the mouseup handler has it (with Option)
    clearTimeout(timer);
    timer = setTimeout(() => { const ty = typedSelection(); const prep = ty && typedPrep(ty, false); if (!prep) return; if (cfg.mode === 'auto') answer(prep); else offer(prep); }, SETTLE);
  }, true);
  addEventListener('scroll', withdraw, true);
  addEventListener('blur', withdraw);
  function bare(text) {                                // just the text: no controls to act on, the answer is shown
    return { choices: [], target: null, x: innerWidth / 2 - 190, y: 24,
      data: { selection: String(text).slice(0, MAX), choices: [], target: null, url: location.href, title: document.title,
              context: txt(document.body).slice(0, 6000), model: cfg.model, think: cfg.think, aboutMe: cfg.aboutMe } };
  }
  // right-click → "Answer with Highlight Answer"
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.type !== 'force') return false;
    const prep = prepare(true, msg.text);
    if (!prep) { reply({ ok: false }); return false; }
    prep.data.force = true; withdraw(); answer(prep); reply({ ok: true }); return false;
  });
})();
