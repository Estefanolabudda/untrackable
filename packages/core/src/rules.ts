import rulesJson from '../../../rules/rules.json' with { type: 'json' };

/** Which cleaning modes a rule participates in. `clean` rules also apply in strict mode. */
export type RuleMode = 'clean' | 'strict';

export interface Rule {
  readonly id: string;
  readonly description: string;
  readonly mode: RuleMode;
  /** Restrict the rule to these registrable domains (and their subdomains). */
  readonly domains?: readonly string[];
  /** Exact parameter names (lower-case). */
  readonly params?: readonly string[];
  /** Parameter name prefixes (lower-case). */
  readonly prefixes?: readonly string[];
}

export interface ProtectionRules {
  readonly domains: readonly string[];
  readonly pathKeywords: readonly string[];
  /** Plain substrings of the decoded, lower-cased path (catches camelCase / joined words). */
  readonly pathSubstrings: readonly string[];
  readonly params: readonly string[];
  readonly paramPrefixes: readonly string[];
  readonly paramSuffixes: readonly string[];
  readonly paramCombinations: readonly (readonly string[])[];
  /**
   * Parameter names that protect a URL in experimental mode only (optional,
   * default empty). Functional names too common to protect in Clean/Strict.
   */
  readonly experimentalParams?: readonly string[];
}

export interface RuleSet {
  readonly schemaVersion: number;
  readonly rules: readonly Rule[];
  readonly protection: ProtectionRules;
}

const EMPTY_PROTECTION: ProtectionRules = Object.freeze({
  domains: [],
  pathKeywords: [],
  pathSubstrings: [],
  params: [],
  paramPrefixes: [],
  paramSuffixes: [],
  paramCombinations: [],
});

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new Error(`unknown field ${where}.${key}`);
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Validate an untrusted rule set (e.g. a future imported rule list).
 * Throws a descriptive Error when the structure is invalid.
 */
export function validateRuleSet(value: unknown): RuleSet {
  if (typeof value !== 'object' || value === null) throw new Error('rule set must be an object');
  const v = value as Record<string, unknown>;
  rejectUnknownKeys(v, ['schemaVersion', 'rules', 'protection'], 'ruleSet');
  if (v.schemaVersion !== 1) throw new Error('unsupported schemaVersion');
  if (!Array.isArray(v.rules)) throw new Error('rules must be an array');
  const ids = new Set<string>();
  for (const r of v.rules as unknown[]) {
    if (typeof r !== 'object' || r === null) throw new Error('rule must be an object');
    const rule = r as Record<string, unknown>;
    rejectUnknownKeys(rule, ['id', 'description', 'mode', 'domains', 'params', 'prefixes'], 'rule');
    if (typeof rule.id !== 'string' || rule.id === '') throw new Error('rule.id must be a non-empty string');
    if (typeof rule.description !== 'string') throw new Error(`${rule.id}.description must be a string`);
    if (ids.has(rule.id)) throw new Error(`duplicate rule id ${rule.id}`);
    ids.add(rule.id);
    if (rule.mode !== 'clean' && rule.mode !== 'strict') throw new Error(`invalid mode in ${rule.id}`);
    if (Array.isArray(rule.domains) && rule.domains.length === 0) {
      throw new Error(`${rule.id}.domains must not be empty (omit it for a global rule)`);
    }
    for (const key of ['domains', 'params', 'prefixes'] as const) {
      if (rule[key] !== undefined && !isStringArray(rule[key])) {
        throw new Error(`${rule.id}.${key} must be a string array`);
      }
      if (isStringArray(rule[key]) && (rule[key] as string[]).some((s) => /[A-Z]/.test(s) || s === '')) {
        throw new Error(`${rule.id}.${key} entries must be non-empty lower-case strings`);
      }
    }
  }
  // Omitting the whole protection object means "no protection" (same as Rust).
  if (v.protection === undefined) v.protection = EMPTY_PROTECTION;
  const p = v.protection as Record<string, unknown> | undefined;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new Error('protection must be an object');
  rejectUnknownKeys(
    p,
    [
      'description',
      'domains',
      'pathKeywords',
      'pathSubstrings',
      'params',
      'paramPrefixes',
      'paramSuffixes',
      'paramCombinations',
      'experimentalParams',
    ],
    'protection',
  );
  if (p.description !== undefined && typeof p.description !== 'string') {
    throw new Error('protection.description must be a string');
  }
  for (const key of [
    'domains',
    'pathKeywords',
    'pathSubstrings',
    'params',
    'paramPrefixes',
    'paramSuffixes',
  ] as const) {
    if (!isStringArray(p[key])) throw new Error(`protection.${key} must be a string array`);
  }
  if (p.experimentalParams !== undefined && !isStringArray(p.experimentalParams)) {
    throw new Error('protection.experimentalParams must be a string array');
  }
  if (!Array.isArray(p.paramCombinations) || !p.paramCombinations.every(isStringArray)) {
    throw new Error('protection.paramCombinations must be an array of string arrays');
  }
  const lists = [
    ...(['domains', 'pathKeywords', 'pathSubstrings', 'params', 'paramPrefixes', 'paramSuffixes'] as const).map(
      (k) => p[k] as string[],
    ),
    ...(p.paramCombinations as string[][]),
    (p.experimentalParams as string[] | undefined) ?? [],
  ];
  for (const list of lists) {
    if (list.some((s) => s === '' || /[A-Z]/.test(s))) {
      throw new Error('protection entries must be non-empty lower-case strings');
    }
  }
  if ((p.paramCombinations as string[][]).some((c) => c.length === 0)) {
    throw new Error('protection.paramCombinations entries must not be empty');
  }
  return value as RuleSet;
}

/** The built-in rule set shipped with Untrackable (rules/rules.json). */
export const defaultRuleSet: RuleSet = validateRuleSet(rulesJson);
