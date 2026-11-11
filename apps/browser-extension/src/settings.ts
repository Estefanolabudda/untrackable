import { toAsciiDomain, type Mode } from '@untrackable/core';

/** Persisted in chrome.storage.local. Contains no URLs and no browsing data. */
export interface Settings {
  /** Master switch. false = global bypass. */
  enabled: boolean;
  /**
   * Cleaning mode when enabled. 'experimental' strips whole query strings and
   * is only ever set by an explicit, confirmed user choice (never a default).
   */
  mode: 'clean' | 'strict' | 'experimental';
  /** Domains (punycode) that are never cleaned, subdomains included. */
  exceptions: string[];
  /** Epoch milliseconds until which cleaning is paused (temporary bypass). 0 = not paused. */
  pausedUntil: number;
  /** Clean URLs when the user copies a selection that is exactly one link. */
  copyCleaning: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  enabled: true,
  mode: 'clean',
  exceptions: [],
  pausedUntil: 0,
  copyCleaning: true,
});

export const MAX_EXCEPTIONS = 1000;

/** Normalise and validate a list of user exception entries (untrusted input). */
export function sanitizeExceptions(entries: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.length > 2048) continue;
    const domain = toAsciiDomain(entry);
    if (domain !== '' && domain.length <= 253) out.add(domain);
    if (out.size >= MAX_EXCEPTIONS) break;
  }
  return [...out].sort();
}

/** Coerce untrusted stored data into valid settings. Never throws. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const pausedUntil =
    typeof r.pausedUntil === 'number' && Number.isFinite(r.pausedUntil) && r.pausedUntil > 0 ? r.pausedUntil : 0;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_SETTINGS.enabled,
    mode: r.mode === 'strict' || r.mode === 'experimental' ? r.mode : 'clean',
    exceptions: Array.isArray(r.exceptions) ? sanitizeExceptions(r.exceptions) : [],
    pausedUntil,
    copyCleaning: typeof r.copyCleaning === 'boolean' ? r.copyCleaning : DEFAULT_SETTINGS.copyCleaning,
  };
}

/** The mode the engine should run in right now. */
export function effectiveMode(s: Settings, now: number = Date.now()): Mode {
  if (!s.enabled || s.pausedUntil > now) return 'bypass';
  return s.mode;
}

export const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

/**
 * Version of the stored settings format, kept under SETTINGS_VERSION_KEY.
 * 0.1.0 and 0.2.0 stored no version (format 0); 1 = sanitised settings as of
 * 0.3.0. Bump it together with a migration step in `migrateSettings`.
 */
export const SETTINGS_VERSION = 1;
export const SETTINGS_VERSION_KEY = 'settingsVersion';

/**
 * Pure migration of the raw stored object: returns the keys to write (empty
 * when nothing needs to change). Only settings that are present are rewritten
 * (sanitised), so nothing is invented; unknown keys are left alone. A newer
 * format (after a downgrade) is not touched – reads are sanitised anyway.
 */
export function migrateSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const stored = raw[SETTINGS_VERSION_KEY];
  const version = typeof stored === 'number' && Number.isInteger(stored) && stored >= 0 ? stored : 0;
  if (version >= SETTINGS_VERSION) return {};
  const clean = sanitizeSettings(raw);
  const write: Record<string, unknown> = { [SETTINGS_VERSION_KEY]: SETTINGS_VERSION };
  for (const key of SETTINGS_KEYS) if (key in raw) write[key] = clean[key];
  return write;
}

/** Bring stored settings to the current format (install, update, browser start). */
export async function migrateStoredSettings(): Promise<void> {
  const write = migrateSettings(await chrome.storage.local.get(null));
  if (Object.keys(write).length > 0) await chrome.storage.local.set(write);
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEYS);
  return sanitizeSettings({ ...DEFAULT_SETTINGS, ...stored });
}

/**
 * Write only the keys in `patch` (sanitised). Writing the whole merged object
 * could undo a concurrent change of another key – e.g. bring back
 * Experimental mode after "Back to Clean" (found in review).
 */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = sanitizeSettings({ ...(await loadSettings()), ...patch });
  const keys = (Object.keys(patch) as (keyof Settings)[]).filter((k) => SETTINGS_KEYS.includes(k));
  await chrome.storage.local.set(Object.fromEntries(keys.map((k) => [k, next[k]])));
  return next;
}

/** Messages accepted by the service worker. */
export type Message =
  | { type: 'getTabState'; tabId?: number }
  | { type: 'setTabPaused'; tabId: number; paused: boolean }
  | { type: 'copyText'; text: string }
  | { type: 'copyCleanTab'; tabId: number }
  | { type: 'resetStats' }
  | { type: 'openUnmodified'; url: string }
  | { type: 'retryLoop'; tabId: number }
  | { type: 'copied'; url?: string };

export interface TabState {
  /** Cleaning is off in this tab (user pause or a running one-time bypass). */
  paused: boolean;
  /** The user switched on "Pause in this tab" (what the popup checkbox shows). */
  pausedByUser?: boolean;
  /** Host of a page in this tab that failed with a redirect loop (extension pages only). */
  loopHost?: string;
  /** The loop persisted even without cleaning: not caused by Untrackable. */
  loopNotOurs?: boolean;
}
