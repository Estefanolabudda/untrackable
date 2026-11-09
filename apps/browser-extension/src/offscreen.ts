/**
 * Offscreen document used only to write text to the clipboard after an
 * explicit user action (context menu, keyboard shortcut, popup button).
 */
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Only the service worker may write to the clipboard (content scripts share sender.id).
  if (
    sender.id !== chrome.runtime.id ||
    sender.tab !== undefined ||
    sender.url !== chrome.runtime.getURL('background.js') ||
    typeof message !== 'object' ||
    message === null
  ) {
    return false;
  }
  const m = message as { target?: unknown; type?: unknown; text?: unknown };
  if (m.target !== 'offscreen' || m.type !== 'copy' || typeof m.text !== 'string') return false;
  const area = document.createElement('textarea');
  area.value = m.text;
  document.body.append(area);
  area.select();
  let ok: boolean;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    area.remove();
  }
  sendResponse(ok);
  return false;
});
