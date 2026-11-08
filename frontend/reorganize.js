// reorganize.js — Edit/Reorganize mode for groups and items
import { state, apiFetch, withLocation } from './app.js';
import { renderPage } from './content.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let isEditMode = false;
export function isEditModeActive() { return isEditMode; }

const GROUP_MIME = 'application/x-exodeck-group';
const ITEM_MIME  = 'application/x-exodeck-item';

/**
 * Checks whether the drag event contains the given MIME type (case-insensitively).
 * @param {DataTransfer|null} dataTransfer
 * @param {string} mime
 * @returns {boolean}
 */
function hasMimeType(dataTransfer, mime) {
  if (!dataTransfer?.types) return false;
  const target = mime.toLowerCase();
  return Array.from(dataTransfer.types).some(t => t.toLowerCase() === target);
}

/** Cleanup functions to remove event listeners added during edit mode. */
const _cleanupFns = [];

// ---------------------------------------------------------------------------
// Edit mode toggle
// ---------------------------------------------------------------------------

export function enterEditMode() {
  isEditMode = true;
  const grid = document.getElementById('pageGrid');
  if (grid) grid.classList.add('content__grid--edit-mode');
  _attachGroupDragEvents();
  _attachGroupDropZones();
  _attachGroupReorderZones();
  _attachItemDragEvents();
  _attachItemReorderZones();
  _attachSidebarDropZones();
}

export function exitEditMode() {
  isEditMode = false;
  const grid = document.getElementById('pageGrid');
  if (grid) grid.classList.remove('content__grid--edit-mode');
  while (_cleanupFns.length) _cleanupFns.pop()();
}

/**
 * Re-attach drag events after a renderPage() call that replaced the grid DOM.
 * Sidebar DOM is not replaced, so its listeners are cleaned up and re-added.
 */
export function reAttachIfActive() {
  if (!isEditMode) return;
  // Run all stored cleanup to remove stale sidebar listeners
  // (grid listeners are moot since those DOM elements were replaced)
  while (_cleanupFns.length) _cleanupFns.pop()();
  _attachGroupDragEvents();
  _attachGroupDropZones();
  _attachGroupReorderZones();
  _attachItemDragEvents();
  _attachItemReorderZones();
  _attachSidebarDropZones();
}

// ---------------------------------------------------------------------------
// Group drag — dragging group cards onto sidebar page entries
// ---------------------------------------------------------------------------

function _attachGroupDragEvents() {
  const cards = document.querySelectorAll('.group-card:not(.group-card--add)');
  for (const card of cards) {
    card.setAttribute('draggable', 'true');

    const onDragStart = e => {
      const groupIndex = card.dataset.groupIndex;
      if (groupIndex == null) return;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(GROUP_MIME, JSON.stringify({
        sourceSlug: state.currentSlug,
        sourceLocation: state.currentLocation ?? null,
        groupIndex: Number(groupIndex),
      }));
      card.classList.add('group-card--dragging');
    };

    const onDragEnd = () => {
      card.classList.remove('group-card--dragging');
      document.querySelectorAll('.sidebar__page--drop-target')
        .forEach(el => el.classList.remove('sidebar__page--drop-target'));
      document.querySelectorAll('.group-card--drop-target, .group-card--insert-before, .group-card--insert-after')
        .forEach(el => el.classList.remove('group-card--drop-target', 'group-card--insert-before', 'group-card--insert-after'));
    };

    card.addEventListener('dragstart', onDragStart);
    card.addEventListener('dragend',   onDragEnd);

    _cleanupFns.push(() => {
      card.removeAttribute('draggable');
      card.removeEventListener('dragstart', onDragStart);
      card.removeEventListener('dragend',   onDragEnd);
    });
  }
}

// ---------------------------------------------------------------------------
// Group drag — reordering within the same page
// ---------------------------------------------------------------------------

function ensureCustomSort(page) {
  if (page.custom_sort) return false;
  
  page.groups.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '', undefined, { sensitivity: 'base' }));
  for (const group of page.groups) {
    if (group.items) {
      group.items.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '', undefined, { sensitivity: 'base' }));
    }
  }
  page.custom_sort = true;
  
  const pageMeta = state.pages.find(p => p.slug === state.currentSlug && (state.currentLocation ? p.location === state.currentLocation : true));
  if (pageMeta) pageMeta.custom_sort = true;
  
  return true;
}

function calculateNewGroupIndex(sourceIndex, targetIndex, isBefore) {
  let newIndex = isBefore ? targetIndex : targetIndex + 1;
  if (sourceIndex === targetIndex - 1 && isBefore) newIndex = targetIndex + 1;
  if (sourceIndex === targetIndex + 1 && !isBefore) newIndex = targetIndex;
  if (sourceIndex < newIndex) newIndex--;
  return newIndex;
}

function calculateNewItemIndex(sourceGroup, targetGroup, sourceItem, targetItem, isBefore) {
  let newIndex = isBefore ? targetItem : targetItem + 1;
  if (sourceGroup === targetGroup) {
    if (sourceItem === targetItem - 1 && isBefore) newIndex = targetItem + 1;
    if (sourceItem === targetItem + 1 && !isBefore) newIndex = targetItem;
    if (sourceItem < newIndex) newIndex--;
  }
  return newIndex;
}

function _attachGroupReorderZones() {
  const cards = document.querySelectorAll('.group-card:not(.group-card--add)');
  for (const card of cards) {
    const onDragOver = e => {
      if (!hasMimeType(e.dataTransfer, GROUP_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      
      const rect = card.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      card.classList.add('group-card--drop-target');
      
      if (e.clientY < midY) {
        card.classList.add('group-card--insert-before');
        card.classList.remove('group-card--insert-after');
      } else {
        card.classList.add('group-card--insert-after');
        card.classList.remove('group-card--insert-before');
      }
    };

    const onDragLeave = e => {
      if (!card.contains(e.relatedTarget)) {
        card.classList.remove('group-card--drop-target', 'group-card--insert-before', 'group-card--insert-after');
      }
    };

    const onDrop = async e => {
      if (!hasMimeType(e.dataTransfer, GROUP_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      const isBefore = card.classList.contains('group-card--insert-before');
      card.classList.remove('group-card--drop-target', 'group-card--insert-before', 'group-card--insert-after');
      
      const raw = e.dataTransfer.getData(GROUP_MIME);
      if (!raw) return;
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      
      if (data.sourceSlug !== state.currentSlug) return; // Only reorder on same page
      const targetGroupIndex = Number(card.dataset.groupIndex);
      if (data.groupIndex === targetGroupIndex) return;

      const page = state.currentPage;
      if (!page?.groups) return;
      
      let autoSwitched = false;
      const groupToMoveRef = page.groups[data.groupIndex];
      const targetGroupRef = page.groups[targetGroupIndex];
      if (!groupToMoveRef || !targetGroupRef) return;

      let actualGroupIndex = data.groupIndex;
      let actualTargetIndex = targetGroupIndex;

      if (ensureCustomSort(page)) {
        actualGroupIndex = page.groups.indexOf(groupToMoveRef);
        actualTargetIndex = page.groups.indexOf(targetGroupRef);
        autoSwitched = true;
      }

      if (actualGroupIndex === actualTargetIndex) {
        if (autoSwitched) await savePageOrder();
        return;
      }

      const newIndex = calculateNewGroupIndex(actualGroupIndex, actualTargetIndex, isBefore);

      const groupToMove = page.groups.splice(actualGroupIndex, 1)[0];
      page.groups.splice(newIndex, 0, groupToMove);
      await savePageOrder();
    };

    card.addEventListener('dragover',  onDragOver);
    card.addEventListener('dragleave', onDragLeave);
    card.addEventListener('drop',      onDrop);

    _cleanupFns.push(() => {
      card.removeEventListener('dragover',  onDragOver);
      card.removeEventListener('dragleave', onDragLeave);
      card.removeEventListener('drop',      onDrop);
    });
  }
}


// ---------------------------------------------------------------------------
// Sidebar drop zones — accept group cards dropped onto page entries
// ---------------------------------------------------------------------------

function _attachSidebarDropZones() {
  const nav = document.getElementById('pageList');
  if (!nav) return;

  const buttons = nav.querySelectorAll('.sidebar__page[data-slug]');
  for (const btn of buttons) {
    const targetSlug     = btn.dataset.slug;
    const targetLocation = btn.dataset.location ?? null;

    // Skip note pages
    if (btn.dataset.pageType === 'note') continue;

    // Skip the currently displayed page
    if (
      targetSlug === state.currentSlug &&
      (targetLocation ?? null) === (state.currentLocation ?? null)
    ) continue;

    const onDragOver = e => {
      if (!hasMimeType(e.dataTransfer, GROUP_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      btn.classList.add('sidebar__page--drop-target');
    };

    const onDragLeave = e => {
      if (!btn.contains(e.relatedTarget)) {
        btn.classList.remove('sidebar__page--drop-target');
      }
    };

    const onDrop = async e => {
      if (!hasMimeType(e.dataTransfer, GROUP_MIME)) return;
      e.preventDefault();
      btn.classList.remove('sidebar__page--drop-target');
      const raw = e.dataTransfer.getData(GROUP_MIME);
      if (!raw) return;
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      await _moveGroupToPage(
        data.sourceSlug, data.sourceLocation, data.groupIndex,
        targetSlug, targetLocation
      );
    };

    btn.addEventListener('dragover',  onDragOver);
    btn.addEventListener('dragleave', onDragLeave);
    btn.addEventListener('drop',      onDrop);

    _cleanupFns.push(() => {
      btn.removeEventListener('dragover',  onDragOver);
      btn.removeEventListener('dragleave', onDragLeave);
      btn.removeEventListener('drop',      onDrop);
    });
  }
}

// ---------------------------------------------------------------------------
// Item drag — dragging items between groups on the same page
// ---------------------------------------------------------------------------

function _attachItemDragEvents() {
  const items = document.querySelectorAll('.group-card__items .item[data-item-index]');
  for (const li of items) {
    li.setAttribute('draggable', 'true');

    const onDragStart = e => {
      e.stopPropagation(); // prevent triggering group's dragstart
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(ITEM_MIME, JSON.stringify({
        sourceGroupIndex: Number(li.dataset.groupIndex),
        itemIndex: Number(li.dataset.itemIndex),
      }));
      li.classList.add('item--dragging');
    };

    const onDragEnd = () => {
      li.classList.remove('item--dragging');
      document.querySelectorAll('.group-card__items--drop-target')
        .forEach(el => el.classList.remove('group-card__items--drop-target'));
      document.querySelectorAll('.item--drop-target, .item--insert-before, .item--insert-after')
        .forEach(el => el.classList.remove('item--drop-target', 'item--insert-before', 'item--insert-after'));
    };

    li.addEventListener('dragstart', onDragStart);
    li.addEventListener('dragend',   onDragEnd);

    _cleanupFns.push(() => {
      li.removeAttribute('draggable');
      li.removeEventListener('dragstart', onDragStart);
      li.removeEventListener('dragend',   onDragEnd);
    });
  }
}

// ---------------------------------------------------------------------------
// Group item lists — drop zones for item moves
// ---------------------------------------------------------------------------

function _attachGroupDropZones() {
  const cards = document.querySelectorAll('.group-card:not(.group-card--add)');
  for (const card of cards) {
    const list = card.querySelector('.group-card__items');

    const onDragOver = e => {
      if (!hasMimeType(e.dataTransfer, ITEM_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (list) list.classList.add('group-card__items--drop-target');
    };

    const onDragLeave = e => {
      if (!card.contains(e.relatedTarget)) {
        if (list) list.classList.remove('group-card__items--drop-target');
      }
    };

    const onDrop = async e => {
      if (!hasMimeType(e.dataTransfer, ITEM_MIME)) return;
      e.preventDefault();
      if (list) list.classList.remove('group-card__items--drop-target');
      const raw = e.dataTransfer.getData(ITEM_MIME);
      if (!raw) return;
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      const page = state.currentPage;
      if (!page?.groups) return;
      
      const targetGroupIndex = Number(card.dataset.groupIndex);
      const sourceGroupRef = page.groups[data.sourceGroupIndex];
      const itemToMoveRef = sourceGroupRef?.items?.[data.itemIndex];
      const targetGroupRef = page.groups[targetGroupIndex];
      if (!sourceGroupRef || !targetGroupRef || !itemToMoveRef) return;

      let actualSourceGroupIndex = data.sourceGroupIndex;
      let actualTargetGroupIndex = targetGroupIndex;
      let actualItemIndex = data.itemIndex;

      if (ensureCustomSort(page)) {
        actualSourceGroupIndex = page.groups.indexOf(sourceGroupRef);
        actualTargetGroupIndex = page.groups.indexOf(targetGroupRef);
        actualItemIndex = page.groups[actualSourceGroupIndex].items.indexOf(itemToMoveRef);
      }

      if (actualSourceGroupIndex === actualTargetGroupIndex) {
        // Drop into empty space of the same group -> move to bottom
        const itemToMove = page.groups[actualSourceGroupIndex].items.splice(actualItemIndex, 1)[0];
        page.groups[actualTargetGroupIndex].items.push(itemToMove);
        await savePageOrder();
        return;
      }

      // If we auto-switched and we are moving to a different group, we need to PUT the alphabetical state 
      // before POSTing the move, or we can just do the move in memory and PUT!
      // Doing in-memory splice for cross-group move is completely fine since we PUT the whole page anyway!
      const itemToMove = page.groups[actualSourceGroupIndex].items.splice(actualItemIndex, 1)[0];
      if (!page.groups[actualTargetGroupIndex].items) page.groups[actualTargetGroupIndex].items = [];
      page.groups[actualTargetGroupIndex].items.push(itemToMove);
      await savePageOrder();
    };

    card.addEventListener('dragover',  onDragOver);
    card.addEventListener('dragleave', onDragLeave);
    card.addEventListener('drop',      onDrop);

    _cleanupFns.push(() => {
      card.removeEventListener('dragover',  onDragOver);
      card.removeEventListener('dragleave', onDragLeave);
      card.removeEventListener('drop',      onDrop);
    });
  }
}

// ---------------------------------------------------------------------------
// Item drag — reordering items within groups
// ---------------------------------------------------------------------------

function _attachItemReorderZones() {
  const items = document.querySelectorAll('.group-card__items .item[data-item-index]');
  for (const li of items) {
    const onDragOver = e => {
      if (!hasMimeType(e.dataTransfer, ITEM_MIME)) return;
      e.preventDefault();
      e.stopPropagation(); // prevent bubbling to group list or card
      e.dataTransfer.dropEffect = 'move';
      
      const rect = li.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      li.classList.add('item--drop-target');
      
      if (e.clientY < midY) {
        li.classList.add('item--insert-before');
        li.classList.remove('item--insert-after');
      } else {
        li.classList.add('item--insert-after');
        li.classList.remove('item--insert-before');
      }
    };

    const onDragLeave = e => {
      if (!li.contains(e.relatedTarget)) {
        li.classList.remove('item--drop-target', 'item--insert-before', 'item--insert-after');
      }
    };

    const onDrop = async e => {
      if (!hasMimeType(e.dataTransfer, ITEM_MIME)) return;
      e.preventDefault();
      e.stopPropagation(); // prevent bubbling to group list or card
      const isBefore = li.classList.contains('item--insert-before');
      li.classList.remove('item--drop-target', 'item--insert-before', 'item--insert-after');
      
      const raw = e.dataTransfer.getData(ITEM_MIME);
      if (!raw) return;
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      
      const page = state.currentPage;
      if (!page?.groups) return;

      const targetGroupIndex = Number(li.dataset.groupIndex);
      const targetItemIndex = Number(li.dataset.itemIndex);

      const sourceGroupRef = page.groups[data.sourceGroupIndex];
      const itemToMoveRef = sourceGroupRef?.items?.[data.itemIndex];
      const targetGroupRef = page.groups[targetGroupIndex];
      const targetItemRef = targetGroupRef?.items?.[targetItemIndex];
      if (!sourceGroupRef || !targetGroupRef || !itemToMoveRef || !targetItemRef) return;

      let actualSourceGroupIndex = data.sourceGroupIndex;
      let actualTargetGroupIndex = targetGroupIndex;
      let actualSourceItemIndex = data.itemIndex;
      let actualTargetItemIndex = targetItemIndex;
      let autoSwitched = false;

      if (ensureCustomSort(page)) {
        actualSourceGroupIndex = page.groups.indexOf(sourceGroupRef);
        actualTargetGroupIndex = page.groups.indexOf(targetGroupRef);
        actualSourceItemIndex = page.groups[actualSourceGroupIndex].items.indexOf(itemToMoveRef);
        actualTargetItemIndex = page.groups[actualTargetGroupIndex].items.indexOf(targetItemRef);
        autoSwitched = true;
      }

      if (actualSourceGroupIndex === actualTargetGroupIndex && actualSourceItemIndex === actualTargetItemIndex) {
        if (autoSwitched) await savePageOrder();
        return;
      }

      const newIndex = calculateNewItemIndex(actualSourceGroupIndex, actualTargetGroupIndex, actualSourceItemIndex, actualTargetItemIndex, isBefore);

      const itemToMove = page.groups[actualSourceGroupIndex].items.splice(actualSourceItemIndex, 1)[0];
      if (!page.groups[actualTargetGroupIndex].items) page.groups[actualTargetGroupIndex].items = [];
      page.groups[actualTargetGroupIndex].items.splice(newIndex, 0, itemToMove);
      await savePageOrder();
    };

    li.addEventListener('dragover',  onDragOver);
    li.addEventListener('dragleave', onDragLeave);
    li.addEventListener('drop',      onDrop);

    _cleanupFns.push(() => {
      li.removeEventListener('dragover',  onDragOver);
      li.removeEventListener('dragleave', onDragLeave);
      li.removeEventListener('drop',      onDrop);
    });
  }
}


// ---------------------------------------------------------------------------
// Move actions
// ---------------------------------------------------------------------------

async function _moveGroupToPage(sourceSlug, sourceLocation, groupIndex, targetSlug, targetLocation) {

  try {
    await apiFetch(
      withLocation(`/pages/${encodeURIComponent(sourceSlug)}/groups/${groupIndex}/move`, sourceLocation),
      {
        method: 'POST',
        body: JSON.stringify({ target_slug: targetSlug, target_location: targetLocation }),
      }
    );
    // Reload and re-render if the move was from the currently displayed page
    if (
      sourceSlug === state.currentSlug &&
      (sourceLocation ?? null) === (state.currentLocation ?? null)
    ) {
      const updated = await apiFetch(withLocation(`/pages/${encodeURIComponent(state.currentSlug)}`));
      state.currentPage = updated;
      renderPage(state.currentPage);
    }
    _showToast(`Group moved to "${_pageName(targetSlug, targetLocation)}".`);
  } catch (err) {
    _showToast(`Move failed: ${err.message}`);
    console.error('[ExoDeck] Move group failed:', err);
  }
}

// eslint-disable-next-line no-unused-vars
async function _moveItemToGroup(sourceGroupIndex, itemIndex, targetGroupIndex) {
  try {
      const slug = state.currentSlug;
      await apiFetch(
        withLocation(`/pages/${encodeURIComponent(slug)}/groups/${sourceGroupIndex}/items/${itemIndex}/move`),
        {
          method: 'POST',
          body: JSON.stringify({ target_group_index: targetGroupIndex }),
        }
      );
      const updated = await apiFetch(withLocation(`/pages/${encodeURIComponent(slug)}`));
      state.currentPage = updated;

    renderPage(state.currentPage);
  } catch (err) {
    _showToast(`Move failed: ${err.message}`);
    console.error('[ExoDeck] Move item failed:', err);
  }
}

async function savePageOrder() {
  try {
    const updated = await apiFetch(
      withLocation(`/pages/${encodeURIComponent(state.currentSlug)}`),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state.currentPage),
      }
    );
    if (updated) {
      state.currentPage = updated;
    }
    renderPage(state.currentPage);
  } catch (err) {
    _showToast(`Save order failed: ${err.message}`);
    console.error('[ExoDeck] Save order failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Toast notification
// ---------------------------------------------------------------------------

function _showToast(message) {
  document.getElementById('reorganize-toast')?.remove();
  const toast = document.createElement('div');
  toast.id = 'reorganize-toast';
  toast.className = 'reorganize-toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function _pageName(slug, location) {
  const page = state.pages.find(
    p => p.slug === slug && (p.location ?? null) === (location ?? null)
  );
  return page?.page_name ?? slug;
}
