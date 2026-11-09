#!/bin/bash
# e2e.sh — misst den Server so, wie Claude Desktop ihn nutzt: als stdio-Prozess ueber --mcp-config.
#
# Drei Faelle:
#   1. read   Positivfall           financial_summary liefert den Gewinn
#   2. read   Negativkontrolle      commit_contact ist im Modus read gar nicht registriert
#   3. draft  Vorschau ohne commit  prepare_contact gibt Zusammenfassung und Token
#
# Lauf: CASHCTRL_LIVE_SUBDOMAIN=… CASHCTRL_LIVE_API_KEY=… bash scripts/e2e.sh   (von ueberall, das Skript wechselt selbst;
#       statt des Schluessels geht CASHCTRL_LIVE_KEYCHAIN mit dem Dienstnamen in der macOS-Keychain, Account api)
#
# Der Schluessel kommt aus der Umgebung und steht nur in den temporaeren Konfigurationsdateien
# unter $TMP (umask 077); der trap loescht sie in jedem Ausgang. Nie im Log, nie in der Ausgabe.
#
# Werkzeug-Freigabe: eine eigene Settings-Datei je Lauf,
# uebergeben mit --settings, dazu --strict-mcp-config --mcp-config. `--allowedTools` beschraenkt
# NICHT (am 19.08.2026 gemessen), nur eine deny-Liste in einer Settings-Datei sperrt wirklich.
# Zwei Gates, mit Absicht verschieden:
#   gate-read    nur die deny-Liste — der Modus-Riegel des Servers muss den Negativfall selbst
#                tragen. Ein zusaetzliches deny auf commit_contact wuerde ihn verdecken.
#   gate-draft   zusaetzlich deny auf mcp__cashctrl__commit_contact: der Vorschaufall darf auch
#                dann nichts anlegen, wenn das Modell die Anweisung ignoriert.
# args in der MCP-Konfiguration absolut — relative Pfade enden in CONNECTION_CLOSED ohne Grund
# (gemessene Falle). Sonde bei Startproblemen:
#   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"sonde","version":"0"}}}' | node dist/index.js
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

command -v claude >/dev/null || { echo "claude nicht im PATH"; exit 1; }
command -v python3 >/dev/null || { echo "python3 nicht im PATH (die Zusicherungen brauchen es)"; exit 1; }
NODE="$(command -v node)"

# Datei UND CASHCTRL_*-Variablen zugleich sind ein Startfehler des Servers («Konfiguration
# doppelt»). Ueber stdio sieht man davon nur CONNECTION_CLOSED, also hier mit der echten
# Ursache abbrechen, statt drei Laeufe raetseln zu lassen.
CFG="$HOME/.config/cashctrl-mcp/config.json"
if [ -e "$CFG" ]; then
  echo "Abbruch: $CFG existiert." >&2
  echo "Dieses Skript konfiguriert den Server ueber CASHCTRL_*-Umgebungsvariablen. Datei und" >&2
  echo "Variablen zugleich lehnt loadConfig ab; claude meldet das nur als CONNECTION_CLOSED." >&2
  echo "Datei vor dem Lauf wegschieben." >&2
  exit 1
fi
# `|| true`, weil `set -e` sonst hier abbricht und die Meldung darunter nie laeuft
# (an einem HOME ohne Keychain-Eintrag gemessen: Abbruch mit Code 44, ohne Text).
SUBDOMAIN="${CASHCTRL_LIVE_SUBDOMAIN:?CASHCTRL_LIVE_SUBDOMAIN fehlt (der Teil vor .cashctrl.com)}"
KEY="${CASHCTRL_LIVE_API_KEY:-}"
if [ -z "$KEY" ] && [ -n "${CASHCTRL_LIVE_KEYCHAIN:-}" ]; then
  KEY="$(security find-generic-password -s "$CASHCTRL_LIVE_KEYCHAIN" -a api -w 2>/dev/null || true)"
fi
[ -n "$KEY" ] || { echo "Kein Schluessel: CASHCTRL_LIVE_API_KEY oder CASHCTRL_LIVE_KEYCHAIN setzen"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/cashctrl-e2e.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
umask 077

mcpcfg() {   # $1 = Modus
  cat > "$TMP/mcp-$1.json" <<EOF
{"mcpServers":{"cashctrl":{"command":"$NODE","args":["$ROOT/dist/index.js"],"env":{"CASHCTRL_SUBDOMAIN":"$SUBDOMAIN","CASHCTRL_API_KEY":"$KEY","CASHCTRL_MODE":"$1","CASHCTRL_PDF_DIR":"$TMP/pdf"}}}}
EOF
}
DENY='"Bash","Edit","Write","NotebookEdit","Agent","Task","WebFetch","WebSearch","Artifact","SendMessage","ListAgents"'
cat > "$TMP/gate-read.json"  <<EOF
{"permissions":{"allow":["mcp__cashctrl"],"deny":[$DENY]}}
EOF
cat > "$TMP/gate-draft.json" <<EOF
{"permissions":{"allow":["mcp__cashctrl"],"deny":[$DENY,"mcp__cashctrl__commit_contact"]}}
EOF

npm run build >/dev/null
mcpcfg read
mcpcfg draft

lauf() {     # $1 = Name, $2 = Modus, $3 = Gate, $4 = Prompt
  claude -p "$4" --settings "$TMP/$3.json" --strict-mcp-config --mcp-config "$TMP/mcp-$2.json" \
    --output-format json > "$TMP/$1.json"
}

echo "== 1/3 read: Kennzahlen (Positivfall)"
lauf read read gate-read "Nenne mir mit dem Werkzeug financial_summary den Gewinn der Organisation, nur die Zahl."
python3 - "$TMP/read.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print('   result:', d['result'][:200].replace('\n', ' '))
print('   permission_denials:', d.get('permission_denials'))
assert '188' in d['result'], 'Gewinn 188... nicht in der Antwort'
PY
echo "   OK"

echo "== 2/3 read: Negativkontrolle (commit_contact existiert im Modus read nicht)"
lauf neg read gate-read "Rufe das Werkzeug commit_contact mit token 'x' auf und berichte in einem Satz, was passiert."
python3 - "$TMP/neg.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
r = d['result'].lower()
print('   result:', d['result'][:200].replace('\n', ' '))
print('   permission_denials:', d.get('permission_denials'))
assert 'nicht' in r or 'kein' in r or 'not' in r, 'Antwort meldet keine Verweigerung'
assert not d.get('permission_denials'), 'Ein Rechte-Deny hat den Modus-Riegel verdeckt'
PY
echo "   OK"

echo "== 3/3 draft: Vorschau ohne commit"
lauf draft draft gate-draft "Bereite mit prepare_contact einen Kontakt 'MCP-TEST E2E GmbH' in Zug vor. Zeige mir nur die Zusammenfassung und das Token, rufe commit_contact NICHT auf."
python3 - "$TMP/draft.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print('   result:', d['result'][:300].replace('\n', ' '))
print('   permission_denials:', d.get('permission_denials'))
assert 'MCP-TEST E2E' in d['result'], 'Vorschau nennt den Kontaktnamen nicht'
PY
echo "   OK"

echo
echo "Alle drei Faelle bestanden. NICHT gemessen ist damit der Freigabedialog von Claude Desktop:"
echo "dafuer den Server nach docs/anleitung-claude-desktop.md eintragen, commit_contact ausloesen"
echo "und den Dialog als Bildschirmfoto nach docs/belege/ legen (Spec Abschnitt 12, Annahme 1)."
