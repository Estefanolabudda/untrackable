import { toAsciiDomain, type Mode } from '@untrackable/core';

/** Persisted in chrome.storage.local. Contains no URLs and no browsing data. */
export interface Settings {
  /** Master switch. false = global bypass. */
  enabled: boolean;
  /** Cleaning mode when enabled. */
  mode: 'clean' | 'strict';
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
    mode: r.mode === 'strict' ? 'strict' : 'clean',
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

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEYS);
  return sanitizeSettings({ ...DEFAULT_SETTINGS, ...stored });
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = sanitizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set(next);
  return next;
}

/** Messages accepted by the service worker. */
export type Message =
  | { type: 'getTabState'; tabId?: number }
  | { type: 'setTabPaused'; tabId: number; paused: boolean }
  | { type: 'copyText'; text: string }
  | { type: 'openUnmodified'; url: string };

export interface TabState {
  paused: boolean;
}
