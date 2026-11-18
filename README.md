# cashctrl-mcp

**Inoffizieller MCP-Server für CashCtrl.** Gebaut von der iConference AG, Zug. Er stammt nicht von
der CashCtrl AG und wird von ihr weder herausgegeben noch unterstützt.

Der Server lässt einen KI-Assistenten (zuerst Claude Desktop) kontrolliert in eine
CashCtrl-Buchhaltung. Lesen ist frei, Schreiben nur auf einer ausdrücklich gesetzten Stufe und
erst nach Vorschau und Bestätigung. Er läuft lokal auf Ihrem Rechner, der Schlüssel verlässt ihn
nicht, nichts wird gehostet.

## Stand

Fassung 0.6.0 vom 18.11.2026. Was sich je Fassung geändert hat, steht im [Changelog](CHANGELOG.md).

«Gemessen» heisst in diesem Dokument: gegen eine echte CashCtrl-Buchhaltung gelaufen und das Ergebnis in
CashCtrl nachgelesen. Was nur gegen aufgezeichnete Antworten getestet ist, steht unter
[Entwicklung](#entwicklung) als ungeprüft.

## Woher der Code kommt

Dieser Server ist die Buchhaltungsanbindung des
[Operating Desk](https://iconference.ch/ki-produkte/operating-desk/datasheet-de) der iConference AG. Der Desk
führt die Vorgänge eines Betriebs und verbindet dafür Mail, Dateiablage, Verträge und ERP. Offerten und
Rechnungen legt er über dieselbe Werkzeugschicht in CashCtrl an, die hier als MCP-Server läuft. Für den Desk
gilt dieselbe Regel wie für diesen Server: Die KI bereitet vor, ein Mensch prüft und bestätigt, erst dann wird
geschrieben.

Die Anbindung ist auch ohne den Desk brauchbar. Wer CashCtrl führt und mit Claude arbeitet, kann damit seine
Buchhaltung befragen und Belege vorbereiten.

## Sicherheitsmodell

Fünf Riegel, in dieser Reihenfolge:

1. **Modus.** `read`, `draft` oder `full`, Standard ist `read`. Werkzeuge oberhalb des Modus
   werden gar nicht erst registriert, das Modell sieht sie nicht. Es gibt kein Werkzeug, das den
   Modus ändert. Umschalten heisst: Konfiguration ändern, Client neu starten.
2. **Zweistufiges Schreiben.** Jede Schreibaktion besteht aus `prepare_*` und `commit_*`.
   `prepare_*` prüft, rechnet, warnt vor Dubletten und gibt eine lesbare Zusammenfassung samt
   Einmal-Token zurück. Das Token gilt 10 Minuten, lebt nur im Arbeitsspeicher, ist an Art,
   Organisation und die geprüfte Eingabe gebunden und verfällt beim Neustart. `commit_*` ohne
   gültiges Token schlägt fehl. Die Zusammenfassung der Fachwerkzeuge endet mit dem Firmennamen aus
   CashCtrl («Organisation: Muster AG (meine-firma)»), damit Sie sehen, in welche Buchhaltung
   geschrieben wird.
3. **Kein Löschen ohne ausdrücklichen Schalter je Organisation, und dann nur ungebuchte Belege.**
   Standard aus, auch auf Stufe `full`. Löschen ist die einzige unumkehrbare Klasse. Mit dem Opt-in
   `deleteOrders` löscht `prepare_delete_order` / `commit_delete_order` einen ungebuchten Beleg,
   etwa eine Offerte oder einen Rechnungsentwurf; gebuchte Belege und Belege mit unklarem
   Buchungsstand weist der Server ab. Alles andere Löschen bleibt beim Menschen in der
   CashCtrl-Oberfläche.
4. **Allgemeine Werkzeuge: eigene Schalter für Löschen, Lohn und Mail.** `api_read` und
   `prepare_api_write` / `commit_api_write` erreichen jeden Endpunkt der CashCtrl-API, aber nur über
   den eingebauten Katalog (unbekannter Pfad, falsche Methode, fehlende Pflichtparameter und unbekannte
   Parameter weist der Server ab, bevor er CashCtrl aufruft). Drei Klassen brauchen zusätzlich einen
   Schalter der angesprochenen Organisation, Standard aus: **Löschen** (jeder POST auf `/delete.json`)
   braucht `deleteRecords`, **Lohn** (jeder Pfad unter `salary/`, lesend wie schreibend, es sind
   Personendaten der Mitarbeitenden) braucht `salary`, **Mail** (Pfade auf `/mail.json`) braucht
   `sendMail`. Ein Endpunkt, der zwei Klassen berührt (`salary/…/delete.json`), braucht beide Schalter.
   Die Schalter werden in `prepare` und in `commit` geprüft. Diese Wege sind **experimentell**: am
   Mandanten gemessen sind nur vier Lösch-Endpunkte (siehe [Entwicklung](#entwicklung)), und sie umgehen
   die Fachprüfungen der Fachwerkzeuge (zum Beispiel die Sperre auf ungebuchte Belege bei `delete_order`).
5. **Rolle des API-Benutzers.** In CashCtrl bekommt der API-Benutzer die zur Stufe passende Rolle.
   Das ist der einzige Riegel auf dem Server von CashCtrl, alle anderen liegen auf Ihrem Rechner.

Dazu: der Schlüssel erscheint nie in Werkzeugausgaben, Fehlermeldungen oder Logs. Beim Hochladen einer PDF-Datei (`commit_file_upload`) geht der Inhalt an den Objektspeicher von CashCtrl (Oracle Cloud), nie der Schlüssel: die Upload-Adresse wird vorher gegen die Regionen der Konfiguration geprüft, es gibt keine Umleitung, und die Adresse steht in keiner Ausgabe. Ein lokaler
Monatszähler warnt ab 80 Prozent des Kontingents und verweigert bei 100 Prozent weitere Aufrufe,
damit CashCtrl den Zugang nicht sperrt.

## Installation

Voraussetzung: Node 22.12 oder neuer.

Der Server startet ohne Installation über `npx`:

```bash
npx -y @iconference/cashctrl-mcp
```

Er spricht MCP über die Standardein- und -ausgabe und wartet auf einen Client. Der Eintrag in einem MCP-Client
sieht so aus:

```json
{
  "mcpServers": {
    "cashctrl": { "command": "npx", "args": ["-y", "@iconference/cashctrl-mcp"] }
  }
}
```

Für Claude Desktop führt [`docs/anleitung-claude-desktop.md`](docs/anleitung-claude-desktop.md) Schritt für
Schritt durch die Einrichtung. Gemessen ist dort der Weg aus dem Quelltext mit absoluten Pfaden; der Eintrag
mit `npx` ist in Claude Desktop noch nicht gemessen.

Aus dem Quelltext:

```bash
git clone https://github.com/iconference-ag/cashctrl-mcp.git
cd cashctrl-mcp
npm install
npm run build
```

Danach ist `dist/index.js` der Server.

## API-Benutzer in CashCtrl anlegen

In CashCtrl unter **Einstellungen, Benutzer & Rollen, API-Benutzer hinzufügen**. Ein API-Benutzer
gehört zu genau einer Organisation und hat die Rechte der Rolle, die Sie ihm geben. Geben Sie ihm
die Rolle, die zu Ihrer Stufe passt: eine nur lesende Rolle für `read`. Notieren Sie den Schlüssel,
CashCtrl zeigt ihn nur einmal.

## Konfiguration

Datei `~/.config/cashctrl-mcp/config.json`, Rechte 0600 (`chmod 600`). Zu offene Rechte geben eine
Warnung im Log.

```json
{
  "mode": "read",
  "pdfDir": "~/Downloads/cashctrl-mcp",
  "orgs": [
    { "name": "meine-firma", "subdomain": "meinefirma", "apiKey": "…" }
  ]
}
```

- `name` ist der Name, unter dem Sie die Organisation im Gespräch ansprechen. Er wird auch als
  Verzeichnisname für abgelegte PDF verwendet und darf deshalb nur Buchstaben, Ziffern, Punkt,
  Unterstrich und Bindestrich enthalten. Keine Umlaute, keine Leerzeichen.
- `subdomain` ist der Teil vor `.cashctrl.com` in Ihrer CashCtrl-Adresse.
- `sendMail` (optional, Standard `false`) schaltet den Belegversand (`prepare_send_order` /
  `commit_send_order`) für diese Organisation frei. Auch im Modus `full` bleiben die beiden
  Werkzeuge ohne diesen Schalter unsichtbar. Siehe «Hochschalten» unten.
- `deleteOrders` (optional, Standard `false`) schaltet das Löschen ungebuchter Belege
  (`prepare_delete_order` / `commit_delete_order`) für diese Organisation frei, ebenfalls nur im
  Modus `full`.
- `salary` (optional, Standard `false`) schaltet die Lohn-Endpunkte der allgemeinen Werkzeuge frei
  (`api_read` auf `salary/…`, `prepare_api_write` auf `salary/…`). Es sind Personendaten der Mitarbeitenden.
- `deleteRecords` (optional, Standard `false`) schaltet das Löschen über `prepare_api_write`
  (Pfade auf `/delete.json`) frei, im Modus `full`. Es ersetzt `deleteOrders` nicht und lockert dessen
  Sperre auf ungebuchte Belege nicht: `delete_order` bleibt der sichere Weg für Belege.
- Mail-Endpunkte der allgemeinen Werkzeuge (Pfade auf `/mail.json`) brauchen den bestehenden Schalter `sendMail`.
- `uploadRegions` (optional, Standard `["eu-zurich-1"]`) nennt die Regionen des Oracle-Objektspeichers, zu denen `commit_file_upload` hochladen darf: erlaubt ist genau der Host `objectstorage.<region>.oraclecloud.com`. Das Feld steht je Organisation oder einmal auf oberster Ebene der Datei für alle; die Angabe bei der Organisation gilt vor der globalen. Eine Region besteht aus Kleinbuchstaben, Ziffern und Bindestrich (`eu-zurich-1`), sonst startet der Server nicht. Zeigt CashCtrl eine andere Region (der Mandant liegt anderswo), lehnt `commit_file_upload` ab, bevor ein Byte hinausgeht: dann die Region hier eintragen.
- Mehrere Organisationen sind vorgesehen (Treuhand). Bei genau einer ist der Parameter `org` an
  jedem Werkzeug optional.

Für ein Setup mit einer einzigen Organisation geht es auch ohne Datei, über
`CASHCTRL_SUBDOMAIN`, `CASHCTRL_API_KEY`, `CASHCTRL_MODE`, `CASHCTRL_PDF_DIR` und
`CASHCTRL_SEND_MAIL` (`1` schaltet Belegversand frei, sonst bleibt er aus) und
`CASHCTRL_DELETE_ORDERS` (`1` schaltet das Löschen ungebuchter Belege frei, sonst bleibt es aus),
`CASHCTRL_SALARY` (`1` schaltet die Lohn-Endpunkte frei) und `CASHCTRL_DELETE_RECORDS` (`1` schaltet das allgemeine
Löschen frei) und `CASHCTRL_UPLOAD_REGIONS` (kommagetrennt, z. B. `eu-zurich-1,eu-frankfurt-1`). Entweder Datei oder Umgebungsvariablen: beides gesetzt ist ein Startfehler mit klarer Meldung.

## Hochschalten auf `draft` oder `full`

Der Standard ist `read`. Wer schreiben will, tut zwei Dinge:

1. In der Konfiguration `"mode": "draft"` (oder `"full"`) setzen und den Client neu starten. Erst
   danach sind die Werkzeuge `prepare_*` und `commit_*` überhaupt sichtbar.
2. In CashCtrl die Rolle des API-Benutzers auf schreibend erweitern. Ohne das antwortet CashCtrl
   mit einem 403, und der Server meldet «Rolle des API-Benutzers erlaubt das nicht».

Die beiden Schritte sind mit Absicht getrennt. Wer nur den Modus hochschaltet, kann weiterhin
nichts schreiben, und wer nur die Rolle erweitert, sieht die Werkzeuge nicht.

`full` fügt Aktionen hinzu, die Geld und Aussenwirkung betreffen: Zahlung erfassen, Buchung
anlegen, Belegstatus setzen, Beleg per Mail versenden. Der Mailversand ist die einzige Aktion, die
den Rechner verlässt. Er braucht deshalb zusätzlich den Opt-in `sendMail` je Organisation,
Standard aus. Ohne ihn bleiben `prepare_send_order`/`commit_send_order` auch im Modus `full`
unsichtbar: in der Konfiguration `"sendMail": true` bei der Organisation setzen (oder
`CASHCTRL_SEND_MAIL=1`) und den Client neu starten. Dasselbe gilt für das Löschen ungebuchter
Belege mit dem Opt-in `deleteOrders` (oder `CASHCTRL_DELETE_ORDERS=1`). Löschen, Lohn und Mail über die
allgemeinen Werkzeuge brauchen ihre eigenen Schalter (`deleteRecords`, `salary`, `sendMail`), ebenfalls
Standard aus; die Werkzeuge `prepare_api_write` / `commit_api_write` sind im Modus `full` sichtbar, die
Schalter öffnen nur die jeweilige Klasse von Endpunkten.

## Werkzeuge

35 Werkzeuge im Standard (Modus `full`), je 2 mehr mit dem Opt-in `sendMail` (Belegversand) und dem Opt-in
`deleteOrders` (Löschen ungebuchter Belege), 39 mit beiden. Die Schalter `salary` und `deleteRecords` ändern
die Zahl nicht (sie öffnen Endpunkte der allgemeinen Werkzeuge). Im Modus `read` sind es 17 Werkzeuge, in `draft` 25.
Jedes nimmt optional `org`; bei genau einer Organisation kann der Parameter entfallen.

### Stufe `read` (17)

| Werkzeug | Zweck |
|---|---|
| `list_orgs` | konfigurierte Organisationen mit Firmenname des Hauptstandorts, aktivem Modus und `reachable` (CashCtrl antwortet) |
| `usage` | Modus, Monatsverbrauch gegen das Limit von 30'000 Anfragen |
| `list_fiscal_periods` | Geschäftsjahre mit Start, Ende, aktuell, abgeschlossen |
| `list_taxes` | Steuercodes mit ID, Name, Satz und `inactive` |
| `list_currencies` | Währungen mit Kennung, Code und Kennzeichen der Standardwährung |
| `search_contacts` | Kunden, Lieferanten, Mitarbeitende suchen, auch nach Notiz (`notes`) |
| `get_contact` | ein Kontakt mit Adressen, Kontaktkanälen und Notiz |
| `search_articles` | Artikelstamm mit Einheit, Verkaufs- und Einkaufspreis, Bestand |
| `get_article` | ein Artikel nach Kennung: Nummer, Name, Einheit, Verkaufspreis (netto oder brutto geführt), Konto |
| `search_orders` | Belege nach Kategorie, Status, Kontakt, Datum, Notizen, Vorgänger, Volltext; Geschäftsjahr mit `fiscalPeriodId` (ohne: nur das aktuelle, dazu offene früherer Jahre) |
| `get_order` | ein Beleg mit IDs, Notizen, Positionen, Netto, Brutto, Steuer, Totale |
| `get_order_pdf` | legt das PDF des Belegs lokal ab und nennt den Pfad |
| `search_journal` | Buchungen in einem Datumsbereich; Geschäftsjahr mit `fiscalPeriodId` (ohne: nur das aktuelle) |
| `list_accounts` | Kontenplan mit Endsaldo |
| `financial_summary` | Aktiven, Passiven, Ertrag, Aufwand, Gewinn, offene Debitoren und Kreditoren (nur Belege mit offenem Betrag) |
| `api_catalog` | durchsucht den eingebauten Katalog der CashCtrl-API (376 Endpunkte) nach Pfad und Parametern, ohne Netzaufruf |
| `api_read` | liest über jeden GET-Endpunkt des Katalogs (am 24.10.2026 live gemessen (11 Fälle am Demo-Mandanten: JSON, Text ohne Endung, CSV als Text, Excel und PDF als Datei, Kappung, Schalter und Abweisungen ohne Netzaufruf)); Lohn nur mit `salary` |

### Stufe `draft` (8 zusätzlich)

| Werkzeugpaar | Zweck |
|---|---|
| `prepare_contact` / `commit_contact` | Kontakt anlegen (auch mit Notiz `notes`), Vorschau warnt bei ähnlichen Kontakten |
| `prepare_article` / `commit_article` | Artikel anlegen; die Artikelnummer ist Pflicht (ohne sie weist CashCtrl den Artikel ab, gemessen 09.11.2026), die Einheit wird aufgelöst und nie neu angelegt |
| `prepare_order_draft` / `commit_order_draft` | Offerte, Auftragsbestätigung, Rechnung oder Einkaufsrechnung **als Entwurf** anlegen |
| `prepare_file_upload` / `commit_file_upload` | PDF (höchstens 10 MB) in die Dateiablage von CashCtrl legen und auf Wunsch an einen Beleg hängen; Näheres unten (0.6.0) |

### Stufe `full` (10 zusätzlich, dazu je 2 weitere mit den Opt-ins `sendMail` und `deleteOrders`)

| Werkzeugpaar | Zweck |
|---|---|
| `prepare_order_create` / `commit_order_create` | Offerte, Auftragsbestätigung oder Rechnung in einem Schreibaufruf mit gewähltem Status anlegen (eine Rechnung mit Status «Offen» ist sofort gebucht) |
| `prepare_order_status` / `commit_order_status` | Belegstatus setzen, zum Beispiel Offerte akzeptiert, per Name oder Status-ID |
| `prepare_payment` / `commit_payment` | Zahlung erfassen und den Beleg auf bezahlt setzen |
| `prepare_journal_entry` / `commit_journal_entry` | manuelle Buchung mit Soll- und Habenkonto |
| `prepare_send_order` / `commit_send_order` | Beleg per CashCtrl-Belegversand mailen, nur mit `sendMail` (siehe Konfiguration) |
| `prepare_delete_order` / `commit_delete_order` | ungebuchten Beleg endgültig löschen, nur mit `deleteOrders`; gebuchte Belege weist der Server ab, auch wenn sie zwischen Vorschau und Ausführung gebucht wurden |
| `prepare_api_write` / `commit_api_write` | schreibt über jeden POST-Endpunkt des Katalogs (experimentell, am Mandanten gemessen sind nur vier Lösch-Endpunkte); Löschen nur mit `deleteRecords`, Lohn nur mit `salary`, Mail nur mit `sendMail` |

### PDF hochladen und anhängen (0.6.0)

`prepare_file_upload` / `commit_file_upload` legen eine PDF-Datei in der Dateiablage von CashCtrl ab und hängen sie auf Wunsch an
einen Beleg. Stufe `draft`: das Werkzeug bucht nichts und löscht nichts; es fügt eine Datei hinzu und, mit `anhaengenAn`, einen
Anhang an einem vorhandenen Beleg (auch an einem gebuchten).

- Eingabe: `name` (Dateiname ohne `/` und `\`, ohne Steuerzeichen, nicht `.` und nicht `..`, höchstens 255 Zeichen), `inhalt` (der Inhalt der Datei
  als Base64-Text; im eigenen Prozess über `createToolset(...).call` auch ein `Uint8Array`) **oder** `fileId` einer schon
  festgehaltenen Datei (dann wird nur angehängt, nichts hochgeladen), `mimeType` (nur `application/pdf`), optional
  `anhaengenAn: { art: "order", id }`. **Einen Dateipfad nimmt das Werkzeug nie an**; es gibt kein Eingabefeld dafür, ein Wert,
  der wie ein Pfad aussieht, wird abgewiesen. Geprüft werden: gültiges Base64, höchstens 10 MB (10 × 1024 × 1024 Bytes), die ersten
  Bytes sind `%PDF-`.
- `prepare_file_upload` ruft CashCtrl nicht auf. Die Vorschau zeigt Name, Grösse, SHA-256 und Ziel.
- `commit_file_upload` führt in dieser Reihenfolge aus: `file/prepare`; die `writeUrl` prüfen (Schema `https`, keine
  Benutzerangaben, Port leer oder 443, Host genau `objectstorage.<region>.oraclecloud.com` mit einer Region aus `uploadRegions`,
  Pfad beginnt mit `/p/`; sonst Abbruch ohne Upload); PUT der Bytes ohne `Authorization`, ohne Umleitung, mit eigener Zeitgrenze von 120 Sekunden und ohne
  Drossel und Zähler von CashCtrl, Erfolg nur bei HTTP 200 und gleichem `opc-content-md5`; `file/persist`; mit `anhaengenAn`
  `order/read` und `order/update_attachments` mit den bisherigen Anhängen und der neuen Datei (CashCtrl ersetzt die ganze Liste,
  der Server liest sie darum vorher; ist die Liste nicht eindeutig lesbar, sendet er nichts).
- Mit `anhaengenAn` liest `commit_file_upload` den Beleg schon vor `file/prepare`: gibt es ihn nicht oder ist seine Anhangliste nicht lesbar, endet der Aufruf ohne Upload. Das Anhängen liest die Liste danach frisch.
- Die `writeUrl` verlässt den Server nie: sie steht in keiner Antwort, keiner Fehlermeldung und keinem Log (höchstens der
  Hostname). Wird ein Upload nicht festgehalten, löscht CashCtrl die Datei nach 4 Stunden; das Werkzeug löscht selbst nichts.
- Fehler nach `file/prepare` tragen in `structuredContent` zusätzlich `fileId` und `festgehalten` (`ja`, `nein` oder `offen`; `offen`, wenn der Ausgang von `file/persist` unklar ist). Beim blossen Anhängen mit `fileId` steht nur `fileId`. Der Erfolg nennt `fileId`, `name`, `bytes`, `sha256`, `festgehalten: true`, `angehaengt`, bei Ziel `beleg` und `fileIds`; beim blossen Anhängen mit `fileId` nur `fileId`, `angehaengt`, `beleg` und `fileIds` (kein `festgehalten`: das Werkzeug prüft es dort nicht). Scheitert das Anhängen nach dem Festhalten, nennt auch die Fehlermeldung die `fileId`. Dann `prepare_file_upload` mit `fileId` und
  `anhaengenAn` aufrufen: das hängt nur noch an und legt keine zweite Datei an.
- **Speicher:** bis zum `commit_*` liegt die Datei als Base64-Text im Token-Speicher, bei 10 MB (10 × 1024 × 1024 Bytes) rund 14 MB Text (13,3 MiB) je offener Vorschau. Das Token gilt 10 Minuten; abgelaufene Einträge räumt erst die nächste
  Vorschau weg; es sind höchstens 3 Vorschauen gleichzeitig offen (siehe unten).
- **Grösse:** Im eigenen Prozess (`createToolset(...).call`) gilt die Grenze von 10 MB sauber: darüber kommt eine Fehlermeldung. Über die Standardeingabe (MCP) nimmt der Server Nachrichten bis 16 MiB (Base64 von 10 MiB plus JSON; das SDK gäbe 10 MiB vor, damit blieben PDF über rund 7,8 MB ohne Antwort). **Dateien über etwa 12 MB beenden die MCP-Verbindung über stdio, statt abgewiesen zu werden:** eine Nachricht über 16 MiB lässt das SDK den Transport schliessen (gemessen mit 17 MiB: der Server endet mit Exit 0). Eine Datei zwischen 10 und 12 MB weist der Server mit Fehlermeldung ab.
- **Offene Vorschauen:** Der eingebaute Token-Speicher hält höchstens 3 gleichzeitig offene Upload-Vorschauen mit Datei (`inhalt`; eine Vorschau mit blosser `fileId` zählt nicht), gemeinsam über alle Organisationen; eine vierte wird abgewiesen («Zu viele offene Upload-Vorschauen; erst ausführen oder 10 Minuten warten.»). Abgelaufene werden vorher weggeräumt. Gemessen im eigenen Prozess mit einer Datei von 10 MiB (Node 24.22.1, Attrappe für `fetch`): Prozessspeicher 72 MiB vor prepare, 116 MiB danach, 144 MiB nach commit (zugleich die Spitze); in einem weiteren Lauf des Prüfers 184 MiB. **Über stdio (Claude Desktop, `npx`) kann eine Datei von 10 MB den Speicher des Servers auf rund 1 GB treiben (gemessen 854 bis 1048 MiB RSS für eine einzige Vorschau, an `dist/index.js`); im eigenen Prozess rund 144 bis 184 MiB.** Die Ursache über stdio ist nicht gemessen (vermutlich der Lesepuffer des SDK).
- **Grenzen der Prüfung:** Die Host-Prüfung unterscheidet keine Oracle-Kunden; sie schützt nur vor Hosts ausserhalb von `objectstorage.<region>.oraclecloud.com`. Zwischen `order/read` und `order/update_attachments` kann ein gleichzeitig gesetzter Anhang verloren gehen; CashCtrl kennt kein bedingtes Schreiben. Wer dem Werkzeugsatz ein eigenes `fetchImpl` übergibt, sieht die `writeUrl` im Klartext und darf sie nicht protokollieren.
- Gemessen ist der Ablauf in CashCtrl (Demo-Mandant, 18.11.2026), das Werkzeug selbst nur gegen Attrappen.

### Allgemeine Werkzeuge (0.4.0, experimentell)

`api_catalog`, `api_read` und `prepare_api_write` / `commit_api_write` decken alle 376 Endpunkte der CashCtrl-API
ab (Stand der API-Doku 24.10.2026: 184 lesend, 192 schreibend, davon 45 löschend und 90 im Bereich Lohn). Der Katalog
liegt im Paket; zur Laufzeit braucht er kein Netz. **Fachwerkzeuge zuerst:** wo es eines gibt (`search_contacts`,
`get_order`, `prepare_order_create` …), nimmt das Modell dieses, weil es Rundung, Steuer und Dubletten prüft. Der
allgemeine Weg ist für den Rest.

- `api_catalog` mit `query` (Wörter in Pfad oder Titel, englisch) und `area` (erstes Pfadsegment, etwa `person`,
  `order`, `salary`) liefert höchstens 100 Treffer mit `kind` (`read`, `write`, `delete`) und, wo nötig, `gate`
  (`salary`, `deleteRecords`, `sendMail`; `gates`, wenn es mehrere sind). Mit `path` kommt der volle Eintrag mit allen
  Parametern (Pflicht, Typ, bei JSON-Parametern die Felder der Elemente).
- `api_read` prüft vor jedem Aufruf: Pfad im Katalog, Methode GET, Lohn nur mit `salary`, Pflichtparameter da, nur
  bekannte Parameter. Antworten über 60'000 Zeichen werden gekürzt, mit `limit` und `start` lässt sich blättern. Dateien
  (PDF, Excel, CSV, ZIP) legt der Server wie `get_order_pdf` im PDF-Ordner ab; die Antwort nennt `file`, `bytes` und
  `contentType`.
- `prepare_api_write` prüft dasselbe für POST-Endpunkte und zeigt Titel, Pfad, Organisation und jedes Feld als
  `name = wert` (je Wert auf 200 Zeichen gekürzt). Es ruft CashCtrl nicht auf und nennt darum nur den Namen aus
  der Konfiguration, nicht den Firmennamen. `commit_api_write` prüft die Schalter
  erneut und sendet genau einen POST mit der geprüften Eingabe. Die Vorschau warnt immer: «Allgemeiner Schreibweg: keine
  Fachprüfung des Servers (Rundung, Steuer, Dubletten), am Mandanten nicht gemessen.» Beim Löschen kommt «Löschen ist
  unumkehrbar.» dazu.
- Listen für CSV-Parameter (`ids`, `orderIds` …) darf das Modell als Liste angeben; der Server verbindet sie mit Komma.
- Regel «eines von» (0.6.0): bei `person/create.json` und `person/update.json` genügt eines von `company`, `firstName`, `lastName`. Laut Doku von CashCtrl gilt «Either firstName, lastName or company must be set»; am Mandanten noch nicht gemessen. `api_catalog` zeigt das als `einesVon`.
- `file/prepare.json` weist der allgemeine Schreibweg ab (0.6.0): die Antwort trüge die Upload-Adresse ins Modell. Für Uploads `prepare_file_upload` verwenden.

Bei einem Fehler enthält die Antwort neben dem Text `structuredContent` mit `kind` (Art des
Fehlers), bei Schreibaufrufen `sent` (die Anfrage könnte CashCtrl erreicht haben; im Zweifel
`true`), nach dem Anlegen `createdId` und bei einem festen Grund `reason` (derzeit kein Wert
belegt; `negative_total` entfiel mit 0.3.0). Hat ein `commit_*` schon einen Schreibaufruf an
CashCtrl abgesetzt, trägt jeder spätere Fehler `sent: true`. Bei `sent: true` oder `createdId` darf der Aufrufer
nie automatisch erneut anlegen. Der Server wiederholt nur Antworten mit 429, nie einen POST nach
einem Netzfehler.

Preise geben Sie überall **netto** an (Ausnahmen: `order_create` mit `copyItemsFromOrderId` übernimmt
Bruttopreise wörtlich, und ein brutto geführter Stammpreis eines Artikels geht wörtlich als Bruttopreis). Dass CashCtrl intern den Bruttopreis je Stück speichert,
rechnet der Server um; das Modell sieht davon nichts. Eine Rabattzeile geben Sie mit negativem
Nettopreis an; CashCtrl führt sie als Position mit negativem Bruttopreis (gemessen 12.10.2026).

Steuer je Position: ein angegebener `taxCode` gilt genau so; fehlt er, gilt die Steuer des Ertragskontos der Position (zuerst
`accountNumber` der Position, dann das Ertragskonto des Artikels, dann `defaultAccountNumber`); führt das Konto keine, geht die
Position ohne Steuer hinaus, brutto = netto. Die Währung des Belegs setzt `currency` (Code, siehe `list_currencies`), ohne Angabe gilt
die Währung des Mandanten; Kurse setzt CashCtrl selbst.

## Grenzen

- **Kontingent:** 30'000 Anfragen pro Monat, 300 Anfragen Burst mit Auffüllung 30 pro Sekunde
  (CashCtrl-AGB Ziffer 6). Der Server wartet selbst, statt in ein 429 zu laufen, zählt lokal mit,
  warnt ab 80 Prozent und stoppt bei 100 Prozent. Ein Werkzeug kann mehrere Aufrufe kosten:
  `prepare_order_draft` braucht vier plus einen je Artikelposition. Die erste Vorschau eines Fachwerkzeugs
  liest je Organisation einmal den Firmennamen (ein Aufruf).
- **Monatswechsel nach UTC.** Der Zähler setzt sich um 00:00 UTC zurück,
  in der Schweiz also am 1. um 01:00 (Winterzeit) oder 02:00 (Sommerzeit).
- **Kontenplan, Geschäftsjahre und Steuercodes kommen vollständig.** `list_accounts`,
  `list_fiscal_periods` und `list_taxes` liefern alle Einträge auf einmal, ohne Blättern; CashCtrl kennt dort
  kein Limit. Alle übrigen Listen zeigen höchstens 200 Einträge und melden `hasMore`.
- **Kontenrahmen:** `financial_summary` klassiert nach der ersten Ziffer der Kontonummer
  (1 Aktiven, 2 Passiven, 3 Ertrag, 4 bis 8 Aufwand). Das ist der Schweizer KMU-Kontenrahmen und
  eine Annahme. Wer einen anderen Kontenrahmen führt, bekommt hier falsche Summen.
- **Organisationsname** ohne Umlaute und Leerzeichen, weil er als Verzeichnisname für PDF dient.
- **Offener Betrag:** `open` ist bei Belegen, deren Status nicht ins Journal bucht (Offerte,
  Auftragsbestätigung), `null` und nicht `0`. Solche Belege zählen in den offenen Posten nicht mit.
- **Versandstatus:** welchen Status ein Beleg nach dem Mailversand bekommt, gibt die Kategorie in
  CashCtrl vor (`sentStatusId`), nicht der Server. Kennt die Kategorie keinen, bleibt der Status
  stehen und der Server sagt das in einer Warnung.
- **Negatives Total:** erlaubt. CashCtrl nahm am Demo-Mandanten einen Beleg mit Total −100 an (17.10.2026); der Server weist ihn
  seit 0.3.0 nicht mehr ab. Ob das buchhalterisch eine Gutschrift ist, entscheidet der Mensch.
- **Als Fachwerkzeug nicht enthalten:** Löschen ausser ungebuchten Belegen mit `deleteOrders`, Lohn, Anlagegüter, Geschäftsjahr
  abschliessen oder wiedereröffnen, Berichts-Endpunkte, Importe, Dateiablage (ausser dem PDF-Upload seit 0.6.0), Einstellungen. Seit 0.4.0 sind sie über die
  allgemeinen Werkzeuge erreichbar (experimentell; am Mandanten gemessen sind nur vier Lösch-Endpunkte, siehe
  [Entwicklung](#entwicklung)), Löschen nur mit `deleteRecords`, Lohn nur
  mit `salary`. Als Löschen gilt auch `file/empty_archive.json` (leert das Dateiarchiv endgültig). Geschäftsjahr abschliessen
  und wiedereröffnen haben keinen eigenen Schalter: wer `full` setzt und die Schreibrechte der Rolle in CashCtrl nicht
  einschränkt, erlaubt sie.
- **Kein Webhook.** CashCtrl bietet keine, Änderungen bekommt man nur durch Nachfragen mit.

## Entwicklung

```bash
npm run build       # TypeScript nach dist/
npm test            # Unit-Suite gegen aufgezeichnete Antworten, ohne Netz
npm run typecheck   # src, tests und scripts
```

Die Unit-Suite erreicht das Netz nie: `tests/kein-netz.setup.ts` ersetzt `fetch` durch eine Sperre, und ein Test,
der ohne Attrappe bis dorthin kommt, fällt durch.

Vertragstests gegen einen echten Mandanten laufen nur mit gesetzten Variablen und sind sonst übersprungen. Mandant
und Schlüssel kommen aus der Umgebung, nie aus einer Datei im Repo (`tests/live/mandant.ts`):

```bash
export CASHCTRL_LIVE_SUBDOMAIN=meinefirma        # der Teil vor .cashctrl.com
export CASHCTRL_LIVE_API_KEY=…                   # oder CASHCTRL_LIVE_KEYCHAIN=<Dienstname in der macOS-Keychain>
CASHCTRL_LIVE=1 npx vitest run tests/live/read.live.test.ts                                # nur lesend
CASHCTRL_LIVE=1 CASHCTRL_LIVE_WRITE=1 npx vitest run tests/live/write.live.test.ts         # Kontakt, Offerte, Status
CASHCTRL_LIVE=1 CASHCTRL_LIVE_WRITE=1 npx vitest run tests/live/schreibwege.live.test.ts   # Artikel, Buchung, Zahlung
bash scripts/e2e.sh                                                                        # drei Fälle über claude -p
```

Die schreibenden Läufe legen echte Datensätze mit dem Präfix `MCP-TEST` an und löschen sie am Ende wieder. Sie
prüfen, dass die Kennzahlen des Mandanten danach dieselben sind wie davor. Scheitert das Aufräumen, stehen die
Kennungen im Protokoll und sind von Hand in CashCtrl zu entfernen. Die Läufe setzen einen Mandanten mit dem
Schweizer KMU-Kontenrahmen voraus; die Annahmen stehen im Kopf der Testdateien.

**Am Mandanten gemessen** sind die Schreibwege `contact`, `order_draft` und `order_status` (28.08.2026),
`order_create` und `delete_order` (12.10.2026) sowie `article`, `journal_entry` und `payment` mit Teil- und
Restzahlung (09.11.2026). **Ungeprüft ist `send_order`:** Unser Demo-Mandant lässt den Belegversand nicht zu, das
Werkzeug läuft nur unter Unit-Tests gegen aufgezeichnete Antworten. Wer es einsetzt, prüft das Ergebnis in
CashCtrl nach.

**Ungeprüft ist `file_upload`** (0.6.0): der Ablauf in CashCtrl ist am 18.11.2026 am Demo-Mandanten gemessen, das Werkzeug läuft nur unter Unit-Tests gegen Attrappen. Der PUT mit dem echten `fetch` ist gegen einen lokalen Testserver geprüft (Node 24.22.1: kein `Authorization`, kein `Content-Type`, `Content-Length` gesetzt, 302 wird nicht verfolgt), nicht gegen den Objektspeicher.

Vom allgemeinen Schreibweg (`prepare_api_write` / `commit_api_write`) sind vier Lösch-Endpunkte gemessen
(`inventory/article/delete`, `journal/delete`, `person/delete`, `order/bookentry/delete`, 09.11.2026). Alle
übrigen Endpunkte dieses Wegs sind **experimentell und am Mandanten nicht gemessen**. `api_read` ist am 24.10.2026
gemessen (11 Fälle: JSON, Text ohne Endung, CSV als Text, Excel und PDF als Datei, Kappung, Schalter und
Abweisungen ohne Netzaufruf).

Die Feldnamen der CashCtrl-Antworten sind in [`tests/fixtures/README.md`](tests/fixtures/README.md)
festgehalten. Wer einen Feldnamen braucht, liest ihn dort ab. Gemessene Eigenheiten der Schnittstelle stehen in
[`docs/cashctrl-api-eigenheiten.md`](docs/cashctrl-api-eigenheiten.md).

## Kontakt

iConference AG, Grafenaustrasse 15, 6300 Zug, Schweiz.
[info@iconference.ch](mailto:info@iconference.ch) · [iconference.ch](https://iconference.ch)

Fragen zum Server und Fehlermeldungen gehören in die Issues dieses Repos. Wer wissen will, wie der
[Operating Desk](https://iconference.ch/ki-produkte/operating-desk/datasheet-de) Vorgänge führt und in die
Buchhaltung schreibt, bucht ein [Erstgespräch](https://iconference.ch/#erstgespraech) oder schreibt uns.

## Lizenz

MIT, siehe [`LICENSE`](LICENSE).
