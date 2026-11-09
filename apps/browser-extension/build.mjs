// Build the extension into dist/ (and optionally a zip in artifacts/).
// Usage: node build.mjs [--zip]
import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: ['background', 'content', 'popup', 'options', 'offscreen'].map((n) => join(root, 'src', `${n}.ts`)),
  outdir: dist,
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  minify: false, // readable output simplifies store review and auditing
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'warning',
});

cpSync(join(root, 'static'), dist, { recursive: true });

// Keep manifest version in sync with package.json.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

if (process.argv.includes('--zip')) {
  const out = join(root, '..', '..', 'artifacts');
  mkdirSync(out, { recursive: true });
  const zip = join(out, `untrackable-chromium-${pkg.version}.zip`);
  rmSync(zip, { force: true });
  // Fixed timestamps make the archive byte-for-byte reproducible.
  const epoch = new Date(Number(process.env.SOURCE_DATE_EPOCH ?? 946684800) * 1000);
  for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
    utimesSync(join(entry.parentPath, entry.name), epoch, epoch);
  }
  // -X: omit extra file attributes; files sorted for reproducibility.
  const files = readdirSync(dist, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dist, join(e.parentPath, e.name)))
    .sort();
  execFileSync('zip', ['-X', '-q', zip, ...files], { cwd: dist, env: { ...process.env, TZ: 'UTC' } });
  console.log(`packaged ${zip}`);
}
console.log('built', dist);
