import type { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server';
import type { Mode } from '../config/config.js';
import type { ToolContext } from './context.js';

/**
 * Werkzeug-Definition und -Fabrik liegen bewusst hier und nicht in `toolset.ts`:
 * die Werkzeugmodule brauchen `tool()`, `toolset.ts` braucht die Module — ein
 * gegenseitiger Import waere ein ESM-Zirkel. `toolset.ts` reicht beides weiter.
 */
/** Opt-in je Organisation (Standard aus), der ein Werkzeug zusaetzlich zum Modus braucht. */
export type Schalter = 'sendMail' | 'deleteOrders';

export interface ToolDef<I extends z.ZodObject = z.ZodObject> {
  name: string; level: Mode; title: string; description: string; inputSchema: I; annotations: ToolAnnotations;
  /** Nur registriert, wenn mindestens eine konfigurierte Organisation den Schalter traegt (createToolset). */
  requires?: Schalter;
  handler(args: z.infer<I>): Promise<CallToolResult>;
}

export function tool<I extends z.ZodObject>(name: string, level: Mode, cfg: { title: string; description: string; inputSchema: I; annotations: ToolAnnotations; requires?: Schalter }, handler: (args: z.infer<I>) => Promise<CallToolResult>): ToolDef<I> {
  return { name, level, ...cfg, handler };
}

export interface ToolModule { tools(ctx: ToolContext): ToolDef[] }
