import { readFileSync } from 'node:fs';
import { simulate } from './dnr-simulator.js';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { defaultRuleSet, cleanUrl, compileDnrRules, ID_BASE, toAsciiDomain, type Mode } from '../src/index.js';

/**
 * Minimal model of Chromium's DNR evaluation for main_frame requests:
 * highest priority wins, `allow` beats `redirect` at equal priority,
 * removeParams removes segments whose raw key matches exactly.
 * The real browser behaviour is verified separately by the e2e suite.
 */
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
        // Protection alternations are kept short (Chromium 2 KB RE2 limit, case-insensitive).
        if (r.action.type === 'allow' && r.condition.regexFilter?.includes('(?:')) {
          const alternation = /\(\?:([^()]*)\)/.exec(r.condition.regexFilter)?.[1] ?? '';
          expect(alternation.length, r.condition.regexFilter).toBeLessThanOrEqual(70);
        }
      }
    }
  });

  it('includes strict-only parameters only in strict mode', () => {
    const removeParams = (mode: 'clean' | 'strict') =>
      compileDnrRules({ mode, exceptions: [] })
        .filter((r) => r.id === ID_BASE.globalRedirect)
        .flatMap((r) =>
          r.action.type === 'redirect' &&
          'transform' in r.action.redirect &&
          'queryTransform' in r.action.redirect.transform
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
// Protection signals that exist only in the fragment are invisible to navigation rules.
const KNOWN_DNR_DIVERGENCES = new Set([
  'OIDC implicit flow token in fragment is protected',
  'experimental: experimental protection name in the fragment counts',
]);

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
    const mode = (c.mode ?? 'clean') as 'clean' | 'strict' | 'experimental';
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
    // Documented exceptions: fragments are never sent; encoded keys are left
    // alone; Chromium's queryTransform normalises valueless/empty segments.
    const query = c.input.trim().split('#')[0]!.split('?').slice(1).join('?');
    const hasValueless = query !== '' && query.split('&').some((seg) => !seg.includes('='));
    const exact = !hasValueless && !engine.removed.some((r) => r.location === 'fragment' || r.name.includes('%'));
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
      'https://e.example/x%2Fsso?utm_source=1',
      'https://e.example/%32fa?utm_source=1',
      'https://e.example/go/https%3A%2F%2Fidp.example%2Fauthorize?utm_source=1',
      'https://e.example/a?utm_source=1&code&state',
      'https://e.example/a?state=1&utm_source=1&code=2',
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
      ['https://e.example/a?x=1&Utm_Source=a#frag', 'https://e.example/a?x=1#frag'],
      ['https://e.example/a?Utm_Source=a#frag', 'https://e.example/a#frag'],
    ];
    for (const [input, expected] of cases) {
      expect(simulate(rules, input)).toBe(expected);
      expect(cleanUrl(input).url).toBe(expected);
    }
  });

  it('documents that Chromium normalises valueless and empty segments when it removes exact matches', () => {
    const rules = compileDnrRules({ mode: 'clean', exceptions: [] });
    // Engine: byte-for-byte. Navigation (queryTransform): `edit` -> `edit=`, `` -> `=`.
    expect(cleanUrl('https://e.example/wiki?edit&utm_source=1').url).toBe('https://e.example/wiki?edit');
    expect(simulate(rules, 'https://e.example/wiki?edit&utm_source=1')).toBe('https://e.example/wiki?edit=');
    // Only mixed-case trackers: handled by the byte-preserving regex fallback.
    expect(simulate(rules, 'https://e.example/wiki?edit&Utm_Source=1')).toBe('https://e.example/wiki?edit');
  });

  it('never exceeds the redirect limit: long queries skip the fallback chain', () => {
    const rules = compileDnrRules({ mode: 'clean', exceptions: [] });
    const unlisted = Array.from({ length: 25 }, (_, i) => `utm_z${i}=1`).join('&');
    const url = `https://e.example/a?${unlisted}&utm_source=x&id=1`;
    // Exact rules still remove the listed tracker; unlisted ones stay (no endless chain).
    expect(simulate(rules, url)).toBe(`https://e.example/a?${unlisted}&id=1`);
  });

  it('terminates for many mixed-case trackers (each hop shortens the URL)', () => {
    const rules = compileDnrRules({ mode: 'clean', exceptions: [] });
    const params = Array.from({ length: 5 }, (_, i) => `Utm_X${i}=1`).join('&');
    expect(simulate(rules, `https://e.example/?${params}&id=1`)).toBe('https://e.example/?id=1');
    // Beyond the guard, mixed-case trackers are left in place rather than looping.
    const many = Array.from({ length: 15 }, (_, i) => `Utm_X${i}=1`).join('&');
    expect(simulate(rules, `https://e.example/?${many}&id=1`)).toBe(`https://e.example/?${many}&id=1`);
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
          fc.array(fc.tuple(key, fc.stringMatching(/^[a-z0-9]{0,4}$/)), { minLength: 1, maxLength: 10 }),
          (params) => {
            const url = `https://shop.example/item?${params.map(([k, v]) => `${k}=${v}`).join('&')}`;
            const engine = cleanUrl(url, { mode });
            if (engine.status === 'protected') return;
            const dnr = simulate(rules, url);
            if (params.length <= 6) {
              // Below the fallback guard: identical to the engine.
              expect(dnr).toBe(engine.url);
            } else {
              // Above it: may remove less, never more (every kept segment survives, in order).
              const kept = engine.url.split('?')[1]?.split('&') ?? [];
              const dnrSegments = dnr.split('?')[1]?.split('&') ?? [];
              let i = 0;
              for (const seg of dnrSegments) if (seg === kept[i]) i++;
              expect(i).toBe(kept.length);
            }
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
