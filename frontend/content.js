// content.js — Main content area
import { state, apiFetch, withLocation, refreshPages, isHelpWorkspace } from './app.js';
import { renderGroup } from './groupbox.js';
import { renderNoteContent } from './note.js';
import { renderWhiteboardPage, unmountWhiteboard } from './whiteboard.js';
import { renderBpmnPage, unmountBpmn } from './bpmn.js';
import { isEditModeActive, enterEditMode, exitEditMode, reAttachIfActive } from './reorganize.js';
import { renderPageList, slugify, createPageActionMenu, updateSidebarVisibility } from './sidebar.js';
import { openConfirmModal } from './modal.js';

let editEscListener = null;

// ---------------------------------------------------------------------------
// Add Group modal
// ---------------------------------------------------------------------------

function startInlineGroupCreation() {
  const grid = document.getElementById('pageGrid');
  const addCard = grid.querySelector('.group-card--add');
  if (!addCard) return;

  const card = document.createElement('div');
  card.className = 'group-card group-card--focused';
  
  const header = document.createElement('div');
  header.className = 'group-card__header';
  
  const titleEl = document.createElement('h2');
  titleEl.className = 'group-card__title group-card__title--editing';
  titleEl.setAttribute('contenteditable', 'plaintext-only');
  titleEl.setAttribute('placeholder', 'New Group');
  titleEl.textContent = 'New Group';
  titleEl.style.outline = 'none';
  
  header.appendChild(titleEl);
  card.appendChild(header);

  addCard.replaceWith(card);
  
  titleEl.focus();
  
  const range = document.createRange();
  range.selectNodeContents(titleEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  
  let isSaving = false;
  
  const finish = async () => {
    if (isSaving) return;
    const name = titleEl.textContent.trim();
    if (!name) { cancel(); return; }

    isSaving = true;
    const slug = state.currentSlug;
    const newGroup = { title: name, items: [] };

    try {
      await apiFetch(withLocation(`/pages/${slug}/groups`), {
        method: 'POST',
        body: JSON.stringify(newGroup),
      });
      const updated = await apiFetch(withLocation(`/pages/${slug}`));
      state.currentPage = updated;
      
      if (updated.groups && updated.groups.length > 0) {
        card.dataset.groupIndex = String(updated.groups.length - 1);
      }
      
      renderPage(state.currentPage);
    } catch (err) {
      console.error(err);
      renderPage(state.currentPage);
    }
  };

  const cancel = () => {
    renderPage(state.currentPage);
  };

  titleEl.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void finish();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      const name = titleEl.textContent.trim();
      if (name && name !== 'New Group') {
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
    if (page.groups?.[idx]?.title !== newTitle) {
      page.groups[idx].title = newTitle;
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
    titleEl2.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); editBtn.click(); }
    }, { once: true });
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

const SVG_SORT_ALPHA = `<span class="material-symbols-outlined" style="font-size: 18px;" aria-hidden="true">sort_by_alpha</span>`;

const SVG_SORT_CUSTOM = `<span class="material-symbols-outlined" style="font-size: 18px;" aria-hidden="true">view_list</span>`;

function createSortButton(page) {
  const isCustomSort = page.custom_sort ?? false;
  
  const sortBtn = document.createElement('button');
  sortBtn.type = 'button';
  sortBtn.className = 'page-header__icon-btn';
  sortBtn.title = isCustomSort ? 'Custom sort is ON (click to disable)' : 'Custom sort is OFF (click to enable)';
  sortBtn.innerHTML = isCustomSort ? SVG_SORT_CUSTOM : SVG_SORT_ALPHA;
  
  sortBtn.addEventListener('click', async () => {
    const willBeCustom = !(state.currentPage.custom_sort ?? false);
    
    if (!willBeCustom) {
      const { showStyledConfirmModal } = await import('./app.js');
      const confirmed = await showStyledConfirmModal('Disable Custom Sort?', 'Are you sure you want to turn off custom sort? Your custom order will be lost when you reorganize or edit items.');
      if (!confirmed) return;
    }

    sortBtn.innerHTML = willBeCustom ? SVG_SORT_CUSTOM : SVG_SORT_ALPHA;
    sortBtn.title = willBeCustom ? 'Custom sort is ON (click to disable)' : 'Custom sort is OFF (click to enable)';
    
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
      sortBtn.innerHTML = !willBeCustom ? SVG_SORT_CUSTOM : SVG_SORT_ALPHA;
      sortBtn.title = !willBeCustom ? 'Custom sort is ON (click to disable)' : 'Custom sort is OFF (click to enable)';
    }
  });

  return sortBtn;
}

// ---------------------------------------------------------------------------
// renderPage
// ---------------------------------------------------------------------------

function setupPageActions(page) {
  const actionsEl = document.getElementById('contentActions');
  if (!actionsEl) return;
  
  actionsEl.innerHTML = '';
  const editBtn = document.createElement('button');
  editBtn.id = 'editPageBtn';
  editBtn.type = 'button';
  editBtn.className = 'page-header__icon-btn';
  editBtn.title = isEditModeActive() ? 'Save (Ctrl+S)' : 'Edit (e)';
  editBtn.innerHTML = isEditModeActive() 
    ? '<span class="material-symbols-outlined" style="font-size: 20px; color: #4caf50;">check</span>' 
    : '<span class="material-symbols-outlined" style="font-size: 20px;">edit</span>';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'page-header__icon-btn';
  cancelBtn.title = 'Cancel (Esc)';
  cancelBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 20px; color: #f44336;">close</span>';
  cancelBtn.style.display = isEditModeActive() ? 'inline-block' : 'none';

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

  const cancelEdit = async () => {
    if (isEditModeActive()) {
      if (isGridEditDirty()) {
        const discard = await openConfirmModal();
        if (!discard) return;
      }
      exitEditMode();
      if (editEscListener) {
        document.removeEventListener('keydown', editEscListener);
        editEscListener = null;
      }
      const titleEl2 = document.getElementById('pageTitle');
      if (titleEl2) {
        titleEl2.removeAttribute('contenteditable');
        titleEl2.classList.remove('content__title--editing');
      }
      renderPage(state.currentPage);
    }
  };

  cancelBtn.addEventListener('click', () => { void cancelEdit(); });

  if (editEscListener) {
    document.removeEventListener('keydown', editEscListener);
    editEscListener = null;
  }

  editEscListener = (e) => {
    if (isEditModeActive() && e.key === 'Escape') {
      e.preventDefault();
      void cancelEdit();
    }
  };

  if (isEditModeActive()) {
    document.addEventListener('keydown', editEscListener);
  }

  editBtn.addEventListener('click', async () => {
    if (isEditModeActive()) {
      await saveTitleAndGroups(page);
      page = state.currentPage; // Update local reference after save
      exitEditMode();
      if (editEscListener) {
        document.removeEventListener('keydown', editEscListener);
        editEscListener = null;
      }
      cancelBtn.style.display = 'none';
    } else {
      enterEditMode();
      enterEditUI(editBtn);
      cancelBtn.style.display = 'inline-flex';
    }
    editBtn.title = isEditModeActive() ? 'Save (Ctrl+S)' : 'Edit (e)';
    editBtn.innerHTML = isEditModeActive() 
      ? '<span class="material-symbols-outlined" style="font-size: 20px; color: #4caf50;">check</span>' 
      : '<span class="material-symbols-outlined" style="font-size: 20px;">edit</span>';
  });

  if (!isHelpWorkspace(state.currentLocation)) {
    const sortBtn = createSortButton(state.currentPage);
    const menuBtn = createPageActionMenu(state.currentSlug, page['page-name'], undefined, state.currentLocation, true);
    actionsEl.appendChild(editBtn);
    actionsEl.appendChild(cancelBtn);
    actionsEl.appendChild(sortBtn);
    actionsEl.appendChild(menuBtn);
  }
}

function createAddGroupCard() {
  const addCard = document.createElement('div');
  addCard.className = 'group-card group-card--add';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'group-card__add-btn';
  addBtn.setAttribute('aria-label', 'Add group');
  addBtn.innerHTML = `
    <span class="group-card__add-icon"><span class="material-symbols-outlined" style="font-size: 18px;" aria-hidden="true">add</span></span>
    <span class="group-card__add-label">Add Group</span>
  `;
  addBtn.addEventListener('click', () => startInlineGroupCreation());
  addCard.appendChild(addBtn);
  return addCard;
}

function renderGroupCards(grid, groups) {
  if (groups.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'content__empty';
    empty.textContent = 'No groups yet. Add one to get started.';
    grid.appendChild(empty);
    return;
  }

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

function restoreGridFocus(grid, { wasAddGroupFocused, savedGroupIndex, savedItemIndex }) {
  const allCards = grid.querySelectorAll('.group-card');
  if (allCards.length === 0) return;

  let cardToFocus = null;
  if (wasAddGroupFocused) {
    cardToFocus = grid.querySelector('.group-card--add');
  } else if (savedGroupIndex !== null) {
    cardToFocus = Array.from(allCards).find(c => c.dataset.groupIndex === savedGroupIndex) ?? null;
  }

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
  const wasAddGroupFocused = Boolean(focusedCard?.classList.contains('group-card--add'));

  grid.innerHTML = '';

  renderGroupCards(grid, page.groups ?? []);

  if (!isHelpWorkspace(state.currentLocation)) {
    grid.appendChild(createAddGroupCard());
  }

  restoreGridFocus(grid, { wasAddGroupFocused, savedGroupIndex, savedItemIndex });
}

export function renderPage(page) {
  updateSidebarVisibility(page.page_type);

  // Whiteboard pages have their own renderer
  if (page.page_type === 'whiteboard') {
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
    void renderBpmnPage(page, state.currentSlug, state.currentLocation);
    return;
  }

  // Unmount any active bpmn-js instance when navigating away
  unmountBpmn();
  document.getElementById('content')?.classList.remove('content--bpmn');

  // Note pages have their own renderer
  if (page.page_type === 'note') {
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
