# CashCtrl-API: gemessene Eigenheiten

Alles hier ist an einem Demo-Mandanten mit erfundenen Daten gemessen oder an der API-Doku gelesen, je Punkt mit Datum. «Gemessen» heisst: gegen den Mandanten gelaufen und das Ergebnis in CashCtrl nachgelesen; «aus der Doku gelesen» ist am Mandanten nicht geprüft. CashCtrl kann sein Verhalten ändern.

## Allgemein

- Ohne `.json` antwortet jeder Endpunkt 404 als HTML, auch mit Query-Parametern (gemessen 27.08.2026).
- Mehrere Parameter sind Komma-Listen (CSV) und keine JSON-Arrays: `ids` (`order/update_status`), `orderIds` (`order/bookentry/create`, `order/document/mail`) und `associateId` (`order/create`). Serialisiert ein Client ein Array als Formularfeld, entsteht `[7,8]` statt `7,8` (aus der Doku gelesen 28.08.2026).
- `journal/delete`, `person/delete` und `inventory/article/delete` nehmen `ids` als Komma-Liste und antworten mit `success: true` und der Zahl der gelöschten Einträge (gemessen 09.11.2026).
- `order/list` und `journal/list` liefern ohne `fiscalPeriodId` nur das aktuelle Geschäftsjahr, bei Belegen dazu offene früherer Jahre (gemessen 24.10.2026).
- Ablehnung beim Lesen: `order/read`, `person/read` und `inventory/article/read` mit unbekannter Kennung antworten mit HTTP 200 und `{"success":false,"errorMessage":"…","data":null}`. Der Wortlaut ohne `lang` ist englisch («This document does not exist.», «This person does not exist.», «This article does not exist.»), mit `lang=de` deutsch («Dieses Dokument existiert nicht.»). `Accept-Language` wirkt nicht, `lang=fr` antwortet englisch (gemessen 20.10.2026).

## Kontakte

- `person/list` liefert `emailWork` gefüllt. Was in der Liste fehlt, ist die Liste `contacts[]` mit allen Kanälen; sie hängt nur an `person/read`. Für die Arbeitsmail genügt `list` (gemessen 28.08.2026, Korrektur einer früheren Aussage vom 27.08.2026).
- `person/create` nimmt `notes` an, `person/read` liefert es (Feld `notes`; ist es leer, fehlt es im Objekt). `person/list` findet den Kontakt über `query` und über einen Filter `notes like` (Filter `[{ comparison: "like", field: "notes", value }]`) (gemessen 17.10.2026).
- `notes` mit Sonderzeichen speichert CashCtrl HTML-maskiert (`&` wird `&amp;`). `query` und `filter notes like` mit dem wörtlichen Wert finden den Kontakt dann nicht. Wer in `notes` einen eigenen Suchschlüssel ablegt, bildet ihn darum nur aus A-Z, a-z, 0-9 und `-_:.` (gemessen 17.10.2026).
- `person/create` mit `isCustomer: true` ergibt einen Kunden (`person/read`: `isCustomer` und `customer` true) (gemessen 17.10.2026).
- Mail: `person/create` nimmt eine Umlaut-Domain an und speichert sie lesbar (`info@müller-holz.ch`). Ein Leerzeichen am Ende entfernt CashCtrl. Ohne Endung (`info@neukunde`) oder mit Leerzeichen innen antwortet CashCtrl mit `success: false` und `errors: [{ field: null, message: "Contact #1: Address: Invalid format. Please enter as follows: john@doe.com" }]` (gemessen 20.10.2026).
- Land: `CHE` und `CH` werden angenommen, gespeichert wird `CHE`; ohne Land bleibt es `null` (gemessen 17.10.2026). «Schweiz» und «ch» werden zu CHE, «Deutschland» zu DEU. «XYZ» wird angenommen, die Adresse aber ohne Land gespeichert (`country` null). Ob das Land übernommen ist, liest der Aufrufer am angelegten Kontakt (`get_contact`); `commit_contact` liest seit 20.10.2026 nicht mehr nach, weil ein zweites Lesen im Schreib-Zeitlimit des Aufrufers lag (gemessen 20.10.2026).
- Adresse ohne Strasse und Ort: Nur Land (CHE) oder nur PLZ wird angenommen und so gespeichert; PLZ mit «Schweiz» ergibt PLZ und CHE. Nur «XYZ» wird angenommen, danach fehlt die Adresse ganz. Seit 0.3.2 geht die Adresse mit, sobald Strasse, PLZ, Ort oder Land gesetzt ist (vorher nur mit Strasse oder Ort). Fehlt nach dem Anlegen die Adresse ganz, ist das gesendete Land nicht übernommen (gemessen 20.10.2026).
- `person/delete` löscht einen Kontakt; danach antwortet `person/read` mit «This person does not exist.» (gemessen 20.10.2026 und 09.11.2026).

## Artikel

- Einheiten heissen mit Punkt («Stk.»). Ein `unit/create` mit «Stk» legt still ein Duplikat an (gemessen 27.08.2026).
- Die Artikel des Demo-Mandanten tragen kein `salesAccountId` (gemessen 28.08.2026).
- `inventory/article/create` ohne `nr`: HTTP 200, `success: false`, «nr: Dieses Feld darf nicht leer sein.», obwohl die API-Doku `nr` als optional führt. Gemessen ohne `categoryId` und ohne `sequenceNumberId`; ob `sequenceNumberId` eine Nummer erzeugt, ist nicht gemessen (gemessen 09.11.2026).
- `inventory/article/read` liefert `unitId`, aber kein `unitName`; `inventory/article/list` liefert beides (gemessen 09.11.2026).

## Belege

- `unitPrice` in `order/create` ist der **Bruttopreis**; Netto × (1 + Satz/100) übergeben (gemessen 27.08.2026). Es gibt kein Nettofeld: `unitPriceNet` statt `unitPrice` ergibt «Position #1: Stückpreis: Dieses Feld darf nicht leer sein.» (gemessen 17.10.2026).
- Standort und Bankkonto hängen nur per `order/document/update` (mit `orgLocationId`, `orgBankAccountId`; vorher `order/document/read` und `layoutId`/`language`/`header`/`footer` mitschicken) am Beleg. Sonst erscheint «Adresse wählen» und der QR-Teil hat eine leere IBAN (gemessen 27.08.2026).
- Abgeglichen mit einem Referenz-Client am 28.08.2026: `order/create` sendet zusätzlich `nr` (Belegnummer) und `roundingId`. `order/document/update` sendet zusätzlich `isDisplayItemGross` und `recipientAddressId`, sonst gehen diese Werte beim Update verloren.
- Eine Position in `order/create` (`items`) braucht `accountId`, `name` und `unitPrice` als Pflichtfelder; `type` ist optional, Standard `ARTICLE`, Werte `ARTICLE`, `TEXT`, `PAGEBREAK`, `SUBTOTAL`, `TITLE`, `OPTIONTOTAL` (aus der Doku gelesen 28.08.2026).
- Ertragskonto je Position: `accountId` an der Position ist Pflicht und kommt aus `accountNumber` der Position, sonst dem Ertrags- oder Aufwandkonto des Artikels, sonst `defaultAccountNumber` am Beleg. Ohne `defaultAccountNumber` gibt es keinen Beleg, weil die Artikel des Demo-Mandanten kein `salesAccountId` tragen. `accountId` der Kategorie (`cat.accountId`) ist das Debitoren- oder Kreditorenkonto der Kategorie (bei der Offerte 1100 Debitoren) und taugt nicht als Konto der Position (gemessen 28.08.2026).
- Belegtotal: CashCtrl rechnet Σ (`quantity` × `unitPrice`), also über den Brutto-Stückpreis je Position. Nettototal mal Satz kommt dabei nicht vor. Bestätigt an zwei Belegen: 205 × 962.09 + 70 × 237.82 = 213'875.85 (aufgezeichneter Beleg) und 2 × 518.88 + 1 × 1.8701 = 1039.63 (angelegte Offerte) (gemessen 28.08.2026).
- Rundung vierstelliger Bruttopreise: Der Server übergibt `unitPrice` auf vier Dezimalen. Eine Position mit 1.73 netto zu UN1 8.1 % ergibt 1.8701 brutto. CashCtrl speichert diesen Wert und meldet ihn unverändert zurück, das Zeilentotal auf zwei Dezimalen als 1.87. `netUnitPrice` rechnet CashCtrl aus dem gespeicherten Brutto zurück und meldet 1.72997225 statt der eingegebenen 1.73; der Nettopreis ist ein abgeleiteter Wert. Wer einen exakten Nettopreis auf dem Beleg braucht, wählt einen, dessen Bruttowert mit vier Dezimalen aufgeht (480 netto ergibt 518.88 brutto und 480 zurück, exakt) (gemessen 28.08.2026).
- Eine Position ohne `unitPrice` oder `name`: `order/create` antwortet 200 mit `success: true`, der Beleg hat aber keine Positionen (`items` leer, Total 0). CashCtrl lässt die Position still weg (gemessen 17.10.2026).
- Negatives Total: Positionen 100 und −200 werden angenommen, Total −100 (gemessen 17.10.2026).
- Rabattzeile: Eine Position mit negativem Preis führt CashCtrl als Position mit negativem Bruttopreis (gemessen 12.10.2026).
- Rundung auf Rappen: CashCtrl rechnet exakt dezimal und rundet halbe Rappen vom Nullpunkt weg (5.405 wird 5.41, 275.655 wird 275.66, ein Zeilentotal von −16.215 wird −16.22). Wer in Gleitkommazahlen rundet, trifft Werte wie 275.655 nicht, und eine Rechnung aus einer solchen Offerte wird abgewiesen (gemessen 12.10.2026).
- Belegnummer: `order/create` (Rechnung) mit `nr` übernimmt die Nummer. Dieselbe `nr` ein zweites Mal: HTTP 200, `success: false`, `errors: [{ field: "nr", message: "Die Nr. wird schon von einem anderen Dokument verwendet." }]`. Es wird nichts angelegt (gemessen 17.10.2026).
- `order/read` liefert an einer Offerte kein `dateDue` (nur `dueDays`), `order/list` schon (gemessen 17.10.2026).
- Eine Rechnung, die mit Status «Offen» angelegt wird, ist sofort gebucht (`open` gleich Total) (gemessen 09.11.2026).
- `order/list` mit `onlyOpen` liefert auch offene Offerten; ihr `open` ist `null` (gemessen 09.11.2026).

## Zahlungen

- `order/bookentry/create` setzt den Status nicht; den Status setzt danach `order/update_status` (gemessen 27.08.2026). Der Parameter heisst `orderIds` (Komma-Liste) (abgeglichen mit einem Referenz-Client 28.08.2026).
- Teilzahlung über `order/bookentry/create`: `open` sinkt um den Betrag, der Status bleibt. Nach der Restzahlung ist `open` 0; den Status «Bezahlt» setzt der Aufrufer selbst (gemessen 09.11.2026).
- `order/bookentry/list` (Parameter `id` = Beleg) liefert die Buchung der Rechnung selbst mit `type: GENERATED` und jede Zahlung mit `type: MANUAL` (gemessen 09.11.2026).
- `order/bookentry/delete` mit einer `GENERATED`-Kennung in `ids` weist den ganzen Aufruf ab («Diese Buchung kann nicht direkt gelöscht werden.»); auch die mitgegebenen `MANUAL`-Kennungen bleiben stehen. Nur `MANUAL` löschen. Die erzeugte Buchung verschwindet, wenn der Beleg auf einen Status wechselt, der nicht bucht (Entwurf) (gemessen 09.11.2026).
- Eine bezahlte Rechnung restlos abbauen: Zahlungen löschen, Status auf Entwurf, `order/delete`. Die Kontensalden sind danach dieselben wie vorher (gemessen 09.11.2026).

## Journal

- `journal/create` kennt `sequenceNumberId` und `associateId` (bei Belegen mit Gegenpartei, zum Beispiel Fixkosten). Beides ist optional (abgeglichen mit einem Referenz-Client 28.08.2026).
- `journal/create` ohne `sequenceNumberId` wird angenommen (gemessen 09.11.2026).
- `journal/create` mit `taxId` (UN1, 8.1 %) und `amount` 108.10: `amount` bleibt 108.10, der Erfolg steigt um 100.00. Der Betrag ist also brutto (gemessen 09.11.2026).

## Steuern

- CashCtrl übernimmt über die API die Steuer des Kontos nicht. Eine Position mit `accountId` und `unitPrice` 480 ohne `taxId` ergibt `taxId` `null`, MWST 0 und Total 480, auch wenn das Konto 3400 die Steuer UN1 führt (`account/update` mit `taxId`, `account/read` bestätigt sie). Die Steuer muss ausdrücklich gesendet werden (gemessen 17.10.2026).
- `tax/list` liefert je Steuer `components[]` mit `applyRule` und `isInputTax` (kein Feld `type`). Verkauf: alle Komponenten REVENUE/false (UN1, UR1, US1, U0A, U0B, U0E, SS1, SS2). Vorsteuer und Zoll: EXPENSE/true. Bezugsteuer: CREDIT (BN1; BR1 dazu DEBIT/true) (am Demo-Mandanten gelesen 17.10.2026).
- Bezugsteuer an einer Verkaufsposition: CashCtrl nimmt BN1 an einer Rechnungsposition an, zählt die Steuer ins `total`, bucht sie aber nicht auf den Debitor (`open` ist um den Steuerbetrag kleiner als `total`). Mit UN1 ist `open` gleich `total` (gemessen 17.10.2026).

## Währungen

- `currency/list` liefert CHF (Hauptwährung, `isDefault`), EUR und USD mit den Feldern `id`, `code`, `rate`, `isDefault`, `isAuto`. Die Hauptwährung heisst am Beleg `currencyId: null`; ein EUR-Beleg trägt die Kennung von EUR (gemessen 16.10.2026).

## Konten und Kennzahlen

- `fiscalperiod/result` liefert das Ergebnis eines Geschäftsjahres als blosse Zahl, ohne JSON-Hülle. Es stimmt mit Ertrag minus Aufwand aus `account/list` überein, wenn die Salden mit Vorzeichen summiert werden (gemessen 09.11.2026 an drei Geschäftsjahren).
- `account/list`: `endAmount` kommt je Kontenklasse als positiver Betrag. Ein negativer Wert ist ein Gegensaldo (gemessen: Aufwandkonto 6961 Rundungsdifferenzen mit −0.18). Wer je Konto den Betrag ohne Vorzeichen nimmt, verfehlt die Bilanzidentität (gemessen 09.11.2026).
- Wer ein Konto per API ändert und zurücksetzt, bekommt es nicht byte-gleich zurück: Nach `account/update` mit leerem `taxId` und erneutem Lesen weichen `name` und `fullName` des Kontos in der Reihenfolge der Sprachelemente ab (vorher `de, en, fr, it`, nachher `de, en, it, fr`). Der Inhalt ist gleich (gemessen 17.10.2026).

## Mailversand

Der Belegversand lässt sich am Demo-Mandanten nicht messen, CashCtrl verweigert ihn dort. Die Parameter von `order/document/mail` sind aus der Doku gelesen; Absender und Versandstatus sind an den Standorten und Kategorien des Mandanten gelesen.

- `order/document/mail`: Pflicht sind `orderIds` (CSV), `mailFrom`, `mailSubject`, `mailText`; optional `mailTo` (leer = Standardadresse des Kontakts), `mailCc`, `mailBcc`, `isCopyToMe`, `sentStatusId`. Es gibt kein `id` und kein `subject`/`message` (aus der Doku gelesen 28.08.2026).
- Absender: `mailFrom` ist Pflicht. Der Server nimmt als Standard die `email` des Standorts vom `type` `MAIN` aus `location/list`, mit dem ersten Standort als Rückfall; `from` an `prepare_send_order` überschreibt ihn (gemessen 28.08.2026).
- Versandstatus: Welchen Status ein Beleg nach `order/document/mail` bekommt, steht im Kategorie-Kopf als `sentStatusId` und nicht in `status[]` (Offerte: «Offen», Zahlungserinnerung: «Versandt»). Der Server fällt zurück auf die Statusnamen «Versandt», dann «Gesendet»; kennt die Kategorie keinen, bleibt der Status stehen und der Server warnt (gemessen 28.08.2026).
