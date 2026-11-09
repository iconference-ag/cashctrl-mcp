# cashctrl-mcp

Deutsche Fassung: [README.md](README.md)

**Unofficial MCP server for CashCtrl.** Built by iConference AG, Zug, Switzerland. It does not come
from CashCtrl AG and is neither published nor supported by them.

The server lets an AI assistant (Claude Desktop first) into a CashCtrl ledger under control.
Reading is free, writing only at an explicitly configured level and only after a preview and a
confirmation. It runs locally on your machine, the API key never leaves it, nothing is hosted.

## Status

Version 0.5.0 of 9 November 2026. What changed in each version is in the [changelog](CHANGELOG.md) (German).

"Measured" in this document means: run against a real CashCtrl ledger and the result read back in
CashCtrl. What is only tested against recorded responses is listed as unverified under
[Development](#development).

## Where the code comes from

This server is the accounting connection of the
[Operating Desk](https://iconference.ch/ki-produkte/operating-desk/en/datasheet-en) of iConference AG. The Desk
runs the processes of a business and connects mail, file storage, contracts and ERP for that. It creates offers and
invoices in CashCtrl through the same tool layer that runs here as an MCP server. The same rule applies to the Desk
as to this server: the AI prepares, a human checks and confirms, and only then is anything written.

The connection is also useful without the Desk. Anyone who runs CashCtrl and works with Claude can use it to
query their ledger and prepare documents.

## Security model

Five barriers, in this order:

1. **Mode.** `read`, `draft` or `full`, default `read`. Tools above the mode
   are never registered, so the model does not see them. No tool changes the mode. Switching means editing
   the configuration and restarting the client.
2. **Two-step writing.** Every write consists of `prepare_*` and `commit_*`.
   `prepare_*` validates, calculates, warns about duplicates and returns a readable summary plus a
   one-time token. The token lives 10 minutes, in memory only, is bound to kind, organisation and the
   validated input, and dies with the process. `commit_*` without a valid token fails. The summary of the
   specialised tools ends with the company name from CashCtrl ("Organisation: Muster AG (meine-firma)"), so that you see
   which ledger is being written to.
3. **No deletion without an explicit switch per organisation, and then only unbooked documents.**
   Off by default, even at `full`. Deleting is the only irreversible class. With the opt-in
   `deleteOrders`, `prepare_delete_order` / `commit_delete_order` deletes an unbooked document,
   such as an offer or a draft invoice; the server refuses booked documents and documents whose
   booking state is unclear. Any other deletion stays with the human in the CashCtrl user
   interface.
4. **General tools: their own switches for deleting, payroll and mail.** `api_read` and
   `prepare_api_write` / `commit_api_write` reach every endpoint of the CashCtrl API, but only through
   the built-in catalogue (an unknown path, the wrong method, missing required parameters and unknown
   parameters are refused by the server before it calls CashCtrl). Three classes additionally need a
   switch on the organisation addressed, off by default: **deleting** (any POST to `/delete.json`)
   needs `deleteRecords`, **payroll** (any path under `salary/`, read or write; it is personal data
   of employees) needs `salary`, **mail** (paths ending in `/mail.json`) needs `sendMail`. An endpoint
   that touches two classes (`salary/…/delete.json`) needs both switches.
   The switches are checked in `prepare` and in `commit`. These paths are **experimental**: measured on the
   tenant are only four delete endpoints (see [Development](#development)), and they bypass
   the specialised checks of the dedicated tools (for example the unbooked-documents-only rule of `delete_order`).
5. **Role of the API user.** In CashCtrl the API user gets the role that matches the level.
   This is the one barrier on CashCtrl's server; all others sit on your machine.

On top of that: the key never appears in tool output, error messages or logs. A local monthly
counter warns at 80 percent of the quota and refuses further calls at 100 percent, so CashCtrl
does not lock the account.

## Installation

Requires Node 22.12 or newer.

The server starts without installation through `npx`:

```bash
npx -y @iconference/cashctrl-mcp
```

It speaks MCP over standard input and output and waits for a client. In Claude Desktop the
entry looks like this:

```json
{
  "mcpServers": {
    "cashctrl": { "command": "npx", "args": ["-y", "@iconference/cashctrl-mcp"] }
  }
}
```

From source:

```bash
git clone https://github.com/iconference-ag/cashctrl-mcp.git
cd cashctrl-mcp
npm install
npm run build
```

`dist/index.js` is then the server.

## Creating an API user in CashCtrl

In CashCtrl under **Settings, Users & Roles, Add API user**. An API user belongs to exactly one
organisation and holds the rights of the role you assign. Give it the role that matches your
level: a read-only role for `read`. Note the key down, CashCtrl shows it only once.

## Configuration

File `~/.config/cashctrl-mcp/config.json`, mode 0600 (`chmod 600`). Wider permissions produce a
warning in the log.

```json
{
  "mode": "read",
  "pdfDir": "~/Downloads/cashctrl-mcp",
  "orgs": [
    { "name": "meine-firma", "subdomain": "meinefirma", "apiKey": "…" }
  ]
}
```

- `name` is how you address the organisation in conversation. It is also used as a directory name
  for stored PDF files, so it may only contain letters, digits, dot, low line (_) and hyphen. No
  umlauts, no spaces.
- `subdomain` is the part before `.cashctrl.com` in your CashCtrl address.
- `sendMail` (optional, default `false`) enables sending documents (`prepare_send_order` /
  `commit_send_order`) for this organisation. Even in mode `full` the two tools stay
  invisible without this switch. See "Moving up to `draft` or `full`" below.
- `deleteOrders` (optional, default `false`) enables deleting unbooked documents
  (`prepare_delete_order` / `commit_delete_order`) for this organisation, likewise only in
  mode `full`.
- `salary` (optional, default `false`) enables the payroll endpoints of the general tools
  (`api_read` on `salary/…`, `prepare_api_write` on `salary/…`). This is personal data of employees.
- `deleteRecords` (optional, default `false`) enables deletion through `prepare_api_write`
  (paths ending in `/delete.json`), in mode `full`. It does not replace `deleteOrders` and does not relax its
  unbooked-documents-only rule: `delete_order` stays the safe route for documents.
- Mail endpoints of the general tools (paths ending in `/mail.json`) need the existing switch `sendMail`.
- Several organisations are supported (fiduciaries). With exactly one, the `org` parameter is
  optional on every tool.

A single-organisation setup also works without a file, through
`CASHCTRL_SUBDOMAIN`, `CASHCTRL_API_KEY`, `CASHCTRL_MODE`, `CASHCTRL_PDF_DIR` and
`CASHCTRL_SEND_MAIL` (`1` enables sending documents, otherwise it stays off) and
`CASHCTRL_DELETE_ORDERS` (`1` enables deleting unbooked documents, otherwise it stays off),
`CASHCTRL_SALARY` (`1` enables the payroll endpoints) and `CASHCTRL_DELETE_RECORDS` (`1` enables general
deletion). Either the file or the environment variables: setting both is a startup error with a clear message.

The entry in Claude Desktop is described step by step in
[`docs/anleitung-claude-desktop.md`](docs/anleitung-claude-desktop.md) (German).

## Moving up to `draft` or `full`

The default is `read`. Anyone who wants to write does two things:

1. Set `"mode": "draft"` (or `"full"`) in the configuration and restart the client. Only then are
   the `prepare_*` and `commit_*` tools visible at all.
2. Widen the role of the API user in CashCtrl to allow writing. Without it CashCtrl answers 403,
   and the server reports "Rolle des API-Benutzers erlaubt das nicht" (the role of the API user does not permit this).

The two steps are separate on purpose. Anyone who only raises the mode still cannot write
anything, and anyone who only widens the role does not see the tools.

`full` adds actions that touch money and the outside world: record a payment, post a journal
entry, set a document status, send a document by mail. The mail send is the only action that
leaves the machine. It therefore additionally needs the opt-in `sendMail` per organisation,
off by default. Without it `prepare_send_order`/`commit_send_order` stay invisible even in mode `full`:
set `"sendMail": true` on the organisation in the configuration (or
`CASHCTRL_SEND_MAIL=1`) and restart the client. The same holds for deleting unbooked
documents with the opt-in `deleteOrders` (or `CASHCTRL_DELETE_ORDERS=1`). Deleting, payroll and mail through the
general tools need their own switches (`deleteRecords`, `salary`, `sendMail`), also
off by default; the tools `prepare_api_write` / `commit_api_write` are visible in mode `full`, and the
switches only open the respective class of endpoints.

## Tools

33 tools by default (mode `full`), 2 more each with the opt-in `sendMail` (sending documents) and the opt-in
`deleteOrders` (deleting unbooked documents), 37 with both. The switches `salary` and `deleteRecords` do not
change the count (they open endpoints of the general tools). In mode `read` there are 17 tools, in `draft` 23.
Each takes an optional `org`; with exactly one organisation the parameter can be omitted.

### Level `read` (17)

| Tool | Purpose |
|---|---|
| `list_orgs` | configured organisations with the company name of the main location, the active mode and `reachable` (CashCtrl answers) |
| `usage` | mode, monthly consumption against the limit of 30,000 requests |
| `list_fiscal_periods` | fiscal years with start, end, current, closed |
| `list_taxes` | tax codes with ID, name, rate and `inactive` |
| `list_currencies` | currencies with ID, code and the flag of the default currency |
| `search_contacts` | search customers, vendors, employees, also by note (`notes`) |
| `get_contact` | one contact with addresses, contact channels and note |
| `search_articles` | article master data with unit, sales and purchase price, stock |
| `get_article` | one article by ID: number, name, unit, sales price (maintained net or gross), account |
| `search_orders` | documents by category, status, contact, date, notes, predecessor, full text; fiscal year with `fiscalPeriodId` (without it: only the current one, plus open documents of earlier years) |
| `get_order` | one document with IDs, notes, items, net, gross, tax, totals |
| `get_order_pdf` | stores the document PDF locally and returns the path |
| `search_journal` | journal entries in a date range; fiscal year with `fiscalPeriodId` (without it: only the current one) |
| `list_accounts` | chart of accounts with closing balance |
| `financial_summary` | assets, liabilities, revenue, expenses, profit, open receivables and payables (only documents with an open amount) |
| `api_catalog` | searches the built-in catalogue of the CashCtrl API (376 endpoints) by path and parameters, no network call |
| `api_read` | reads through any GET endpoint of the catalogue (measured live on 24 October 2026 (11 cases on the demo tenant: JSON, text without extension, CSV as text, Excel and PDF as files, truncation, switches and rejections without a network call)); payroll only with `salary` |

### Level `draft` (6 more)

| Tool pair | Purpose |
|---|---|
| `prepare_contact` / `commit_contact` | create a contact (also with a note, `notes`), the preview warns about similar contacts |
| `prepare_article` / `commit_article` | create an article; the article number is required (without it CashCtrl rejects the article, measured 9 November 2026), the unit is resolved and never created anew |
| `prepare_order_draft` / `commit_order_draft` | create an offer, order confirmation, invoice or purchase invoice **as a draft** |

### Level `full` (10 more, plus 2 further each with the opt-ins `sendMail` and `deleteOrders`)

| Tool pair | Purpose |
|---|---|
| `prepare_order_create` / `commit_order_create` | create an offer, order confirmation or invoice in one write call with a chosen status (an invoice with status "Open" is booked at once) |
| `prepare_order_status` / `commit_order_status` | set the document status, for example offer accepted, by name or status ID |
| `prepare_payment` / `commit_payment` | record a payment and set the document to paid |
| `prepare_journal_entry` / `commit_journal_entry` | manual journal entry with debit and credit account |
| `prepare_send_order` / `commit_send_order` | send a document through the CashCtrl document mailer, only with `sendMail` (see Configuration) |
| `prepare_delete_order` / `commit_delete_order` | delete an unbooked document for good, only with `deleteOrders`; the server refuses booked documents, also when they were booked between preview and execution |
| `prepare_api_write` / `commit_api_write` | writes through any POST endpoint of the catalogue (experimental, measured on the tenant are only four delete endpoints); deleting only with `deleteRecords`, payroll only with `salary`, mail only with `sendMail` |

### General tools (0.4.0, experimental)

`api_catalog`, `api_read` and `prepare_api_write` / `commit_api_write` cover all 376 endpoints of the CashCtrl API
(API documentation as of 24 October 2026: 184 read, 192 write, of which 45 delete and 90 in the payroll area). The catalogue
ships inside the package and needs no network at run time. **Specialised tools first:** where one exists (`search_contacts`,
`get_order`, `prepare_order_create` …) the model uses it, because it checks rounding, tax and duplicates. The general
route is for the rest.

- `api_catalog` with `query` (words in path or title, English) and `area` (first path segment, such as `person`,
  `order`, `salary`) returns at most 100 hits with `kind` (`read`, `write`, `delete`) and, where needed, `gate`
  (`salary`, `deleteRecords`, `sendMail`; `gates` when there are several). With `path` it returns the full entry with all
  parameters (required, type, and for JSON parameters the fields of their elements).
- `api_read` checks before every call: path in the catalogue, method GET, payroll only with `salary`, required parameters
  present, known parameters only. Responses over 60,000 characters are cut off; page with `limit` and `start`. Files
  (PDF, Excel, CSV, ZIP) are stored by the server in the PDF folder like `get_order_pdf`; the response gives `file`, `bytes`
  and `contentType`.
- `prepare_api_write` checks the same for POST endpoints and shows title, path, organisation and every field as
  `name = value` (each value cut to 200 characters). It does not call CashCtrl and therefore names only the name from
  the configuration, not the company name. `commit_api_write` checks the switches
  again and sends exactly one POST with the validated input. The preview always warns: "Allgemeiner Schreibweg: keine
  Fachprüfung des Servers (Rundung, Steuer, Dubletten), am Mandanten nicht gemessen." (general write path: no specialised
  check by the server for rounding, tax and duplicates, not measured on the tenant). For deletion, "Löschen ist
  unumkehrbar." (deleting is irreversible) is added.
- For CSV parameters (`ids`, `orderIds` …) the model may pass a list; the server joins it with commas.

On failure the response carries `structuredContent` next to the text: `kind` (type of error),
for write calls `sent` (the request may have reached CashCtrl; `true` when in doubt), after
creation `createdId`, and for a fixed cause `reason` (currently no value in use;
`negative_total` was dropped in 0.3.0). Once a `commit_*` has sent a write call to CashCtrl, every later error
carries `sent: true`. With `sent: true` or `createdId` a caller must never create again
automatically. The server only retries 429 responses, never a POST after a network error.

You give prices **net** everywhere (exceptions: `order_create` with `copyItemsFromOrderId` copies gross prices
verbatim, and a gross-maintained article master price is sent verbatim as the gross price). CashCtrl stores the gross
unit price per item internally; the server converts this, and the model sees none of it. A discount line takes a negative
net price; CashCtrl keeps it as an item with a negative gross price (measured 12 October 2026).

Tax per item: a given `taxCode` applies exactly; without it the tax of the item's revenue account applies (first
`accountNumber` of the item, then the revenue account of the article, then `defaultAccountNumber`); if the account carries none, the
item goes out without tax, gross = net. The currency of the document is set by `currency` (a code, see `list_currencies`); without it
the currency of the tenant applies; CashCtrl sets exchange rates itself.

## Limits

- **Quota:** 30,000 requests per month, a burst of 300 refilled at 30 per second
  (CashCtrl terms, clause 6). The server waits by itself instead of running into a 429, counts locally,
  warns at 80 percent and stops at 100 percent. One tool can cost several calls:
  `prepare_order_draft` needs four plus one per article line. The first preview of a specialised tool
  reads the company name once per organisation (one call).
- **The month rolls over in UTC.** The counter resets at 00:00 UTC and ignores
  local midnight; in Switzerland that is the 1st at 01:00 (winter time) or 02:00 (summer time).
- **Chart of accounts, fiscal years and tax codes come in full.** `list_accounts`,
  `list_fiscal_periods` and `list_taxes` return all entries at once, without paging; CashCtrl has no
  limit there. All other lists show at most 200 entries and report `hasMore`.
- **Chart of accounts:** `financial_summary` classifies by the first digit of the account number
  (1 assets, 2 liabilities, 3 revenue, 4 to 8 expenses). That is the Swiss SME chart of accounts
  and an assumption. Anyone who keeps a different chart of accounts gets wrong totals here.
- **Organisation name** without umlauts and spaces, because it serves as a directory name for PDF files.
- **Open amount:** for documents whose status does not post to the journal (offer,
  order confirmation), `open` is `null` and not `0`. Such documents do not count towards open items.
- **Sent status:** which status a document gets after the mail send is defined by the category in
  CashCtrl (`sentStatusId`), not by the server. If the category knows none, the status stays
  and the server says so in a warning.
- **Negative total:** allowed. CashCtrl accepted a document with total −100 on the demo tenant (17 October 2026); since 0.3.0 the server
  no longer rejects it. Whether that is a credit note in accounting terms is for the human to decide.
- **Not included as specialised tools:** deletion other than unbooked documents with `deleteOrders`, payroll, fixed assets, closing
  or reopening a fiscal year, report endpoints, imports, file storage, settings. Since 0.4.0 they are reachable through the
  general tools (experimental; only four delete endpoints are measured on the tenant, see
  [Development](#development)), deleting only with `deleteRecords`, payroll only
  with `salary`. `file/empty_archive.json` (empties the file archive for good) also counts as deleting. Closing and reopening a fiscal year
  have no switch of their own: anyone who sets `full` and does not restrict the write rights of the role in CashCtrl allows
  them.
- **No webhooks.** CashCtrl offers none, changes are only visible by asking.

## Development

```bash
npm run build       # TypeScript to dist/
npm test            # unit suite against recorded responses, without network
npm run typecheck   # src, tests and scripts
```

The unit suite never reaches the network: `tests/kein-netz.setup.ts` replaces `fetch` with a block, and a test
that gets there without a stand-in fails.

Contract tests against a real tenant run only with the variables set and are skipped otherwise. Tenant
and key come from the environment, never from a file in the repository (`tests/live/mandant.ts`):

```bash
export CASHCTRL_LIVE_SUBDOMAIN=meinefirma        # the part before .cashctrl.com
export CASHCTRL_LIVE_API_KEY=…                   # or CASHCTRL_LIVE_KEYCHAIN=<service name in the macOS keychain>
CASHCTRL_LIVE=1 npx vitest run tests/live/read.live.test.ts                                # read only
CASHCTRL_LIVE=1 CASHCTRL_LIVE_WRITE=1 npx vitest run tests/live/write.live.test.ts         # contact, offer, status
CASHCTRL_LIVE=1 CASHCTRL_LIVE_WRITE=1 npx vitest run tests/live/schreibwege.live.test.ts   # article, journal entry, payment
bash scripts/e2e.sh                                                                        # three cases through claude -p
```

The writing runs create real records prefixed `MCP-TEST` and delete them again at the end. They
check that the tenant's key figures are the same afterwards as before. If the clean-up fails, the
identifiers appear in the log and have to be removed by hand in CashCtrl. The runs assume a tenant with the
Swiss SME chart of accounts; the assumptions are stated at the top of the test files.

**Measured on the tenant** are the write paths `contact`, `order_draft` and `order_status` (28 August 2026),
`order_create` and `delete_order` (12 October 2026) and `article`, `journal_entry` and `payment` with partial and
final payment (9 November 2026). **`send_order` is unverified:** our demo tenant does not allow sending documents, the
tool runs only under unit tests against recorded responses. Anyone who uses it checks the result in
CashCtrl.

Of the general write path (`prepare_api_write` / `commit_api_write`) four delete endpoints are measured
(`inventory/article/delete`, `journal/delete`, `person/delete`, `order/bookentry/delete`, 9 November 2026). All
other endpoints of this path are **experimental and not measured on the tenant**. `api_read` was measured on 24 October 2026
(11 cases: JSON, text without extension, CSV as text, Excel and PDF as files, truncation, switches and
rejections without a network call).

The field names of the CashCtrl responses are recorded in [`tests/fixtures/README.md`](tests/fixtures/README.md) (German).
Anyone who needs a field name reads it there. Measured quirks of the interface are in
[`docs/cashctrl-api-eigenheiten.md`](docs/cashctrl-api-eigenheiten.md) (German).

## Contact

iConference AG, Grafenaustrasse 15, 6300 Zug, Switzerland.
[info@iconference.ch](mailto:info@iconference.ch) · [iconference.ch](https://iconference.ch)

Questions about the server and error reports belong in the issues of this repository. Anyone who wants to know how the
[Operating Desk](https://iconference.ch/ki-produkte/operating-desk/en/datasheet-en) runs processes and writes to
the ledger can book an [initial consultation](https://iconference.ch/#erstgespraech) or write to us.

## Licence

MIT, see [`LICENSE`](LICENSE).
