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
 * any click or contextmenu handler) are also "trusted". To stop pages from
 * using the copy result as an oracle for settings and exception domains, only
 * act on a copy that directly follows a genuine keyboard copy gesture
 * (Ctrl/Cmd+C or Ctrl+Insert; matched by physical key so non-Latin layouts
 * work) and only if the selection is still the one the user had when pressing
 * the keys – a page that swaps in its own probe URL gets nothing. At most one
 * copy is cleaned per gesture. The browser's own "Copy" menu entry is not
 * covered; Untrackable's "Copy clean link" menu item is the alternative.
 */
const GESTURE_WINDOW_MS = 1000;
let gesture: { at: number; selection: string } | undefined;

function onKeyDown(e: KeyboardEvent): void {
  if (!e.isTrusted) return;
  const isCopy = ((e.ctrlKey || e.metaKey) && e.code === 'KeyC') || (e.ctrlKey && e.code === 'Insert');
  if (isCopy) gesture = { at: performance.now(), selection: selectedText() };
}
window.addEventListener('keydown', onKeyDown, true);

function consumeGesture(currentSelection: string): boolean {
  const g = gesture;
  gesture = undefined;
  return g !== undefined && performance.now() - g.at <= GESTURE_WINDOW_MS && g.selection === currentSelection;
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
    const selection = selectedText();
    if (!event.isTrusted || !consumeGesture(selection)) return;
    if (!settingsLoaded || !settings.copyCleaning || tabPaused || event.clipboardData === null) return;
    const mode = effectiveMode(settings);
    if (mode === 'bypass') return;
    const text = selection.trim();
    if (text.length > 8192 || !SINGLE_URL.test(text)) return;
    const result = cleanUrl(text, { mode, exceptions: settings.exceptions });
    if (result.status !== 'cleaned') return;
    event.clipboardData.setData('text/plain', result.url);
    event.preventDefault();
  },
  true,
);
