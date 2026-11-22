// content.js — Main content area
import { state, apiFetch, withLocation, refreshPages, isHelpWorkspace } from './app.js';
import { renderGroup, createNewStickyNoteCard } from './groupbox.js';
import { buildGroupHeightKey, getGroupOccurrenceIndex, migrateGroupMaxHeight, syncGridRowFloors } from './groupbox-resize.js';
import { renderNoteContent, cleanupActiveNoteEditor } from './note.js';
import { renderWhiteboardPage, unmountWhiteboard } from './whiteboard.js';
import { renderBpmnPage, unmountBpmn } from './bpmn.js';
import { isEditModeActive, enterEditMode, exitEditMode, reAttachIfActive } from './reorganize.js';
import { renderPageList, slugify, createPageActionMenu, updateSidebarVisibility, setHeaderBreadcrumbs } from './sidebar.js';
import { openConfirmModal } from './modal.js';
import { fetchVaultStatus, getVaultMenuAction } from './vault.js';

let editEscListener = null;
let titleEditEnterListener = null;

function detachEditEscListener() {
  if (editEscListener) {
    document.removeEventListener('keydown', editEscListener);
    editEscListener = null;
  }
}

function detachTitleEditEnterListener() {
  const titleEl2 = document.getElementById('pageTitle');
  if (titleEl2 && titleEditEnterListener) {
    titleEl2.removeEventListener('keydown', titleEditEnterListener);
  }
  titleEditEnterListener = null;
}

// ---------------------------------------------------------------------------
// Add Group modal
// ---------------------------------------------------------------------------

function clearGridFocus(grid) {
  grid.querySelectorAll('.group-card--focused').forEach(c => c.classList.remove('group-card--focused'));
  grid.querySelectorAll('.item--focused').forEach(i => i.classList.remove('item--focused'));
}

export function focusGridGroupCard(groupIndex) {
  const grid = document.getElementById('pageGrid');
  if (!grid || groupIndex == null) return;
  clearGridFocus(grid);
  const target = Array.from(grid.querySelectorAll('.group-card'))
    .find(c => c.dataset.groupIndex === String(groupIndex));
  if (!target) return;
  target.classList.add('group-card--focused');
  target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

export function startInlineGroupCreation(groupType = 'group') {
  if (isHelpWorkspace(state.currentLocation)) return;
  const grid = document.getElementById('pageGrid');
  if (!grid) return;
  const addControl = document.getElementById('gridAddGroup');

  clearGridFocus(grid);

  if (groupType === 'sticky') {
    const { card, focusTarget } = createNewStickyNoteCard(state.currentSlug, state.currentLocation);
    if (addControl) {
      addControl.replaceWith(card);
    } else {
      grid.appendChild(card);
    }
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    focusTarget.focus();
    return;
  }

  const card = document.createElement('div');
  card.className = 'group-card group-card--focused';

  const header = document.createElement('div');
  header.className = 'group-card__header';

  const titleEl = document.createElement('h2');
  titleEl.className = 'group-card__title group-card__title--editing';
  titleEl.setAttribute('contenteditable', 'plaintext-only');
  titleEl.style.outline = 'none';

  header.appendChild(titleEl);
  card.appendChild(header);

  if (addControl) {
    addControl.replaceWith(card);
  } else {
    grid.appendChild(card);
  }

  titleEl.focus();

  let isSaving = false;

  const cancel = () => {
    renderPage(state.currentPage);
  };

  const finish = async () => {
    if (isSaving) return;
    const name = titleEl.textContent.trim();
    if (!name) { cancel(); return; }

    isSaving = true;
    const slug = state.currentSlug;
    const newGroup = { title: name, items: [] };

    try {
      const res = await apiFetch(withLocation(`/pages/${slug}/groups`), {
        method: 'POST',
        body: JSON.stringify(newGroup),
      });
      const updated = await apiFetch(withLocation(`/pages/${slug}`));
      state.currentPage = updated;

      const newIndex = res?.group_index ?? (updated.groups?.length ? updated.groups.length - 1 : null);
      renderPage(state.currentPage);
      focusGridGroupCard(newIndex);
    } catch (err) {
      console.error(err);
      renderPage(state.currentPage);
    }
  };

  titleEl.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void finish();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      const name = titleEl.textContent.trim();
      if (name) {
        const discard = await openConfirmModal();
        if (!discard) {
          titleEl.focus();
          return;
        }
      }
      cancel();
    }
  });
}

// ---------------------------------------------------------------------------
// renderPage helpers
// ---------------------------------------------------------------------------

function saveGroupTitles(page) {
  let changed = false;
  document.querySelectorAll('.group-card:not(.group-card--add)').forEach(card => {
    const idx = Number(card.dataset.groupIndex);
    const groupTitleEl = card.querySelector('.group-card__title');
    if (!groupTitleEl) return;
    const newTitle = groupTitleEl.textContent.trim() || 'Untitled Group';
    const oldTitle = page.groups?.[idx]?.title;
    if (oldTitle !== newTitle && page.groups?.[idx]) {
      const occ = getGroupOccurrenceIndex(page.groups, idx);
      const oldKey = buildGroupHeightKey(state.currentLocation, state.currentSlug, oldTitle ?? '', occ);
      page.groups[idx].title = newTitle;
      const newOcc = getGroupOccurrenceIndex(page.groups, idx);
      migrateGroupMaxHeight(oldKey, buildGroupHeightKey(state.currentLocation, state.currentSlug, newTitle, newOcc));
      changed = true;
    }
    groupTitleEl.textContent = page.groups[idx].title;
    groupTitleEl.removeAttribute('contenteditable');
    groupTitleEl.classList.remove('group-card__title--editing');
  });
  return changed;
}

async function syncPageNameChange(titleEl2, slug, newSlug, newName) {
  await refreshPages();
  state.currentSlug = newSlug;
  renderPageList();
  titleEl2.textContent = newName;
}

async function saveTitleAndGroups(page) {
  const titleEl2 = document.getElementById('pageTitle');
  if (!titleEl2) return;
  titleEl2.removeAttribute('contenteditable');
  titleEl2.classList.remove('content__title--editing');

  const groupsChanged = saveGroupTitles(page);

  const newName = titleEl2.textContent.trim();
  const oldName = page['page-name'] ?? page.page_name ?? '';
  const isPageNameChanged = newName && newName !== oldName;

  if (!newName) titleEl2.textContent = oldName;
  if (!isPageNameChanged && !groupsChanged) return;

  const slug = state.currentSlug;
  const updatedPage = { ...page, 'page-name': newName || oldName, page_name: newName || oldName };
  const newSlug = isPageNameChanged ? slugify(newName) : slug;

    await apiFetch(withLocation(`/pages/${slug}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedPage),
    });

  state.currentPage = updatedPage;

  if (isPageNameChanged) {
    await syncPageNameChange(titleEl2, slug, newSlug, newName);
  }
}

function enterEditUI(editBtn) {
  const titleEl2 = document.getElementById('pageTitle');
  if (titleEl2) {
    titleEl2.setAttribute('contenteditable', 'plaintext-only');
    titleEl2.classList.add('content__title--editing');
    const range = document.createRange();
    const sel = globalThis.getSelection();
    range.selectNodeContents(titleEl2);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    titleEl2.focus();
    detachTitleEditEnterListener();
    titleEditEnterListener = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); editBtn.click(); }
    };
    titleEl2.addEventListener('keydown', titleEditEnterListener);
  }

  const groupCards = document.querySelectorAll('.group-card:not(.group-card--add)');
  groupCards.forEach(card => {
    const groupTitleEl = card.querySelector('.group-card__title');
    if (groupTitleEl) {
      groupTitleEl.setAttribute('contenteditable', 'plaintext-only');
      groupTitleEl.classList.add('group-card__title--editing');
      groupTitleEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); editBtn.click(); }
      });
    }
  });
}

function sortPageGroupsAlphabetically(page) {
  page.groups.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '', undefined, { sensitivity: 'base' }));
  for (const group of page.groups) {
    if (group.items) {
      group.items.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '', undefined, { sensitivity: 'base' }));
    }
  }
}

async function toggleCustomSort() {
  const willBeCustom = !(state.currentPage?.custom_sort ?? false);

  if (!willBeCustom) {
    const { showStyledConfirmModal } = await import('./app.js');
    const confirmed = await showStyledConfirmModal('Disable Custom Sort?', 'Are you sure you want to turn off custom sort? Your custom order will be lost when you reorganize or edit items.');
    if (!confirmed) return;
  }

  try {
    const slug = state.currentSlug;
    const location = state.currentLocation;
    const fullPage = await apiFetch(withLocation(`/pages/${encodeURIComponent(slug)}`, location));

    if (willBeCustom) {
      sortPageGroupsAlphabetically(fullPage);
    }

    fullPage.custom_sort = willBeCustom;

    await apiFetch(withLocation(`/pages/${encodeURIComponent(slug)}`, location), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fullPage),
    });

    const pageMeta = state.pages.find(p => p.slug === slug && (location ? p.location === location : true));
    if (pageMeta) pageMeta.custom_sort = willBeCustom;

    state.currentPage = fullPage;
    renderPage(state.currentPage);
  } catch (err) {
    console.error('Failed to toggle sort:', err);
  }
}

// ---------------------------------------------------------------------------
// renderPage
// ---------------------------------------------------------------------------

function setupPageActions(page) {
  const actionsEl = document.getElementById('contentActions');
  if (!actionsEl) return;

  actionsEl.innerHTML = '';
  if (isHelpWorkspace(state.currentLocation)) {
    detachEditEscListener();
    return;
  }

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'page-header__icon-btn';
  saveBtn.title = 'Save (Ctrl+S)';
  saveBtn.setAttribute('aria-label', 'Save changes');
  saveBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 20px; color: #4caf50;">check</span>';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'page-header__icon-btn';
  cancelBtn.title = 'Cancel (Esc)';
  cancelBtn.setAttribute('aria-label', 'Cancel editing');
  cancelBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 20px; color: #f44336;">close</span>';

  const isGridEditDirty = () => {
    const titleEl2 = document.getElementById('pageTitle');
    const oldName = page['page-name'] ?? page.page_name ?? '';
    if (titleEl2 && titleEl2.textContent.trim() !== oldName) return true;

    const cards = document.querySelectorAll('.group-card:not(.group-card--add)');
    for (const card of cards) {
      const idx = Number(card.dataset.groupIndex);
      const groupTitleEl = card.querySelector('.group-card__title');
      if (groupTitleEl) {
        const currentTitle = groupTitleEl.textContent.trim() || 'Untitled Group';
        const origTitle = page.groups?.[idx]?.title ?? '';
        if (currentTitle !== origTitle) return true;
      }
    }
    return false;
  };

  let isCancelling = false;

  const cancelEdit = async () => {
    if (!isEditModeActive() || isCancelling) return;
    isCancelling = true;
    try {
      if (isGridEditDirty()) {
        const discard = await openConfirmModal();
        if (!discard) return;
      }
      exitEditMode();
      detachEditEscListener();
      detachTitleEditEnterListener();
      const titleEl2 = document.getElementById('pageTitle');
      if (titleEl2) {
        titleEl2.removeAttribute('contenteditable');
        titleEl2.classList.remove('content__title--editing');
      }
      renderPage(state.currentPage);
    } finally {
      isCancelling = false;
    }
  };

  const onEditEscape = (e) => {
    if (!isEditModeActive() || e.key !== 'Escape') return;
    if (document.querySelector('.modal, .modal-overlay, .add-picker, .note-window-overlay, .keynav:not([hidden]), .group-card__menu:not([hidden])')) return;
    const floatingNav = document.getElementById('floatingNav');
    if (floatingNav && !floatingNav.hasAttribute('hidden')) return;
    const notifOverlay = document.getElementById('notificationOverlay');
    if (notifOverlay && !notifOverlay.hasAttribute('hidden')) return;
    e.preventDefault();
    e.stopPropagation();
    void cancelEdit();
  };

  const attachEditEscListener = () => {
    detachEditEscListener();
    editEscListener = onEditEscape;
    document.addEventListener('keydown', editEscListener);
  };

  const startEdit = () => {
    enterEditMode();
    renderActionBar();
    enterEditUI(saveBtn);
    attachEditEscListener();
  };

  const renderActionBar = () => {
    actionsEl.innerHTML = '';
    const editing = isEditModeActive();
    saveBtn.id = editing ? 'editPageBtn' : '';

    const menuBtn = createPageActionMenu(state.currentSlug, page['page-name'], undefined, state.currentLocation, true, {
      getHeaderItems: () => {
        const items = [];
        if (!isEditModeActive()) {
          items.push({
            id: 'editPageBtn',
            icon: 'edit',
            label: 'Edit',
            shortcut: 'e',
            title: 'Edit (e)',
            onClick: () => startEdit(),
          });
        }
        const isCustomSort = state.currentPage?.custom_sort ?? false;
        items.push({
          icon: isCustomSort ? 'view_list' : 'sort_by_alpha',
          label: isCustomSort ? 'Custom Sort: On' : 'Custom Sort: Off',
          title: isCustomSort ? 'Custom sort is ON (click to disable)' : 'Custom sort is OFF (click to enable)',
          onClick: () => { void toggleCustomSort(); },
        });
        const vaultAction = getVaultMenuAction(state.currentLocation);
        if (vaultAction) {
          items.push({
            icon: vaultAction.icon,
            iconColor: vaultAction.iconColor,
            label: vaultAction.label,
            title: vaultAction.title,
            onClick: vaultAction.onClick,
          });
        }
        return items;
      },
      refreshOnOpen: () => fetchVaultStatus(state.currentLocation),
    });

    if (editing) {
      actionsEl.appendChild(saveBtn);
      actionsEl.appendChild(cancelBtn);
    }
    actionsEl.appendChild(menuBtn);
  };

  cancelBtn.addEventListener('click', () => { void cancelEdit(); });

  saveBtn.addEventListener('click', async () => {
    if (!isEditModeActive()) return;
    detachTitleEditEnterListener();
    await saveTitleAndGroups(page);
    page = state.currentPage;
    exitEditMode();
    detachEditEscListener();
    renderActionBar();
  });

  detachEditEscListener();
  detachTitleEditEnterListener();
  if (isEditModeActive()) {
    attachEditEscListener();
  }

  renderActionBar();
}

function createAddGroupControl() {
  const wrap = document.createElement('div');
  wrap.className = 'grid-add-group';
  wrap.id = 'gridAddGroup';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn--circle grid-add-group__btn';
  addBtn.id = 'gridAddGroupBtn';
  addBtn.setAttribute('aria-label', 'Add group or sticky note');
  addBtn.title = 'Add Group or Sticky Note';
  addBtn.setAttribute('aria-expanded', 'false');
  addBtn.setAttribute('aria-haspopup', 'menu');
  addBtn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">add</span>';

  const menu = document.createElement('ul');
  menu.className = 'group-card__menu grid-add-group__menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;

  const options = [
    { action: 'add-group', label: 'Add Group', icon: 'folder' },
    { action: 'add-sticky', label: 'Add Sticky Note', icon: 'sticky_note' },
  ];

  const menuButtons = [];
  for (const opt of options) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.dataset.action = opt.action;
    btn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px; margin-right: 6px; vertical-align: bottom;" aria-hidden="true">${opt.icon}</span>${opt.label}`;
    li.appendChild(btn);
    menu.appendChild(li);
    menuButtons.push(btn);
  }

  let focusedIdx = 0;
  const focusMenuItem = (idx) => {
    if (menuButtons.length === 0) return;
    focusedIdx = ((idx % menuButtons.length) + menuButtons.length) % menuButtons.length;
    menuButtons[focusedIdx].focus();
  };

  const closeMenu = () => {
    menu.hidden = true;
    addBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onOutsideClick);
    document.removeEventListener('keydown', onMenuKeyDown, true);
  };

  function onOutsideClick(e) {
    if (!wrap.isConnected || !wrap.contains(e.target)) {
      closeMenu();
    }
  }

  function onMenuKeyDown(e) {
    if (!wrap.isConnected) {
      closeMenu();
      return;
    }
    if (menu.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      addBtn.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      focusMenuItem(menuButtons.includes(document.activeElement) ? focusedIdx + 1 : 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      focusMenuItem(menuButtons.includes(document.activeElement) ? focusedIdx - 1 : menuButtons.length - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      e.stopPropagation();
      focusMenuItem(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      focusMenuItem(menuButtons.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (menuButtons.includes(document.activeElement)) {
        e.preventDefault();
        e.stopPropagation();
        document.activeElement.click();
      }
    } else if (e.key === 'Tab') {
      closeMenu();
    }
  }

  menuButtons.forEach((btn, i) => {
    btn.addEventListener('mouseenter', () => {
      focusedIdx = i;
      btn.focus();
    });
  });

  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!menu.hidden) {
      closeMenu();
      return;
    }
    menu.hidden = false;
    addBtn.setAttribute('aria-expanded', 'true');
    focusMenuItem(0);
    setTimeout(() => {
      document.addEventListener('click', onOutsideClick);
      document.addEventListener('keydown', onMenuKeyDown, true);
    }, 0);
  });

  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.stopPropagation();
    closeMenu();
    startInlineGroupCreation(btn.dataset.action === 'add-sticky' ? 'sticky' : 'group');
  });

  wrap.appendChild(addBtn);
  wrap.appendChild(menu);
  return wrap;
}

function renderGroupCards(grid, groups) {
  if (groups.length === 0) return;

  let sorted = groups.map((group, originalIndex) => ({ group, originalIndex }));
  if (!state.currentPage.custom_sort) {
    sorted = sorted.sort((a, b) =>
      (a.group.title ?? '').localeCompare(b.group.title ?? '', undefined, { sensitivity: 'base' })
    );
  }

  for (const { group, originalIndex } of sorted) {
    const el = renderGroup(group, originalIndex, state.currentSlug, state.currentLocation);
    if (el) grid.appendChild(el);
  }
}

function restoreGridFocus(grid, { savedGroupIndex, savedItemIndex }) {
  if (savedGroupIndex === null) return;
  const allCards = grid.querySelectorAll('.group-card');
  const cardToFocus = Array.from(allCards).find(c => c.dataset.groupIndex === savedGroupIndex) ?? null;

  if (!cardToFocus) return;

  cardToFocus.classList.add('group-card--focused');
  if (savedItemIndex !== null) {
    const items = cardToFocus.querySelectorAll('.item');
    const targetItem = Array.from(items).find(i => i.dataset.itemIndex === savedItemIndex);
    if (targetItem) targetItem.classList.add('item--focused');
  }
}

function renderPageGrid(page) {
  const grid = document.getElementById('pageGrid');
  if (!grid) return;

  const focusedCard = grid.querySelector('.group-card--focused');
  const savedGroupIndex = focusedCard?.dataset.groupIndex ?? null;
  const focusedItem = grid.querySelector('.item--focused');
  const savedItemIndex = focusedItem?.dataset.itemIndex ?? null;

  grid.innerHTML = '';

  renderGroupCards(grid, page.groups ?? []);

  if (!isHelpWorkspace(state.currentLocation)) {
    grid.appendChild(createAddGroupControl());
  }

  syncGridRowFloors(grid);
  restoreGridFocus(grid, { savedGroupIndex, savedItemIndex });
}

export function renderPage(page) {
  cleanupActiveNoteEditor();
  state.activeGridNote = null;
  setHeaderBreadcrumbs(null);
  updateSidebarVisibility(page.page_type);

  // Whiteboard pages have their own renderer
  if (page.page_type === 'whiteboard') {
    detachEditEscListener();
    if (isEditModeActive()) exitEditMode();
    unmountBpmn();
    document.getElementById('content')?.classList.remove('content--bpmn');
    void renderWhiteboardPage(page, state.currentSlug, state.currentLocation);
    return;
  }

  // Unmount any active Excalidraw instance when navigating away
  unmountWhiteboard();
  document.getElementById('content')?.classList.remove('content--whiteboard');

  // Business Process pages have their own renderer
  if (page.page_type === 'bpmn') {
    detachEditEscListener();
    if (isEditModeActive()) exitEditMode();
    void renderBpmnPage(page, state.currentSlug, state.currentLocation);
    return;
  }

  // Unmount any active bpmn-js instance when navigating away
  unmountBpmn();
  document.getElementById('content')?.classList.remove('content--bpmn');

  // Note pages have their own renderer
  if (page.page_type === 'note') {
    detachEditEscListener();
    if (isEditModeActive()) exitEditMode();
    renderNoteContent(page);
    return;
  }

  // Remove note-specific layout class if navigating away from a note
  document.getElementById('content')?.classList.remove('content--markdown');
  document.getElementById('content')?.classList.remove('content--editing');

  // 1. Page title
  const titleEl = document.getElementById('pageTitle');
  if (titleEl) titleEl.textContent = page['page-name'] ?? page.page_name ?? '';

  // 2. Setup actions
  setupPageActions(page);

  // 3. Clear and render grid
  renderPageGrid(page);

  reAttachIfActive();
}
