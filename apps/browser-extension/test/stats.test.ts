import { cleanUrl } from '@untrackable/core';
import { describe, expect, it } from 'vitest';
import {
  addToStats,
  classifyRemoved,
  localDateKey,
  sanitizeStats,
  STATS_DAYS,
  summarize,
  verifiedRemovals,
} from '../src/stats.js';

describe('stored statistics', () => {
  it('accumulates per local date and in total', () => {
    let s = addToStats(undefined, { trackers: 2, other: 0 }, '2026-11-10');
    s = addToStats(s, { trackers: 1, other: 3 }, '2026-11-11');
    s = addToStats(s, { trackers: 1, other: 0 }, '2026-11-11');
    expect(s).toEqual({
      total: { trackers: 4, other: 3 },
      days: { '2026-11-10': { trackers: 2, other: 0 }, '2026-11-11': { trackers: 2, other: 3 } },
    });
    expect(summarize(s, '2026-11-11')).toEqual({
      today: { trackers: 2, other: 3 },
      week: { trackers: 4, other: 3 },
      total: { trackers: 4, other: 3 },
    });
  });

  it('keeps only the last seven calendar days (across month and year ends)', () => {
    let s = addToStats(undefined, { trackers: 1, other: 0 }, '2026-12-26');
    s = addToStats(s, { trackers: 1, other: 0 }, '2026-12-27');
    s = addToStats(s, { trackers: 1, other: 0 }, '2027-01-02');
    expect(Object.keys(s.days).sort()).toEqual(['2026-12-27', '2027-01-02']);
    expect(summarize(s, '2027-01-02').week.trackers).toBe(2);
    expect(summarize(s, '2027-01-03').week.trackers).toBe(1);
    expect(summarize(s, '2027-01-03').today.trackers).toBe(0);
    expect(summarize(s, '2027-01-03').total.trackers).toBe(3);
    expect(STATS_DAYS).toBe(7);
  });

  it('ignores future dates (clock changes) and corrupt data', () => {
    expect(
      sanitizeStats(
        {
          total: { trackers: -5, other: 'x' },
          days: {
            '2026-11-12': { trackers: 9 },
            nonsense: { trackers: 1 },
            '2026-11-11': { trackers: 1.7, other: NaN },
          },
          url: 'https://example.com/?secret',
        },
        '2026-11-11',
      ),
    ).toEqual({ total: { trackers: 0, other: 0 }, days: { '2026-11-11': { trackers: 1, other: 0 } } });
    expect(sanitizeStats(null)).toEqual({ total: { trackers: 0, other: 0 }, days: {} });
    expect(sanitizeStats({ total: { trackers: Infinity } }).total.trackers).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('stores nothing but numbers and dates', () => {
    const s = addToStats(undefined, { trackers: 3, other: 1 });
    expect(JSON.stringify(s)).toMatch(/^[{}":,\d\-a-z]*$/);
    expect(Object.keys(s.days)).toEqual([localDateKey()]);
  });
});

describe('verified navigation removals', () => {
  const v = (
    from: string,
    to: string,
    mode: 'clean' | 'strict' | 'experimental' | 'bypass' = 'clean',
    ex: string[] = [],
  ) => verifiedRemovals(from, to, mode, ex);

  it('counts exactly the parameters the engine removes', () => {
    expect(v('https://news.test/a?utm_source=x&id=1&utm_medium=y', 'https://news.test/a?id=1')).toEqual({
      trackers: 2,
      other: 0,
    });
    expect(v('https://news.test/a?fbclid=1', 'https://news.test/a')).toEqual({ trackers: 1, other: 0 });
    // Mixed case handled by the regex fallback.
    expect(v('https://news.test/b?Utm_Source=x&id=1', 'https://news.test/b?id=1').trackers).toBe(1);
  });

  it('counts nothing that it cannot attribute to the engine', () => {
    // HSTS upgrade / server redirect / other path.
    expect(v('http://news.test/a?utm_source=x', 'https://news.test/a')).toEqual({ trackers: 0, other: 0 });
    expect(v('https://news.test/a?utm_source=x', 'https://news.test/b')).toEqual({ trackers: 0, other: 0 });
    expect(v('https://news.test/a?utm_source=x', 'https://other.test/a')).toEqual({ trackers: 0, other: 0 });
    // Another extension removing a parameter the engine keeps.
    expect(v('https://news.test/a?utm_source=x&id=1', 'https://news.test/a')).toEqual({ trackers: 0, other: 0 });
    // Added or reordered parameters.
    expect(v('https://news.test/a?utm_source=x&id=1', 'https://news.test/a?id=1&x=2')).toEqual({
      trackers: 0,
      other: 0,
    });
    expect(v('https://news.test/a?a=1&b=2&utm_source=x', 'https://news.test/a?b=2&a=1')).toEqual({
      trackers: 0,
      other: 0,
    });
    // Protected, excepted, paused, unchanged, invalid.
    expect(v('https://news.test/login?utm_source=x', 'https://news.test/login')).toEqual({ trackers: 0, other: 0 });
    expect(v('https://news.test/a?utm_source=x', 'https://news.test/a', 'clean', ['news.test'])).toEqual({
      trackers: 0,
      other: 0,
    });
    expect(v('https://news.test/a?utm_source=x', 'https://news.test/a', 'bypass')).toEqual({ trackers: 0, other: 0 });
    expect(v('https://news.test/a?id=1', 'https://news.test/a?id=1')).toEqual({ trackers: 0, other: 0 });
    expect(v('not a url', 'https://news.test/')).toEqual({ trackers: 0, other: 0 });
    // Strict-only parameter while in Clean.
    expect(v('https://news.test/a?ref=x', 'https://news.test/a')).toEqual({ trackers: 0, other: 0 });
    expect(v('https://news.test/a?ref=x', 'https://news.test/a', 'strict')).toEqual({ trackers: 1, other: 0 });
  });

  it('splits Experimental removals into trackers and other parameters', () => {
    expect(v('https://news.test/a?utm_source=x&id=1&q=cats', 'https://news.test/a', 'experimental')).toEqual({
      trackers: 1,
      other: 2,
    });
  });

  it('counts duplicate segments individually', () => {
    expect(v('https://news.test/a?utm_source=1&utm_source=2&id=1', 'https://news.test/a?id=1')).toEqual({
      trackers: 2,
      other: 0,
    });
  });
});

describe('copy counts', () => {
  it('classifies removed parameters of a copy', () => {
    const url = 'https://news.test/a?utm_source=x&q=1#utm_medium=y';
    expect(classifyRemoved(url, cleanUrl(url, { mode: 'strict' }), 'strict', [])).toEqual({ trackers: 2, other: 0 });
    expect(classifyRemoved(url, cleanUrl(url, { mode: 'experimental' }), 'experimental', [])).toEqual({
      trackers: 1, // the fragment is kept in Experimental
      other: 1,
    });
    expect(classifyRemoved(url, cleanUrl(url, { mode: 'bypass' }), 'bypass', [])).toEqual({ trackers: 0, other: 0 });
  });
});
