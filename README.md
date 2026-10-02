# Highlight Answer

Chrome extension: highlight a question with the mouse →
- answer choices (radio / checkbox / dropdown / listbox) → the right one is selected
- free response with a box → the answer is typed into the box
- question with no box → answer shown with Copy
- a question about *you* that "About me" doesn't cover → says what it needs, fills nothing
- not a question → nothing happens (plain prose never even leaves the page)

A plain highlight never changes the page or sends anything; the button disappears on any click, key (⌘C included), scroll or window switch, so copy-paste is untouched.

**Typed questions:** type a question into any search bar / text field / editor and highlight it → Answer button → the answer is shown (Copy, or Replace to put it in place of your text, with Undo). Your typed text is never overwritten unless you press Replace.

**Chrome's address bar:** pages can't see it, so type `ask`, space, your question, ⏎ → answer window.

**Backup: right-click a selection → "Answer with Highlight Answer".** Always runs (no question filter); on a page whose script isn't there yet it injects it; on pages Chrome keeps extensions out of (PDF viewer, chrome:// pages) a small window shows the answer with Copy.

Undo button on the chip, or Esc. Toolbar button toggles on/off. Options: button vs automatic mode, model (default Opus), thinking (default on), "About me".

Default Opus + thinking: 10/10 on a hard benchmark (Bertrand-style probability, code tracing, C undefined behaviour, digit sums), ~$0.016/question typical, ~$0.05 and ~20s on the hardest. The helper replaces Claude Code's agent system prompt (with it, Opus tried to "run Python" instead of answering).

## Setup
1. `./install.sh` — runs the local helper (127.0.0.1:8799) as a launchd agent; uses the Claude Code CLI, no API key.
2. chrome://extensions → Developer mode → Load unpacked → `extension/`.

Log: `/tmp/highlight_answer.log`. Independent of Relay — no shared code, profile, or prompts.
