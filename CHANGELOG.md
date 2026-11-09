# Changelog

Daten im Format TT.MM.JJJJ. «Gemessen» heisst: gegen eine echte CashCtrl-Buchhaltung gelaufen und das Ergebnis in CashCtrl nachgelesen.

## 0.5.0 (09.11.2026)

Neu:

- `list_orgs` nennt je Organisation `reachable` (CashCtrl antwortet); der Grund eines Ausfalls steht weiter in `orgName`.
- Die Vorschau der Fachwerkzeuge endet mit dem Firmennamen aus CashCtrl («Organisation: Muster AG (meine-firma)»), in der Antwort zusätzlich als `orgName`. Das kostet je Organisation einmal einen Leseaufruf. `prepare_api_write` ist ausgenommen, weil dessen Vorschau CashCtrl nicht aufruft.
- Das Paket heisst `@iconference/cashctrl-mcp` und ist öffentlich.

Geändert (Verhalten):

- `prepare_article` verlangt `nr`. CashCtrl weist einen Artikel ohne Nummer ab («nr: Dieses Feld darf nicht leer sein.», gemessen 09.11.2026); bis 0.4.0 versprach das Werkzeug eine automatische Nummer.
- `financial_summary`: `openReceivables.count` und `openPayables.count` zählen nur noch Belege mit offenem Betrag. Vorher stand dort die Trefferzahl von CashCtrl, die auch offene Offerten enthält (gemessen: 61 statt 19).
- Voraussetzung ist Node 22.12 oder neuer.

Behoben:

- `financial_summary` zählte je Konto den Betrag ohne Vorzeichen. Ein Konto mit Gegensaldo (gemessen: 6961 Rundungsdifferenzen mit −0.18) verfälschte Aufwand und Gewinn um 0.36, die Bilanz schloss nicht. Jetzt wird mit Vorzeichen summiert; Aktiven minus Passiven ergibt in allen drei Geschäftsjahren des Demo-Mandanten den Gewinn, und der Gewinn stimmt mit `fiscalperiod/result` von CashCtrl überein.
- `get_article` lieferte die Einheit leer, weil `inventory/article/read` nur `unitId` trägt. Der Name kommt jetzt aus `inventory/unit/list`.

Gemessen (09.11.2026, Demo-Mandant):

- `article`, `journal_entry` (ohne und mit Steuercode) und `payment` (Teilzahlung und Restzahlung).
- Vom allgemeinen Schreibweg vier Lösch-Endpunkte: `inventory/article/delete`, `journal/delete`, `person/delete`, `order/bookentry/delete`.
- Die schreibenden Vertragstests löschen, was sie anlegen, und prüfen, dass die Kennzahlen des Mandanten danach dieselben sind.

Tests:

- Die Unit-Suite erreicht das Netz nie (`tests/kein-netz.setup.ts`). 502 Tests.
- Die Vertragstests lesen Mandant und Schlüssel aus der Umgebung (`tests/live/mandant.ts`). Der lesende Vertragstest prüft die Bilanzidentität und vergleicht den Gewinn mit `fiscalperiod/result`, statt feste Zahlen zu erwarten.
- Die Aufnahmen unter `tests/fixtures` tragen keine Telefonnummern mehr; `scripts/schwaerzen.ts` ersetzt sie wie Mailadressen und IBAN.

Abhängigkeiten:

- zod ^4.6.7 (behebt GHSA-mrhx-c7xc-m3w5), vitest ^5.1.0 (nur Entwicklung). `npm audit` ohne Fund.

## 0.4.0 (24.10.2026)

Ziel dieser Fassung: alle CashCtrl-Funktionen im MCP abbilden, mit wenigen allgemeinen Werkzeugen statt 300 einzelner.

Neu:

- `api_catalog` durchsucht den eingebauten Katalog der 376 Endpunkte der CashCtrl-API (Stand 24.10.2026), ohne Netzaufruf.
- `api_read` liest über jeden GET-Endpunkt des Katalogs.
- `prepare_api_write` / `commit_api_write` schreiben über jeden POST-Endpunkt, zweistufig mit Token.
- Die 29 Fachwerkzeuge bleiben der bevorzugte Weg.
- `search_orders` und `search_journal` nehmen `fiscalPeriodId`. CashCtrl liefert ohne Angabe nur das aktuelle Geschäftsjahr, bei Belegen dazu offene früherer Jahre (gemessen 24.10.2026). Die Antwort nennt das Jahr.
- Zwei neue Schalter je Organisation, Standard aus: `salary` (Lohn-Endpunkte lesen und schreiben, Personendaten der Mitarbeitenden) und `deleteRecords` (Löschen jeder Art über `prepare_api_write`). Mail-Endpunkte brauchen den bestehenden Schalter `sendMail`.
- Werkzeugzahlen ohne Schalter: 17 im Modus `read`, 23 in `draft`, 33 in `full`.

Geändert:

- **Die allgemeinen Schreibwege sind experimentell und am Mandanten nicht gemessen.** Sie kennen keine Fachprüfung (Rundung, Steuer, Dubletten).

Behoben:

- `serverInfo.version` kommt jetzt aus `package.json` (stand fest auf 0.2.0).

Gemessen:

- 24.10.2026: `api_read` mit 11 Fällen am Demo-Mandanten (JSON, Text ohne Endung, CSV als Text, Excel und PDF als Datei, Kappung, Schalter und Abweisungen ohne Netzaufruf).
- 24.10.2026 in Claude Desktop (Fassung 0.3.3, Modus `draft`): Claude Desktop zeigt einen eigenen Freigabedialog vor jedem Aufruf, solange die Einstellung «Needs approval» gilt. Wer im Dialog «Always allow» wählt, schaltet ihn für dieses Werkzeug ab. Verlassen Sie sich darum nicht allein auf diesen Dialog: Die Bremse ist die Vorschau mit Token, geschrieben wird erst nach Ihrem Ja.

Tests:

- `tsc` sauber, Suite 486 bestanden (vorher 415), Werkzeugzahlen über stdio gemessen.

## 0.3.3 (23.10.2026)

Abhängigkeiten:

- `@modelcontextprotocol/server` von 2.0.0 auf 2.3.0 (mit `core` 2.3.0). Behebt GHSA-46jr-4wx8-v453, GHSA-jm63-cq47-j5jp und GHSA-rvq5-wwqv-78pq (alle auf der HTTP-Serverseite des SDK; dieser Server läuft über stdio, der Operating Desk nutzt nur die Werkzeugschicht).

Sonst keine Änderung. `tsc` sauber, Suite 415 bestanden / 13 übersprungen wie vor dem Update, Rauchtest über stdio (initialize, tools/list: 15 Werkzeuge im Modus `read`).

Bekannt, nicht geändert: `serverInfo.version` in `src/server.ts` nennt noch 0.2.0.

## 0.3.2 (20.10.2026)

Geändert:

- Der Server liest den Grund einer Ablehnung aus `errorMessage` (ohne Grund: «CashCtrl hat abgewiesen und keinen Grund genannt.»).
- Artikel nennen `currencyId` und `currency`, der Stammpreis gilt in der Währung aus `currencyId`.
- `get_order` rechnet `dueDate` aus Datum und `dueDays`.
- Im Verkauf geht die Steuer des Kontos nur hinaus, wenn sie eine Verkaufssteuer ist (sonst Abweisung mit Konto und Steuer).
- `prepare_contact` prüft Mail und Land nicht mehr vor und sendet die Adresse auch ohne Strasse und Ort. Ob CashCtrl das Land übernommen hat, zeigt `get_contact` (Hauptadresse ohne Land).

## 0.3.1 (17.10.2026)

Neu:

- `list_taxes` nennt je Steuer `sales` (Verkaufssteuer: alle Komponenten `applyRule` REVENUE und `isInputTax` false, gelesen am Demo-Mandanten). Ein Verbraucher kann die Liste damit auf Verkaufssteuern beschränken.

Gemessen:

- CashCtrl nimmt eine Bezugsteuer (BN1) an einer Verkaufsposition still an; der Beleg hat dann einen offenen Betrag, der nicht zum Total passt (gemessen 17.10.2026).

## 0.3.0 (17.10.2026)

Geändert (Verhaltensänderung für Claude Desktop und den Operating Desk):

- **UN1 als Vorgabe fällt; ohne Steuercode gilt die Steuer des Ertragskontos, sonst keine.** Das gilt für `order_create` und `order_draft`, im Verkauf wie im Einkauf (auch VN1 fällt). Der Server liest die Steuer (`taxId`) des Ertragskontos der Position und sendet sie ausdrücklich; CashCtrl setzt über die API ohne `taxId` keine Steuer, auch nicht die des Kontos (gemessen 17.10.2026). Führt das Konto keine, geht die Position ohne Steuer hinaus (MWST 0, brutto = netto); die Vorschau nennt «Steuer vom Konto …» bzw. «ohne Steuer (Konto führt keine)». Ein Aufrufer, der bisher auf die stille Vorgabe UN1 baute, gibt `taxCode` an.
- Ein negatives Total wird nicht mehr abgewiesen (CashCtrl nimmt es an, gemessen 17.10.2026); `structuredContent.reason` hat damit keinen Wert mehr.
- Jede Position muss vor dem Senden `name` und `unitPrice` tragen (CashCtrl verwirft sie sonst still).

Neu:

- Währung: `currency` (Code wie `EUR`) an `order_create` und `order_draft`; neues Lesewerkzeug `list_currencies`; `currencyId` in `get_order` und `search_orders`. Der Kopierweg übernimmt die Währung des Quellbelegs statt sie abzuweisen. Ohne Preis des Menschen gilt der Stammpreis eines Artikels nur, wenn dessen Währung die des Belegs ist.
- Belegnummer: `nr` an `order_create`.
- `notes` an Kontakten (`prepare_contact`, `get_contact`, Suche `notes` in `search_contacts`).
- 29 Werkzeuge im Standard (15 lesend), 31 mit `sendMail`, 33 mit `sendMail` und `deleteOrders`.

## 0.2.4 (14.10.2026)

Neu:

- Lesewerkzeug `get_article`: ein Artikel nach Kennung, gleiche Felder wie `search_articles`. Eine unbekannte Kennung ist `validation` (gemessen am Demo-Mandanten: HTTP 200, `success: false`).
- `list_taxes` nennt je Steuer `inactive` (aus `isInactive`).
- 28 Werkzeuge im Standard (14 lesend), 30 mit `sendMail`, 32 mit `sendMail` und `deleteOrders`.

## 0.2.3 (12.10.2026)

Geändert:

- Die Abweisung eines negativen Totals trägt einen festen Grund (`structuredContent.reason: "negative_total"`), auch wenn ein Stammpreis das Total bestimmt. Aufrufer erkennen sie ohne Textmuster.

## 0.2.2 (12.10.2026)

Behoben:

- Runden exakt wie CashCtrl. Ein Trennlauf am Demo-Mandanten zeigt: CashCtrl rechnet exakt dezimal und rundet halbe Rappen vom Nullpunkt weg (5.405 wird 5.41, 275.655 wird 275.66). 0.2.1 rundete in Float und traf Werte wie 275.655 nicht (275.65); eine Rechnung aus einer solchen Offerte (`copyItemsFromOrderId`) wurde darum abgewiesen. Der Fehler bestand seit 0.1.0 und betrifft auch positive Beträge.

## 0.2.1 (12.10.2026)

Neu:

- Rabattzeilen: `unitPriceNet` darf in `order_draft` und `order_create` negativ sein; ein Beleg mit negativem Total wird abgewiesen, auch im Kopierweg.

Geändert:

- Runden jetzt symmetrisch, halbe Rappen vom Nullpunkt weg wie CashCtrl (am Demo-Mandanten gemessen 12.10.2026: Zeilentotal −16.215 wird −16.22). Das Verhalten ändert sich nur bei negativen Beträgen auf halbe Rappen.

## 0.2.0 (12.10.2026)

Neu:

- 27 Werkzeuge im Standard (13 lesend, 6 auf Stufe `draft`, 8 auf Stufe `full`), 29 mit `sendMail`, 31 mit `sendMail` und `deleteOrders`.
- `prepare_order_create` / `commit_order_create`: Beleg in einem Schreibaufruf mit gewähltem Status, Positionen neu oder wörtlich aus einem Quellbeleg.
- `list_taxes`.
- Strukturierte Fehlerangaben (`kind`, `sent`, `createdId`).
- `notes` in `get_order` und `search_orders`; Status per ID.
- `prepare_delete_order` / `commit_delete_order`, nur mit dem Opt-in `deleteOrders` je Organisation, nur ungebuchte Belege.

Hinweis: Die Antworten von `order/create` bei Erfolg, Zeitüberschreitung, ECONNREFUSED und 5xx und die von `order/delete` sind aus der Doku nachgebaut, am Mandanten nicht gemessen.

## 0.1.0 (28.08.2026)

Vollständig implementiert und gemessen:

- 24 Werkzeuge im Standard (12 lesend, 6 zusätzlich auf Stufe `draft`, 6 zusätzlich auf Stufe `full`), 26 mit dem Opt-in `sendMail` für Belegversand je Organisation (Standard aus).
- Eine Unit-Suite gegen aufgezeichnete Antworten (`npm test`), 13 Vertragstests gegen den Demo-Mandanten, 3 Ende-zu-Ende-Fälle über `claude -p`.

Gemessen:

- Die Live-Messung vom 28.08.2026 trifft die Kontrollzahlen des Mandanten.
