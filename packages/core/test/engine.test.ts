import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  Cleaner,
  cleanUrl,
  defaultRuleSet,
  domainMatches,
  isParamShapedFragment,
  normaliseException,
  normaliseKey,
  validateRuleSet,
} from '../src/index.js';

describe('helpers', () => {
  it('normalises keys', () => {
    expect(normaliseKey('UTM_Source')).toBe('utm_source');
    expect(normaliseKey('utm%5Fsource')).toBe('utm_source');
    expect(normaliseKey('a+b')).toBe('a b');
    expect(normaliseKey('bad%ZZ')).toBe('bad%zz');
    expect(normaliseKey('ÄBC')).toBe('Äbc'); // ASCII-only lower-casing
  });

  it('matches domains without suffix confusion', () => {
    expect(domainMatches('example.com', 'example.com')).toBe(true);
    expect(domainMatches('a.b.example.com', 'example.com')).toBe(true);
    expect(domainMatches('badexample.com', 'example.com')).toBe(false);
    expect(domainMatches('com', 'example.com')).toBe(false);
  });

  it('normalises exceptions', () => {
    expect(normaliseException(' *.Example.COM. ')).toBe('example.com');
    expect(normaliseException('https://news.example.org/path?x')).toBe('news.example.org');
    expect(normaliseException('https://[bad')).toBe('');
    expect(normaliseException('   ')).toBe('');
  });

  it('detects param-shaped fragments', () => {
    expect(isParamShapedFragment('a=1&b=2')).toBe(true);
    expect(isParamShapedFragment('/route?a=1')).toBe(false);
    expect(isParamShapedFragment('section')).toBe(false);
  });
});

describe('rule set', () => {
  it('validates the shipped rules', () => {
    expect(() => validateRuleSet(JSON.parse(JSON.stringify(defaultRuleSet)))).not.toThrow();
  });

  it('rejects malformed rule sets', () => {
    expect(() => validateRuleSet(null)).toThrow();
    expect(() => validateRuleSet({ schemaVersion: 2 })).toThrow();
    const bad = JSON.parse(JSON.stringify(defaultRuleSet));
    bad.rules[0].params = ['UTM_SOURCE'];
    expect(() => validateRuleSet(bad)).toThrow(/lower-case/);
    const dup = JSON.parse(JSON.stringify(defaultRuleSet));
    dup.rules.push(dup.rules[0]);
    expect(() => validateRuleSet(dup)).toThrow(/duplicate/);
  });

  it('lists only lower-case protection entries', () => {
    const p = defaultRuleSet.protection;
    for (const list of [
      p.domains,
      p.pathKeywords,
      p.params,
      p.paramPrefixes,
      p.paramSuffixes,
      ...p.paramCombinations,
    ]) {
      for (const entry of list) expect(entry).toBe(entry.toLowerCase());
    }
  });

  it('never lists a protected parameter as a tracking parameter', () => {
    const cleaner = new Cleaner();
    for (const rule of defaultRuleSet.rules) {
      for (const param of rule.params ?? []) {
        const r = cleaner.clean(`https://neutral.example/x?${encodeURIComponent(param)}=1`, { mode: 'strict' });
        expect(r.status === 'protected', `${param} is both tracking and protected`).toBe(false);
      }
    }
  });
});

describe('engine behaviour', () => {
  it('reports rule ids and never reports values', () => {
    const r = cleanUrl('https://example.com/?utm_source=SECRETVALUE&fbclid=OTHERSECRET');
    expect(r.removed).toEqual([
      { name: 'utm_source', location: 'query', ruleId: 'utm' },
      { name: 'fbclid', location: 'query', ruleId: 'click-ids' },
    ]);
    expect(JSON.stringify(r.removed)).not.toContain('SECRET');
  });

  it('marks fragment removals', () => {
    const r = cleanUrl('https://example.com/#utm_source=x', { mode: 'strict' });
    expect(r.removed[0]?.location).toBe('fragment');
    expect(r.url).toBe('https://example.com/');
  });

  it('defaults to clean mode', () => {
    expect(cleanUrl('https://example.com/?ref=x').status).toBe('unchanged');
    expect(cleanUrl('https://example.com/?utm_source=x').status).toBe('cleaned');
  });

  it('does not throw on non-string input at runtime', () => {
    expect(cleanUrl(undefined as unknown as string).status).toBe('invalid');
  });

  it('supports custom rule sets', () => {
    const custom = validateRuleSet({
      schemaVersion: 1,
      rules: [{ id: 'x', description: '', mode: 'clean', params: ['foo'] }],
      protection: {
        domains: [],
        pathKeywords: [],
        params: [],
        paramPrefixes: [],
        paramSuffixes: [],
        paramCombinations: [],
      },
    });
    const c = new Cleaner(custom);
    expect(c.clean('https://e.example/?foo=1&utm_source=2').url).toBe('https://e.example/?utm_source=2');
  });
});

describe('properties', () => {
  const trackingKeys = defaultRuleSet.rules
    .filter((r) => r.domains === undefined && r.mode === 'clean')
    .flatMap((r) => r.params ?? []);
  const safeKey = fc
    .stringMatching(/^[a-z]{1,8}$/)
    .filter((k) => !k.startsWith('utm') && !k.endsWith('token') && !k.endsWith('signature'));
  const keyArb = fc.oneof(fc.constantFrom(...trackingKeys), safeKey);
  const valueArb = fc.stringMatching(/^[A-Za-z0-9%._~-]{0,10}$/).filter((v) => !/%(?![0-9A-F]{2})/.test(v));
  const urlArb = fc
    .tuple(
      fc.constantFrom('https://example.com/', 'http://shop.example/item', 'https://a.b.example/x/y'),
      fc.array(fc.tuple(keyArb, valueArb), { maxLength: 8 }),
    )
    .map(([base, params]) => ({
      base,
      params,
      url: params.length ? `${base}?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : base,
    }));

  it('never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary' }),
        fc.constantFrom('clean', 'strict', 'bypass') as fc.Arbitrary<'clean' | 'strict' | 'bypass'>,
        (s, mode) => {
          const r = cleanUrl(s, { mode });
          expect(typeof r.url).toBe('string');
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(urlArb, ({ url }) => {
        const once = cleanUrl(url, { mode: 'strict' });
        const twice = cleanUrl(once.url, { mode: 'strict' });
        expect(twice.url).toBe(once.url);
        expect(['unchanged', 'protected']).toContain(twice.status);
      }),
      { numRuns: 1000 },
    );
  });

  it('removes every tracking key and keeps every other segment in order', () => {
    fc.assert(
      fc.property(urlArb, ({ base, params, url }) => {
        const r = cleanUrl(url);
        if (r.status === 'protected') return;
        const kept = params.filter(([k]) => !trackingKeys.includes(k)).map(([k, v]) => `${k}=${v}`);
        const expected = kept.length ? `${base}?${kept.join('&')}` : base;
        expect(r.url).toBe(expected);
      }),
      { numRuns: 1000 },
    );
  });
});
