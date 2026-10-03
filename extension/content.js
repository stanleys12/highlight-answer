// Highlight Answer — highlight a question and let go of the mouse: the answer appears beside it within about half a
// second (a fast model), and a stronger model double-checks it at the same time (✓, or a correction). The page is
// not changed until you press Select / Fill — or hold Option while highlighting to apply it at once. ("Answer
// button" mode in the options waits for a click instead; "Automatic" applies every answer.)
//   not a question               → no button, nothing happens
//   question + answer choices    → the right option is clicked
//   free-response question + box → the answer is typed into the box
//   question with no box         → the answer is shown, with Copy
// A small chip near the highlight says what was done and offers Undo (Esc undoes too).
(() => {
  if (window.__highlightAnswer) return; window.__highlightAnswer = true;
  const MIN = 4, MAX = 8000, SETTLE = 150, INSTANT_SETTLE = 40, HIDE_MS = 8000;
  let timer = null, undo = null, gen = 0, lastMouseUp = 0, instantGen = 0;
  let cfg = { enabled: true, mode: 'instant', model: 'opus', think: true, speculate: true, verify: true, aboutMe: '' };
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
  const isSearch = (el) => el.type === 'search' || /search|combobox/i.test(el.getAttribute('role') || '') || !!el.closest('form[role=search],[role=search]') || /search|query|^q$/i.test([el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder')].join(' '));
  function typedPrep(ty, force) {
    const text = ty.text.replace(/\s+/g, ' ').trim();
    if (text.length < (force ? 1 : MIN) || text.length > MAX) return null;
    // selecting your own words in a box (to delete or retype them) must not pop answers up: outside the Answer-button
    // mode, only a question-shaped selection or anything in a SEARCH field counts
    if (!force && (cfg.mode || 'instant') !== 'button' && !looksAsked(text) && !isSearch(ty.el)) return null;
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
  // ── a request: streamed through a port; can start before the click (speculation) and be picked up by it ──
  function startJob(prep, spec, lane) {
    const job = { id: Math.random().toString(36).slice(2), spec, text: '', final: null, firstAt: 0, doneAt: 0, onUpdate: null };
    const port = chrome.runtime.connect({ name: 'answer' });
    port.onMessage.addListener((m) => {
      if (m.type === 'delta') { job.text += m.text; if (!job.firstAt) job.firstAt = Date.now(); }
      else if (m.type === 'final') { job.final = m; job.doneAt = Date.now(); if (!job.firstAt) job.firstAt = job.doneAt; try { port.disconnect(); } catch {} }
      if (job.onUpdate) job.onUpdate();
    });
    port.onDisconnect.addListener(() => { if (!job.final) { job.final = { ok: false, error: 'connection to the extension was lost' }; job.doneAt = Date.now(); if (job.onUpdate) job.onUpdate(); } });
    port.postMessage({ ...prep.data, id: job.id, spec, lane: lane || 'check', model: cfg.model, think: cfg.think });
    return job;
  }
  let offered = false;
  function offer(prep) {
    offered = true;
    // start answering now: by the time the Answer button is clicked the answer is often already there. Only
    // question-shaped highlights get here; the speculative answer is cached, so nothing is ever asked twice.
    if (cfg.speculate !== false && !prep.job) prep.job = startJob(prep, true);
    show('', [['Answer', () => { offered = false; answer(prep); }]], prep.x, prep.y, false);
    clearTimeout(hideT); hideT = setTimeout(() => { if (offered) { offered = false; hide(); } }, 6000);
  }
  function withdraw() { if (offered) { offered = false; hide(); } }
  function answer(prep) {
    const { choices, target, typed, x, y } = prep;
    const my = ++gen;                                                    // a newer request supersedes this one
    const clickAt = Date.now();
    const job = prep.job || startJob(prep, false);
    const readyBeforeClick = !!job.final;
    let finished = false;
    const render = () => {
      if (my !== gen || finished) return;
      if (!job.final) {
        if (job.text) show('<b>Answer</b><br>' + esc(job.text) + '<span class="dot"></span>', [], x, y, true);
        else show('<span class="dot"></span>Thinking… ' + Math.round((Date.now() - clickAt) / 1000) + 's', [], x, y, true);
        return;
      }
      finished = true; clearInterval(tick); job.onUpdate = null;
      chrome.runtime.sendMessage({ type: 'metric', data: { id: job.id, spec: !!prep.job, readyBeforeClick, model: cfg.model,
        clickToFirstMs: readyBeforeClick ? 0 : Math.max(0, job.firstAt - clickAt), clickToDoneMs: readyBeforeClick ? 0 : job.doneAt - clickAt, kind: job.final.kind || null, ok: !!job.final.ok } });
      done(job.final);
    };
    const tick = setInterval(render, 1000);
    job.onUpdate = render; render();
    function done(r) {
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
  }
  // ── instant: the answer on mouse release ──────────────────────────────────────────────────────────
  // Two requests at once: the FAST lane (Haiku, terse, ~0.5 s to the first answer) is what you see first; the CHECK
  // lane (your chosen model, default Opus + thinking) confirms it (✓) or replaces it (corrected). A long-answer box
  // (essay) skips the fast lane — a one-line quick answer is no use there — and streams the check lane instead.
  const nrm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
  function agrees(f, c) {
    if (!f || !c || !f.ok || !c.ok || f.kind !== c.kind) return false;
    if (f.kind === 'choice') return [...f.picks].sort().join('|') === [...c.picks].sort().join('|');
    if (f.kind !== 'free') return true;
    const a = nrm(f.answer), b = nrm(c.answer), nums = a.match(/\d+(\.\d+)?/g) || [];
    return b.includes(a) || a.includes(b) || (nums.length > 0 && nums.every((n) => b.includes(n)));
  }
  function instant(prep, applyNow) {
    const { choices, target, typed, x, y } = prep;
    const my = ++gen, at = Date.now(); instantGen = my;
    const essay = target && (target.tagName === 'TEXTAREA' || target.isContentEditable || target.getAttribute('role') === 'textbox' || target.maxLength > 300);
    const fast = essay ? null : startJob(prep, false, 'fast');
    const check = cfg.verify !== false || essay ? startJob(prep, true, 'check') : null;
    let applied = null, reported = false, firstShown = 0;
    const best = () => {                              // what to act on: the check lane once it has answered, else the fast one
      const c = check && check.final, f = fast && fast.final;
      if (c && c.ok && c.kind !== 'none') return c;
      if (f && f.ok && f.kind !== 'none' && (!check || !c || !c.ok)) return f;
      return null;
    };
    const apply = (r) => {
      if (!r || (applied && applied === r)) return;
      if (undo && applied) { try { undo(); } catch {} undo = null; }
      if (r.kind === 'choice') undo = choose(choices, r.picks);
      else if (r.kind === 'free' && target) undo = setValue(target, r.answer);
      applied = r;
    };
    const textOf = (r) => (r.kind === 'choice' ? r.picks.join('; ') : r.answer);
    const render = () => {
      if (my !== gen) return;
      const f = fast && fast.final, c = check && check.final;
      const lead = fast || check;                     // what is shown first
      const leadText = lead.final ? (lead.final.ok && lead.final.kind !== 'none' ? textOf(lead.final) : '') : lead.text;
      // not a question (fast lane says so and the check lane agrees, or has not said otherwise): stay out of the way
      const fastNone = f && (f.kind === 'none' || !f.ok);
      if ((fastNone && (!check || !c || c.kind === 'none' || !c.ok)) || (!fast && c && (c.kind === 'none' || !c.ok))) {
        if (fastNone && check && !c) return;          // the check lane may still find a question
        hide(); return finish();
      }
      if (!leadText && !c) { if (Date.now() - at > 600) show('<span class="dot"></span>', [], x, y, true); return; }
      if (!firstShown) firstShown = Date.now();
      let html, status = '';
      const r = best();
      if (c && c.ok && c.kind !== 'none') {
        if (!fast || !f) html = '<b>' + esc(textOf(c)) + '</b>';
        else if (agrees(f, c)) { html = '<b>' + esc(textOf(f)) + '</b>'; status = '✓ double-checked' + (c.kind === 'free' && nrm(c.answer) !== nrm(f.answer) ? '<br>' + esc(c.answer) : ''); }
        else { html = '<b>' + esc(textOf(c)) + '</b>'; status = '⚠ corrected — the quick answer said “' + esc(textOf(f)) + '”'; }
        if (c.kind === 'choice' && c.why) status += (status ? '<br>' : '') + esc(c.why);
      } else if (c && c.kind === 'needs_info') {
        html = '<b>Needs info about you</b><br>' + esc(c.missing || ''); status = 'Add it under “About me” in the extension options.';
      } else {
        html = '<b>' + esc(leadText) + '</b>' + (lead.final ? '' : '<span class="dot"></span>');
        if (check && !c) status = '<span class="dot"></span>double-checking…'; else if (check && c && !c.ok) status = 'could not double-check: ' + esc(c.error || '');
      }
      if (applyNow) apply(r);
      const acts = [];
      if (r && !applyNow) {
        if (r.kind === 'choice' && choices.length) acts.push(['Select', () => { applyNow = true; apply(best()); render(); }]);
        else if (r.kind === 'free' && target) acts.push(['Fill', () => { applyNow = true; apply(best()); render(); }]);
      }
      if (applied) acts.push(['Undo', () => { doUndo(); applyNow = false; applied = null; }]);
      if (r && r.kind === 'free') acts.push(['Copy', () => navigator.clipboard.writeText(r.answer)]);
      if (r && r.kind === 'free' && typed && typed.field && !target) acts.push(['Replace', () => { undo = replaceTyped(typed, r.answer); applied = r; render(); }]);
      acts.push(['×', () => { hide(); gen++; }]);
      show(html + (status ? '<br><small>' + status + '</small>' : ''), acts, x, y, true);
      if ((!fast || f) && (!check || c)) finish();
    };
    function finish() {
      if (reported) return; reported = true; clearInterval(tick);
      const f = fast && fast.final, c = check && check.final;
      chrome.runtime.sendMessage({ type: 'metric', data: { id: (fast || check).id, checkId: check && check.id, trigger: applyNow ? 'release+apply' : 'release', model: cfg.model, readyBeforeClick: false,
        clickToFirstMs: firstShown ? firstShown - at : null, clickToDoneMs: (fast || check).doneAt ? (fast || check).doneAt - at : null,
        checkedMs: check && check.doneAt ? check.doneAt - at : null, agreed: f && c ? agrees(f, c) : null, kind: (c || f || {}).kind || null, ok: !!(c || f || {}).ok } });
    }
    const tick = setInterval(render, 250);
    if (fast) fast.onUpdate = render;
    if (check) check.onUpdate = render;
  }

  document.addEventListener('mouseup', (e) => {
    if (e.composedPath().includes(host) || !cfg.enabled) return;
    const alt = e.altKey; clearTimeout(timer); lastMouseUp = Date.now();
    const mode = cfg.mode || 'instant';
    timer = setTimeout(() => {
      const prep = prepare(); if (!prep) return;
      if (mode === 'instant') instant(prep, alt);
      else if (alt || mode === 'auto') answer(prep); else offer(prep);
    }, mode === 'instant' ? INSTANT_SETTLE : SETTLE);
  }, true);
  const dismiss = () => { if (instantGen && instantGen === gen) gen++; };   // an instant chip stops re-drawing once dismissed
  // a click anywhere else closes the chip (and with it the chance to Undo — Undo lives on the chip and on Esc while it shows)
  document.addEventListener('mousedown', (e) => { if (!e.composedPath().includes(host)) { clearTimeout(timer); withdraw(); dismiss(); hide(); undo = null; } }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (undo) doUndo(); else { offered = false; dismiss(); hide(); } return; }
    withdraw();                                                          // ⌘C or any typing: the button gets out of the way
  }, true);
  // keyboard selection inside a box (⌘A, ⇧+arrows): the box fires "select"
  document.addEventListener('select', (e) => {
    if (!cfg.enabled || e.composedPath().includes(host) || Date.now() - lastMouseUp < 1000) return;   // a mouse selection: the mouseup handler has it (with Option)
    clearTimeout(timer);
    timer = setTimeout(() => { const ty = typedSelection(); const prep = ty && typedPrep(ty, false); if (!prep) return; if ((cfg.mode || 'instant') === 'instant') instant(prep, false); else if (cfg.mode === 'auto') answer(prep); else offer(prep); }, (cfg.mode || 'instant') === 'instant' ? INSTANT_SETTLE : SETTLE);
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
    prep.data.force = true; withdraw(); if ((cfg.mode || 'instant') === 'instant') instant(prep, true); else answer(prep); reply({ ok: true }); return false;   // a right-click is an explicit ask: apply, like Option
  });
})();
