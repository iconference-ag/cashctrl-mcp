# Sicherheit

Dieser Server liest und schreibt in eine Buchhaltung. Eine Lücke melden Sie bitte per Mail an
[info@iconference.ch](mailto:info@iconference.ch), Betreff «cashctrl-mcp Sicherheit», und nicht als öffentliches
Issue. Schreiben Sie dazu, welche Fassung betroffen ist und wie sich das Verhalten zeigt. Einen Schlüssel oder
echte Buchhaltungsdaten brauchen wir dafür nicht, schicken Sie bitte keine mit.

Als Lücke gilt insbesondere:

- Der Schlüssel oder ein Teil davon erscheint in einer Werkzeugausgabe, einer Fehlermeldung oder einem Log.
- Ein Werkzeug oberhalb des gesetzten Modus ist erreichbar.
- Ein Schreibaufruf geht ohne gültiges Token aus `prepare_*` an CashCtrl.
- Ein Schalter je Organisation (`sendMail`, `deleteOrders`, `deleteRecords`, `salary`) lässt sich umgehen.
- Der Server ruft einen Pfad auf, der nicht im eingebauten Katalog steht.

Gepflegt wird die jeweils neuste Fassung auf npm.

Das Sicherheitsmodell steht im [README](README.md#sicherheitsmodell). Der Riegel, der nicht auf Ihrem Rechner
liegt, ist die Rolle des API-Benutzers in CashCtrl: Geben Sie ihm nur die Rechte, die Ihre Stufe braucht.
