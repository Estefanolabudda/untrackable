import { STATS_KEY, STATS_PERMISSION, summarize } from './stats.js';

/**
 * Shared rendering of the local statistics (popup and settings page).
 * Expected elements: #stats-on, #stats-off, #stats-today, #stats-week,
 * #stats-total, #stats-other.
 */
function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el;
}

const format = new Intl.NumberFormat();

export async function statsEnabled(): Promise<boolean> {
  return chrome.permissions.contains(STATS_PERMISSION).catch(() => false);
}

export async function renderStats(): Promise<boolean> {
  const enabled = await statsEnabled();
  byId('stats-on').hidden = !enabled;
  byId('stats-off').hidden = enabled;
  if (!enabled) return false;
  const s = summarize((await chrome.storage.local.get(STATS_KEY))[STATS_KEY]);
  byId('stats-today').textContent = format.format(s.today.trackers);
  byId('stats-week').textContent = format.format(s.week.trackers);
  byId('stats-total').textContent = format.format(s.total.trackers);
  const other = byId('stats-other');
  other.hidden = s.total.other === 0;
  other.textContent =
    s.total.other === 0
      ? ''
      : `Plus ${format.format(s.total.other)} other parameter${s.total.other === 1 ? '' : 's'} removed in Experimental mode (${format.format(s.week.other)} in the last 7 days).`;
  return true;
}

/** Turn statistics on (needs a user gesture) or off (deletes the numbers). */
export async function setStatsEnabled(on: boolean): Promise<boolean> {
  if (on) {
    await chrome.permissions.request(STATS_PERMISSION).catch(() => false);
  } else {
    await chrome.permissions.remove(STATS_PERMISSION).catch(() => false);
    await chrome.storage.local.remove(STATS_KEY);
  }
  return statsEnabled();
}

export async function resetStats(): Promise<void> {
  await chrome.storage.local.remove(STATS_KEY);
}

/** Re-render on changes of the numbers or of the permission. */
export function watchStats(onChange: () => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && STATS_KEY in changes) onChange();
  });
  chrome.permissions.onAdded.addListener(onChange);
  chrome.permissions.onRemoved.addListener(onChange);
}
