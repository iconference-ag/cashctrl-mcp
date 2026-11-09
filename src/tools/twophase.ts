import { z } from 'zod';
import type { Mode } from '../config/config.js';
import { tool, type ToolDef, type Schalter } from './def.js';
import type { ToolContext } from './context.js';
import { ok, fail, OrgParam } from './result.js';
import { CashCtrlError } from '../core/errors.js';
import { OFFEN_SATZ } from '../core/http.js';

export interface Prepared<P> { summary: string; warnings: string[]; payload: P }
export interface TwoPhaseSpec<I extends z.ZodObject, P> {
  kind: string; title: string; description: string; input: I; destructive: boolean;
  /** Reicht die Registrierungs-Bedingung an beide erzeugten Werkzeuge durch (createToolset). */
  requires?: Schalter;
  /** prepare ruft CashCtrl nicht auf: die Vorschau liest dann auch den Firmennamen nicht nach (api_write). */
  ohneNetz?: boolean;
  prepare(ctx: ToolContext, args: z.infer<I>): Promise<Prepared<P>>;
  commit(ctx: ToolContext, org: string, payload: P): Promise<unknown>;
}
const HINT = ' Zeige dem Menschen die Zusammenfassung (summary) und alle warnings und warte auf ein ausdrückliches Ja, bevor du commit_ mit dem Token aufrufst. Das Token gilt 10 Minuten.';

/**
 * Zweistufiges Schreibmuster: `prepare_<kind>` prueft die Eingabe, zeigt eine Vorschau
 * (summary, warnings) und stellt ein Einmal-Token aus; `commit_<kind>` loest das Token
 * (gebunden an Art, Organisation und die bei prepare gespeicherte Eingabe) ein und fuehrt
 * `s.commit` genau einmal aus. Fehler auf beiden Stufen werden zu `fail()`, nie zu einer
 * durchschlagenden Ausnahme.
 */
export function twoPhaseTools<I extends z.ZodObject, P>(ctx: ToolContext, level: Mode, s: TwoPhaseSpec<I, P>): ToolDef[] {
  const prepare = tool(`prepare_${s.kind}`, level, { title: `${s.title} — Vorschau`, description: s.description + HINT, inputSchema: s.input, annotations: { readOnlyHint: true, openWorldHint: true }, requires: s.requires }, async (args) => {
    try {
      const org = ctx.orgName((args as { org?: string }).org);
      const p = await s.prepare(ctx, args as z.infer<I>);
      // B-MCP-3: der Mensch bestaetigt gegen den Firmennamen, nicht gegen den Namen aus der Konfiguration.
      const firma = s.ohneNetz ? undefined : await ctx.firma(org);
      const summary = firma ? `${p.summary}\nOrganisation: ${firma} (${org})` : p.summary;
      const { token, expiresAt } = await ctx.tokens.issue(s.kind, org, p.payload);
      return ok({ summary, warnings: p.warnings, ...(firma ? { orgName: firma } : {}), token, expiresAt }, summary + (p.warnings.length ? '\nWarnungen: ' + p.warnings.join(' | ') : ''));
    } catch (e) { return fail(e); }
  });
  const commit = tool(`commit_${s.kind}`, level, { title: `${s.title} — ausführen`, description: `Führt ${s.title} aus. Braucht das Token aus prepare_${s.kind}; nur nach ausdrücklichem Ja des Menschen aufrufen.`, inputSchema: z.object({ org: OrgParam, 'token': z.string() }), annotations: { readOnlyHint: false, destructiveHint: s.destructive, idempotentHint: false, openWorldHint: true }, requires: s.requires }, async ({ org, token }) => {
    let name: string;
    let payload: P;
    try {
      name = ctx.orgName(org);
      payload = await ctx.tokens.redeem<P>(s.kind, name, token);
    } catch (e) { return fail(e); }
    const vorher = ctx.gesendet(name);
    try {
      return ok(await s.commit(ctx, name, payload));
    } catch (e) { return fail(nachSchreiben(e, ctx.gesendet(name) > vorher)); }
  });
  return [prepare as ToolDef, commit as ToolDef];
}

/**
 * Hat in diesem commit schon ein POST CashCtrl erreicht (oder erreichen koennen), gilt jeder
 * spaetere Fehler als «Ausgang offen»: sent wird true, `createdId` bleibt stehen. Nur
 * hochstufen, nie auf false. Ein roher Fehler (z.B. TypeError aus einer unerwarteten Antwort)
 * wird dabei zur CashCtrlError, damit sent ueberhaupt ankommt.
 */
export function nachSchreiben(e: unknown, geschrieben: boolean): unknown {
  if (!geschrieben) return e;
  if (e instanceof CashCtrlError) {
    if (e.sent === true) return e;
    const text = e.message.replace(/ — bitte erneut versuchen\.$/, '.');
    return new CashCtrlError(e.kind, `${text} Ein Schreibaufruf dieses Auftrags hat CashCtrl bereits erreicht. ${OFFEN_SATZ}`, e.details, { sent: true, createdId: e.createdId });
  }
  const text = e instanceof Error ? `Fehler: ${e.message}` : 'Unbekannter Fehler';
  return new CashCtrlError('unknown', `${text} Ein Schreibaufruf dieses Auftrags hat CashCtrl bereits erreicht. ${OFFEN_SATZ}`, undefined, { sent: true });
}
