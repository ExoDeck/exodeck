// password-generator.js — Cryptographically secure password generator
import { copyToClipboard } from './password.js';

const CHAR_SETS = {
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lowercase: 'abcdefghijklmnopqrstuvwxyz',
  numbers: '0123456789',
  symbols: '!@#$%^&*()_+-=[]{}|;:,.<>?',
};

const AMBIGUOUS_CHARS = new Set(['0', 'O', 'l', '1', 'I', '|', '`', '\'', '"', ';', ':']);

export const DEFAULT_GENERATOR_OPTIONS = {
  length: 20,
  uppercase: true,
  lowercase: true,
  numbers: true,
  symbols: true,
  avoidAmbiguous: true,
};

/**
 * Generate a cryptographically secure random password.
 * @param {object} opts
 * @returns {string}
 */
export function generatePassword(opts = {}) {
  const options = { ...DEFAULT_GENERATOR_OPTIONS, ...opts };
  const length = Math.max(8, Math.min(64, options.length || 20));

  let pool = '';
  const requiredChars = [];

  const addSet = (chars) => {
    let filtered = chars;
    if (options.avoidAmbiguous) {
      filtered = chars.split('').filter(c => !AMBIGUOUS_CHARS.has(c)).join('');
    }
    if (filtered.length > 0) {
      pool += filtered;
      // Guarantee at least one character from this set
      const randIdx = getRandomInt(filtered.length);
      requiredChars.push(filtered[randIdx]);
    }
  };

  if (options.uppercase) addSet(CHAR_SETS.uppercase);
  if (options.lowercase) addSet(CHAR_SETS.lowercase);
  if (options.numbers) addSet(CHAR_SETS.numbers);
  if (options.symbols) addSet(CHAR_SETS.symbols);

  if (pool.length === 0) {
    addSet(CHAR_SETS.lowercase);
  }

  const result = [...requiredChars];
  const remaining = length - result.length;

  for (let i = 0; i < remaining; i++) {
    result.push(pool[getRandomInt(pool.length)]);
  }

  // Shuffle array using Fisher-Yates with crypto randomness
  for (let i = result.length - 1; i > 0; i--) {
    const j = getRandomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result.join('');
}

function getRandomInt(max) {
  if (max <= 0) return 0;
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return array[0] % max;
}

/**
 * Calculate entropy and quality of a password.
 * @param {string} password
 * @returns {{ bits: number, score: 'weak'|'fair'|'good'|'strong', label: string, color: string }}
 */
export function calculateEntropy(password) {
  if (!password) {
    return { bits: 0, score: 'weak', label: 'Empty', color: '#e05c5c' };
  }

  let poolSize = 0;
  if (/[a-z]/.test(password)) poolSize += 26;
  if (/[A-Z]/.test(password)) poolSize += 26;
  if (/\d/.test(password)) poolSize += 10;
  if (/[^a-zA-Z0-9]/.test(password)) poolSize += 32;

  if (poolSize === 0) poolSize = 10;

  const bits = Math.round(password.length * Math.log2(poolSize));

  if (bits < 40) {
    return { bits, score: 'weak', label: `${bits} bits (Weak)`, color: '#e05c5c' };
  }
  if (bits < 60) {
    return { bits, score: 'fair', label: `${bits} bits (Fair)`, color: '#f59e0b' };
  }
  if (bits < 80) {
    return { bits, score: 'good', label: `${bits} bits (Good)`, color: '#3b82f6' };
  }
  return { bits, score: 'strong', label: `${bits} bits (Strong)`, color: '#10b981' };
}

/**
 * Open the Password Generator modal.
 * @param {(password: string) => void} onApply
 */
export function openPasswordGeneratorModal(onApply) {
  document.getElementById('_pwGenModal')?.remove();

  const options = { ...DEFAULT_GENERATOR_OPTIONS };

  const overlay = document.createElement('div');
  overlay.id = '_pwGenModal';
  overlay.className = 'modal-overlay pw-generator-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal pw-gen-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  modal.innerHTML = `
    <div class="modal__header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
      <h2 class="modal__title" style="margin: 0; display: flex; align-items: center; gap: 0.5rem;">
        <span class="material-symbols-outlined">password</span> Password Generator
      </h2>
      <button type="button" class="btn btn--ghost _pw_gen_close" title="Close" aria-label="Close">✕</button>
    </div>

    <div class="pw-gen__preview-row" style="display: flex; gap: 0.5rem; margin-bottom: 0.5rem;">
      <input type="text" readonly class="modal__input pw-gen__output" style="font-family: var(--font-mono); font-size: 1.1rem; flex: 1; letter-spacing: 1px;" />
      <button type="button" class="btn btn--ghost _pw_gen_refresh" title="Regenerate" aria-label="Regenerate">
        <span class="material-symbols-outlined">refresh</span>
      </button>
      <button type="button" class="btn btn--ghost _pw_gen_copy" title="Copy to clipboard" aria-label="Copy">
        <span class="material-symbols-outlined">content_copy</span>
      </button>
    </div>

    <div class="pw-gen__strength-container" style="margin-bottom: 1.5rem;">
      <div class="pw-gen__strength-bar" style="height: 6px; border-radius: 3px; background: rgba(255,255,255,0.1); overflow: hidden; margin-bottom: 0.25rem;">
        <div class="pw-gen__strength-fill" style="height: 100%; width: 0%; transition: width 0.3s, background-color 0.3s;"></div>
      </div>
      <div class="pw-gen__strength-text" style="font-size: 0.8rem; color: var(--color-text-muted);"></div>
    </div>

    <div class="pw-gen__controls" style="display: flex; flex-direction: column; gap: 0.75rem; margin-bottom: 1.5rem;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <label for="_pw_gen_len" style="font-size: 0.9rem;">Length: <strong class="_pw_gen_len_val">20</strong></label>
        <input type="range" id="_pw_gen_len" min="8" max="64" value="20" style="width: 60%; cursor: pointer;" />
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; font-size: 0.9rem;">
        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
          <input type="checkbox" id="_pw_gen_upper" checked /> Uppercase (A-Z)
        </label>
        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
          <input type="checkbox" id="_pw_gen_lower" checked /> Lowercase (a-z)
        </label>
        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
          <input type="checkbox" id="_pw_gen_nums" checked /> Numbers (0-9)
        </label>
        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
          <input type="checkbox" id="_pw_gen_syms" checked /> Symbols (!@#$...)
        </label>
      </div>

      <label style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; cursor: pointer; margin-top: 0.25rem;">
        <input type="checkbox" id="_pw_gen_ambig" checked /> Avoid ambiguous characters (0, O, l, 1, I)
      </label>
    </div>

    <div class="modal__actions" style="display: flex; justify-content: flex-end; gap: 0.5rem;">
      <button type="button" class="btn btn--ghost _pw_gen_cancel">Cancel</button>
      <button type="button" class="btn btn--primary _pw_gen_apply">Use Password</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const outputEl = modal.querySelector('.pw-gen__output');
  const fillEl = modal.querySelector('.pw-gen__strength-fill');
  const textEl = modal.querySelector('.pw-gen__strength-text');
  const lenSlider = modal.querySelector('#_pw_gen_len');
  const lenVal = modal.querySelector('._pw_gen_len_val');
  const upperCb = modal.querySelector('#_pw_gen_upper');
  const lowerCb = modal.querySelector('#_pw_gen_lower');
  const numsCb = modal.querySelector('#_pw_gen_nums');
  const symsCb = modal.querySelector('#_pw_gen_syms');
  const ambigCb = modal.querySelector('#_pw_gen_ambig');

  function update() {
    options.length = Number.parseInt(lenSlider.value, 10);
    lenVal.textContent = options.length;
    options.uppercase = upperCb.checked;
    options.lowercase = lowerCb.checked;
    options.numbers = numsCb.checked;
    options.symbols = symsCb.checked;
    options.avoidAmbiguous = ambigCb.checked;

    const pw = generatePassword(options);
    outputEl.value = pw;

    const entropy = calculateEntropy(pw);
    const fillPercent = Math.min(100, Math.round((entropy.bits / 100) * 100));
    fillEl.style.width = `${fillPercent}%`;
    fillEl.style.backgroundColor = entropy.color;
    textEl.textContent = entropy.label;
    textEl.style.color = entropy.color;
  }

  lenSlider.addEventListener('input', update);
  upperCb.addEventListener('change', update);
  lowerCb.addEventListener('change', update);
  numsCb.addEventListener('change', update);
  symsCb.addEventListener('change', update);
  ambigCb.addEventListener('change', update);

  modal.querySelector('._pw_gen_refresh').addEventListener('click', update);

  const copyBtn = modal.querySelector('._pw_gen_copy');
  copyBtn.addEventListener('click', async () => {
    await copyToClipboard(outputEl.value, copyBtn);
  });

  const close = () => overlay.remove();

  modal.querySelector('._pw_gen_close').addEventListener('click', close);
  modal.querySelector('._pw_gen_cancel').addEventListener('click', close);

  modal.querySelector('._pw_gen_apply').addEventListener('click', () => {
    if (onApply && outputEl.value) {
      onApply(outputEl.value);
    }
    close();
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  update();
}
