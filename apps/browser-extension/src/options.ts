import { cleanUrl, toAsciiDomain } from '@untrackable/core';
import { effectiveMode, loadSettings, MAX_EXCEPTIONS, saveSettings, type Settings } from './settings.js';

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el;
}

const enabledBox = $('enabled') as HTMLInputElement;
const modeRadios = [...document.querySelectorAll<HTMLInputElement>('input[name="mode"]')];
const copyBox = $('copy-cleaning') as HTMLInputElement;
const pauseStatus = $('pause-status');
const form = $('add-exception') as HTMLFormElement;
const input = $('exception-input') as HTMLInputElement;
const errorEl = $('exception-error');
const list = $('exceptions');
const empty = $('no-exceptions');
const previewInput = $('preview-input') as HTMLInputElement;
const previewOutput = $('preview-output');
const openUnmodifiedBtn = $('open-unmodified') as HTMLButtonElement;

let current: Settings | undefined;

function render(s: Settings): void {
  current = s;
  enabledBox.checked = s.enabled;
  for (const r of modeRadios) r.checked = r.value === s.mode;
  copyBox.checked = s.copyCleaning;
  pauseStatus.textContent =
    s.enabled && s.pausedUntil > Date.now() ? `Paused until ${new Date(s.pausedUntil).toLocaleTimeString()}.` : '';

  list.replaceChildren(
    ...s.exceptions.map((domain) => {
      const li = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = domain; // textContent only – never innerHTML with user data
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Remove';
      btn.setAttribute('aria-label', `Remove exception ${domain}`);
      btn.addEventListener('click', () => void saveSettings({ exceptions: s.exceptions.filter((d) => d !== domain) }));
      li.append(code, btn);
      return li;
    }),
  );
  empty.hidden = s.exceptions.length > 0;
  renderPreview();
}

function renderPreview(): void {
  const value = previewInput.value;
  previewOutput.replaceChildren();
  openUnmodifiedBtn.disabled = true;
  if (value.trim() === '' || current === undefined) return;
  const mode = effectiveMode(current);
  const result = cleanUrl(value, { mode, exceptions: current.exceptions });
  openUnmodifiedBtn.disabled = result.status === 'invalid' || result.status === 'unsupported';
  const p = document.createElement('p');
  const messages: Record<string, string> = {
    cleaned: 'Cleaned link:',
    unchanged: 'No tracking parameters found.',
    protected: 'Left unchanged: this looks like a sign-in, payment or signed link',
    bypassed: 'Cleaning is currently off or paused.',
    excepted: 'Left unchanged: this site is in your exceptions.',
    unsupported: 'Only http and https links are cleaned.',
    invalid: 'This is not a valid link.',
  };
  p.textContent = messages[result.status] + (result.reason ? ` (${result.reason}).` : '');
  previewOutput.append(p);
  if (result.status === 'cleaned') {
    const code = document.createElement('code');
    code.textContent = result.url;
    const ul = document.createElement('ul');
    for (const r of result.removed) {
      const li = document.createElement('li');
      li.textContent = `${r.name} (${r.location}, rule “${r.ruleId}”)`;
      ul.append(li);
    }
    previewOutput.append(code, ul);
  }
}

enabledBox.addEventListener('change', () => void saveSettings({ enabled: enabledBox.checked, pausedUntil: 0 }));
for (const r of modeRadios) {
  r.addEventListener('change', () => {
    if (r.checked) void saveSettings({ mode: r.value === 'strict' ? 'strict' : 'clean' });
  });
}
copyBox.addEventListener('change', () => void saveSettings({ copyCleaning: copyBox.checked }));

form.addEventListener('submit', (e) => {
  e.preventDefault();
  void (async () => {
    const domain = toAsciiDomain(input.value);
    const s = await loadSettings();
    if (domain === '') {
      errorEl.textContent = 'Please enter a domain such as example.com.';
      return;
    }
    if (s.exceptions.length >= MAX_EXCEPTIONS) {
      errorEl.textContent = `At most ${MAX_EXCEPTIONS} exceptions are supported.`;
      return;
    }
    errorEl.textContent = '';
    input.value = '';
    await saveSettings({ exceptions: [...s.exceptions, domain] });
  })();
});

previewInput.addEventListener('input', renderPreview);
openUnmodifiedBtn.addEventListener('click', () => {
  void chrome.runtime.sendMessage({ type: 'openUnmodified', url: previewInput.value.trim() });
});

chrome.storage.onChanged.addListener((_c, area) => {
  if (area === 'local') void loadSettings().then(render);
});

void loadSettings().then(render);
