// src/lib.ts — die Bibliothek fuer den Operating Desk (kein core-Export)
export { createToolset, type Toolset, type ToolDef, type ToolModule } from './toolset.js';
export { loadConfig, type Config, type Mode, type OrgConfig } from './config/config.js';
// O125: die Speicherschnittstelle und was ein fremder Speicher braucht, um denselben Vertrag zu erfuellen:
// den Zustand des Zaehlers rechnen und dieselben Fehlersaetze werfen. `core` bleibt sonst innen.
export type { Stores, UsageStore, TokenStore, PdfStore } from './core/stores.js';
export { zustandAus, MONATSLIMIT, type UsageState } from './core/usage.js';
export { CashCtrlError } from './core/errors.js';
