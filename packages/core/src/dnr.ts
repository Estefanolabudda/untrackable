/**
 * Compiles the rule set + user settings into Chromium declarativeNetRequest
 * (DNR) rules for automatic navigation cleaning.
 *
 * DNR cannot run the engine's algorithm, so this is a deliberately
 * conservative approximation (see docs/architecture/overview.md):
 *  - removal uses queryTransform.removeParams (exact key names) for the
 *    common case, plus lower-priority case-insensitive regexSubstitution
 *    fallback rules that remove one remaining tracker per internal redirect
 *    (mixed-case spellings, global prefix rules such as utm_*). Chromium
 *    skips redirect rules whose result equals the request URL and falls
 *    through to the next matching rule, so the exact rules always run first,
 *  - protection signals become higher-priority `allow` rules,
 *  - fragments are never part of HTTP requests and are not touched.
 *
 * Pure function, no browser APIs: unit-testable in Node.
 */
import { asciiLower, domainMatches, normaliseException } from './engine.js';
import { defaultRuleSet, type Rule, type RuleSet } from './rules.js';

/** Minimal structural subset of chrome.declarativeNetRequest.Rule. */
export interface DnrRule {
  id: number;
  priority: number;
  action:
    | { type: 'allow' }
    | {
        type: 'redirect';
        redirect: { transform: { queryTransform: { removeParams: string[] } } } | { regexSubstitution: string };
      };
  condition: {
    resourceTypes: ['main_frame'];
    requestDomains?: string[];
    excludedRequestDomains?: string[];
    regexFilter?: string;
    isUrlFilterCaseSensitive?: boolean;
  };
}

export interface DnrSettings {
  readonly mode: 'clean' | 'strict';
  readonly exceptions: readonly string[];
}

export const PRIORITY = {
  caseInsensitiveFallback: 1,
  /** `allow` that stops the one-per-hop fallback chain on very long queries. */
  fallbackGuard: 2,
  globalRedirect: 3,
  domainRedirect: 4,
  protection: 5,
  userException: 6,
  /** Reserved for per-tab session rules created by the extension. */
  tabPause: 7,
} as const;

/** Rule id ranges, so callers can recognise rule kinds. */
export const ID_BASE = {
  globalRedirect: 1,
  domainRedirect: 100,
  caseInsensitiveFallback: 500,
  fallbackGuard: 999,
  protection: 1000,
  userException: 2000,
} as const;

/** Names per fallback regex. Case-insensitive RE2 programs grow fast; 4 stays well below Chromium's 2 KB limit (8 already fails for some names). */
const FALLBACK_CHUNK = 4;

const REGEX_CHUNK = 6;

/**
 * Chromium aborts after 20 redirects. The fallback removes one parameter per
 * redirect, so it is disabled (exact rules still run) once the URL has 16 or
 * more '&' after its first '?' (fragment included – errs towards not cleaning).
 * Written without '#'-exclusion on purpose: `[^&#]` repeated 16 times exceeds
 * Chromium's 2 KB regex memory limit, `[^&]` does not (verified).
 */
const MAX_FALLBACK_SEGMENTS = 16;

function escapeRe2(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Convert a user exception to an ASCII (punycode) domain usable in
 * requestDomains, or '' if it is not a valid host name.
 */
export function toAsciiDomain(entry: string): string {
  const host = normaliseException(entry);
  if (host === '') return '';
  try {
    const u = new URL(`http://${host}/`);
    if (u.hostname.startsWith('[')) return '';
    // Reject anything that smuggled in a port, path or credentials.
    if (u.port !== '' || u.username !== '' || u.pathname !== '/' || asciiLower(u.hostname) !== u.hostname) return '';
    return host;
  } catch {
    return '';
  }
}

function applies(rule: Rule, mode: DnrSettings['mode']): boolean {
  return rule.mode === 'clean' || mode === 'strict';
}

function uniq(items: Iterable<string>): string[] {
  return [...new Set(items)];
}

/**
 * removeParams matches keys case-sensitively, the engine does not. Add the
 * all-upper-case spelling (e.g. UTM_SOURCE) as a cheap partial bridge;
 * mixed-case spellings are only handled by copy / explicit cleaning.
 */
function withCaseVariants(params: readonly string[]): string[] {
  return uniq(params.flatMap((p) => [p, p.toUpperCase()]));
}

export function compileDnrRules(settings: DnrSettings, ruleSet: RuleSet = defaultRuleSet): DnrRule[] {
  const rules: DnrRule[] = [];
  const active = ruleSet.rules.filter((r) => applies(r, settings.mode));
  const globalParams = uniq(active.filter((r) => r.domains === undefined).flatMap((r) => r.params ?? []));

  // 1. Global redirect: remove globally applicable tracking parameters.
  if (globalParams.length > 0) {
    rules.push({
      id: ID_BASE.globalRedirect,
      priority: PRIORITY.globalRedirect,
      action: {
        type: 'redirect',
        redirect: { transform: { queryTransform: { removeParams: withCaseVariants(globalParams) } } },
      },
      // No regexFilter here on purpose: Chromium only falls through from a
      // no-op redirect to a lower-priority rule of the *other* matcher kind
      // (URL-pattern vs regex). Keeping the exact rules regex-free lets the
      // regex fallback run after them (verified in the e2e suite).
      condition: { resourceTypes: ['main_frame'] },
    });
  }

  // 2. Domain-specific redirects. Only one redirect can win per request, so
  //    every domain rule also carries the global parameters.
  const domains = uniq(active.flatMap((r) => r.domains ?? []));
  domains.forEach((domain, i) => {
    const params = uniq([
      ...globalParams,
      ...active.filter((r) => r.domains?.some((d) => domainMatches(domain, d))).flatMap((r) => r.params ?? []),
    ]);
    rules.push({
      id: ID_BASE.domainRedirect + i,
      priority: PRIORITY.domainRedirect,
      action: {
        type: 'redirect',
        redirect: { transform: { queryTransform: { removeParams: withCaseVariants(params) } } },
      },
      condition: { resourceTypes: ['main_frame'], requestDomains: [domain] },
    });
  });

  // 2b. Byte-preserving, case-insensitive fallback: removes one remaining
  //     tracker per redirect (mixed case such as Utm_Source, unlisted utm_*,
  //     queries the exact rules skip). Every hop strictly shortens the URL, so
  //     the chain terminates; the guard below keeps it under Chromium's limit.
  const patternsOf = (rs: readonly Rule[]): string[] =>
    uniq([
      ...rs.flatMap((r) => (r.prefixes ?? []).map((x) => `${escapeRe2(x)}[^=&#]*`)),
      ...rs.flatMap((r) => (r.params ?? []).map(escapeRe2)),
    ]);
  const fallbackGroups: { domains?: string[]; patterns: string[] }[] = [
    { patterns: patternsOf(active.filter((r) => r.domains === undefined)) },
    ...active
      .filter((r) => r.domains !== undefined)
      .map((r) => ({ domains: [...(r.domains ?? [])], patterns: patternsOf([r]) })),
  ];
  let fid: number = ID_BASE.caseInsensitiveFallback;
  for (const { domains: requestDomains, patterns } of fallbackGroups) {
    for (const group of chunk(patterns, FALLBACK_CHUNK)) {
      const names = `(?:${group.join('|')})`;
      const variants: [string, string][] = [
        // tracker followed by more parameters: drop it and its '&'
        [`^([^?#]*\\?(?:[^&#]*&)*?)${names}(?:=[^&#]*)?&(.*)$`, '\\1\\2'],
        // last parameter after others: drop it and the preceding '&'
        [`^([^?#]*\\?[^#]*?)&${names}(?:=[^&#]*)?(#.*)?$`, '\\1\\2'],
        // the only parameter: drop it and the '?'
        [`^([^?#]*)\\?${names}(?:=[^&#]*)?(#.*)?$`, '\\1\\2'],
      ];
      for (const [regexFilter, regexSubstitution] of variants) {
        rules.push({
          id: fid++,
          priority: PRIORITY.caseInsensitiveFallback,
          action: { type: 'redirect', redirect: { regexSubstitution } },
          condition: {
            resourceTypes: ['main_frame'],
            ...(requestDomains === undefined ? {} : { requestDomains }),
            regexFilter,
            isUrlFilterCaseSensitive: false,
          },
        });
      }
    }
  }
  if (fid >= ID_BASE.fallbackGuard) throw new Error('too many fallback rules for the reserved id range');
  rules.push({
    id: ID_BASE.fallbackGuard,
    priority: PRIORITY.fallbackGuard,
    action: { type: 'allow' },
    condition: { resourceTypes: ['main_frame'], regexFilter: `\\?(?:[^&]*&){${MAX_FALLBACK_SEGMENTS}}` },
  });

  // 3. Protection allow rules.
  const p = ruleSet.protection;
  let pid: number = ID_BASE.protection;
  const allow = (condition: Omit<DnrRule['condition'], 'resourceTypes'>): void => {
    rules.push({
      id: pid++,
      priority: PRIORITY.protection,
      action: { type: 'allow' },
      condition: { resourceTypes: ['main_frame'], ...condition },
    });
  };
  if (p.domains.length > 0) allow({ requestDomains: [...p.domains] });
  for (const group of chunk(p.pathKeywords, REGEX_CHUNK)) {
    allow({
      regexFilter: `^https?://[^/?#]*/(?:[^?#]*[/_.-])?(?:${group.map(escapeRe2).join('|')})(?:[/_.0-9?#-]|$)`,
      isUrlFilterCaseSensitive: false,
    });
  }
  for (const group of chunk(p.pathSubstrings, REGEX_CHUNK)) {
    allow({
      regexFilter: `^https?://[^/?#]*/[^?#]*(?:${group.map(escapeRe2).join('|')})`,
      isUrlFilterCaseSensitive: false,
    });
  }
  // DNR cannot percent-decode. Leave URLs alone whose path or parameter keys
  // contain an encoded letter, digit, '-', '.', '/' or '_' (could hide a
  // protection signal such as /x%2Fsso or /%32fa).
  const encodedWordChar = '%(?:[46][1-9a-f]|[57][0-9a]|2[def]|3[0-9]|5f)';
  allow({ regexFilter: `^https?://[^/?#]*/[^?#]*${encodedWordChar}`, isUrlFilterCaseSensitive: false });
  allow({ regexFilter: `[?&][^=&#]*${encodedWordChar}`, isUrlFilterCaseSensitive: false });
  for (const group of chunk(p.params, REGEX_CHUNK)) {
    allow({
      regexFilter: `[?&](?:${group.map(escapeRe2).join('|')})(?:[=&#]|$)`,
      isUrlFilterCaseSensitive: false,
    });
  }
  if (p.paramPrefixes.length > 0) {
    allow({ regexFilter: `[?&](?:${p.paramPrefixes.map(escapeRe2).join('|')})`, isUrlFilterCaseSensitive: false });
  }
  if (p.paramSuffixes.length > 0) {
    allow({
      regexFilter: `[?&][^=&#]*(?:${p.paramSuffixes.map(escapeRe2).join('|')})(?:[=&#]|$)`,
      isUrlFilterCaseSensitive: false,
    });
  }
  for (const combo of p.paramCombinations) {
    if (combo.length !== 2) continue; // only pairs are expressible compactly
    const [a, b] = combo.map((k) => `[?&]${escapeRe2(k)}(?:[=&#]|$)`);
    allow({ regexFilter: `${a}.*${b}|${b}.*${a}`, isUrlFilterCaseSensitive: false });
  }

  // 4. User exceptions.
  const exceptions = uniq(settings.exceptions.map(toAsciiDomain).filter((d) => d !== ''));
  if (exceptions.length > 0) {
    rules.push({
      id: ID_BASE.userException,
      priority: PRIORITY.userException,
      action: { type: 'allow' },
      condition: { resourceTypes: ['main_frame'], requestDomains: exceptions },
    });
  }
  return rules;
}
