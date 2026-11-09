/**
 * Untrackable cleaning engine (TypeScript implementation).
 *
 * Normative specification: docs/architecture/engine-spec.md
 * Must stay behaviourally identical to crates/untrackable-core (Rust);
 * both are verified against tests/fixtures/cases.json.
 *
 * Security notes:
 *  - All input is untrusted. The engine never throws on any string input.
 *  - The engine never logs and never performs I/O.
 *  - Parameter values are never copied into the result metadata.
 */
import { defaultRuleSet, type Rule, type RuleSet } from './rules.js';

export type Mode = 'clean' | 'strict' | 'bypass';

export type Status = 'cleaned' | 'unchanged' | 'protected' | 'bypassed' | 'excepted' | 'unsupported' | 'invalid';

export interface RemovedParam {
  /** Raw (still percent-encoded) key as it appeared in the input. */
  readonly name: string;
  readonly location: 'query' | 'fragment';
  readonly ruleId: string;
}

export interface CleanResult {
  readonly url: string;
  readonly changed: boolean;
  readonly status: Status;
  readonly removed: readonly RemovedParam[];
  /** Machine-readable reason for `protected` results, e.g. `path:oauth`. */
  readonly reason?: string;
}

export interface CleanOptions {
  readonly mode?: Mode;
  /** User-defined domains that are never cleaned (subdomains included). */
  readonly exceptions?: readonly string[];
}

interface CompiledRule {
  readonly rule: Rule;
  readonly params: ReadonlySet<string>;
  readonly prefixes: readonly string[];
  readonly domains: readonly string[] | undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

/** ASCII-only lower-casing (spec: only A-Z are changed). */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function percentDecodeOr(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Normalise a raw query key for matching: `+` → space, percent-decode, ASCII lower-case. */
export function normaliseKey(rawKey: string): string {
  return asciiLower(percentDecodeOr(rawKey.replace(/\+/g, ' ')));
}

/** `host` equals `domain` or is a subdomain of it. */
export function domainMatches(host: string, domain: string): boolean {
  return host === domain || (host.length > domain.length && host.endsWith('.' + domain));
}

/**
 * Normalise a user-supplied exception entry to an ASCII (punycode) host name,
 * or '' if unusable. Accepts bare domains, `*.domain` and full URLs.
 */
export function normaliseException(entry: string): string {
  let e = asciiLower(trimC0(entry));
  if (e.startsWith('*.')) e = e.slice(2);
  if (e === '') return '';
  let host: string;
  try {
    host = new URL(e.includes('://') ? e : `http://${e}`).hostname;
  } catch {
    return '';
  }
  const h = stripTrailingDots(asciiLower(host));
  return isSaneHost(h) ? h : '';
}

/**
 * Hosts must be ASCII host names (after IDNA) or bracketed IPv6 literals.
 * Guards against parsers that are more lenient than the WHATWG standard
 * (Chromium's URL implementation percent-encodes e.g. spaces in hosts).
 */
function isSaneHost(host: string): boolean {
  return /^(?:[a-z0-9_.-]+|\[[0-9a-f:.]+\])$/.test(host);
}

function stripTrailingDots(host: string): string {
  let h = host;
  while (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/** Strip leading/trailing characters <= U+0020 (WHATWG URL trimming). */
function trimC0(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start++;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end--;
  return s.slice(start, end);
}

function rawKeyOf(segment: string): string {
  const eq = segment.indexOf('=');
  return eq === -1 ? segment : segment.slice(0, eq);
}

/** A fragment is param-shaped if it contains `=`, no `/` or `?`, and is not a text fragment (`:~:`). */
export function isParamShapedFragment(fragment: string): boolean {
  return fragment.includes('=') && !fragment.includes('/') && !fragment.includes('?') && !fragment.startsWith(':~:');
}

export class Cleaner {
  readonly ruleSet: RuleSet;
  private readonly compiled: readonly CompiledRule[];
  private readonly pathKeywordRes: readonly { kw: string; re: RegExp }[];
  private readonly protectedParams: ReadonlySet<string>;

  constructor(ruleSet: RuleSet = defaultRuleSet) {
    this.ruleSet = ruleSet;
    this.compiled = ruleSet.rules.map((rule) => ({
      rule,
      params: new Set(rule.params ?? []),
      prefixes: rule.prefixes ?? [],
      domains: rule.domains,
    }));
    this.pathKeywordRes = ruleSet.protection.pathKeywords.map((kw) => ({
      kw,
      re: new RegExp(`(^|[/_.-])(${escapeRegExp(kw)})($|[/_.0-9-])`),
    }));
    this.protectedParams = new Set(ruleSet.protection.params);
  }

  clean(input: string, options: CleanOptions = {}): CleanResult {
    const mode: Mode = options.mode ?? 'clean';
    const unchanged = (status: Status, reason?: string): CleanResult =>
      reason === undefined
        ? { url: input, changed: false, status, removed: [] }
        : { url: input, changed: false, status, removed: [], reason };

    if (typeof input !== 'string') return unchanged('invalid');
    const trimmed = trimC0(input);
    if (/[\t\n\r]/.test(trimmed)) return unchanged('invalid');

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return unchanged('invalid');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return unchanged('unsupported');
    if (!isSaneHost(asciiLower(parsed.hostname))) return unchanged('invalid');
    if (mode === 'bypass') return unchanged('bypassed');

    const host = stripTrailingDots(asciiLower(parsed.hostname));

    for (const entry of options.exceptions ?? []) {
      const ex = normaliseException(entry);
      if (ex !== '' && domainMatches(host, ex)) return unchanged('excepted');
    }

    // Raw string surgery boundaries (see spec).
    const hashIdx = trimmed.indexOf('#');
    const fragmentStart = hashIdx === -1 ? trimmed.length : hashIdx;
    const qIdx = trimmed.indexOf('?');
    const queryStart = qIdx !== -1 && qIdx < fragmentStart ? qIdx : -1;
    const prefix = trimmed.slice(0, queryStart === -1 ? fragmentStart : queryStart);
    const query = queryStart === -1 ? undefined : trimmed.slice(queryStart + 1, fragmentStart);
    const fragment = hashIdx === -1 ? undefined : trimmed.slice(hashIdx + 1);

    const reason = this.protectionReason(host, parsed.pathname, query, fragment);
    if (reason !== undefined) return unchanged('protected', reason);

    const applicable = this.compiled.filter(
      (c) =>
        (c.rule.mode === 'clean' || mode === 'strict') &&
        (c.domains === undefined || c.domains.some((d) => domainMatches(host, d))),
    );

    const removed: RemovedParam[] = [];
    const cleanPart = (part: string, location: 'query' | 'fragment'): string =>
      part
        .split('&')
        .filter((segment) => {
          const rawKey = rawKeyOf(segment);
          const key = normaliseKey(rawKey);
          const match = applicable.find((c) => c.params.has(key) || c.prefixes.some((p) => key.startsWith(p)));
          if (match === undefined) return true;
          removed.push({ name: rawKey, location, ruleId: match.rule.id });
          return false;
        })
        .join('&');

    const newQuery = query === undefined ? undefined : cleanPart(query, 'query');
    const removedFromQuery = removed.length;
    const newFragment =
      fragment !== undefined && mode === 'strict' && isParamShapedFragment(fragment)
        ? cleanPart(fragment, 'fragment')
        : fragment;
    const removedFromFragment = removed.length - removedFromQuery;

    if (removed.length === 0) return unchanged('unchanged');

    // Drop `?` / `#` only when that part became empty through removal.
    let url = prefix;
    if (newQuery !== undefined && !(newQuery === '' && removedFromQuery > 0)) url += '?' + newQuery;
    if (newFragment !== undefined && !(newFragment === '' && removedFromFragment > 0)) url += '#' + newFragment;
    return { url, changed: url !== input, status: 'cleaned', removed };
  }

  private protectionReason(
    host: string,
    pathname: string,
    query: string | undefined,
    fragment: string | undefined,
  ): string | undefined {
    const p = this.ruleSet.protection;
    const domain = p.domains.find((d) => domainMatches(host, d));
    if (domain !== undefined) return `domain:${domain}`;

    const path = asciiLower(percentDecodeOr(pathname));
    const kw = this.pathKeywordRes.find(({ re }) => re.test(path));
    if (kw !== undefined) return `path:${kw.kw}`;

    const keys: string[] = [];
    if (query !== undefined) for (const seg of query.split('&')) keys.push(normaliseKey(rawKeyOf(seg)));
    if (fragment !== undefined && fragment.includes('=')) {
      for (const seg of fragment.split('&')) keys.push(normaliseKey(rawKeyOf(seg)));
    }
    for (const key of keys) {
      if (key === '') continue;
      if (
        this.protectedParams.has(key) ||
        p.paramPrefixes.some((x) => key.startsWith(x)) ||
        p.paramSuffixes.some((x) => key.endsWith(x))
      ) {
        return `param:${key}`;
      }
    }
    const keySet = new Set(keys);
    const combo = p.paramCombinations.find((c) => c.every((k) => keySet.has(k)));
    if (combo !== undefined) return `combination:${combo.join('+')}`;
    return undefined;
  }
}

const defaultCleaner = new Cleaner();

/** Clean a URL with the built-in rule set. Never throws. */
export function cleanUrl(input: string, options: CleanOptions = {}): CleanResult {
  return defaultCleaner.clean(input, options);
}
