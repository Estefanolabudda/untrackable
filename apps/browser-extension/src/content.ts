/**
 * Copy cleaning content script.
 *
 * When the user copies a selection that is exactly one http(s) link, the
 * clipboard receives the cleaned link instead. Everything else (normal text,
 * text that merely contains links, cut operations) is left alone so we never
 * alter what the user meant to copy.
 *
 * Runs in Chrome's isolated world. It reads settings only; it never stores,
 * logs or transmits page content or URLs.
 */
import { cleanUrl } from '@untrackable/core';
import { effectiveMode, sanitizeSettings, SETTINGS_KEYS, type Settings, type TabState } from './settings.js';

let settings: Settings = sanitizeSettings({});
let tabPaused = false;

chrome.storage.local.get(SETTINGS_KEYS).then(
  (stored) => {
    settings = sanitizeSettings({ ...settings, ...stored });
  },
  () => {
    /* extension context invalidated (e.g. after update) – keep defaults */
  },
);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const next: Record<string, unknown> = { ...settings };
  for (const [key, change] of Object.entries(changes)) next[key] = change.newValue;
  settings = sanitizeSettings(next);
});

chrome.runtime.sendMessage({ type: 'getTabState' }).then(
  (state: TabState | undefined) => {
    tabPaused = state?.paused === true;
  },
  () => {},
);

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (sender.id !== chrome.runtime.id || typeof message !== 'object' || message === null) return;
  const m = message as { type?: unknown; paused?: unknown };
  if (m.type === 'tabState' && typeof m.paused === 'boolean') tabPaused = m.paused;
});

const SINGLE_URL = /^https?:\/\/\S+$/i;

function selectedText(): string {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const { selectionStart, selectionEnd, value } = active;
    if (selectionStart !== null && selectionEnd !== null && selectionEnd > selectionStart) {
      return value.slice(selectionStart, selectionEnd);
    }
  }
  return window.getSelection()?.toString() ?? '';
}

document.addEventListener(
  'copy',
  (event: ClipboardEvent) => {
    if (!settings.copyCleaning || tabPaused || event.clipboardData === null) return;
    const mode = effectiveMode(settings);
    if (mode === 'bypass') return;
    const text = selectedText().trim();
    if (text.length > 8192 || !SINGLE_URL.test(text)) return;
    const result = cleanUrl(text, { mode, exceptions: settings.exceptions });
    if (result.status !== 'cleaned') return;
    event.clipboardData.setData('text/plain', result.url);
    event.preventDefault();
  },
  true,
);
