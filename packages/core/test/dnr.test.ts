import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  cleanUrl,
  compileDnrRules,
  domainMatches,
  ID_BASE,
  toAsciiDomain,
  type DnrRule,
  type Mode,
} from '../src/index.js';

/**
 * Minimal model of Chromium's DNR evaluation for main_frame requests:
 * highest priority wins, `allow` beats `redirect` at equal priority,
 * removeParams removes segments whose raw key matches exactly.
 * The real browser behaviour is verified separately by the e2e suite.
 */
function simulate(rules: DnrRule[], url: string): string {
  const u = new URL(url);
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');
  const matching = rules.filter((r) => {
    const c = r.condition;
    if (c.requestDomains && !c.requestDomains.some((d) => domainMatches(host, d))) return false;
    if (c.regexFilter && !new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive === false ? 'i' : '').test(url))
      return false;
    return true;
  });
  if (matching.length === 0) return url;
  matching.sort((a, b) => b.priority - a.priority || (a.action.type === 'allow' ? -1 : 1));
  const winner = matching[0]!;
  if (winner.action.type === 'allow') return url;
  const remove = new Set(winner.action.redirect.transform.queryTransform.removeParams);
  const hashIdx = url.indexOf('#');
  const noFrag = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const qIdx = noFrag.indexOf('?');
  if (qIdx === -1) return url;
  const kept = noFrag
    .slice(qIdx + 1)
    .split('&')
    .filter((seg) => !remove.has(seg.split('=')[0]!));
  if (kept.length === noFrag.slice(qIdx + 1).split('&').length) return url;
  return noFrag.slice(0, qIdx) + (kept.join('&') ? `?${kept.join('&')}` : '');
}

interface Case {
  name: string;
  input: string;
  mode?: Mode;
  exceptions?: string[];
  expected: string;
  status: string;
}
const { cases } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../tests/fixtures/cases.json', import.meta.url)), 'utf8'),
) as { cases: Case[] };

describe('compileDnrRules', () => {
  it('produces unique ids within their ranges and valid structure', () => {
    for (const mode of ['clean', 'strict'] as const) {
      const rules = compileDnrRules({ mode, exceptions: ['example.com'] });
      expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
      for (const r of rules) {
        expect(r.condition.resourceTypes).toEqual(['main_frame']);
        expect(r.id).toBeGreaterThan(0);
        if (r.action.type === 'redirect') expect(r.id).toBeLessThan(ID_BASE.protection);
        if (r.condition.regexFilter) expect(() => new RegExp(r.condition.regexFilter!)).not.toThrow();
        if (r.condition.regexFilter) expect(r.condition.regexFilter.length).toBeLessThan(400);
      }
    }
  });

  it('includes strict-only parameters only in strict mode', () => {
    const removeParams = (mode: 'clean' | 'strict') =>
      compileDnrRules({ mode, exceptions: [] })
        .filter((r) => r.id === ID_BASE.globalRedirect)
        .flatMap((r) => (r.action.type === 'redirect' ? r.action.redirect.transform.queryTransform.removeParams : []));
    expect(removeParams('clean')).toContain('utm_source');
    expect(removeParams('clean')).not.toContain('ref');
    expect(removeParams('strict')).toContain('ref');
  });

  it('adds user exceptions as punycode allow rules and drops invalid entries', () => {
    const rules = compileDnrRules({
      mode: 'clean',
      exceptions: ['Bücher.example', 'bad host', '', 'https://x.example/a', 'a.example:8080'],
    });
    const ex = rules.find((r) => r.id === ID_BASE.userException);
    expect(ex?.condition.requestDomains).toEqual(['xn--bcher-kva.example', 'x.example', 'a.example']);
  });

  it('validates exception domains', () => {
    expect(toAsciiDomain('EXAMPLE.com')).toBe('example.com');
    expect(toAsciiDomain('a b')).toBe('');
    expect(toAsciiDomain('host.example/path')).toBe('host.example');
    expect(toAsciiDomain('[::1]')).toBe('');
  });

  it('only uses pairwise protection combinations (expressible in DNR)', async () => {
    const { defaultRuleSet } = await import('../src/index.js');
    for (const c of defaultRuleSet.protection.paramCombinations) expect(c).toHaveLength(2);
  });
});

/**
 * Documented divergences (docs/architecture/overview.md, "Navigation cleaning"):
 * DNR never sees URL fragments and matches the raw, still percent-encoded URL.
 */
const KNOWN_DNR_DIVERGENCES = new Set(['OIDC implicit flow token in fragment is protected']);

describe('DNR approximation vs engine (shared fixtures)', () => {
  const navigable = cases.filter(
    (c) =>
      c.mode !== 'bypass' &&
      !KNOWN_DNR_DIVERGENCES.has(c.name) &&
      ['cleaned', 'unchanged', 'protected', 'excepted'].includes(c.status),
  );

  it('known divergences still exist as fixtures', () => {
    for (const name of KNOWN_DNR_DIVERGENCES) expect(cases.some((c) => c.name === name)).toBe(true);
  });

  it.each(navigable.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    const mode = (c.mode ?? 'clean') as 'clean' | 'strict';
    const rules = compileDnrRules({ mode, exceptions: c.exceptions ?? [] });
    const trimmed = c.input.trim();
    const viaDnr = simulate(rules, new URL(trimmed).href);
    const engine = cleanUrl(c.input, { mode, exceptions: c.exceptions ?? [] });

    if (engine.status === 'protected' || engine.status === 'excepted' || engine.status === 'unchanged') {
      // Safety property: navigation cleaning must never touch what the engine leaves alone.
      expect(viaDnr).toBe(new URL(trimmed).href);
      return;
    }
    // Cleaned: DNR may be weaker (prefix rules, case variants, fragments) but never removes more.
    const dnrKeys = new URL(viaDnr).searchParams;
    for (const [k] of new URL(engine.url).searchParams) expect(dnrKeys.has(k), `${k} lost`).toBe(true);
  });

  it('leaves percent-encoded paths and keys alone (DNR cannot decode)', () => {
    const rules = compileDnrRules({ mode: 'clean', exceptions: [] });
    for (const url of [
      'https://e.example/%6Fauth/x?utm_source=a',
      'https://e.example/my%2Dlogin?utm_source=a',
      'https://e.example/dl?%73ig=abc&utm_source=a',
    ]) {
      expect(simulate(rules, url)).toBe(url);
    }
    // Encoded non-ASCII paths (e.g. umlauts) are still cleaned.
    expect(simulate(rules, 'https://e.example/stra%C3%9Fe?utm_source=a')).toBe('https://e.example/stra%C3%9Fe');
  });

  it('matches the engine exactly for common lower-case tracking URLs', () => {
    const url = 'https://example.com/article?utm_source=newsletter&utm_medium=email&id=123&fbclid=x&gclid=y';
    const rules = compileDnrRules({ mode: 'clean', exceptions: [] });
    expect(simulate(rules, url)).toBe(cleanUrl(url).url);
  });
});
