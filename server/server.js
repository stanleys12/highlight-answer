// Highlight Answer — local helper. The extension sends what was highlighted (plus any answer choices and the
// box it belongs to); one Claude call decides whether it is a question and answers it. Listens on 127.0.0.1
// only, and only answers requests carrying the extension's header (a web page cannot add a custom header to a
// cross-site request without a preflight this server never approves).
//
// Uses the Claude Code CLI (your subscription, no API key), stripped to a bare single-shot text call: no MCP
// servers, no tools, an empty working directory so no CLAUDE.md is read.
//
// SPEED (2026-10-02, measured — see metrics.jsonl / GET /stats):
//  - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: the CLI made a side Haiku call on every run; off, an easy question
//    went from ~2.4 s to ~1.4 s (and costs less). Pre-spawning the CLI saved nothing measurable, so it isn't done.
//  - the answer is STREAMED: text deltas are decoded out of the half-written JSON and sent as they arrive.
//  - identical requests share one model call (a speculative start + the click on Answer), and finished answers
//    are cached, so a repeat is instant.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = 8799;
const HEADER = 'x-highlight-answer';
const MODELS = new Set(['haiku', 'sonnet', 'opus']);
const METRICS = path.join(__dirname, '..', 'metrics.jsonl');

function claudeBin() {
  for (const p of [path.join(os.homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) if (fs.existsSync(p)) return p;
  const ext = path.join(os.homedir(), '.vscode/extensions');   // the binary that ships inside the VS Code extension
  const dirs = fs.existsSync(ext) ? fs.readdirSync(ext).filter((d) => /^anthropic\.claude-code-.*-darwin-arm64$/.test(d)).sort() : [];
  if (!dirs.length) throw new Error('claude binary not found');
  return path.join(ext, dirs[dirs.length - 1], 'resources/native-binary/claude');
}

// Claude Code's own system prompt tells the model it is a coding agent with tools — with the tools removed, Opus
// still "ran Python" for an arithmetic question (as plain text) instead of answering. Replace it outright.
const SYSTEM = 'You answer questions that a person highlighted on a web page. You have no tools: do every calculation, '
  + 'code trace and logical step yourself, in your head, carefully, and double-check it before you commit. '
  + 'Your entire reply is one JSON object in the format the user message specifies — no prose, no markdown. Write the "kind" key first.';

// FAST LANE (2026-10-02): the answer he sees on mouse release. Measured on 34 CS/quiz questions with a terse reply
// format and no thinking: Haiku's first answer token at p50 485 ms (Sonnet ~1000, Opus ~1200), 33/34 right; the
// one miss is caught by the check lane (his chosen model, default Opus + thinking) that runs at the same time.
const FAST_SYSTEM = 'You answer quiz and lookup questions instantly and correctly. Output ONLY the answer: no preamble, no explanation, no working, no markdown.';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function fastPrompt(q) {
  const choices = (q.choices || []).slice(0, 26);
  const ctx = String(q.context || '').slice(0, 1500);
  const head = (ctx ? `Context from the page:\n${ctx}\n\n` : '') + `Question: ${String(q.selection || '').slice(0, 4000)}\n`;
  if (choices.length) return head + `Options:\n${choices.map((o, i) => `${LETTERS[i]}) ${o}`).join('\n')}\nReply with only the letter of the correct option (letters separated by commas only if it asks to select all that apply).${q.typed || q.force ? '' : ' If the text is not a question about these options, reply exactly: -'}`;
  return head + `Reply with only the answer: a word, number, or short phrase; at most one sentence.${q.typed || q.force ? '' : ' If the text is not a question, reply exactly: -'}`;
}
function parseFast(q, text) {
  const t = String(text || '').trim();
  if (!t || t === '-' || /^-\s*$/.test(t)) return { kind: 'none' };
  const choices = q.choices || [];
  if (choices.length) {
    const picks = [...new Set((t.match(/\b[A-Z]\b/g) || []).map((l) => choices[LETTERS.indexOf(l)]).filter(Boolean))];
    return picks.length ? { kind: 'choice', picks } : { kind: 'none', why: 'no option letter in the quick answer' };
  }
  return { kind: 'free', answer: t.replace(/^answer:\s*/i, '') };
}

// One CLI process per question. It is started in stream-json INPUT mode, which waits for its message indefinitely,
// so a SPARE can be started ahead of time for the settings in use: measured, that takes the CLI's own start-up off
// the clock (overhead p50 274 ms → 92 ms). A plain `-p` process cannot wait — it gives up on stdin after ~3 s.
// effort: 'low' = no thinking; 'high' (default) / 'xhigh' / 'max' = thinking, as much as the question needs, up to that level
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
function spawnCli(model, effort, lane) {
  const think = effort !== 'low';
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hla-'));
  const p = spawn(claudeBin(), ['-p', '--model', model, '--max-turns', '3', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--system-prompt', lane === 'fast' ? FAST_SYSTEM : SYSTEM, '--effort', effort,
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--dangerously-skip-permissions'],
    { cwd, env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...(think ? {} : { MAX_THINKING_TOKENS: '0' }) } });
  const cli = { p, cwd, bornAt: Date.now(), dead: false, onLine: null, err: '' };
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (cli.onLine) cli.onLine(l); } });
  p.stderr.on('data', (d) => { cli.err += d; });
  p.on('close', () => { cli.dead = true; fs.rm(cwd, { recursive: true, force: true }, () => {}); if (cli.onClose) cli.onClose(); });
  p.stdin.on('error', () => {});
  return cli;
}
const SPARE = new Map();                              // "model|think" → a started CLI waiting for its question
const SPARE_MAX_AGE = 30 * 60e3;                       // renewed now and then so a stale one (new CLI version, expired login) never answers
function takeCli(model, effort, lane) {
  const k = model + '|' + effort + '|' + (lane || 'check'), s = SPARE.get(k); SPARE.delete(k);
  const warm = s && !s.dead && Date.now() - s.bornAt < SPARE_MAX_AGE;
  if (s && !warm) try { s.p.kill(); } catch {}
  setTimeout(() => { if (!SPARE.has(k)) SPARE.set(k, spawnCli(model, effort, lane)); }, 50);   // the next question's spare
  return { cli: warm ? s : spawnCli(model, effort, lane), warm };
}
function primeSpare(model, effort, lane) { const k = model + '|' + effort + '|' + (lane || 'check'); const s = SPARE.get(k); if (!s || s.dead || Date.now() - s.bornAt >= SPARE_MAX_AGE) { if (s) try { s.p.kill(); } catch {} SPARE.set(k, spawnCli(model, effort, lane)); } }
setInterval(() => { for (const k of [...SPARE.keys()]) { const [m, e, l] = k.split('|'); primeSpare(m, e, l); } }, 60e3).unref();
process.on('exit', () => { for (const s of SPARE.values()) try { s.p.kill(); } catch {} });

// One question, streamed. onText(chunk) gets the reply text as it is written; resolves with the final reply + usage.
// Thinking: effort "high" lets the model reason as long as a hard question needs (an easy one barely thinks).
function ask(prompt, model, effort, onText, lane) {
  return new Promise((resolve, reject) => {
    const { cli, warm } = takeCli(model, effort, lane);
    const t0 = Date.now(); let firstAny = 0, result = null;
    const kill = setTimeout(() => cli.p.kill('SIGKILL'), 240000);
    cli.onLine = (line) => {
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'stream_event' && ev.event && ev.event.type === 'content_block_delta') {
        if (!firstAny) firstAny = Date.now() - t0;                                       // first output of any kind (thinking included)
        if (ev.event.delta && ev.event.delta.type === 'text_delta') onText(ev.event.delta.text);
      } else if (ev.type === 'result') { result = ev; try { cli.p.stdin.end(); } catch {} }
    };
    const finish = () => {
      clearTimeout(kill);
      if (!result) return reject(new Error('no answer from claude: ' + (cli.err || '').slice(0, 160)));
      if (result.is_error) return reject(new Error(result.result || result.subtype || 'model error'));
      const u = result.usage || {};
      resolve({ text: String(result.result || ''), cost: result.total_cost_usd || 0, apiMs: result.duration_api_ms || 0, firstAnyMs: firstAny, warm,
        inTok: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), outTok: u.output_tokens || 0,
        thinkTok: (u.output_tokens_details || {}).thinking_tokens || 0 });
    };
    if (cli.dead) return finish();
    cli.onClose = finish;
    cli.p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
  });
}

// Pull the "answer" string out of JSON that is still being written: {"kind":"free","answer":"Canb…
function answerStreamer(emit) {
  let raw = '', sent = 0;
  return (chunk) => {
    raw += chunk;
    const m = /"answer"\s*:\s*"/.exec(raw); if (!m) return;
    let body = raw.slice(m.index + m[0].length), end = -1;
    for (let i = 0; i < body.length; i++) { if (body[i] === '\\') { i++; continue; } if (body[i] === '"') { end = i; break; } }
    if (end >= 0) body = body.slice(0, end);
    else body = body.replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, '');                          // never cut an escape in half
    let s; try { s = JSON.parse('"' + body + '"'); } catch { return; }
    if (s.length > sent) { emit(s.slice(sent)); sent = s.length; }
  };
}

function prompt(q) {
  const choices = (q.choices || []).slice(0, 40);
  const box = q.target ? `${q.target.kind === 'text' ? 'a single-line text input' : 'a multi-line text box'}${q.target.maxlength ? ` (max ${q.target.maxlength} characters)` : ''}${q.target.label ? `, labelled "${q.target.label}"` : ''}` : 'none';
  return `Someone highlighted text on a web page. Decide whether it is a question (or a prompt that asks for an answer), and if so, answer it.

Reply with ONLY one JSON object, no other text:
- {"kind":"none"} — the highlight is not a question or prompt (ordinary prose, a heading, instructions, an announcement).
- {"kind":"choice","picks":["<exact option text>"],"why":"<one short sentence>"} — answer CHOICES are listed below and the question is about them. Copy option text exactly. Give more than one pick only when the question asks to select all that apply.
- {"kind":"free","answer":"<text>"} — any other question. The answer is exactly what should go in the box: no preamble, no quotes, no "Answer:". Size it to the box: a single-line input gets a word, number, or one sentence; a multi-line box gets a complete answer (usually one short paragraph, longer only if the question clearly wants it); respect a character limit.
- {"kind":"needs_info","missing":"<what you would need>"} — the question is about the person filling the page (their name, history, opinions, experiences) and ABOUT THE PERSON below does not tell you. Never invent personal facts.

Getting it RIGHT matters more than speed. Before answering, work the problem out fully: for math, compute it step by step and check the result; for code, trace it line by line; for a multiple-choice question, test EVERY option against the question (watch for "NOT", "EXCEPT", "always", "best", "most likely" and other qualifiers) and pick the one that is actually correct, not the one that merely sounds familiar. If the question depends on information in the page context (a passage, a table, a code block), use it. For a free response, answer what was actually asked, fully, at the level of a strong expert. Keep all of that reasoning to yourself — the JSON is the only output.

${q.typed ? 'The person typed this themselves into a search bar or text field and highlighted it: it is THEIR question to you. Treat it as a question even when it is a bare phrase ("capital of australia", "python list comprehension" = answer what they are looking up). Answer as kind "free": lead with the direct answer, then only as much explanation as helps — usually 1-4 sentences, more only if the question clearly needs it.\n\n' : ''}${q.force ? 'The person right-clicked this highlight and explicitly asked for an answer: treat it as a question or prompt (a bare term or statement means "explain this" / "is this true?") unless it plainly cannot be one.\n\n' : ''}HIGHLIGHTED TEXT:
${String(q.selection || '').slice(0, 8000)}

CHOICES: ${choices.length ? JSON.stringify(choices) : 'none'}
ANSWER BOX: ${box}

PAGE: ${String(q.title || '').slice(0, 150)} — ${String(q.url || '').slice(0, 200)}
PAGE CONTEXT (text around the highlight):
${String(q.context || '').slice(0, 6000)}

ABOUT THE PERSON (written by them; may be empty):
${String(q.aboutMe || '').slice(0, 3000) || '(nothing)'}`;
}

function parse(text) {
  let t = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  return JSON.parse(a >= 0 && b > a ? t.slice(a, b + 1) : t);
}

// ── jobs: one model call per distinct request; later identical requests join it or read the cache ──────
const CACHE = new Map(), CACHE_MAX = 300, JOBS = new Map();
const keyOf = (q) => crypto.createHash('sha1').update(JSON.stringify([q.lane === 'fast' ? 'fast' : 'check', q.selection, q.choices, q.target, q.model, q.think !== false, q.effort || 'high', q.aboutMe, !!q.typed, !!q.force, String(q.context || '').slice(0, 6000)])).digest('hex');
function record(o) { fs.appendFile(METRICS, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n', () => {}); }

function run(q) {
  const fast = q.lane === 'fast';
  const model = fast ? 'haiku' : MODELS.has(q.model) ? q.model : 'opus';
  const effort = fast || q.think === false ? 'low' : EFFORTS.has(q.effort) ? q.effort : 'high', think = effort !== 'low';
  const job = { events: [], subs: new Set(), done: false };
  const push = (ev) => { job.events.push(ev); for (const s of job.subs) s(ev); if (ev.type === 'final') job.done = true; };
  const t0 = Date.now(); let firstAnswer = 0;
  (async () => {
    let r, j, spent = 0, err;
    for (let i = 0; i < 2; i++) {                    // one retry: a CLI that died, or a reply that was not JSON
      const emit = (t) => { if (!firstAnswer && t.trim()) firstAnswer = Date.now() - t0; if (i === 0 || !job.events.length) push({ type: 'delta', text: t }); };
      // the fast lane streams its plain reply as is (a free answer), except option letters and the "-" for not-a-question
      const stream = fast ? (t) => { if (!(q.choices || []).length) { const so = (job._raw = (job._raw || '') + t); if (so.trim() !== '-' && !/^-?\s*$/.test(so)) emit(job._sent === undefined ? (job._sent = so) : t); } else if (!firstAnswer && t.trim()) firstAnswer = Date.now() - t0; } : answerStreamer(emit);
      try { r = await ask(fast ? fastPrompt(q) : prompt(q), model, effort, stream, fast ? 'fast' : 'check'); spent += r.cost; j = fast ? parseFast(q, r.text) : parse(r.text); break; }
      catch (e) { err = r && !j ? 'unreadable answer: ' + String(r.text).slice(0, 120) : String(e.message || e).slice(0, 200); r = null; }
    }
    let out;
    if (!j) out = { ok: false, error: err, cost: spent };
    else {
      const choices = q.choices || [];
      if (j.kind === 'choice') {                     // keep only picks that really are options on the page
        const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        j.picks = (j.picks || []).map((p) => choices.find((c) => norm(c) === norm(p)) || choices.find((c) => norm(c).includes(norm(p)) || norm(p).includes(norm(c)))).filter(Boolean);
        if (!j.picks.length) j = { kind: 'none', why: 'the answer matched no option' };
      }
      if (j.kind === 'free' && q.target && q.target.maxlength && String(j.answer).length > q.target.maxlength) j.answer = String(j.answer).slice(0, q.target.maxlength);
      out = { ok: true, ...j, model, cost: spent, ms: Date.now() - t0 };
    }
    record({ type: 'server', id: q.id, spec: !!q.spec, lane: fast ? 'fast' : 'check', model, think, effort, kind: out.kind || null, ok: out.ok, error: out.error, cached: false,
      totalMs: Date.now() - t0, firstOutputMs: r ? r.firstAnyMs : null, firstAnswerMs: firstAnswer || null, apiMs: r ? r.apiMs : null,
      cliOverheadMs: r ? Date.now() - t0 - r.apiMs : null, warmCli: r ? r.warm : null, inTok: r && r.inTok, outTok: r && r.outTok, thinkTok: r && r.thinkTok, cost: spent,
      selLen: String(q.selection || '').length, ctxLen: String(q.context || '').length, typed: !!q.typed, force: !!q.force, choices: (q.choices || []).length });
    console.log(new Date().toISOString(), out.kind || 'error', model, spent.toFixed(4), (Date.now() - t0) + 'ms', JSON.stringify(String(q.selection || '').slice(0, 60)));
    push({ type: 'final', ...out });
  })();
  return job;
}

function answer(q, onEvent) {                         // onEvent gets every event (replayed, then live); resolves on final
  const key = keyOf(q);
  const hit = CACHE.get(key);
  if (hit) {
    CACHE.delete(key); CACHE.set(key, hit);         // most recently used
    record({ type: 'server', id: q.id, spec: !!q.spec, model: hit.model, kind: hit.kind, ok: true, cached: true, totalMs: 0, cost: 0 });
    onEvent({ type: 'final', ...hit, cached: true }); return Promise.resolve();
  }
  let job = JOBS.get(key);
  if (job) record({ type: 'server', id: q.id, spec: !!q.spec, joined: true, joinedAfterMs: null });
  else {
    job = run(q); JOBS.set(key, job);
    job.subs.add(function cleanup(ev) {
      if (ev.type !== 'final') return;
      JOBS.delete(key);
      if (ev.ok) { const { type, ...v } = ev; CACHE.set(key, v); if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value); }
    });
  }
  return new Promise((resolve) => {
    const sub = (ev) => { onEvent(ev); if (ev.type === 'final') { job.subs.delete(sub); resolve(); } };
    for (const ev of job.events) sub(ev);
    if (!job.done) job.subs.add(sub);
  });
}

// ── /stats: what the metrics say ───────────────────────────────────────────────────────────────────
function pct(a, p) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }
function stats(days = 7) {
  let rows = [];
  try { rows = fs.readFileSync(METRICS, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  const since = Date.now() - days * 864e5, today = new Date().toISOString().slice(0, 10);
  const recent = rows.filter((r) => Date.parse(r.ts) >= since);
  const calls = recent.filter((r) => r.type === 'server' && !r.cached && !r.joined && r.ok !== undefined);
  const client = recent.filter((r) => r.type === 'client');
  const usedIds = new Set(client.map((c) => c.id));
  const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
  const ms = (a) => ({ p50: pct(a, 0.5), p90: pct(a, 0.9), n: a.length });
  const byModel = {};
  for (const r of calls) {
    const lk = (r.lane === 'fast' ? 'quick: ' : '') + r.model; const b = byModel[lk] || (byModel[lk] = { totalMs: [], firstOutputMs: [], firstAnswerMs: [], cliOverheadMs: [], cost: [], thinkTok: [] });
    b.totalMs.push(r.totalMs); if (r.firstOutputMs) b.firstOutputMs.push(r.firstOutputMs); if (r.firstAnswerMs) b.firstAnswerMs.push(r.firstAnswerMs);
    if (r.cliOverheadMs != null) b.cliOverheadMs.push(r.cliOverheadMs); b.cost.push(r.cost); b.thinkTok.push(r.thinkTok || 0);
  }
  const specCalls = calls.filter((r) => r.spec);
  const served = recent.filter((r) => r.type === 'server' && r.ok !== undefined || r.joined);
  return {
    ok: true, days,
    requests: served.length, modelCalls: calls.length, errors: calls.filter((r) => !r.ok).length,
    cacheHits: recent.filter((r) => r.cached).length, joinedInFlight: recent.filter((r) => r.joined).length,
    // what you actually waited: Answer click (or Option-highlight) → first words / → done
    youWaited: { clickToFirstMs: ms(client.map((c) => c.clickToFirstMs).filter((x) => x != null)), clickToDoneMs: ms(client.map((c) => c.clickToDoneMs).filter((x) => x != null)),
      readyBeforeClick: client.filter((c) => c.readyBeforeClick).length, of: client.length,
      checkedMs: ms(client.map((c) => c.checkedMs).filter((x) => x != null)), agreed: client.filter((c) => c.agreed === true).length, compared: client.filter((c) => c.agreed != null).length },
    model: Object.fromEntries(Object.entries(byModel).map(([m, b]) => [m, { calls: b.totalMs.length, totalMs: ms(b.totalMs), firstOutputMs: ms(b.firstOutputMs), firstAnswerMs: ms(b.firstAnswerMs),
      cliOverheadMs: ms(b.cliOverheadMs), avgCost: +(sum(b.cost) / b.cost.length).toFixed(4), avgThinkTok: Math.round(sum(b.thinkTok) / b.thinkTok.length) }])),
    speculation: { started: specCalls.length, neverUsed: specCalls.filter((r) => !usedIds.has(r.id)).length, wastedCost: +sum(specCalls.filter((r) => !usedIds.has(r.id)).map((r) => r.cost)).toFixed(4) },
    cost: { today: +sum(rows.filter((r) => r.type === 'server' && String(r.ts).startsWith(today)).map((r) => r.cost)).toFixed(4), window: +sum(calls.map((r) => r.cost)).toFixed(4),
      allTime: +sum(rows.filter((r) => r.type === 'server').map((r) => r.cost)).toFixed(4) },
  };
}

http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true });
  if (req.headers[HEADER] !== '1') return send(403, { ok: false, error: 'not allowed' });
  if (req.method === 'GET' && url.pathname === '/stats') return send(200, stats(+url.searchParams.get('days') || 7));
  if (req.method !== 'POST' || !['/answer', '/metric'].includes(url.pathname)) return send(404, { ok: false });
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 200000) req.destroy(); });
  req.on('end', async () => {
    let q; try { q = JSON.parse(body || '{}'); } catch { return send(400, { ok: false, error: 'bad json' }); }
    if (url.pathname === '/metric') { record({ type: 'client', ...q }); return send(200, { ok: true }); }
    if (q.stream) {                                  // NDJSON: {type:'delta',text}… then {type:'final',…}
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
      try { await answer(q, (ev) => res.write(JSON.stringify(ev) + '\n')); } catch (e) { res.write(JSON.stringify({ type: 'final', ok: false, error: String(e.message || e) }) + '\n'); }
      return res.end();
    }
    let fin; try { await answer(q, (ev) => { if (ev.type === 'final') fin = ev; }); } catch (e) { fin = { ok: false, error: String(e.message || e).slice(0, 200) }; }
    const { type, ...rest } = fin || { ok: false, error: 'no answer' }; send(200, rest);
  });
}).listen(PORT, '127.0.0.1', () => { console.log('highlight-answer helper on 127.0.0.1:' + PORT); primeSpare('opus', 'high', 'check'); primeSpare('haiku', 'low', 'fast'); });
