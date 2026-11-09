# cashctrl-mcp in Claude Desktop einrichten

Stand 24.10.2026 (Fassung 0.4.0; die Messung des Freigabedialogs in Schritt 8 stammt von Fassung 0.3.3), macOS. Diese Anleitung führt vom leeren Rechner bis zum ersten
geschriebenen Kontakt. Abschnitt 8 hält fest, wie sich der Freigabedialog von Claude Desktop
verhält (gemessen 24.10.2026).

Voraussetzungen: Node 22.12 oder neuer, Claude Desktop installiert, ein API-Benutzer in CashCtrl
(siehe README, Abschnitt «API-Benutzer in CashCtrl anlegen»).

Seit Fassung 0.5.0 liegt das Paket auch auf npm (`@iconference/cashctrl-mcp`). Diese Anleitung beschreibt den
Weg aus dem Quelltext, weil er in Claude Desktop gemessen ist.

## 1. Server bauen

```bash
cd <ordner>/cashctrl-mcp
npm install
npm run build
```

Danach existiert `dist/index.js`. Merken Sie sich den vollen Pfad dorthin, Sie brauchen ihn in
Schritt 3:

```bash
node -e "console.log(require('path').resolve('dist/index.js'))"
```

## 2. Konfiguration anlegen

Datei `~/.config/cashctrl-mcp/config.json`:

```json
{
  "mode": "read",
  "pdfDir": "~/Downloads/cashctrl-mcp",
  "orgs": [
    { "name": "meine-firma", "subdomain": "meinefirma", "apiKey": "…" }
  ]
}
```

Rechte setzen, sonst warnt der Server beim Start:

```bash
chmod 600 ~/.config/cashctrl-mcp/config.json
```

`mode` bleibt vorerst auf `read`. Hochgeschaltet wird erst in Schritt 6.

## 3. Eintrag in Claude Desktop

Die Datei heisst `claude_desktop_config.json` und liegt unter
`~/Library/Application Support/Claude/`. Wenn sie noch nicht existiert, legen Sie sie an. Sie
erreichen sie auch über Claude Desktop, Einstellungen, Entwickler, Konfiguration bearbeiten.

```json
{
  "mcpServers": {
    "cashctrl": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/<benutzer>/cashctrl-mcp/dist/index.js"]
    }
  }
}
```

Zwei Punkte, an denen es sonst scheitert:

- **Beide Pfade absolut.** Claude Desktop startet den Server nicht aus Ihrer Shell und erbt deren
  `PATH` nicht zuverlässig. Den Pfad zu Node liefert `command -v node`, den zum Server Schritt 1.
  Ein relativer Pfad endet in der Meldung, dass die Verbindung geschlossen wurde, ohne Grund.
- **Enthält die Datei schon andere Server,** ergänzen Sie nur den Eintrag `cashctrl` innerhalb von
  `mcpServers` und lassen die übrigen stehen.

Ein `env`-Block ist nicht nötig, solange die Konfiguration aus Schritt 2 vorhanden ist. Der
Schlüssel steht dann nur dort und nicht zusätzlich in der Claude-Konfiguration.

## 4. Claude Desktop neu starten und die Werkzeugliste prüfen

Claude Desktop ganz beenden und neu öffnen. Der Server wird beim Start gelesen, ein Neuladen des
Fensters genügt nicht.

Fragen Sie im Gespräch: «Welche cashctrl-Werkzeuge hast du?» Erwartet werden **siebzehn** Werkzeuge:
`list_orgs`, `usage`, `list_fiscal_periods`, `list_taxes`, `list_currencies`, `search_contacts`,
`get_contact`, `search_articles`, `get_article`, `search_orders`, `get_order`, `get_order_pdf`,
`search_journal`, `list_accounts`, `financial_summary` und, seit Fassung 0.4.0, `api_catalog` und
`api_read` (der allgemeine Weg zu allen Endpunkten der CashCtrl-API, siehe Schritt 9). Kein
`prepare_` und kein `commit_`: das ist der Modus `read`, und er ist richtig so.

Startet der Server nicht, stossen Sie ihn von Hand an. Die Fehlermeldung steht dann auf der
Standardfehlerausgabe, während Claude Desktop nur «Verbindung geschlossen» meldet:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"sonde","version":"0"}}}' | node dist/index.js
```

Die erste Zeile der Antwort nennt Modus, Anzahl Organisationen und die Werkzeugliste.

## 5. Lesen ausprobieren

Ein paar Fragen, die ohne jedes Risiko laufen:

- «Zeig mir die Kennzahlen meiner Buchhaltung.»
- «Welche Rechnungen sind offen?»
- «Hol mir das PDF der letzten Rechnung.»
- «Wie viel von meinem Monatskontingent ist verbraucht?»

## 6. Auf `draft` hochschalten

Zwei Schritte, beide nötig:

1. In `~/.config/cashctrl-mcp/config.json` `"mode": "draft"` setzen.
2. In CashCtrl unter Einstellungen, Benutzer & Rollen die Rolle des API-Benutzers auf schreibend
   erweitern.

Claude Desktop erneut ganz beenden und neu starten. Die Werkzeugliste zeigt jetzt dreiundzwanzig
Werkzeuge, darunter `prepare_contact` und `commit_contact`.

## 7. Der erste geschriebene Kontakt

Sagen Sie im Gespräch:

> Lege mir einen Kontakt an: MCP-TEST Muster AG in Zug, als Kunde.

Erwarteter Ablauf:

1. Claude ruft `prepare_contact` auf. Es schreibt noch nichts.
2. Sie bekommen eine Zusammenfassung im Klartext, allfällige Warnungen (etwa ein ähnlicher
   Kontakt, der schon existiert) und ein Token mit Gültigkeit von zehn Minuten.
3. Sie antworten «Ja».
4. Claude ruft `commit_contact` mit dem Token auf. Erst dieser Schritt schreibt.

Antworten Sie nicht mit Ja, passiert nichts. Das Token verfällt nach zehn Minuten von selbst und
lässt sich kein zweites Mal einlösen.

Den angelegten Kontakt danach in CashCtrl wieder löschen. Der Server löscht keine Kontakte.

## 8. Der Freigabedialog von Claude Desktop

Alle `commit_*`-Werkzeuge tragen die Annotation `readOnlyHint: false`, die folgenschwersten
zusätzlich `destructiveHint: true`: `commit_order_status`, `commit_order_create`, `commit_payment`,
`commit_journal_entry`, `commit_send_order`, `commit_delete_order` und, seit Fassung 0.4.0,
`commit_api_write`.

Gemessen am 24.10.2026 (Fassung 0.3.3, Modus `draft`):

- Claude Desktop teilt die Werkzeuge unter Einstellungen, Connectors, cashctrl in «Read-only tools»
  (alle lesenden und die `prepare_*`) und «Write/delete tools» (die `commit_*`). Beide Gruppen
  stehen von Haus aus auf «Needs approval».
- Der Dialog «Decline / Always allow / Allow once» kam im ersten Durchgang vor jedem Aufruf, auch
  beim Lesen. Vor `commit_contact` zeigt er nur das Token, nicht den Inhalt des Kontakts
  (`docs/belege/claude-desktop-freigabe-commit-2026-10-24.png`).
- Wer im Dialog «Always allow» wählt, schaltet ihn für dieses Werkzeug ab; danach läuft es ohne
  Rückfrage. Zurück geht es unter Einstellungen, Connectors, cashctrl: die Gruppe auf «Blocked»
  und wieder auf «Needs approval» stellen (so gemessen am 24.10.2026).

Verlassen Sie sich darum nicht allein auf diesen Dialog. Die Sicherung dieses Servers ist die Vorschau
mit Token: Lesen Sie die Zusammenfassung, die Claude nach `prepare_*` zeigt, und antworten Sie nur
mit Ja, wenn sie stimmt. Ohne Ja wird nichts geschrieben. Wählen Sie bei `commit_*` nie «Always
allow», wenn Sie den Dialog als zweite Kontrolle behalten wollen.

## 9. Auf `full` hochschalten

`full` fügt zehn Werkzeuge hinzu, die Liste zeigt dann dreiunddreissig: Belegstatus setzen, Beleg mit Status anlegen,
Zahlung erfassen, Buchung anlegen, dazu den allgemeinen Schreibweg `prepare_api_write` / `commit_api_write`, je mit
Vorschau und Ausführung. Vorgehen wie in Schritt 6, mit `"mode": "full"` und einer entsprechend
weiten Rolle in CashCtrl.

Der allgemeine Schreibweg erreicht jeden schreibenden Endpunkt der CashCtrl-API (Claude findet Pfad und
Parameter mit `api_catalog`). Er ist **experimentell und am Mandanten nicht gemessen** und kennt keine
Fachprüfung (Rundung, Steuer, Dubletten); wo es ein Fachwerkzeug gibt, nimmt Claude dieses. Drei Klassen
brauchen zusätzlich einen Schalter bei der Organisation, Standard aus: Löschen `"deleteRecords": true`,
Lohn (lesend und schreibend) `"salary": true`, Mail den bestehenden `"sendMail": true`.

Der Mailversand (`prepare_send_order`/`commit_send_order`) ist die einzige Aktion, die den
Rechner verlässt, und braucht deshalb einen eigenen Schalter: den Opt-in `sendMail` je
Organisation, Standard aus. Ohne ihn bleiben die beiden Werkzeuge auch im Modus `full`
unsichtbar. In `~/.config/cashctrl-mcp/config.json` bei der Organisation `"sendMail": true`
setzen und Claude Desktop erneut ganz beenden und neu starten; erst dann tauchen die zwei
Werkzeuge in der Liste auf.
