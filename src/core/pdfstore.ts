import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { PdfStore } from './stores.js';

/**
 * Ein einzelnes Pfadsegment, das nichts anderes bedeuten kann — gilt fuer Organisationsname und
 * Dateiname. Der Zeichenfilter allein genuegt nicht: `.` und `..` bestehen ihn und bezeichnen
 * das eigene bzw. das uebergeordnete Verzeichnis. Ein Segment aus lauter Punkten (oder ein leeres)
 * wird deshalb zu `_` — sonst fuehrt der Name aus <pdfDir> heraus oder erzeugt eine versteckte Datei.
 */
export const pfadsicher = (s: string): string => {
  const t = s.replace(/[^A-Za-z0-9._-]/g, '_');
  return /^\.*$/.test(t) ? '_' : t;
};

/** Eingebaute PDF-Ablage: `pdfDir/<org>/<name>`, nur fuer den eigenen Benutzer lesbar. Ref = Pfad. */
export class FilePdfStore implements PdfStore {
  constructor(private readonly pdfDir: string) {}
  async put(org: string, name: string, bytes: Uint8Array): Promise<string> {
    const dir = join(this.pdfDir, pfadsicher(org));
    // Ein Beleg-PDF traegt Kundendaten: nur der eigene Benutzer, nicht die ganze Maschine.
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, pfadsicher(name));
    await fs.writeFile(path, bytes, { mode: 0o600 });
    return path;
  }
}
