// Highlight Answer — local helper. The extension sends what was highlighted (plus any answer choices and the
// box it belongs to); one Claude call decides whether it is a question and answers it. Listens on 127.0.0.1
// only, and only answers requests carrying the extension's header (a web page cannot add a custom header to a
// cross-site request without a preflight this server never approves).
//
// Uses the Claude Code CLI (your subscription, no API key), stripped to a bare single-shot text call: no MCP
// servers, no tools, an empty working directory so no CLAUDE.md is read.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8799;
const HEADER = 'x-highlight-answer';
const MODELS = new Set(['haiku', 'sonnet', 'opus']);

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
  + 'Your entire reply is one JSON object in the format the user message specifies — no prose, no markdown.';
// Thinking: effort "high" lets the model reason as long as a hard question needs (an easy one still answers in a
// few seconds); "low" with no thinking budget is the fast path.
function ask(prompt, model, think) {
  return new Promise((resolve, reject) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hla-'));
    const p = spawn(claudeBin(), ['-p', '--model', model, '--max-turns', '3', '--output-format', 'json',
      '--system-prompt', SYSTEM, '--effort', think ? 'high' : 'low',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--dangerously-skip-permissions'],
      { cwd, env: think ? process.env : { ...process.env, MAX_THINKING_TOKENS: '0' } });
    let out = '', err = '';
    const kill = setTimeout(() => p.kill('SIGKILL'), 240000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', () => {
      clearTimeout(kill); fs.rm(cwd, { recursive: true, force: true }, () => {});
      try { const d = JSON.parse(out); if (d.is_error) return reject(new Error(d.result || d.subtype || 'model error')); resolve({ text: String(d.result || ''), cost: d.total_cost_usd || 0 }); }
      catch { reject(new Error('no answer from claude: ' + (err || out).slice(0, 160))); }
    });
    p.stdin.end(prompt);
  });
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

${q.force ? 'The person right-clicked this highlight and explicitly asked for an answer: treat it as a question or prompt (a bare term or statement means "explain this" / "is this true?") unless it plainly cannot be one.\n\n' : ''}HIGHLIGHTED TEXT:
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

async function answer(q) {
  const model = MODELS.has(q.model) ? q.model : 'opus';
  const t0 = Date.now();
  const think = q.think !== false;
  // one retry: a CLI that died (several calls at once) or a reply that was not JSON
  let r, j, spent = 0;
  for (let i = 0; i < 2; i++) {
    try { r = await ask(prompt(q), model, think); spent += r.cost; j = parse(r.text); break; }
    catch (e) { if (i === 1) return { ok: false, error: r && !j ? 'unreadable answer: ' + String(r.text).slice(0, 120) : String(e.message || e).slice(0, 200), cost: spent }; r = null; }
  }
  r.cost = spent;
  const choices = q.choices || [];
  if (j.kind === 'choice') {
    // keep only picks that really are options on the page
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    j.picks = (j.picks || []).map((p) => choices.find((c) => norm(c) === norm(p)) || choices.find((c) => norm(c).includes(norm(p)) || norm(p).includes(norm(c)))).filter(Boolean);
    if (!j.picks.length) j = { kind: 'none', why: 'the answer matched no option' };
  }
  if (j.kind === 'free' && q.target && q.target.maxlength && String(j.answer).length > q.target.maxlength) j.answer = String(j.answer).slice(0, q.target.maxlength);
  return { ok: true, ...j, model, cost: r.cost, ms: Date.now() - t0 };
}

http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/answer') return send(404, { ok: false });
  if (req.headers[HEADER] !== '1') return send(403, { ok: false, error: 'not allowed' });
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 200000) req.destroy(); });
  req.on('end', async () => {
    let q; try { q = JSON.parse(body || '{}'); } catch { return send(400, { ok: false, error: 'bad json' }); }
    try { const r = await answer(q); console.log(new Date().toISOString(), r.kind || 'error', r.model, (r.cost || 0).toFixed(4), r.ms + 'ms', JSON.stringify(String(q.selection || '').slice(0, 60))); send(200, r); }
    catch (e) { send(200, { ok: false, error: String(e.message || e).slice(0, 200) }); }
  });
}).listen(PORT, '127.0.0.1', () => console.log('highlight-answer helper on 127.0.0.1:' + PORT));
