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

export type Mode = 'clean' | 'strict' | 'experimental' | 'bypass';

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
  const spaced = rawKey.replace(/\+/g, ' ');
  return asciiLower(spaced.includes('%') ? percentDecodeOr(spaced) : spaced);
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

/**
 * A parser strips trailing characters <= U+0020, which would silently change
 * the path or a value once the segment after them was removed. Encode them.
 */
function encodeTrailingWhitespace(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) <= 0x20) end--;
  if (end === url.length) return url;
  let tail = '';
  for (let i = end; i < url.length; i++) {
    tail += '%' + url.charCodeAt(i).toString(16).toUpperCase().padStart(2, '0');
  }
  return url.slice(0, end) + tail;
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

/**
 * Remove every non-empty query segment; keep the fragment verbatim (spec:
 * "Experimental mode: query stripping"). `input` is the untrimmed original.
 */
function stripParts(
  input: string,
  prefix: string,
  query: string | undefined,
  fragment: string | undefined,
): CleanResult {
  const segments = (query ?? '').split('&').filter((seg) => seg !== '');
  if (segments.length === 0) return { url: input, changed: false, status: 'unchanged', removed: [] };
  const removed: RemovedParam[] = segments.map((seg) => ({
    name: rawKeyOf(seg),
    location: 'query',
    ruleId: EXPERIMENTAL_RULE_ID,
  }));
  const url = encodeTrailingWhitespace(prefix + (fragment === undefined ? '' : '#' + fragment));
  return { url, changed: url !== input, status: 'cleaned', removed };
}

/** Split a trimmed URL into prefix / query / fragment (raw string surgery boundaries, see spec). */
function splitRaw(trimmed: string): { prefix: string; query: string | undefined; fragment: string | undefined } {
  const hashIdx = trimmed.indexOf('#');
  const fragmentStart = hashIdx === -1 ? trimmed.length : hashIdx;
  const qIdx = trimmed.indexOf('?');
  const queryStart = qIdx !== -1 && qIdx < fragmentStart ? qIdx : -1;
  return {
    prefix: trimmed.slice(0, queryStart === -1 ? fragmentStart : queryStart),
    query: queryStart === -1 ? undefined : trimmed.slice(queryStart + 1, fragmentStart),
    fragment: hashIdx === -1 ? undefined : trimmed.slice(hashIdx + 1),
  };
}

/**
 * Explicit user action "Copy/Open link without query parameters": strip the
 * whole query of an http(s) URL. Unlike `clean`, this ignores mode, exceptions
 * and protection signals – the user asked for exactly this link without its
 * query. Input validation (steps 1–3 of the spec) is the same. Never throws.
 */
export function stripQuery(input: string): CleanResult {
  const unchanged = (status: Status): CleanResult => ({ url: input, changed: false, status, removed: [] });
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
  const { prefix, query, fragment } = splitRaw(trimmed);
  return stripParts(input, prefix, query, fragment);
}

/** Spec signal `value:url`: the segment's raw value starts with an (encoded) http(s) URL. */
function valueIsUrl(segment: string): boolean {
  const eq = segment.indexOf('=');
  if (eq === -1) return false;
  const v = asciiLower(segment.slice(eq + 1, eq + 1 + 14));
  return ['http://', 'https://', 'http%3a%2f%2f', 'https%3a%2f%2f'].some((x) => v.startsWith(x));
}

/** `ruleId` reported for parameters removed by experimental query stripping. */
export const EXPERIMENTAL_RULE_ID = 'experimental';

export class Cleaner {
  readonly ruleSet: RuleSet;
  private readonly compiled: readonly CompiledRule[];
  private readonly pathKeywordRes: readonly { kw: string; re: RegExp }[];
  private readonly protectedParams: ReadonlySet<string>;
  private readonly experimentalParams: ReadonlySet<string>;

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
    this.experimentalParams = new Set(ruleSet.protection.experimentalParams ?? []);
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
    const { prefix, query, fragment } = splitRaw(trimmed);

    const reason = this.protectionReason(host, parsed.pathname, query, fragment, mode === 'experimental');
    if (reason !== undefined) return unchanged('protected', reason);

    // Query stripping: every non-empty segment goes, whatever its name.
    if (mode === 'experimental') return stripParts(input, prefix, query, fragment);

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
    url = encodeTrailingWhitespace(url);
    return { url, changed: url !== input, status: 'cleaned', removed };
  }

  private protectionReason(
    host: string,
    pathname: string,
    query: string | undefined,
    fragment: string | undefined,
    experimental: boolean,
  ): string | undefined {
    const p = this.ruleSet.protection;
    const domain = p.domains.find((d) => domainMatches(host, d));
    if (domain !== undefined) return `domain:${domain}`;

    const path = asciiLower(percentDecodeOr(pathname));
    const kw = this.pathKeywordRes.find(({ re }) => re.test(path));
    if (kw !== undefined) return `path:${kw.kw}`;
    const sub = p.pathSubstrings.find((x) => path.includes(x));
    if (sub !== undefined) return `path:${sub}`;

    const keys: string[] = [];
    if (query !== undefined) for (const seg of query.split('&')) keys.push(normaliseKey(rawKeyOf(seg)));
    if (fragment !== undefined && fragment.includes('=')) {
      for (const seg of fragment.split('&')) keys.push(normaliseKey(rawKeyOf(seg)));
    }
    for (const key of keys) {
      if (key === '') continue;
      if (
        this.protectedParams.has(key) ||
        (experimental && this.experimentalParams.has(key)) ||
        p.paramPrefixes.some((x) => key.startsWith(x)) ||
        p.paramSuffixes.some((x) => key.endsWith(x))
      ) {
        return `param:${key}`;
      }
    }
    const keySet = new Set(keys);
    const combo = p.paramCombinations.find((c) => c.every((k) => keySet.has(k)));
    if (combo !== undefined) return `combination:${combo.join('+')}`;
    if (experimental) {
      const segments = [...(query?.split('&') ?? []), ...(fragment?.includes('=') ? fragment.split('&') : [])];
      if (segments.some(valueIsUrl)) return 'value:url';
    }
    return undefined;
  }
}

const defaultCleaner = new Cleaner();

/** Clean a URL with the built-in rule set. Never throws. */
export function cleanUrl(input: string, options: CleanOptions = {}): CleanResult {
  return defaultCleaner.clean(input, options);
}
