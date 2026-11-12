/**
 * Regression corpus of sensitive real-world URL shapes (tests/corpus/sensitive-urls.json).
 * 'preserved' = engine output equals the input AND navigation (DNR rules via the
 * simulator) leaves it unchanged; 'changed' = at least one of them modifies it.
 * Changing an expectation is a reviewed decision, never a test fix.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cleanUrl, compileDnrRules } from '../src/index.js';
import { simulate } from './dnr-simulator.js';

type Mode = 'clean' | 'strict' | 'experimental';
interface Entry {
  category: string;
  url: string;
  expect: Record<Mode, 'preserved' | 'changed'>;
  note?: string;
}

const path = fileURLToPath(new URL('../../../tests/corpus/sensitive-urls.json', import.meta.url));
const { entries } = JSON.parse(readFileSync(path, 'utf8')) as { entries: Entry[] };
const modes: Mode[] = ['clean', 'strict', 'experimental'];
const rules = Object.fromEntries(modes.map((m) => [m, compileDnrRules({ mode: m, exceptions: [] })])) as Record<
  Mode,
  ReturnType<typeof compileDnrRules>
>;

describe('sensitive URL regression corpus', () => {
  it('is substantial and has unique URLs', () => {
    expect(entries.length).toBeGreaterThan(200);
    expect(new Set(entries.map((e) => e.url)).size).toBe(entries.length);
  });

  for (const mode of modes) {
    it.each(entries.map((e) => [`${e.category}: ${e.url}`, e] as const))(`${mode}: %s`, (_n, e) => {
      const engine = cleanUrl(e.url, { mode });
      const canonical = new URL(e.url).href;
      const navigation = simulate(rules[mode], canonical);
      const preserved = engine.url === e.url && navigation === canonical;
      expect(preserved ? 'preserved' : 'changed', `engine=${engine.url} navigation=${navigation}`).toBe(e.expect[mode]);
      // Safety: whatever the engine leaves alone, navigation must leave alone too.
      if (engine.url === e.url) expect(navigation).toBe(canonical);
    });
  }
});
