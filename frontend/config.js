// config.js — Configuration management
import { state, apiFetch, refreshPages } from './app.js';
import { parseApiError } from './ui-utils.js';
import { loadPage } from './sidebar.js';
import {
    fetchVaultStatus,
    lockVault,
    promptUnlockVault,
    openVaultSetupModal,
    openVaultChangePasswordModal,
    openVaultMigrateModal,
} from './vault.js';

// ---------------------------------------------------------------------------
// Defaults (mirrors backend DEFAULT_CONFIG)
// ---------------------------------------------------------------------------

const DEFAULTS = {
    theme: 'dark',
    groupbox_max_width: 420,
    font_size_ui: 14,
    font_size_note: 16,
    font_size_links: 14,
};


// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

/**
 * Load config from the backend.
 * @returns {Promise<object>}
 */
export async function loadConfig() {
  try {
    return await apiFetch('/config');
  } catch {
    return { ...DEFAULTS };
  }
}

async function saveConfig(cfg) {
  return apiFetch('/config', { method: 'PUT', body: JSON.stringify(cfg) });
}

// ---------------------------------------------------------------------------
// Apply config to CSS variables
// ---------------------------------------------------------------------------

/**
 * Apply a config object to the document's CSS variables.
 * @param {object} cfg
 */
export function applyConfig(cfg) {
    const root = document.documentElement;
    if (cfg.groupbox_max_width) {
        root.style.setProperty('--groupbox-max-width', `${cfg.groupbox_max_width}px`);
    }
    if (cfg.font_size_ui) {
        // --font-size-sm and --font-size-base are the vars used throughout the UI
        const sm = cfg.font_size_ui;
        const base = Math.round(cfg.font_size_ui * 16 / 14); // scale base relative to sm
        root.style.setProperty('--font-size-sm', `${sm}px`);
        root.style.setProperty('--font-size-base', `${base}px`);
    }
    if (cfg.font_size_note) {
        root.style.setProperty('--font-size-note', `${cfg.font_size_note}px`);
    }
    if (cfg.font_size_links) {
        root.style.setProperty('--font-size-links', `${cfg.font_size_links}px`);
    }
    // Theme
    if (cfg.theme) {
        document.documentElement.dataset.theme = cfg.theme;
    }
    // Store for reference
    state.config = cfg;
}

// ---------------------------------------------------------------------------
// Config modal
// ---------------------------------------------------------------------------

// Generate a Fernet-compatible 32-byte URL-safe base64 key
function _generateFernetKey() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let binary = '';
    bytes.forEach(b => { binary += String.fromCodePoint(b); });
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_');
}

function renderConfiguredVault(statusEl, actionsEl, loc, { keyInput, fernetLabel, fernetRow }, status, onUpdate) {
    loc.fernet_key = '';
    if (keyInput) keyInput.value = '';
    if (fernetLabel) fernetLabel.style.display = 'none';
    if (fernetRow) fernetRow.style.display = 'none';

    statusEl.innerHTML = `
        <span style="display: inline-flex; align-items: center; gap: 6px; color: var(--color-accent); font-weight: 500;">
            <span class="material-symbols-outlined" style="font-size: 18px;">${status.unlocked ? 'lock_open' : 'lock'}</span>
            Vault Active (${status.unlocked ? 'Unlocked' : 'Locked'})
        </span>
    `;

    const lockUnlockBtn = document.createElement('button');
    lockUnlockBtn.type = 'button';
    lockUnlockBtn.className = 'btn btn--ghost';
    lockUnlockBtn.style.fontSize = 'var(--font-size-sm)';
    lockUnlockBtn.textContent = status.unlocked ? 'Lock' : 'Unlock';
    lockUnlockBtn.onclick = async () => {
        if (status.unlocked) {
            await lockVault(loc.name);
        } else {
            await promptUnlockVault(loc.name);
        }
        onUpdate();
    };

    const changePwBtn = document.createElement('button');
    changePwBtn.type = 'button';
    changePwBtn.className = 'btn btn--ghost';
    changePwBtn.style.fontSize = 'var(--font-size-sm)';
    changePwBtn.textContent = 'Change Password';
    changePwBtn.onclick = () => {
        openVaultChangePasswordModal(loc.name, () => onUpdate());
    };

    actionsEl.appendChild(lockUnlockBtn);
    actionsEl.appendChild(changePwBtn);
}

function renderLegacyVault(statusEl, actionsEl, loc, { keyInput, fernetLabel, fernetRow }, onUpdate) {
    if (fernetLabel) fernetLabel.style.display = '';
    if (fernetRow) fernetRow.style.display = '';

    statusEl.innerHTML = `
        <span style="display: inline-flex; align-items: center; gap: 6px; color: var(--color-warning); font-weight: 500;">
            <span class="material-symbols-outlined" style="font-size: 18px;">warning</span>
            Legacy Key Active
        </span>
    `;

    const migrateBtn = document.createElement('button');
    migrateBtn.type = 'button';
    migrateBtn.className = 'btn btn--primary';
    migrateBtn.style.fontSize = 'var(--font-size-sm)';
    migrateBtn.textContent = 'Upgrade to Vault';
    migrateBtn.onclick = () => {
        openVaultMigrateModal(loc.name, () => {
            loc.fernet_key = '';
            if (keyInput) keyInput.value = '';
            onUpdate();
        });
    };
    actionsEl.appendChild(migrateBtn);
}

function renderUnconfiguredVault(statusEl, actionsEl, loc, { fernetLabel, fernetRow }, onUpdate) {
    if (fernetLabel) fernetLabel.style.display = '';
    if (fernetRow) fernetRow.style.display = '';

    statusEl.innerHTML = `
        <span style="color: var(--color-text-muted); font-size: var(--font-size-sm);">
            No Master Password configured.
        </span>
    `;

    const setupBtn = document.createElement('button');
    setupBtn.type = 'button';
    setupBtn.className = 'btn btn--primary';
    setupBtn.style.fontSize = 'var(--font-size-sm)';
    setupBtn.textContent = 'Enable Vault';
    setupBtn.onclick = () => {
        openVaultSetupModal(loc.name, () => onUpdate());
    };
    actionsEl.appendChild(setupBtn);
}

/**
 * Open the configuration modal. On confirm, save and apply the new config.
 */
export async function openConfigModal() {
    const current = state.config ?? await loadConfig();

    // Local mutable state for workspaces rows (supports legacy object or new array format)
    const dl = current.workspaces ?? {};
    const parsedLocations = Array.isArray(dl)
        ? dl.map(loc => ({ name: loc.name, path: loc.path ?? '', fernet_key: loc.fernet_key ?? '', hidden: loc.hidden ?? false }))
        : Object.entries(dl).map(([name, loc]) => ({ name, path: loc.path ?? '', fernet_key: loc.fernet_key ?? '', hidden: loc.hidden ?? false }));

    let locationRows = parsedLocations.map(loc => ({
        id: crypto.randomUUID(),
        ...loc
    }));

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = '_configModal';

    const modal = document.createElement('div');
    modal.className = 'modal config-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', '_configModalTitle');

    modal.innerHTML = `
    <h2 class="modal__title" id="_configModalTitle">Configuration</h2>

    <div class="config-modal__tabs-layout">
      <nav class="config-modal__tab-nav" role="tablist" aria-label="Config sections">
        <button type="button" class="config-modal__tab-btn config-modal__tab-btn--active"
          id="_cfg_tab_general" role="tab" aria-selected="true" aria-controls="_cfg_panel_general">
          General
        </button>
        <button type="button" class="config-modal__tab-btn"
          id="_cfg_tab_workspaces" role="tab" aria-selected="false" aria-controls="_cfg_panel_workspaces">
          Workspaces
        </button>
      </nav>

      <div class="config-modal__tab-panels">
        <div class="config-modal__tab-panel" id="_cfg_panel_general" role="tabpanel" aria-labelledby="_cfg_tab_general">
          <div class="config-modal__section">
            <span class="modal__label">Theme</span>
            <div class="config-modal__theme-row">
              <button type="button" id="_cfg_theme_dark"
                class="config-modal__theme-btn ${current.theme === 'light' ? '' : 'config-modal__theme-btn--active'}">
                ◑ Dark
              </button>
              <button type="button" id="_cfg_theme_light"
                class="config-modal__theme-btn ${current.theme === 'light' ? 'config-modal__theme-btn--active' : ''}">
                ○ Light
              </button>
            </div>
          </div>

          <div class="config-modal__grid">
            <label class="modal__label" for="_cfg_gw">Max group box width (px)</label>
            <input class="modal__input" id="_cfg_gw" type="number" min="200" max="900" step="10"
              value="${current.groupbox_max_width}" />

            <label class="modal__label" for="_cfg_fs_ui">UI font size (px)</label>
            <input class="modal__input" id="_cfg_fs_ui" type="number" min="10" max="24" step="1"
              value="${current.font_size_ui}" />

            <label class="modal__label" for="_cfg_fs_md">Note font size (px)</label>
            <input class="modal__input" id="_cfg_fs_md" type="number" min="10" max="24" step="1"
              value="${current.font_size_note}" />

            <label class="modal__label" for="_cfg_fs_lk">Grid font size (px)</label>
            <input class="modal__input" id="_cfg_fs_lk" type="number" min="10" max="24" step="1"
              value="${current.font_size_links}" />

            <label class="modal__label" for="_cfg_port">Port</label>
            <input class="modal__input" id="_cfg_port" type="number" min="1" max="65535" step="1"
              value="${current.port ?? 8000}" />
          </div>

          <div class="config-modal__section">
            <label class="config-modal__check-row">
              <input type="checkbox" id="_cfg_git_sync" ${current.enable_git_sync ? 'checked' : ''} />
              <span class="modal__label">Enable Git sync</span>
            </label>
          </div>
        </div>

        <div class="config-modal__tab-panel" id="_cfg_panel_workspaces" role="tabpanel" aria-labelledby="_cfg_tab_workspaces" hidden>
          <div class="config-modal__section">
            <div class="config-modal__loc-header">
              <button type="button" class="btn btn--ghost config-modal__loc-add" id="_cfg_add_loc">+ Add Workspace</button>
            </div>
            <div id="_cfg_locations"></div>
          </div>
        </div>
      </div>
    </div>

    <div class="modal__actions">
      <button type="button" class="btn btn--ghost" id="_cfg_cancel">Cancel</button>
      <button type="button" class="btn btn--primary" id="_cfg_save">Save</button>
    </div>
  `;

    // --- Tab switching ---
    const tabGeneral = modal.querySelector('#_cfg_tab_general');
    const tabWorkspaces = modal.querySelector('#_cfg_tab_workspaces');
    const panelGeneral = modal.querySelector('#_cfg_panel_general');
    const panelWorkspaces = modal.querySelector('#_cfg_panel_workspaces');

    const activateTab = (tab) => {
        const isGeneral = tab === tabGeneral;
        tabGeneral.classList.toggle('config-modal__tab-btn--active', isGeneral);
        tabGeneral.setAttribute('aria-selected', String(isGeneral));
        tabWorkspaces.classList.toggle('config-modal__tab-btn--active', !isGeneral);
        tabWorkspaces.setAttribute('aria-selected', String(!isGeneral));
        panelGeneral.hidden = !isGeneral;
        panelWorkspaces.hidden = isGeneral;
    };

    tabGeneral.addEventListener('click', () => activateTab(tabGeneral));
    tabWorkspaces.addEventListener('click', () => activateTab(tabWorkspaces));

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // --- Theme toggle ---
    let selectedTheme = current.theme ?? 'dark';
    const originalTheme = selectedTheme;
    const darkBtn = modal.querySelector('#_cfg_theme_dark');
    const lightBtn = modal.querySelector('#_cfg_theme_light');

    const setTheme = (t) => {
        selectedTheme = t;
        darkBtn.classList.toggle('config-modal__theme-btn--active', t !== 'light');
        lightBtn.classList.toggle('config-modal__theme-btn--active', t === 'light');
        document.documentElement.dataset.theme = t;
    };
    darkBtn.addEventListener('click', () => setTheme('dark'));
    lightBtn.addEventListener('click', () => setTheme('light'));

    // --- Workspaces ---
    const locContainer = modal.querySelector('#_cfg_locations');

    let draggedIndex = null;

    function renderLocations() {
        locContainer.innerHTML = '';
        for (let index = 0; index < locationRows.length; index++) {
            const loc = locationRows[index];
            const row = document.createElement('div');
            row.className = 'config-modal__loc';
            row.dataset.locId = loc.id;
            row.draggable = true;
            row.innerHTML = `
              <div class="config-modal__loc-drag-handle" tabindex="0" title="Drag or use Up/Down arrow keys to move" aria-label="Move workspace">☰</div>
              <div class="config-modal__loc-name-display">${_esc(loc.name) || '<em>Unnamed</em>'}</div>
              <label class="config-modal__loc-hidden-label">
                <input type="checkbox" class="config-modal__loc-hidden" ${loc.hidden ? 'checked' : ''} />
                Hidden
              </label>
              <button type="button" class="config-modal__loc-del" title="Remove location" aria-label="Remove workspace">
                <span class="material-symbols-outlined" style="font-size: 18px;" aria-hidden="true">delete</span>
              </button>
            `;

            row.addEventListener('dragstart', (e) => {
                draggedIndex = index;
                e.dataTransfer.effectAllowed = 'move';
                setTimeout(() => row.classList.add('dragging'), 0);
            });
            row.addEventListener('dragend', () => {
                draggedIndex = null;
                row.classList.remove('dragging');
            });
            row.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (draggedIndex === null || draggedIndex === index) {
                    row.classList.remove('config-modal__loc--insert-before', 'config-modal__loc--insert-after');
                    return;
                }
                e.dataTransfer.dropEffect = 'move';
                const rect = row.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                if (e.clientY < midY) {
                    row.classList.add('config-modal__loc--insert-before');
                    row.classList.remove('config-modal__loc--insert-after');
                } else {
                    row.classList.add('config-modal__loc--insert-after');
                    row.classList.remove('config-modal__loc--insert-before');
                }
            });
            row.addEventListener('dragleave', () => {
                row.classList.remove('config-modal__loc--insert-before', 'config-modal__loc--insert-after');
            });
            row.addEventListener('drop', (e) => {
                e.preventDefault();
                row.classList.remove('config-modal__loc--insert-before', 'config-modal__loc--insert-after');
                if (draggedIndex === null || draggedIndex === index) return;
                
                const rect = row.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                let dropIndex = e.clientY < midY ? index : index + 1;
                
                // Adjust for shifting array indices after removal
                if (draggedIndex < dropIndex) {
                    dropIndex--;
                }
                
                const draggedItem = locationRows.splice(draggedIndex, 1)[0];
                locationRows.splice(dropIndex, 0, draggedItem);
                renderLocations();
            });

            const dragHandle = row.querySelector('.config-modal__loc-drag-handle');
            dragHandle.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (index > 0) {
                        [locationRows[index - 1], locationRows[index]] = [locationRows[index], locationRows[index - 1]];
                        renderLocations();
                        locContainer.querySelectorAll('.config-modal__loc-drag-handle')[index - 1].focus();
                    }
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (index < locationRows.length - 1) {
                        [locationRows[index], locationRows[index + 1]] = [locationRows[index + 1], locationRows[index]];
                        renderLocations();
                        locContainer.querySelectorAll('.config-modal__loc-drag-handle')[index + 1].focus();
                    }
                } else if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openWorkspaceEditModal(loc, index);
                }
            });

            row.addEventListener('click', (e) => {
                if (e.target.closest('.config-modal__loc-hidden-label') || e.target.closest('.config-modal__loc-del') || e.target.closest('.config-modal__loc-drag-handle')) {
                    return;
                }
                openWorkspaceEditModal(loc, index);
            });

            row.querySelector('.config-modal__loc-del').addEventListener('click', (e) => {
                e.stopPropagation();
                locationRows = locationRows.filter(l => l.id !== loc.id);
                renderLocations();
            });

            row.querySelector('.config-modal__loc-hidden').addEventListener('change', (e) => {
                loc.hidden = e.target.checked;
            });

            locContainer.appendChild(row);
        }
    }

    function openWorkspaceEditModal(loc, index) {
        const editOverlay = document.createElement('div');
        editOverlay.className = 'modal-overlay workspace-edit-modal-overlay';
        
        const editModal = document.createElement('div');
        editModal.className = 'modal config-modal';
        editModal.innerHTML = `
            <h2 class="modal__title">${index === -1 ? 'Add Workspace' : 'Edit Workspace'}</h2>
            <div class="config-modal__grid config-modal__grid--auto" style="margin-bottom: var(--space-md);">
                <label class="modal__label" for="_edit_ws_name" title="Workspace name">Name</label>
                <input class="modal__input" id="_edit_ws_name" type="text" value="${_esc(loc.name)}" />
                
                <label class="modal__label" for="_edit_ws_path" title="Absolute filesystem directory path">Path</label>
                <input class="modal__input" id="_edit_ws_path" type="text" value="${_esc(loc.path)}" />
                
                <label class="modal__label">Master Password Vault</label>
                ${index !== -1 ? `
                <div id="_edit_ws_vault_container" style="background: var(--color-surface-2); padding: 8px 12px; border-radius: var(--radius-sm); border: 1px solid var(--color-border); min-width: 0;">
                    <div style="display: flex; justify-content: space-between; align-items: center; min-height: 32px; gap: var(--space-xs); flex-wrap: wrap;">
                        <span id="_edit_ws_vault_status" style="font-size: var(--font-size-sm); color: var(--color-text-muted); display: inline-flex; align-items: center; gap: 6px;">Checking vault status…</span>
                        <div id="_edit_ws_vault_actions" style="display: inline-flex; gap: var(--space-xs); align-items: center; flex-shrink: 0;"></div>
                    </div>
                </div>
                ` : `
                <div style="font-size: var(--font-size-sm); color: var(--color-text-muted);">Save the workspace first to configure a Master Password vault.</div>
                `}

                <label class="modal__label _edit_ws_fernet_label" for="_edit_ws_key" title="32-byte URL-safe base64 key">Fernet Key (Legacy)</label>
                <div class="config-modal__key-row _edit_ws_fernet_row" style="display: flex; gap: var(--space-xs); align-items: center;">
                    <input class="modal__input" id="_edit_ws_key" type="password" value="${_esc(loc.fernet_key)}" autocomplete="off" style="flex: 1; font-family: var(--font-mono, monospace);" />
                    <button type="button" class="pw-icon-btn config-modal__key-reveal" title="Show Fernet key" aria-label="Show Fernet key" style="flex-shrink: 0;"><span class="material-symbols-outlined" style="font-size: 18px;" aria-hidden="true">visibility</span></button>
                    <button type="button" class="btn btn--ghost" id="_edit_ws_keygen" style="flex-shrink: 0;">Generate</button>
                </div>
                
                ${index !== -1 ? `
                <label class="modal__label">Workspace Icon</label>
                <div style="display: flex; gap: var(--space-xs); align-items: center;">
                    <img src="/api/v1/media/.icon.svg?location=${encodeURIComponent(loc.name)}" onerror="this.style.display='none'" style="width: 24px; height: 24px; object-fit: contain; display: none;" id="_edit_ws_icon_preview" onload="this.style.display='block'" />
                    <input type="file" id="_edit_ws_icon_file" accept=".svg" style="display: none;" />
                    <button type="button" class="btn btn--ghost" id="_edit_ws_icon_btn">Upload SVG Icon</button>
                    <button type="button" class="btn btn--ghost btn--icon" id="_edit_ws_icon_del" title="Delete custom icon" aria-label="Delete custom icon" style="padding: 0 var(--space-xs); display: flex; align-items: center;"><span class="material-symbols-outlined" style="font-size: 18px;" aria-hidden="true">delete</span></button>
                </div>
                <div id="_edit_ws_icon_msg" style="font-size: var(--font-size-sm); color: var(--color-text-muted); margin-top: 4px;"></div>
                ` : `
                <label class="modal__label">Workspace Icon</label>
                <div style="font-size: var(--font-size-sm); color: var(--color-text-muted);">Save the workspace first to upload an icon.</div>
                `}
            </div>
            <div class="modal__actions">
                <button type="button" class="btn btn--ghost" id="_edit_ws_cancel">Cancel</button>
                <button type="button" class="btn btn--primary" id="_edit_ws_save">Save</button>
            </div>
        `;

        const onEditEscape = (e) => {
            if (e.key === 'Escape') {
                e.stopImmediatePropagation();
                closeEditModal();
            }
        };

        const closeEditModal = () => {
            document.removeEventListener('keydown', onEditEscape, true);
            editOverlay.remove();
        };

        editOverlay.appendChild(editModal);
        document.body.appendChild(editOverlay);
        
        document.addEventListener('keydown', onEditEscape, true);

        editModal.querySelector('#_edit_ws_cancel').addEventListener('click', closeEditModal);
        
        editModal.querySelector('.config-modal__key-reveal').addEventListener('click', () => {
            const keyInput = editModal.querySelector('#_edit_ws_key');
            const revealBtn = editModal.querySelector('.config-modal__key-reveal');
            const show = keyInput.type === 'password';
            keyInput.type = show ? 'text' : 'password';
            revealBtn.innerHTML = show ? '<span class="material-symbols-outlined" style="font-size: 18px;" aria-hidden="true">visibility_off</span>' : '<span class="material-symbols-outlined" style="font-size: 18px;" aria-hidden="true">visibility</span>';
            revealBtn.setAttribute('aria-label', show ? 'Hide Fernet key' : 'Show Fernet key');
            revealBtn.title = show ? 'Hide Fernet key' : 'Show Fernet key';
        });

        editModal.querySelector('#_edit_ws_keygen').addEventListener('click', () => {
            const keyInput = editModal.querySelector('#_edit_ws_key');
            keyInput.value = _generateFernetKey();
            keyInput.type = 'text';
            const revealBtn = editModal.querySelector('.config-modal__key-reveal');
            revealBtn.textContent = '🙈';
            revealBtn.setAttribute('aria-label', 'Hide Fernet key');
            revealBtn.title = 'Hide Fernet key';
        });

        editModal.querySelector('#_edit_ws_save').addEventListener('click', () => {
            loc.name = editModal.querySelector('#_edit_ws_name').value.trim();
            loc.path = editModal.querySelector('#_edit_ws_path').value.trim();
            loc.fernet_key = editModal.querySelector('#_edit_ws_key').value;
            
            if (index === -1) {
                locationRows.push(loc);
            }
            renderLocations();
            closeEditModal();
        });
        
        if (index !== -1) {
            const iconBtn = editModal.querySelector('#_edit_ws_icon_btn');
            const iconFile = editModal.querySelector('#_edit_ws_icon_file');
            const iconPreview = editModal.querySelector('#_edit_ws_icon_preview');
            const iconMsg = editModal.querySelector('#_edit_ws_icon_msg');

            if (iconBtn && iconFile) {
                iconBtn.addEventListener('click', () => iconFile.click());

                iconFile.addEventListener('change', async (e) => {
                    const file = e.target.files[0];
                    if (!file) return;

                    const formData = new FormData();
                    formData.append('file', file);

                    iconBtn.disabled = true;
                    iconMsg.textContent = 'Uploading...';
                    iconMsg.style.color = 'var(--color-text-muted)';

                    try {
                        const res = await fetch(`/api/v1/locations/icon?location=${encodeURIComponent(loc.name)}`, {
                            method: 'POST',
                            body: formData
                        });
                        if (!res.ok) {
                            const errText = await res.text();
                            throw new Error(parseApiError(errText, 'Upload failed'));
                        }
                        iconMsg.textContent = 'Icon uploaded successfully.';
                        iconMsg.style.color = '#4caf50';
                        iconPreview.src = `/api/v1/media/.icon.svg?location=${encodeURIComponent(loc.name)}&t=${Date.now()}`;
                        iconPreview.style.display = 'block';
                        
                        document.dispatchEvent(new CustomEvent('exodeck:workspace-icon-changed', {
                            detail: { location: loc.name }
                        }));
                    } catch (err) {
                        iconMsg.textContent = `Error: ${err.message}`;
                        iconMsg.style.color = '#f44336';
                    } finally {
                        iconBtn.disabled = false;
                    }
                });
            }

            const iconDelBtn = editModal.querySelector('#_edit_ws_icon_del');
            if (iconDelBtn) {
                iconDelBtn.addEventListener('click', async () => {
                    iconDelBtn.disabled = true;
                    iconMsg.textContent = 'Deleting icon...';
                    iconMsg.style.color = 'var(--color-text-muted)';
                    try {
                        const res = await fetch(`/api/v1/locations/icon?location=${encodeURIComponent(loc.name)}`, {
                            method: 'DELETE'
                        });
                        if (!res.ok) {
                            const errText = await res.text();
                            throw new Error(parseApiError(errText, 'Delete failed'));
                        }
                        iconMsg.textContent = 'Icon deleted successfully.';
                        iconMsg.style.color = '#4caf50';
                        iconPreview.style.display = 'none';
                        iconPreview.src = '';
                        document.dispatchEvent(new CustomEvent('exodeck:workspace-icon-changed', {
                            detail: { location: loc.name }
                        }));
                    } catch (err) {
                        iconMsg.textContent = `Error: ${err.message}`;
                        iconMsg.style.color = '#f44336';
                    } finally {
                        iconDelBtn.disabled = false;
                    }
                });
            }

            const updateVaultSection = async () => {
                const statusEl = editModal.querySelector('#_edit_ws_vault_status');
                const actionsEl = editModal.querySelector('#_edit_ws_vault_actions');
                const fernetLabel = editModal.querySelector('._edit_ws_fernet_label');
                const fernetRow = editModal.querySelector('._edit_ws_fernet_row');
                const keyInput = editModal.querySelector('#_edit_ws_key');
                if (!statusEl || !actionsEl) return;

                const status = await fetchVaultStatus(loc.name);
                actionsEl.innerHTML = '';
                const els = { keyInput, fernetLabel, fernetRow };

                if (status.configured) {
                    renderConfiguredVault(statusEl, actionsEl, loc, els, status, updateVaultSection);
                } else if (loc.fernet_key || status.has_legacy_key) {
                    renderLegacyVault(statusEl, actionsEl, loc, els, updateVaultSection);
                } else {
                    renderUnconfiguredVault(statusEl, actionsEl, loc, els, updateVaultSection);
                }
            };
            void updateVaultSection();
        }

        editModal.querySelector('#_edit_ws_name').focus();
    }

    modal.querySelector('#_cfg_add_loc').addEventListener('click', () => {
        openWorkspaceEditModal({ id: crypto.randomUUID(), name: '', path: '', fernet_key: _generateFernetKey(), hidden: false }, -1);
    });

    renderLocations();

    // --- Close / cancel ---
    const onEscape = (e) => {
      if (e.key === 'Escape') close(true);
    };

    const close = (revertTheme = true) => {
      document.removeEventListener('keydown', onEscape);
        if (revertTheme) document.documentElement.dataset.theme = originalTheme;
        overlay.remove();
    };

    modal.querySelector('#_cfg_cancel').addEventListener('click', () => close(true));
    document.addEventListener('keydown', onEscape);

    // --- Save ---
    modal.querySelector('#_cfg_save').addEventListener('click', async () => {
        const gw = Number.parseInt(modal.querySelector('#_cfg_gw').value, 10) || current.groupbox_max_width;
        const fsUi = Number.parseInt(modal.querySelector('#_cfg_fs_ui').value, 10) || current.font_size_ui;
        const fsMd = Number.parseInt(modal.querySelector('#_cfg_fs_md').value, 10) || current.font_size_note;
        const fsLk = Number.parseInt(modal.querySelector('#_cfg_fs_lk').value, 10) || current.font_size_links;
        const port = Number.parseInt(modal.querySelector('#_cfg_port').value, 10) || (current.port ?? 8000);
        const enableGitSync = modal.querySelector('#_cfg_git_sync').checked;

        const dataLocations = [];
        locationRows.forEach(loc => {
            const name = loc.name.trim();
            if (name) {
                dataLocations.push({ name, path: loc.path, fernet_key: loc.fernet_key, hidden: loc.hidden });
            }
        });

        const newCfg = {
            ...current,
            theme: selectedTheme,
            groupbox_max_width: gw,
            font_size_ui: fsUi,
            font_size_note: fsMd,
            font_size_links: fsLk,
            port,
            enable_git_sync: enableGitSync,
            workspaces: dataLocations,
        };

        try {
            const saved = await saveConfig(newCfg);
            applyConfig(saved);
            await refreshPages();
            document.dispatchEvent(new CustomEvent('exodeck:pages-changed'));
            // Reload the current page so group-card closures pick up the updated location name.
            if (state.currentSlug) {
              const updatedMeta = state.pages.find(p => p.slug === state.currentSlug);
              if (updatedMeta) {
                await loadPage(state.currentSlug, updatedMeta.location ?? null);
              }
            }
            close(false);
        } catch (err) {
            console.error('[ExoDeck] Failed to save config:', err);
        }
    });

    modal.querySelector('#_cfg_cancel').focus();
}

function _esc(str) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
    return (str ?? '').replace(/[&<>"]/g, m => map[m]);
}
