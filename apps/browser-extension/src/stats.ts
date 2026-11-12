import { cleanUrl, type CleanResult, type Mode } from '@untrackable/core';

/**
 * Local removal statistics (opt-in).
 *
 * Only aggregate counts are stored – never a URL, host, parameter name or
 * time of day: `{ total, days }` where `days` holds at most the last
 * STATS_DAYS local calendar dates. Counts are split into tracking parameters
 * (what Clean/Strict remove) and other parameters (only Experimental removes
 * those).
 */
export interface Counts {
  trackers: number;
  other: number;
}

export interface Stats {
  total: Counts;
  /** Local date (YYYY-MM-DD) → counts; at most STATS_DAYS entries. */
  days: Record<string, Counts>;
}

export interface StatsSummary {
  today: Counts;
  week: Counts;
  total: Counts;
}

export const STATS_KEY = 'stats';
/** Rolling window of the "7 days" figure (today and the six days before). */
export const STATS_DAYS = 7;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export const ZERO: Readonly<Counts> = Object.freeze({ trackers: 0, other: 0 });

export function isZero(c: Counts): boolean {
  return c.trackers === 0 && c.other === 0;
}

export function sum(a: Counts, b: Counts): Counts {
  return { trackers: clamp(a.trackers + b.trackers), other: clamp(a.other + b.other) };
}

function clamp(n: number): number {
  return Number.isSafeInteger(n) && n > 0 ? n : n >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : 0;
}

function sanitizeCounts(raw: unknown): Counts {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' ? clamp(Math.floor(v)) : 0);
  return { trackers: n(r.trackers), other: n(r.other) };
}

/** Local calendar date of `d` as YYYY-MM-DD. */
export function localDateKey(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Whole days from `from` to `to` (both YYYY-MM-DD); calendar arithmetic, immune to DST. */
function dayDiff(from: string, to: string): number {
  const ms = (k: string): number => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

function inWindow(day: string, today: string): boolean {
  const d = dayDiff(day, today);
  return d >= 0 && d < STATS_DAYS;
}

/** Coerce untrusted stored data. Never throws. */
export function sanitizeStats(raw: unknown, today: string = localDateKey()): Stats {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const days: Record<string, Counts> = {};
  if (typeof r.days === 'object' && r.days !== null) {
    for (const [k, v] of Object.entries(r.days as Record<string, unknown>)) {
      if (DATE_KEY.test(k) && inWindow(k, today)) days[k] = sanitizeCounts(v);
    }
  }
  return { total: sanitizeCounts(r.total), days };
}

export function addToStats(stats: unknown, add: Counts, today: string = localDateKey()): Stats {
  const s = sanitizeStats(stats, today);
  s.total = sum(s.total, add);
  s.days[today] = sum(s.days[today] ?? ZERO, add);
  return s;
}

export function summarize(raw: unknown, today: string = localDateKey()): StatsSummary {
  const s = sanitizeStats(raw, today);
  const week = Object.values(s.days).reduce(sum, { ...ZERO });
  return { today: s.days[today] ?? { ...ZERO }, week, total: s.total };
}

function queryKey(segment: string): string {
  const eq = segment.indexOf('=');
  return eq === -1 ? segment : segment.slice(0, eq);
}

/** Removed parameters of an engine result, split into trackers and other (Experimental-only) parameters. */
export function classifyRemoved(input: string, result: CleanResult, mode: Mode, exceptions: readonly string[]): Counts {
  if (result.status !== 'cleaned' || result.removed.length === 0) return { ...ZERO };
  if (mode !== 'experimental') return { trackers: result.removed.length, other: 0 };
  // In Experimental, a parameter counts as a tracker when Strict would remove it too.
  const strict = cleanUrl(input, { mode: 'strict', exceptions: [...exceptions] });
  const trackers = multiset(strict.removed.map((r) => `${r.location}\u0000${r.name}`));
  let t = 0;
  for (const r of result.removed) if (take(trackers, `${r.location}\u0000${r.name}`)) t++;
  return { trackers: t, other: result.removed.length - t };
}

function multiset(items: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return m;
}

function take(m: Map<string, number>, key: string): boolean {
  const n = m.get(key) ?? 0;
  if (n === 0) return false;
  m.set(key, n - 1);
  return true;
}

function segments(search: string): string[] {
  return search
    .replace(/^\?/, '')
    .split('&')
    .filter((s) => s !== '');
}

/**
 * Parameters verifiably removed from a navigation: `to` must be `from` with
 * some query segments taken out (same scheme, credentials, host, port, path
 * and order of the remaining segments), and every removed segment must be one
 * the engine removes from `from` with the current settings. Anything else –
 * a server redirect, an HSTS upgrade, another extension's rewrite – counts 0.
 */
export function verifiedRemovals(from: string, to: string, mode: Mode, exceptions: readonly string[]): Counts {
  if (mode === 'bypass' || from === to) return { ...ZERO };
  let a: URL, b: URL;
  try {
    a = new URL(from);
    b = new URL(to);
  } catch {
    return { ...ZERO };
  }
  const base = (u: URL): string => `${u.protocol}//${u.username}:${u.password}@${u.host}${u.pathname}`;
  if (base(a) !== base(b)) return { ...ZERO };
  const before = segments(a.search);
  const after = segments(b.search);
  const removed: string[] = [];
  let j = 0;
  for (const seg of before) {
    if (j < after.length && after[j] === seg) j++;
    else removed.push(seg);
  }
  if (j !== after.length || removed.length === 0) return { ...ZERO };
  const result = cleanUrl(from, { mode, exceptions: [...exceptions] });
  const engineKeys = multiset(result.removed.filter((r) => r.location === 'query').map((r) => r.name));
  for (const seg of removed) if (!take(engineKeys, queryKey(seg))) return { ...ZERO };
  if (mode !== 'experimental') return { trackers: removed.length, other: 0 };
  // In Experimental, a parameter counts as a tracker when Strict would remove it too.
  const strict = cleanUrl(from, { mode: 'strict', exceptions: [...exceptions] });
  const strictKeys = multiset(strict.removed.filter((r) => r.location === 'query').map((r) => r.name));
  const trackers = removed.filter((seg) => take(strictKeys, queryKey(seg))).length;
  return { trackers, other: removed.length - trackers };
}

/** Optional permission that enables statistics (granted = statistics on). */
export const STATS_PERMISSION: chrome.permissions.Permissions = { permissions: ['webRequest'] };
