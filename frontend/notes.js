// notes.js — Note items component
import { state, apiFetch, withLocation } from './app.js';
import { parseApiError, createWindowFrame, trapFocus } from './ui-utils.js';
import { renderPage } from './content.js';
import { renderMarkdownToElement, updateMarkdownCheckbox } from './markdown-utils.js';
import { promptUnlockVault } from './vault.js';
import { openConfirmModal } from './modal.js';

/**
 * Decode a Base64-encoded UTF-8 string.
 * @param {string} base64
 * @returns {string}
 */
function decodeNote(base64) {
  if (!base64) return '';
  return new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.codePointAt(0)));
}

/**
 * Encode a string to a Base64-encoded UTF-8 string.
 * @param {string} text
 * @returns {string}
 */
function encodeNote(text) {
  const bytes = new TextEncoder().encode(text ?? '');
  return btoa(Array.from(bytes, b => String.fromCodePoint(b)).join(''));
}

function createNoteCancelHandler({ isDirty, canSwitchToView, switchToView, closeWindow }) {
  return async () => {
    if (isDirty()) {
      const discard = await openConfirmModal();
      if (!discard) return false;
    }
    if (canSwitchToView()) {
      switchToView();
    } else {
      closeWindow();
    }
    return true;
  };
}

function createNoteKeyHandler({ win, isInEditMode, onCancelEdit, onClose }) {
  return async (e) => {
    if (document.getElementById('_confirmModalOverlay')) return;
    if (e.key === 'Tab') {
      trapFocus(e, win);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (isInEditMode()) {
        await onCancelEdit();
      } else {
        onClose();
      }
    }
  };
}

function renderItemDates(metaDiv, currentItem) {
  metaDiv.innerHTML = '';
  const formatDate = (iso) => iso ? new Date(iso).toLocaleString() : '';
  if (currentItem.created_at) {
    metaDiv.innerHTML += `<div><strong>Created At:</strong> ${formatDate(currentItem.created_at)}</div>`;
  }
  if (currentItem.modified_at) {
    metaDiv.innerHTML += `<div><strong>Modified At:</strong> ${formatDate(currentItem.modified_at)}</div>`;
  }
}

/**
 * Common viewer/editor window implementation for both standard and encrypted notes.
 */
function openGenericNoteWindow({
  isEncrypted,
  item,
  itemIndex,
  groupIndex,
  slug,
  location = null,
  initialMode = 'view',
}) {
  const isNew = isEncrypted && item === null;
  const overlayId = isEncrypted ? '_encNoteWindow' : '_noteWindow';

  let currentItem = isNew ? { title: '', enc_text: '' } : { ...item };
  let originalRawText = isEncrypted
    ? (currentItem.enc_text ?? '')
    : decodeNote(currentItem.text ?? '');
  let currentRawText = originalRawText;
  let hasCheckboxChanges = false;
  let isInEditMode = false;
  let editFromView = false;
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
    id: overlayId,
    onClose: async () => {
      if (isInEditMode) {
        await requestCancelEdit();
      } else {
        closeWindow();
      }
    },
  });

  const viewDiv = document.createElement('div');
  viewDiv.className = 'note-window__view';

  const editDiv = document.createElement('div');
  editDiv.className = 'note-window__edit';
  editDiv.hidden = true;

  const titleId = isEncrypted ? '_en_title' : '_nw_title';
  const contentId = isEncrypted ? '_en_content' : '_nw_content';

  const titleLabel = document.createElement('label');
  titleLabel.className = 'modal__label';
  titleLabel.textContent = 'Title';
  titleLabel.title = isEncrypted ? 'Encrypted note title' : 'Note title';
  titleLabel.htmlFor = titleId;

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.id = titleId;
  titleInput.className = 'modal__input';
  titleInput.required = true;

  const contentLabel = document.createElement('label');
  contentLabel.className = 'modal__label';
  contentLabel.textContent = 'Content (Markdown)';
  contentLabel.title = 'Markdown formatted content';
  contentLabel.htmlFor = contentId;

  const contentArea = document.createElement('textarea');
  contentArea.id = contentId;
  contentArea.className = 'modal__input modal__textarea';
  contentArea.rows = 16;

  editDiv.appendChild(titleLabel);
  editDiv.appendChild(titleInput);
  editDiv.appendChild(contentLabel);
  editDiv.appendChild(contentArea);

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

  viewDiv.addEventListener('change', (e) => {
    if (!e.target.classList.contains('task-list-checkbox')) return;
    const checkboxes = Array.from(viewDiv.querySelectorAll('.task-list-checkbox'));
    const idx = checkboxes.indexOf(e.target);
    if (idx === -1) return;

    currentRawText = updateMarkdownCheckbox(currentRawText, idx, e.target.checked);
    hasCheckboxChanges = (currentRawText !== originalRawText);
    if (isEncrypted) {
      currentItem.enc_text = currentRawText;
    } else {
      currentItem.text = encodeNote(currentRawText);
    }
  });

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

  const isDirty = () => titleInput.value !== (currentItem.title ?? '') || contentArea.value !== (currentRawText ?? '');

  requestCancelEdit = createNoteCancelHandler({
    isDirty,
    canSwitchToView: () => editFromView,
    switchToView,
    closeWindow,
  });

  overlay.addEventListener('click', async (e) => {
    if (e.target === overlay) {
      if (isInEditMode) {
        await requestCancelEdit();
      } else {
        closeWindow();
      }
    }
  });

  function switchToView(updatedItem) {
    isInEditMode = false;
    if (updatedItem) {
      currentItem = updatedItem;
      originalRawText = isEncrypted
        ? (currentItem.enc_text ?? '')
        : decodeNote(currentItem.text ?? '');
      currentRawText = originalRawText;
      hasCheckboxChanges = false;
    }
    titleEl.textContent = isEncrypted ? `🔒 ${currentItem.title}` : currentItem.title;
    void renderMarkdownToElement(currentRawText, viewDiv);
    primaryBtn.hidden = false;
    primaryBtn.textContent = 'Edit';
    primaryBtn.onclick = () => switchToEdit(true);
    viewDiv.hidden = false;
    editDiv.hidden = true;
    errorEl.hidden = true;
    closeHeaderBtn.hidden = false;
    secondaryBtn.textContent = 'Close';
    secondaryBtn.onclick = closeWindow;
    primaryBtn.focus();
  }

  function switchToEdit(fromView = false) {
    isInEditMode = true;
    editFromView = fromView;
    if (isEncrypted) {
      if (isNew) {
        titleEl.textContent = '🔒 New Encrypted Note';
      } else {
        titleEl.textContent = currentItem.title ? `🔒 ✎ ${currentItem.title}` : '🔒 Edit Encrypted Note';
      }
    } else {
      titleEl.textContent = currentItem.title ? `✎ ${currentItem.title}` : 'Edit Note';
    }
    titleInput.value = currentItem.title;
    contentArea.value = currentRawText;

    renderItemDates(metaDiv, currentItem);

    viewDiv.hidden = true;
    editDiv.hidden = false;
    errorEl.hidden = true;
    closeHeaderBtn.hidden = true;
    primaryBtn.hidden = false;
    primaryBtn.textContent = 'Save';
    secondaryBtn.textContent = 'Cancel';
    primaryBtn.onclick = saveNote;
    secondaryBtn.onclick = () => { void requestCancelEdit(); };
    titleInput.focus();
  }

  async function saveNote() {
    const newTitle = titleInput.value.trim();
    if (!newTitle) {
      errorEl.textContent = '"Title" is required.';
      errorEl.hidden = false;
      titleInput.focus();
      return;
    }
    errorEl.hidden = true;
    primaryBtn.disabled = true;

    try {
      if (isEncrypted) {
        const updated = { title: newTitle, enc_text: contentArea.value ?? '' };
        if (isNew) {
          await apiFetch(withLocation(`/pages/${slug}/groups/${groupIndex}/items`, location), {
            method: 'POST',
            body: JSON.stringify(updated),
          });
          state.currentPage = await apiFetch(withLocation(`/pages/${slug}`, location));
          renderPage(state.currentPage);
          closeWindow();
        } else {
          const returned = await apiFetch(withLocation(`/pages/${slug}/groups/${groupIndex}/items/${itemIndex}`, location), {
            method: 'PUT',
            body: JSON.stringify(updated),
          });
          state.currentPage = await apiFetch(withLocation(`/pages/${slug}`, location));
          renderPage(state.currentPage);
          primaryBtn.disabled = false;
          originalRawText = contentArea.value ?? '';
          currentRawText = originalRawText;
          hasCheckboxChanges = false;
          switchToView({ ...updated, enc_text: returned.enc_text ?? updated.enc_text });
        }
      } else {
        const encoded = encodeNote(contentArea.value ?? '');
        const updated = { title: newTitle, text: encoded };
        await apiFetch(withLocation(`/pages/${slug}/groups/${groupIndex}/items/${itemIndex}`, location), {
          method: 'PUT',
          body: JSON.stringify(updated),
        });
        item.text = encoded;
        item.title = newTitle;
        state.currentPage = await apiFetch(withLocation(`/pages/${slug}`, location));
        renderPage(state.currentPage);
        primaryBtn.disabled = false;
        switchToView(updated);
      }
    } catch (err) {
      errorEl.textContent = parseApiError(err, isEncrypted ? 'Failed to save encrypted note.' : 'Failed to save note.');
      errorEl.hidden = false;
      primaryBtn.disabled = false;
    }
  }

  async function persistCheckboxChanges() {
    try {
      if (isEncrypted) {
        const updated = { title: currentItem.title, enc_text: currentRawText };
        if (!isNew && item) item.enc_text = currentRawText;
        if (!isNew && state.currentPage?.groups?.[groupIndex]?.items?.[itemIndex]) {
          state.currentPage.groups[groupIndex].items[itemIndex].enc_text = currentRawText;
        }
        await apiFetch(withLocation(`/pages/${slug}/groups/${groupIndex}/items/${itemIndex}`, location), {
          method: 'PUT',
          body: JSON.stringify(updated),
        });
      } else {
        const encoded = encodeNote(currentRawText);
        const updated = { title: currentItem.title, text: encoded };
        item.text = encoded;
        if (state.currentPage?.groups?.[groupIndex]?.items?.[itemIndex]) {
          state.currentPage.groups[groupIndex].items[itemIndex].text = encoded;
        }
        await apiFetch(withLocation(`/pages/${slug}/groups/${groupIndex}/items/${itemIndex}`, location), {
          method: 'PUT',
          body: JSON.stringify(updated),
        });
      }
      if (state.currentSlug === slug && (state.currentLocation ?? null) === (location ?? null)) {
        state.currentPage = await apiFetch(withLocation(`/pages/${slug}`, location));
        renderPage(state.currentPage);
      }
    } catch (err) {
      console.error('Failed to persist note checkbox changes on close:', err);
    }
  }

  let onKeyDown;
  function closeWindow() {
    isInEditMode = false;
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
    restoreFocus();
    if (!isNew && hasCheckboxChanges) {
      void persistCheckboxChanges();
    }
  }

  onKeyDown = createNoteKeyHandler({
    win,
    isInEditMode: () => isInEditMode,
    onCancelEdit: requestCancelEdit,
    onClose: closeWindow,
  });

  document.addEventListener('keydown', onKeyDown);

  if (initialMode === 'edit') {
    switchToEdit(false);
  } else {
    switchToView();
  }
}

/**
 * Open a full-page viewer/editor window for a note.
 *
 * @param {object}         item        - The item object (has `title` and `text` fields).
 * @param {number}         itemIndex   - Original index of this item in the group's items array.
 * @param {number}         groupIndex  - Index of the group in page.groups.
 * @param {string}         slug        - Page slug.
 * @param {'view'|'edit'}  initialMode - Whether to open in view or edit mode.
 */
export function openNoteWindow(item, itemIndex, groupIndex, slug, location = null, initialMode = 'view') {
  openGenericNoteWindow({
    isEncrypted: false,
    item,
    itemIndex,
    groupIndex,
    slug,
    location,
    initialMode,
  });
}

/**
 * Generic renderer for standard or encrypted note items in list view.
 */
function renderGenericNoteItem({ isEncrypted, item, itemIndex, groupIndex, slug, location = null }) {
  const li = document.createElement('li');
  li.className = isEncrypted ? 'item item--enc-note' : 'item item--note';

  let inlineOriginalText = isEncrypted ? (item.enc_text ?? '') : decodeNote(item.text ?? '');
  let inlineCurrentText = inlineOriginalText;
  let inlineHasCheckboxChanges = false;

  async function persistInlineChanges() {
    try {
      const payloadText = isEncrypted ? inlineCurrentText : encodeNote(inlineCurrentText);
      const updated = isEncrypted
        ? { title: item.title, enc_text: payloadText }
        : { title: item.title, text: payloadText };
      inlineOriginalText = inlineCurrentText;
      inlineHasCheckboxChanges = false;
      if (isEncrypted) {
        item.enc_text = payloadText;
      } else {
        item.text = payloadText;
      }
      if (state.currentPage?.groups?.[groupIndex]?.items?.[itemIndex]) {
        if (isEncrypted) {
          state.currentPage.groups[groupIndex].items[itemIndex].enc_text = payloadText;
        } else {
          state.currentPage.groups[groupIndex].items[itemIndex].text = payloadText;
        }
      }
      await apiFetch(withLocation(`/pages/${slug}/groups/${groupIndex}/items/${itemIndex}`, location), {
        method: 'PUT',
        body: JSON.stringify(updated),
      });
      if (state.currentSlug === slug && (state.currentLocation ?? null) === (location ?? null)) {
        state.currentPage = await apiFetch(withLocation(`/pages/${slug}`, location));
      }
    } catch (err) {
      console.error('Failed to persist inline note checkbox changes on close:', err);
    }
  }

  const isLocked = isEncrypted && item.locked === true;

  const noteHeader = document.createElement('div');
  noteHeader.className = 'item__note-header';

  const iconBtn = document.createElement('button');
  iconBtn.type = 'button';
  iconBtn.className = 'item__note-icon-btn item__type-icon';
  iconBtn.setAttribute('aria-expanded', 'false');

  if (isEncrypted) {
    iconBtn.setAttribute('aria-label', isLocked ? 'Vault locked' : 'Toggle encrypted note preview');
    iconBtn.title = isLocked ? 'Vault locked (click to unlock)' : 'Toggle encrypted note preview';
    iconBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px; ${isLocked ? 'color: var(--color-warning);' : ''}" aria-hidden="true">lock</span>`;
  } else {
    iconBtn.setAttribute('aria-label', 'Toggle note preview');
    iconBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">description</span>`;
  }

  const titleBtn = document.createElement('button');
  titleBtn.type = 'button';
  titleBtn.className = 'item__note-title-btn';
  titleBtn.innerHTML = `<span class="item__title-text">${item.title}</span>`;

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'item__note-edit';
  editBtn.setAttribute('aria-label', isEncrypted ? 'Edit encrypted note' : 'Edit note');
  editBtn.title = isEncrypted ? 'Edit encrypted note' : 'Edit note';
  editBtn.textContent = '✎';

  const handleOpenWindow = async (mode) => {
    if (isEncrypted && isLocked) {
      const unlocked = await promptUnlockVault(location);
      if (unlocked) {
        const freshItem = findDecryptedItem(groupIndex, itemIndex, item.title);
        if (freshItem) {
          openEncryptedNoteWindow(freshItem, itemIndex, groupIndex, slug, location, mode);
        }
      }
      return;
    }
    if (isEncrypted) {
      openEncryptedNoteWindow(item, itemIndex, groupIndex, slug, location, mode);
    } else {
      openNoteWindow(item, itemIndex, groupIndex, slug, location, mode);
    }
  };

  titleBtn.addEventListener('click', () => { void handleOpenWindow('view'); });
  editBtn.addEventListener('click', () => { void handleOpenWindow('edit'); });

  noteHeader.appendChild(iconBtn);
  noteHeader.appendChild(titleBtn);
  noteHeader.appendChild(editBtn);
  li.appendChild(noteHeader);

  const handleUnlockAndClick = async () => {
    const unlocked = await promptUnlockVault(location);
    if (unlocked) {
      const newLi = document.querySelector(`li.item--note-encrypted[data-group-index="${groupIndex}"][data-item-index="${itemIndex}"]`);
      newLi?.querySelector('.item__note-icon-btn')?.click();
    }
  };

  const collapsePreview = () => {
    iconBtn.setAttribute('aria-expanded', 'false');
    li.classList.remove('item--note-open');
    const body = li.querySelector('.item__note-body');
    if (body) body.hidden = true;
    if (inlineHasCheckboxChanges) {
      void persistInlineChanges();
    }
  };

  const createNoteBody = (currentText) => {
    const body = document.createElement('div');
    body.className = 'item__note-body';
    inlineOriginalText = currentText;
    inlineCurrentText = currentText;
    void renderMarkdownToElement(inlineCurrentText, body);
    li.appendChild(body);
    body.addEventListener('change', (e) => {
      if (!e.target.classList.contains('task-list-checkbox')) return;
      const checkboxes = Array.from(body.querySelectorAll('.task-list-checkbox'));
      const idx = checkboxes.indexOf(e.target);
      if (idx === -1) return;

      inlineCurrentText = updateMarkdownCheckbox(inlineCurrentText, idx, e.target.checked);
      inlineHasCheckboxChanges = (inlineCurrentText !== inlineOriginalText);
      if (isEncrypted) {
        item.enc_text = inlineCurrentText;
      } else {
        item.text = encodeNote(inlineCurrentText);
      }
    });
    return body;
  };

  const expandPreview = () => {
    iconBtn.setAttribute('aria-expanded', 'true');
    li.classList.add('item--note-open');

    const currentText = isEncrypted ? (item.enc_text ?? '') : decodeNote(item.text ?? '');
    const body = li.querySelector('.item__note-body');
    if (body) {
      body.hidden = false;
      if (currentText !== inlineCurrentText) {
        inlineOriginalText = currentText;
        inlineCurrentText = currentText;
        inlineHasCheckboxChanges = false;
        void renderMarkdownToElement(inlineCurrentText, body);
      }
    } else {
      createNoteBody(currentText);
    }
  };

  iconBtn.addEventListener('click', async () => {
    if (isEncrypted && isLocked) {
      await handleUnlockAndClick();
      return;
    }
    if (iconBtn.getAttribute('aria-expanded') === 'true') {
      collapsePreview();
    } else {
      expandPreview();
    }
  });

  return li;
}

/**
 * Build a `<li class="item item--note">` element for a note item.
 *
 * @param {object} item         - The item object (has `title` and `text` fields).
 * @param {number} itemIndex    - Original index of this item in the group's items array.
 * @param {number} groupIndex   - Index of the group in page.groups.
 * @param {string} slug         - Page slug.
 * @returns {HTMLLIElement}
 */
export function renderNoteItem(item, itemIndex, groupIndex, slug, location = null) {
  return renderGenericNoteItem({ isEncrypted: false, item, itemIndex, groupIndex, slug, location });
}

// ---------------------------------------------------------------------------
// Encrypted note item
// ---------------------------------------------------------------------------

function findDecryptedItem(groupIndex, itemIndex, title) {
  if (groupIndex == null) return null;
  const grp = state.currentPage?.groups?.[groupIndex];
  if (!grp?.items) return null;
  if (itemIndex != null && grp.items[itemIndex] && (grp.items[itemIndex].title === title || grp.items[itemIndex].enc_text !== undefined)) {
    return grp.items[itemIndex];
  }
  return grp.items.find(it => it.title === title && it.enc_text !== undefined) || (itemIndex != null ? grp.items[itemIndex] : null);
}

/**
 * Open a full-page viewer/editor window for an encrypted note.
 *
 * @param {object}        item        - Item object (has `title` and `enc_text` fields; enc_text is plaintext from API).
 * @param {number|null}   itemIndex   - Index in group.items, or null for new.
 * @param {number}        groupIndex  - Index in page.groups.
 * @param {string}        slug        - Page slug.
 * @param {string|null}   location    - Location name.
 * @param {'view'|'edit'} initialMode
 */
export function openEncryptedNoteWindow(item, itemIndex, groupIndex, slug, location = null, initialMode = 'view') {
  if (item?.locked) {
    void promptUnlockVault(location).then((unlocked) => {
      if (unlocked) {
        const freshItem = findDecryptedItem(groupIndex, itemIndex, item.title);
        if (freshItem) {
          openEncryptedNoteWindow(freshItem, itemIndex, groupIndex, slug, location, initialMode);
        }
      }
    });
    return;
  }

  openGenericNoteWindow({
    isEncrypted: true,
    item,
    itemIndex,
    groupIndex,
    slug,
    location,
    initialMode,
  });
}

/**
 * Build a `<li class="item item--enc-note">` element for an encrypted note item.
 *
 * @param {object} item         - Item object (has `title` and `enc_text` fields; enc_text is plaintext from API).
 * @param {number} itemIndex    - Original index in group.items.
 * @param {number} groupIndex   - Index in page.groups.
 * @param {string} slug         - Page slug.
 * @param {string|null} location
 * @returns {HTMLLIElement}
 */
export function renderEncryptedNoteItem(item, itemIndex, groupIndex, slug, location = null) {
  return renderGenericNoteItem({ isEncrypted: true, item, itemIndex, groupIndex, slug, location });
}


