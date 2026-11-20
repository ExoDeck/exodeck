// groupbox.js — Group box component
import { state, apiFetch, withLocation, isHelpWorkspace } from './app.js';
import { openModal, openConfirmModal } from './modal.js';
import { renderPage } from './content.js';
import { renderMarkdownToElement, updateMarkdownCheckbox } from './markdown-utils.js';
import { renderNoteItem, renderEncryptedNoteItem, openNoteWindow, openEncryptedNoteWindow } from './notes.js';
import { renderPasswordItem, openPasswordWindow } from './password.js';
import { renderTaskItem, openAddTaskModal } from './task.js';
import { canEncryptWorkspace, ensureVaultUnlocked, fetchVaultStatus } from './vault.js';

export const STICKY_COLORS = [
  { id: 'yellow', label: 'Yellow' },
  { id: 'amber', label: 'Amber' },
  { id: 'orange', label: 'Orange' },
  { id: 'red', label: 'Red' },
  { id: 'rose', label: 'Rose' },
  { id: 'pink', label: 'Pink' },
  { id: 'purple', label: 'Purple' },
  { id: 'violet', label: 'Violet' },
  { id: 'indigo', label: 'Indigo' },
  { id: 'blue', label: 'Blue' },
  { id: 'sky', label: 'Sky' },
  { id: 'cyan', label: 'Cyan' },
  { id: 'teal', label: 'Teal' },
  { id: 'emerald', label: 'Emerald' },
  { id: 'green', label: 'Green' },
  { id: 'lime', label: 'Lime' },
];

/** @type {HTMLUListElement|null} */
let _openMenu = null;
/** @type {HTMLDivElement|null} */
let _openColorPicker = null;

function closeOpenMenu() {
  if (_openMenu) {
    _openMenu.hidden = true;
    _openMenu = null;
  }
  if (_openColorPicker) {
    _openColorPicker.hidden = true;
    _openColorPicker = null;
  }
}

// Close on Escape globally (registered once)
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeOpenMenu();
});

// ---------------------------------------------------------------------------
// Link edit helper
// ---------------------------------------------------------------------------

/**
 * Open a pre-filled modal to edit an existing link item.
 * @param {object} item
 * @param {number} itemIndex
 * @param {number} groupIndex
 * @param {string} slug
 * @param {Location|null} location
 */
async function openEditLinkModal(item, itemIndex, groupIndex, slug, location) {
  const formatDate = (iso) => iso ? new Date(iso).toLocaleString() : '';
  const fields = [
    {
      label: 'URL', name: 'url', type: 'url', help: 'e.g. https://example.com', required: true,
      value: item.url,
      onBlur: () => {
        const urlInput = document.getElementById('_modal_url');
        const titleInput = document.getElementById('_modal_title');
        if (!titleInput || titleInput.value.trim()) return;
        try {
          const hostname = new URL(urlInput.value.trim()).hostname.replace(/^www\./, '');
          if (hostname) titleInput.value = hostname.charAt(0).toUpperCase() + hostname.slice(1);
        } catch { /* invalid URL — leave title empty */ }
      },
    },
    { label: 'Title', name: 'title', type: 'text', help: 'e.g. Google', required: true, value: item.title },
    { label: 'Notes', name: 'notes', type: 'textarea', value: item.notes || '', rows: 4 },
  ];

  if (item.created_at) fields.push({ label: 'Created At', name: 'created_at', type: 'text', value: formatDate(item.created_at), readonly: true });
  if (item.modified_at) fields.push({ label: 'Modified At', name: 'modified_at', type: 'text', value: formatDate(item.modified_at), readonly: true });

  const values = await openModal({
    title: 'Edit Link',
    fields,
    confirmLabel: 'Save',
  });
  if (!values) return;
  const updated = { title: values.title, url: values.url, notes: values.notes || undefined };
    await apiFetch(withLocation(`/pages/${slug}/groups/${groupIndex}/items/${itemIndex}`, location), {
      method: 'PUT',
      body: JSON.stringify(updated),
    });
    state.currentPage = await apiFetch(withLocation(`/pages/${slug}`, location));

  renderPage(state.currentPage);
}

// ---------------------------------------------------------------------------
// Item rendering helpers
// ---------------------------------------------------------------------------

/**
 * Build a single `<li>` for a link or note item.
 * @param {object} item
 * @param {number} originalIndex  - original index in the unsorted array
 * @param {number} groupIndex
 * @param {string} slug
 * @param {boolean} deleteMode
 * @returns {HTMLLIElement}
 */
function buildItemEl(item, originalIndex, groupIndex, slug, location, deleteMode) {
  const li = document.createElement('li');

  if (deleteMode) {
    li.className = 'item item--delete-mode';
    const label = document.createElement('label');
    label.className = 'item__delete-label';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'item__delete-cb';
    cb.dataset.index = String(originalIndex);

    const span = document.createElement('span');
    span.textContent = item.title;

    label.appendChild(cb);
    label.appendChild(span);
    li.appendChild(label);
    return li;
  }

  const itemDragHandle = document.createElement('span');
  itemDragHandle.className = 'item__drag-handle';
  itemDragHandle.setAttribute('aria-hidden', 'true');
  itemDragHandle.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;">drag_indicator</span>';

  if (item.password != null) {
    const el = renderPasswordItem(item, originalIndex, groupIndex, slug, location);
    el.dataset.itemIndex = String(originalIndex);
    el.dataset.groupIndex = String(groupIndex);
    el.prepend(itemDragHandle);
    return el;
  } else if (item.enc_text != null) {
    const el = renderEncryptedNoteItem(item, originalIndex, groupIndex, slug, location);
    el.dataset.itemIndex = String(originalIndex);
    el.dataset.groupIndex = String(groupIndex);
    el.prepend(itemDragHandle);
    return el;
  } else if (typeof item.task_checked === 'boolean') {
    const el = renderTaskItem(item, originalIndex, groupIndex, slug, location);
    el.dataset.itemIndex = String(originalIndex);
    el.dataset.groupIndex = String(groupIndex);
    el.prepend(itemDragHandle);
    return el;
  } else if (item.url) {
    li.className = 'item item--link';
    li.dataset.itemIndex = String(originalIndex);
    li.dataset.groupIndex = String(groupIndex);
    li.appendChild(itemDragHandle);

    const linkHeader = document.createElement('div');
    linkHeader.className = 'item__link-header';

    const a = document.createElement('a');
    a.href = item.url;
    const internalTarget = resolveInternalLinkTarget(item.url);
    if (internalTarget) {
      a.target = '_self';
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          const sidebar = await import('./sidebar.js');
          await sidebar.loadPage(internalTarget.slug, internalTarget.location, 'push');
        } catch (err) {
          console.error('[ExoDeck] Failed to route internal grid link:', err);
          window.location.assign(internalTarget.path);
        }
      });
    } else {
      a.target = '_blank';
      a.rel = 'noopener';
    }
    a.innerHTML = `<span class="item__type-icon"><span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">open_in_new</span></span><span class="item__title-text">${item.title}</span>`;

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'item__link-edit';
    editBtn.setAttribute('aria-label', 'Edit link');
    editBtn.title = 'Edit link';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', () => {
      openEditLinkModal(item, originalIndex, groupIndex, slug, location).catch(console.error);
    });

    linkHeader.appendChild(a);
    if (!isHelpWorkspace(location)) {
      linkHeader.appendChild(editBtn);
    }
    li.appendChild(linkHeader);
  } else {
    // Note item
    const el = renderNoteItem(item, originalIndex, groupIndex, slug, location);
    el.dataset.itemIndex = String(originalIndex);
    el.dataset.groupIndex = String(groupIndex);
    el.prepend(itemDragHandle);
    return el;
  }

  return li;
}

function isExternalHref(href) {
  return /^(mailto:|tel:|data:|javascript:)/i.test(href);
}

function resolveInternalLinkTarget(rawHref) {
  if (!rawHref || typeof rawHref !== 'string' || rawHref.startsWith('#') || isExternalHref(rawHref)) {
    return null;
  }

  let path = rawHref.trim();
  if (!path) return null;

  if (/^https?:\/\//i.test(path)) {
    try {
      const parsed = new URL(path);
      if (parsed.origin !== window.location.origin) return null;
      path = parsed.pathname;
    } catch {
      return null;
    }
  }

  if (!path.startsWith('/')) {
    path = `/${path}`;
  }

  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  if (segments.length >= 2) {
    const location = segments[0];
    const slug = segments[1];
    const exists = state.pages.some(p => p.location === location && p.slug === slug);
    if (!exists) return null;
    return { location, slug, path: `/${location}/${slug}` };
  }

  const slug = segments[0];
  const preferred = state.pages.find(p => p.slug === slug && p.location === state.currentLocation)
    ?? state.pages.find(p => p.slug === slug);
  if (!preferred) return null;
  return { location: preferred.location ?? null, slug: preferred.slug, path: `/${preferred.slug}` };
}

// ---------------------------------------------------------------------------
// addItemToGroup — exported for use by the keyboard shortcut handler
// ---------------------------------------------------------------------------

/**
 * Add an item of the given type to the specified group on the current page.
 * @param {'link'|'note'|'task'|'password'|'enc_note'} type
 * @param {number} groupIndex
 * @param {string} slug
 * @param {string|null} location
 */
export async function addItemToGroup(type, groupIndex, slug, location) {
  switch (type) {
    case 'link': {
      const values = await openModal({
        title: 'Add Link',
        fields: [
          {
            label: 'URL', name: 'url', type: 'url', help: 'e.g. https://example.com', required: true,
            onBlur: () => {
              const urlInput = document.getElementById('_modal_url');
              const titleInput = document.getElementById('_modal_title');
              if (!titleInput || titleInput.value.trim()) return;
              try {
                // Check if the URL points to an internal page
                let urlPath = urlInput.value.trim();
                if (urlPath.startsWith(window.location.origin)) {
                  urlPath = urlPath.slice(window.location.origin.length);
                }
                if (urlPath.startsWith('/')) {
                  const segments = urlPath.split('/').filter(Boolean);
                  let matchedPage = null;
                  if (segments.length === 2) {
                    matchedPage = state.pages.find(p => p.location === segments[0] && p.slug === segments[1]);
                  } else if (segments.length === 1) {
                    matchedPage = state.pages.find(p => p.slug === segments[0]);
                  }
                  if (matchedPage) {
                    titleInput.value = matchedPage.page_name ?? matchedPage['page-name'] ?? '';
                    return;
                  }
                }
                const hostname = new URL(urlInput.value.trim()).hostname.replace(/^www\./, '');
                if (hostname) titleInput.value = hostname.charAt(0).toUpperCase() + hostname.slice(1);
              } catch { /* invalid URL — leave title empty */ }
            },
          },
          { label: 'Title', name: 'title', type: 'text', help: 'e.g. Google', required: true },
          { label: 'Notes', name: 'notes', type: 'textarea', rows: 4 },
        ],
        confirmLabel: 'Add',
      });
      if (!values) return;
      await apiFetch(withLocation(`/pages/${slug}/groups/${groupIndex}/items`, location), {
        method: 'POST',
        body: JSON.stringify({ title: values.title, url: values.url, notes: values.notes || undefined }),
      });
      state.currentPage = await apiFetch(withLocation(`/pages/${slug}`, location));

      renderPage(state.currentPage);
      break;
    }
    case 'note': {
      openNoteWindow(null, null, groupIndex, slug, location, 'edit');
      break;
    }
    case 'task': {
      openAddTaskModal(async (values) => {
        const bytes = new TextEncoder().encode(values.description ?? '');
        const encoded = values.description?.trim()
          ? btoa(Array.from(bytes, b => String.fromCodePoint(b)).join(''))
          : undefined;
        const newItem = {
          title: values.title,
          task_checked: false,
          task_created: new Date().toISOString(),
          ...(encoded !== undefined && { text: encoded }),
          ...(values.due_date && { task_due_date: values.due_date }),
        };
          await apiFetch(withLocation(`/pages/${slug}/groups/${groupIndex}/items`, location), {
            method: 'POST',
            body: JSON.stringify(newItem),
          });
          state.currentPage = await apiFetch(withLocation(`/pages/${slug}`, location));

        renderPage(state.currentPage);
      });
      break;
    }
    case 'password': {
      const ok = await ensureVaultUnlocked(location);
      if (!ok) return;
      openPasswordWindow(null, null, groupIndex, slug, location, 'edit');
      break;
    }
    case 'enc_note': {
      const ok = await ensureVaultUnlocked(location);
      if (!ok) return;
      openEncryptedNoteWindow(null, null, groupIndex, slug, location, 'edit');
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Shared Group Header / Menu / Delete helpers
// ---------------------------------------------------------------------------

function buildMenuOptionElement(def) {
  const li = document.createElement('li');
  if (def.divider) {
    li.className = 'group-card__menu-divider';
    return li;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.action = def.action;
  if (def.icon) {
    btn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px; margin-right: 6px; vertical-align: bottom;" aria-hidden="true">${def.icon}</span>${def.label}`;
  } else {
    btn.textContent = def.label;
  }
  if (def.danger) btn.classList.add('danger');
  li.appendChild(btn);
  return li;
}

function buildGroupHeader(group, getMenuItems, readOnly = false) {
  const header = document.createElement('div');
  header.className = 'group-card__header';

  const dragHandle = document.createElement('button');
  dragHandle.type = 'button';
  dragHandle.className = 'group-card__drag-handle';
  dragHandle.setAttribute('aria-label', 'Drag to move group');
  dragHandle.setAttribute('aria-hidden', 'true');
  dragHandle.innerHTML = '<span class="material-symbols-outlined" style="font-size: 20px;">drag_indicator</span>';

  const titleEl = document.createElement('h2');
  titleEl.className = 'group-card__title';
  titleEl.textContent = group.title ?? '';

  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'group-card__menu-btn';
  menuBtn.setAttribute('aria-label', 'Group menu');
  menuBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 20px;">more_horiz</span>';

  if (readOnly) {
    dragHandle.hidden = true;
    menuBtn.hidden = true;
  }

  const menu = document.createElement('ul');
  menu.className = 'group-card__menu';
  menu.hidden = true;

  const populateMenu = () => {
    menu.innerHTML = '';
    for (const def of getMenuItems()) {
      menu.appendChild(buildMenuOptionElement(def));
    }
  };

  populateMenu();

  header.appendChild(dragHandle);
  header.appendChild(titleEl);
  header.appendChild(menuBtn);
  header.appendChild(menu);

  return { header, titleEl, menuBtn, menu, populateMenu };
}

function attachOutsideCloseListener(popoverEl, triggerEl) {
  const onOutside = ev => {
    if (!popoverEl.contains(ev.target) && ev.target !== triggerEl) {
      closeOpenMenu();
      document.removeEventListener('click', onOutside);
    }
  };
  setTimeout(() => document.addEventListener('click', onOutside), 0);
}

function attachHeaderMenuToggle(menuBtn, menu, populateMenu, onMenuOpen = null) {
  menuBtn.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = !menu.hidden;
    closeOpenMenu();
    if (!isOpen) {
      populateMenu();
      menu.hidden = false;
      _openMenu = menu;
      onMenuOpen?.();
      attachOutsideCloseListener(menu, menuBtn);
    }
  });
}

export async function deleteGroupBox(group, groupIndex, slug, location) {
  if (!group || isHelpWorkspace(location)) return;
  const isSticky = group.type === 'sticky';
  const label = isSticky ? 'sticky note' : 'group';
  const titleText = group.title ? `"${group.title}"` : `this ${label}`;
  const confirmed = await openConfirmModal({
    title: `Delete ${label} ${titleText}?`,
    message: isSticky
      ? 'Are you sure you want to permanently delete this sticky note?'
      : 'Are you sure you want to permanently delete this group and all its items?',
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
    isDanger: true,
  });
  if (!confirmed) return;
  await apiFetch(withLocation(`/pages/${slug}/groups/${groupIndex}`, location), { method: 'DELETE' });
  state.currentPage = await apiFetch(withLocation(`/pages/${slug}`, location));
  renderPage(state.currentPage);
}

// ---------------------------------------------------------------------------
// Sticky Note Group helpers & renderer
// ---------------------------------------------------------------------------

async function persistStickyGroupUpdate(groupIndex, slug, location, payload) {
  await apiFetch(withLocation(`/pages/${slug}/groups/${groupIndex}`, location), {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  state.currentPage = await apiFetch(withLocation(`/pages/${slug}`, location));
}

function buildStickyColorPicker(getCurrentColor, onSelectColor, defaultColor = 'yellow') {
  const picker = document.createElement('div');
  picker.className = 'group-card__color-picker';
  picker.setAttribute('role', 'grid');
  picker.setAttribute('aria-label', 'Color picker');
  picker.hidden = true;

  const noneSwatch = document.createElement('button');
  noneSwatch.type = 'button';
  noneSwatch.className = 'group-card__color-swatch group-card__color-swatch--none';
  noneSwatch.dataset.color = 'none';
  noneSwatch.title = 'No fill';
  noneSwatch.setAttribute('aria-label', 'No fill');
  noneSwatch.innerHTML = '<span class="material-symbols-outlined" style="font-size: 14px;" aria-hidden="true">format_color_reset</span><span>No fill</span>';
  noneSwatch.addEventListener('click', e => {
    e.stopPropagation();
    closeOpenMenu();
    void onSelectColor('none');
  });
  picker.appendChild(noneSwatch);

  for (const c of STICKY_COLORS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'group-card__color-swatch';
    swatch.dataset.color = c.id;
    swatch.title = c.label;
    swatch.setAttribute('aria-label', c.label);
    swatch.addEventListener('click', e => {
      e.stopPropagation();
      closeOpenMenu();
      void onSelectColor(c.id);
    });
    picker.appendChild(swatch);
  }

  const syncActiveSwatch = () => {
    const activeColor = getCurrentColor() || defaultColor;
    picker.querySelectorAll('.group-card__color-swatch').forEach(btn => {
      btn.classList.toggle('group-card__color-swatch--active', btn.dataset.color === activeColor);
    });
  };

  return { picker, syncActiveSwatch };
}

function buildStickyEditor({ card, initialTitle, initialText, fallbackTitle = 'Sticky Note', header, menuBtn, titleEl, onSave, onCancel }) {
  titleEl.setAttribute('contenteditable', 'plaintext-only');
  titleEl.classList.add('group-card__title--editing');

  if (menuBtn) {
    menuBtn.hidden = true;
  }

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'page-header__icon-btn group-card__sticky-action-btn';
  saveBtn.title = 'Save (Ctrl+S)';
  saveBtn.setAttribute('aria-label', 'Save sticky note');
  saveBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 20px; color: #4caf50;">check</span>';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'page-header__icon-btn group-card__sticky-action-btn';
  cancelBtn.title = 'Cancel (Esc)';
  cancelBtn.setAttribute('aria-label', 'Cancel editing');
  cancelBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 20px; color: #f44336;">close</span>';

  header?.appendChild(saveBtn);
  header?.appendChild(cancelBtn);

  const editorWrap = document.createElement('div');
  editorWrap.className = 'group-card__sticky-editor';

  const textarea = document.createElement('textarea');
  textarea.className = 'group-card__sticky-textarea';
  textarea.rows = 6;
  textarea.value = initialText;

  editorWrap.appendChild(textarea);

  let isSaving = false;

  const isBlockingOverlayOpen = () => Boolean(
    document.querySelector('.modal, .modal-overlay, .add-picker, .note-window-overlay, .keynav:not([hidden])')
  );

  const cycleStickyFocus = (e) => {
    const focusOrder = [titleEl, textarea, saveBtn, cancelBtn].filter(
      el => el && !el.disabled && !el.hidden && el.isConnected
    );
    if (focusOrder.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const idx = focusOrder.indexOf(document.activeElement);
    if (idx === -1) {
      (e.shiftKey ? focusOrder.at(-1) : focusOrder[0])?.focus();
      return;
    }
    const nextIdx = (idx + (e.shiftKey ? -1 : 1) + focusOrder.length) % focusOrder.length;
    focusOrder[nextIdx]?.focus();
  };

  function cleanup() {
    document.removeEventListener('keydown', onDocKeydown);
  }

  const triggerSave = async () => {
    if (isSaving) return;
    isSaving = true;
    saveBtn.disabled = true;
    const newTitle = titleEl.textContent.trim() || fallbackTitle;
    try {
      await onSave(newTitle, textarea.value);
      cleanup();
    } catch (err) {
      isSaving = false;
      saveBtn.disabled = false;
      console.error('[ExoDeck] Save sticky note failed:', err);
    }
  };

  const triggerCancel = async () => {
    if (isSaving) return;
    const isDirty = titleEl.textContent.trim() !== initialTitle || textarea.value !== initialText;
    if (isDirty) {
      const activeBeforeModal = document.activeElement;
      const discard = await openConfirmModal();
      if (!discard) {
        if (activeBeforeModal === titleEl || activeBeforeModal === textarea) {
          activeBeforeModal.focus();
        } else {
          textarea.focus();
        }
        return;
      }
    }
    cleanup();
    onCancel();
  };

  const handleStickyKeydown = (e) => {
    if (e.key === 'Tab') {
      cycleStickyFocus(e);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      e.stopPropagation();
      void triggerSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      void triggerCancel();
    }
  };

  function onDocKeydown(e) {
    if (!card?.isConnected) {
      cleanup();
      return;
    }
    if (isBlockingOverlayOpen()) return;
    handleStickyKeydown(e);
  }

  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      textarea.focus();
    }
  });
  card?.addEventListener('keydown', (e) => {
    if (!isBlockingOverlayOpen()) {
      handleStickyKeydown(e);
    }
  });
  document.addEventListener('keydown', onDocKeydown);
  saveBtn.addEventListener('click', () => { void triggerSave(); });
  cancelBtn.addEventListener('click', () => { void triggerCancel(); });

  return { editorWrap, textarea };
}

function renderStickyGroup(group, groupIndex, slug, location = null) {
  const readOnly = isHelpWorkspace(location);
  const card = document.createElement('div');
  card.className = 'group-card group-card--sticky';
  card.dataset.groupIndex = String(groupIndex);
  card.dataset.stickyColor = group.color || 'yellow';

  const getMenuItems = () => [
    { action: 'edit-sticky', label: 'Edit', icon: 'edit' },
    { action: 'change-color', label: 'Change color', icon: 'palette' },
    { divider: true },
    { action: 'delete-box', label: 'Delete box', danger: true, icon: 'delete' },
  ];

  const { header, titleEl, menuBtn, menu, populateMenu } = buildGroupHeader(group, getMenuItems, readOnly);

  const { picker: colorPicker, syncActiveSwatch } = buildStickyColorPicker(
    () => group.color || 'yellow',
    async (colorId) => {
      const prevColor = group.color || 'yellow';
      group.color = colorId;
      card.dataset.stickyColor = colorId;
      try {
        await persistStickyGroupUpdate(groupIndex, slug, location, {
          ...group,
          type: 'sticky',
          color: colorId,
          items: group.items ?? [],
        });
      } catch (err) {
        group.color = prevColor;
        card.dataset.stickyColor = prevColor;
        console.error('[ExoDeck] Change sticky color failed:', err);
      }
    },
    'yellow'
  );
  if (!readOnly) {
    header.appendChild(colorPicker);
  }
  card.appendChild(header);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'group-card__sticky-body markdown-body';
  void renderMarkdownToElement(group.text ?? '', bodyEl);

  bodyEl.addEventListener('change', (e) => {
    if (!e.target.classList.contains('task-list-checkbox')) return;
    if (readOnly) {
      e.target.checked = !e.target.checked;
      return;
    }
    const checkboxes = Array.from(bodyEl.querySelectorAll('.task-list-checkbox'));
    const idx = checkboxes.indexOf(e.target);
    if (idx === -1) return;

    const prevText = group.text ?? '';
    const nextText = updateMarkdownCheckbox(prevText, idx, e.target.checked);
    group.text = nextText;
    void persistStickyGroupUpdate(groupIndex, slug, location, {
      ...group,
      type: 'sticky',
      text: nextText,
      color: group.color || 'yellow',
      items: group.items ?? [],
    }).catch(err => {
      group.text = prevText;
      e.target.checked = !e.target.checked;
      console.error('[ExoDeck] Update sticky checkbox failed:', err);
    });
  });

  card.appendChild(bodyEl);

  const enterStickyEditMode = () => {
    if (card.classList.contains('group-card--sticky-editing')) return;
    card.classList.add('group-card--sticky-editing');
    bodyEl.hidden = true;

    const { editorWrap, textarea } = buildStickyEditor({
      card,
      initialTitle: group.title ?? '',
      initialText: group.text ?? '',
      fallbackTitle: 'Sticky Note',
      header,
      menuBtn,
      titleEl,
      onSave: async (newTitle, newText) => {
        await persistStickyGroupUpdate(groupIndex, slug, location, {
          ...group,
          title: newTitle,
          type: 'sticky',
          text: newText,
          color: group.color || 'yellow',
          items: group.items ?? [],
        });
        renderPage(state.currentPage);
      },
      onCancel: () => renderPage(state.currentPage),
    });

    card.appendChild(editorWrap);
    textarea.focus();
    const len = textarea.value.length;
    textarea.setSelectionRange(len, len);
  };

  if (!readOnly) {
    attachHeaderMenuToggle(menuBtn, menu, populateMenu);
    card.addEventListener('exodeck:edit-sticky', () => {
      closeOpenMenu();
      enterStickyEditMode();
    });
  }

  menu.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.stopPropagation();
    closeOpenMenu();
    const action = btn.dataset.action;
    if (action === 'edit-sticky') {
      enterStickyEditMode();
    } else if (action === 'change-color') {
      syncActiveSwatch();
      colorPicker.hidden = false;
      _openColorPicker = colorPicker;
      attachOutsideCloseListener(colorPicker, menuBtn);
    } else if (action === 'delete-box') {
      void deleteGroupBox(group, groupIndex, slug, location).catch(err => {
        console.error('[ExoDeck] Action failed:', err);
      });
    }
  });

  return card;
}

/**
 * Build an inline sticky-note creation card ready to be inserted into `#pageGrid`.
 * @param {string} slug
 * @param {string|null} [location]
 * @returns {{ card: HTMLDivElement, focusTarget: HTMLElement }}
 */
export function createNewStickyNoteCard(slug, location = null) {
  const card = document.createElement('div');
  card.className = 'group-card group-card--sticky group-card--sticky-editing group-card--focused';
  card.dataset.stickyColor = 'yellow';

  const header = document.createElement('div');
  header.className = 'group-card__header';

  const titleEl = document.createElement('h2');
  titleEl.className = 'group-card__title';
  titleEl.textContent = '';
  header.appendChild(titleEl);
  card.appendChild(header);

  const { editorWrap } = buildStickyEditor({
    card,
    initialTitle: '',
    initialText: '',
    fallbackTitle: 'Sticky Note',
    header,
    titleEl,
    onSave: async (newTitle, newText) => {
      await apiFetch(withLocation(`/pages/${slug}/groups`, location), {
        method: 'POST',
        body: JSON.stringify({
          title: newTitle,
          type: 'sticky',
          text: newText,
          color: 'yellow',
          items: [],
        }),
      });
      state.currentPage = await apiFetch(withLocation(`/pages/${slug}`, location));
      renderPage(state.currentPage);
    },
    onCancel: () => renderPage(state.currentPage),
  });

  card.appendChild(editorWrap);
  return { card, focusTarget: titleEl };
}

// ---------------------------------------------------------------------------
// renderGroup
// ---------------------------------------------------------------------------

/**
 * @param {object} group
 * @param {number} groupIndex  - original index in page.groups
 * @param {string} slug
 * @returns {HTMLDivElement}
 */
export function renderGroup(group, groupIndex, slug, location = null) {
  if (group.type === 'sticky') {
    return renderStickyGroup(group, groupIndex, slug, location);
  }

  const readOnly = isHelpWorkspace(location);
  const card = document.createElement('div');
  card.className = 'group-card';
  card.dataset.groupIndex = String(groupIndex);
  card.dataset.stickyColor = group.color || 'none';

  const getMenuItems = () => {
    const canEncrypt = canEncryptWorkspace(location);
    return [
      { action: 'add-link', label: 'Add link', icon: 'open_in_new' },
      { action: 'add-note', label: 'Add note', icon: 'description' },
      ...(canEncrypt ? [{ action: 'add-enc-note', label: 'Add encrypted note', icon: 'lock' }] : []),
      { action: 'add-task', label: 'Add Task', icon: 'check' },
      ...(canEncrypt ? [{ action: 'add-password', label: 'Add password', icon: 'key' }] : []),
      { action: 'delete-items', label: 'Delete items', icon: 'delete' },
      { action: 'change-color', label: 'Change color', icon: 'palette' },
      { divider: true },
      { action: 'delete-box', label: 'Delete box', danger: true, icon: 'delete' },
    ];
  };

  const { header, menuBtn, menu, populateMenu } = buildGroupHeader(group, getMenuItems, readOnly);
  const { picker: colorPicker, syncActiveSwatch } = buildStickyColorPicker(
    () => group.color || 'none',
    async (colorId) => {
      const prevColor = group.color || 'none';
      group.color = colorId;
      card.dataset.stickyColor = colorId;
      try {
        await persistStickyGroupUpdate(groupIndex, slug, location, {
          ...group,
          color: colorId,
          items: group.items ?? [],
        });
      } catch (err) {
        group.color = prevColor;
        card.dataset.stickyColor = prevColor;
        console.error('[ExoDeck] Change group color failed:', err);
      }
    },
    'none'
  );
  if (!readOnly) {
    header.appendChild(colorPicker);
  }
  card.appendChild(header);

  // -- Item list --
  const itemList = document.createElement('ul');
  itemList.className = 'group-card__items';

  const items = group.items ?? [];

  // Build sorted view preserving original indices
  let sorted = items.map((item, i) => ({ item, originalIndex: i }));
  if (!state.currentPage.custom_sort) {
    sorted = sorted.sort((a, b) =>
      (a.item.title ?? '').localeCompare(b.item.title ?? '', undefined, { sensitivity: 'base' })
    );
  }

  const renderItems = (deleteMode = false) => {
    itemList.innerHTML = '';
    for (const { item, originalIndex } of sorted) {
      itemList.appendChild(buildItemEl(item, originalIndex, groupIndex, slug, location, deleteMode));
    }
  };

  renderItems();
  card.appendChild(itemList);

  if (!readOnly) {
    attachHeaderMenuToggle(menuBtn, menu, populateMenu, () => {
      void fetchVaultStatus(location).then(() => {
        if (!menu.hidden && _openMenu === menu) {
          populateMenu();
        }
      });
    });
  }

  // -- Menu action helpers --
  const doAddLink = () => addItemToGroup('link', groupIndex, slug, location);
  const doAddNote = () => addItemToGroup('note', groupIndex, slug, location);
  const doAddTask = () => addItemToGroup('task', groupIndex, slug, location);
  const doAddPassword = () => addItemToGroup('password', groupIndex, slug, location);
  const doAddEncryptedNote = () => addItemToGroup('enc_note', groupIndex, slug, location);

  const doDeleteItems = () => {
    renderItems(true);
    header.querySelectorAll('.group-card__delete-ctrl').forEach(el => el.remove());

    const confirmDel = document.createElement('button');
    confirmDel.type = 'button';
    confirmDel.className = 'btn btn--danger group-card__delete-ctrl';
    confirmDel.textContent = 'Confirm';

    const cancelDel = document.createElement('button');
    cancelDel.type = 'button';
    cancelDel.className = 'btn btn--ghost group-card__delete-ctrl';
    cancelDel.textContent = 'Cancel';

    header.appendChild(cancelDel);
    header.appendChild(confirmDel);

    const exitDeleteMode = () => { confirmDel.remove(); cancelDel.remove(); renderItems(false); };
    cancelDel.addEventListener('click', exitDeleteMode);
    confirmDel.addEventListener('click', () => applyDeleteItems(exitDeleteMode));
  };

  const applyDeleteItems = async (exitDeleteMode) => {
    const checked = /** @type {NodeListOf<HTMLInputElement>} */ (
      itemList.querySelectorAll('.item__delete-cb:checked')
    );
    const indicesToDelete = Array.from(checked)
      .map(cb => Number(cb.dataset.index))
      .sort((a, b) => b - a);
    try {
      for (const idx of indicesToDelete) {
        await apiFetch(withLocation(`/pages/${slug}/groups/${groupIndex}/items/${idx}`, location), { method: 'DELETE' });
      }
      state.currentPage = await apiFetch(withLocation(`/pages/${slug}`, location));

      renderPage(state.currentPage);
    } catch (err) {
      console.error('[ExoDeck] Delete items failed:', err);
      exitDeleteMode();
    }
  };

  const doDeleteBox = () => deleteGroupBox(group, groupIndex, slug, location);

  // -- Menu actions --
  menu.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.stopPropagation();
    closeOpenMenu();
    if (btn.dataset.action === 'change-color') {
      syncActiveSwatch();
      colorPicker.hidden = false;
      _openColorPicker = colorPicker;
      attachOutsideCloseListener(colorPicker, menuBtn);
      return;
    }
    const handlers = { 'add-link': doAddLink, 'add-note': doAddNote, 'add-enc-note': doAddEncryptedNote, 'add-task': doAddTask, 'add-password': doAddPassword, 'delete-items': doDeleteItems, 'delete-box': doDeleteBox };
    handlers[btn.dataset.action]?.().catch(err => console.error('[ExoDeck] Action failed:', err));
  });

  return card;
}
