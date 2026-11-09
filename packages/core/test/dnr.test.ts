import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  defaultRuleSet,
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
function applyRedirect(rule: DnrRule, url: string): string {
  if (rule.action.type !== 'redirect') return url;
  const redirect = rule.action.redirect;
  if ('regexSubstitution' in redirect) {
    const re = new RegExp(rule.condition.regexFilter!, rule.condition.isUrlFilterCaseSensitive === false ? 'i' : '');
    return url.replace(re, redirect.regexSubstitution.replace(/\\(\d)/g, '$$$1'));
  }
  const remove = new Set(redirect.transform.queryTransform.removeParams);
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return url;
  const segments = url.slice(qIdx + 1).split('&');
  const kept = segments.filter((seg) => !remove.has(seg.split('=')[0]!));
  if (kept.length === segments.length) return url;
  return url.slice(0, qIdx) + (kept.join('&') ? `?${kept.join('&')}` : '');
}

/**
 * Model of Chromium's DNR evaluation for main_frame requests: highest
 * priority first, `allow` beats `redirect` at equal priority, a redirect whose
 * result equals the request URL is skipped (verified in Chromium), and every
 * redirect starts a new request (max 20 hops). Fragments are not sent and are
 * re-attached by the browser. The real browser is exercised by the e2e suite.
 */
function simulate(rules: DnrRule[], input: string): string {
  const hashIdx = input.indexOf('#');
  const fragment = hashIdx === -1 ? '' : input.slice(hashIdx);
  let url = hashIdx === -1 ? input : input.slice(0, hashIdx);
  for (let hop = 0; hop < 20; hop++) {
    const host = new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
    const matching = rules
      .filter((r) => {
        const c = r.condition;
        if (c.requestDomains && !c.requestDomains.some((d) => domainMatches(host, d))) return false;
        if (c.regexFilter && !new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive === false ? 'i' : '').test(url))
          return false;
        return true;
      })
      .sort((a, b) => b.priority - a.priority || (a.action.type === 'allow' ? -1 : 1));
    let next = url;
    for (const rule of matching) {
      if (rule.action.type === 'allow') break;
      next = applyRedirect(rule, url);
      if (next !== url) break;
    }
    if (next === url) return url + fragment;
    url = next;
  }
  throw new Error('redirect limit exceeded');
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
        .flatMap((r) =>
          r.action.type === 'redirect' && 'transform' in r.action.redirect
            ? r.action.redirect.transform.queryTransform.removeParams
            : [],
        );
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
    // Cleaned: identical to the engine for the query; DNR never touches fragments.
    const engineNoFragment = new URL(engine.url);
    const dnr = new URL(viaDnr);
    // Documented exceptions: fragments are never sent; encoded keys are left alone.
    const exact = !engine.removed.some((r) => r.location === 'fragment' || r.name.includes('%'));
    if (exact) {
      expect(dnr.search).toBe(engineNoFragment.search);
    }
    for (const [k] of engineNoFragment.searchParams) expect(dnr.searchParams.has(k), `${k} lost`).toBe(true);
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

  it('removes mixed-case and unlisted prefix trackers via the case-insensitive fallback', () => {
    const rules = compileDnrRules({ mode: 'clean', exceptions: [] });
    const cases: [string, string][] = [
      ['https://e.example/a?Utm_Source=x&id=1', 'https://e.example/a?id=1'],
      ['https://e.example/a?id=1&FbClid=x', 'https://e.example/a?id=1'],
      ['https://e.example/a?uTm_NewThing=1', 'https://e.example/a'],
      ['https://e.example/a?utm_source=x&Utm_Medium=y&b=2&GCLID=z', 'https://e.example/a?b=2'],
      ['https://e.example/a?utm=1&Utm_Source=2', 'https://e.example/a?utm=1'],
      ['https://e.example/a?myutm_source=1&xgclid=2', 'https://e.example/a?myutm_source=1&xgclid=2'],
      ['https://e.example/login?Utm_Source=x', 'https://e.example/login?Utm_Source=x'],
    ];
    for (const [input, expected] of cases) {
      expect(simulate(rules, input)).toBe(expected);
      expect(cleanUrl(input).url).toBe(expected);
    }
  });

  it('terminates for many mixed-case trackers (each hop shortens the URL)', () => {
    const rules = compileDnrRules({ mode: 'clean', exceptions: [] });
    const params = Array.from({ length: 15 }, (_, i) => `Utm_X${i}=1`).join('&');
    expect(simulate(rules, `https://e.example/?${params}&id=1`)).toBe('https://e.example/?id=1');
  });

  it('matches the engine exactly for common lower-case tracking URLs', () => {
    const url = 'https://example.com/article?utm_source=newsletter&utm_medium=email&id=123&fbclid=x&gclid=y';
    const rules = compileDnrRules({ mode: 'clean', exceptions: [] });
    expect(simulate(rules, url)).toBe(cleanUrl(url).url);
  });
});

describe('DNR vs engine (property, random case)', () => {
  const global = defaultRuleSet.rules.filter((r) => r.domains === undefined);
  for (const mode of ['clean', 'strict'] as const) {
    it(`agrees with the engine for random mixed-case trackers (${mode})`, async () => {
      const { defaultRuleSet: rs } = await import('../src/index.js');
      const keys = rs.rules
        .filter((r) => r.domains === undefined && (r.mode === 'clean' || mode === 'strict'))
        .flatMap((r) => r.params ?? []);
      const rules = compileDnrRules({ mode, exceptions: [] });
      const randomCase = (k: string, bits: number) =>
        [...k].map((ch, i) => ((bits >> (i % 30)) & 1 ? ch.toUpperCase() : ch)).join('');
      const key = fc.oneof(
        fc.tuple(fc.constantFrom(...keys), fc.nat()).map(([k, b]) => randomCase(k, b)),
        fc.stringMatching(/^[a-z]{1,6}$/).filter((k) => !keys.includes(k) && !k.startsWith('utm') && k !== 'api'),
      );
      fc.assert(
        fc.property(
          fc.array(fc.tuple(key, fc.stringMatching(/^[a-z0-9]{0,4}$/)), { minLength: 1, maxLength: 8 }),
          (params) => {
            const url = `https://shop.example/item?${params.map(([k, v]) => `${k}=${v}`).join('&')}`;
            const engine = cleanUrl(url, { mode });
            if (engine.status === 'protected') return;
            expect(simulate(rules, url)).toBe(engine.url);
          },
        ),
        { numRuns: 1500 },
      );
    });
  }
  it('uses only global rules for the fallback', () => {
    expect(global.length).toBeGreaterThan(0);
  });
});
