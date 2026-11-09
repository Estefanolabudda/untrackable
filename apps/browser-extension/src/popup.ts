import { cleanUrl } from '@untrackable/core';
import { effectiveMode, loadSettings, saveSettings, type Settings, type TabState } from './settings.js';

const PAUSE_MINUTES = 15;

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el;
}

const enabledBox = $('enabled') as HTMLInputElement;
const modeRadios = [...document.querySelectorAll<HTMLInputElement>('input[name="mode"]')];
const pauseBtn = $('pause') as HTMLButtonElement;
const statusEl = $('status');
const siteSection = $('site-section');
const siteHost = $('site-host');
const siteException = $('site-exception') as HTMLInputElement;
const tabPausedBox = $('tab-paused') as HTMLInputElement;
const copyBtn = $('copy') as HTMLButtonElement;
const copyResult = $('copy-result');

let tab: chrome.tabs.Tab | undefined;
let host = '';

function hostOf(url: string | undefined): string {
  if (url === undefined) return '';
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.replace(/\.+$/, '') : '';
  } catch {
    return '';
  }
}

/** The configured exception that covers `host`, if any. */
function coveringException(s: Settings): string | undefined {
  return s.exceptions.find((d) => host === d || host.endsWith(`.${d}`));
}

function render(s: Settings): void {
  const mode = effectiveMode(s);
  enabledBox.checked = s.enabled;
  for (const r of modeRadios) {
    r.checked = r.value === s.mode;
    r.disabled = !s.enabled;
  }
  const paused = s.enabled && s.pausedUntil > Date.now();
  pauseBtn.textContent = paused ? 'Resume now' : `Pause for ${PAUSE_MINUTES} minutes`;
  pauseBtn.disabled = !s.enabled;
  if (!s.enabled) statusEl.textContent = 'Off';
  else if (paused)
    statusEl.textContent = `Paused until ${new Date(s.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  else statusEl.textContent = mode === 'strict' ? 'Strict' : 'Active';
  statusEl.classList.toggle('off', mode === 'bypass');

  siteSection.hidden = host === '';
  siteHost.textContent = host || '–';
  const covering = coveringException(s);
  siteException.checked = covering !== undefined;
  siteException.title = covering !== undefined && covering !== host ? `Covered by exception for ${covering}` : '';
  copyBtn.disabled = tab?.url === undefined || hostOf(tab.url) === '';
}

async function init(): Promise<void> {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  host = hostOf(tab?.url);
  render(await loadSettings());
  if (tab?.id !== undefined && host !== '') {
    const state = (await chrome.runtime.sendMessage({ type: 'getTabState', tabId: tab.id })) as TabState | undefined;
    tabPausedBox.checked = state?.paused === true;
  }
}

enabledBox.addEventListener('change', () => void saveSettings({ enabled: enabledBox.checked, pausedUntil: 0 }));
for (const r of modeRadios) {
  r.addEventListener('change', () => {
    if (r.checked) void saveSettings({ mode: r.value === 'strict' ? 'strict' : 'clean' });
  });
}
pauseBtn.addEventListener('click', async () => {
  const s = await loadSettings();
  const paused = s.pausedUntil > Date.now();
  await saveSettings({ pausedUntil: paused ? 0 : Date.now() + PAUSE_MINUTES * 60_000 });
});
siteException.addEventListener('change', async () => {
  const s = await loadSettings();
  const covering = coveringException(s);
  const exceptions = siteException.checked
    ? [...s.exceptions, host]
    : s.exceptions.filter((d) => d !== covering && d !== host);
  await saveSettings({ exceptions });
});
tabPausedBox.addEventListener('change', async () => {
  if (tab?.id === undefined) return;
  await chrome.runtime.sendMessage({ type: 'setTabPaused', tabId: tab.id, paused: tabPausedBox.checked });
});
copyBtn.addEventListener('click', async () => {
  if (tab?.url === undefined || tab.url.length > 32_768) return;
  const s = await loadSettings();
  const result = cleanUrl(tab.url, { mode: s.mode, exceptions: s.exceptions });
  const ok = (await chrome.runtime.sendMessage({ type: 'copyText', text: result.url })) === true;
  copyResult.textContent = !ok
    ? 'Copy failed'
    : result.removed.length > 0
      ? `Copied – removed ${result.removed.length} tracker${result.removed.length === 1 ? '' : 's'}`
      : 'Copied';
});
$('open-options').addEventListener('click', () => void chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((_c, area) => {
  if (area === 'local') void loadSettings().then(render);
});

void init();
