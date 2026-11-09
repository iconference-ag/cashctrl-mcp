import { describe, it, expect } from 'vitest';
import { TokenBucket } from '../../src/core/ratelimit.js';

describe('TokenBucket', () => {
  it('gibt 300 Marken sofort und fuellt 30 pro Sekunde nach', async () => {
    let t = 0;
    const clock = () => t;
    const waits: number[] = [];
    const b = new TokenBucket(300, 30, clock, async (ms) => { waits.push(ms); t += ms; });
    for (let i = 0; i < 300; i++) await b.take();
    expect(b.available()).toBe(0);
    expect(waits).toEqual([]);
    await b.take();                     // 301. Marke: muss ~33 ms warten
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThanOrEqual(33);
    t += 1000;                          // eine Sekunde spaeter
    expect(b.available()).toBe(30);
  });
  it('serialisiert parallele take() — Bucket geht nie unter null (M5)', async () => {
    let t = 0;
    const waits: number[] = [];
    const gesehen: number[] = [];
    const b = new TokenBucket(1, 30, () => t, async (ms) => { waits.push(ms); gesehen.push(b.available()); t += ms; });
    await Promise.all(Array.from({ length: 5 }, () => b.take()));
    gesehen.push(b.available());
    expect(Math.min(...gesehen)).toBeGreaterThanOrEqual(0);
    expect(waits.length).toBe(4);
  });
});
