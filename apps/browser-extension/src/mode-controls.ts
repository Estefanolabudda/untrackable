import { saveSettings, type Settings } from './settings.js';

type ModeSetting = Settings['mode'];

export interface ModeControls {
  /** Reflect stored settings (radios, warning, "Back to Clean"). */
  render(s: Settings): void;
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el;
}

function asMode(value: string): ModeSetting {
  return value === 'strict' || value === 'experimental' ? value : 'clean';
}

/**
 * Mode radios shared by the popup and the options page.
 *
 * Experimental is never activated by a radio change alone: choosing it shows a
 * warning with an explicit "Use Experimental" button (keyboard users arrowing
 * through the radio group cannot switch it on by accident). While it is
 * active, a short notice with "Back to Clean" is shown.
 *
 * Expected elements: radios `input[name="mode"]`, `#exp-confirm` (with
 * `#exp-enable`, `#exp-cancel`), `#exp-active` (with `#exp-back`).
 */
export function setupModeControls(): ModeControls {
  const radios = [...document.querySelectorAll<HTMLInputElement>('input[name="mode"]')];
  const confirmBox = byId('exp-confirm');
  const enableBtn = byId('exp-enable') as HTMLButtonElement;
  const cancelBtn = byId('exp-cancel') as HTMLButtonElement;
  const activeBox = byId('exp-active');
  const backBtn = byId('exp-back') as HTMLButtonElement;
  let current: Settings | undefined;

  const showRadios = (mode: ModeSetting): void => {
    for (const r of radios) r.checked = r.value === mode;
  };

  const closeConfirm = (): void => {
    confirmBox.hidden = true;
    if (current !== undefined) showRadios(current.mode);
  };

  for (const r of radios) {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      const mode = asMode(r.value);
      if (mode === 'experimental' && current?.mode !== 'experimental') {
        confirmBox.hidden = false;
        // Focus the safe choice: Enter or Space keep the current mode.
        cancelBtn.focus();
        return;
      }
      confirmBox.hidden = true;
      void saveSettings({ mode });
    });
  }
  enableBtn.addEventListener('click', () => {
    confirmBox.hidden = true;
    void saveSettings({ mode: 'experimental' });
    // The focused button just disappeared: keep focus on a visible control.
    radios.find((r) => r.value === 'experimental')?.focus();
  });
  cancelBtn.addEventListener('click', () => {
    closeConfirm();
    radios.find((r) => r.checked)?.focus();
  });
  const cancelOnEscape = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !confirmBox.hidden) {
      e.preventDefault();
      cancelBtn.click();
    }
  };
  confirmBox.addEventListener('keydown', cancelOnEscape);
  for (const r of radios) r.addEventListener('keydown', cancelOnEscape);
  backBtn.addEventListener('click', () => {
    confirmBox.hidden = true;
    void saveSettings({ mode: 'clean' });
    radios.find((r) => r.value === 'clean')?.focus();
  });

  return {
    render(s: Settings): void {
      current = s;
      // Keep a pending (unconfirmed) Experimental choice visible – unless
      // cleaning was switched off meanwhile (the choice cannot be confirmed).
      if (confirmBox.hidden || s.mode === 'experimental' || !s.enabled) {
        confirmBox.hidden = true;
        showRadios(s.mode);
      }
      for (const r of radios) r.disabled = !s.enabled;
      activeBox.hidden = !(s.enabled && s.mode === 'experimental');
      enableBtn.disabled = !s.enabled;
    },
  };
}
