// vault.js — Master Password Vault management & UI
import { apiFetch, withLocation, state } from './app.js';
import { renderPage } from './content.js';
import { parseApiError } from './ui-utils.js';

function isValidFernetKey(key) {
  if (typeof key !== 'string') return false;
  return (key.length === 43 || key.length === 44) && /^[A-Za-z0-9\-_]+={0,2}$/.test(key);
}

export function hasFernetKey(locationName) {
  if (!state.config?.workspaces) return false;
  const ws = state.config.workspaces;
  let key = null;
  if (Array.isArray(ws)) {
    const loc = ws.find(w => w.name === locationName);
    if (loc) key = loc.fernet_key;
  } else {
    const loc = ws[locationName];
    if (loc) key = loc.fernet_key;
  }
  return isValidFernetKey(key);
}

/**
 * Checks synchronously whether encryption is available for the given workspace
 * (either migrated/configured vault or legacy Fernet key).
 * @param {string|null} location
 * @returns {boolean}
 */
export function canEncryptWorkspace(location = null) {
  const ws = location || state.currentLocation || '';
  if (!ws || ws === 'docs') return false;
  const status = state.vaultStatus?.[ws];
  if (status?.configured || status?.has_legacy_key) return true;
  return hasFernetKey(ws);
}

/**
 * Fetch the current vault status for a workspace.
 * @param {string|null} location
 * @returns {Promise<{ configured: boolean, unlocked: boolean, has_legacy_key: boolean, expires_in_seconds: number }>}
 */
export async function fetchVaultStatus(location = null) {
  const ws = location || state.currentLocation || '';
  if (!ws || ws === 'docs') {
    return { configured: false, unlocked: false, has_legacy_key: false, expires_in_seconds: 0 };
  }
  try {
    const res = await apiFetch(`/workspaces/${encodeURIComponent(ws)}/vault/status`);
    if (!state.vaultStatus) state.vaultStatus = {};
    state.vaultStatus[ws] = res;
    return res;
  } catch {
    const fallback = { configured: false, unlocked: false, has_legacy_key: false, expires_in_seconds: 0 };
    if (!state.vaultStatus) state.vaultStatus = {};
    state.vaultStatus[ws] = fallback;
    return fallback;
  }
}

/**
 * Ensures a workspace vault is unlocked before performing a sensitive action.
 * If migrated and locked, asks the user to unlock first.
 * @param {string|null} location
 * @returns {Promise<boolean>}
 */
export async function ensureVaultUnlocked(location = null) {
  const ws = location || state.currentLocation || '';
  if (!ws || ws === 'docs') return true;
  const status = await fetchVaultStatus(ws);
  if (status.configured && !status.unlocked) {
    const unlocked = await promptUnlockVault(ws);
    return Boolean(unlocked);
  }
  return true;
}

/**
 * Lock the current vault.
 * @param {string|null} location
 */
export async function lockVault(location = null) {
  const ws = location || state.currentLocation || '';
  if (!ws || ws === 'docs') return;
  try {
    await apiFetch(`/workspaces/${encodeURIComponent(ws)}/vault/lock`, { method: 'POST' });
    if (state.vaultStatus?.[ws]) {
      state.vaultStatus[ws].unlocked = false;
      state.vaultStatus[ws].expires_in_seconds = 0;
    }
    // Refresh page data
    if (state.currentSlug) {
      state.currentPage = await apiFetch(withLocation(`/pages/${state.currentSlug}`, ws));
      renderPage(state.currentPage);
    }
    await updateVaultBadge();
  } catch (err) {
    console.error('Failed to lock vault:', err);
  }
}

/**
 * Prompt the user with a modal to unlock the vault.
 * @param {string|null} location
 * @returns {Promise<boolean>} resolves true if unlocked, false if cancelled
 */
export async function promptUnlockVault(location = null) {
  const ws = location || state.currentLocation || '';
  if (!ws || ws === 'docs') return true;

  const status = await fetchVaultStatus(ws);
  if (status.unlocked) return true;

  return new Promise((resolve) => {
    document.getElementById('_vaultUnlockModal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = '_vaultUnlockModal';
    overlay.className = 'modal-overlay vault-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal vault-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    modal.innerHTML = `
      <div class="modal__header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
        <h2 class="modal__title" style="margin: 0; display: flex; align-items: center; gap: 0.5rem;">
          <span class="material-symbols-outlined" style="color: var(--color-warning);">lock</span>
          Unlock Workspace: ${ws}
        </h2>
        <button type="button" class="btn btn--ghost _vault_close" title="Close" aria-label="Close">✕</button>
      </div>

      <p style="color: var(--color-text-muted); font-size: 0.9rem; margin-bottom: 1rem;">
        Enter the Master Password for this workspace to access passwords and secure notes.
      </p>

      <form class="_vault_form" style="display: flex; flex-direction: column; gap: 1rem;">
        <div>
          <label class="modal__label" for="_vault_pwd" title="Master password for this workspace">Master Password</label>
          <div style="display: flex; gap: 0.5rem; position: relative;">
            <input type="password" id="_vault_pwd" class="modal__input" required autofocus style="flex: 1;" />
            <button type="button" class="btn btn--ghost _vault_toggle_pw" title="Show password" style="position: absolute; right: 8px; top: 50%; transform: translateY(-50%); padding: 4px;">
              <span class="material-symbols-outlined" style="font-size: 18px;">visibility</span>
            </button>
          </div>
        </div>

        <p class="_vault_error" style="color: var(--color-danger); font-size: 0.85rem; margin: 0;" hidden></p>

        <div class="modal__actions" style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.5rem;">
          <button type="button" class="btn btn--ghost _vault_cancel">Cancel</button>
          <button type="submit" class="btn btn--primary _vault_submit">Unlock Vault</button>
        </div>
      </form>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const input = modal.querySelector('#_vault_pwd');
    const errorEl = modal.querySelector('._vault_error');
    const form = modal.querySelector('._vault_form');
    const toggleBtn = modal.querySelector('._vault_toggle_pw');

    toggleBtn.addEventListener('click', () => {
      const isPw = input.type === 'password';
      input.type = isPw ? 'text' : 'password';
      toggleBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 18px;">${isPw ? 'visibility_off' : 'visibility'}</span>`;
    });

    const cleanup = (success) => {
      overlay.remove();
      resolve(success);
    };

    modal.querySelector('._vault_close').addEventListener('click', () => cleanup(false));
    modal.querySelector('._vault_cancel').addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      const pwd = input.value;
      if (!pwd) return;

      const submitBtn = modal.querySelector('._vault_submit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Verifying...';

      try {
        await apiFetch(`/workspaces/${encodeURIComponent(ws)}/vault/unlock`, {
          method: 'POST',
          body: JSON.stringify({ password: pwd }),
        });

        if (state.vaultStatus?.[ws]) {
          state.vaultStatus[ws].unlocked = true;
        }

        // Refetch and re-render current page
        if (state.currentSlug) {
          state.currentPage = await apiFetch(withLocation(`/pages/${state.currentSlug}`, ws));
          renderPage(state.currentPage);
        }
        await updateVaultBadge();
        cleanup(true);
      } catch (err) {
        errorEl.textContent = parseApiError(err, 'Incorrect Master Password.');
        errorEl.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Unlock Vault';
        input.select();
      }
    });

    input.focus();
  });
}

/**
 * Open setup modal for creating a new vault.
 * @param {string} location
 * @param {() => void} onComplete
 */
function openVaultPasswordConfirmModal({
  modalId,
  icon,
  iconColor,
  title,
  description,
  submitLabel,
  loadingLabel,
  endpoint,
  onComplete,
  errorFallback,
  onSuccessStatus,
}) {
  document.getElementById(modalId)?.remove();

  const overlay = document.createElement('div');
  overlay.id = modalId;
  overlay.className = 'modal-overlay vault-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal vault-modal';

  modal.innerHTML = `
    <div class="modal__header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
      <h2 class="modal__title" style="margin: 0; display: flex; align-items: center; gap: 0.5rem;">
        <span class="material-symbols-outlined" style="color: ${iconColor};">${icon}</span>
        ${title}
      </h2>
      <button type="button" class="btn btn--ghost _modal_close">✕</button>
    </div>

    <p style="color: var(--color-text-muted); font-size: 0.9rem; margin-bottom: 1rem;">
      ${description}
    </p>

    <form class="_modal_form" style="display: flex; flex-direction: column; gap: 1rem;">
      <div>
        <label class="modal__label" for="_modal_pw1" title="At least 8 characters">Master Password</label>
        <input type="password" id="_modal_pw1" class="modal__input" required minlength="8" />
      </div>

      <div>
        <label class="modal__label" for="_modal_pw2" title="Repeat password to confirm">Confirm Master Password</label>
        <input type="password" id="_modal_pw2" class="modal__input" required minlength="8" />
      </div>

      <p class="_modal_error" style="color: var(--color-danger); font-size: 0.85rem; margin: 0;" hidden></p>

      <div class="modal__actions" style="display: flex; justify-content: flex-end; gap: 0.5rem;">
        <button type="button" class="btn btn--ghost _modal_cancel">Cancel</button>
        <button type="submit" class="btn btn--primary _modal_submit">${submitLabel}</button>
      </div>
    </form>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  modal.querySelector('._modal_close').addEventListener('click', close);
  modal.querySelector('._modal_cancel').addEventListener('click', close);

  const pw1 = modal.querySelector('#_modal_pw1');
  const pw2 = modal.querySelector('#_modal_pw2');
  const errEl = modal.querySelector('._modal_error');
  const form = modal.querySelector('._modal_form');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (pw1.value !== pw2.value) {
      errEl.textContent = 'Passwords do not match.';
      errEl.hidden = false;
      return;
    }

    const btn = modal.querySelector('._modal_submit');
    btn.disabled = true;
    btn.textContent = loadingLabel;

    try {
      await apiFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({ password: pw1.value }),
      });
      if (onSuccessStatus) {
        onSuccessStatus();
      }
      close();
      if (onComplete) onComplete();
      await updateVaultBadge();
    } catch (err) {
      errEl.textContent = parseApiError(err, errorFallback);
      errEl.hidden = false;
      btn.disabled = false;
      btn.textContent = submitLabel;
    }
  });
}

/**
 * Open setup modal for creating a new vault.
 * @param {string} location
 * @param {() => void} onComplete
 */
export function openVaultSetupModal(location, onComplete) {
  openVaultPasswordConfirmModal({
    modalId: '_vaultSetupModal',
    icon: 'shield',
    iconColor: 'var(--color-accent)',
    title: `Set Master Password: ${location}`,
    description: 'Choose a strong Master Password. This will protect all passwords and secure notes in this workspace using Argon2id and AES-256-GCM.',
    submitLabel: 'Enable Vault',
    loadingLabel: 'Initializing...',
    endpoint: `/workspaces/${encodeURIComponent(location)}/vault/setup`,
    location,
    onComplete,
    errorFallback: 'Failed to setup vault.',
    onSuccessStatus: () => {
      if (state.vaultStatus?.[location]) {
        state.vaultStatus[location].configured = true;
        state.vaultStatus[location].unlocked = true;
      }
    },
  });
}

/**
 * Open change password modal for an existing vault.
 * @param {string} location
 * @param {() => void} [onComplete]
 */
export function openVaultChangePasswordModal(location, onComplete) {
  document.getElementById('_vaultChangePwModal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = '_vaultChangePwModal';
  overlay.className = 'modal-overlay vault-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal vault-modal';

  modal.innerHTML = `
    <div class="modal__header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
      <h2 class="modal__title" style="margin: 0; display: flex; align-items: center; gap: 0.5rem;">
        <span class="material-symbols-outlined" style="color: var(--color-accent);">password</span>
        Change Master Password: ${location}
      </h2>
      <button type="button" class="btn btn--ghost _vcp_close">✕</button>
    </div>

    <p style="color: var(--color-text-muted); font-size: 0.9rem; margin-bottom: 1rem;">
      Re-encrypts all credentials in this workspace with a new Master Password using Argon2id and AES-256-GCM.
    </p>

    <form class="_vcp_form" style="display: flex; flex-direction: column; gap: 1rem;">
      <div>
        <label class="modal__label" for="_vcp_old" title="Current master password">Current Master Password</label>
        <input type="password" id="_vcp_old" class="modal__input" required autofocus />
      </div>

      <div>
        <label class="modal__label" for="_vcp_pw1" title="At least 8 characters">New Master Password</label>
        <input type="password" id="_vcp_pw1" class="modal__input" required minlength="8" />
      </div>

      <div>
        <label class="modal__label" for="_vcp_pw2" title="Repeat new password to confirm">Confirm New Master Password</label>
        <input type="password" id="_vcp_pw2" class="modal__input" required minlength="8" />
      </div>

      <p class="_vcp_error" style="color: var(--color-danger); font-size: 0.85rem; margin: 0;" hidden></p>

      <div class="modal__actions" style="display: flex; justify-content: flex-end; gap: 0.5rem;">
        <button type="button" class="btn btn--ghost _vcp_cancel">Cancel</button>
        <button type="submit" class="btn btn--primary _vcp_submit">Update Password</button>
      </div>
    </form>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  modal.querySelector('._vcp_close').addEventListener('click', close);
  modal.querySelector('._vcp_cancel').addEventListener('click', close);

  const oldPw = modal.querySelector('#_vcp_old');
  const pw1 = modal.querySelector('#_vcp_pw1');
  const pw2 = modal.querySelector('#_vcp_pw2');
  const errEl = modal.querySelector('._vcp_error');
  const form = modal.querySelector('._vcp_form');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (pw1.value !== pw2.value) {
      errEl.textContent = 'New passwords do not match.';
      errEl.hidden = false;
      return;
    }

    const btn = modal.querySelector('._vcp_submit');
    btn.disabled = true;
    btn.textContent = 'Updating...';

    try {
      await apiFetch(`/workspaces/${encodeURIComponent(location)}/vault/change-password`, {
        method: 'POST',
        body: JSON.stringify({ old_password: oldPw.value, new_password: pw1.value }),
      });
      close();
      if (onComplete) onComplete();
      await updateVaultBadge();
    } catch (err) {
      errEl.textContent = parseApiError(err, 'Failed to update password.');
      errEl.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Update Password';
    }
  });
}

/**
 * Open migration modal to upgrade legacy Fernet key to Master Password.
 * @param {string} location
 * @param {() => void} onComplete
 */
export function openVaultMigrateModal(location, onComplete) {
  openVaultPasswordConfirmModal({
    modalId: '_vaultMigrateModal',
    icon: 'upgrade',
    iconColor: 'var(--color-warning)',
    title: `Upgrade Workspace: ${location}`,
    description: 'This workspace is currently using a legacy static Fernet key. Enter a new Master Password to re-encrypt all credentials with KeePass-grade Argon2id and AES-256-GCM, and remove the plaintext key from config.',
    submitLabel: 'Upgrade & Migrate',
    loadingLabel: 'Migrating items...',
    endpoint: `/workspaces/${encodeURIComponent(location)}/vault/migrate-fernet`,
    location,
    onComplete,
    errorFallback: 'Migration failed.',
    onSuccessStatus: () => {
      if (state.vaultStatus?.[location]) {
        state.vaultStatus[location].configured = true;
        state.vaultStatus[location].unlocked = true;
        state.vaultStatus[location].has_legacy_key = false;
      }
    },
  });
}

/**
 * Checks whether the currently active view/page is a Grid page.
 * @returns {boolean}
 */
export function isGridPage() {
  if (state.activePageType !== undefined && state.activePageType !== null) {
    if (state.activePageType !== 'grid') return false;
  }
  if (!state.currentPage) return false;
  const pageType = state.currentPage.page_type;
  if (pageType && pageType !== 'grid') return false;

  const contentEl = document.getElementById('content');
  if (contentEl?.matches('.content--markdown, .content--whiteboard, .content--bpmn')) {
    return false;
  }
  return true;
}

/**
 * Update the vault lock/unlock status badge in the header/navigation.
 */
export async function updateVaultBadge() {
  const badgeBtn = document.getElementById('_vaultStatusBadge');
  if (!badgeBtn) return;

  const ws = state.currentLocation;
  if (!ws || ws === 'docs') {
    badgeBtn.hidden = true;
    return;
  }

  if (!isGridPage()) {
    badgeBtn.hidden = true;
    return;
  }

  const status = await fetchVaultStatus(ws);
  if (state.currentLocation !== ws || !isGridPage()) {
    badgeBtn.hidden = true;
    return;
  }
  if (!status.configured) {
    if (status.has_legacy_key) {
      badgeBtn.hidden = false;
      badgeBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 18px; color: var(--color-warning);">warning</span> <span style="font-size: 11px;">Legacy Key</span>`;
      badgeBtn.title = 'Legacy Fernet Key in use. Click to upgrade to Master Password vault.';
      badgeBtn.onclick = () => openVaultMigrateModal(ws, () => { void updateVaultBadge(); });
    } else {
      badgeBtn.hidden = true;
    }
    return;
  }

  badgeBtn.hidden = false;
  if (status.unlocked) {
    const mins = Math.max(1, Math.round(status.expires_in_seconds / 60));
    badgeBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 18px; color: var(--color-accent);">lock_open</span> <span style="font-size: 11px;">${mins}m</span>`;
    badgeBtn.title = `Vault unlocked (~${mins}m idle remaining). Click to lock now.`;
    badgeBtn.onclick = async () => {
      await lockVault(ws);
    };
  } else {
    badgeBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 18px; color: var(--color-warning);">lock</span> <span style="font-size: 11px;">Locked</span>`;
    badgeBtn.title = 'Vault locked. Click to unlock with Master Password.';
    badgeBtn.onclick = async () => {
      await promptUnlockVault(ws);
    };
  }
}
