#!/bin/zsh
# Installs the Highlight Answer helper as a launchd agent (starts at login, restarts if it dies).
# Uninstall: launchctl bootout gui/$(id -u)/com.stanley.highlightanswer; rm ~/Library/LaunchAgents/com.stanley.highlightanswer.plist
set -e
DIR="${0:A:h}"
NODE="$(print -l ~/.nvm/versions/node/*/bin/node(N) | sort -V | tail -1)"
[[ -x "$NODE" ]] || NODE="$(command -v node || true)"
[[ -x "$NODE" ]] || { echo "node not found: install Node.js (or nvm), then run ./install.sh again" >&2; exit 1; }
LABEL=com.stanley.highlightanswer
PLIST=~/Library/LaunchAgents/$LABEL.plist
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/server/server.js</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/highlight_answer.log</string>
  <key>StandardErrorPath</key><string>/tmp/highlight_answer.log</string>
</dict></plist>
EOF
launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST"
sleep 1; curl -s http://127.0.0.1:8799/health && echo "  helper running"
