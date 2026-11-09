import type { ToolContext } from '../context.js';
import type { ToolModule } from '../def.js';
import { apiReadModule } from './read.js';
import { apiWriteModule } from './write.js';

/**
 * Allgemeine Werkzeuge (0.4.0, Entscheid 24.10.2026, Variante B): api_catalog und api_read
 * (Stufe read), prepare_api_write und commit_api_write (Stufe full). Sie decken jeden der 376
 * Endpunkte der CashCtrl-API ab; die Fachwerkzeuge bleiben der bevorzugte Weg.
 */
export const apiModule: ToolModule = {
  tools(ctx: ToolContext) { return [...apiReadModule.tools(ctx), ...apiWriteModule.tools(ctx)]; },
};
