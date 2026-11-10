/**
 * Copy cleaning content script.
 *
 * When the user copies a selection that is exactly one http(s) link with the
 * keyboard, the clipboard ends up holding the cleaned link. Everything else
 * (normal text, text that merely contains links, cut operations, copies
 * started by page scripts) is left alone.
 *
 * Design (privacy): this script never touches the copy event itself – no
 * setData, no preventDefault – so the page cannot observe whether, or how,
 * Untrackable reacted. It only forwards the copied link to the service worker,
 * which decides with the user's settings (mode, exceptions, pause, switch) and
 * writes the cleaned link to the clipboard afterwards. The page would need
 * clipboard-read permission to notice; settings never enter the page's
 * process.
 *
 * Runs in Chrome's isolated world. It never stores or logs anything.
 */

const SINGLE_URL = /^https?:\/\/\S+$/i;
const MAX_LENGTH = 8192;

/**
 * Only copies that directly follow a genuine keyboard copy gesture count
 * (Ctrl/Cmd+C or Ctrl+Insert; matched by physical key and by character so
 * Dvorak and non-Latin layouts work), at most one per gesture. Page scripts
 * cannot synthesise trusted keyboard events. The browser's own "Copy" menu
 * entries are not covered; Untrackable's "Copy clean link" item is the
 * alternative.
 */
const GESTURE_WINDOW_MS = 1000;
let gestureAt = -Infinity;

function isCopyKeystroke(e: KeyboardEvent): boolean {
  const key = e.key.toLowerCase();
  const c = e.code === 'KeyC' || key === 'c';
  return ((e.ctrlKey || e.metaKey) && c) || (e.ctrlKey && (e.code === 'Insert' || key === 'insert'));
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.isTrusted && isCopyKeystroke(e)) gestureAt = performance.now();
}

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

/** False once the extension was disabled, reloaded or updated (orphaned script). */
function extensionAlive(): boolean {
  try {
    return chrome.runtime?.id !== undefined;
  } catch {
    return false;
  }
}

function detach(): void {
  window.removeEventListener('keydown', onKeyDown, true);
  document.removeEventListener('copy', onCopy, true);
}

function onCopy(event: ClipboardEvent): void {
  if (!extensionAlive()) {
    detach(); // never act with stale settings after disable/update
    return;
  }
  if (!event.isTrusted || !consumeGesture()) return;
  const text = selectedText().trim();
  if (text.length > MAX_LENGTH || !SINGLE_URL.test(text)) return;
  // Fire and forget; the native copy proceeds untouched.
  chrome.runtime.sendMessage({ type: 'cleanCopiedLink', url: text }).catch(() => {});
}

window.addEventListener('keydown', onKeyDown, true);
document.addEventListener('copy', onCopy, true);
