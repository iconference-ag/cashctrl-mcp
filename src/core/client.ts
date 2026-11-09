import type { CashCtrlHttp } from './http.js';

export type Rec = Record<string, unknown>;
export interface ListResult { data: Rec[]; total: number }
export type OrderType = 'SALES' | 'PURCHASE';
type Raw = { data?: Rec[]; total?: number } & Rec;

function list(r: Raw): ListResult { return { data: r.data ?? [], total: r.total ?? (r.data?.length ?? 0) }; }
function rows(r: Raw | Rec[]): Rec[] { return Array.isArray(r) ? r : (r.data ?? []); }
// CashCtrl verlangt bei ids/orderIds/associateId eine Komma-Liste (CSV), kein JSON-Array — encodeForm wuerde sonst [7,8] senden.
const csv = (ids: number[]) => ids.join(',');

export class CashCtrlClient {
  constructor(readonly http: CashCtrlHttp) {}

  listPersons(p: { query?: string; onlyCustomers?: boolean; onlyVendors?: boolean; onlyEmployees?: boolean; limit?: number; start?: number; filter?: unknown }) {
    return this.http.get<Raw>('person/list', p).then(list);
  }
  readPerson(id: number) { return this.http.get<{ data: Rec }>('person/read', { id }).then((r) => r.data); }
  listArticles(p: { query?: string; limit?: number; start?: number }) { return this.http.get<Raw>('inventory/article/list', p).then(list); }
  // Ein Artikel ueber seine ID: `inventory/article/list` mit `query` ist eine Volltextsuche
  // und trifft die ID nicht, `read` schon.
  readArticle(id: number) { return this.http.get<{ data: Rec }>('inventory/article/read', { id }).then((r) => r.data); }
  listUnits() { return this.http.get<Raw>('inventory/unit/list').then(rows); }
  // Feldnamen der Statusliste (order/category/list und /read) laut tests/fixtures/README.md.
  listOrderCategories(type: OrderType) { return this.http.get<Raw>('order/category/list', { type }).then(rows); }
  readOrderCategory(id: number) { return this.http.get<{ data: Rec }>('order/category/read', { id }).then((r) => r.data); }
  // Datumsfilter: order/list filtert ueber das Feld `date` (tests/fixtures/README.md, Abschnitt order/list).
  listOrders(p: { type: OrderType; categoryId?: number; statusId?: number; personId?: number; onlyOpen?: boolean; query?: string; fiscalPeriodId?: number; limit?: number; start?: number; filter?: unknown }) {
    return this.http.get<Raw>('order/list', p).then(list);
  }
  readOrder(id: number) { return this.http.get<{ data: Rec }>('order/read', { id }).then((r) => r.data); }
  readOrderDocument(id: number) { return this.http.get<{ data: Rec }>('order/document/read', { id }).then((r) => r.data); }
  readOrderPdf(id: number) { return this.http.getBinary('order/document/read.pdf', { id }); }
  // Datumsfilter: journal/list filtert ueber das Feld `dateAdded` (tests/fixtures/README.md, Abschnitt journal/list).
  listJournal(p: { accountId?: number; fiscalPeriodId?: number; query?: string; limit?: number; start?: number; filter?: unknown }) {
    return this.http.get<Raw>('journal/list', p).then(list);
  }
  listAccounts(p: { fiscalPeriodId?: number; categoryId?: number; query?: string } = {}) { return this.http.get<Raw>('account/list', p).then(rows); }
  listFiscalPeriods() { return this.http.get<Raw>('fiscalperiod/list').then(rows); }
  listLocations() { return this.http.get<Raw>('location/list').then(rows); }
  listBankAccounts() { return this.http.get<Raw>('account/bank/list').then(rows); }
  listTaxes() { return this.http.get<Raw>('tax/list').then(rows); }
  // currency/list: Felder id, code, rate, isDefault, isAuto (gemessen 16.10.2026, Messbericht M-K A5).
  listCurrencies() { return this.http.get<Raw>('currency/list').then(rows); }

  createPerson(d: { company?: string; firstName?: string; lastName?: string; nr?: string; notes?: string; categoryId?: number; isCustomer?: boolean; isVendor?: boolean; isEmployee?: boolean; addresses?: unknown[]; contacts?: unknown[]; language?: string }) {
    return this.http.post<Created>('person/create', d);
  }
  createArticle(d: { nr?: string; name: string; unitId?: number; salesPrice?: number; lastPurchasePrice?: number; description?: string }) {
    return this.http.post<Created>('inventory/article/create', d);
  }
  createOrder(d: { categoryId: number; associateId: number; date: string; nr?: string; dueDays?: number; statusId?: number; previousId?: number; currencyId?: number; description?: string; notes?: string; language?: string; roundingId?: number; items: OrderItemInput[] }) {
    return this.http.post<Created>('order/create', { ...d, associateId: String(d.associateId) });
  }
  updateOrderDocument(d: { id: number; orgLocationId?: number; orgBankAccountId?: number; layoutId?: number; language?: string; header?: string; footer?: string; isDisplayItemGross?: boolean; recipientAddressId?: number }) {
    return this.http.post('order/document/update', d);
  }
  mailOrderDocument(d: { orderIds: number[]; mailFrom: string; mailSubject: string; mailText: string; mailTo?: string; mailCc?: string; mailBcc?: string; isCopyToMe?: boolean; sentStatusId?: number }) {
    return this.http.post('order/document/mail', { ...d, orderIds: csv(d.orderIds) });
  }
  /** Loescht endgueltig (Doku: order/delete, Parameter ids; Antwort am Mandanten nicht gemessen). Nur ueber delete_order. */
  deleteOrders(ids: number[]) { return this.http.post('order/delete', { ids: csv(ids) }); }
  updateOrderStatus(d: { ids: number[]; statusId: number }) { return this.http.post('order/update_status', { ids: csv(d.ids), statusId: d.statusId }); }
  createOrderBookEntry(d: { orderIds: number[]; accountId: number; amount?: number; date?: string; description?: string; reference?: string; taxId?: number }) {
    return this.http.post('order/bookentry/create', { ...d, orderIds: csv(d.orderIds) });
  }
  // Allgemeine Wege (0.4.0, api_read/api_write). Der Pfad kommt aus dem Katalog und ist vorher geprueft;
  // `apiGet`/`apiPost` ohne Endung (die HTTP-Schicht haengt `.json` an), `apiGetRaw` mit der Endung des Katalogpfads.
  apiGet(endpoint: string, params?: Record<string, unknown>) { return this.http.get<unknown>(endpoint, params); }
  apiGetRaw(endpointWithExt: string, params?: Record<string, unknown>) { return this.http.getRaw(endpointWithExt, params); }
  apiPost(endpoint: string, data: Record<string, unknown>) { return this.http.post<unknown>(endpoint, data); }
  createJournalEntry(d: { dateAdded: string; title: string; debitId: number; creditId: number; amount: number; taxId?: number; reference?: string; sequenceNumberId?: number; associateId?: number }) {
    return this.http.post<Created>('journal/create', d);
  }
}

export interface OrderItemInput { accountId: number; name: string; unitPrice: number; quantity: number; description?: string; taxId?: number; unitId?: number; articleNr?: string; inventoryId?: number; type?: 'ARTICLE' | 'TEXT' | 'PAGEBREAK' | 'SUBTOTAL' | 'TITLE' | 'OPTIONTOTAL' }
type Created = { insertId: number };
