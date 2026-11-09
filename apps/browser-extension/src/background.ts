/**
 * Untrackable service worker.
 *
 * - Compiles settings into declarativeNetRequest rules (automatic navigation cleaning).
 * - Context menu: "Copy clean link", "Open link without cleaning", "Copy clean page link".
 * - Keyboard command: copy clean link of the current page.
 * - Per-tab pause and one-time bypass via DNR session rules.
 *
 * Privacy: nothing here stores or transmits URLs. Tab state lives only in
 * memory/chrome.storage.session and disappears with the browser session.
 */
import { cleanUrl, compileDnrRules, PRIORITY } from '@untrackable/core';
import { effectiveMode, loadSettings, saveSettings, type Message, type Settings, type TabState } from './settings.js';

const RESUME_ALARM = 'untrackable-resume';
/** Longest URL the extension cleans on explicit actions (Chromium's own limit is 2 MB). */
const MAX_URL_LENGTH = 32_768;
const MENU = {
  copyLink: 'copy-clean-link',
  openUnmodified: 'open-link-unmodified',
  copyPage: 'copy-clean-page-link',
} as const;

// ---------------------------------------------------------------------------
// Dynamic rules
// ---------------------------------------------------------------------------

let applyQueue: Promise<void> = Promise.resolve();

/** Serialise rule updates so concurrent setting changes cannot interleave. */
function applyRules(): Promise<void> {
  applyQueue = applyQueue.then(applyRulesNow, applyRulesNow);
  return applyQueue;
}

/**
 * Drop rules Chromium cannot compile. A protection (`allow`) rule that cannot
 * be installed makes cleaning unsafe, so in that case no redirect is installed
 * at all (fail safe: leave URLs alone rather than risk breaking them).
 */
async function supportedRules(
  rules: chrome.declarativeNetRequest.Rule[],
): Promise<chrome.declarativeNetRequest.Rule[]> {
  const kept: chrome.declarativeNetRequest.Rule[] = [];
  let protectionBroken = false;
  for (const rule of rules) {
    const regex = rule.condition.regexFilter;
    if (regex !== undefined) {
      const { isSupported } = await chrome.declarativeNetRequest.isRegexSupported({
        regex,
        isCaseSensitive: rule.condition.isUrlFilterCaseSensitive !== false,
        requireCapturing: rule.action.redirect?.regexSubstitution !== undefined,
      });
      if (!isSupported) {
        if (rule.action.type === chrome.declarativeNetRequest.RuleActionType.ALLOW) protectionBroken = true;
        continue;
      }
    }
    kept.push(rule);
  }
  return protectionBroken
    ? kept.filter((r) => r.action.type !== chrome.declarativeNetRequest.RuleActionType.REDIRECT)
    : kept;
}

async function applyRulesNow(): Promise<void> {
  const settings = await loadSettings();
  const mode = effectiveMode(settings);
  const compiled =
    mode === 'bypass'
      ? []
      : await supportedRules(
          compileDnrRules({ mode, exceptions: settings.exceptions }) as chrome.declarativeNetRequest.Rule[],
        );
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: compiled });
  } catch {
    // An update is atomic: one bad rule would leave the previous rule set in
    // place. Retry without the optional regex fallback rules.
    const essential = compiled.filter((r) => r.action.redirect?.regexSubstitution === undefined);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: essential }).catch(() => {
      /* keep previous rules; nothing else is safe to do */
    });
  }
  await scheduleResume(settings);
  await updateBadge(settings);
}

async function scheduleResume(settings: Settings): Promise<void> {
  await chrome.alarms.clear(RESUME_ALARM);
  if (settings.pausedUntil > Date.now()) {
    await chrome.alarms.create(RESUME_ALARM, { when: settings.pausedUntil });
  }
}

async function updateBadge(settings: Settings): Promise<void> {
  const mode = effectiveMode(settings);
  const text = mode === 'bypass' ? 'off' : mode === 'strict' ? 'S' : '';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: mode === 'bypass' ? '#8a3b12' : '#1f5f3a' });
  const title =
    mode === 'bypass'
      ? settings.enabled
        ? 'Untrackable – paused'
        : 'Untrackable – off'
      : `Untrackable – ${mode === 'strict' ? 'Strict' : 'Clean'} mode`;
  await chrome.action.setTitle({ title });
}

// ---------------------------------------------------------------------------
// Per-tab session rules (pause on tab, one-time bypass)
// ---------------------------------------------------------------------------

/**
 * Per-tab session rules. The rules themselves are the only state:
 *   - kind is encoded in the id range (pause: [1, ONCE_BASE), one-time: [ONCE_BASE, 2^31)),
 *   - the tab is condition.tabIds[0].
 * Tab ids can be close to 2^31 in Chromium, so ids are allocated, not derived
 * from the tab id. All mutations go through one queue → no lost updates.
 */
const ONCE_BASE = 1_000_000_000;
const ONCE_ALARM_PREFIX = 'untrackable-once-';
/** A one-time bypass that never completes (e.g. the link was a download) expires after this. */
const ONCE_TIMEOUT_MINUTES = 1;

type TabRuleKind = 'pause' | 'once';

let sessionQueue: Promise<unknown> = Promise.resolve();
function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const run = sessionQueue.then(fn, fn);
  sessionQueue = run.catch(() => {});
  return run;
}

function kindOf(id: number): TabRuleKind {
  return id >= ONCE_BASE ? 'once' : 'pause';
}

async function tabRules(tabId: number): Promise<chrome.declarativeNetRequest.Rule[]> {
  return (await chrome.declarativeNetRequest.getSessionRules()).filter((r) => r.condition.tabIds?.includes(tabId));
}

async function isTabPaused(tabId: number): Promise<boolean> {
  return (await tabRules(tabId)).length > 0;
}

/** Replace the tab's rules of `kind` (remove all, optionally add one). Must run inside `serialised`. */
async function setTabRule(tabId: number, kind: TabRuleKind, present: boolean): Promise<void> {
  const all = await chrome.declarativeNetRequest.getSessionRules();
  const remove = all.filter((r) => kindOf(r.id) === kind && r.condition.tabIds?.includes(tabId)).map((r) => r.id);
  const addRules: chrome.declarativeNetRequest.Rule[] = [];
  if (present) {
    const base = kind === 'once' ? ONCE_BASE : 1;
    const used = new Set(all.map((r) => r.id));
    let id = base;
    while (used.has(id)) id++;
    addRules.push({
      id,
      priority: PRIORITY.tabPause,
      action: { type: chrome.declarativeNetRequest.RuleActionType.ALLOW },
      condition: { tabIds: [tabId], resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME] },
    });
  }
  if (remove.length > 0 || addRules.length > 0) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: remove, addRules });
  }
}

function notifyTab(tabId: number, paused: boolean): void {
  // Tell the tab's content script so copy cleaning follows the tab state.
  chrome.tabs.sendMessage(tabId, { type: 'tabState', paused } satisfies { type: string } & TabState).catch(() => {
    /* no content script in this tab (e.g. chrome:// page) */
  });
}

function setTabPaused(tabId: number, paused: boolean): Promise<void> {
  return serialised(async () => {
    await setTabRule(tabId, 'pause', paused);
    // Un-pausing also ends a pending one-time bypass in that tab.
    if (!paused) await setTabRule(tabId, 'once', false);
    if (!paused) await chrome.alarms.clear(ONCE_ALARM_PREFIX + tabId);
    notifyTab(tabId, paused);
  });
}

function endOnce(tabId: number): Promise<void> {
  return serialised(async () => {
    const rules = await tabRules(tabId);
    if (!rules.some((r) => kindOf(r.id) === 'once')) return;
    await setTabRule(tabId, 'once', false);
    await chrome.alarms.clear(ONCE_ALARM_PREFIX + tabId);
    notifyTab(
      tabId,
      rules.some((r) => kindOf(r.id) === 'pause'),
    );
  });
}

/** One-time bypass: open `url` in a new tab with cleaning disabled for that single page load. */
async function openUnmodified(url: string, openerTab?: chrome.tabs.Tab): Promise<void> {
  if (!/^https?:/i.test(url)) return;
  const createProps: chrome.tabs.CreateProperties = { url: 'about:blank', active: true };
  if (openerTab?.id !== undefined) createProps.openerTabId = openerTab.id;
  if (openerTab?.index !== undefined) createProps.index = openerTab.index + 1;
  const tab = await chrome.tabs.create(createProps);
  if (tab.id === undefined) return;
  const tabId = tab.id;
  await serialised(() => setTabRule(tabId, 'once', true));
  await chrome.alarms.create(ONCE_ALARM_PREFIX + tab.id, { delayInMinutes: ONCE_TIMEOUT_MINUTES });
  await chrome.tabs.update(tab.id, { url });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || tab.url === undefined || tab.url === 'about:blank') return;
  void endOnce(tabId);
});

// ---------------------------------------------------------------------------
// Redirect-loop recovery (optional permission "webNavigation", off by default)
// ---------------------------------------------------------------------------
//
// If a server insists on a tracking parameter and redirects back to it, the
// cleaned navigation loops until Chromium aborts with ERR_TOO_MANY_REDIRECTS.
// DNR cannot observe this. When the user grants the optional webNavigation
// permission, the failed top-level load is retried once, unmodified, in the
// same tab. Only the error event is used; nothing is stored or logged.

const REDIRECT_LOOP_ERROR = 'net::ERR_TOO_MANY_REDIRECTS';

async function waitForTabComplete(tabId: number, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (tab === undefined || tab.status === 'complete') return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function recoverFromRedirectLoop(tabId: number, url: string): Promise<void> {
  if (!/^https?:/i.test(url) || effectiveMode(await loadSettings()) === 'bypass') return;
  // Already retried without cleaning (or paused): the loop is not ours – give up.
  if (await isTabPaused(tabId)) return;
  // Let the error page finish first, so its "complete" event cannot end the bypass early.
  await waitForTabComplete(tabId);
  await serialised(() => setTabRule(tabId, 'once', true));
  await chrome.alarms.create(ONCE_ALARM_PREFIX + tabId, { delayInMinutes: ONCE_TIMEOUT_MINUTES });
  await chrome.tabs.update(tabId, { url });
}

function onNavigationError(details: { tabId: number; frameId: number; url: string; error: string }): void {
  if (details.frameId !== 0 || details.tabId < 0 || details.error !== REDIRECT_LOOP_ERROR) return;
  void recoverFromRedirectLoop(details.tabId, details.url);
}

function registerLoopRecovery(): void {
  // chrome.webNavigation only exists while the optional permission is granted.
  const nav = (chrome as { webNavigation?: typeof chrome.webNavigation }).webNavigation;
  if (nav !== undefined && !nav.onErrorOccurred.hasListener(onNavigationError)) {
    nav.onErrorOccurred.addListener(onNavigationError);
  }
}

registerLoopRecovery();
chrome.permissions.onAdded.addListener(registerLoopRecovery);

chrome.tabs.onRemoved.addListener((tabId) => {
  void serialised(async () => {
    await setTabRule(tabId, 'pause', false);
    await setTabRule(tabId, 'once', false);
  });
  void chrome.alarms.clear(ONCE_ALARM_PREFIX + tabId);
});

// ---------------------------------------------------------------------------
// Clipboard (offscreen document; MV3 service workers have no DOM clipboard)
// ---------------------------------------------------------------------------

let creatingOffscreen: Promise<void> | undefined;

async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL('offscreen.html');
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  });
  if (contexts.length > 0) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: 'Write the cleaned link to the clipboard after an explicit user action.',
    })
    .finally(() => {
      creatingOffscreen = undefined;
    });
  await creatingOffscreen;
}

let clipboardQueue: Promise<unknown> = Promise.resolve();

/** Serialised so concurrent copies cannot create or close the document under each other. */
function copyToClipboard(text: string): Promise<boolean> {
  const run = clipboardQueue.then(async () => {
    await ensureOffscreen();
    try {
      const ok: unknown = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text });
      return ok === true;
    } finally {
      // Do not keep a clipboard-capable document alive longer than needed.
      await chrome.offscreen.closeDocument().catch(() => {});
    }
  });
  clipboardQueue = run.catch(() => {});
  return run.catch(() => false);
}

/**
 * Explicit user action ("Copy clean link"): clean with the configured mode even
 * while automatic cleaning is paused – the user asked for a clean link.
 * Domain exceptions are still honoured.
 */
async function copyClean(url: string): Promise<void> {
  if (url.length > MAX_URL_LENGTH) return; // hostile pages can craft huge hrefs
  const settings = await loadSettings();
  const result = cleanUrl(url, { mode: settings.mode, exceptions: settings.exceptions });
  await copyToClipboard(result.url);
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function createMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU.copyLink, title: 'Copy clean link', contexts: ['link'] });
    chrome.contextMenus.create({ id: MENU.openUnmodified, title: 'Open link without cleaning', contexts: ['link'] });
    chrome.contextMenus.create({ id: MENU.copyPage, title: 'Copy clean page link', contexts: ['page'] });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  createMenus();
  void applyRules();
});

chrome.runtime.onStartup.addListener(() => {
  void applyRules();
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') void applyRules();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RESUME_ALARM) void saveSettings({ pausedUntil: 0 });
  else if (alarm.name.startsWith(ONCE_ALARM_PREFIX)) {
    const tabId = Number(alarm.name.slice(ONCE_ALARM_PREFIX.length));
    if (Number.isInteger(tabId)) void endOnce(tabId);
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU.copyLink && info.linkUrl) void copyClean(info.linkUrl);
  else if (info.menuItemId === MENU.openUnmodified && info.linkUrl) void openUnmodified(info.linkUrl, tab);
  else if (info.menuItemId === MENU.copyPage) {
    const pageUrl = info.pageUrl ?? tab?.url;
    if (pageUrl !== undefined) void copyClean(pageUrl);
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'copy-clean-link' || tab?.url === undefined) return;
  void copyClean(tab.url);
});

function isMessage(m: unknown): m is Message {
  if (typeof m !== 'object' || m === null) return false;
  const msg = m as Record<string, unknown>;
  switch (msg.type) {
    case 'getTabState':
      return msg.tabId === undefined || Number.isInteger(msg.tabId);
    case 'setTabPaused':
      return Number.isInteger(msg.tabId) && typeof msg.paused === 'boolean';
    case 'copyText':
      return typeof msg.text === 'string' && msg.text.length <= 32_768;
    case 'openUnmodified':
      return typeof msg.url === 'string' && msg.url.length <= 32_768;
    default:
      return false;
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isMessage(message)) return false;
  // Extension pages (popup, options – also when opened in a tab) have an
  // extension URL; content scripts report the web page's URL.
  const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL('')) === true;
  const fromContentScript = !fromExtensionPage;

  if (message.type === 'getTabState') {
    // Content scripts may only ask about their own tab.
    const tabId = fromContentScript ? sender.tab?.id : (message.tabId ?? sender.tab?.id);
    if (tabId === undefined) return false;
    void isTabPaused(tabId).then((paused) => sendResponse({ paused } satisfies TabState));
    return true;
  }
  if (fromContentScript) return false; // privileged messages: extension pages only
  if (message.type === 'setTabPaused') {
    void setTabPaused(message.tabId, message.paused).then(() => sendResponse(true));
    return true;
  }
  if (message.type === 'copyText') {
    void copyToClipboard(message.text).then(sendResponse);
    return true;
  }
  if (message.type === 'openUnmodified') {
    void openUnmodified(message.url).then(() => sendResponse(true));
    return true;
  }
  return false;
});

// Service workers can be restarted at any time; make sure rules match settings.
void applyRules();
