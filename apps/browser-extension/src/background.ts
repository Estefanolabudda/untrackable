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

async function applyRulesNow(): Promise<void> {
  const settings = await loadSettings();
  const mode = effectiveMode(settings);
  const addRules =
    mode === 'bypass'
      ? []
      : (compileDnrRules({ mode, exceptions: settings.exceptions }) as chrome.declarativeNetRequest.Rule[]);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules,
  });
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

/** Session rule ids: tabId + offset, so each tab has at most one rule. */
const TAB_RULE_OFFSET = 1;
const ONCE_KEY = 'onceTabs';

function tabRuleId(tabId: number): number {
  return tabId + TAB_RULE_OFFSET;
}

async function isTabPaused(tabId: number): Promise<boolean> {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  return rules.some((r) => r.id === tabRuleId(tabId));
}

async function setTabPaused(tabId: number, paused: boolean): Promise<void> {
  const id = tabRuleId(tabId);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: paused
      ? [
          {
            id,
            priority: PRIORITY.tabPause,
            action: { type: chrome.declarativeNetRequest.RuleActionType.ALLOW },
            condition: {
              tabIds: [tabId],
              resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME],
            },
          },
        ]
      : [],
  });
  if (!paused) await forgetOnce(tabId);
  // Tell the tab's content script so copy cleaning follows the tab state.
  chrome.tabs.sendMessage(tabId, { type: 'tabState', paused } satisfies { type: string } & TabState).catch(() => {
    /* no content script in this tab (e.g. chrome:// page) */
  });
}

async function getOnceTabs(): Promise<number[]> {
  const v = (await chrome.storage.session.get(ONCE_KEY))[ONCE_KEY];
  return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : [];
}

async function forgetOnce(tabId: number): Promise<void> {
  const once = await getOnceTabs();
  if (once.includes(tabId)) await chrome.storage.session.set({ [ONCE_KEY]: once.filter((t) => t !== tabId) });
}

/** One-time bypass: open `url` in a new tab with cleaning disabled for that single page load. */
async function openUnmodified(url: string, openerTab?: chrome.tabs.Tab): Promise<void> {
  if (!/^https?:/i.test(url)) return;
  const createProps: chrome.tabs.CreateProperties = { url: 'about:blank', active: true };
  if (openerTab?.id !== undefined) createProps.openerTabId = openerTab.id;
  if (openerTab?.index !== undefined) createProps.index = openerTab.index + 1;
  const tab = await chrome.tabs.create(createProps);
  if (tab.id === undefined) return;
  await setTabPaused(tab.id, true);
  await chrome.storage.session.set({ [ONCE_KEY]: [...(await getOnceTabs()), tab.id] });
  await chrome.tabs.update(tab.id, { url });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || tab.url === undefined || tab.url === 'about:blank') return;
  void getOnceTabs().then(async (once) => {
    if (once.includes(tabId)) await setTabPaused(tabId, false);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabRuleId(tabId)] });
  void forgetOnce(tabId);
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

async function copyToClipboard(text: string): Promise<boolean> {
  await ensureOffscreen();
  const ok: unknown = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text });
  return ok === true;
}

/**
 * Explicit user action ("Copy clean link"): clean with the configured mode even
 * while automatic cleaning is paused – the user asked for a clean link.
 * Domain exceptions are still honoured.
 */
async function copyClean(url: string): Promise<void> {
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
