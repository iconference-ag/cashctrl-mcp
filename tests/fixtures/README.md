# Fixtures — der Feldnamen-Vertrag

Aufgenommen am 28.08.2026 vom Demo-Mandanten **Nothing Toulouse** (eine erfundene Firma mit
erfundenen Geschäftsdaten) mit `scripts/record-fixtures.ts`, ausschliesslich lesend
(`list` / `read` / `tree`).

**Diese Dateien sind die Quelle für Feldnamen.** Wer in den Tasks 7–17 einen Feldnamen
braucht, liest ihn hier ab und rät ihn nicht. Weicht die API später ab, wird neu aufgenommen
und diese Tabelle nachgezogen — nicht der Code an eine Vermutung angepasst.

Neu aufnehmen:

```bash
CASHCTRL_LIVE=1 CASHCTRL_LIVE_SUBDOMAIN=… CASHCTRL_LIVE_API_KEY=… npx tsx scripts/record-fixtures.ts
```

Ein Lauf kostet 24 Aufrufe vom Monatskontingent (30'000). Der Schlüssel kommt aus der
Umgebung (oder mit `CASHCTRL_LIVE_KEYCHAIN` aus der macOS-Keychain) und erscheint in keiner Datei.

## Schwärzung

Die Logik steht in `scripts/schwaerzen.ts` (Export `schwaerzen(v)`, importiert von
`record-fixtures.ts`; Direktaufruf `npx tsx scripts/schwaerzen.ts` schwärzt bestehende
Fixtures erneut, idempotent). Vor dem Schreiben ersetzt sie Werte:

| Regel | Ersatzwert | Betroffene Feldnamen in dieser Aufnahme |
|---|---|---|
| jeder Feldname, der auf `iban` endet (unabhängig von Gross-/Kleinschreibung), dazu `apiKey`, `password`, `ssn` | `GESCHWAERZT` | `iban`, `qrIban`, `orgIban`, `orgQrIban` |
| `createdBy` / `lastUpdatedBy`, wenn der Wert mit `API:` beginnt | `API:GESCHWAERZT` | 72 Vorkommen |
| jeder String-Wert, der wie eine Mailadresse aussieht — ganz oder als Fundstelle innerhalb eines längeren Strings (z.B. `mailTo` mit mehreren Adressen, ein Footer-Text) —, unabhängig vom Feldnamen | `geschwaerzt@example.com` | `emailWork` (`person/list`, `person/read`), `contacts[].address` bei `EMAIL_*` (`person/read`), `email` und `footer` (`location/list`), `mailTo` (`order/document/read`) |
| jede Telefonnummer in internationaler Schreibweise (`+41 …`), als Feldwert oder innerhalb eines Texts (seit 0.5.0) | `+41 00 000 00 00` | `phoneMain` und `footer` (`location/list`) |

Der zweite Fall ist kein Schönheitsfehler: der Name eines CashCtrl-API-Benutzers ist **gleich
den ersten vier Zeichen seines Schlüssels** (gemessen 27.08.2026). Ungeschwärzt stünde ein
Schlüsselfragment im Repo.

Der dritte Fall ist ein nachträglicher Entscheid (28.08.2026): Nothing Toulouse ist reine
Demo, keine Mailadresse aus dem Mandanten gehört ins öffentliche Repo, unabhängig davon,
ob sie fiktiv oder echt ist. Dasselbe gilt seit 0.5.0 für Telefonnummern: auch eine erfundene
Nummer kann einem echten Anschluss gehören.

Nicht geschwärzt und bewusst so: `bic`, `qrReference`, `iso11649Reference`, postalische
Adressen, Firmennamen. Der Mandant enthält nur erfundene Demo-Daten (das Bankkonto sagt das
in seinem eigenen `notes`-Feld).

## Aufbau der Antworten

Zwei Hüllen, je nach Endpunkt-Art:

| Art | Hülle | Nutzlast |
|---|---|---|
| `…/list`, `…/tree` | `{ total, data, summary, properties }` | `data` ist ein **Array** |
| `…/read` | `{ success, data }` | `data` ist ein **Objekt** |

- `…/read` liefert **kein** `total`, `…/list` liefert **kein** `success`.
- `summary` war in allen 20 Aufnahmen `null`, `properties` ein leeres Objekt.
- `total` ist die Gesamtzahl im Mandanten, nicht die Zahl der gelieferten Zeilen:
  `person/list` mit `limit: 5` meldet `total: 20` und liefert 5.
- **Ausnahme `account/category/tree`:** `total` ist `0`, obwohl `data` fünf Wurzelknoten
  enthält. Bei `tree` ist `total` nicht verwendbar.
- Leere Treffermenge (`person/list` mit `query: 'Muster'`): `total: 0`, `data: []` — kein Fehler.

## Mehrsprachige Werte

Viele Namensfelder tragen keinen String, sondern ein XML-Fragment:

```
<values><de>Stk.</de><en>pcs.</en><fr>pcs.</fr><it>pz.</it></values>
```

Gemessen über alle 20 Fixtures: 571 solcher Werte in 15 verschiedenen Feldern
(`name`, `categoryDisplay`, `categoryName`, `nameSingular`, `namePlural`, `statusName`,
`unitName`, `accountName`, `debitName`, `creditName`, `account`, `description`,
`documentName`, `layoutName`, `message`).

Eine `de()`-Funktion (Task 7) muss drei Fälle vertragen — alle drei kommen in dieser
Aufnahme vor:

| Fall | Anzahl | Beispiel |
|---|---|---|
| reines Fragment | 560 | `unitName` von Einheit 4: `<values><de>Stk.</de>…</values>` |
| Fragment **mit Präfix davor** | 11 | `creditName`: `1020 <values><de>Bank</de>…</values>` — nur in `accountName`, `debitName`, `creditName` |
| gar kein Fragment, einfacher String | Rest | `unitName` von Einheit 1001: `m²`; `person.name`: `Aare Energie GmbH` |

Sprachsätze: 551 Werte mit `de+en+fr+it`, 20 mit nur `de+en` (Layout-Namen). **Kein Wert
ohne `<de>`.** Trotzdem darf `de()` das nicht voraussetzen und muss bei fehlendem `<de>`
oder fehlendem Fragment den Eingabewert unverändert zurückgeben.

## Dateien

| Datei | Aufruf | Inhalt |
|---|---|---|
| `person-list-limit-5.json` | `person/list` `limit=5` | 5 von 20 |
| `person-list-query-Muster-limit-5.json` | `person/list` `query=Muster` | leere Treffermenge |
| `person-read.json` | `person/read` `id=7` | Firma mit `contacts`/`addresses`; `notes` fehlt, weil leer (M-5, 17.10.2026: gesetzt liefert `person/read` das Feld `notes`) |
| `currency-list.json` | `currency/list` | **nicht von `record-fixtures.ts` aufgenommen**, sondern aus dem Messbericht M-K (16.10.2026, A5) abgeschrieben: CHF 1 (Standard), EUR 2, USD 3 mit `isDefault`, `isAuto`, `rate` |
| `inventory-article-list-limit-5.json` | `inventory/article/list` `limit=5` | 5 von 10 |
| `inventory-unit-list.json` | `inventory/unit/list` | 7 Einheiten |
| `order-category-list-type-SALES.json` | `order/category/list` `type=SALES` | 6 Kategorien inkl. `status[]` |
| `order-category-list-type-PURCHASE.json` | `order/category/list` `type=PURCHASE` | 6 Kategorien inkl. `status[]` |
| `order-category-read.json` | `order/category/read` `id=2` | Offerte, Einzelobjekt |
| `order-list-type-SALES-limit-5.json` | `order/list` `type=SALES` `limit=5` | 5 von 27 |
| `order-list-type-SALES-onlyOpen-true-limit-5.json` | dito + `onlyOpen=true` | 5 von **17** |
| `order-list-type-PURCHASE-limit-5.json` | `order/list` `type=PURCHASE` `limit=5` | 5 von 11, **gebuchte Rechnungen** |
| `order-read.json` | `order/read` `id=55` | Offerte mit 2 Positionen |
| `order-document-read.json` | `order/document/read` `id=55` | Belegkopf, Absender/Empfänger |
| `journal-list-limit-5.json` | `journal/list` `limit=5` | 5 von 128 |
| `account-list.json` | `account/list` | alle 140 |
| `account-category-tree.json` | `account/category/tree` | 5 Wurzeln, verschachtelt |
| `fiscalperiod-list.json` | `fiscalperiod/list` | 1 Periode |
| `location-list.json` | `location/list` | 1 Standort |
| `account-bank-list.json` | `account/bank/list` | 1 Bankkonto |
| `tax-list.json` | `tax/list` | 20 Steuercodes |

## Feldnamen

Alle Beispielwerte stammen aus dem jeweils ersten Datensatz der genannten Datei.

### `person/list`

| Zweck | Feld | Beispiel | Typ |
|---|---|---|---|
| ID | `id` | `7` | number |
| Nummer | `nr` | `"000011"` | string — **nicht** `number` |
| Anzeigename | `name` | `"Aare Energie GmbH"` | string, nie mehrsprachig |
| Firma | `company` | `"Aare Energie GmbH"` | string \| null |
| Vorname | `firstName` | `null` (bei Firmen) | string \| null |
| Nachname | `lastName` | `null` (bei Firmen) | string \| null |
| Ort | `city` | `"Bern"` | string \| null |
| Rolle Kunde | `isCustomer` / `customer` | `true` | boolean, **beide Felder vorhanden, gleicher Wert** |
| Rolle Lieferant | `isVendor` / `vendor` | `false` | boolean |
| Rolle Angestellter | `isEmployee` / `employee` | `false` | boolean |
| Kategorie | `categoryId`, `categoryName` | `1`, `<values><de>Kunden</de>…` | number, mehrsprachig |
| aktiv/inaktiv | `isInactive` / `inactive` | `false` | boolean |

Weiter vorhanden und brauchbar: `emailWork` (geschwärzt), `address`, `zip`, `canton`, `country`,
`countryName`, `language`, `vatUid`, `iban` (geschwärzt), `bic`.

**Abweichung von der Notiz im Spec-Anhang:** dort steht «`person/list` liefert keine Mail im
Listenfeld». In dieser Aufnahme ist `emailWork` in `person/list` gefüllt
(`"geschwaerzt@example.com"`). Was in `person/list` **fehlt**, ist die Liste `contacts` — die
hängt nur an `person/read`. Wer alle Kontaktkanäle braucht, muss `read` aufrufen; für die
Arbeitsmail reicht `list`.

### `person/read` (zusätzlich zu den Listenfeldern)

| Zweck | Feld | Beispiel |
|---|---|---|
| Kontaktkanäle | `contacts[]` | `{ id, personId, type: "EMAIL_WORK", purpose, address, notes, pos }` |
| Adressen | `addresses[]` | `{ id, type: "MAIN", address, zip, city, canton, country, streetName, streetNumber, … }` |
| weitere Listen | `bankAccounts[]`, `servicePeriods[]`, `children[]`, `insuranceContracts[]`, `attachments[]` | in dieser Aufnahme alle leer |

Die Mailadresse steht im Kontakt unter `address`, nicht unter `email`.

### `inventory/article/list`

| Zweck | Feld | Beispiel | Typ |
|---|---|---|---|
| ID | `id` | `1` | number |
| Nummer | `nr` | `"A-01"` | string |
| Name | `name` | `"Pflanzwand-Modul 60x60 cm"` | string, nicht mehrsprachig |
| Einheit | `unitId` + `unitName` | `4` + `<values><de>Stk.</de>…` | **number** + mehrsprachig-oder-String |
| Verkaufspreis | `salesPrice` | `480` | number, **netto** (`isSalesPriceGross: false`) |
| Einkaufspreis | `lastPurchasePrice` | `265` | number — ein Feld `purchasePrice` gibt es **nicht** |
| Bestand | `stock` | `24` | number \| null |
| Art | `type` | `"ARTICLE"` | string |
| Lagerartikel | `isStockArticle` | `true` | boolean |

Weiter vorhanden: `description`, `minStock`, `maxStock`, `currencyCode`, `salesAccountId`,
`purchaseAccountId`, `isPurchasePriceGross`, `isInactive`.

### `inventory/unit/list`

| Zweck | Feld | Beispiel |
|---|---|---|
| ID | `id` | `4` |
| Name | `name` | `<values><de>Stk.</de>…` bei den 5 System-Einheiten, **einfacher String** bei selbst angelegten (`1001` → `"m²"`, `1002` → `"Mt."`) |

Stück heisst «Stk.» **mit Punkt**, ID 4.

### `order/list`

| Zweck | Feld | Beispiel | Typ |
|---|---|---|---|
| ID | `id` | `55` | number |
| Nummer | `nr` | `"AN-00012"` | string |
| Datum | `date` | `"2026-07-10 00:00:00.0"` | string, `YYYY-MM-DD HH:mm:ss.S` — kein ISO-8601, kein `T`, keine Zeitzone |
| Fälligkeit | `dateDue` | `"2026-07-24 00:00:00.0"` | string \| null |
| Kategorie | `categoryId` | `2` | number |
| Kategoriename | `nameSingular` / `namePlural` | `<values><de>Offerte</de>…` | mehrsprachig — ein Feld `categoryName` gibt es in `list` **nicht**, nur in `read` |
| Status | `statusId` + `statusName` | `37` + `<values><de>Offen</de>…` | number + mehrsprachig |
| Kontaktname | `associateName` (+ `associateId`) | `"Winterthur Maschinen AG"` | string |
| Total | `total` | `213875.85` | number, brutto |
| Netto / Steuer | `subTotal`, `tax` | `197850`, `16025.85` | number |
| Offener Betrag | `open` (+ `groupOpen`) | siehe unten | number \| **null** |
| Währung | `currencyCode` | `"CHF"` | string |
| Art | `type`, `bookType` | `"SALES"`, `"DEBIT"` | string |
| abgeschlossen | `isClosed` | `false` | boolean |

**`open` ist nicht immer gefüllt.** In `order-list-type-SALES-limit-5.json` ist `open` bei
allen fünf Zeilen `null` — es sind Offerten und Auftragsbestätigungen, also Belege aus
Kategorien, deren Status nicht bucht (`isBook: false`). Gefüllt ist `open` erst bei
gebuchten Belegen: in `order-list-type-PURCHASE-limit-5.json` steht bei Status «Offen»
(78) `open: 2659.25`, bei Status «Bezahlt» (76) `open: 0`. Ein Werkzeug, das den offenen
Betrag zeigt, muss `null` als «nicht anwendbar» behandeln, nicht als 0.

**`onlyOpen: true` wirkt, aber nicht auf die ersten Zeilen.** Ohne den Parameter meldet
`order/list` `total: 27`, mit ihm `total: 17`; die fünf gelieferten Zeilen sind in beiden
Aufnahmen dieselben, weil sie ohnehin offen sind. Wer die Wirkung prüfen will, prüft
`total`, nicht `data`.

Im aufgenommenen SALES-Ausschnitt gibt es **keine gebuchte Verkaufsrechnung** (die Liste ist
nach ID absteigend sortiert, oben liegen die zuletzt erzeugten Offerten). Beispielwerte für
gebuchte Belege daher aus der PURCHASE-Datei nehmen.

### `order/read` — Kopf

Zusätzlich zu den Listenfeldern: `items[]`, `categoryName` (mehrsprachig), `taxType`,
`totalToPay`, `defaultCurrencyTotal`, `roundingDifference`, `paid`, `due`, `hash`,
`attachments[]`, `dateDeliveryStart` / `dateDeliveryEnd`.

Zwei Fallen im Kopf:

- `paid` ist **kein** bezahlter Betrag im erwarteten Sinn: beim ungebuchten Beleg 55 steht
  `paid: 213875.85` bei `open: null`. Für «wie viel ist noch offen» ist `open` das Feld.
- `currencyCode` ist in `order/read` `null` (Standardwährung), in `order/list` derselben
  Belege `"CHF"`. Wer die Währung anzeigt, braucht einen Rückfall auf die Mandantenwährung.

### `order/read` — Positionen (`data.items[]`)

| Zweck | Feld | Beispiel | Typ |
|---|---|---|---|
| Artikelnummer | `articleNr` | `"A-02"` | string |
| Artikel-ID | `inventoryId` | `2` | number \| null |
| Name | `name` | `"Pflanzwand-Modul 120x60 cm"` | string |
| Beschreibung | `description` | `"Modulare Living-Wall-Kassette …"` | string \| null |
| Menge | `quantity` | `205` | number |
| Stückpreis | `unitPrice` | `962.09` | number — **brutto** |
| Stückpreis netto | `netUnitPrice` | `890` | number |
| Steuercode | `taxCode` (+ `taxId`) | `"UN1"` (+ `9`) | string + number |
| Steuersatz | `taxRate` | `8.1` | number |
| Total brutto | `grossTotal` | `197228.45` | number |
| Total netto | `netTotal` | `182450` | number |
| Steuerbetrag | `taxTotal` | `14778.45` | number |
| Einheit | `unitId` + `unitName` | `"4"` + `<values>…` | **`unitId` ist hier ein String**, in `inventory/article/list` eine number |
| Reihenfolge | `pos` | `0` | number, nullbasiert |
| Rabatt | `discountPercentage` | `null` | number \| null |
| Art | `type` | `"ARTICLE"` | string |

`unitPrice` ist der Bruttopreis — das ist die am 27.08.2026 gemessene Falle, hier bestätigt:
Artikel A-02 hat `salesPrice: 890` (netto), die Position `unitPrice: 962.09` bei `taxRate: 8.1`.

### `order/category/read` und `order/category/list` — Statusliste

Beide Endpunkte liefern die Statusliste. **`order/category/list` enthält `status[]`
bereits vollständig**, ein zusätzliches `read` je Kategorie ist dafür nicht nötig.

Statuseintrag (`data.status[]` bzw. `data[].status[]`):

| Zweck | Feld | Beispiel |
|---|---|---|
| ID | `id` | `18` |
| Name | `name` | `<values><de>Bezahlt</de>…` — mehrsprachig |
| bucht ins Journal | `isBook` / `book` | `true` |
| schliesst den Beleg | `isClosed` / `closed` | `true` |
| Farbe | `icon` | `"GRAY"` \| `"BLUE"` \| `"GREEN"` \| `"RED"` \| `"YELLOW"` |
| Reihenfolge | `pos` | `4` |
| Folgeaktion | `actionId` | `""`, `"CATEGORY_3"`, `"BOOK_TEMPLATE_3"`, `"CREATE_PAYMENT_ORDER"` |

**Ein Kennzeichen «bezahlt» gibt es nicht.** Maschinell lesbar sind nur `isBook` und
`isClosed`; «Entwurf», «Offen», «Bezahlt», «Storniert» sind Namen. Wer «bezahlt» braucht,
muss die Status-ID der Kategorie kennen. Gemessen im Mandanten:

| Kategorie | ID | Entwurf | Offen | Bezahlt | Storniert |
|---|---|---|---|---|---|
| Rechnung (SALES) | 4 | 12 | 16 | **18** | 17 |
| Rechnung (PURCHASE) | 15 | — (Standard ist «Offen») | 78 | **76** | 79 |
| Gutschrift (SALES) | 8 | — | 58 | 50 | 60 |

Kategorie-Kopffelder: `id`, `nameSingular`, `namePlural`, `type` (`SALES`/`PURCHASE`),
`bookType` (`DEBIT`/`CREDIT`), `defaultStatusId`, `sequenceNrId`, `layoutId`, `dueDays`,
`accountId`, `status[]`, `bookTemplates[]`.

Vorhandene Kategorien: SALES 2 Offerte, 3 Auftragsbestätigung, 6 Lieferschein,
4 Rechnung, 9 Zahlungserinnerung, 8 Gutschrift · PURCHASE 12 Anfrage, 13 Bestellung,
14 Wareneingang, 15 Rechnung, 16 Gutschrift, 17 Retourschein.

### `order/document/read`

| Zweck | Feld | Beispiel |
|---|---|---|
| Beleg | `orderId`, `nr`, `categoryId` | `55`, `"AN-00012"`, `2` |
| Absender | `orgLocationId`, `orgAddress`, `orgIban` (geschwärzt), `orgQrIban` (geschwärzt), `orgBic` | `1`, `"Nothing-Toulouse AG\nDemoweg 12\n6300 Zug"` |
| Bankkonto | `orgBankAccountId` | `1` |
| Empfänger | `recipientAddressId`, `recipientAddress`, `recipientIban`, `recipientBic` | `10`, `"Winterthur Maschinen AG\n…"` |
| Referenz | `qrReference`, `iso11649Reference`, `generatedReference`, `customReference` | `"000000000000000000255000121"` |
| Versand | `mailTo` (geschwärzt), `mailSubject`, `mailText`, `sentStatusId` | `"geschwaerzt@example.com"` |
| Layout | `layoutId`, `templateId`, `language`, `header`, `footer` | `1`, `1`, `"DE"` |

Das sind die Felder, die ein `order/document/update` mitschicken muss (Spec-Anhang:
Standort und Bankkonto hängen nur so am Beleg).

### PDF: `order/document/read.pdf`

**Gemessen 28.08.2026: `order/document/read.pdf?id=55` liefert `application/pdf`,
29'468 Bytes, die ersten fünf Bytes sind `%PDF-`.** Die Annahme 2 in Spec Abschnitt 12
(«`order/document/read` liefert das PDF binär») trifft zu. `CashCtrlHttp.getBinary()`
prüft den Content-Type und ist der richtige Weg. Das PDF wird nicht als Fixture abgelegt.

### `account/list`

| Zweck | Feld | Beispiel | Typ |
|---|---|---|---|
| ID | `id` | `1` | number |
| Nummer | `number` | `"1000"` | string — **`number`, nicht `nr`** |
| Name | `name` | `<values><de>Kasse</de>…` | mehrsprachig |
| Kategorie | `categoryId` + `categoryDisplay` | `51` + `<values><de>Flüssige Mittel</de>…` | number + mehrsprachig (ein Feld `categoryName` gibt es hier nicht) |
| Endsaldo | `endAmount` | `2500` | number |
| Anfangssaldo | `openingAmount` | `2500` | number |
| Klasse | `accountClass` | `"ASSET"` | string |
| Währung | `currencyCode` | `"CHF"` | string |
| Steuercode | `taxId`, `taxCode` | `null`, `null` | number \| null |
| Bankkonto? | `isBankAccount` | `false` | boolean |

`endAmount` und `defaultCurrencyEndAmount` sind bei Standardwährung identisch.
Ein Feld `balance` gibt es **nicht**.

### `account/category/tree`

Verschachtelte Knoten, Kinder im Feld **`data`** (nicht `children`):

| Zweck | Feld | Beispiel |
|---|---|---|
| ID / Vater | `id`, `parentId` | `50`, `1` |
| Nummer | `number` | `"10"` |
| Name | `name` | `"Aktiven"` (Wurzel, einfacher String) bzw. `<values><de>Umlaufvermögen</de>…` |
| Name aufgelöst | `text` | `"Umlaufvermögen"` — bereits deutsch, ohne XML |
| Kinder | `data` | Array \| `null` |
| Blatt? | `leaf` | `false` |

`text` ist der bequeme Weg an den deutschen Namen; `name` braucht `de()`.

### `fiscalperiod/list`

| Zweck | Feld | Beispiel | Typ |
|---|---|---|---|
| ID | `id` | `1` | number |
| Name | `name` | `"2026"` | string |
| Start | `start` | `"2026-01-01 00:00:00.0"` | string |
| Ende | `end` | `"2026-12-31 23:59:59.0"` | string |
| aktuell | `isCurrent` / `current` | `true` | boolean |
| abgeschlossen | `isClosed` / `closed` | `false` | boolean |

Weiter: `shortName`, `lastEntryDate`, `openMonthIds[]`, `closedMonthIds[]`,
`availableMonthIds[]` (jeweils `"2026-01"`-Strings) und die Salär-Gegenstücke.

### `tax/list`

| Zweck | Feld | Beispiel | Typ |
|---|---|---|---|
| ID | `id` | `1` | number |
| Name | **existiert nicht** — stattdessen `code` und `description` | `"BN1"`, `<values><de>Bezugsteuer mit Vorsteuer Normalsatz</de>…` | string, mehrsprachig |
| Kurzname für den Beleg | `documentName` | `<values><de>Bezugsteuer</de>…` | mehrsprachig |
| Satz | `currentPercentage` | `8.1` | number |
| Sätze mit Gültigkeit | `rates[]` | `{ id, dateValid, percentage, percentageFlat }` | Array |
| Konten | `accountDisplay` | `"2200, 1170"` | string |
| Komponenten | `components[]` | `{ id, accountId, code, calcType, applyRule, pos, isInputTax }` | Array |
| aktiv | `isInactive` | `false` | boolean |

Ein Feld `percentage` auf oberster Ebene gibt es **nicht**; der aktuelle Satz ist
`currentPercentage`, die Historie steht in `rates[]`. `calcType` (`NET`/`GROSS`) sitzt in
`components[]`, nicht am Steuercode selbst.

### `location/list`

| Zweck | Feld | Beispiel |
|---|---|---|
| ID | `id` | `1` |
| Name | `name` | `"Hauptsitz Zug"` (einfacher String) |
| Art | `type` | `"MAIN"` |
| Firmenname | `orgName` | `"Nothing-Toulouse AG"` |
| Adresse | `address`, `zip`, `city`, `canton`, `country`, `fullAddress` | `"Demoweg 12"`, `"6300"`, `"Zug"` |
| MWST-Nummer | `vatUid` | `"CHE-123.456.789 MWST"` |
| Bankkonto | `bankAccountId`, `iban` (geschwärzt), `qrIban` (geschwärzt), `bic` | `1` |

### `account/bank/list`

| Zweck | Feld | Beispiel |
|---|---|---|
| ID | `id` | `1` |
| Name | `name` | `"Zuger Seeblick Privatbank – Kontokorrent CHF"` (einfacher String) |
| IBAN | `iban` | `"GESCHWAERZT"` |
| QR-IBAN | `qrIban` | `"GESCHWAERZT"` |
| BIC | `bic` | `"ZSPBCH2ZXXX"` (nicht geschwärzt, fiktiv) |
| Konto | `accountId` + `accountName` | `3` + `"1020 <values><de>Bank</de>…"` — **Präfix vor dem Fragment** |
| Saldo | `endAmount`, `openingAmount` | `494472.2`, `185000` |
| Währung | `currencyCode` | `"CHF"` |

### `journal/list`

| Zweck | Feld | Beispiel |
|---|---|---|
| ID | `id` | `139` |
| Datum | `dateAdded` | `"2026-08-28 00:00:00.0"` |
| Soll | `debitId` + `debitName` | `19` + `"5700 <values><de>Sozialleistungen</de>…"` |
| Haben | `creditId` + `creditName` | `3` + `"1020 <values><de>Bank</de>…"` |
| Betrag | `amount` | `2100` |
| Text | `title` | `"Pensionskasse BVG und UVG/KTG August 2026"` |
| Beleg | `reference` | `"74"` |
| Gegenpartei | `associateId` + `associateName` | `2` + `"Demo-Versicherung (BVG, UVG, KTG)"` |
| Steuer | `taxId`, `taxCode`, `taxRate` | `null` |
| Art | `type` | `"MANUAL"` |
| Herkunftsbeleg | `orderId`, `orderBookEntryId` | `null` |

`debitName` / `creditName` tragen Kontonummer **und** Fragment in einem String.

## Offene Punkte für die späteren Tasks

1. Kein gebuchter Verkaufsbeleg im aufgenommenen SALES-Ausschnitt. Wer `open`, `paid` oder
   den Status «Bezahlt» an einer Verkaufsrechnung testen will, nimmt die Kategorie 4 gezielt
   auf (`order/list` mit `categoryId: 4`) oder nutzt die PURCHASE-Datei.
2. `person/list` mit `query` ist nur gegen einen Nicht-Treffer gemessen. Die Feldform eines
   Treffers ist dieselbe wie ohne `query` (`total`/`data`), die Sortierung ist ungeprüft.
3. `summary` war überall `null`. Ob CashCtrl das Feld bei anderen Endpunkten füllt, ist
   nicht gemessen.
4. Paginierung: `account/list` lieferte ohne `limit` alle 140 Zeilen. Ob es eine
   serverseitige Obergrenze gibt, ist nicht gemessen.

## Nachgebaute Antworten (v0.2.0, 12.10.2026)

Diese Antworten gibt es **nicht** als Aufnahme. Sie sind im Test gebaut
(`tests/unit/order-create.test.ts`, `tests/unit/fehlerart.test.ts`), **aus der Doku nachgebaut, am
Mandanten nicht gemessen (12.10.2026)**:

| Antwort | Nachbau |
|---|---|
| `order/create` Erfolg | `{ "success": true, "insertId": 99 }` |
| `order/create` ohne `insertId` | `{ "success": true }` (Ausgang unklar) |
| `order/create` und andere POST bei Zeitüberschreitung | `fetchImpl` wirft einen Fehler mit `name` `AbortError`/`TimeoutError` |
| Verbindung nicht zustande gekommen | `fetchImpl` wirft einen Fehler mit `code` `ECONNREFUSED` (auch `ENOTFOUND`, `EAI_AGAIN`; bei undici steht der Code in `cause.code`, beide Orte sind getestet) |
| HTTP 5xx | Antwort mit Status 502, leerer Body |
| `order/document/update` abgelehnt | `{ "success": false, "errors": [{ "field": "header", "message": "…" }] }` |
| Artikel mit Stammpreis | `inventory/article/read` mit `salesPrice` und `isSalesPriceGross` (Feldnamen aus `inventory-article-list-limit-5.json`; ein brutto geführter Artikel ist im Test gebaut, in den Fixtures ist keiner) |
| Beleg mit `notes`/`custom` | `order-read.json` mit gesetzten Feldern (in der Aufnahme beide `null`) |
| Filter `notes` in `order/list` | Filterfeld `notes` ist angenommen (Doku-Muster wie `date`), nicht gemessen |
| Filter `previousId` in `order/list` | Filterfeld `previousId` mit `eq` ist angenommen (Doku-Muster wie `date`), nicht gemessen; ob CashCtrl ein unbekanntes Filterfeld übergeht oder ablehnt, ebenso |
