// End-to-end tests: load the built extension (dist/) into a real Chromium and
// verify navigation cleaning, modes, exceptions, bypasses and clipboard features.
//
// Run: npm run test:e2e   (builds first)
// Requires Playwright's Chromium. Set CHROMIUM_PATH to use a specific binary.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

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
    seen.push(req.url);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  userDataDir = mkdtempSync(join(tmpdir(), 'untrackable-e2e-'));
  const launch = {
    headless: true,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      // Route every test host name to the local server.
      '--host-resolver-rules=MAP * 127.0.0.1',
      // Keep http:// test URLs from being upgraded to https.
      '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable',
    ],
  };
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  else launch.channel = 'chromium';
  context = await chromium.launchPersistentContext(userDataDir, launch);
  [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker');
  extensionId = new URL(sw.url()).host;
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

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
  });

  test('installs dynamic rules with default settings', async () => {
    const rules = await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
    assert.ok(rules.length > 10);
    for (const r of rules.filter((x) => x.condition.regexFilter)) {
      const ok = await sw.evaluate(
        (regex) => chrome.declarativeNetRequest.isRegexSupported({ regex }),
        r.condition.regexFilter,
      );
      assert.equal(ok.isSupported, true, r.condition.regexFilter);
    }
  });
});

describe('automatic navigation cleaning (Clean mode)', () => {
  test('removes utm parameters before the request leaves the browser', async () => {
    assert.equal(await visit('/article?utm_source=newsletter&utm_medium=email&id=123'), '/article?id=123');
    assert.deepEqual(seen, ['/article?id=123']);
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

  test('one-time bypass opens the original link once', async () => {
    const ext = await extensionPage('options.html');
    const opened = context.waitForEvent('page', (p) => p.url().includes('/once') || p.url() === 'about:blank');
    await ext.fill('#preview-input', `http://news.test:${port}/once?utm_source=x&id=1`);
    await ext.click('#open-unmodified');
    const tab = await opened;
    await tab.waitForURL(/\/once/);
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
  async function copySelection(page, setup) {
    await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
    await page.evaluate(setup);
    await page.keyboard.press('ControlOrMeta+C');
    return page.evaluate(() => navigator.clipboard.readText());
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
    assert.equal(await ext.evaluate(() => navigator.clipboard.readText()), 'https://clean.example/');
    await ext.close();
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
