// notes.js — Note items component
import { state, apiFetch, withLocation, isHelpWorkspace } from './app.js';
import { renderMarkdownToElement, updateMarkdownCheckbox } from './markdown-utils.js';
import { promptUnlockVault, retryAfterVaultUnlock } from './vault.js';
import { decodeNote, encodeNote, openGridNoteView } from './note.js';

/**
 * Open a full-screen viewer/editor for a grid note.
 *
 * @param {object|null}    item        - The item object (has `title` and `text` fields), or null for new.
 * @param {number|null}    itemIndex   - Original index of this item in the group's items array, or null for new.
 * @param {number}         groupIndex  - Index of the group in page.groups.
 * @param {string}         slug        - Page slug.
 * @param {string|null}    location    - Workspace location name.
 * @param {'view'|'edit'}  initialMode - Whether to open in view or edit mode.
 */
export function openNoteWindow(item, itemIndex, groupIndex, slug, location = null, initialMode = 'view') {
  void openGridNoteView({
    item,
    itemIndex,
    groupIndex,
    slug,
    location,
    isEncrypted: false,
    initialMode,
  }).catch(console.error);
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
      await retryAfterVaultUnlock(location, () => apiFetch(
        withLocation(`/pages/${slug}/groups/${groupIndex}/items/${itemIndex}`, location),
        { method: 'PUT', body: JSON.stringify(updated) }
      ));
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
    if (inlineHasCheckboxChanges) {
      await persistInlineChanges();
    }
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

  const readOnly = isHelpWorkspace(location);

  titleBtn.addEventListener('click', () => { void handleOpenWindow('view'); });
  editBtn.addEventListener('click', () => { void handleOpenWindow('edit'); });

  noteHeader.appendChild(iconBtn);
  noteHeader.appendChild(titleBtn);
  if (!readOnly) {
    noteHeader.appendChild(editBtn);
  }
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
      if (readOnly) {
        e.target.checked = !e.target.checked;
        return;
      }
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

  void openGridNoteView({
    item,
    itemIndex,
    groupIndex,
    slug,
    location,
    isEncrypted: true,
    initialMode,
  }).catch(console.error);
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


