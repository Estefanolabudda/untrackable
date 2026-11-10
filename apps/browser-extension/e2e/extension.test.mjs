// End-to-end tests: load the built extension (dist/) into a real Chromium and
// verify navigation cleaning, modes, exceptions, bypasses and clipboard features.
//
// Run: npm run test:e2e   (builds first)
// Requires Playwright's Chromium. Set CHROMIUM_PATH to use a specific binary.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
assert.ok(existsSync(join(dist, 'manifest.json')), 'run `npm run build` first');

/** Requests received by the local test server (path + query). */
const seen = [];
let server;
let port;
let context;
let sw;
let extensionId;
let userDataDir;
let selfLoopHits = 0;
let launderHits = 0;

const PAGE = `<!doctype html><html><body>
<input id="field" value="">
<p id="para"></p>
<a id="link" href="/landing?utm_source=x&amp;id=9">link</a>
</body></html>`;

async function waitFor(fn, what, timeout = 5000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Write settings via the service worker and wait until DNR reflects them. */
async function setSettings(patch) {
  await sw.evaluate(async (p) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set(p);
  }, patch);
  const expectRules = (patch.enabled ?? true) && !(patch.pausedUntil > Date.now());
  await waitFor(async () => {
    const rules = await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
    if (!expectRules) return rules.length === 0;
    const mode = patch.mode ?? 'clean';
    const global = rules.find((r) => r.id === 1);
    const hasStrict = global?.action.redirect.transform.queryTransform.removeParams.includes('ref');
    const exceptionRule = rules.find((r) => r.id === 2000);
    const exceptionsOk = (patch.exceptions ?? []).length === 0 ? !exceptionRule : !!exceptionRule;
    return global && hasStrict === (mode === 'strict') && exceptionsOk;
  }, 'dynamic rules to update');
}

async function visit(path, host = 'news.test') {
  const page = await context.newPage();
  await page.goto(`http://${host}:${port}${path}`);
  const url = page.url();
  await page.close();
  return url.replace(`http://${host}:${port}`, '');
}

async function extensionPage(file) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${file}`);
  return page;
}

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url !== '/favicon.ico') seen.push(req.url);
    // A server that insists on its tracking parameter (redirect loop when cleaned).
    if (req.url.startsWith('/loop') && !/utm_source=/i.test(req.url)) {
      res.writeHead(302, { location: '/loop?utm_source=forced' });
      res.end();
      return;
    }
    // A click tracker redirecting to another host with a tracker parameter.
    if (req.url.startsWith('/r?to=dest')) {
      res.writeHead(302, { location: `http://dest.test:${port}/landing?mkt_tok=ABC` });
      res.end();
      return;
    }
    // A download (never commits a page).
    if (req.url.startsWith('/download')) {
      res.setHeader('content-disposition', 'attachment; filename=x.bin');
      res.end('x');
      return;
    }
    // Two server redirects, each adding five unlisted trackers.
    if (req.url.startsWith('/chain') && !req.url.startsWith('/chain-end')) {
      const step = Number(new URL(req.url, 'http://x').searchParams.get('step') ?? '0');
      const extra = Array.from({ length: 5 }, (_, i) => `Utm_S${step}x${i}=1`).join('&');
      if (step < 2) {
        res.writeHead(302, { location: `/chain?step=${step + 1}&${extra}` });
        res.end();
        return;
      }
      if (req.url.startsWith('/chain?')) {
        res.writeHead(302, { location: `/chain-end?${extra}` });
        res.end();
        return;
      }
    }
    // A broken server that loops no matter what (must not cause endless retries).
    if (req.url.startsWith('/selfloop')) {
      selfLoopHits++;
      res.writeHead(302, { location: `/selfloop?utm_source=x&n=${selfLoopHits}` });
      res.end();
      return;
    }
    // A redirector that loops on purpose, then forwards to another site with trackers.
    if (req.url.startsWith('/launder')) {
      launderHits++;
      const location =
        launderHits <= 24
          ? `/launder?n=${launderHits}&utm_source=loop`
          : `http://victim.test:${port}/landing?gclid=TRACKED&id=1`;
      res.writeHead(302, { location });
      res.end();
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  userDataDir = mkdtempSync(join(tmpdir(), 'untrackable-e2e-'));
  ({ context, sw } = await launchWith(dist, userDataDir));
  extensionId = new URL(sw.url()).host;
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

async function launchWith(extensionDir, profileDir) {
  const launch = {
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      // Route every test host name to the local server.
      '--host-resolver-rules=MAP * 127.0.0.1',
      // Keep http:// test URLs from being upgraded to https.
      '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable',
    ],
  };
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  else launch.channel = 'chromium';
  const ctx = await chromium.launchPersistentContext(profileDir, launch);
  let [worker] = ctx.serviceWorkers();
  worker ??= await ctx.waitForEvent('serviceworker');
  return { context: ctx, sw: worker };
}

after(async () => {
  await context?.close();
  server?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  seen.length = 0;
  await setSettings({});
});

describe('installation', () => {
  test('loads with the expected minimal permissions', async () => {
    const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions.sort(), [
      'alarms',
      'clipboardWrite',
      'contextMenus',
      'declarativeNetRequest',
      'offscreen',
      'storage',
    ]);
    assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*']);
    assert.deepEqual(manifest.optional_permissions, ['webNavigation']);
  });

  test('installs every compiled rule in both modes (none silently dropped)', async () => {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL('../../../packages/core/src/index.ts', import.meta.url))],
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      logLevel: 'silent',
    });
    const core = await import(
      `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
    );
    for (const mode of ['clean', 'strict']) {
      await setSettings({ mode, exceptions: ['a.example'] });
      const expected = core
        .compileDnrRules({ mode, exceptions: ['a.example'] })
        .map((r) => r.id)
        .sort((a, b) => a - b);
      const installed = (await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules()))
        .map((r) => r.id)
        .sort((a, b) => a - b);
      assert.deepEqual(installed, expected, mode);
      assert.ok(
        installed.some((id) => id >= 500 && id < 1000),
        'case-insensitive fallback rules installed',
      );
    }
  });
});

describe('automatic navigation cleaning (Clean mode)', () => {
  test('removes utm parameters before the request leaves the browser', async () => {
    assert.equal(await visit('/article?utm_source=newsletter&utm_medium=email&id=123'), '/article?id=123');
    await waitFor(() => seen.length > 0, 'request', 2000).catch(() => {});
    assert.deepEqual(seen, ['/article?id=123'], JSON.stringify(seen));
  });

  test('removes click ids and keeps functional parameters in order', async () => {
    assert.equal(
      await visit('/c/shoes?color=black&gclid=a&size=44&fbclid=b&msclkid=c'),
      '/c/shoes?color=black&size=44',
    );
  });

  test('removes upper-case spellings', async () => {
    assert.equal(await visit('/a?UTM_SOURCE=x&id=1'), '/a?id=1');
  });

  test('valueless segments: documented Chromium normalisation vs byte-preserving fallback', async () => {
    // Exact (queryTransform) removal: Chromium re-serialises `edit` as `edit=`.
    assert.equal(await visit('/wiki?edit&utm_source=1'), '/wiki?edit=');
    // Regex fallback (mixed case) keeps the query byte-for-byte.
    assert.equal(await visit('/wiki?edit&Utm_Source=1'), '/wiki?edit');
  });

  test('many unlisted trackers never exceed the redirect limit', async () => {
    const unlisted = Array.from({ length: 25 }, (_, i) => `utm_z${i}=1`).join('&');
    assert.equal(await visit(`/a?${unlisted}&utm_source=x&id=1`), `/a?${unlisted}&id=1`);
    const some = Array.from({ length: 4 }, (_, i) => `Utm_Z${i}=1`).join('&');
    assert.equal(await visit(`/b?${some}&id=1`), '/b?id=1');
  });

  test('removes mixed-case spellings and unlisted utm_* names', async () => {
    assert.equal(await visit('/a?Utm_Source=x&id=1&FbClid=y&uTm_NewThing=z'), '/a?id=1');
    assert.deepEqual(seen, ['/a?id=1'], 'tracker never reached the server');
    assert.equal(await visit('/a?myUtm_source=1&GclidX=2'), '/a?myUtm_source=1&GclidX=2');
  });

  test('leaves URLs without tracking parameters alone (no redirect loop)', async () => {
    assert.equal(await visit('/plain?id=1&q=two%20words'), '/plain?id=1&q=two%20words');
    assert.deepEqual(seen, ['/plain?id=1&q=two%20words']);
  });

  test('applies domain-specific rules', async () => {
    assert.equal(await visit('/watch?v=abc&si=share&t=42', 'www.youtube.com'), '/watch?v=abc&t=42');
    assert.equal(await visit('/x?si=1', 'news.test'), '/x?si=1');
  });

  test('cleans links clicked inside pages', async () => {
    const page = await context.newPage();
    await page.goto(`http://news.test:${port}/start`);
    await Promise.all([page.waitForURL(/landing/), page.click('#link')]);
    assert.equal(new URL(page.url()).search, '?id=9');
    await page.close();
  });

  test('Strict-only parameters are kept in Clean mode', async () => {
    assert.equal(await visit('/p?ref=hn&id=5'), '/p?ref=hn&id=5');
  });
});

describe('protected URLs are never modified', () => {
  const cases = [
    '/oauth2/authorize?client_id=1&redirect_uri=x&utm_source=a',
    '/welcome?code=abc&state=xyz&utm_source=a',
    '/account/reset-password?uid=1&utm_source=a',
    '/email/verify/1/abc?utm_source=a',
    '/file.pdf?X-Amz-Signature=abc&utm_source=a',
    '/dl?sig=abc&utm_source=a',
    '/m?login_token=abc&utm_source=a',
    '/saml2/sso?SAMLRequest=abc&utm_source=a',
    '/checkout/step-2?utm_source=a',
  ];
  for (const path of cases) {
    test(path, async () => {
      assert.equal(await visit(path), path);
    });
  }

  test('identity provider domains', async () => {
    // Many identity providers are HSTS-preloaded (forced to https), which the
    // plain-http test server cannot serve; okta.com subdomains are used instead.
    assert.equal(await visit('/app/x?utm_source=a', 'acme.okta.com'), '/app/x?utm_source=a');
  });
});

describe('modes and user control', () => {
  test('Strict mode removes additional parameters', async () => {
    await setSettings({ mode: 'strict' });
    assert.equal(await visit('/p?ref=hn&id=5&utm_source=x'), '/p?id=5');
    assert.equal(await visit('/dp/B0X?ref=sr_1&pf_rd_p=a&th=1', 'www.amazon.de'), '/dp/B0X?th=1');
  });

  test('global bypass (cleaning off) removes all rules', async () => {
    await setSettings({ enabled: false });
    assert.equal(await visit('/a?utm_source=x'), '/a?utm_source=x');
  });

  test('temporary pause disables cleaning and schedules automatic resume', async () => {
    await setSettings({ pausedUntil: Date.now() + 60_000 });
    assert.equal(await visit('/a?utm_source=x'), '/a?utm_source=x');
    const alarm = await sw.evaluate(() => chrome.alarms.get('untrackable-resume'));
    assert.ok(alarm && alarm.scheduledTime > Date.now());
  });

  test('pause expires automatically', async () => {
    await setSettings({ pausedUntil: Date.now() + 1500 });
    assert.equal(await visit('/a?utm_source=x'), '/a?utm_source=x');
    // chrome.alarms has a 30 s minimum in production, so trigger the handler directly
    // after the pause has elapsed, as the alarm would.
    await new Promise((r) => setTimeout(r, 1600));
    await sw.evaluate(() => chrome.storage.local.set({ pausedUntil: 0 }));
    await waitFor(
      async () => (await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length > 0,
      'resume',
    );
    assert.equal(await visit('/a?utm_source=x'), '/a');
  });

  test('domain exceptions (including subdomains)', async () => {
    await setSettings({ exceptions: ['news.test'] });
    assert.equal(await visit('/a?utm_source=x'), '/a?utm_source=x');
    assert.equal(await visit('/a?utm_source=x', 'eu.news.test'), '/a?utm_source=x');
    assert.equal(await visit('/a?utm_source=x', 'other.test'), '/a');
  });

  test('settings persist in storage and are sanitised', async () => {
    await sw.evaluate(() => chrome.storage.local.set({ mode: 'bogus', exceptions: ['Bücher.TEST', 42, 'bad host'] }));
    const options = await extensionPage('options.html');
    await options.waitForSelector('#exceptions li');
    const items = await options.$$eval('#exceptions code', (els) => els.map((e) => e.textContent));
    assert.deepEqual(items, ['xn--bcher-kva.test']);
    assert.equal(await options.isChecked('input[name="mode"][value="clean"]'), true);
    await options.close();
  });
});

describe('per-tab controls', () => {
  test('pause in this tab only affects that tab', async () => {
    const target = await context.newPage();
    await target.goto(`http://news.test:${port}/first`);
    const ext = await extensionPage('options.html');
    const tabId = await ext.evaluate(async (port) => {
      const [tab] = await chrome.tabs.query({ url: `http://news.test:${port}/first` });
      await chrome.runtime.sendMessage({ type: 'setTabPaused', tabId: tab.id, paused: true });
      return tab.id;
    }, port);
    await target.goto(`http://news.test:${port}/a?utm_source=x`);
    assert.match(target.url(), /\?utm_source=x$/);
    assert.equal(await visit('/a?utm_source=x'), '/a', 'other tabs are still cleaned');
    await ext.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'setTabPaused', tabId, paused: false }), tabId);
    await target.goto(`http://news.test:${port}/b?utm_source=x`);
    assert.match(target.url(), /\/b$/);
    await target.close();
    await ext.close();
  });

  test('concurrent one-time bypasses are all consumed (regression)', async () => {
    const ext = await extensionPage('options.html');
    const pages = [];
    const onPage = (p) => pages.push(p);
    context.on('page', onPage);
    await ext.evaluate(
      (port) =>
        Promise.all(
          ['x', 'y', 'z'].map((v) =>
            chrome.runtime.sendMessage({
              type: 'openUnmodified',
              url: `http://news.test:${port}/multi-${v}?utm_source=${v}`,
            }),
          ),
        ),
      port,
    );
    await waitFor(() => pages.filter((p) => p.url().includes('/multi-')).length === 3, 'three tabs');
    await waitFor(
      async () => (await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).length === 0,
      'all bypass rules removed',
    );
    for (const p of pages.filter((x) => x.url().includes('/multi-'))) {
      assert.match(p.url(), /utm_source=/, 'original link was opened');
      await p.goto(`http://news.test:${port}/after?utm_source=x`);
      assert.match(p.url(), /\/after$/, 'tab is cleaned again');
      await p.close();
    }
    context.off('page', onPage);
    await ext.close();
  });

  test('one-time bypass requests a download link exactly once (signed links stay valid)', async () => {
    const ext = await extensionPage('options.html');
    const url = `http://news.test:${port}/download-once?utm_source=x&sig=1`;
    await ext.evaluate((u) => chrome.runtime.sendMessage({ type: 'openUnmodified', url: u }), url);
    await waitFor(() => seen.includes('/download-once?utm_source=x&sig=1'), 'download requested');
    await new Promise((r) => setTimeout(r, 4000)); // longer than any retry window
    assert.equal(seen.filter((u) => u.startsWith('/download-once')).length, 1);
    for (const p of context.pages()) if (p !== ext && p.url() === 'about:blank') await p.close();
    await ext.close();
  });

  test('one-time bypass covers redirectors in front of the destination', async () => {
    const ext = await extensionPage('options.html');
    await ext.evaluate(
      (u) => chrome.runtime.sendMessage({ type: 'openUnmodified', url: u }),
      `http://click.test:${port}/r?to=dest`,
    );
    const tab = await waitFor(() => context.pages().find((p) => p.url().includes('dest.test')), 'destination', 15_000);
    assert.match(tab.url(), /\/landing\?mkt_tok=ABC$/);
    await tab.close();
    await ext.close();
  });

  test('one-time bypass opens the original link once', async () => {
    const ext = await extensionPage('options.html');
    await ext.fill('#preview-input', `http://news.test:${port}/once?utm_source=x&id=1`);
    await ext.click('#open-unmodified');
    // Poll instead of a 'page' event predicate: the new tab's URL may still be
    // empty when the event fires on a slow machine.
    const tab = await waitFor(
      () => context.pages().find((p) => p.url().includes('/once')),
      'tab opened without cleaning',
      15_000,
    );
    assert.match(tab.url(), /\/once\?utm_source=x&id=1$/);
    assert.ok(seen.includes('/once?utm_source=x&id=1'));
    // The bypass is consumed: the next navigation in the same tab is cleaned again.
    await waitFor(
      async () => (await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).length === 0,
      'bypass rule removal',
    );
    await tab.goto(`http://news.test:${port}/again?utm_source=x`);
    assert.match(tab.url(), /\/again$/);
    await tab.close();
    await ext.close();
  });
});

describe('copy cleaning', () => {
  /**
   * Copy with the real keyboard shortcut and return the clipboard once it has
   * settled: the native copy writes first, Untrackable's clean link (written by
   * the service worker via the offscreen document) may replace it shortly after.
   */
  async function copySelection(page, setup) {
    await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
    await page.evaluate(setup);
    await page.keyboard.press('ControlOrMeta+C');
    const read = () => page.evaluate(() => navigator.clipboard.readText());
    let text = 'sentinel';
    await waitFor(async () => (text = await read()) !== 'sentinel', 'clipboard update', 3_000);
    let stableSince = Date.now();
    const deadline = Date.now() + 4_000;
    while (Date.now() - stableSince < 800 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      const next = await read();
      if (next !== text) {
        text = next;
        stableSince = Date.now();
      }
    }
    return text;
  }

  test('copying a selected link copies the cleaned link', async () => {
    const page = await context.newPage();
    await page.goto(`http://localhost:${port}/copy`);
    await page.waitForTimeout(200); // content script settings load
    const text = await copySelection(page, () => {
      const p = document.getElementById('para');
      p.textContent = 'https://shop.example/item?utm_source=mail&id=7';
      getSelection().selectAllChildren(p);
    });
    assert.equal(text, 'https://shop.example/item?id=7');
    await page.close();
  });

  test('copying from an input field', async () => {
    const page = await context.newPage();
    await page.goto(`http://localhost:${port}/copy`);
    await page.waitForTimeout(200);
    const text = await copySelection(page, () => {
      const f = document.getElementById('field');
      f.value = 'https://youtu.be/abc?si=xyz';
      f.focus();
      f.select();
    });
    assert.equal(text, 'https://youtu.be/abc');
    await page.close();
  });

  test('normal text and protected links are copied unchanged', async () => {
    const page = await context.newPage();
    await page.goto(`http://localhost:${port}/copy`);
    await page.waitForTimeout(200);
    const sentence = 'see https://a.example/?utm_source=x for details';
    assert.equal(
      await copySelection(page, () => {
        const p = document.getElementById('para');
        p.textContent = 'see https://a.example/?utm_source=x for details';
        getSelection().selectAllChildren(p);
      }),
      sentence,
    );
    assert.equal(
      await copySelection(page, () => {
        const p = document.getElementById('para');
        p.textContent = 'https://a.example/oauth/authorize?utm_source=x';
        getSelection().selectAllChildren(p);
      }),
      'https://a.example/oauth/authorize?utm_source=x',
    );
    await page.close();
  });

  test('synthetic copy events from the page are ignored (no settings oracle)', async () => {
    await setSettings({ exceptions: ['private.example'] });
    const page = await context.newPage();
    await page.goto(`http://localhost:${port}/copy`);
    await page.waitForTimeout(200);
    const probe = await page.evaluate(() => {
      const f = document.getElementById('field');
      f.value = 'https://public.example/?utm_source=x';
      f.focus();
      f.select();
      const dt = new DataTransfer();
      const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      return { data: dt.getData('text/plain'), prevented: ev.defaultPrevented };
    });
    assert.deepEqual(probe, { data: '', prevented: false });
    await page.close();
  });

  test('script-initiated copies after a click are not cleaned (no settings oracle)', async () => {
    await setSettings({ exceptions: ['private.example'] });
    const page = await context.newPage();
    await page.goto(`http://localhost:${port}/copy`);
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      window.results = [];
      document.addEventListener('copy', (e) => window.results.push(e.defaultPrevented));
      document.body.addEventListener('click', () => {
        for (const host of ['private.example', 'public.example']) {
          const t = document.createElement('textarea');
          t.value = `https://${host}/?utm_source=x`;
          document.body.append(t);
          t.select();
          document.execCommand('copy');
          t.remove();
        }
      });
    });
    await page.click('body');
    assert.deepEqual(await page.evaluate(() => window.results), [false, false]);
    await page.close();
  });

  test('a right-click cannot be used to probe settings', async () => {
    await setSettings({ exceptions: ['bank.example'] });
    const page = await context.newPage();
    await page.goto(`http://localhost:${port}/copy`);
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      window.results = [];
      document.addEventListener('copy', (e) => window.results.push(e.defaultPrevented));
      document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const t = document.createElement('textarea');
        t.value = 'https://other.example/?utm_source=x';
        document.body.append(t);
        t.select();
        document.execCommand('copy');
        t.remove();
      });
    });
    await page.click('body', { button: 'right' });
    assert.deepEqual(await page.evaluate(() => window.results), [false]);
    await page.close();
  });

  test('a page swapping the selection in the copy keystroke gets no cleaning result', async () => {
    const page = await context.newPage();
    await page.goto(`http://localhost:${port}/copy`);
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      window.results = [];
      document.addEventListener('copy', (e) => window.results.push(e.defaultPrevented));
      const p = document.getElementById('para');
      p.textContent = 'harmless text';
      getSelection().selectAllChildren(p);
      document.addEventListener('keydown', (e) => {
        if (e.code !== 'KeyC') return;
        const f = document.getElementById('field');
        f.value = 'https://probe.example/?utm_source=x';
        f.focus();
        f.select();
      });
    });
    await page.keyboard.press('ControlOrMeta+C');
    assert.deepEqual(await page.evaluate(() => window.results), [false]);
    await page.close();
  });

  test('a page cannot observe copy cleaning even when it acts before the content script', async () => {
    await setSettings({ exceptions: ['private.example'] });
    const page = await context.newPage();
    // Runs before any content script: a capture-phase keydown listener that
    // swaps the selection to a probe URL, and a copy listener that inspects
    // the event afterwards.
    await page.addInitScript(() => {
      window.results = [];
      window.addEventListener(
        'keydown',
        (e) => {
          if (!(e.ctrlKey || e.metaKey) || e.code !== 'KeyC') return;
          const f = document.getElementById('field');
          f.value = window.probe;
          f.focus();
          f.select();
        },
        true,
      );
      document.addEventListener('copy', (e) =>
        window.results.push({ prevented: e.defaultPrevented, data: e.clipboardData.getData('text/plain') }),
      );
    });
    await page.goto(`http://localhost:${port}/copy`);
    await page.waitForTimeout(200);
    for (const probe of ['https://private.example/?utm_source=x', 'https://public.example/?utm_source=x']) {
      await page.evaluate((p) => (window.probe = p), probe);
      await page.keyboard.press('ControlOrMeta+C');
    }
    assert.deepEqual(await page.evaluate(() => window.results), [
      { prevented: false, data: '' },
      { prevented: false, data: '' },
    ]);
    await page.close();
  });

  test('copy cleaning can be switched off', async () => {
    await setSettings({ copyCleaning: false });
    const page = await context.newPage();
    await page.goto(`http://localhost:${port}/copy`);
    await page.waitForTimeout(200);
    const text = await copySelection(page, () => {
      const p = document.getElementById('para');
      p.textContent = 'https://shop.example/item?utm_source=mail';
      getSelection().selectAllChildren(p);
    });
    assert.equal(text, 'https://shop.example/item?utm_source=mail');
    await page.close();
  });

  test('"Copy clean link" path writes through the offscreen document', async () => {
    const ext = await extensionPage('options.html');
    const ok = await ext.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'copyText', text: 'https://clean.example/' }),
    );
    assert.equal(ok, true);
    // The write happens in another renderer (offscreen document); the system
    // clipboard can take a moment to reflect it on slow machines.
    await waitFor(
      async () => (await ext.evaluate(() => navigator.clipboard.readText())) === 'https://clean.example/',
      'clipboard to contain the clean link',
      5_000,
    );
    await ext.close();
  });
});

describe('extension lifecycle', () => {
  test('content scripts of a reloaded extension stop acting (no stale settings)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'untrackable-e2e-orphan-ext-'));
    cpSync(dist, dir, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), 'untrackable-e2e-orphan-'));
    const third = await launchWith(dir, profile);
    try {
      await third.context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await waitFor(
        async () => (await third.sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length > 0,
        'rules',
      );
      const page = await third.context.newPage();
      await page.goto(`http://localhost:${port}/copy`);
      await page.waitForTimeout(300);
      // Reloading the extension orphans the content script in this tab.
      await third.sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
      await page.evaluate(() => {
        const f = document.getElementById('field');
        f.value = 'https://shop.example/item?utm_source=mail';
        f.focus();
        f.select();
      });
      await page.keyboard.press('ControlOrMeta+C');
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        'https://shop.example/item?utm_source=mail',
      );
    } finally {
      await third.context.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(profile, { recursive: true, force: true });
    }
  });
});

describe('popup for a real tab', () => {
  /** Open the popup as if it belonged to `target` (the real popup queries the active tab). */
  async function popupFor(target) {
    const tabId = await sw.evaluate(
      async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id,
      target.url(),
    );
    const popup = await context.newPage();
    await popup.addInitScript(
      ({ id, url }) => {
        const original = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = (q) => (q && q.active ? Promise.resolve([{ id, url, index: 0 }]) : original(q));
      },
      { id: tabId, url: target.url() },
    );
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForSelector('#site-host:not(:empty)');
    return { popup, tabId };
  }

  test('site exception toggle adds and removes only the exact host', async () => {
    await setSettings({ exceptions: ['news.test'] });
    const target = await context.newPage();
    await target.goto(`http://eu.news.test:${port}/page`);
    const { popup } = await popupFor(target);
    assert.equal(await popup.textContent('#site-host'), 'eu.news.test');
    assert.equal(await popup.isChecked('#site-exception'), true);
    assert.equal(await popup.isDisabled('#site-exception'), true, 'parent exception is not removed from here');
    assert.match(await popup.textContent('#site-note'), /news\.test/);
    await popup.close();
    await setSettings({});
    const { popup: p2 } = await popupFor(target);
    await p2.check('#site-exception');
    await waitFor(
      async () =>
        (await sw.evaluate(() => chrome.storage.local.get('exceptions'))).exceptions?.includes('eu.news.test'),
      'added',
    );
    await p2.uncheck('#site-exception');
    await waitFor(
      async () =>
        !(await sw.evaluate(() => chrome.storage.local.get('exceptions'))).exceptions?.includes('eu.news.test'),
      'removed',
    );
    await p2.close();
    await target.close();
  });

  test('pause-in-this-tab checkbox pauses only that tab', async () => {
    const target = await context.newPage();
    await target.goto(`http://news.test:${port}/first`);
    const { popup } = await popupFor(target);
    await popup.check('#tab-paused');
    await waitFor(
      async () => (await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).length === 1,
      'pause rule',
    );
    await popup.close();
    await target.goto(`http://news.test:${port}/a?utm_source=x`);
    assert.match(target.url(), /\?utm_source=x$/);
    const { popup: again } = await popupFor(target);
    assert.equal(await again.isChecked('#tab-paused'), true);
    await again.uncheck('#tab-paused');
    await waitFor(
      async () => (await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).length === 0,
      'unpaused',
    );
    await again.close();
    await target.close();
  });
});

describe('user interface', () => {
  test('popup reflects and changes settings', async () => {
    const popup = await extensionPage('popup.html');
    assert.equal(await popup.isChecked('#enabled'), true);
    assert.equal(await popup.textContent('#status'), 'Active');
    await popup.check('input[name="mode"][value="strict"]');
    await waitFor(
      async () => (await sw.evaluate(() => chrome.storage.local.get('mode'))).mode === 'strict',
      'mode saved',
    );
    await popup.click('#pause');
    await waitFor(async () => (await popup.textContent('#status')).startsWith('Paused'), 'paused status');
    await popup.click('#pause');
    await waitFor(async () => (await popup.textContent('#status')) === 'Strict', 'resumed status');
    await popup.uncheck('#enabled');
    await waitFor(async () => (await popup.textContent('#status')) === 'Off', 'off status');
    await waitFor(async () => (await sw.evaluate(() => chrome.action.getBadgeText({}))) === 'off', 'badge off');
    await popup.close();
  });

  test('options page previews what would be removed', async () => {
    const options = await extensionPage('options.html');
    await options.fill('#preview-input', 'https://example.com/a?utm_source=x&id=1');
    const out = await options.textContent('#preview-output');
    assert.match(out, /https:\/\/example\.com\/a\?id=1/);
    assert.match(out, /utm_source/);
    await options.fill('#preview-input', 'https://example.com/login?utm_source=x');
    assert.match(await options.textContent('#preview-output'), /Left unchanged/);
    await options.fill('#exception-input', 'shop.example');
    await options.click('#add-exception button');
    await options.waitForSelector('#exceptions li');
    const stored = await sw.evaluate(() => chrome.storage.local.get('exceptions'));
    assert.deepEqual(stored.exceptions, ['shop.example']);
    await options.close();
  });
});

describe('redirect loops', () => {
  test('without the optional permission a forced tracker loop fails as documented', async () => {
    const page = await context.newPage();
    await assert.rejects(page.goto(`http://news.test:${port}/loop`), /ERR_TOO_MANY_REDIRECTS/);
    await page.close();
  });

  test('with the optional webNavigation permission a loop is offered for an explicit retry', async () => {
    // Optional permissions cannot be granted through the permission prompt in
    // automation, so this test loads a copy whose manifest pre-grants it.
    const dir = mkdtempSync(join(tmpdir(), 'untrackable-e2e-loop-ext-'));
    cpSync(dist, dir, { recursive: true });
    const manifestPath = join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.permissions.push('webNavigation');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const profile = mkdtempSync(join(tmpdir(), 'untrackable-e2e-loop-'));
    const second = await launchWith(dir, profile);
    const extId = new URL(second.sw.url()).host;
    const tabIdOf = (fragment) =>
      second.sw.evaluate(async (f) => (await chrome.tabs.query({})).find((t) => t.url?.includes(f))?.id, fragment);
    const offerFor = (tabId) =>
      second.sw.evaluate(async (id) => {
        const offers = (await chrome.storage.session.get('loopOffers')).loopOffers ?? {};
        return { offered: id in offers, badge: await chrome.action.getBadgeText({ tabId: id }) };
      }, tabId);
    const retry = async (tabId) => {
      const ext = await second.context.newPage();
      await ext.goto(`chrome-extension://${extId}/options.html`);
      const ok = await ext.evaluate((id) => chrome.runtime.sendMessage({ type: 'retryLoop', tabId: id }), tabId);
      await ext.close();
      return ok;
    };
    try {
      await waitFor(
        async () => (await second.sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length > 0,
        'rules',
      );
      const page = await second.context.newPage();
      seen.length = 0;
      await page.goto(`http://news.test:${port}/loop`).catch(() => {});
      const tabId = await waitFor(() => tabIdOf('/loop'), 'loop tab');
      await waitFor(async () => (await offerFor(tabId)).offered, 'retry offered');
      assert.equal((await offerFor(tabId)).badge, '↻');
      // Privacy: only the host is kept, never a URL.
      const session = await second.sw.evaluate(() => chrome.storage.session.get(null));
      assert.ok(!JSON.stringify(session).includes('http'), JSON.stringify(session));
      // Nothing happens automatically (no extension-initiated navigation).
      // Let the original loop settle (its last requests can arrive late on slow
      // runners), then make sure nothing loads the page without cleaning: an
      // uncleaned load is the only way '/loop?utm_source=forced' reaches us.
      let last = -1;
      await waitFor(
        async () => {
          const stable = seen.length === last;
          last = seen.length;
          if (!stable) await new Promise((r) => setTimeout(r, 750));
          return stable;
        },
        'loop settled',
        15_000,
      );
      await new Promise((r) => setTimeout(r, 1500));
      assert.ok(!seen.some((u) => u.includes('utm_source=forced')), 'no automatic retry without cleaning');
      // Explicit retry: loads once without cleaning, then normal cleaning resumes.
      assert.equal(await retry(tabId), true);
      // Privacy: the stored URL is forgotten as soon as the offer is used.
      assert.equal((await offerFor(tabId)).offered, false);
      await page.waitForURL(/\/loop\?utm_source=forced$/, { timeout: 10_000 });
      await waitFor(
        async () => (await second.sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).length === 0,
        'bypass removed',
      );
      await page.goto(`http://news.test:${port}/after-loop?utm_source=x`);
      assert.match(page.url(), /\/after-loop$/);

      // A server that loops even without cleaning: a second retry within a minute is refused.
      const self = await second.context.newPage();
      await self.goto(`http://news.test:${port}/selfloop?utm_source=x`).catch(() => {});
      const selfTab = await waitFor(() => tabIdOf('/selfloop'), 'selfloop tab');
      await waitFor(async () => (await offerFor(selfTab)).offered, 'offer');
      assert.equal(await retry(selfTab), true);
      await waitFor(async () => (await offerFor(selfTab)).offered, 'offered again after failed retry', 10_000);
      assert.equal(await retry(selfTab), false, 'only one retry per tab per minute');
      // A stale offer disappears once the tab successfully loads something else.
      await waitFor(async () => (await offerFor(selfTab)).offered, 'offer present again', 10_000).catch(() => {});
      await self.goto(`http://other.test:${port}/unrelated`);
      await waitFor(async () => !(await offerFor(selfTab)).offered, 'stale offer cleared');

      // A redirector cannot use the retry to forward trackers to another site.
      launderHits = 0;
      const tab = await second.context.newPage();
      await tab.goto(`http://attacker.test:${port}/launder?n=0&utm_source=loop`).catch(() => {});
      const launderTab = await waitFor(() => tabIdOf('attacker.test'), 'launder tab');
      await waitFor(async () => (await offerFor(launderTab)).offered, 'offer');
      assert.equal(await retry(launderTab), true);
      await tab.waitForURL(/victim\.test/, { timeout: 10_000 });
      assert.match(tab.url(), /\/landing\?id=1$/);
      assert.ok(!seen.some((u) => u.startsWith('/landing') && u.includes('gclid')), 'tracker never reached victim');
    } finally {
      await second.context.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test('server redirect chains adding unlisted trackers still load', async () => {
    assert.match(await visit('/chain?step=0'), /^\/chain-end/);
  });
});

describe('DNR model vs Chromium', () => {
  test('the unit-test simulator predicts Chromium for generated URLs', async () => {
    const bundle = await build({
      stdin: {
        contents: `export * from './packages/core/src/index.ts'; export { simulate } from './packages/core/test/dnr-simulator.ts';`,
        resolveDir: fileURLToPath(new URL('../../../', import.meta.url)),
        loader: 'ts',
      },
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      logLevel: 'silent',
    });
    const mod = await import(
      `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
    );
    const rules = mod.compileDnrRules({ mode: 'clean', exceptions: [] });
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = (xs) => xs[Math.floor(rand() * xs.length)];
    const keys = [
      'utm_source',
      'UTM_MEDIUM',
      'Utm_Campaign',
      'utm_new',
      'fbclid',
      'FbClid',
      'gclid',
      'id',
      'q',
      'edit',
      'si',
      'ref',
      'sig',
      'code',
      'state',
      '',
      'utm%5Fsource',
    ];
    const vals = ['', '=1', '=a%20b', '=x&', '=1#frag'];
    const paths = ['/a', '/login', '/watch', '/x%2Fsso', '/p/q'];
    const mismatches = [];
    for (let i = 0; i < 200; i++) {
      const n = 1 + Math.floor(rand() * 5);
      const query =
        Array.from({ length: n }, () => pick(keys) + pick(vals.slice(0, 3))).join('&') + (rand() < 0.15 ? '&' : '');
      const host = pick(['news.test', 'www.youtube.com']);
      const path = `${pick(paths)}?${query}${rand() < 0.2 ? '#frag' : ''}`;
      const predicted = mod.simulate(rules, `http://${host}:${port}${path}`).replace(`http://${host}:${port}`, '');
      const page = await context.newPage();
      await page.goto(`http://${host}:${port}${path}`).catch(() => {});
      const actual = page.url().replace(`http://${host}:${port}`, '');
      await page.close();
      if (actual !== predicted) mismatches.push({ path, host, predicted, actual });
    }
    assert.deepEqual(mismatches, []);
  });
});

describe('engine inside Chromium', () => {
  test("all shared fixtures pass with Chromium's URL parser", async () => {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL('../../../packages/core/src/index.ts', import.meta.url))],
      bundle: true,
      format: 'iife',
      globalName: 'UntrackableCore',
      write: false,
      logLevel: 'silent',
    });
    const { cases } = JSON.parse(readFileSync(new URL('../../../tests/fixtures/cases.json', import.meta.url), 'utf8'));
    const page = await context.newPage();
    await page.goto(`http://news.test:${port}/engine`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const failures = await page.evaluate((cases) => {
      const out = [];
      for (const c of cases) {
        const r = globalThis.UntrackableCore.cleanUrl(c.input, {
          mode: c.mode ?? 'clean',
          exceptions: c.exceptions ?? [],
        });
        if (r.url !== c.expected || r.status !== c.status) out.push(`${c.name}: ${r.status} ${r.url}`);
      }
      return out;
    }, cases);
    assert.deepEqual(failures, []);
    await page.close();
  });

  test('navigation leaves percent-encoded protected paths and keys alone', async () => {
    for (const path of ['/%6Fauth/x?utm_source=a', '/my%2Dlogin?utm_source=a', '/dl?%73ig=abc&utm_source=a']) {
      assert.equal(await visit(path), path);
    }
    assert.equal(await visit('/stra%C3%9Fe?utm_source=a'), '/stra%C3%9Fe');
  });

  test('camelCase protected paths are left alone during navigation', async () => {
    assert.equal(await visit('/account/resetPassword?utm_source=a'), '/account/resetPassword?utm_source=a');
    assert.equal(await visit('/UnsubscribePage.html?mkt_tok=a'), '/UnsubscribePage.html?mkt_tok=a');
  });
});

describe('privacy', () => {
  test('storage contains only settings – no URLs or browsing data', async () => {
    await visit('/article?utm_source=x');
    const local = await sw.evaluate(() => chrome.storage.local.get(null));
    assert.deepEqual(Object.keys(local).sort(), []);
    await setSettings({ mode: 'strict', exceptions: ['a.test'] });
    await visit('/article?utm_source=x');
    const after = await sw.evaluate(() => chrome.storage.local.get(null));
    assert.deepEqual(Object.keys(after).sort(), ['exceptions', 'mode']);
    const session = await sw.evaluate(() => chrome.storage.session.get(null));
    assert.ok(!JSON.stringify(session).includes('http'));
  });
});
