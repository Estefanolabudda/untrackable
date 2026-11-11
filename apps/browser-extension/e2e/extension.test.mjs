// End-to-end tests: load the built extension (dist/) into a real Chromium and
// verify navigation cleaning, modes, exceptions, bypasses and clipboard features.
//
// Run: npm run test:e2e   (builds first)
// Requires Playwright's Chromium. Set CHROMIUM_PATH to use a specific binary.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'esbuild';

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
let httpsServer;
let httpsPort;
const HSTS_PRELOADED = /(^|\.)(youtube\.com|amazon\.de)$/;

/** Scheme, host and port the test server answers on for `host`. */
function origin(host) {
  return HSTS_PRELOADED.test(host) ? `https://${host}:${httpsPort}` : `http://${host}:${port}`;
}
/**
 * Behaviour of older Chromium versions (the minimum supported version 116 is
 * tested in CI): removing the last parameter can leave an empty '?' (`/a?`),
 * which is harmless; `visit` then normalises it. Detected at startup.
 */
const browserInfo = { major: 0, emptyQuery: false };
/** Chrome 116 leaves an empty '?'; current versions (verified: 153, 157) do not. */
const LEGACY_EMPTY_QUERY_BEFORE = 120;
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
    if (mode === 'experimental') {
      const exceptionRule = rules.find((r) => r.id === 2000);
      const exceptionsOk = (patch.exceptions ?? []).length === 0 ? !exceptionRule : !!exceptionRule;
      return rules.some((r) => r.id === 50) && !rules.some((r) => r.id === 1) && exceptionsOk;
    }
    const global = rules.find((r) => r.id === 1);
    const hasStrict = global?.action.redirect.transform.queryTransform.removeParams.includes('ref');
    const exceptionRule = rules.find((r) => r.id === 2000);
    const exceptionsOk = (patch.exceptions ?? []).length === 0 ? !exceptionRule : !!exceptionRule;
    return global && hasStrict === (mode === 'strict') && exceptionsOk;
  }, 'dynamic rules to update');
}

async function visit(path, host = 'news.test') {
  const page = await context.newPage();
  await page.goto(`${origin(host)}${path}`);
  const url = page.url();
  await page.close();
  const result = url.replace(origin(host), '');
  return browserInfo.emptyQuery ? result.replace(/\?$/, '') : result;
}

async function extensionPage(file) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${file}`);
  // The clipboard API needs a focused document; older headless Chromium does
  // not focus background pages on its own.
  await (await context.newCDPSession(page)).send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.mouse.click(1, 1);
  return page;
}

/** page.url(), without the harmless empty '?' that older Chromium leaves after removal. */
function urlOf(page) {
  return browserInfo.emptyQuery ? page.url().replace(/\?$/, '') : page.url();
}

before(async () => {
  const handler = (req, res) => {
    if (req.url !== '/favicon.ico') seen.push(req.url);
    // A server that insists on its tracking parameter (redirect loop when cleaned).
    if (req.url.startsWith('/loop') && !/utm_source=/i.test(req.url)) {
      res.writeHead(302, { location: '/loop?utm_source=forced' });
      res.end();
      return;
    }
    // A destination whose load never completes, then navigates onwards via JS.
    if (req.url.startsWith('/hang')) return; // never answer (keeps the load event pending)
    if (req.url.startsWith('/slow-then-leak')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        `<img src="/hang"><script>setTimeout(() => { location.href = 'http://third.test:${port}/landing?gclid=LEAK&id=1'; }, 1500);</script>`,
      );
      return;
    }
    // A click tracker redirecting to another host with a tracker parameter.
    if (req.url.startsWith('/r?to=dest')) {
      res.writeHead(302, { location: `http://dest.test:${port}/landing?mkt_tok=ABC` });
      res.end();
      return;
    }
    // A plain server redirect to a destination with parameters.
    if (req.url.startsWith('/hop')) {
      res.writeHead(302, { location: '/landing?id=1&utm_source=x' });
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
    // Replica of a real OpenAI e-mail link (2026-11): SendGrid click tracker ->
    // chatgpt.com/images?...&login_hint=...&utm_* -> 301 trailing slash -> 200.
    if (req.url.startsWith('/ls/click')) {
      const q =
        'entry_id=11111111-2222&deep_link_id=33333333-4444&auth_modal=1&login_hint=user%40example.com' +
        '&utm_campaign=EML_FE_NTF_CN_Images5_REC_EX&utm_medium=email&utm_source=sendgrid';
      res.writeHead(302, { location: `http://chatgpt.test:${port}/images?${q}` });
      res.end();
      return;
    }
    if (req.url.startsWith('/images?')) {
      res.writeHead(301, { location: req.url.replace('/images?', '/images/?') });
      res.end();
      return;
    }
    // A site whose sign-in round trip restores the full original URL (incl.
    // utm_*) whenever the request differs from it – a loop if anything strips
    // parameters from such auth deep links.
    if (req.url.startsWith('/deeplink')) {
      const full = '/deeplink?auth_modal=1&login_hint=user%40example.com&utm_source=sendgrid&utm_medium=email';
      if (req.url !== full) {
        res.writeHead(302, { location: full });
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
  };
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  // Real domains on the HSTS preload list (youtube.com, amazon.de) are forced
  // to https by Chrome; serve them over TLS with a throwaway self-signed
  // certificate (test browsers run with --ignore-certificate-errors).
  const certDir = mkdtempSync(join(tmpdir(), 'untrackable-e2e-tls-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=untrackable-e2e',
      '-keyout',
      join(certDir, 'key.pem'),
      '-out',
      join(certDir, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  httpsServer = https.createServer(
    { key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) },
    handler,
  );
  await new Promise((r) => httpsServer.listen(0, '127.0.0.1', r));
  httpsPort = httpsServer.address().port;
  rmSync(certDir, { recursive: true, force: true });

  userDataDir = mkdtempSync(join(tmpdir(), 'untrackable-e2e-'));
  ({ context, sw } = await launchWith(dist, userDataDir));
  extensionId = new URL(sw.url()).host;
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  browserInfo.major = Number((await sw.evaluate(() => navigator.userAgent)).match(/Chrome\/(\d+)/)?.[1] ?? 0);
  await waitFor(
    async () => (await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length > 0,
    'rules installed',
    10_000,
  );
  const probe = await context.newPage();
  await probe.goto(`http://news.test:${port}/__probe?utm_source=x`);
  browserInfo.emptyQuery = probe.url().endsWith('?');
  await probe.close();
  console.log(`# browser: Chrome ${browserInfo.major}, empty '?' after removal: ${browserInfo.emptyQuery}`);
  // Tolerating the empty '?' (and skipping the simulator check) is only for
  // old browsers known to behave so. On a current browser it is a regression
  // that must fail the run, not silently relax it (found in review).
  assert.ok(
    !browserInfo.emptyQuery || browserInfo.major < LEGACY_EMPTY_QUERY_BEFORE,
    `Chrome ${browserInfo.major} unexpectedly leaves an empty '?' after removing the last parameter`,
  );
});

async function launchWith(extensionDir, profileDir) {
  const launch = {
    // Explicit new headless mode: before Chrome ~132 plain --headless meant the
    // old headless mode, which cannot load extensions (minimum version 116 is
    // tested in CI).
    headless: false,
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      // Route every test host name to the local server.
      '--host-resolver-rules=MAP * 127.0.0.1',
      // Keep http:// test URLs from being upgraded to https.
      '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable',
      // Self-signed certificate of the local https test server (HSTS hosts).
      '--ignore-certificate-errors',
      // All test traffic is local; never use a proxy from the environment.
      '--no-proxy-server',
    ],
  };
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  else launch.channel = 'chromium';
  const ctx = await chromium.launchPersistentContext(profileDir, launch);
  let [worker] = ctx.serviceWorkers();
  worker ??= await ctx.waitForEvent('serviceworker');
  return { context: ctx, sw: liveWorker(ctx, worker) };
}

/**
 * MV3 service workers stop when idle (older Chromium, e.g. 116, does so even
 * while tests run). This handle wakes the extension's worker again when the
 * previous one has already closed – it never retries a call that failed,
 * so a call that itself stops the worker (runtime.reload) is not repeated.
 */
function liveWorker(ctx, first) {
  const id = new URL(first.url()).host;
  let current = first;
  let closed = false;
  const track = (w) => w.once('close', () => (closed = w === current ? true : closed));
  track(first);
  async function ensure() {
    if (!closed) return current;
    const fresh = () => ctx.serviceWorkers().find((w) => w !== current && w.url().includes(id));
    let next = fresh();
    if (!next) {
      const waiter = ctx.waitForEvent('serviceworker', { predicate: (w) => w.url().includes(id), timeout: 15_000 });
      const page = await ctx.newPage();
      await page.goto(`chrome-extension://${id}/options.html`).catch(() => {});
      next = fresh() ?? (await waiter);
      await page.close();
    }
    current = next;
    closed = false;
    track(next);
    return current;
  }
  return {
    url: () => current.url(),
    evaluate: async (fn, arg) => (await ensure()).evaluate(fn, arg),
  };
}

after(async () => {
  await context?.close();
  server?.close();
  httpsServer?.close();
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

  test('installs every compiled rule in every mode (none silently dropped)', async () => {
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
    for (const mode of ['clean', 'strict', 'experimental']) {
      await setSettings({ mode, exceptions: ['a.example'] });
      const expected = core
        .compileDnrRules({ mode, exceptions: ['a.example'] })
        .map((r) => r.id)
        .sort((a, b) => a - b);
      const installed = (await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules()))
        .map((r) => r.id)
        .sort((a, b) => a - b);
      assert.deepEqual(installed, expected, mode);
      if (mode === 'experimental') {
        assert.ok(installed.includes(50) && !installed.some((id) => id < 1000 && id !== 50), 'only the strip rule');
        assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), 'E');
      } else {
        assert.ok(
          installed.some((id) => id >= 500 && id < 1000),
          'case-insensitive fallback rules installed',
        );
      }
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

describe('Experimental mode (strip query parameters)', () => {
  test('strips trackers, functional and unknown parameters before the request is sent', async () => {
    await setSettings({ mode: 'experimental' });
    assert.equal(await visit('/article?utm_source=email&id=123&ref=newsletter'), '/article');
    assert.equal(await visit('/search?q=shoes&page=2'), '/search');
    assert.equal(await visit('/?email_id=example123', 'support.stripe.test'), '/');
    // The original URL never reached the server (no consumed one-time links).
    assert.deepEqual(
      seen.filter((u) => !u.startsWith('/favicon')),
      ['/article', '/search', '/'],
      JSON.stringify(seen),
    );
  });

  test('protection signals in the fragment are honoured, also valueless ones (safe side for plain anchors)', async () => {
    assert.equal(await visit('/guide?id=1&utm_source=x#token&a=1'), '/guide?id=1&utm_source=x#token&a=1');
    assert.equal(await visit('/guide?id=1&utm_source=x#api-token'), '/guide?id=1&utm_source=x#api-token');
    assert.equal(await visit('/guide?id=1&utm_source=x#intro'), '/guide?id=1#intro');
    await setSettings({ mode: 'experimental' });
    assert.equal(await visit('/guide?id=1#token&a=1'), '/guide?id=1#token&a=1');
    assert.equal(await visit('/guide?id=1#intro'), '/guide#intro');
  });

  test('keeps the fragment and leaves URLs without a query alone', async () => {
    await setSettings({ mode: 'experimental' });
    const page = await context.newPage();
    await page.goto(`http://news.test:${port}/a?x=1&y=2#section`);
    assert.equal(urlOf(page), `http://news.test:${port}/a#section`);
    await page.goto(`http://news.test:${port}/plain`);
    assert.equal(urlOf(page), `http://news.test:${port}/plain`);
    await page.goto(`http://news.test:${port}/empty?`);
    assert.equal(page.url(), `http://news.test:${port}/empty?`, 'an existing empty query is left alone');
    await page.goto(`http://news.test:${port}/amp?&&`);
    assert.equal(urlOf(page), `http://news.test:${port}/amp?&&`);
    await page.close();
  });

  const protectedPaths = [
    '/oauth2/authorize?client_id=1&redirect_uri=x&utm_source=a',
    '/welcome?code=abc',
    '/welcome?error=access_denied&utm_source=a',
    '/account/reset-password?uid=1',
    '/email/verify/1/abc?utm_source=a',
    '/file.pdf?X-Amz-Signature=abc&utm_source=a',
    '/m?login_token=abc',
    '/action?csrf=1&utm_source=a',
    '/order/complete?payment_intent=pi_1&payment_intent_client_secret=s&redirect_status=succeeded',
    '/account?return_to=%2Forders',
    '/f.zip?expires=1700000000&id=2',
    '/images/?entry_id=1&login_hint=user%40example.com&utm_source=a',
    '/checkout/step-2?utm_source=a',
    '/x%2Fsso?id=1',
    // Review findings: protection signals in the fragment, more flows.
    '/cb?tenant=a#code=xyz',
    '/l.php?u=https%3A%2F%2Fshop.example%2Freset%3Ftoken%3Dabc&h=AT0',
    '/gc/return?redirect_flow_id=RE123',
    '/ct?Len=10&Data=abcdef',
    '/cb?tenant=a#access_token=abc&token_type=bearer',
    '/finish?mode=signIn&oobCode=abc',
    '/adfs/ls/?wa=wsignin1.0&wtrealm=urn%3Aapp',
    '/attachments/f.png?ex=1&is=2&hm=3&utm_source=a',
  ];
  for (const path of protectedPaths) {
    test(`protected: ${path}`, async () => {
      await setSettings({ mode: 'experimental' });
      assert.equal(await visit(path), path);
    });
  }

  test('sign-in and payment hosts keep their query (host label signal)', async () => {
    await setSettings({ mode: 'experimental' });
    assert.equal(await visit('/x?y=1', 'login.example.test'), '/x?y=1');
    assert.equal(await visit('/start?x=1', 'secure.bank.test'), '/start?x=1');
    assert.equal(await visit('/x?y=1', 'www.login.test'), '/x', 'only the first label counts');
    await setSettings({ mode: 'clean' });
    assert.equal(await visit('/x?y=1&utm_source=z', 'login.example.test'), '/x?y=1', 'Clean is unaffected');
  });

  test('domain exceptions, global off, timed pause and tab pause still apply', async () => {
    await setSettings({ mode: 'experimental', exceptions: ['news.test'] });
    assert.equal(await visit('/a?id=1', 'eu.news.test'), '/a?id=1');
    assert.equal(await visit('/a?id=1', 'other.test'), '/a');
    await setSettings({ mode: 'experimental', enabled: false });
    assert.equal(await visit('/a?id=1'), '/a?id=1');
    await setSettings({ mode: 'experimental', pausedUntil: Date.now() + 60_000 });
    assert.equal(await visit('/a?id=1'), '/a?id=1');
    await setSettings({ mode: 'experimental' });
    const page = await context.newPage();
    await page.goto(`http://news.test:${port}/first`);
    const tabId = await sw.evaluate(
      async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id,
      page.url(),
    );
    const ext = await extensionPage('options.html');
    await ext.evaluate((id) => chrome.runtime.sendMessage({ type: 'setTabPaused', tabId: id, paused: true }), tabId);
    await page.goto(`http://news.test:${port}/a?id=1`);
    assert.match(urlOf(page), /\/a\?id=1$/);
    await ext.evaluate((id) => chrome.runtime.sendMessage({ type: 'setTabPaused', tabId: id, paused: false }), tabId);
    await page.goto(`http://news.test:${port}/b?id=1`);
    assert.match(urlOf(page), /\/b$/);
    await ext.close();
    await page.close();
  });

  test('"Open link without cleaning" opens the original once, then stripping resumes', async () => {
    await setSettings({ mode: 'experimental' });
    const ext = await extensionPage('options.html');
    await ext.fill('#preview-input', `http://news.test:${port}/once-exp?id=1&utm_source=x`);
    await ext.click('#open-unmodified');
    const tab = await waitFor(
      () => context.pages().find((p) => p.url().includes('/once-exp')),
      'tab opened without cleaning',
      15_000,
    );
    assert.match(urlOf(tab), /\/once-exp\?id=1&utm_source=x$/);
    assert.equal(seen.filter((u) => u.startsWith('/once-exp')).length, 1, 'requested exactly once');
    await waitFor(
      async () => (await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).length === 0,
      'bypass rule removal',
    );
    await tab.goto(`http://news.test:${port}/again?id=1`);
    assert.match(urlOf(tab), /\/again$/);
    await tab.close();
    await ext.close();
  });

  test('form submissions (POST) keep their target query', async () => {
    await setSettings({ mode: 'experimental' });
    const page = await context.newPage();
    await page.goto(`http://news.test:${port}/form`);
    await Promise.all([
      page.waitForURL(/\/submit/),
      page.evaluate(() => {
        const f = document.createElement('form');
        f.method = 'post';
        f.action = '/submit?step=2';
        document.body.append(f);
        f.submit();
      }),
    ]);
    assert.ok(seen.includes('/submit?step=2'), JSON.stringify(seen));
    await page.close();
  });

  test('server redirect chains terminate; a server insisting on a query fails as documented', async () => {
    await setSettings({ mode: 'experimental' });
    // Each hop is stripped: redirect -> destination query stripped too.
    assert.equal(await visit('/hop?utm_source=a'), '/landing');
    assert.deepEqual(seen, ['/hop', '/landing'], JSON.stringify(seen));
    seen.length = 0;
    const page = await context.newPage();
    await assert.rejects(page.goto(`http://news.test:${port}/loop`), /ERR_TOO_MANY_REDIRECTS/);
    await page.close();
  });

  test('"Open link without query parameters" opens one stripped tab, no bypass left behind', async () => {
    await setSettings({ mode: 'clean' });
    const before = context.pages().length;
    await sw.evaluate(
      (linkUrl) =>
        chrome.contextMenus.onClicked.dispatch({ menuItemId: 'open-link-without-query', linkUrl, editable: false }),
      `http://news.test:${port}/opened?code=abc&utm_source=x#frag`,
    );
    const tab = await waitFor(() => context.pages().find((p) => p.url().includes('/opened')), 'stripped tab', 10_000);
    await tab.waitForLoadState();
    assert.equal(urlOf(tab), `http://news.test:${port}/opened#frag`);
    assert.deepEqual(
      seen.filter((u) => u.startsWith('/opened')),
      ['/opened'],
    );
    assert.equal((await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).length, 0);
    // javascript: and other schemes are ignored.
    await sw.evaluate(() =>
      chrome.contextMenus.onClicked.dispatch({
        menuItemId: 'open-link-without-query',
        linkUrl: 'javascript:alert(1)',
        editable: false,
      }),
    );
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(context.pages().length, before + 1);
    await tab.close();
  });
});

describe('robustness of mode handling (v0.2)', () => {
  test('cycling through all modes changes navigation and badge every time', async () => {
    const steps = [
      ['clean', '/m?id=1&utm_source=x&ref=a', '/m?id=1&ref=a', ''],
      ['strict', '/m?id=1&utm_source=x&ref=a', '/m?id=1', 'S'],
      ['experimental', '/m?id=1&utm_source=x&ref=a', '/m', 'E'],
      ['clean', '/m?id=1&utm_source=x&ref=a', '/m?id=1&ref=a', ''],
      ['experimental', '/m?id=1', '/m', 'E'],
      ['strict', '/m?id=1&ref=a', '/m?id=1', 'S'],
    ];
    for (const [mode, path, expected, badge] of steps) {
      await setSettings({ mode });
      assert.equal(await visit(path), expected, mode);
      assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), badge, mode);
    }
    await setSettings({ mode: 'experimental', enabled: false });
    assert.equal(await visit('/m?id=1'), '/m?id=1', 'bypass');
  });

  test('a strip rule Chromium refuses shows "!" and strips nothing; recovery afterwards', async () => {
    // Simulate a browser that rejects the strip rule's regex.
    await sw.evaluate(() => {
      const original = chrome.declarativeNetRequest.isRegexSupported.bind(chrome.declarativeNetRequest);
      globalThis.__origIsRegexSupported = original;
      chrome.declarativeNetRequest.isRegexSupported = async (o) =>
        o.regex === '^[^?#]*\\?[^#]*[^&#]' ? { isSupported: false, reason: 'memoryLimitExceeded' } : original(o);
    });
    try {
      await sw.evaluate(() => chrome.storage.local.set({ mode: 'experimental' }));
      await waitFor(async () => (await sw.evaluate(() => chrome.action.getBadgeText({}))) === '!', 'badge !');
      const ids = (await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).map((r) => r.id);
      assert.ok(!ids.includes(50), 'strip rule not installed');
      assert.equal(await visit('/f?id=1'), '/f?id=1', 'nothing stripped');
    } finally {
      await sw.evaluate(() => {
        chrome.declarativeNetRequest.isRegexSupported = globalThis.__origIsRegexSupported;
      });
    }
    await setSettings({ mode: 'experimental' });
    assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), 'E');
    assert.equal(await visit('/f?id=1'), '/f');
  });

  test('a protection rule Chromium refuses disables all redirects (fail-safe), also in Experimental', async () => {
    await sw.evaluate(() => {
      const original = chrome.declarativeNetRequest.isRegexSupported.bind(chrome.declarativeNetRequest);
      globalThis.__origIsRegexSupported = original;
      chrome.declarativeNetRequest.isRegexSupported = async (o) =>
        o.regex.includes('oauth') ? { isSupported: false, reason: 'memoryLimitExceeded' } : original(o);
    });
    try {
      await sw.evaluate(() => chrome.storage.local.set({ mode: 'experimental' }));
      await waitFor(async () => (await sw.evaluate(() => chrome.action.getBadgeText({}))) === '!', 'badge !');
      const rules = await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
      assert.ok(rules.length > 0 && rules.every((r) => r.action.type === 'allow'), 'only allow rules remain');
      assert.equal(await visit('/f?id=1&utm_source=x'), '/f?id=1&utm_source=x');
    } finally {
      await sw.evaluate(() => {
        chrome.declarativeNetRequest.isRegexSupported = globalThis.__origIsRegexSupported;
      });
    }
    await setSettings({ mode: 'experimental' });
    assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), 'E');
  });

  test('if installing rules fails twice, stale rules of the previous mode are removed', async () => {
    await setSettings({ mode: 'experimental' });
    await sw.evaluate(() => {
      const original = chrome.declarativeNetRequest.updateDynamicRules.bind(chrome.declarativeNetRequest);
      globalThis.__origUpdate = original;
      chrome.declarativeNetRequest.updateDynamicRules = async (o) => {
        if ((o.addRules ?? []).length > 0) throw new Error('simulated failure');
        return original(o);
      };
    });
    try {
      // Switching back to Clean must not leave the Experimental strip rule behind.
      await sw.evaluate(() => chrome.storage.local.set({ mode: 'clean' }));
      await waitFor(async () => (await sw.evaluate(() => chrome.action.getBadgeText({}))) === '!', 'badge !');
      assert.equal((await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length, 0);
      assert.equal(await visit('/f?id=1'), '/f?id=1', 'no stale stripping');
    } finally {
      await sw.evaluate(() => {
        chrome.declarativeNetRequest.updateDynamicRules = globalThis.__origUpdate;
      });
    }
    await setSettings({ mode: 'clean' });
    assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), '');
    assert.equal(await visit('/f?id=1&utm_source=x'), '/f?id=1');
  });

  test('Experimental and exceptions survive a browser restart', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'untrackable-e2e-restart-'));
    try {
      let b = await launchWith(dist, profile);
      await b.sw.evaluate(() => chrome.storage.local.set({ mode: 'experimental', exceptions: ['keep.test'] }));
      await waitFor(
        async () =>
          (await b.sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).some((r) => r.id === 50),
        'strip rule',
      );
      await b.context.close();
      b = await launchWith(dist, profile);
      await waitFor(
        async () => (await b.sw.evaluate(() => chrome.action.getBadgeText({}))) === 'E',
        'badge E after restart',
      );
      const stored = await b.sw.evaluate(() => chrome.storage.local.get(null));
      assert.equal(stored.mode, 'experimental');
      assert.deepEqual(stored.exceptions, ['keep.test']);
      const page = await b.context.newPage();
      await page.goto(`http://news.test:${port}/after-restart?id=1`);
      assert.match(urlOf(page), /\/after-restart$/);
      await page.goto(`http://keep.test:${port}/x?id=1`);
      assert.match(urlOf(page), /\/x\?id=1$/);
      // No session state survives: no tab pause or one-time bypass rules.
      assert.equal((await b.sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).length, 0);
      await b.context.close();
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });
});

describe('upgrades from published releases', () => {
  // Release ZIPs as published on GitHub (checked against the published SHA-256).
  const releases = [
    {
      version: '0.1.0',
      sha256: 'ee29d0c4f5db146d41609a135ae8a0baef2d2969e249092c061da1cd8d7baaea',
      settings: { mode: 'strict', exceptions: ['keep.test'], copyCleaning: false },
      check: { path: '/u?id=1&ref=a&utm_source=x', expected: '/u?id=1' },
    },
    {
      version: '0.2.0',
      sha256: 'd3b4dca2fc9fc7948401e123c4b756653081dd616c256c74695eef04d5f62a65',
      settings: { mode: 'experimental', exceptions: ['keep.test'] },
      check: { path: '/u?id=1&ref=a', expected: '/u' },
    },
  ];
  const menuIds = [
    'copy-clean-link',
    'open-link-unmodified',
    'copy-clean-page-link',
    'copy-link-without-query',
    'open-link-without-query',
  ];

  /**
   * The documented update path is "replace the folder, then reload the
   * extension in chrome://extensions". A browser launched with
   * --enable-unsafe-extension-debugging can do exactly that over CDP
   * (Extensions.loadUnpacked on the same folder = reload). (Merely restarting a
   * browser launched with --load-extension keeps running the previously
   * registered service worker, so it does not model an update.)
   */
  async function launchForUpdates(profile) {
    const exe = process.env.CHROMIUM_PATH ?? chromium.executablePath();
    const proc = spawn(
      exe,
      [
        '--headless=new',
        '--no-sandbox',
        '--no-first-run',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        '--enable-unsafe-extension-debugging',
        '--host-resolver-rules=MAP * 127.0.0.1',
        '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable',
        '--no-proxy-server',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    const portFile = join(profile, 'DevToolsActivePort');
    await waitFor(() => existsSync(portFile) && readFileSync(portFile, 'utf8').includes('\n'), 'DevTools port', 15_000);
    const devtoolsPort = readFileSync(portFile, 'utf8').split('\n')[0];
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${devtoolsPort}`);
    const cdp = await browser.newBrowserCDPSession();
    return { browser, cdp, context: browser.contexts()[0], proc };
  }

  async function extensionState(context, id) {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/options.html`);
    const state = await page.evaluate(async (ids) => {
      const menus = {};
      for (const mid of ids) {
        menus[mid] = await new Promise((res) =>
          chrome.contextMenus.update(mid, {}, () => res(chrome.runtime.lastError ? 'missing' : 'ok')),
        );
      }
      return {
        version: chrome.runtime.getManifest().version,
        local: await chrome.storage.local.get(null),
        rules: (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id),
        stripsRef: (await chrome.declarativeNetRequest.getDynamicRules()).some((r) =>
          r.action.redirect?.transform?.queryTransform?.removeParams?.includes('ref'),
        ),
        menus,
      };
    }, menuIds);
    await page.close();
    return state;
  }

  for (const release of releases) {
    test(`${release.version} → current: settings, menus and rules survive an update`, async (t) => {
      const zip = fileURLToPath(new URL(`./releases/untrackable-chromium-${release.version}.zip`, import.meta.url));
      const digest = createHash('sha256').update(readFileSync(zip)).digest('hex');
      assert.equal(digest, release.sha256, 'fixture is the published release asset');
      const extDir = mkdtempSync(join(tmpdir(), `untrackable-upgrade-ext-${release.version}-`));
      const profile = mkdtempSync(join(tmpdir(), `untrackable-upgrade-profile-${release.version}-`));
      let b;
      try {
        execFileSync('unzip', ['-q', zip, '-d', extDir]);
        b = await launchForUpdates(profile);
        const loaded = await b.cdp.send('Extensions.loadUnpacked', { path: extDir }).catch((e) => e);
        if (loaded instanceof Error && /wasn't found/.test(loaded.message)) {
          t.skip('this browser version has no CDP Extensions domain to reload the extension');
          return;
        }
        if (loaded instanceof Error) throw loaded;
        const { id } = loaded;
        await waitFor(async () => (await extensionState(b.context, id)).version === release.version, 'old version');
        const setter = await b.context.newPage();
        await setter.goto(`chrome-extension://${id}/options.html`);
        await setter.evaluate((s) => chrome.storage.local.set(s), release.settings);
        await setter.close();

        // Update as documented: replace the folder contents, reload the extension.
        for (const f of readdirSync(extDir)) rmSync(join(extDir, f), { recursive: true, force: true });
        cpSync(dist, extDir, { recursive: true });
        const reloaded = await b.cdp.send('Extensions.loadUnpacked', { path: extDir });
        assert.equal(reloaded.id, id, 'same extension id (settings are tied to it)');
        const current = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')).version;
        let state;
        await waitFor(
          async () => {
            state = await extensionState(b.context, id);
            const modeRules = release.settings.mode === 'experimental' ? state.rules.includes(50) : state.stripsRef;
            return state.version === current && state.local.settingsVersion === 1 && modeRules;
          },
          'updated, migrated, rules for the stored mode installed',
          10_000,
        ).catch((e) => {
          throw new Error(`${e.message}: ${JSON.stringify({ ...state, rules: state?.rules.length })}`);
        });
        for (const [k, v] of Object.entries(release.settings)) assert.deepEqual(state.local[k], v, `setting ${k} kept`);
        assert.deepEqual(
          state.menus,
          Object.fromEntries(menuIds.map((m) => [m, 'ok'])),
          'all context-menu items exist',
        );
        assert.ok(state.rules.length > 0, 'rules installed');
        if (release.settings.mode === 'experimental') assert.ok(state.rules.includes(50), 'strip rule installed');
        const page = await b.context.newPage();
        await page.goto(`http://news.test:${port}${release.check.path}`);
        assert.equal(urlOf(page), `http://news.test:${port}${release.check.expected}`);
        await page.goto(`http://keep.test:${port}${release.check.path}`);
        assert.equal(urlOf(page), `http://keep.test:${port}${release.check.path}`, 'exception kept');
      } finally {
        await b?.browser.close().catch(() => {});
        if (b && b.proc.exitCode === null) {
          await new Promise((r) => {
            b.proc.once('exit', r);
            b.proc.kill();
          });
        }
        // Chromium's helper processes may still write briefly; temp dirs only.
        for (const d of [extDir, profile]) {
          try {
            rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
          } catch {
            /* left in the temp directory */
          }
        }
      }
    });
  }
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
    assert.match(urlOf(target), /\?utm_source=x$/);
    assert.equal(await visit('/a?utm_source=x'), '/a', 'other tabs are still cleaned');
    await ext.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'setTabPaused', tabId, paused: false }), tabId);
    await target.goto(`http://news.test:${port}/b?utm_source=x`);
    assert.match(urlOf(target), /\/b$/);
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
      assert.match(urlOf(p), /utm_source=/, 'original link was opened');
      await p.goto(`http://news.test:${port}/after?utm_source=x`);
      assert.match(urlOf(p), /\/after$/, 'tab is cleaned again');
      await p.close();
    }
    context.off('page', onPage);
    await ext.close();
  });

  test('one-time bypass requests a download link exactly once (signed links stay valid)', async (t) => {
    if (browserInfo.major < 120) {
      t.skip('downloads hang headless Chrome 116 under automation (verified); covered on current Chromium');
      return;
    }
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
    assert.match(urlOf(tab), /\/landing\?mkt_tok=ABC$/);
    await tab.close();
    await ext.close();
  });

  test('one-time bypass ends when the destination commits (slow pages cannot leak onwards)', async () => {
    const ext = await extensionPage('options.html');
    await ext.evaluate(
      (u) => chrome.runtime.sendMessage({ type: 'openUnmodified', url: u }),
      `http://news.test:${port}/slow-then-leak?utm_source=x`,
    );
    const tab = await waitFor(
      () => context.pages().find((p) => p.url().includes('third.test')),
      'onward navigation',
      15_000,
    );
    await tab.waitForURL(/third\.test/);
    assert.match(urlOf(tab), /\/landing\?id=1$/);
    assert.ok(seen.includes('/slow-then-leak?utm_source=x'), 'original link opened uncleaned');
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
    assert.match(urlOf(tab), /\/once\?utm_source=x&id=1$/);
    assert.ok(seen.includes('/once?utm_source=x&id=1'));
    // The bypass is consumed: the next navigation in the same tab is cleaned again.
    await waitFor(
      async () => (await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).length === 0,
      'bypass rule removal',
    );
    await tab.goto(`http://news.test:${port}/again?utm_source=x`);
    assert.match(urlOf(tab), /\/again$/);
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

  test('clipboard-change notifications do not reveal settings', async (t) => {
    await setSettings({ exceptions: ['private.example'] });
    const page = await context.newPage();
    await page.goto(`http://localhost:${port}/copy`);
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      window.changes = 0;
      navigator.clipboard.addEventListener?.('clipboardchange', () => window.changes++);
    });
    const countFor = async (url) => {
      await page.evaluate(() => (window.changes = 0));
      await page.evaluate((u) => {
        const f = document.getElementById('field');
        f.value = u;
        f.focus();
        f.select();
      }, url);
      await page.keyboard.press('ControlOrMeta+C');
      await new Promise((r) => setTimeout(r, 1000));
      return page.evaluate(() => window.changes);
    };
    const excepted = await countFor('https://private.example/?utm_source=x');
    const cleaned = await countFor('https://public.example/?utm_source=x');
    const protectedUrl = await countFor('https://public.example/oauth/authorize?utm_source=x');
    if (cleaned === 0 && (await page.evaluate(() => !('onclipboardchange' in navigator.clipboard)))) {
      t.skip('this browser has no clipboardchange event, so it cannot leak anything');
      return;
    }
    assert.ok(cleaned >= 1, 'clipboardchange events are observable in this browser (test is meaningful)');
    assert.equal(excepted, cleaned, `excepted ${excepted} vs cleaned ${cleaned}`);
    assert.equal(protectedUrl, cleaned, `protected ${protectedUrl} vs cleaned ${cleaned}`);
    await page.close();
  });

  test('a quick second copy is never replaced by the first one', async () => {
    const page = await context.newPage();
    await page.goto(`http://localhost:${port}/copy`);
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const f = document.getElementById('field');
      f.value = 'https://shop.example/a?utm_source=x';
      f.focus();
      f.select();
    });
    await page.keyboard.press('ControlOrMeta+C');
    // A person needs well over 150 ms to select something else and copy again.
    await new Promise((r) => setTimeout(r, 150));
    await page.evaluate(() => {
      const p = document.getElementById('para');
      p.textContent = 'plain second copy';
      getSelection().selectAllChildren(p);
    });
    await page.keyboard.press('ControlOrMeta+C');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'plain second copy');
    await page.close();
  });

  test("a page's own copy handling is respected", async () => {
    const page = await context.newPage();
    await page.goto(`http://localhost:${port}/copy`);
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      document.addEventListener('copy', (e) => {
        e.clipboardData.setData('text/plain', 'PAGE-CUSTOM-DATA');
        e.preventDefault();
      });
      const f = document.getElementById('field');
      f.value = 'https://shop.example/x?utm_source=y';
      f.focus();
      f.select();
    });
    await page.keyboard.press('ControlOrMeta+C');
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'PAGE-CUSTOM-DATA');
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

  test('Experimental: keyboard copies are cleaned with the Strict rules (no silent stripping), protected links unchanged', async () => {
    await setSettings({ mode: 'experimental' });
    const page = await context.newPage();
    await page.goto(`http://localhost:${port}/copy`);
    await page.waitForTimeout(200);
    const stripped = await copySelection(page, () => {
      const p = document.getElementById('para');
      p.textContent = 'https://shop.example/search?q=shoes&utm_source=x&ref=a#results';
      getSelection().selectAllChildren(p);
    });
    assert.equal(stripped, 'https://shop.example/search?q=shoes#results');
    const kept = await copySelection(page, () => {
      const p = document.getElementById('para');
      p.textContent = 'https://shop.example/order/complete?payment_intent=pi_1&redirect_status=succeeded';
      getSelection().selectAllChildren(p);
    });
    assert.equal(kept, 'https://shop.example/order/complete?payment_intent=pi_1&redirect_status=succeeded');
    await page.close();
  });

  test('"Copy link without query parameters" strips on explicit request, even protected links', async () => {
    const ext = await extensionPage('options.html');
    const clip = () => ext.evaluate(() => navigator.clipboard.readText());
    const menu = (id, linkUrl) =>
      sw.evaluate(
        ({ id, linkUrl }) => chrome.contextMenus.onClicked.dispatch({ menuItemId: id, linkUrl, editable: false }),
        { id, linkUrl },
      );
    await ext.evaluate(() => navigator.clipboard.writeText('sentinel'));
    // Works in the default Clean mode too: it is a manual action.
    await menu('copy-link-without-query', 'https://example.com/login?token=abc&utm_source=x#top');
    await waitFor(async () => (await clip()) === 'https://example.com/login#top', 'stripped link copied', 5_000);
    // Non-http(s) links are ignored (clipboard untouched).
    await ext.evaluate(() => navigator.clipboard.writeText('sentinel'));
    await menu('copy-link-without-query', 'javascript:alert(1)?x=1');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await clip(), 'sentinel');
    await ext.close();
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

  test('popup shows no redirect-loop notice without a loop (regression: [hidden] overridden by CSS)', async () => {
    const target = await context.newPage();
    await target.goto(`http://news.test:${port}/fine`);
    const { popup } = await popupFor(target);
    await popup.waitForTimeout(300);
    assert.equal(await popup.isVisible('#loop-section'), false);
    assert.equal(await popup.isVisible('#loop-retry'), false);
    await popup.close();
    await target.close();
  });

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
    assert.match(urlOf(target), /\?utm_source=x$/);
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

  test('Experimental needs an explicit confirmation and can be left with one click', async () => {
    const popup = await extensionPage('popup.html');
    const mode = async () => (await sw.evaluate(() => chrome.storage.local.get('mode'))).mode ?? 'clean';
    // Choosing the radio only shows the warning; focus goes to the safe button.
    await popup.check('input[name="mode"][value="experimental"]');
    assert.equal(await popup.isVisible('#exp-confirm'), true);
    assert.equal(await popup.evaluate(() => document.activeElement?.id), 'exp-cancel');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await mode(), 'clean', 'not activated without confirmation');
    await popup.keyboard.press('Enter'); // Enter on "Cancel"
    assert.equal(await popup.isHidden('#exp-confirm'), true);
    assert.equal(await popup.isChecked('input[name="mode"][value="clean"]'), true);
    assert.equal(await mode(), 'clean');
    // Confirmed: mode, badge, status and the "Back to Clean" notice.
    // Escape on the radio group also cancels.
    await popup.check('input[name="mode"][value="experimental"]');
    await popup.focus('input[name="mode"][value="experimental"]');
    await popup.keyboard.press('Escape');
    assert.equal(await popup.isHidden('#exp-confirm'), true);
    assert.equal(await mode(), 'clean');
    await popup.check('input[name="mode"][value="experimental"]');
    await popup.click('#exp-enable');
    assert.equal(
      await popup.evaluate(() => document.activeElement?.getAttribute('value')),
      'experimental',
      'focus stays on a visible control',
    );
    await waitFor(async () => (await mode()) === 'experimental', 'experimental saved');
    await waitFor(async () => (await sw.evaluate(() => chrome.action.getBadgeText({}))) === 'E', 'badge E');
    await waitFor(async () => (await popup.textContent('#status')) === 'Experimental', 'status');
    assert.equal(await popup.isVisible('#exp-active'), true);
    await popup.close();
    // The options page shows the same notice; "Back to Clean" switches back at once.
    const options = await extensionPage('options.html');
    await options.fill('#preview-input', 'https://example.com/a?id=1&utm_source=x#top');
    assert.match(await options.textContent('#preview-output'), /https:\/\/example\.com\/a#top/);
    assert.equal(await options.isVisible('#exp-active'), true);
    await options.click('#exp-back');
    await waitFor(async () => (await mode()) === 'clean', 'back to clean');
    await waitFor(async () => (await sw.evaluate(() => chrome.action.getBadgeText({}))) === '', 'badge cleared');
    assert.equal(await options.isHidden('#exp-active'), true);
    assert.equal(await options.isChecked('input[name="mode"][value="clean"]'), true);
    await options.close();
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

describe('e-mail deep links (regression: OpenAI "too many redirects" report)', () => {
  for (const mode of ['clean', 'strict']) {
    test(`tracker -> deep link with login_hint -> trailing-slash redirect loads (${mode})`, async () => {
      await setSettings({ mode });
      const page = await context.newPage();
      await page.goto(`http://r.openai.test:${port}/ls/click?upn=u001.abc`);
      assert.match(urlOf(page), /^http:\/\/chatgpt\.test:\d+\/images\/\?/);
      // OIDC login_hint => protected: the deep link reaches the site unchanged.
      assert.ok(page.url().includes('login_hint=user%40example.com'));
      assert.ok(page.url().includes('entry_id=11111111-2222&deep_link_id=33333333-4444&auth_modal=1'));
      assert.ok(page.url().includes('utm_source=sendgrid'), 'protected auth deep link is not modified');
      await page.close();
    });

    test(`auth round trip that restores the original URL does not loop (${mode})`, async () => {
      await setSettings({ mode });
      const page = await context.newPage();
      seen.length = 0;
      await page.goto(
        `http://chatgpt.test:${port}/deeplink?auth_modal=1&login_hint=user%40example.com&utm_source=sendgrid&utm_medium=email`,
      );
      assert.match(urlOf(page), /\/deeplink\?auth_modal=1&login_hint=/);
      assert.ok(seen.filter((u) => u.startsWith('/deeplink')).length <= 2, `no loop: ${seen.length} requests`);
      await page.close();
    });
  }

  test('without the login_hint signal the same e-mail deep link is cleaned and keeps its ids', async () => {
    await setSettings({ mode: 'strict' });
    assert.equal(
      await visit(
        '/images/?entry_id=1&deep_link_id=2&utm_campaign=EML_X&utm_medium=email&utm_source=sendgrid',
        'chatgpt.test',
      ),
      '/images/?entry_id=1&deep_link_id=2',
    );
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
        return {
          offered: id in offers,
          notOurs: offers[id]?.notOurs === true,
          badge: await chrome.action.getBadgeText({ tabId: id }),
        };
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
      // A successful load ends the retry window: a later loop is a new event, not "not ours".
      await waitFor(
        async () =>
          !(
            String(tabId) in
            ((await second.sw.evaluate(() => chrome.storage.session.get('loopRetries'))).loopRetries ?? {})
          ),
        'retry forgotten after successful load',
      );
      await page.goto(`http://news.test:${port}/after-loop?utm_source=x`);
      assert.match(urlOf(page), browserInfo.emptyQuery ? /\/after-loop\??$/ : /\/after-loop$/);

      // A server that loops even without cleaning: a second retry within a minute is refused.
      const self = await second.context.newPage();
      await self.goto(`http://news.test:${port}/selfloop?utm_source=x`).catch(() => {});
      const selfTab = await waitFor(() => tabIdOf('/selfloop'), 'selfloop tab');
      await waitFor(async () => (await offerFor(selfTab)).offered, 'offer');
      assert.equal(await retry(selfTab), true);
      await waitFor(async () => (await offerFor(selfTab)).offered, 'offered again after failed retry', 10_000);
      // It also failed without cleaning: Untrackable must not blame itself.
      assert.equal((await offerFor(selfTab)).notOurs, true, 'loop classified as not caused by Untrackable');
      // The popup says so (carefully) and offers no second reload.
      const loopPopup = await second.context.newPage();
      await loopPopup.addInitScript(
        ({ id, url }) => {
          const original = chrome.tabs.query.bind(chrome.tabs);
          chrome.tabs.query = (q) => (q && q.active ? Promise.resolve([{ id, url, index: 0 }]) : original(q));
        },
        { id: selfTab, url: `http://news.test:${port}/selfloop` },
      );
      await loopPopup.goto(`chrome-extension://${extId}/popup.html`);
      await loopPopup.waitForSelector('#loop-section:not([hidden])');
      assert.match(await loopPopup.textContent('#loop-text'), /probably not caused by Untrackable/);
      assert.equal(await loopPopup.isHidden('#loop-retry'), true, 'no second reload offered');
      await loopPopup.close();
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
      assert.match(urlOf(tab), /\/landing\?id=1$/);
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
  test('the unit-test simulator predicts Chromium for generated URLs', async (t) => {
    if (browserInfo.emptyQuery) {
      t.skip('the simulator models current Chromium; this older version keeps an empty "?"');
      return;
    }
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
    let rules = mod.compileDnrRules({ mode: 'clean', exceptions: [] });
    for (let i = 0; i < 260; i++) {
      if (i === 200) {
        // Experimental mode (query stripping) on the remaining URLs.
        await setSettings({ mode: 'experimental' });
        rules = mod.compileDnrRules({ mode: 'experimental', exceptions: [] });
      }
      const n = 1 + Math.floor(rand() * 5);
      const query =
        Array.from({ length: n }, () => pick(keys) + pick(vals.slice(0, 3))).join('&') + (rand() < 0.15 ? '&' : '');
      const host = pick(['news.test', 'www.youtube.com']);
      const path = `${pick(paths)}?${query}${rand() < 0.2 ? '#frag' : ''}`;
      const predicted = mod.simulate(rules, `${origin(host)}${path}`).replace(origin(host), '');
      const page = await context.newPage();
      await page.goto(`${origin(host)}${path}`).catch(() => {});
      const actual = page.url().replace(origin(host), '');
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
    // Older Chromium versions decode unreserved characters in the path
    // (/%6Fauth -> /oauth) before rules match; the URL must stay unchanged either way.
    const decodeUnreserved = (x) =>
      x.replace(/%([0-9a-f]{2})/gi, (m, h) =>
        /[\w.~-]/.test(String.fromCharCode(parseInt(h, 16))) ? String.fromCharCode(parseInt(h, 16)) : m,
      );
    for (const path of ['/%6Fauth/x?utm_source=a', '/my%2Dlogin?utm_source=a', '/dl?%73ig=abc&utm_source=a']) {
      const got = await visit(path);
      assert.ok(
        got === path ||
          (browserInfo.major < 130 && got === decodeUnreserved(path.split('?')[0]) + '?' + path.split('?')[1]),
        got,
      );
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
    assert.deepEqual(
      Object.keys(after)
        .filter((k) => k !== 'settingsVersion')
        .sort(),
      ['exceptions', 'mode'],
    );
    assert.ok(
      Object.values(after).every((v) => !JSON.stringify(v).includes('http')),
      'no URLs stored',
    );
    const session = await sw.evaluate(() => chrome.storage.session.get(null));
    assert.ok(!JSON.stringify(session).includes('http'));
  });
});
