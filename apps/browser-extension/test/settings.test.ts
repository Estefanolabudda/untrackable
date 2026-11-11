import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Minimal chrome.storage.local double whose reads resolve before writes, so
 * two saveSettings calls interleave exactly like two UI handlers in one task.
 */
let store: Record<string, unknown> = {};
const tick = () => new Promise((r) => setTimeout(r, 0));
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      async get(keys: string[]) {
        await tick();
        return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]));
      },
      async set(items: Record<string, unknown>) {
        await tick();
        await tick();
        store = { ...store, ...items };
      },
    },
  },
};

const { saveSettings, sanitizeSettings } = await import('../src/settings.js');

describe('settings', () => {
  beforeEach(() => {
    store = {};
  });

  it('concurrent saves of different keys do not undo each other (regression: lost update)', async () => {
    store = { mode: 'experimental' };
    // "Back to Clean" and "Pause" started in the same task.
    await Promise.all([saveSettings({ mode: 'clean' }), saveSettings({ pausedUntil: 123 })]);
    expect(store.mode).toBe('clean');
    expect(store.pausedUntil).toBe(123);
  });

  it('writes only the patched, sanitised keys', async () => {
    await saveSettings({ mode: 'bogus' as never });
    expect(store).toEqual({ mode: 'clean' });
  });

  it('accepts the experimental mode and keeps older modes', () => {
    expect(sanitizeSettings({ mode: 'experimental' }).mode).toBe('experimental');
    expect(sanitizeSettings({ mode: 'strict' }).mode).toBe('strict');
    expect(sanitizeSettings({ mode: 'EXPERIMENTAL' }).mode).toBe('clean');
    expect(sanitizeSettings({}).mode).toBe('clean');
  });
});
