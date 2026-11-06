// groupbox.js — Group box component
import { state, apiFetch, withLocation } from './app.js';
import { openModal } from './modal.js';
import { renderPage } from './content.js';
import { renderNoteItem, renderEncryptedNoteItem, openEncryptedNoteWindow } from './notes.js';
import { renderPasswordItem, openPasswordWindow } from './password.js';
import { renderTaskItem, openAddTaskModal } from './task.js';
import { canEncryptWorkspace, ensureVaultUnlocked, fetchVaultStatus } from './vault.js';

/** @type {HTMLUListElement|null} */
let _openMenu = null;

function closeOpenMenu() {
  if (_openMenu) {
    _openMenu.hidden = true;
    _openMenu = null;
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
    linkHeader.appendChild(editBtn);
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
      const values = await openModal({
        title: 'Add Note',
        fields: [
          { label: 'Title', name: 'title', type: 'text', help: 'e.g. My note', required: true },
          { label: 'Content (Markdown)', name: 'content', type: 'textarea', help: 'Markdown formatted content' },
        ],
        confirmLabel: 'Add',
      });
      if (!values) return;
      const bytes = new TextEncoder().encode(values.content ?? '');
      const encoded = btoa(Array.from(bytes, b => String.fromCodePoint(b)).join(''));
        await apiFetch(withLocation(`/pages/${slug}/groups/${groupIndex}/items`, location), {
          method: 'POST',
          body: JSON.stringify({ title: values.title, text: encoded }),
        });
        state.currentPage = await apiFetch(withLocation(`/pages/${slug}`, location));

      renderPage(state.currentPage);
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
// renderGroup
// ---------------------------------------------------------------------------

/**
 * @param {object} group
 * @param {number} groupIndex  - original index in page.groups
 * @param {string} slug
 * @returns {HTMLDivElement}
 */
export function renderGroup(group, groupIndex, slug, location = null) {
  const card = document.createElement('div');
  card.className = 'group-card';
  card.dataset.groupIndex = String(groupIndex);

  // -- Header --
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

  const menu = document.createElement('ul');
  menu.className = 'group-card__menu';
  menu.hidden = true;

  const populateMenu = () => {
    menu.innerHTML = '';
    const canEncrypt = canEncryptWorkspace(location);

    const menuItems = [
      { action: 'add-link', label: 'Add link', icon: 'open_in_new' },
      { action: 'add-note', label: 'Add note', icon: 'description' },
      ...(canEncrypt ? [{ action: 'add-enc-note', label: 'Add encrypted note', icon: 'lock' }] : []),
      { action: 'add-task', label: 'Add Task', icon: 'check' },
      ...(canEncrypt ? [{ action: 'add-password', label: 'Add password', icon: 'key' }] : []),
      { action: 'delete-items', label: 'Delete items', icon: 'delete' },
      { divider: true },
      { action: 'delete-box', label: 'Delete box', danger: true, icon: 'delete' },
    ];

    for (const def of menuItems) {
      const li = document.createElement('li');
      if (def.divider) {
        li.className = 'group-card__menu-divider';
      } else {
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
      }
      menu.appendChild(li);
    }
  };

  populateMenu();

  header.appendChild(dragHandle);
  header.appendChild(titleEl);
  header.appendChild(menuBtn);
  header.appendChild(menu);
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

  // -- Menu toggle --
  menuBtn.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = !menu.hidden;
    closeOpenMenu();
    if (!isOpen) {
      populateMenu();
      menu.hidden = false;
      _openMenu = menu;
      void fetchVaultStatus(location).then(() => {
        if (!menu.hidden && _openMenu === menu) {
          populateMenu();
        }
      });

      // Close when clicking outside
      const onOutside = ev => {
        if (!menu.contains(ev.target) && ev.target !== menuBtn) {
          closeOpenMenu();
          document.removeEventListener('click', onOutside);
        }
      };
      // Defer so this click doesn't immediately close it
      setTimeout(() => document.addEventListener('click', onOutside), 0);
    }
  });

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

  const doDeleteBox = async () => {
    const confirmed = await openModal({
      title: `Delete group "${group.title}"?`,
      fields: [],
      confirmLabel: 'Delete',
      isDanger: true,
    });
    if (!confirmed) return;
    await apiFetch(withLocation(`/pages/${slug}/groups/${groupIndex}`, location), { method: 'DELETE' });
    state.currentPage = await apiFetch(withLocation(`/pages/${slug}`, location));

    renderPage(state.currentPage);
  };

  // -- Menu actions --
  menu.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    closeOpenMenu();
    const handlers = { 'add-link': doAddLink, 'add-note': doAddNote, 'add-enc-note': doAddEncryptedNote, 'add-task': doAddTask, 'add-password': doAddPassword, 'delete-items': doDeleteItems, 'delete-box': doDeleteBox };
    handlers[btn.dataset.action]?.().catch(err => console.error('[ExoDeck] Action failed:', err));
  });

  return card;
}
