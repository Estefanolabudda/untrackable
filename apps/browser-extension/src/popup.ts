import { setupModeControls } from './mode-controls.js';
import { loadSettings, saveSettings, SETTINGS_KEYS, type Settings, type TabState } from './settings.js';
import { renderStats, setStatsEnabled, watchStats } from './stats-view.js';

const PAUSE_MINUTES = 15;

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el;
}

const hero = document.querySelector<HTMLElement>('.hero');
const enabledBox = $('enabled') as HTMLInputElement;
const modeControls = setupModeControls();
const pauseBtn = $('pause') as HTMLButtonElement;
const pauseLabel = $('pause-label');
const pauseIcon = $('pause-icon');
const statusEl = $('status');
const statusDetail = $('status-detail');
const siteSection = $('site-section');
const siteHost = $('site-host');
const siteException = $('site-exception') as HTMLInputElement;
const tabPausedBox = $('tab-paused') as HTMLInputElement;
const copyBtn = $('copy') as HTMLButtonElement;
const copyResult = $('copy-result');
const loopSection = $('loop-section');
const loopHostEl = $('loop-host');
const loopRetry = $('loop-retry') as HTMLButtonElement;
const siteNote = $('site-note');
const statsEnable = $('stats-enable') as HTMLButtonElement;

let tab: chrome.tabs.Tab | undefined;
let host = '';
let tabPaused = false;
let latest: Settings | undefined;

function hostOf(url: string | undefined): string {
  if (url === undefined) return '';
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.replace(/\.+$/, '') : '';
  } catch {
    return '';
  }
}

/** The first configured exception that covers `host`, if any. */
function coveringException(s: Settings): string | undefined {
  return s.exceptions.find((d) => host === d || host.endsWith(`.${d}`));
}

const MODE_DETAIL = {
  clean: 'Clean · removes known trackers',
  strict: 'Strict · also removes referral and analytics tags',
  experimental: 'Experimental · removes all after “?”',
} as const;

function render(s: Settings): void {
  latest = s;
  const paused = s.enabled && s.pausedUntil > Date.now();
  const covering = coveringException(s);
  enabledBox.checked = s.enabled;
  modeControls.render(s);

  // The status is always spelled out – never conveyed by colour alone.
  let status: string;
  let detail: string;
  let tone: 'on' | 'off' | 'warn' = 'on';
  if (!s.enabled) {
    status = 'Off';
    detail = 'Links are not cleaned.';
    tone = 'off';
  } else if (paused) {
    const until = new Date(s.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    status = `Paused until ${until}`;
    detail = 'Resumes automatically, or choose Resume.';
    tone = 'off';
  } else {
    status = 'On';
    detail = MODE_DETAIL[s.mode];
    if (s.mode === 'experimental') tone = 'warn';
    if (host !== '' && tabPaused) {
      status = 'Paused in this tab';
      detail = 'Other tabs are still cleaned';
      tone = 'off';
    } else if (covering !== undefined) {
      detail = 'This site is never cleaned (exception)';
    }
  }
  statusEl.textContent = status;
  statusDetail.textContent = detail;
  hero?.classList.toggle('is-off', tone === 'off');
  hero?.classList.toggle('is-warn', tone === 'warn');

  pauseLabel.textContent = paused ? 'Resume' : `Pause all · ${PAUSE_MINUTES} min`;
  pauseIcon.setAttribute('href', paused ? '#i-play' : '#i-pause');
  pauseBtn.title = paused ? 'Resume cleaning now' : `Pause cleaning everywhere for ${PAUSE_MINUTES} minutes`;
  pauseBtn.disabled = !s.enabled;

  siteSection.hidden = host === '';
  siteHost.textContent = host || '–';
  siteHost.title = host;
  siteException.checked = covering !== undefined;
  // An exception for a parent domain is managed in the settings, not silently
  // removed from here (found in review).
  const byParent = covering !== undefined && covering !== host;
  siteException.disabled = byParent;
  siteNote.textContent = byParent ? `Covered by the exception for ${covering} (change it in Settings).` : '';
  copyBtn.disabled = tab?.url === undefined || hostOf(tab.url) === '';
}

async function init(): Promise<void> {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  host = hostOf(tab?.url);
  render(await loadSettings());
  void renderStats();
  if (tab?.id !== undefined && host !== '') {
    const state = (await chrome.runtime.sendMessage({ type: 'getTabState', tabId: tab.id })) as TabState | undefined;
    tabPaused = state?.pausedByUser === true;
    tabPausedBox.checked = tabPaused;
    if (latest !== undefined) render(latest);
    // Only offer the reload for the page that actually failed.
    if (state?.loopHost !== undefined && state.loopHost === host) {
      loopHostEl.textContent = state.loopHost;
      if (state.loopNotOurs === true) {
        $('loop-text').textContent =
          'still fails with cleaning turned off for this site – the loop is probably not caused by Untrackable. If it involves another site, use “Pause in this tab” and reload; otherwise try again later or contact the site.';
        loopRetry.hidden = true;
      }
      loopSection.hidden = false;
    }
  }
}

enabledBox.addEventListener('change', () => void saveSettings({ enabled: enabledBox.checked, pausedUntil: 0 }));
pauseBtn.addEventListener('click', async () => {
  const s = await loadSettings();
  const paused = s.pausedUntil > Date.now();
  await saveSettings({ pausedUntil: paused ? 0 : Date.now() + PAUSE_MINUTES * 60_000 });
});
siteException.addEventListener('change', async () => {
  const s = await loadSettings();
  const exceptions = siteException.checked ? [...s.exceptions, host] : s.exceptions.filter((d) => d !== host);
  await saveSettings({ exceptions });
});
tabPausedBox.addEventListener('change', async () => {
  if (tab?.id === undefined) return;
  tabPaused = tabPausedBox.checked;
  if (latest !== undefined) render(latest);
  await chrome.runtime.sendMessage({ type: 'setTabPaused', tabId: tab.id, paused: tabPausedBox.checked });
});
copyBtn.addEventListener('click', async () => {
  if (tab?.id === undefined) return;
  const s = await loadSettings();
  const result = (await chrome.runtime.sendMessage({ type: 'copyCleanTab', tabId: tab.id }).catch(() => undefined)) as
    { ok: boolean; removed: number } | undefined;
  const what = s.mode === 'experimental' ? 'parameter' : 'tracker';
  copyResult.textContent =
    result?.ok !== true
      ? 'Copy failed'
      : result.removed > 0
        ? `Copied – removed ${result.removed} ${what}${result.removed === 1 ? '' : 's'}`
        : 'Copied – nothing to remove';
});
loopRetry.addEventListener('click', async () => {
  if (tab?.id === undefined) return;
  loopRetry.disabled = true;
  const ok = (await chrome.runtime.sendMessage({ type: 'retryLoop', tabId: tab.id })) === true;
  if (ok) window.close();
  else if (loopHostEl.parentElement)
    loopHostEl.parentElement.textContent = 'Not possible right now – at most one reload per minute.';
});
statsEnable.addEventListener('click', () => void setStatsEnabled(true).then(() => renderStats()));
$('open-options').addEventListener('click', () => void chrome.runtime.openOptionsPage());
$('stats-about').addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#stats') }).then(() => window.close());
});

// Only settings changes re-render (statistics writes would steal focus).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => (SETTINGS_KEYS as string[]).includes(k))) {
    void loadSettings().then(render);
  }
});
watchStats(() => void renderStats());

void init();
