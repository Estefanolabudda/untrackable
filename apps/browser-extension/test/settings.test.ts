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
      async get(keys: string[] | null) {
        await tick();
        if (keys === null) return { ...store };
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

describe('settings migration', () => {
  it('0.1/0.2 data (no version) is sanitised and versioned, nothing invented', async () => {
    const { migrateSettings, SETTINGS_VERSION } = await import('../src/settings.js');
    expect(migrateSettings({ mode: 'strict', exceptions: ['Keep.Example', 'bad host'] })).toEqual({
      settingsVersion: SETTINGS_VERSION,
      mode: 'strict',
      exceptions: ['keep.example'],
    });
    expect(migrateSettings({})).toEqual({ settingsVersion: SETTINGS_VERSION });
    expect(migrateSettings({ mode: 'bogus', enabled: 'yes', unknownFutureKey: 1 })).toEqual({
      settingsVersion: SETTINGS_VERSION,
      mode: 'clean',
      enabled: true,
    });
  });

  it('current or newer formats are left alone (no rewrite on every start, no downgrade damage)', async () => {
    const { migrateSettings, SETTINGS_VERSION } = await import('../src/settings.js');
    expect(migrateSettings({ settingsVersion: SETTINGS_VERSION, mode: 'experimental' })).toEqual({});
    expect(migrateSettings({ settingsVersion: SETTINGS_VERSION + 5, mode: 'future-mode' })).toEqual({});
  });

  it('migrateStoredSettings writes only the migrated keys', async () => {
    const { migrateStoredSettings } = await import('../src/settings.js');
    store = { mode: 'experimental', pausedUntil: -5 };
    await migrateStoredSettings();
    expect(store).toEqual({ mode: 'experimental', pausedUntil: 0, settingsVersion: 1 });
    await migrateStoredSettings();
    expect(store).toEqual({ mode: 'experimental', pausedUntil: 0, settingsVersion: 1 });
  });
});
