import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cleanUrl, type Mode } from '../src/index.js';

interface Case {
  name: string;
  input: string;
  mode?: Mode;
  exceptions?: string[];
  expected: string;
  status: string;
  removed?: string[];
  reason?: string;
}

const fixturePath = fileURLToPath(new URL('../../../tests/fixtures/cases.json', import.meta.url));
const { cases } = JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: Case[] };

describe('shared conformance fixtures', () => {
  it('has a meaningful number of cases', () => {
    expect(cases.length).toBeGreaterThan(80);
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const result = cleanUrl(c.input, { mode: c.mode ?? 'clean', exceptions: c.exceptions ?? [] });
    expect(result.url).toBe(c.expected);
    expect(result.status).toBe(c.status);
    expect(result.changed).toBe(c.expected !== c.input);
    if (c.removed !== undefined) expect(result.removed.map((r) => r.name)).toEqual(c.removed);
    if (c.reason !== undefined) expect(result.reason).toBe(c.reason);
    if (c.status !== 'cleaned') expect(result.removed).toEqual([]);
  });
});
