// Differential conformance test: TypeScript engine vs Rust engine.
//
// Generates a deterministic corpus from rules/rules.json – every rule, every
// parameter and prefix, every rule domain, every protection signal – mixed
// with random spelling, encoding, values, fragments and exceptions, runs both
// engines and compares url, status, removed keys and reason. New rules are
// covered automatically.
//
// Usage: node scripts/differential.mjs [--cases N] [--seed S]
// Requires: npm ci, and a Rust toolchain (builds the `clean` example).
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const RANDOM_CASES = arg('--cases', 20000);
let seed = arg('--seed', 20261109) >>> 0;

// Deterministic PRNG (mulberry32).
function rand() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const chance = (p) => rand() < p;

const rules = JSON.parse(readFileSync(`${root}/rules/rules.json`, 'utf8'));
const p = rules.protection;

function randomCase(s) {
  return [...s].map((c) => (chance(0.3) ? c.toUpperCase() : c)).join('');
}
function encodeSome(s) {
  return [...s]
    .map((c) => (/[a-z_.-]/i.test(c) && chance(0.15) ? `%${c.charCodeAt(0).toString(16).toUpperCase()}` : c))
    .join('');
}
function variantKey(k) {
  let key = k;
  if (chance(0.3)) key = randomCase(key);
  if (chance(0.1)) key = encodeSome(key);
  if (chance(0.05)) key = key.replace('_', pick(['+', '%2B', '%20']));
  if (chance(0.05)) key = pick(['%FF', '%C3', 'Ä', 'ß', '%E2%80%8B']) + key;
  if (chance(0.03)) key = key + pick(['%ZZ', '%', '+']);
  return key;
}
const values = [
  '',
  '1',
  'abc',
  'a%20b',
  'caf%C3%A9',
  'x+y',
  'a=b',
  '%ZZ',
  'größe',
  'https%3A%2F%2Fe.example%2F%3Futm_source%3D1',
];
const neutralKeys = [
  'id',
  'q',
  'page',
  'sort',
  'lang',
  'v',
  'list',
  't',
  'k',
  'th',
  'size',
  'color',
  'code',
  'state',
  'expires',
  's',
];
const hostsBase = [
  'example.com',
  'shop.example',
  'news.example.org',
  'bücher.example',
  'xn--mnchen-3ya.example',
  '192.168.0.1',
  '[::1]',
];
const ruleDomains = rules.rules.flatMap((r) => r.domains ?? []);
const prefixKeys = rules.rules.flatMap((r) =>
  (r.prefixes ?? []).map((x) => x + pick(['x', 'campaign', 'new_thing', ''])),
);
const trackingKeys = [...rules.rules.flatMap((r) => r.params ?? []), ...prefixKeys];
const protectedKeys = [
  ...p.params,
  ...p.paramPrefixes.map((x) => x + 'x'),
  ...p.paramSuffixes.map((x) => 'my' + x),
  ...(p.experimentalParams ?? []),
];
const pathWords = [...p.pathKeywords, ...p.pathSubstrings];

function host() {
  const h = chance(0.5) ? pick(ruleDomains) : chance(0.1) ? pick(p.domains) : pick(hostsBase);
  if (h.startsWith('[') || /^\d/.test(h)) return h;
  return (
    (chance(0.3) ? pick(['www.', 'm.', 'a.b.']) : '') + (chance(0.2) ? h.toUpperCase() : h) + (chance(0.05) ? '.' : '')
  );
}
function path() {
  const segs = [];
  const n = Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) {
    if (chance(0.15)) {
      const w = pick(pathWords);
      segs.push(pick([w, `${w}-x`, `my${w}`, `${w}2`, randomCase(w), `x_${w}.html`, encodeSome(w), `a%2F${w}`]));
    } else
      segs.push(pick(['a', 'article', 'dp', 'B0X1', 'watch', 'author', 'display', 'straße', 's-anzeige', 'p%20q']));
  }
  return '/' + segs.join('/') + (chance(0.1) ? '/' : '');
}
function params() {
  const n = Math.floor(rand() * 7);
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = rand();
    const key =
      r < 0.5 ? variantKey(pick(trackingKeys)) : r < 0.6 ? variantKey(pick(protectedKeys)) : pick(neutralKeys);
    out.push(chance(0.08) ? key : `${key}=${pick(values)}`);
  }
  if (chance(0.05)) out.splice(Math.floor(rand() * (out.length + 1)), 0, '');
  return out;
}
function url() {
  let u = `${pick(['https', 'http', 'HTTPS'])}://${chance(0.05) ? 'user@' : ''}${host()}${chance(0.05) ? ':8080' : ''}${path()}`;
  const q = params();
  if (q.length > 0 || chance(0.05)) u += '?' + q.join('&');
  if (chance(0.25)) {
    u +=
      '#' +
      pick([
        'section',
        params().join('&'),
        '/route?utm_source=x',
        ':~:text=a&utm_medium=b',
        '',
        `/cb?${params().join('&')}`,
        `a=1/b&${params().join('&')}`,
      ]);
  }
  if (chance(0.03)) u = pick([' ', '\u0001', '']) + u + pick([' ', '  ', '']);
  // whitespace / control characters inside the URL (path, before '?', in values)
  if (chance(0.05)) {
    const i = Math.floor(rand() * u.length);
    u = u.slice(0, i) + pick([' ', '\u0001', '\u001f', '\u007f']) + u.slice(i);
  }
  return u;
}

const requests = [];
// 1. Exhaustive: every tracking key and protection signal on every rule domain.
for (const mode of ['clean', 'strict', 'experimental']) {
  for (const r of rules.rules) {
    for (const d of r.domains ?? ['example.com']) {
      for (const k of [...(r.params ?? []), ...(r.prefixes ?? []).map((x) => x + 'x')]) {
        requests.push({ input: `https://www.${d}/a?id=1&${k}=v&${k.toUpperCase()}=w`, mode, exceptions: [] });
      }
    }
  }
  for (const w of pathWords) requests.push({ input: `https://example.com/x/${w}?utm_source=1`, mode, exceptions: [] });
  for (const k of protectedKeys)
    requests.push({ input: `https://example.com/x?${k}=1&utm_source=1`, mode, exceptions: [] });
  for (const c of p.paramCombinations) {
    requests.push({
      input: `https://example.com/x?${c.map((k) => `${k}=1`).join('&')}&utm_source=1`,
      mode,
      exceptions: [],
    });
  }
  for (const d of p.domains) requests.push({ input: `https://sub.${d}/x?utm_source=1`, mode, exceptions: [] });
}
// 1b. Sensitive URL regression corpus, every mode and the explicit strip action.
for (const { url: input } of JSON.parse(readFileSync(`${root}/tests/corpus/sensitive-urls.json`, 'utf8')).entries) {
  for (const mode of ['clean', 'strict', 'experimental', 'bypass']) requests.push({ input, mode, exceptions: [] });
  requests.push({ input, strip: true });
}
// 2. Random corpus.
for (let i = 0; i < RANDOM_CASES; i++) {
  const exceptions = chance(0.1)
    ? [pick([...ruleDomains, ...hostsBase, '*.example.com', 'https://shop.example/x', 'bad host'])]
    : [];
  requests.push({ input: url(), mode: pick(['clean', 'clean', 'strict', 'experimental', 'bypass']), exceptions });
  // Explicit "without query parameters" action on the same kind of input.
  if (chance(0.25)) requests.push({ input: url(), strip: true });
}

// TypeScript engine (bundled in memory, same code as the extension).
const bundle = await build({
  entryPoints: [`${root}/packages/core/src/index.ts`],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'silent',
});
const core = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

// Rust engine (via `cargo run`, so CARGO_TARGET_DIR and friends are honoured).
function runRust(args, input) {
  const res = spawnSync('cargo', ['run', '-q', '--locked', '--example', 'clean', '--', ...args], {
    cwd: root,
    input,
    maxBuffer: 1 << 30,
    encoding: 'utf8',
  });
  if (res.error) throw res.error;
  return res;
}
const rust = runRust(['--jsonl'], requests.map((r) => JSON.stringify(r)).join('\n') + '\n');
if (rust.status !== 0) {
  console.error(rust.stderr);
  process.exit(1);
}
const rustResults = rust.stdout
  .trimEnd()
  .split('\n')
  .map((l) => JSON.parse(l));
if (rustResults.length !== requests.length)
  throw new Error(`expected ${requests.length} results, got ${rustResults.length}`);

const summarise = (r) =>
  JSON.stringify([r.url, r.status, r.removed.map((x) => `${x.name}@${x.location}:${x.ruleId}`), r.reason ?? null]);
const diffs = [];
const statuses = {};
requests.forEach((req, i) => {
  const ts = req.strip
    ? core.stripQuery(req.input)
    : core.cleanUrl(req.input, { mode: req.mode, exceptions: req.exceptions });
  statuses[ts.status] = (statuses[ts.status] ?? 0) + 1;
  if (summarise(ts) !== summarise(rustResults[i]))
    diffs.push({ req, ts: summarise(ts), rust: summarise(rustResults[i]) });
});

// 3. Rule-set validation parity on mutated copies of rules.json.
const mutations = [
  (rs) => (rs.extra = 1),
  (rs) => (pick(rs.rules).param = ['x']),
  (rs) => (rs.protection.extra = []),
  (rs) => (pick(rs.rules).domains = null),
  (rs) => (pick(rs.rules).domains = []),
  (rs) => (pick(rs.rules).description = 5),
  (rs) => delete pick(rs.rules).description,
  (rs) => (pick(rs.rules).id = ''),
  (rs) => (rs.rules[1].id = rs.rules[0].id),
  (rs) => (pick(rs.rules).mode = 'weird'),
  (rs) => (pick(rs.rules).params ??= []).push('UPPER'),
  (rs) => (pick(rs.rules).params ??= []).push(''),
  (rs) => (pick(rs.rules).params ??= []).push('äöü'),
  (rs) => delete rs.protection,
  (rs) => {
    const key = pick([
      'domains',
      'pathKeywords',
      'pathSubstrings',
      'params',
      'paramPrefixes',
      'paramSuffixes',
      'paramCombinations',
      'experimentalParams',
    ]);
    rs.protection = Object.fromEntries(Object.entries(rs.protection).filter(([k]) => k !== key));
  },
  (rs) => (rs.protection.description = 7),
  (rs) => (rs.protection.experimentalParams = null),
  (rs) => (rs.protection.experimentalParams = 'code'),
  (rs) => (rs.protection.experimentalParams ??= []).push('UPPER'),
  (rs) => (rs.protection.experimentalParams ??= []).push(''),
  (rs) => (rs.schemaVersion = 2),
  (rs) => (rs.rules = {}),
  () => {},
];
const tmp = mkdtempSync(join(tmpdir(), 'untrackable-validate-'));
let validationMismatches = 0;
try {
  for (let i = 0; i < 60; i++) {
    const rs = JSON.parse(JSON.stringify(rules));
    mutations[i % mutations.length](rs);
    const file = join(tmp, `rules-${i}.json`);
    writeFileSync(file, JSON.stringify(rs));
    let tsOk = true;
    try {
      core.validateRuleSet(JSON.parse(JSON.stringify(rs)));
    } catch {
      tsOk = false;
    }
    const r = runRust(['--rules', file, '--validate'], '');
    const rustOk = r.status === 0 && JSON.parse(r.stdout.trim() || '{}').ok === true;
    if (tsOk !== rustOk) {
      validationMismatches++;
      console.error(`validation mismatch (mutation ${i % mutations.length}): ts=${tsOk} rust=${rustOk}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (validationMismatches > 0) process.exit(1);
console.log('Rule-set validation agrees on 60 mutated rule sets.');

console.log(`differential: ${requests.length} cases, status mix ${JSON.stringify(statuses)}`);
if (diffs.length > 0) {
  console.error(`${diffs.length} divergences, first ${Math.min(20, diffs.length)}:`);
  for (const d of diffs.slice(0, 20)) console.error(JSON.stringify(d));
  process.exit(1);
}
console.log('TypeScript and Rust engines agree on every case.');
