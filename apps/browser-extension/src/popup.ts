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
const siteNoteText = $('site-note-text');
const exceptionHint = $('l-exception-d');
const heroResume = $('hero-resume') as HTMLButtonElement;
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

/** The hero names the mode; the selected mode row below explains it (no repetition). */
const MODE_DETAIL = {
  clean: 'Clean mode · cleaning links automatically',
  strict: 'Strict mode · cleaning links automatically',
  experimental: 'Experimental mode',
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
    detail = 'Cleaning resumes automatically.';
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
      status = 'Not cleaned on this site';
      detail = 'Exception · other sites are still cleaned';
      tone = 'off';
    }
  }
  statusEl.textContent = status;
  statusDetail.textContent = detail;
  hero?.classList.toggle('is-off', tone === 'off');
  hero?.classList.toggle('is-warn', tone === 'warn');
  heroResume.hidden = !paused;

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
  siteNoteText.textContent = byParent ? `Covered by the exception for ${covering}.` : '';
  siteNote.hidden = !byParent;
  // "Includes subdomains" means nothing for IP addresses and single-label hosts.
  exceptionHint.hidden = !host.includes('.') || /^[\d.]+$|^\[/.test(host);
  copyBtn.disabled = tab?.url === undefined || hostOf(tab.url) === '';
  copyBtn.title = copyBtn.disabled ? 'This tab shows no web page' : '';
  if (copyBtn.disabled && copyResult.textContent === '')
    copyResult.textContent = 'Open a web page to copy its clean link.';
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
          'still fails without cleaning – probably not caused by Untrackable. If another site is involved, try “Pause in this tab” and reload.';
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
heroResume.addEventListener('click', () => void saveSettings({ pausedUntil: 0 }));
$('site-note-settings').addEventListener('click', () => void chrome.runtime.openOptionsPage());
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
