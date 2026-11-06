// password.js — Password item rendering and viewer/editor window
import { state, apiFetch, withLocation } from './app.js';
import { parseApiError, createWindowFrame, trapFocus } from './ui-utils.js';
import { renderPage } from './content.js';
import { promptUnlockVault } from './vault.js';
import { openPasswordGeneratorModal, calculateEntropy } from './password-generator.js';
import { openConfirmModal } from './modal.js';

/**
 * Extracts the secret key from an otpauth:// URI, or returns the trimmed input.
 * @param {string} input
 * @returns {string}
 */
export function extractOtpSecret(input) {
  if (!input || typeof input !== 'string') return '';
  const trimmed = input.trim();
  if (/^otpauth:\/\/totp\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const secret = parsed.searchParams.get('secret');
      if (secret) return secret.trim();
    } catch {
      const match = /[?&]secret=([^&]+)/i.exec(trimmed);
      if (match) return decodeURIComponent(match[1]).trim();
    }
  }
  return trimmed;
}

/**
 * Parses an otpauth:// URI and extracts its secret, account label, and issuer.
 * @param {string} uri
 * @returns {{ secret: string, account: string, issuer: string }|null}
 */
export function parseOtpAuthUri(uri) {
  if (!uri || typeof uri !== 'string' || !/^otpauth:\/\/totp\//i.test(uri.trim())) {
    return null;
  }
  try {
    const parsed = new URL(uri.trim());
    const secret = parsed.searchParams.get('secret')?.trim() ?? '';
    let account = '';
    let issuer = parsed.searchParams.get('issuer')?.trim() ?? '';
    const rawLabel = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
    if (rawLabel.includes(':')) {
      const parts = rawLabel.split(':');
      if (!issuer) issuer = parts[0].trim();
      account = parts.slice(1).join(':').trim();
    } else {
      account = rawLabel.trim();
    }
    return { secret, account, issuer };
  } catch {
    return null;
  }
}

function validateBase32Characters(cleanNoSep) {
  if (/[^A-Z2-7=]/.test(cleanNoSep)) {
    if (/[0189]/.test(cleanNoSep)) {
      return 'Base32 secrets only contain letters A–Z and digits 2–7 (digits 0, 1, 8, 9 are not valid).';
    }
    return 'Invalid characters: OTP secret must be Base32 (letters A–Z and digits 2–7).';
  }
  return null;
}

function validateBase32Padding(cleanNoSep, unpadded, firstEq) {
  if (firstEq === -1) return null;

  const afterFirstEq = cleanNoSep.slice(firstEq);
  if (!/^=+$/.test(afterFirstEq)) {
    return 'Invalid padding: "=" characters may only appear at the end.';
  }
  if (cleanNoSep.length % 8 !== 0) {
    return 'Invalid padding: padded Base32 string length must be a multiple of 8.';
  }
  const padCount = cleanNoSep.length - unpadded.length;
  if (![0, 1, 3, 4, 6].includes(padCount)) {
    return `Invalid padding: ${padCount} padding characters is not valid in Base32.`;
  }
  return null;
}

function hasValidTrailingBits(unpadded) {
  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of unpadded) {
    const val = base32chars.indexOf(char);
    bits += val.toString(2).padStart(5, '0');
  }
  const remainderBits = bits.length % 8;
  if (remainderBits !== 0) {
    const paddingBits = bits.slice(bits.length - remainderBits);
    if (paddingBits !== '0'.repeat(remainderBits)) {
      return false;
    }
  }
  return true;
}

/**
 * Validates an OTP secret string against RFC 4648 Base32 specifications.
 * @param {string} secret
 * @returns {{ valid: boolean, clean: string, message: string }}
 */
export function validateOtpSecret(secret) {
  if (!secret || typeof secret !== 'string') {
    return { valid: true, clean: '', message: '' };
  }
  const extracted = extractOtpSecret(secret);
  const trimmed = extracted.trim();
  if (!trimmed) {
    return { valid: true, clean: '', message: '' };
  }

  // Remove whitespace and hyphens
  const cleanNoSep = trimmed.replace(/[\s-]/g, '').toUpperCase();

  const charError = validateBase32Characters(cleanNoSep);
  if (charError) {
    return { valid: false, clean: cleanNoSep, message: charError };
  }

  const firstEq = cleanNoSep.indexOf('=');

  // Strip trailing padding '='
  let unpadded = cleanNoSep;
  while (unpadded.endsWith('=')) {
    unpadded = unpadded.slice(0, -1);
  }

  if (!unpadded) {
    return { valid: false, clean: '', message: 'Secret cannot be only padding characters.' };
  }

  const padError = validateBase32Padding(cleanNoSep, unpadded, firstEq);
  if (padError) {
    return { valid: false, clean: unpadded, message: padError };
  }

  // Base32 quantum length check: unpadded length modulo 8 cannot be 1, 3, or 6
  const mod = unpadded.length % 8;
  if (mod === 1 || mod === 3 || mod === 6) {
    return {
      valid: false,
      clean: unpadded,
      message: 'Invalid length: incomplete Base32 byte sequence.',
    };
  }

  // Minimum length check (minimum 8 Base32 characters = 40 bits)
  if (unpadded.length < 8) {
    return {
      valid: false,
      clean: unpadded,
      message: 'Secret is too short for a valid OTP secret (minimum 8 characters).',
    };
  }

  // Verify trailing padding bits in the last character are zero (RFC 4648 §6)
  if (!hasValidTrailingBits(unpadded)) {
    return {
      valid: false,
      clean: unpadded,
      message: 'Corrupted secret: non-zero padding bits detected.',
    };
  }

  return { valid: true, clean: unpadded, message: '' };
}

/**
 * Validates whether an OTP secret string conforms to RFC 4648 Base32.
 * @param {string} secret
 * @returns {boolean}
 */
export function isValidBase32Secret(secret) {
  return validateOtpSecret(secret).valid;
}

/**
 * Generates an RFC 6238 TOTP code for the given Base32 secret using Web Crypto HMAC-SHA1.
 * @param {string} secret
 * @param {number} [epochSeconds]
 * @returns {Promise<string|null>}
 */
export async function generateTotpCode(secret, epochSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret) return null;
  const validation = validateOtpSecret(secret);
  if (!validation.valid || !validation.clean) return null;
  const clean = validation.clean;

  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of clean) {
    const val = base32chars.indexOf(char);
    if (val === -1) return null;
    bits += val.toString(2).padStart(5, '0');
  }

  const byteLength = Math.floor(bits.length / 8);
  if (byteLength === 0) return null;
  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }

  const timeStep = Math.floor(epochSeconds / 30);
  const timeBuffer = new ArrayBuffer(8);
  const timeView = new DataView(timeBuffer);
  timeView.setUint32(0, Math.floor(timeStep / 0x100000000), false);
  timeView.setUint32(4, timeStep >>> 0, false);

  const key = await crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, timeBuffer);
  const hmac = new Uint8Array(signature);
  const offset = hmac.at(-1) & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (binary % 1000000).toString().padStart(6, '0');
}

async function getOtpCode(secret, slug, groupIndex, itemIndex, location) {
  try {
    if (globalThis.crypto?.subtle && secret) {
      const code = await generateTotpCode(secret);
      if (code) return code;
    }
  } catch (err) {
    console.warn('Client TOTP generation failed, trying backend:', err);
  }

  if (itemIndex != null && slug != null && groupIndex != null) {
    try {
      const res = await apiFetch(withLocation(`/pages/${slug}/groups/${groupIndex}/items/${itemIndex}/otp`, location));
      return res?.otp ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

let clipboardTimeoutId = null;
let activeCopyButton = null;
let activeOriginalText = null;

export async function copyToClipboard(text, buttonEl = null, autoClear = false) {
  if (!text) return;

  const writeText = async (str) => {
    if (navigator.clipboard && globalThis.isSecureContext) {
      await navigator.clipboard.writeText(str);
    } else {
      throw new Error('Clipboard API is not available in this context');
    }
  };

  try {
    await writeText(text);

    if (activeCopyButton && activeCopyButton !== buttonEl) {
      activeCopyButton.innerHTML = activeOriginalText;
    }

    if (buttonEl) {
      if (activeCopyButton !== buttonEl) {
        activeOriginalText = buttonEl.innerHTML;
      }
      buttonEl.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;">check</span>`;
      activeCopyButton = buttonEl;
    }

    if (clipboardTimeoutId) {
      clearTimeout(clipboardTimeoutId);
    }
    
    // Reset check icon after 5 seconds
    clipboardTimeoutId = setTimeout(() => {
      clipboardTimeoutId = null;
      if (activeCopyButton) {
        activeCopyButton.innerHTML = activeOriginalText;
        activeCopyButton = null;
        activeOriginalText = null;
      }
    }, 5000);

    // Auto-clear clipboard after 30 seconds for sensitive data
    if (autoClear) {
      setTimeout(async () => {
        try {
          if (navigator.clipboard?.readText) {
            const current = await navigator.clipboard.readText();
            if (current === text) {
              await navigator.clipboard.writeText('');
            }
          }
        } catch {
          // ignore clipboard read/write permission errors
        }
      }, 30000);
    }
  } catch (err) {
    console.error('Failed to copy to clipboard:', err);
  }
}
// ---------------------------------------------------------------------------
// renderPasswordItem
// ---------------------------------------------------------------------------

function findDecryptedItem(groupIndex, itemIndex, title) {
  if (groupIndex == null) return null;
  const grp = state.currentPage?.groups?.[groupIndex];
  if (!grp?.items) return null;
  if (itemIndex != null && grp.items[itemIndex] && (grp.items[itemIndex].title === title || grp.items[itemIndex].password !== undefined)) {
    return grp.items[itemIndex];
  }
  return grp.items.find(it => it.title === title && it.password !== undefined) || (itemIndex != null ? grp.items[itemIndex] : null);
}

/**
 * Build a `<li class="item item--password">` for a password item.
 *
 * @param {object} item         - Item object with `password` field (plaintext from API).
 * @param {number} itemIndex    - Original index in group.items.
 * @param {number} groupIndex   - Index in page.groups.
 * @param {string} slug         - Page slug.
 * @returns {HTMLLIElement}
 */
export function renderPasswordItem(item, itemIndex, groupIndex, slug, location = null) {
  const isLocked = item.locked === true;
  const li = document.createElement('li');
  li.className = 'item item--password';

  const header = document.createElement('div');
  header.className = 'item__password-header';

  const lockBtn = document.createElement('button');
  lockBtn.type = 'button';
  lockBtn.className = 'item__password-lock-btn';
  if (isLocked) {
    lockBtn.setAttribute('aria-label', 'Vault locked');
    lockBtn.title = 'Vault locked (click to unlock)';
    lockBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px; color: var(--color-warning);">lock</span>';
  } else {
    lockBtn.setAttribute('aria-label', 'Copy password');
    lockBtn.title = 'Copy password';
    lockBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;">key</span>';
  }

  const titleBtn = document.createElement('button');
  titleBtn.type = 'button';
  titleBtn.className = 'item__password-title-btn';
  titleBtn.textContent = item.title;

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'item__password-edit';
  editBtn.setAttribute('aria-label', 'Edit password');
  editBtn.title = 'Edit password';
  editBtn.textContent = '✎';

  header.appendChild(lockBtn);
  header.appendChild(titleBtn);
  header.appendChild(editBtn);
  li.appendChild(header);

  lockBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (isLocked) {
      const unlocked = await promptUnlockVault(location);
      if (unlocked) {
        const freshItem = findDecryptedItem(groupIndex, itemIndex, item.title);
        if (freshItem?.password) {
          const newLi = document.querySelector(`li.item--password[data-group-index="${groupIndex}"][data-item-index="${itemIndex}"]`);
          const newLockBtn = newLi?.querySelector('.item__password-lock-btn') || lockBtn;
          await copyToClipboard(freshItem.password, newLockBtn, true);
        }
      }
      return;
    }
    if (item.password) {
      await copyToClipboard(item.password, lockBtn, true);
    }
  });

  titleBtn.addEventListener('click', async () => {
    if (isLocked) {
      const unlocked = await promptUnlockVault(location);
      if (unlocked) {
        const freshItem = findDecryptedItem(groupIndex, itemIndex, item.title);
        if (freshItem) {
          openPasswordWindow(freshItem, itemIndex, groupIndex, slug, location, 'view');
        }
      }
      return;
    }
    openPasswordWindow(item, itemIndex, groupIndex, slug, location, 'view');
  });

  editBtn.addEventListener('click', async () => {
    if (isLocked) {
      const unlocked = await promptUnlockVault(location);
      if (unlocked) {
        const freshItem = findDecryptedItem(groupIndex, itemIndex, item.title);
        if (freshItem) {
          openPasswordWindow(freshItem, itemIndex, groupIndex, slug, location, 'edit');
        }
      }
      return;
    }
    openPasswordWindow(item, itemIndex, groupIndex, slug, location, 'edit');
  });

  return li;
}

// ---------------------------------------------------------------------------
// openPasswordWindow
// ---------------------------------------------------------------------------

function resetOtpValidationUI(otpInput, otpFeedback) {
  otpFeedback.style.display = 'none';
  otpFeedback.innerHTML = '';
  otpInput.style.borderColor = '';
  otpInput.removeAttribute('aria-invalid');
}

function handleOtpAuthUri(otpInput, usernameInput, rawVal) {
  if (!/^otpauth:\/\/totp\//i.test(rawVal)) return;

  const parsed = parseOtpAuthUri(rawVal);
  if (parsed?.secret) {
    otpInput.value = parsed.secret;
  }
  if (!usernameInput.value.trim() && parsed?.account) {
    usernameInput.value = parsed.account;
  }
}

async function renderOtpFeedback(otpInput, otpFeedback, res) {
  otpFeedback.style.display = 'flex';
  if (!res.valid) {
    otpInput.style.borderColor = 'var(--color-danger)';
    otpInput.setAttribute('aria-invalid', 'true');
    otpFeedback.style.color = 'var(--color-danger)';
    otpFeedback.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px; flex-shrink: 0;" aria-hidden="true">error</span><span>${res.message}</span>`;
    return;
  }

  otpInput.style.borderColor = '';
  otpInput.removeAttribute('aria-invalid');
  otpFeedback.style.color = 'var(--color-success, #4caf50)';

  let previewMsg = 'Valid Base32 secret';
  try {
    const code = await generateTotpCode(res.clean);
    if (code) {
      const formatted = `${code.slice(0, 3)} ${code.slice(3)}`;
      previewMsg = `Valid Base32 secret &bull; Live preview: <strong>${formatted}</strong>`;
    }
  } catch {
    // Ignore preview failure
  }
  otpFeedback.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px; flex-shrink: 0;" aria-hidden="true">check_circle</span><span>${previewMsg}</span>`;
}

/**
 * Open the password viewer/editor window overlay.
 *
 * @param {object|null}        item        - Item data, or null for a new password.
 * @param {number|null}        itemIndex   - Index in group.items, or null for new.
 * @param {number}             groupIndex  - Index in page.groups.
 * @param {string}             slug        - Page slug.
 * @param {'view'|'edit'}      initialMode
 */
export function openPasswordWindow(item, itemIndex, groupIndex, slug, location = null, initialMode = 'view') {
  if (item?.locked) {
    void promptUnlockVault(location).then((unlocked) => {
      if (unlocked) {
        const freshItem = findDecryptedItem(groupIndex, itemIndex, item.title);
        if (freshItem) {
          openPasswordWindow(freshItem, itemIndex, groupIndex, slug, location, initialMode);
        }
      }
    });
    return;
  }

  document.getElementById('_pwWindow')?.remove();

  let isNew = item === null;
  let currentItem = isNew ? { title: '', password: '', username: '', pw_url: '', pw_notes: '' } : { ...item };
  let otpTimerId = null;
  let currentOtpCode = '';

  let requestCancelEdit;
  const {
    overlay,
    win,
    titleEl,
    errorEl,
    bodyDiv,
    closeHeaderBtn,
    restoreFocus,
  } = createWindowFrame({
    id: '_pwWindow',
    onClose: async () => {
      if (!editDiv.hidden) {
        await requestCancelEdit();
      } else {
        closeWindow();
      }
    },
  });

  // View pane
  const viewDiv = document.createElement('div');
  viewDiv.className = 'note-window__view pw-view';

  // Edit pane
  const editDiv = document.createElement('div');
  editDiv.className = 'note-window__edit pw-edit';
  editDiv.hidden = true;

  // Edit fields
  const titleLabel = document.createElement('label');
  titleLabel.className = 'modal__label';
  titleLabel.textContent = 'Title';
  titleLabel.htmlFor = '_pw_title';
  titleLabel.title = 'e.g. GitHub';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.id = '_pw_title';
  titleInput.className = 'modal__input';
  titleInput.required = true;

  const urlLabel = document.createElement('label');
  urlLabel.className = 'modal__label';
  urlLabel.textContent = 'URL';
  urlLabel.htmlFor = '_pw_url';
  urlLabel.title = 'e.g. https://example.com';

  const urlInput = document.createElement('input');
  urlInput.type = 'url';
  urlInput.id = '_pw_url';
  urlInput.className = 'modal__input';

  const usernameLabel = document.createElement('label');
  usernameLabel.className = 'modal__label';
  usernameLabel.textContent = 'Username';
  usernameLabel.htmlFor = '_pw_username';
  usernameLabel.title = 'username or email address';

  const usernameInput = document.createElement('input');
  usernameInput.type = 'text';
  usernameInput.id = '_pw_username';
  usernameInput.name = 'username';
  usernameInput.autocomplete = 'username';
  usernameInput.className = 'modal__input';

  const passwordLabel = document.createElement('label');
  passwordLabel.className = 'modal__label';
  passwordLabel.textContent = 'Password';
  passwordLabel.htmlFor = '_pw_password';

  const pwRow = document.createElement('div');
  pwRow.className = 'pw-input-row';

  const passwordInput = document.createElement('input');
  passwordInput.id = '_pw_password';
  passwordInput.name = 'password';
  passwordInput.autocomplete = 'current-password';
  passwordInput.className = 'modal__input pw-input-row__input';

  const pwEditToggle = document.createElement('button');
  pwEditToggle.type = 'button';
  pwEditToggle.className = 'pw-icon-btn';
  pwEditToggle.setAttribute('aria-label', 'Show password');
  pwEditToggle.title = 'Show password';
  pwEditToggle.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;">visibility</span>`;

  const otpLabel = document.createElement('label');
  otpLabel.className = 'modal__label';
  otpLabel.textContent = 'OTP Secret';
  otpLabel.htmlFor = '_pw_otp';
  otpLabel.title = 'Base32 secret (e.g. JBSW...)';

  const otpRow = document.createElement('div');
  otpRow.className = 'pw-input-row pw-input-row--single';

  const otpInput = document.createElement('input');
  otpInput.id = '_pw_otp';
  otpInput.name = 'ExoDeck_totp_seed';
  otpInput.autocomplete = 'off';
  otpInput.dataset['1pIgnore'] = 'true';
  otpInput.dataset.lpignore = 'true';
  otpInput.dataset.bwignore = 'true';
  otpInput.setAttribute('spellcheck', 'false');
  otpInput.setAttribute('autocapitalize', 'off');
  otpInput.className = 'modal__input pw-input-row__input';

  const otpEditToggle = document.createElement('button');
  otpEditToggle.type = 'button';
  otpEditToggle.className = 'pw-icon-btn';
  otpEditToggle.setAttribute('aria-label', 'Show OTP secret');
  otpEditToggle.title = 'Show OTP secret';
  otpEditToggle.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;">visibility</span>`;

  const notesLabel = document.createElement('label');
  notesLabel.className = 'modal__label';
  notesLabel.textContent = 'Notes';
  notesLabel.htmlFor = '_pw_notes';
  notesLabel.title = 'Optional notes and details';

  const notesInput = document.createElement('textarea');
  notesInput.id = '_pw_notes';
  notesInput.className = 'modal__input modal__textarea';
  notesInput.rows = 4;

  passwordInput.type = 'password';
  pwEditToggle.addEventListener('click', () => {
    const show = passwordInput.type === 'password';
    passwordInput.type = show ? 'text' : 'password';
    pwEditToggle.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;">${show ? 'visibility_off' : 'visibility'}</span>`;
    pwEditToggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    pwEditToggle.title = show ? 'Hide password' : 'Show password';
  });

  otpInput.type = 'password';
  otpEditToggle.addEventListener('click', () => {
    const show = otpInput.type === 'password';
    otpInput.type = show ? 'text' : 'password';
    otpEditToggle.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;">${show ? 'visibility_off' : 'visibility'}</span>`;
    otpEditToggle.setAttribute('aria-label', show ? 'Hide OTP secret' : 'Show OTP secret');
    otpEditToggle.title = show ? 'Hide OTP secret' : 'Show OTP secret';
  });

  const pwGenToggle = document.createElement('button');
  pwGenToggle.type = 'button';
  pwGenToggle.className = 'pw-icon-btn';
  pwGenToggle.setAttribute('aria-label', 'Generate secure password');
  pwGenToggle.title = 'Generate secure password';
  pwGenToggle.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;">casino</span>`;

  const pwStrengthContainer = document.createElement('div');
  pwStrengthContainer.style.marginTop = '0.25rem';
  pwStrengthContainer.style.marginBottom = '0.75rem';
  const pwStrengthBar = document.createElement('div');
  pwStrengthBar.style.height = '4px';
  pwStrengthBar.style.borderRadius = '2px';
  pwStrengthBar.style.background = 'rgba(255,255,255,0.1)';
  pwStrengthBar.style.overflow = 'hidden';
  const pwStrengthFill = document.createElement('div');
  pwStrengthFill.style.height = '100%';
  pwStrengthFill.style.width = '0%';
  pwStrengthFill.style.transition = 'width 0.2s, background-color 0.2s';
  const pwStrengthLabel = document.createElement('div');
  pwStrengthLabel.style.fontSize = '0.75rem';
  pwStrengthLabel.style.marginTop = '0.2rem';
  pwStrengthLabel.style.color = 'var(--color-text-muted)';

  pwStrengthBar.appendChild(pwStrengthFill);
  pwStrengthContainer.appendChild(pwStrengthBar);
  pwStrengthContainer.appendChild(pwStrengthLabel);

  function updateStrength() {
    const val = passwordInput.value;
    if (!val) {
      pwStrengthContainer.style.display = 'none';
      return;
    }
    pwStrengthContainer.style.display = 'block';
    const ent = calculateEntropy(val);
    const pct = Math.min(100, Math.round((ent.bits / 100) * 100));
    pwStrengthFill.style.width = `${pct}%`;
    pwStrengthFill.style.backgroundColor = ent.color;
    pwStrengthLabel.textContent = `Strength: ${ent.label}`;
    pwStrengthLabel.style.color = ent.color;
  }
  passwordInput.addEventListener('input', updateStrength);

  pwGenToggle.addEventListener('click', () => {
    openPasswordGeneratorModal((newPw) => {
      passwordInput.value = newPw;
      updateStrength();
    });
  });

  const pwActions = document.createElement('div');
  pwActions.className = 'pw-input-row__actions';
  pwActions.appendChild(pwEditToggle);
  pwActions.appendChild(pwGenToggle);

  pwRow.appendChild(passwordInput);
  pwRow.appendChild(pwActions);

  const otpActions = document.createElement('div');
  otpActions.className = 'pw-input-row__actions';
  otpActions.appendChild(otpEditToggle);

  otpRow.appendChild(otpInput);
  otpRow.appendChild(otpActions);

  const otpFeedback = document.createElement('div');
  otpFeedback.className = 'pw-otp-feedback';
  otpFeedback.style.display = 'none';
  otpFeedback.style.fontSize = 'var(--font-size-sm, 12px)';
  otpFeedback.style.marginTop = '0.25rem';
  otpFeedback.style.marginBottom = '0.5rem';
  otpFeedback.style.alignItems = 'center';
  otpFeedback.style.gap = '0.35rem';
  otpFeedback.style.lineHeight = '1.4';

  let otpValidationDebounce = null;

  async function updateOtpValidation() {
    const rawVal = otpInput.value.trim();
    if (!rawVal) {
      resetOtpValidationUI(otpInput, otpFeedback);
      return;
    }

    handleOtpAuthUri(otpInput, usernameInput, rawVal);

    const currentVal = otpInput.value.trim();
    if (!currentVal) {
      resetOtpValidationUI(otpInput, otpFeedback);
      return;
    }

    const res = validateOtpSecret(currentVal);
    await renderOtpFeedback(otpInput, otpFeedback, res);
  }

  otpInput.addEventListener('input', () => {
    if (otpValidationDebounce) clearTimeout(otpValidationDebounce);
    otpValidationDebounce = setTimeout(() => {
      void updateOtpValidation();
    }, 150);
  });
  otpInput.addEventListener('change', () => {
    void updateOtpValidation();
  });
  otpInput.addEventListener('paste', () => {
    setTimeout(() => {
      void updateOtpValidation();
    }, 0);
  });

  editDiv.appendChild(titleLabel);
  editDiv.appendChild(titleInput);
  editDiv.appendChild(urlLabel);
  editDiv.appendChild(urlInput);
  editDiv.appendChild(usernameLabel);
  editDiv.appendChild(usernameInput);
  editDiv.appendChild(passwordLabel);
  editDiv.appendChild(pwRow);
  editDiv.appendChild(pwStrengthContainer);
  editDiv.appendChild(otpLabel);
  editDiv.appendChild(otpRow);
  editDiv.appendChild(otpFeedback);
  editDiv.appendChild(notesLabel);
  editDiv.appendChild(notesInput);

  const metaDiv = document.createElement('div');
  metaDiv.style.marginTop = '1rem';
  metaDiv.style.display = 'flex';
  metaDiv.style.gap = '1rem';
  metaDiv.style.fontSize = '0.85em';
  metaDiv.style.color = 'var(--text-color)';
  metaDiv.style.opacity = '0.7';
  editDiv.appendChild(metaDiv);

  bodyDiv.appendChild(viewDiv);
  bodyDiv.appendChild(editDiv);

  // -- Actions --
  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'note-window__actions';

  const primaryBtn = document.createElement('button');
  primaryBtn.type = 'button';
  primaryBtn.className = 'btn btn--primary';

  const secondaryBtn = document.createElement('button');
  secondaryBtn.type = 'button';
  secondaryBtn.className = 'btn btn--ghost';

  actionsDiv.appendChild(secondaryBtn);
  actionsDiv.appendChild(primaryBtn);

  // -- Assemble --
  win.appendChild(actionsDiv);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', async (e) => {
    if (e.target === overlay) {
      if (!editDiv.hidden) {
        await requestCancelEdit();
      } else {
        closeWindow();
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Mode helpers
  // ---------------------------------------------------------------------------

  function stopOtpTimer() {
    if (otpTimerId) {
      clearInterval(otpTimerId);
      otpTimerId = null;
    }
  }

  function setOtpCodeDisplay(codeEl, code) {
    codeEl.textContent = '';
    if (code && (code.length === 6 || code.length === 8)) {
      const mid = code.length / 2;
      const p1 = document.createElement('span');
      p1.className = 'pw-otp__code-part';
      p1.textContent = code.slice(0, mid);
      const p2 = document.createElement('span');
      p2.className = 'pw-otp__code-part';
      p2.textContent = code.slice(mid);
      codeEl.appendChild(p1);
      codeEl.appendChild(p2);
    } else {
      codeEl.textContent = code || '------';
    }
  }

  function buildOtpViewField() {
    const row = document.createElement('div');
    row.className = 'pw-field pw-field--otp';

    const labelEl = document.createElement('span');
    labelEl.className = 'pw-field__label';
    labelEl.textContent = 'OTP';

    const valueEl = document.createElement('div');
    valueEl.className = 'pw-field__value pw-otp__value';

    const codeEl = document.createElement('span');
    codeEl.className = 'pw-otp__code';
    setOtpCodeDisplay(codeEl, '------');

    const indicatorEl = document.createElement('div');
    indicatorEl.className = 'pw-otp__indicator';
    indicatorEl.title = 'Validity period';

    const ringSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ringSvg.setAttribute('class', 'pw-otp__timer-ring');
    ringSvg.setAttribute('width', '18');
    ringSvg.setAttribute('height', '18');
    ringSvg.setAttribute('viewBox', '0 0 20 20');

    const trackCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    trackCircle.setAttribute('cx', '10');
    trackCircle.setAttribute('cy', '10');
    trackCircle.setAttribute('r', '8');
    trackCircle.setAttribute('fill', 'none');
    trackCircle.setAttribute('stroke', 'var(--color-border)');
    trackCircle.setAttribute('stroke-width', '2.5');

    const progressCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    progressCircle.setAttribute('class', 'pw-otp__timer-progress');
    progressCircle.setAttribute('cx', '10');
    progressCircle.setAttribute('cy', '10');
    progressCircle.setAttribute('r', '8');
    progressCircle.setAttribute('fill', 'none');
    progressCircle.setAttribute('stroke', 'var(--color-accent)');
    progressCircle.setAttribute('stroke-width', '2.5');
    progressCircle.setAttribute('stroke-linecap', 'round');
    progressCircle.setAttribute('stroke-dasharray', '50.27');
    progressCircle.setAttribute('stroke-dashoffset', '0');
    progressCircle.setAttribute('transform', 'rotate(-90 10 10)');

    ringSvg.appendChild(trackCircle);
    ringSvg.appendChild(progressCircle);

    const timerText = document.createElement('span');
    timerText.className = 'pw-otp__timer-text';
    timerText.textContent = '--s';

    indicatorEl.appendChild(ringSvg);
    indicatorEl.appendChild(timerText);

    valueEl.appendChild(codeEl);
    valueEl.appendChild(indicatorEl);

    const actions = document.createElement('span');
    actions.className = 'pw-field__actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'pw-icon-btn';
    copyBtn.setAttribute('aria-label', 'Copy OTP');
    copyBtn.title = 'Copy OTP';
    copyBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;">content_copy</span>`;
    copyBtn.addEventListener('click', async () => {
      if (currentOtpCode) {
        await copyToClipboard(currentOtpCode, copyBtn, true);
      } else {
        try {
          const code = await getOtpCode(currentItem.otp_secret, slug, groupIndex, itemIndex, location);
          if (code) {
            currentOtpCode = code;
            setOtpCodeDisplay(codeEl, code);
            await copyToClipboard(code, copyBtn, true);
          } else {
            alert('Failed to generate OTP');
          }
        } catch (e) {
          console.error(e);
          alert('Failed to generate OTP');
        }
      }
    });

    actions.appendChild(copyBtn);

    row.appendChild(labelEl);
    row.appendChild(valueEl);
    row.appendChild(actions);

    return { row, codeEl, progressCircle, timerText, indicatorEl };
  }

  function startOtp(codeEl, progressCircle, timerText, indicatorEl) {
    stopOtpTimer();

    const circumference = 50.27;
    let lastPeriod = -1;

    async function refreshCode() {
      try {
        const code = await getOtpCode(currentItem.otp_secret, slug, groupIndex, itemIndex, location);
        if (code) {
          currentOtpCode = code;
          setOtpCodeDisplay(codeEl, code);
          codeEl.style.color = '';
          codeEl.style.fontSize = '';
          indicatorEl.style.display = 'inline-flex';
        } else {
          currentOtpCode = '';
          codeEl.textContent = 'Invalid OTP Secret';
          codeEl.style.color = 'var(--color-danger)';
          codeEl.style.fontSize = 'var(--font-size-sm)';
          indicatorEl.style.display = 'none';
        }
      } catch (err) {
        console.error('Failed to generate OTP:', err);
        currentOtpCode = '';
        codeEl.textContent = 'Failed to generate OTP';
        codeEl.style.color = 'var(--color-danger)';
        codeEl.style.fontSize = 'var(--font-size-sm)';
        indicatorEl.style.display = 'none';
      }
    }

    function tick() {
      const now = Math.floor(Date.now() / 1000);
      const period = Math.floor(now / 30);
      const remaining = 30 - (now % 30);

      timerText.textContent = `${remaining}s`;
      const offset = circumference * (1 - remaining / 30);
      progressCircle.style.strokeDashoffset = `${offset}`;

      const isExpiring = remaining <= 5;
      progressCircle.style.stroke = isExpiring ? 'var(--color-warning)' : 'var(--color-accent)';
      timerText.style.color = isExpiring ? 'var(--color-warning)' : 'var(--color-text-muted)';

      if (period !== lastPeriod) {
        lastPeriod = period;
        void refreshCode();
      }
    }

    tick();
    otpTimerId = setInterval(tick, 1000);
  }

  function buildViewField(label, value, { mono = false, isLink = false, copyable = false, maskable = false } = {}) {
    if (!value) return null;

    const row = document.createElement('div');
    row.className = 'pw-field';

    const labelEl = document.createElement('span');
    labelEl.className = 'pw-field__label';
    labelEl.textContent = label;

    const valueEl = document.createElement('span');
    valueEl.className = 'pw-field__value' + (mono ? ' pw-field__value--mono' : '');

    if (isLink && value) {
      const a = document.createElement('a');
      a.href = value;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = value;
      valueEl.appendChild(a);
    } else if (maskable) {
      let revealed = false;
      valueEl.textContent = '•••••••';

      const actions = document.createElement('span');
      actions.className = 'pw-field__actions';

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'pw-icon-btn';
      toggleBtn.setAttribute('aria-label', `Show ${label}`);
      toggleBtn.title = `Show ${label}`;
      toggleBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;">visibility</span>`;
      toggleBtn.addEventListener('click', () => {
        revealed = !revealed;
        valueEl.textContent = revealed ? value : '•••••••';
        toggleBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;">${revealed ? 'visibility_off' : 'visibility'}</span>`;
        toggleBtn.setAttribute('aria-label', revealed ? `Hide ${label}` : `Show ${label}`);
        toggleBtn.title = revealed ? `Hide ${label}` : `Show ${label}`;
      });

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'pw-icon-btn';
      copyBtn.setAttribute('aria-label', `Copy ${label}`);
      copyBtn.title = `Copy ${label}`;
      copyBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;">content_copy</span>`;
      copyBtn.addEventListener('click', async () => {
        if (label === 'Password') {
          await copyToClipboard(value, copyBtn, true);
        } else {
          await copyToClipboard(value, copyBtn);
        }
      });

      actions.appendChild(toggleBtn);
      actions.appendChild(copyBtn);
      row.appendChild(labelEl);
      row.appendChild(valueEl);
      row.appendChild(actions);
      return row;
    } else {
      valueEl.textContent = value;
    }

    if (copyable && value) {
      const actions = document.createElement('span');
      actions.className = 'pw-field__actions';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'pw-icon-btn';
      copyBtn.setAttribute('aria-label', `Copy ${label}`);
      copyBtn.title = `Copy ${label}`;
      copyBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;">content_copy</span>`;
      copyBtn.addEventListener('click', async () => {
        await copyToClipboard(value, copyBtn);
      });

      actions.appendChild(copyBtn);
      row.appendChild(labelEl);
      row.appendChild(valueEl);
      row.appendChild(actions);
      return row;
    }

    row.appendChild(labelEl);
    row.appendChild(valueEl);
    return row;
  }

  function switchToView(updatedItem) {
    stopOtpTimer();
    if (updatedItem) currentItem = updatedItem;

    titleEl.textContent = `🔒 ${currentItem.title}`;
    closeHeaderBtn.hidden = false;

    viewDiv.innerHTML = '';

    const urlRow = buildViewField('URL', currentItem.pw_url ?? '', { isLink: true });
    if (urlRow) viewDiv.appendChild(urlRow);

    const userRow = buildViewField('Username', currentItem.username ?? '', { mono: true, copyable: true });
    if (userRow) viewDiv.appendChild(userRow);

    const pwRow = buildViewField('Password', currentItem.password ?? '', { mono: true, maskable: true });
    if (pwRow) viewDiv.appendChild(pwRow);
    
    const hasCorruptedOtp = currentItem.otp_secret && (
      currentItem.otp_secret.startsWith('gAAAAA') || currentItem.otp_secret.startsWith('v1:')
    );
    if (currentItem.otp_secret && !hasCorruptedOtp) {
      const otpField = buildOtpViewField();
      viewDiv.appendChild(otpField.row);
      startOtp(otpField.codeEl, otpField.progressCircle, otpField.timerText, otpField.indicatorEl);
    }

    if (currentItem.pw_notes) {
      const notesRow = document.createElement('div');
      notesRow.className = 'pw-field pw-field--notes';
      const lbl = document.createElement('span');
      lbl.className = 'pw-field__label';
      lbl.textContent = 'Notes';
      const val = document.createElement('p');
      val.className = 'pw-field__value pw-field__notes-text';
      val.textContent = currentItem.pw_notes;
      notesRow.appendChild(lbl);
      notesRow.appendChild(val);
      viewDiv.appendChild(notesRow);
    }

    viewDiv.hidden = false;
    editDiv.hidden = true;
    errorEl.hidden = true;

    primaryBtn.textContent = 'Edit';
    secondaryBtn.textContent = 'Close';
    primaryBtn.onclick = switchToEdit;
    secondaryBtn.onclick = closeWindow;
    primaryBtn.focus();
  }

  function switchToEdit() {
    stopOtpTimer();
    titleInput.value = currentItem.title ?? '';
    urlInput.value = currentItem.pw_url ?? '';
    usernameInput.value = currentItem.username ?? '';
    notesInput.value = currentItem.pw_notes ?? '';
    passwordInput.value = currentItem.password ?? '';
    passwordInput.type = 'password';
    pwEditToggle.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;">visibility</span>`;
    updateStrength();

    const hasCorruptedOtp = currentItem.otp_secret && (
      currentItem.otp_secret.startsWith('gAAAAA') || currentItem.otp_secret.startsWith('v1:')
    );
    otpInput.value = hasCorruptedOtp ? '' : (currentItem.otp_secret ?? '');
    otpInput.type = 'password';
    otpEditToggle.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;">visibility</span>`;
    void updateOtpValidation();

    metaDiv.innerHTML = '';
    const formatDate = (iso) => iso ? new Date(iso).toLocaleString() : '';
    if (currentItem.created_at) {
      metaDiv.innerHTML += `<div><strong>Created At:</strong> ${formatDate(currentItem.created_at)}</div>`;
    }
    if (currentItem.modified_at) {
      metaDiv.innerHTML += `<div><strong>Modified At:</strong> ${formatDate(currentItem.modified_at)}</div>`;
    }

    viewDiv.hidden = true;
    editDiv.hidden = false;
    errorEl.hidden = true;
    closeHeaderBtn.hidden = true;

    primaryBtn.textContent = 'Save';
    secondaryBtn.textContent = 'Cancel';
    primaryBtn.onclick = savePassword;
    secondaryBtn.onclick = () => {
      void requestCancelEdit();
    };

    titleInput.focus();
  }

  const isDirty = () => {
    const origTitle = currentItem.title ?? '';
    const origUrl = currentItem.pw_url ?? '';
    const origUsername = currentItem.username ?? '';
    const origNotes = currentItem.pw_notes ?? '';
    const origPassword = currentItem.password ?? '';
    const hasCorruptedOtp = currentItem.otp_secret && (
      currentItem.otp_secret.startsWith('gAAAAA') || currentItem.otp_secret.startsWith('v1:')
    );
    const origOtp = hasCorruptedOtp ? '' : (currentItem.otp_secret ?? '');

    return titleInput.value !== origTitle ||
      urlInput.value !== origUrl ||
      usernameInput.value !== origUsername ||
      notesInput.value !== origNotes ||
      passwordInput.value !== origPassword ||
      otpInput.value !== origOtp;
  };

  requestCancelEdit = async () => {
    if (isDirty()) {
      const discard = await openConfirmModal();
      if (!discard) return false;
    }
    if (isNew) {
      closeWindow();
    } else {
      switchToView();
    }
    return true;
  };

  function buildPayload(newTitle) {
    const rawOtp = otpInput.value.trim();
    const validation = validateOtpSecret(rawOtp);
    return {
      title: newTitle,
      password: passwordInput.value,
      otp_secret: validation.valid && validation.clean ? validation.clean : null,
      ...(usernameInput.value.trim() && { username: usernameInput.value.trim() }),
      ...(urlInput.value.trim() && { pw_url: urlInput.value.trim() }),
      ...(notesInput.value.trim() && { pw_notes: notesInput.value.trim() }),
    };
  }

  async function savePassword() {
    const newTitle = titleInput.value.trim();
    if (!newTitle) {
      errorEl.textContent = '"Title" is required.';
      errorEl.hidden = false;
      titleInput.focus();
      return;
    }
    if (!passwordInput.value.trim()) {
      errorEl.textContent = '"Password" is required.';
      errorEl.hidden = false;
      passwordInput.focus();
      return;
    }
    const rawOtp = otpInput.value.trim();
    if (rawOtp) {
      const validation = validateOtpSecret(rawOtp);
      if (!validation.valid) {
        errorEl.textContent = `Invalid OTP Secret: ${validation.message}`;
        errorEl.hidden = false;
        primaryBtn.disabled = false;
        otpInput.focus();
        return;
      }
    }
    errorEl.hidden = true;
    primaryBtn.disabled = true;

    const payload = buildPayload(newTitle);

    try {
      const apiUrl = isNew
        ? withLocation(`/pages/${slug}/groups/${groupIndex}/items`, location)
        : withLocation(`/pages/${slug}/groups/${groupIndex}/items/${itemIndex}`, location);
      await apiFetch(apiUrl, { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(payload) });
      state.currentPage = await apiFetch(withLocation(`/pages/${slug}`, location));
    } catch (err) {
      errorEl.textContent = parseApiError(err, 'Failed to save password.');
      errorEl.hidden = false;
      primaryBtn.disabled = false;
      return;
    }

    renderPage(state.currentPage);
    primaryBtn.disabled = false;

    // Find the updated item in the refreshed page to switch to view mode
    const updatedIdx = state.currentPage.groups[groupIndex].items.findIndex(it => it.title === newTitle && it.password !== undefined);
    if (updatedIdx !== -1) {
      itemIndex = updatedIdx;
      isNew = false;
    }
    const updatedItem = updatedIdx !== -1 ? state.currentPage.groups[groupIndex].items[updatedIdx] : null;
    switchToView(updatedItem ?? payload);
  }

  function closeWindow() {
    stopOtpTimer();
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
    restoreFocus();
  }

  const onKeyDown = async (e) => {
    if (document.getElementById('_confirmModalOverlay')) return;
    const pwGenModal = document.getElementById('_pwGenModal');
    if (pwGenModal) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        pwGenModal.remove();
      }
      return;
    }
    if (e.key === 'Tab') {
      trapFocus(e, win);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (editDiv.hidden) {
        closeWindow();
      } else {
        await requestCancelEdit();
      }
    }
  };

  document.addEventListener('keydown', onKeyDown);

  if (initialMode === 'edit') {
    titleEl.textContent = isNew ? 'New Password' : `🔒 ${currentItem.title}`;
    switchToEdit();
  } else {
    switchToView();
  }
}
