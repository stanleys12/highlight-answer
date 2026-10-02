# Highlight Answer

Chrome extension: highlight a question with the mouse →
- answer choices (radio / checkbox / dropdown / listbox) → the right one is selected
- free response with a box → the answer is typed into the box
- question with no box → answer shown with Copy
- a question about *you* that "About me" doesn't cover → says what it needs, fills nothing
- not a question → nothing happens (plain prose never even leaves the page)

Undo button on the chip, or Esc. Toolbar button toggles on/off. Options: model (Haiku/Sonnet/Opus), "About me".

## Setup
1. `./install.sh` — runs the local helper (127.0.0.1:8799) as a launchd agent; uses the Claude Code CLI, no API key.
2. chrome://extensions → Developer mode → Load unpacked → `extension/`.

Log: `/tmp/highlight_answer.log`. Independent of Relay — no shared code, profile, or prompts.
