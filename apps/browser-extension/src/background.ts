/**
 * Untrackable service worker.
 *
 * - Compiles settings into declarativeNetRequest rules (automatic navigation cleaning).
 * - Context menu: "Copy clean link", "Open link without cleaning", "Copy clean page link",
 *   "Copy link without query parameters", "Open link without query parameters".
 * - Keyboard command: copy clean link of the current page.
 * - Per-tab pause and one-time bypass via DNR session rules.
 *
 * Privacy: nothing here transmits URLs or stores them persistently. Per-tab
 * state lives only in DNR session rules, alarms and chrome.storage.session
 * (retry timestamps and – only with the optional retry offer – the URL of a
 * page that hit a redirect loop, for at most 10 minutes) and disappears with
 * the browser session.
 */
import { cleanUrl, compileDnrRules, ID_BASE, PRIORITY, stripQuery } from '@untrackable/core';
import {
  effectiveMode,
  loadSettings,
  migrateStoredSettings,
  saveSettings,
  SETTINGS_KEYS,
  type Message,
  type Settings,
  type TabState,
} from './settings.js';
import {
  addToStats,
  classifyRemoved,
  isZero,
  STATS_KEY,
  STATS_PERMISSION,
  sum,
  verifiedRemovals,
  ZERO,
  type Counts,
} from './stats.js';

const RESUME_ALARM = 'untrackable-resume';
/** Longest URL the extension cleans on explicit actions (Chromium's own limit is 2 MB). */
const MAX_URL_LENGTH = 32_768;

/** True when navigation cleaning had to be disabled because protection rules could not be installed. */
let rulesDegraded = false;
const MENU = {
  copyLink: 'copy-clean-link',
  openUnmodified: 'open-link-unmodified',
  copyPage: 'copy-clean-page-link',
  copyStripped: 'copy-link-without-query',
  openStripped: 'open-link-without-query',
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
  let stripBroken = false;
  for (const rule of rules) {
    const regex = rule.condition.regexFilter;
    if (regex !== undefined) {
      const { isSupported } = await chrome.declarativeNetRequest.isRegexSupported({
        regex,
        // Chromium's default for regex rules is case-insensitive (Chrome 118+).
        isCaseSensitive: rule.condition.isUrlFilterCaseSensitive === true,
        requireCapturing: rule.action.redirect?.regexSubstitution !== undefined,
      });
      if (!isSupported) {
        if (rule.action.type === chrome.declarativeNetRequest.RuleActionType.ALLOW) protectionBroken = true;
        // Without its single strip rule, Experimental would silently do nothing (badge 'E'): say so.
        if (rule.id === ID_BASE.stripQuery) stripBroken = true;
        continue;
      }
    }
    kept.push(rule);
  }
  rulesDegraded = protectionBroken || stripBroken;
  return protectionBroken
    ? kept.filter((r) => r.action.type !== chrome.declarativeNetRequest.RuleActionType.REDIRECT)
    : kept;
}

async function applyRulesNow(): Promise<void> {
  rulesDegraded = false;
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
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: essential });
    } catch {
      // Still failing: the previous rules may belong to another mode (e.g.
      // Experimental after switching to Clean). Remove them all and show '!'
      // rather than keep cleaning with stale rules (found in review).
      rulesDegraded = true;
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds }).catch(() => {});
    }
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
  if (rulesDegraded && mode !== 'bypass') {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#8a4b00' });
    await chrome.action.setTitle({
      title:
        'Untrackable – navigation cleaning disabled: this browser could not install the cleaning or protection rules',
    });
    return;
  }
  const text = { bypass: 'off', strict: 'S', experimental: 'E', clean: '' }[mode];
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({
    color: mode === 'bypass' ? '#5c636b' : mode === 'experimental' ? '#8a4b00' : '#0f5f56',
  });
  const title =
    mode === 'bypass'
      ? settings.enabled
        ? 'Untrackable – paused'
        : 'Untrackable – off'
      : mode === 'experimental'
        ? 'Untrackable – Experimental mode: removes all query parameters (sites may break)'
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

/** Replace the tab's rules of `kind` (remove all, optionally add one). Must run inside `serialised`. */
async function setTabRule(
  tabId: number,
  kind: TabRuleKind,
  present: boolean,
  requestDomains?: string[],
): Promise<void> {
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
      condition: {
        tabIds: [tabId],
        resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME],
        ...(requestDomains === undefined ? {} : { requestDomains }),
      },
    });
  }
  if (remove.length > 0 || addRules.length > 0) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: remove, addRules });
  }
}

function setTabPaused(tabId: number, paused: boolean): Promise<void> {
  return serialised(async () => {
    await setTabRule(tabId, 'pause', paused);
    // Un-pausing also ends a pending one-time bypass in that tab.
    if (!paused) await setTabRule(tabId, 'once', false);
    if (!paused) await chrome.alarms.clear(ONCE_ALARM_PREFIX + tabId);
  });
}

function endOnce(tabId: number): Promise<void> {
  return serialised(async () => {
    const rules = await tabRules(tabId);
    if (!rules.some((r) => kindOf(r.id) === 'once')) return;
    await setTabRule(tabId, 'once', false);
    await chrome.alarms.clear(ONCE_ALARM_PREFIX + tabId);
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
  // A navigation requested while the new tab is still loading its initial
  // about:blank can be swallowed (observed under load), so wait for it first.
  await waitForTab(tabId, (t) => t.status === 'complete');
  // The bypass covers every main-frame request in this tab until the page has
  // loaded (or one minute passes) – including redirectors and click trackers
  // in front of the destination, which is the point of "without cleaning".
  await serialised(() => setTabRule(tabId, 'once', true));
  await chrome.alarms.create(ONCE_ALARM_PREFIX + tabId, { delayInMinutes: ONCE_TIMEOUT_MINUTES });
  // No blind retry: downloads and 204 responses never commit, and a second
  // request could consume a one-time link (found in review).
  await chrome.tabs.update(tabId, { url });
}

/** Poll a tab until `done` holds (or it is gone / the timeout passes). Returns whether `done` held. */
async function waitForTab(tabId: number, done: (t: chrome.tabs.Tab) => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (tab === undefined) return false;
    if (done(tab)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// A one-time bypass ends as soon as the destination page commits (its URL
// shows up), not when it finishes loading – otherwise a slow page could
// navigate onwards while cleaning is still off (found in review). Server
// redirects happen before the commit and stay covered. A reload (loop
// helper) keeps the URL, so the "complete" status ends it there.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const committedUrl = changeInfo.url !== undefined && changeInfo.url !== 'about:blank';
  const completed = changeInfo.status === 'complete' && tab.url !== undefined && tab.url !== 'about:blank';
  if (committedUrl || completed) void endOnce(tabId);
});

// ---------------------------------------------------------------------------
// Redirect-loop recovery (optional permission "webNavigation", off by default)
// ---------------------------------------------------------------------------
//
// If a server insists on a tracking parameter and redirects back to it, the
// cleaned navigation loops until Chromium aborts with ERR_TOO_MANY_REDIRECTS.
// DNR cannot observe this. When the user grants the optional webNavigation
// permission, Untrackable notices such a top-level error, marks the tab
// (badge "↻") and offers "Reload once without cleaning" in the popup.
//
// Safeguards (reviewed three times):
// - never automatic: an extension-initiated load is treated like a typed URL
//   (no Referer, SameSite=Strict cookies), so only an explicit click reloads;
// - the reload is `tabs.reload` of the tab's own error page – Untrackable
//   never navigates to a stored or page-supplied URL and stores no URL at
//   all, only the host for display and scoping;
// - no offer when the failing URL is protected or excepted (our rules cannot
//   have caused that loop);
// - the bypass covers only that host in that tab, once per tab per minute;
// - an offer disappears on the tab's next successful top-level navigation,
//   when the tab closes, when the permission is removed, and after
//   LOOP_OFFER_TTL_MS (alarm).

const REDIRECT_LOOP_ERROR = 'net::ERR_TOO_MANY_REDIRECTS';
const LOOP_RETRY_KEY = 'loopRetries';
const LOOP_OFFER_KEY = 'loopOffers';
const LOOP_PURGE_ALARM = 'untrackable-loop-purge';
const LOOP_RETRY_WINDOW_MS = 60_000;
const LOOP_OFFER_TTL_MS = 10 * 60_000;

/**
 * notOurs: the page failed again after a reload without cleaning its host –
 * probably not caused by Untrackable. Only "probably": the reload bypass is
 * limited to that host, so a loop through another (still cleaned) host can
 * look the same (found in review); the popup points to "Pause in this tab".
 */
type LoopOffers = Record<string, { host: string; at: number; notOurs?: boolean }>;

async function readLoopOffers(): Promise<LoopOffers> {
  const raw = (await chrome.storage.session.get(LOOP_OFFER_KEY))[LOOP_OFFER_KEY];
  const out: LoopOffers = {};
  if (typeof raw === 'object' && raw !== null) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const o = v as { host?: unknown; at?: unknown; notOurs?: unknown };
      if (typeof o?.host === 'string' && typeof o.at === 'number' && Date.now() - o.at < LOOP_OFFER_TTL_MS) {
        out[k] = o.notOurs === true ? { host: o.host, at: o.at, notOurs: true } : { host: o.host, at: o.at };
      }
    }
  }
  return out;
}

/** Replace the offer for `tabId` (undefined removes it); also prunes expired offers. */
function setLoopOffer(tabId: number, host: string | undefined, notOurs = false): Promise<void> {
  return serialised(async () => {
    const offers = Object.fromEntries(
      Object.entries(await readLoopOffers()).filter(([k]) => k !== String(tabId)),
    ) as LoopOffers;
    if (host !== undefined) {
      offers[String(tabId)] = notOurs ? { host, at: Date.now(), notOurs: true } : { host, at: Date.now() };
    }
    await chrome.storage.session.set({ [LOOP_OFFER_KEY]: offers });
    await chrome.alarms.clear(LOOP_PURGE_ALARM);
    if (Object.keys(offers).length > 0) {
      const oldest = Math.min(...Object.values(offers).map((o) => o.at));
      await chrome.alarms.create(LOOP_PURGE_ALARM, { when: oldest + LOOP_OFFER_TTL_MS + 1000 });
    }
    // null resets the tab to the global badge (an empty string would hide S/off/!).
    await chrome.action
      .setBadgeText({ tabId, text: host === undefined ? (null as unknown as string) : '↻' })
      .catch(() => {});
    if (host !== undefined) {
      await chrome.action
        .setTitle({
          tabId,
          title: notOurs
            ? 'Untrackable – this page still fails with cleaning off for this site; the loop is probably not caused by Untrackable.'
            : 'Untrackable – this page failed with too many redirects. Open for options.',
        })
        .catch(() => {});
    }
  });
}

async function purgeLoopOffers(): Promise<void> {
  const before = (await chrome.storage.session.get(LOOP_OFFER_KEY))[LOOP_OFFER_KEY] as
    Record<string, unknown> | undefined;
  const live = await readLoopOffers();
  for (const tabId of Object.keys(before ?? {})) {
    if (!(tabId in live)) await setLoopOffer(Number(tabId), undefined);
  }
}

async function loopOfferHost(tabId: number): Promise<string | undefined> {
  return (await readLoopOffers())[String(tabId)]?.host;
}

async function loopOffer(tabId: number): Promise<LoopOffers[string] | undefined> {
  return (await readLoopOffers())[String(tabId)];
}

/** Atomically claim the single retry for this tab. Returns false if one happened recently. */
function claimLoopRetry(tabId: number, host: string): Promise<boolean> {
  return serialised(async () => {
    const now = Date.now();
    const raw = (await chrome.storage.session.get(LOOP_RETRY_KEY))[LOOP_RETRY_KEY];
    const retries = pruneRetries(raw, now);
    const claimed = retries[String(tabId)] === undefined;
    if (claimed) retries[String(tabId)] = { at: now, host };
    await chrome.storage.session.set({ [LOOP_RETRY_KEY]: retries });
    return claimed;
  });
}

type LoopRetries = Record<string, { at: number; host: string }>;

function pruneRetries(raw: unknown, now: number): LoopRetries {
  const retries: LoopRetries = {};
  if (typeof raw === 'object' && raw !== null) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const r = v as { at?: unknown; host?: unknown };
      if (typeof r?.at === 'number' && typeof r.host === 'string' && now - r.at < LOOP_RETRY_WINDOW_MS) {
        retries[k] = { at: r.at, host: r.host };
      }
    }
  }
  return retries;
}

/** Forget the tab's retry once a top-level page loaded: a later loop is a new event (found in review). */
function clearLoopRetry(tabId: number): Promise<void> {
  return serialised(async () => {
    const raw = (await chrome.storage.session.get(LOOP_RETRY_KEY))[LOOP_RETRY_KEY];
    const retries = pruneRetries(raw, Date.now());
    if (retries[String(tabId)] === undefined) return;
    const rest = Object.fromEntries(Object.entries(retries).filter(([k]) => k !== String(tabId)));
    await chrome.storage.session.set({ [LOOP_RETRY_KEY]: rest });
  });
}

/** Host of a reload without cleaning in this tab within the retry window, if any. */
async function recentRetryHost(tabId: number): Promise<string | undefined> {
  const raw = (await chrome.storage.session.get(LOOP_RETRY_KEY))[LOOP_RETRY_KEY];
  return pruneRetries(raw, Date.now())[String(tabId)]?.host;
}

/** Explicit user action from the popup: reload the failed page once without cleaning its host. */
async function retryLoopWithoutCleaning(tabId: number): Promise<boolean> {
  const host = await loopOfferHost(tabId);
  if (host === undefined) return false;
  await setLoopOffer(tabId, undefined);
  if (!(await claimLoopRetry(tabId, host))) return false;
  await serialised(() => setTabRule(tabId, 'once', true, host.startsWith('[') ? undefined : [host]));
  await chrome.alarms.create(ONCE_ALARM_PREFIX + tabId, { delayInMinutes: ONCE_TIMEOUT_MINUTES });
  await chrome.tabs.reload(tabId);
  return true;
}

async function onRedirectLoop(tabId: number, url: string): Promise<void> {
  const settings = await loadSettings();
  const mode = effectiveMode(settings);
  if (mode === 'bypass' || url.length > MAX_URL_LENGTH || !/^https?:/i.test(url)) return;
  // Our rules never touch protected or excepted URLs, so such a loop is not ours.
  const { status } = cleanUrl(url, { mode, exceptions: settings.exceptions });
  if (status === 'protected' || status === 'excepted' || status === 'invalid') return;
  let host: string;
  try {
    host = new URL(url).hostname.replace(/\.+$/, '');
  } catch {
    return;
  }
  if (host === '') return;
  // Failing again right after a reload without cleaning on the same host means
  // the loop is not caused by Untrackable – say so instead of blaming cleaning.
  const notOurs = (await recentRetryHost(tabId)) === host;
  await setLoopOffer(tabId, host, notOurs);
}

function onNavigationError(details: { tabId: number; frameId: number; url: string; error: string }): void {
  if (details.frameId !== 0 || details.tabId < 0 || details.error !== REDIRECT_LOOP_ERROR) return;
  void onRedirectLoop(details.tabId, details.url);
}

function onNavigationCommitted(details: { tabId: number; frameId: number }): void {
  if (details.frameId !== 0 || details.tabId < 0) return;
  // A successful top-level load supersedes any pending offer and retry for this tab.
  void loopOfferHost(details.tabId).then((h) => (h === undefined ? undefined : setLoopOffer(details.tabId, undefined)));
  void clearLoopRetry(details.tabId);
}

function registerLoopRecovery(): void {
  // chrome.webNavigation only exists while the optional permission is granted.
  const nav = (chrome as { webNavigation?: typeof chrome.webNavigation }).webNavigation;
  if (nav === undefined) return;
  if (!nav.onErrorOccurred.hasListener(onNavigationError)) nav.onErrorOccurred.addListener(onNavigationError);
  if (!nav.onCommitted.hasListener(onNavigationCommitted)) nav.onCommitted.addListener(onNavigationCommitted);
}

registerLoopRecovery();
chrome.permissions.onAdded.addListener(registerLoopRecovery);
chrome.permissions.onRemoved.addListener(() => {
  void (async () => {
    for (const tabId of Object.keys(await readLoopOffers())) await setLoopOffer(Number(tabId), undefined);
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void readLoopOffers().then((offers) => (offers[String(tabId)] ? setLoopOffer(tabId, undefined) : undefined));
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
function copyToClipboard(text: string, stillWanted: () => boolean = () => true): Promise<boolean> {
  const run = clipboardQueue.then(async () => {
    if (!stillWanted()) return false;
    await ensureOffscreen();
    // Checked again right before writing, so a newer copy wins whenever possible.
    if (!stillWanted()) return false;
    // The offscreen document stays open between writes: it only accepts
    // messages from this service worker, and reopening it for every keyboard
    // copy would widen the window in which a slow write could replace a newer
    // copy. Chromium closes it together with the service worker.
    const ok: unknown = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text });
    return ok === true;
  });
  clipboardQueue = run.catch(() => {});
  return run.catch(() => false);
}

/**
 * Order of copies (keyboard copies seen by content scripts in all tabs and
 * explicit copy actions); a pending keyboard copy may only write while it is
 * the latest, so it never replaces a later explicit copy (found in review).
 */
let copySeq = 0;

/**
 * Explicit user action ("Copy clean link"): clean with the configured mode even
 * while automatic cleaning is paused – the user asked for a clean link.
 * Domain exceptions are still honoured.
 */
async function copyClean(url: string, tab?: chrome.tabs.Tab): Promise<void> {
  const seq = ++copySeq;
  if (url.length > MAX_URL_LENGTH) return; // hostile pages can craft huge hrefs
  const settings = await loadSettings();
  const result = cleanUrl(url, { mode: settings.mode, exceptions: settings.exceptions });
  if (await copyToClipboard(result.url, () => seq === copySeq)) {
    await recordStatsFor(tab, classifyRemoved(url, result, settings.mode, settings.exceptions));
  }
}

/**
 * Explicit user actions "Copy/Open link without query parameters". They strip
 * the whole query even where automatic cleaning would protect the link (the
 * user asked for exactly that) – but only on a click, never automatically, and
 * never for anything but http(s). Opening is a single new-tab navigation: no
 * bypass rule, no retry; the stripped URL is cleaned like any other.
 */
async function copyStripped(url: string): Promise<void> {
  const seq = ++copySeq;
  if (url.length > MAX_URL_LENGTH) return;
  const result = stripQuery(url);
  if (result.status !== 'cleaned' && result.status !== 'unchanged') return;
  await copyToClipboard(result.url, () => seq === copySeq);
}

async function openStripped(url: string, openerTab?: chrome.tabs.Tab): Promise<void> {
  if (url.length > MAX_URL_LENGTH) return;
  const result = stripQuery(url);
  if (result.status !== 'cleaned' && result.status !== 'unchanged') return;
  const createProps: chrome.tabs.CreateProperties = { url: result.url, active: true };
  if (openerTab?.id !== undefined) createProps.openerTabId = openerTab.id;
  if (openerTab?.index !== undefined) createProps.index = openerTab.index + 1;
  await chrome.tabs.create(createProps);
}

// ---------------------------------------------------------------------------
// Local statistics (optional permission "webRequest", off by default)
// ---------------------------------------------------------------------------
//
// Counts how many parameters Untrackable removed – nothing else. DNR does not
// report its redirects, so with the user's opt-in the service worker observes
// top-level navigations (read-only, no blocking) and compares the requested
// with the actually sent URL. A difference is counted only when it is exactly
// the removal of query parameters the engine removes from that URL with the
// current settings (`verifiedRemovals`); server redirects, HSTS upgrades and
// other extensions' rewrites count 0. Copies count what was written.
//
// Privacy: URLs live only in memory for the duration of a request; storage
// holds aggregate numbers per local date for the last seven days and a total.
// Incognito tabs and prerendered pages are never counted. Turning statistics
// off removes the permission and deletes the numbers (found in review: every
// write and delete runs in one queue, so a pending write cannot bring deleted
// numbers back).

let pendingStats: Counts = { ...ZERO };
let statsTimer: ReturnType<typeof setTimeout> | undefined;
let statsQueue: Promise<void> = Promise.resolve();

/**
 * Upper bound per counted event. Real links carry a handful of trackers; a
 * page could otherwise inflate the numbers with a crafted URL (found in review).
 */
const MAX_COUNT_PER_EVENT = 20;

/**
 * Incognito tabs only reach the extension when the user allowed it there
 * (Chromium restarts the extension when that switch changes).
 */
const incognitoAllowed: Promise<boolean> = chrome.extension.isAllowedIncognitoAccess().catch(() => true);
/** Tab id → incognito, learnt when a page load starts (the tab may be closed by the time it is counted). */
const tabIncognito = new Map<number, boolean>();

async function isIncognito(tab: chrome.tabs.Tab | number | undefined): Promise<boolean | undefined> {
  if (!(await incognitoAllowed)) return false;
  if (typeof tab !== 'number') return tab?.incognito;
  const known = tabIncognito.get(tab);
  if (known !== undefined) return known;
  return (await chrome.tabs.get(tab).catch(() => undefined))?.incognito;
}

/** Count for a tab – never for an incognito one (the numbers would outlive the private session). */
async function recordStatsFor(tab: chrome.tabs.Tab | number | undefined, add: Counts): Promise<void> {
  if (isZero(add)) return;
  if ((await isIncognito(tab)) !== false) return;
  const trackers = Math.min(add.trackers, MAX_COUNT_PER_EVENT);
  recordStats({ trackers, other: Math.min(add.other, MAX_COUNT_PER_EVENT - trackers) });
}

function recordStats(add: Counts): void {
  if (isZero(add)) return;
  pendingStats = sum(pendingStats, add);
  statsTimer ??= setTimeout(() => {
    statsTimer = undefined;
    statsQueue = statsQueue.then(flushStats, flushStats);
  }, 250);
}

async function flushStats(): Promise<void> {
  const add = pendingStats;
  pendingStats = { ...ZERO };
  if (isZero(add) || !(await chrome.permissions.contains(STATS_PERMISSION))) return;
  const stored = (await chrome.storage.local.get(STATS_KEY))[STATS_KEY];
  await chrome.storage.local.set({ [STATS_KEY]: addToStats(stored, add) });
  // Switched off meanwhile (e.g. in chrome://extensions): never leave numbers behind.
  if (!(await chrome.permissions.contains(STATS_PERMISSION))) await chrome.storage.local.remove(STATS_KEY);
}

/** Delete the numbers, after any write already queued. */
function deleteStats(): Promise<void> {
  pendingStats = { ...ZERO };
  const run = statsQueue.then(() => chrome.storage.local.remove(STATS_KEY));
  statsQueue = run.catch(() => {});
  return run;
}

/** Top-level request id → URL last requested for it (memory only, never stored). */
const requested = new Map<string, string>();
const MAX_TRACKED_REQUESTS = 500;

async function countNavigation(from: string, to: string, tabId: number): Promise<void> {
  if (from.length > MAX_URL_LENGTH || to.length > MAX_URL_LENGTH) return;
  const settings = await loadSettings();
  const mode = effectiveMode(settings);
  if (mode === 'bypass' || (await tabRules(tabId)).length > 0) return;
  await recordStatsFor(tabId, verifiedRemovals(from, to, mode, settings.exceptions));
}

function onStatsBeforeRequest(d: chrome.webRequest.OnBeforeRequestDetails): undefined {
  // Prerendered pages may never be shown; their URL is not kept either.
  const lifecycle = (d as { documentLifecycle?: string }).documentLifecycle;
  if (d.tabId < 0 || lifecycle === 'prerender' || d.url.length > MAX_URL_LENGTH) {
    requested.delete(d.requestId);
    return undefined;
  }
  if (requested.size >= MAX_TRACKED_REQUESTS) requested.clear();
  requested.set(d.requestId, d.url);
  const tabId = d.tabId;
  if (!tabIncognito.has(tabId)) {
    void incognitoAllowed.then(async (allowed) => {
      if (!allowed) return;
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (tab === undefined) return;
      if (tabIncognito.size >= MAX_TRACKED_REQUESTS) tabIncognito.clear();
      tabIncognito.set(tabId, tab.incognito);
    });
  }
  return undefined;
}

/** A DNR rewrite of a server redirect's target changes the URL in place: requested ≠ sent. */
function checkInPlace(d: { requestId: string; url: string; tabId: number }): void {
  const from = requested.get(d.requestId);
  if (from !== undefined && from !== d.url) void countNavigation(from, d.url, d.tabId);
}

function onStatsBeforeRedirect(d: chrome.webRequest.OnBeforeRedirectDetails): void {
  if (d.tabId < 0) return;
  checkInPlace(d);
  requested.delete(d.requestId);
  // Redirects made inside the browser (DNR, HSTS, other extensions) have no
  // server address; verifiedRemovals tells ours apart.
  const lifecycle = (d as { documentLifecycle?: string }).documentLifecycle;
  if (
    lifecycle !== 'prerender' &&
    d.statusCode === 307 &&
    d.ip === undefined &&
    /Internal Redirect/i.test(d.statusLine)
  ) {
    void countNavigation(d.url, d.redirectUrl, d.tabId);
  }
}

function onStatsCompleted(d: chrome.webRequest.OnCompletedDetails): void {
  if (d.tabId < 0) return;
  checkInPlace(d);
  requested.delete(d.requestId);
}

function onStatsError(d: chrome.webRequest.OnErrorOccurredDetails): void {
  if (d.tabId < 0) return;
  requested.delete(d.requestId);
}

/** Returns whether the listeners are registered. */
function registerStats(): boolean {
  // chrome.webRequest only exists while the optional permission is granted.
  const wr = (chrome as { webRequest?: typeof chrome.webRequest }).webRequest;
  if (wr === undefined) return false;
  const filter: chrome.webRequest.RequestFilter = {
    urls: ['http://*/*', 'https://*/*'],
    types: [chrome.webRequest.ResourceType.MAIN_FRAME],
  };
  if (!wr.onBeforeRequest.hasListener(onStatsBeforeRequest))
    wr.onBeforeRequest.addListener(onStatsBeforeRequest, filter);
  if (!wr.onBeforeRedirect.hasListener(onStatsBeforeRedirect)) {
    wr.onBeforeRedirect.addListener(onStatsBeforeRedirect, filter);
  }
  if (!wr.onCompleted.hasListener(onStatsCompleted)) wr.onCompleted.addListener(onStatsCompleted, filter);
  if (!wr.onErrorOccurred.hasListener(onStatsError)) wr.onErrorOccurred.addListener(onStatsError, filter);
  return true;
}

/**
 * Chrome 116 fires permissions.onAdded before chrome.webRequest appears in a
 * running service worker (verified in e2e): try again briefly.
 */
function registerStatsSoon(attempt = 0): void {
  if (registerStats() || attempt >= 20) return;
  setTimeout(() => registerStatsSoon(attempt + 1), 100);
}

registerStats();
chrome.permissions.onAdded.addListener(() => registerStatsSoon());
function deleteStatsIfOff(): void {
  void chrome.permissions.contains(STATS_PERMISSION).then((granted) => {
    if (granted) return;
    requested.clear();
    return deleteStats();
  });
}
chrome.permissions.onRemoved.addListener(deleteStatsIfOff);
// Also on every service-worker start, in case a removal was missed.
deleteStatsIfOff();

/** Popup "Copy clean link": clean the tab's URL with the configured mode (also while paused). */
async function copyCleanTab(tabId: number): Promise<{ ok: boolean; removed: number }> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const url = tab?.url;
  if (url === undefined || url.length > MAX_URL_LENGTH || !/^https?:/i.test(url)) return { ok: false, removed: 0 };
  const seq = ++copySeq;
  const settings = await loadSettings();
  const result = cleanUrl(url, { mode: settings.mode, exceptions: settings.exceptions });
  const ok = await copyToClipboard(result.url, () => seq === copySeq);
  if (ok) await recordStatsFor(tab, classifyRemoved(url, result, settings.mode, settings.exceptions));
  return { ok, removed: ok ? result.removed.length : 0 };
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

/**
 * Copy cleaning, decided here so settings never reach web pages.
 *
 * The content script reports every keyboard copy the page did not handle
 * itself, with the copied text if it is exactly one link. For such a link the
 * clipboard is **always** rewritten right after the native copy – with the
 * clean link if the settings say so, otherwise with the same link unchanged.
 * Writing in every case is deliberate: Chromium notifies pages of clipboard
 * changes (`clipboardchange`), so writing only when something was cleaned
 * would reveal mode, pause state and exception domains (found in review).
 * Only when the user switched copy cleaning (or Untrackable) off entirely is
 * nothing written.
 *
 * Only the latest copy may write, so a slow write never replaces something
 * the user copied afterwards. A content script can only cause the copied link
 * itself or its cleaned version to be written, never arbitrary text.
 */
async function onCopiedLink(tabId: number, url: string | undefined): Promise<void> {
  const seq = ++copySeq;
  if (url === undefined) return; // a newer non-link copy supersedes pending writes
  const settings = await loadSettings();
  // Switched off means no clipboard writes at all. (A page can therefore tell
  // whether copy cleaning is switched on – but not mode, pauses or exceptions.)
  if (!settings.enabled || !settings.copyCleaning) return;
  const effective = effectiveMode(settings);
  // Experimental strips whole queries on purpose while navigating, but a
  // keyboard copy must not silently replace the user's clipboard with a link
  // that may no longer work (search, video, wrapped links – found in review):
  // copies are cleaned with the Strict rules. Explicit "Copy clean link" and
  // "Copy link without query parameters" still strip.
  const mode = effective === 'experimental' ? 'strict' : effective;
  const active = mode !== 'bypass' && (await tabRules(tabId)).length === 0;
  const result = active ? cleanUrl(url, { mode, exceptions: settings.exceptions }) : undefined;
  const text = result?.status === 'cleaned' ? result.url : url;
  const written = await copyToClipboard(text, () => seq === copySeq);
  if (written && result !== undefined)
    await recordStatsFor(tabId, classifyRemoved(url, result, mode, settings.exceptions));
}

function createMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU.copyLink, title: 'Copy clean link', contexts: ['link'] });
    chrome.contextMenus.create({ id: MENU.openUnmodified, title: 'Open link without cleaning', contexts: ['link'] });
    chrome.contextMenus.create({ id: MENU.copyPage, title: 'Copy clean page link', contexts: ['page'] });
    chrome.contextMenus.create({
      id: MENU.copyStripped,
      title: 'Copy link without query parameters',
      contexts: ['link'],
    });
    chrome.contextMenus.create({
      id: MENU.openStripped,
      title: 'Open link without query parameters',
      contexts: ['link'],
    });
  });
}

/**
 * Context menus and the stored settings format must match this version.
 * onInstalled (install, and an update via "reload" in chrome://extensions –
 * covered by the upgrade e2e tests from 0.1.0 and 0.2.0) refreshes both
 * unconditionally. As a safety net every service-worker start also checks a
 * per-browser-session marker, in case a future update path skips onInstalled.
 * (Replacing the folder and only restarting the browser is not an update:
 * Chromium keeps running the previously registered service worker until the
 * extension is reloaded – the README tells users to reload.)
 */
const LIFECYCLE_KEY = 'lifecycleVersion';

/**
 * At most one refresh at a time: on install, update and browser start the
 * top-level check and onInstalled/onStartup fire together, and two concurrent
 * runs would interleave `contextMenus.removeAll`/`create` (found in review).
 */
let refreshing: Promise<void> | undefined;

function refreshForThisVersion(): Promise<void> {
  refreshing ??= (async () => {
    createMenus();
    // The marker is only set after a successful migration, so a failed one is
    // retried on the next service-worker start (found in review).
    const migrated = await migrateStoredSettings().then(
      () => true,
      () => false,
    );
    if (migrated) await chrome.storage.session.set({ [LIFECYCLE_KEY]: chrome.runtime.getManifest().version });
    await applyRules();
  })()
    .catch(() => {})
    .finally(() => {
      refreshing = undefined;
    });
  return refreshing;
}

async function refreshIfNeeded(): Promise<void> {
  const done = await chrome.storage.session.get(LIFECYCLE_KEY).then(
    (r) => r[LIFECYCLE_KEY],
    () => undefined,
  );
  if (done !== chrome.runtime.getManifest().version) await refreshForThisVersion();
}

chrome.runtime.onInstalled.addListener(() => void refreshForThisVersion());
chrome.runtime.onStartup.addListener(() => void refreshIfNeeded());

chrome.storage.onChanged.addListener((changes, area) => {
  // Only settings affect the rules (statistics are stored in the same area).
  if (area === 'local' && Object.keys(changes).some((k) => (SETTINGS_KEYS as string[]).includes(k))) {
    void applyRules();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RESUME_ALARM) void saveSettings({ pausedUntil: 0 });
  else if (alarm.name === LOOP_PURGE_ALARM) void purgeLoopOffers();
  else if (alarm.name.startsWith(ONCE_ALARM_PREFIX)) {
    const tabId = Number(alarm.name.slice(ONCE_ALARM_PREFIX.length));
    if (Number.isInteger(tabId)) void endOnce(tabId);
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU.copyLink && info.linkUrl) void copyClean(info.linkUrl, tab);
  else if (info.menuItemId === MENU.openUnmodified && info.linkUrl) void openUnmodified(info.linkUrl, tab);
  else if (info.menuItemId === MENU.copyStripped && info.linkUrl) void copyStripped(info.linkUrl);
  else if (info.menuItemId === MENU.openStripped && info.linkUrl) void openStripped(info.linkUrl, tab);
  else if (info.menuItemId === MENU.copyPage) {
    const pageUrl = info.pageUrl ?? tab?.url;
    if (pageUrl !== undefined) void copyClean(pageUrl, tab);
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'copy-clean-link' || tab?.url === undefined) return;
  void copyClean(tab.url, tab);
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
    case 'copyCleanTab':
      return Number.isInteger(msg.tabId);
    case 'resetStats':
      return true;
    case 'openUnmodified':
      return typeof msg.url === 'string' && msg.url.length <= 32_768;
    case 'retryLoop':
      return Number.isInteger(msg.tabId);
    case 'copied':
      return msg.url === undefined || (typeof msg.url === 'string' && msg.url.length <= 8192);
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
    void Promise.all([tabRules(tabId), fromContentScript ? undefined : loopOffer(tabId)]).then(([rules, offer]) => {
      const state: TabState = {
        paused: rules.length > 0,
        pausedByUser: rules.some((r) => kindOf(r.id) === 'pause'),
      };
      if (offer !== undefined) {
        // extension pages only
        state.loopHost = offer.host;
        if (offer.notOurs === true) state.loopNotOurs = true;
      }
      sendResponse(state);
    });
    return true;
  }
  if (message.type === 'copied') {
    // Content scripts only: the user just copied with the keyboard.
    if (!fromContentScript || sender.tab?.id === undefined) return false;
    void onCopiedLink(sender.tab.id, message.url);
    return false;
  }
  if (fromContentScript) return false; // privileged messages: extension pages only
  if (message.type === 'setTabPaused') {
    void setTabPaused(message.tabId, message.paused).then(() => sendResponse(true));
    return true;
  }
  if (message.type === 'copyText') {
    const seq = ++copySeq;
    void copyToClipboard(message.text, () => seq === copySeq).then(sendResponse);
    return true;
  }
  if (message.type === 'resetStats') {
    void deleteStats().then(() => sendResponse(true));
    return true;
  }
  if (message.type === 'copyCleanTab') {
    void copyCleanTab(message.tabId).then(sendResponse);
    return true;
  }
  if (message.type === 'openUnmodified') {
    void openUnmodified(message.url).then(() => sendResponse(true));
    return true;
  }
  if (message.type === 'retryLoop') {
    void retryLoopWithoutCleaning(message.tabId).then(sendResponse);
    return true;
  }
  return false;
});

// Service workers can be restarted at any time; make sure rules match settings.
void applyRules();
void refreshIfNeeded();
