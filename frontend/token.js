// token.js — Token item (PAT / API key) rendering and viewer/editor window
import { state, apiFetch, withLocation } from './app.js';
import { parseApiError, createWindowFrame, trapFocus } from './ui-utils.js';
import { renderPage } from './content.js';
import { promptUnlockVault, retryAfterVaultUnlock } from './vault.js';
import { copyToClipboard } from './password.js';
import { formatDate } from './task.js';
import { openConfirmModal } from './modal.js';

/**
 * Compute expiration status for a YYYY-MM-DD date string (3-day warning window).
 * @param {string|undefined|null} expiresAt
 * @returns {''|'overdue'|'due_soon'}
 */
export function getExpiryStatus(expiresAt) {
  if (!expiresAt) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const warnEnd = new Date(today);
  warnEnd.setDate(today.getDate() + 3);
  const exp = new Date(`${expiresAt}T00:00:00`);
  if (Number.isNaN(exp.getTime())) return '';
  if (exp <= today) return 'overdue';
  if (exp <= warnEnd) return 'due_soon';
  return '';
}

/**
 * Build badge labels for items that are expired or expiring within 3 days.
 * @param {string|undefined|null} expiresAt
 * @returns {{ status: 'overdue'|'due_soon', shortLabel: string, fullLabel: string }|null}
 */
export function getExpiryBadgeInfo(expiresAt) {
  const status = getExpiryStatus(expiresAt);
  if (!status) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(`${expiresAt}T00:00:00`);
  const diffDays = Math.round((exp - today) / (1000 * 60 * 60 * 24));
  const formatted = formatDate(expiresAt);

  if (diffDays < 0) {
    return { status, shortLabel: 'Expired', fullLabel: `Expired (${formatted})` };
  }
  if (diffDays === 0) {
    return { status, shortLabel: 'Today', fullLabel: `Expires today (${formatted})` };
  }
  return {
    status,
    shortLabel: `${diffDays}d`,
    fullLabel: `Expires in ${diffDays} day${diffDays === 1 ? '' : 's'} (${formatted})`,
  };
}

function findDecryptedTokenItem(groupIndex, itemIndex, title) {
  if (groupIndex == null) return null;
  const grp = state.currentPage?.groups?.[groupIndex];
  if (!grp?.items) return null;
  if (itemIndex != null && grp.items[itemIndex] && (grp.items[itemIndex].title === title || grp.items[itemIndex].token !== undefined)) {
    return grp.items[itemIndex];
  }
  return grp.items.find(it => it.title === title && it.token !== undefined) || (itemIndex != null ? grp.items[itemIndex] : null);
}

/**
 * Build a `<li class="item item--token">` element.
 *
 * @param {object}      item
 * @param {number}      itemIndex
 * @param {number}      groupIndex
 * @param {string}      slug
 * @param {string|null} location
 * @returns {HTMLLIElement}
 */
export function renderTokenItem(item, itemIndex, groupIndex, slug, location = null) {
  const isLocked = item.locked === true;
  const badge = getExpiryBadgeInfo(item.expires_at);
  const statusMod = badge ? ` item--token--${badge.status === 'overdue' ? 'overdue' : 'due-soon'}` : '';

  const li = document.createElement('li');
  li.className = `item item--token${statusMod}`;

  const header = document.createElement('div');
  header.className = 'item__token-header';

  const lockBtn = document.createElement('button');
  lockBtn.type = 'button';
  lockBtn.className = 'item__token-lock-btn';
  if (isLocked) {
    lockBtn.setAttribute('aria-label', 'Vault locked');
    lockBtn.title = 'Vault locked (click to unlock)';
    lockBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px; color: var(--color-warning);">lock</span>';
  } else {
    lockBtn.setAttribute('aria-label', 'Copy token');
    lockBtn.title = 'Copy token';
    lockBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;">key</span>';
  }

  const titleBtn = document.createElement('button');
  titleBtn.type = 'button';
  titleBtn.className = 'item__token-title-btn';
  titleBtn.textContent = item.title;

  header.appendChild(lockBtn);
  header.appendChild(titleBtn);

  if (badge) {
    const badgeEl = document.createElement('span');
    const badgeMod = badge.status === 'overdue' ? 'overdue' : 'due-soon';
    badgeEl.className = `item__token-badge item__token-badge--${badgeMod}`;
    badgeEl.title = badge.fullLabel;
    badgeEl.innerHTML = `<span class="material-symbols-outlined" style="font-size: 13px;" aria-hidden="true">notifications</span><span>${badge.shortLabel}</span>`;
    header.appendChild(badgeEl);
  }

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'item__token-edit';
  editBtn.setAttribute('aria-label', 'Edit token');
  editBtn.title = 'Edit token';
  editBtn.textContent = '✎';
  header.appendChild(editBtn);

  li.appendChild(header);

  lockBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (isLocked) {
      const unlocked = await promptUnlockVault(location);
      if (unlocked) {
        const freshItem = findDecryptedTokenItem(groupIndex, itemIndex, item.title);
        if (freshItem?.token) {
          const newLi = document.querySelector(`li.item--token[data-group-index="${groupIndex}"][data-item-index="${itemIndex}"]`);
          const newLockBtn = newLi?.querySelector('.item__token-lock-btn') || lockBtn;
          await copyToClipboard(freshItem.token, newLockBtn, true);
        }
      }
      return;
    }
    if (item.token) {
      await copyToClipboard(item.token, lockBtn, true);
    }
  });

  titleBtn.addEventListener('click', async () => {
    if (isLocked) {
      const unlocked = await promptUnlockVault(location);
      if (unlocked) {
        const freshItem = findDecryptedTokenItem(groupIndex, itemIndex, item.title);
        if (freshItem) {
          openTokenWindow(freshItem, itemIndex, groupIndex, slug, location, 'view');
        }
      }
      return;
    }
    openTokenWindow(item, itemIndex, groupIndex, slug, location, 'view');
  });

  editBtn.addEventListener('click', async () => {
    if (isLocked) {
      const unlocked = await promptUnlockVault(location);
      if (unlocked) {
        const freshItem = findDecryptedTokenItem(groupIndex, itemIndex, item.title);
        if (freshItem) {
          openTokenWindow(freshItem, itemIndex, groupIndex, slug, location, 'edit');
        }
      }
      return;
    }
    openTokenWindow(item, itemIndex, groupIndex, slug, location, 'edit');
  });

  return li;
}

function buildTokenViewField(label, value, { mono = false, isLink = false, maskable = false, badge = null } = {}) {
  if (!value) return null;

  const row = document.createElement('div');
  row.className = 'pw-field';

  const labelEl = document.createElement('span');
  labelEl.className = 'pw-field__label';
  labelEl.textContent = label;

  const valueEl = document.createElement('span');
  valueEl.className = 'pw-field__value' + (mono ? ' pw-field__value--mono' : '');

  if (isLink) {
    const a = document.createElement('a');
    a.href = value;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = value;
    valueEl.appendChild(a);
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    return row;
  }

  if (maskable) {
    let revealed = false;
    valueEl.textContent = '•••••••';

    const actions = document.createElement('span');
    actions.className = 'pw-field__actions';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'pw-icon-btn';
    toggleBtn.setAttribute('aria-label', `Show ${label}`);
    toggleBtn.title = `Show ${label}`;
    toggleBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;">visibility</span>';
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
    copyBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;">content_copy</span>';
    copyBtn.addEventListener('click', async () => {
      await copyToClipboard(value, copyBtn, true);
    });

    actions.appendChild(toggleBtn);
    actions.appendChild(copyBtn);
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    row.appendChild(actions);
    return row;
  }

  valueEl.textContent = value;
  if (badge) {
    const pill = document.createElement('span');
    const mod = badge.status === 'overdue' ? 'overdue' : 'due-soon';
    pill.className = `token-expiry-pill token-expiry-pill--${mod}`;
    pill.textContent = badge.shortLabel === 'Expired' ? 'Expired' : `Expiring (${badge.shortLabel})`;
    valueEl.appendChild(document.createTextNode(' '));
    valueEl.appendChild(pill);
  }
  row.appendChild(labelEl);
  row.appendChild(valueEl);
  return row;
}

function appendTimestampsMeta(container, item) {
  container.innerHTML = '';
  const formatDateTime = (iso) => (iso ? new Date(iso).toLocaleString() : '');
  if (item.created_at) {
    const createdDiv = document.createElement('div');
    createdDiv.innerHTML = '<strong>Created At:</strong> ';
    createdDiv.appendChild(document.createTextNode(formatDateTime(item.created_at)));
    container.appendChild(createdDiv);
  }
  if (item.modified_at) {
    const modDiv = document.createElement('div');
    modDiv.innerHTML = '<strong>Modified At:</strong> ';
    modDiv.appendChild(document.createTextNode(formatDateTime(item.modified_at)));
    container.appendChild(modDiv);
  }
}

/**
 * Open the token viewer/editor window overlay.
 *
 * @param {object|null}   item
 * @param {number|null}   itemIndex
 * @param {number}        groupIndex
 * @param {string}        slug
 * @param {string|null}   [location]
 * @param {'view'|'edit'} [initialMode]
 */
export function openTokenWindow(item, itemIndex, groupIndex, slug, location = null, initialMode = 'view') {
  if (item?.locked) {
    void promptUnlockVault(location).then((unlocked) => {
      if (unlocked) {
        const freshItem = findDecryptedTokenItem(groupIndex, itemIndex, item.title);
        if (freshItem) {
          openTokenWindow(freshItem, itemIndex, groupIndex, slug, location, initialMode);
        }
      }
    });
    return;
  }

  document.getElementById('_tokenWindow')?.remove();

  const isNew = item === null;
  const currentItem = isNew
    ? { title: '', token: '', expires_at: '', token_url: '', token_description: '' }
    : { ...item };

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
    id: '_tokenWindow',
    onClose: async () => {
      if (!editDiv.hidden) {
        await requestCancelEdit();
      } else {
        closeWindow();
      }
    },
  });

  const viewDiv = document.createElement('div');
  viewDiv.className = 'note-window__view pw-view token-view';

  const editDiv = document.createElement('div');
  editDiv.className = 'note-window__edit pw-edit token-edit';
  editDiv.hidden = true;

  // Edit fields
  const titleLabel = document.createElement('label');
  titleLabel.className = 'modal__label';
  titleLabel.textContent = 'Token Name';
  titleLabel.htmlFor = '_tok_title';
  titleLabel.title = 'e.g. GitHub PAT';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.id = '_tok_title';
  titleInput.className = 'modal__input';
  titleInput.required = true;

  const tokenLabel = document.createElement('label');
  tokenLabel.className = 'modal__label';
  tokenLabel.textContent = 'Token';
  tokenLabel.htmlFor = '_tok_secret';

  const tokenRow = document.createElement('div');
  tokenRow.className = 'pw-input-row pw-input-row--single';

  const tokenInput = document.createElement('input');
  tokenInput.id = '_tok_secret';
  tokenInput.type = 'password';
  tokenInput.name = 'ExoDeck_token_secret';
  tokenInput.autocomplete = 'off';
  tokenInput.setAttribute('spellcheck', 'false');
  tokenInput.setAttribute('autocapitalize', 'off');
  tokenInput.className = 'modal__input pw-input-row__input';

  const tokenEditToggle = document.createElement('button');
  tokenEditToggle.type = 'button';
  tokenEditToggle.className = 'pw-icon-btn';
  tokenEditToggle.setAttribute('aria-label', 'Show token');
  tokenEditToggle.title = 'Show token';
  tokenEditToggle.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;">visibility</span>';
  tokenEditToggle.addEventListener('click', () => {
    const show = tokenInput.type === 'password';
    tokenInput.type = show ? 'text' : 'password';
    tokenEditToggle.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;">${show ? 'visibility_off' : 'visibility'}</span>`;
    tokenEditToggle.setAttribute('aria-label', show ? 'Hide token' : 'Show token');
    tokenEditToggle.title = show ? 'Hide token' : 'Show token';
  });

  const tokenActions = document.createElement('div');
  tokenActions.className = 'pw-input-row__actions';
  tokenActions.appendChild(tokenEditToggle);
  tokenRow.appendChild(tokenInput);
  tokenRow.appendChild(tokenActions);

  const expiresLabel = document.createElement('label');
  expiresLabel.className = 'modal__label';
  expiresLabel.textContent = 'Expiration Date (optional)';
  expiresLabel.htmlFor = '_tok_expires';
  expiresLabel.title = 'Notify 3 days before expiration';

  const expiresInput = document.createElement('input');
  expiresInput.type = 'date';
  expiresInput.id = '_tok_expires';
  expiresInput.className = 'modal__input';

  const urlLabel = document.createElement('label');
  urlLabel.className = 'modal__label';
  urlLabel.textContent = 'URL (optional)';
  urlLabel.htmlFor = '_tok_url';
  urlLabel.title = 'e.g. https://github.com/settings/tokens';

  const urlInput = document.createElement('input');
  urlInput.type = 'url';
  urlInput.id = '_tok_url';
  urlInput.className = 'modal__input';

  const descLabel = document.createElement('label');
  descLabel.className = 'modal__label';
  descLabel.textContent = 'Description (optional)';
  descLabel.htmlFor = '_tok_desc';
  descLabel.title = 'Scopes, service details, or renewal notes';

  const descInput = document.createElement('textarea');
  descInput.id = '_tok_desc';
  descInput.className = 'modal__input modal__textarea';
  descInput.rows = 4;

  const metaDiv = document.createElement('div');
  metaDiv.className = 'token-meta';

  editDiv.appendChild(titleLabel);
  editDiv.appendChild(titleInput);
  editDiv.appendChild(tokenLabel);
  editDiv.appendChild(tokenRow);
  editDiv.appendChild(expiresLabel);
  editDiv.appendChild(expiresInput);
  editDiv.appendChild(urlLabel);
  editDiv.appendChild(urlInput);
  editDiv.appendChild(descLabel);
  editDiv.appendChild(descInput);
  editDiv.appendChild(metaDiv);

  bodyDiv.appendChild(viewDiv);
  bodyDiv.appendChild(editDiv);

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

  function switchToView() {
    titleEl.textContent = `🔑 ${currentItem.title}`;
    closeHeaderBtn.hidden = false;
    viewDiv.innerHTML = '';

    const urlRow = buildTokenViewField('URL', currentItem.token_url ?? '', { isLink: true });
    if (urlRow) viewDiv.appendChild(urlRow);

    const tokenRowView = buildTokenViewField('Token', currentItem.token ?? '', { mono: true, maskable: true });
    if (tokenRowView) viewDiv.appendChild(tokenRowView);

    if (currentItem.expires_at) {
      const badge = getExpiryBadgeInfo(currentItem.expires_at);
      const expRow = buildTokenViewField('Expiration Date', formatDate(currentItem.expires_at), { badge });
      if (expRow) viewDiv.appendChild(expRow);
    }

    if (currentItem.token_description) {
      const descRow = document.createElement('div');
      descRow.className = 'pw-field pw-field--notes';
      const lbl = document.createElement('span');
      lbl.className = 'pw-field__label';
      lbl.textContent = 'Description';
      const val = document.createElement('p');
      val.className = 'pw-field__value pw-field__notes-text';
      val.textContent = currentItem.token_description;
      descRow.appendChild(lbl);
      descRow.appendChild(val);
      viewDiv.appendChild(descRow);
    }

    if (currentItem.created_at || currentItem.modified_at) {
      const metaViewDiv = document.createElement('div');
      metaViewDiv.className = 'token-meta';
      appendTimestampsMeta(metaViewDiv, currentItem);
      viewDiv.appendChild(metaViewDiv);
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
    titleInput.value = currentItem.title ?? '';
    tokenInput.value = currentItem.token ?? '';
    tokenInput.type = 'password';
    tokenEditToggle.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;">visibility</span>';
    expiresInput.value = currentItem.expires_at ?? '';
    urlInput.value = currentItem.token_url ?? '';
    descInput.value = currentItem.token_description ?? '';
    appendTimestampsMeta(metaDiv, currentItem);

    viewDiv.hidden = true;
    editDiv.hidden = false;
    errorEl.hidden = true;
    closeHeaderBtn.hidden = true;

    primaryBtn.textContent = 'Save';
    secondaryBtn.textContent = 'Cancel';
    primaryBtn.onclick = saveToken;
    secondaryBtn.onclick = () => { void requestCancelEdit(); };

    titleInput.focus();
  }

  const isDirty = () => {
    const origTitle = currentItem.title ?? '';
    const origToken = currentItem.token ?? '';
    const origExpires = currentItem.expires_at ?? '';
    const origUrl = currentItem.token_url ?? '';
    const origDesc = currentItem.token_description ?? '';
    return titleInput.value !== origTitle ||
      tokenInput.value !== origToken ||
      expiresInput.value !== origExpires ||
      urlInput.value !== origUrl ||
      descInput.value !== origDesc;
  };

  requestCancelEdit = async () => {
    if (isDirty()) {
      const discard = await openConfirmModal();
      if (!discard) return false;
    }
    closeWindow();
    return true;
  };

  function buildPayload(newTitle) {
    return {
      title: newTitle,
      token: tokenInput.value,
      ...(expiresInput.value && { expires_at: expiresInput.value }),
      ...(urlInput.value.trim() && { token_url: urlInput.value.trim() }),
      ...(descInput.value.trim() && { token_description: descInput.value.trim() }),
    };
  }

  async function saveToken() {
    const newTitle = titleInput.value.trim();
    if (!newTitle) {
      errorEl.textContent = '"Token Name" is required.';
      errorEl.hidden = false;
      titleInput.focus();
      return;
    }
    if (!tokenInput.value.trim()) {
      errorEl.textContent = '"Token" is required.';
      errorEl.hidden = false;
      tokenInput.focus();
      return;
    }

    errorEl.hidden = true;
    primaryBtn.disabled = true;
    const payload = buildPayload(newTitle);

    try {
      state.currentPage = await retryAfterVaultUnlock(location, async () => {
        const apiUrl = isNew
          ? withLocation(`/pages/${slug}/groups/${groupIndex}/items`, location)
          : withLocation(`/pages/${slug}/groups/${groupIndex}/items/${itemIndex}`, location);
        await apiFetch(apiUrl, { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(payload) });
        return apiFetch(withLocation(`/pages/${slug}`, location));
      });
    } catch (err) {
      errorEl.textContent = parseApiError(err, 'Failed to save token.');
      errorEl.hidden = false;
      primaryBtn.disabled = false;
      return;
    }

    renderPage(state.currentPage);
    primaryBtn.disabled = false;
    closeWindow();
  }

  function closeWindow() {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('exodeck:vault-locked', onVaultLocked);
    overlay.remove();
    restoreFocus();
  }

  const onVaultLocked = (e) => {
    const lockedWs = e.detail?.workspace ?? '';
    const targetWs = location ?? state.currentLocation ?? '';
    if (lockedWs === targetWs && editDiv.hidden) {
      closeWindow();
    }
  };

  const onKeyDown = async (e) => {
    if (document.getElementById('_confirmModalOverlay') || document.getElementById('_vaultUnlockModal')) return;
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
  document.addEventListener('exodeck:vault-locked', onVaultLocked);

  if (initialMode === 'edit') {
    titleEl.textContent = isNew ? 'New Token' : `🔑 ${currentItem.title}`;
    switchToEdit();
  } else {
    switchToView();
  }
}
