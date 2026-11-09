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
let settingsLoaded = false;
let tabPaused = false;

chrome.storage.local.get(SETTINGS_KEYS).then(
  (stored) => {
    settings = sanitizeSettings({ ...settings, ...stored });
    settingsLoaded = true; // never act on defaults: the user may have turned cleaning off
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

/**
 * Copy events triggered by page scripts (document.execCommand('copy') inside
 * any click handler) are also "trusted". To stop pages from using the copy
 * result as an oracle for settings and exception domains, only act right
 * after a genuine copy gesture – Ctrl/Cmd+C, Ctrl+Insert or the context menu –
 * and at most once per gesture. Page scripts cannot synthesise trusted
 * keyboard or contextmenu events.
 */
const GESTURE_WINDOW_MS = 1000;
let gestureAt = -Infinity;

function onKeyDown(e: KeyboardEvent): void {
  if (!e.isTrusted) return;
  const key = e.key.toLowerCase();
  if (((e.ctrlKey || e.metaKey) && key === 'c') || (e.ctrlKey && key === 'insert')) gestureAt = performance.now();
}
function onContextMenu(e: MouseEvent): void {
  if (e.isTrusted) gestureAt = performance.now();
}
window.addEventListener('keydown', onKeyDown, true);
window.addEventListener('contextmenu', onContextMenu, true);

function consumeGesture(): boolean {
  const ok = performance.now() - gestureAt <= GESTURE_WINDOW_MS;
  gestureAt = -Infinity;
  return ok;
}

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
    // Ignore synthetic and script-initiated copies: otherwise a page could probe
    // settings and exceptions by triggering copies and inspecting the result.
    if (!event.isTrusted || !consumeGesture()) return;
    if (!settingsLoaded || !settings.copyCleaning || tabPaused || event.clipboardData === null) return;
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
