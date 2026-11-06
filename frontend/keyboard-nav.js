// keyboard-nav.js — Keyboard navigation overlay
import { state, apiFetch } from './app.js';
import { loadPage, toggleSidebar, createGridPage, createNote } from './sidebar.js';
import { openNoteWindow, openEncryptedNoteWindow } from './notes.js';
import { openPasswordWindow } from './password.js';
import { openTaskWindow } from './task.js';
import { addItemToGroup } from './groupbox.js';
import { openPicker } from './add-picker.js';
import { createWhiteboardPage, printWhiteboardPage } from './whiteboard.js';
import { createBpmnPage, printBpmnPage } from './bpmn.js';
import { printNotePage } from './note.js';
import { canEncryptWorkspace, fetchVaultStatus } from './vault.js';
import { toggleNotificationPanel, toggleTasksPanel } from './notifications.js';

// ---------------------------------------------------------------------------
// DOM references (populated after DOMContentLoaded in initKeyNav)
// ---------------------------------------------------------------------------
/** @type {HTMLDivElement} */
let keyNavEl;
/** @type {HTMLInputElement} */
let keyNavInput;
/** @type {HTMLUListElement} */
let keyNavResults;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
let activeIndex = -1;
/** @type {(() => void)|null} Stored so we can remove the listener on close */
let _docKeyHandler = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the element is an editable context (input / textarea /
 * contenteditable), so we don't hijack the '/' key while the user types.
 * @param {EventTarget} el
 */
function isTypingContext(el) {
  if (!(el instanceof Element)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

// ---------------------------------------------------------------------------
// Results rendering
// ---------------------------------------------------------------------------

function populatePageResult(li, res) {
  const locPrefix = res.location && state.locations.length > 1 ? `${res.location} / ` : '';
  const name = document.createTextNode(`${locPrefix}${res.page_name ?? res.slug}`);
  li.appendChild(name);

  if (res.hidden) {
    const badge = document.createElement('span');
    badge.className = 'keynav__hidden-badge';
    badge.textContent = '🔒 hidden';
    li.appendChild(badge);
  }
}

function populateItemResult(li, res) {
  li.dataset.groupIndex = String(res.group_index);
  li.dataset.itemIndex = String(res.item_index);
  li.dataset.itemType = res.item_type;

  const locPrefix = res.location && state.locations.length > 1 ? `${res.location} / ` : '';
  const groupPart = res.group_title ? `${res.group_title} / ` : '';
  const text = `${locPrefix}${res.page_name} / ${groupPart}${res.title}`;

  const nameSpan = document.createElement('span');
  nameSpan.textContent = text;
  li.appendChild(nameSpan);

  const typeIcon = document.createElement('span');
  typeIcon.className = 'keynav__item-type';
  typeIcon.style.opacity = '0.5';
  typeIcon.style.marginLeft = '8px';
  typeIcon.style.fontSize = '0.85em';
  typeIcon.textContent = `(${res.item_type.replaceAll('_', ' ')})`;
  li.appendChild(typeIcon);
}

function createResultItem(res) {
  const li = document.createElement('li');
  li.className = 'keynav__result-item';
  li.dataset.resultType = res.resultType;
  li.dataset.slug = res.slug;
  if (res.location) li.dataset.location = res.location;

  if (res.resultType === 'page') {
    populatePageResult(li, res);
  } else {
    populateItemResult(li, res);
  }

  li.addEventListener('click', () => {
    void handleResultClick(li);
  });
  return li;
}

/**
 * Render the filtered page list into #keyNavResults.
 * @param {string} query - lower-cased, trimmed search string
 */
let currentSearchId = 0;

async function renderKeyNavResults(query) {
  const searchId = ++currentSearchId;

  const allPages = state.pages ?? [];

  const visible = allPages.filter(p => !p.hidden);
  const hidden  = allPages.filter(p => p.hidden);

  // Visible pages that match the query (or all if query is empty)
  const matched = query
    ? visible.filter(p => (p.page_name ?? '').toLowerCase().includes(query))
    : [...visible];

  // Hidden pages shown only on exact-name match
  const exactHidden = hidden.filter(
    p => (p.page_name ?? '').toLowerCase() === query
  );

  let results = [...matched, ...exactHidden].map(p => ({ ...p, resultType: 'page' }));

  if (query) {
    try {
      const items = await apiFetch(`/search?q=${encodeURIComponent(query)}`);
      if (searchId !== currentSearchId) return;
      const itemResults = items.map(it => ({ ...it, resultType: 'item' }));
      results = [...results, ...itemResults];
    } catch (err) {
      console.error('[ExoDeck] Search failed:', err);
    }
  }

  if (searchId !== currentSearchId) return;

  keyNavResults.innerHTML = '';
  activeIndex = -1;

  for (const res of results) {
    keyNavResults.appendChild(createResultItem(res));
  }

  // Highlight first result
  if (results.length > 0) setActive(0);
}

// ---------------------------------------------------------------------------
// Active item highlight
// ---------------------------------------------------------------------------

function setActive(index) {
  const items = /** @type {NodeListOf<HTMLLIElement>} */ (
    keyNavResults.querySelectorAll('.keynav__result-item')
  );
  if (!items.length) return;

  // Clamp + wrap
  activeIndex = ((index % items.length) + items.length) % items.length;

  items.forEach((el, i) => {
    el.classList.toggle('keynav__result-item--focused', i === activeIndex);
  });

  items[activeIndex].scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Open / Close
// ---------------------------------------------------------------------------

function openKeyNav() {
  if (_docKeyHandler) return; // already open

  keyNavEl.removeAttribute('hidden');
  keyNavInput.value = '';
  void renderKeyNavResults('');

  _docKeyHandler = (e) => {
    if (e.key === 'Escape') {
      closeKeyNav();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(activeIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(activeIndex - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const items = keyNavResults.querySelectorAll('.keynav__result-item');
      if (activeIndex >= 0 && activeIndex < items.length) {
        void handleResultClick(/** @type {HTMLElement} */ (items[activeIndex]));
      }
    }
  };

  document.addEventListener('keydown', _docKeyHandler);

  // Defer focus so the '/' keypress/beforeinput events complete first.
  // Without this, '/' would be inserted into the input, filtering out all results.
  setTimeout(() => keyNavInput.focus(), 0);
}

function closeKeyNav() {
  keyNavEl.setAttribute('hidden', '');
  keyNavInput.value = '';
  keyNavResults.innerHTML = '';
  activeIndex = -1;

  if (_docKeyHandler) {
    document.removeEventListener('keydown', _docKeyHandler);
    _docKeyHandler = null;
  }
}

// ---------------------------------------------------------------------------
// Navigate
// ---------------------------------------------------------------------------

async function handleResultClick(li) {
  const resultType = li.dataset.resultType;
  const slug = li.dataset.slug;
  const location = li.dataset.location ?? null;

  closeKeyNav();

  if (resultType === 'page') {
    await loadPage(slug, location);
    return;
  }

  const itemType = li.dataset.itemType;
  const groupIndex = Number(li.dataset.groupIndex);
  const itemIndex = Number(li.dataset.itemIndex);

  await loadPage(slug, location);

  // After `loadPage`, the full page is in `state.currentPage`
  const page = state.currentPage;
  if (!page?.groups?.[groupIndex]) return;
  const item = page.groups[groupIndex].items[itemIndex];
  if (!item) return;

  if (itemType === 'link' && item.url) {
    window.open(item.url, '_blank', 'noopener');
  } else if (itemType === 'note') {
    openNoteWindow(item, itemIndex, groupIndex, slug, location, 'view');
  } else if (itemType === 'enc_note') {
    openEncryptedNoteWindow(item, itemIndex, groupIndex, slug, location, 'view');
  } else if (itemType === 'password') {
    openPasswordWindow(item, itemIndex, groupIndex, slug, location, 'view');
  } else if (itemType === 'task') {
    openTaskWindow(item, itemIndex, groupIndex, slug, location, 'view');
  }
}

// ---------------------------------------------------------------------------
// + shortcut — Add content
// ---------------------------------------------------------------------------



function getSelectedGroupContext() {
  const isGridPage = state.currentPage
    && state.currentPage.page_type !== 'note'
    && state.currentPage.page_type !== 'whiteboard'
    && state.currentPage.page_type !== 'bpmn'
    && Array.isArray(state.currentPage.groups);

  if (!isGridPage) return null;

  const grid = document.getElementById('pageGrid');
  const groupCards = grid ? Array.from(grid.querySelectorAll('.group-card')) : [];
  const selectedGroupIdx = groupCards.findIndex(c => c.classList.contains('group-card--focused'));
  if (selectedGroupIdx === -1 || groupCards[selectedGroupIdx].classList.contains('group-card--add')) {
    return null;
  }

  const originalGroupIdx = Number(groupCards[selectedGroupIdx].dataset.groupIndex);
  const selectedGroup = state.currentPage.groups[originalGroupIdx];
  const groupName = selectedGroup?.title || `Group ${originalGroupIdx + 1}`;
  return { originalGroupIdx, groupName };
}

function buildAddActions() {
  const actions = [];
  const selectedGroup = getSelectedGroupContext();
  const isGridPage = state.currentPage
    && state.currentPage.page_type !== 'note'
    && state.currentPage.page_type !== 'whiteboard'
    && state.currentPage.page_type !== 'bpmn'
    && Array.isArray(state.currentPage.groups);

  if (selectedGroup) {
    const { originalGroupIdx, groupName } = selectedGroup;
    const canEncrypt = canEncryptWorkspace(state.currentLocation);
    const groupActions = [
      { label: `Link (to ${groupName})`, value: `add_item:link:${originalGroupIdx}`, icon: 'open_in_new' },
      { label: `Note (to ${groupName})`, value: `add_item:note:${originalGroupIdx}`, icon: 'description' },
      ...(canEncrypt ? [{ label: `Encrypted Note (to ${groupName})`, value: `add_item:enc_note:${originalGroupIdx}`, icon: 'lock' }] : []),
      { label: `Task (to ${groupName})`, value: `add_item:task:${originalGroupIdx}`, icon: 'check' },
      ...(canEncrypt ? [{ label: `Password (to ${groupName})`, value: `add_item:password:${originalGroupIdx}`, icon: 'key' }] : []),
    ];
    actions.push(...groupActions, { isDivider: true });
  } else if (isGridPage && (state.currentPage?.groups?.length ?? 0) > 0) {
    const canEncrypt = canEncryptWorkspace(state.currentLocation);
    const itemActions = [
      { label: 'Link', value: 'add_item:link', icon: 'open_in_new' },
      { label: 'Note', value: 'add_item:note', icon: 'description' },
      ...(canEncrypt ? [{ label: 'Encrypted Note', value: 'add_item:enc_note', icon: 'lock' }] : []),
      { label: 'Task', value: 'add_item:task', icon: 'check' },
      ...(canEncrypt ? [{ label: 'Password', value: 'add_item:password', icon: 'key' }] : []),
    ];
    actions.push(...itemActions, { isDivider: true });
  }

  actions.push(
    { label: 'Note Page', value: 'note', icon: 'description' },
    { label: 'Whiteboard Page', value: 'whiteboard', icon: 'draw' },
    { label: 'Business Process Page', value: 'bpmn', icon: 'schema' },
    { label: 'Grid Page', value: 'grid', icon: 'grid_view' },
  );

  return actions;
}

async function handleAddItemAction(action) {
  const parts = action.split(':');
  const itemType = parts[1];
  const groupIdx = parts.length > 2 ? Number.parseInt(parts[2], 10) : null;

  if (groupIdx !== null) {
    await addItemToGroup(itemType, groupIdx, state.currentSlug, state.currentLocation);
    return;
  }

  const groups = state.currentPage?.groups ?? [];
  if (groups.length === 0) {
    const addBtn = document.querySelector('.group-card--add .group-card__add-btn');
    addBtn?.click();
    return;
  }

  const groupOptions = groups.map((g, i) => ({ label: g.title || `Group ${i + 1}`, value: i, icon: 'folder' }));
  const selectedGroupIndex = await openPicker('Select a group', groupOptions);
  if (selectedGroupIndex !== null) {
    await addItemToGroup(itemType, selectedGroupIndex, state.currentSlug, state.currentLocation);
  }
}

function handleCreatePageAction(action, targetLocation) {
  switch (action) {
    case 'grid':
      createGridPage(targetLocation);
      break;
    case 'whiteboard':
      createWhiteboardPage(targetLocation);
      break;
    case 'bpmn':
      createBpmnPage(targetLocation);
      break;
    default:
      createNote(targetLocation);
      break;
  }
}

async function handleAddShortcut() {
  await fetchVaultStatus(state.currentLocation);
  const actions = buildAddActions();
  const action = await openPicker('Add ...', actions);
  if (!action) return;

  if (action.startsWith('add_item:')) {
    await handleAddItemAction(action);
    return;
  }

  handleCreatePageAction(action, state.currentLocation);
}

// ---------------------------------------------------------------------------
// Public init
// ---------------------------------------------------------------------------

function isOverlayActive() {
  if (document.querySelector('.modal, .modal-overlay, .add-picker, .note-window-overlay, .keynav:not([hidden])')) return true;
  const floatingNav = document.getElementById('floatingNav');
  if (floatingNav && !floatingNav.hasAttribute('hidden')) return true;
  const notifOverlay = document.getElementById('notificationOverlay');
  if (notifOverlay && !notifOverlay.hasAttribute('hidden')) return true;
  const notifPanel = document.getElementById('notificationMenuPanel');
  if (notifPanel && !notifPanel.hasAttribute('hidden') && notifPanel.classList.contains('notification-panel--open')) return true;
  return false;
}

function handleSlashKeydown(e) {
  if (!isTypingContext(e.target) && !isOverlayActive()) {
    e.preventDefault();
    openKeyNav();
  }
}

function handleSKeydown(e) {
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !isTypingContext(e.target) && !isOverlayActive()) {
    e.preventDefault();
    toggleSidebar();
  }
}

function handleEKeydown(e) {
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !isTypingContext(e.target) && !isOverlayActive()) {
    e.preventDefault();
    if (!document.getElementById('mdEditorContainer') && !document.getElementById('wbEditorContainer') && !document.getElementById('bpmnEditorContainer')) {
      const editBtn = document.getElementById('editMdPageBtn')
        ?? document.getElementById('editWbPageBtn')
        ?? document.getElementById('editBpmnPageBtn')
        ?? document.getElementById('editPageBtn')
        ?? document.querySelector('#contentActions .btn--ghost');
      editBtn?.click();
    }
  }
}

function handleCtrlSKeydown(e) {
  e.preventDefault();
  // Note, whiteboard, and BPMN editors handle ctrl+s internally via their own keydown listeners
  if (document.getElementById('mdEditorContainer') || document.getElementById('wbEditorContainer') || document.getElementById('bpmnEditorContainer')) return;
  // Grid edit mode: clicking Save exits and saves
  if (document.getElementById('pageGrid')?.classList.contains('content__grid--edit-mode')) {
    const editBtn = document.getElementById('editPageBtn') ?? document.querySelector('#contentActions .btn--ghost');
    editBtn?.click();
  }
}

function handlePlusKeydown(e) {
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !isTypingContext(e.target) && !isOverlayActive()) {
    e.preventDefault();
    handleAddShortcut().catch(console.error);
  }
}

function handleQKeydown(e) {
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !isTypingContext(e.target) && !isOverlayActive()) {
    e.preventDefault();
    createNote(state.currentLocation);
  }
}

function handleWKeydown(e) {
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !isTypingContext(e.target) && !isOverlayActive()) {
    e.preventDefault();
    createWhiteboardPage(state.currentLocation);
  }
}

function handleGKeydown(e) {
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !isTypingContext(e.target) && !isOverlayActive()) {
    e.preventDefault();
    createGridPage(state.currentLocation);
  }
}

function handlePeriodKeydown(e) {
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !isTypingContext(e.target)) {
    if (!document.querySelector('.modal-overlay, .add-picker') && keyNavEl?.hasAttribute('hidden')) {
      e.preventDefault();
      void import('./sidebar.js').then(m => m.toggleFloatingNavigator()).catch(console.error);
    }
  }
}

function handleBKeydown(e) {
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !isTypingContext(e.target) && !isOverlayActive()) {
    e.preventDefault();
    createBpmnPage(state.currentLocation);
  }
}

function handlePKeydown(e) {
  if (e.ctrlKey || e.altKey || e.metaKey || isTypingContext(e.target) || isOverlayActive()) return;

  const pageType = state.currentPage?.page_type;
  if (pageType !== 'note' && pageType !== 'whiteboard' && pageType !== 'bpmn') return;

  const isEditing = document.getElementById('mdEditorContainer')
    || document.getElementById('wbEditorContainer')
    || document.getElementById('bpmnEditorContainer');
  if (isEditing) return;

  e.preventDefault();
  let fn;
  if (pageType === 'note') fn = printNotePage;
  else if (pageType === 'whiteboard') fn = printWhiteboardPage;
  else if (pageType === 'bpmn') fn = printBpmnPage;
  fn?.(state.currentSlug, state.currentLocation).catch(console.error);
}

function handleNKeydown(e) {
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !isTypingContext(e.target)) {
    const otherOverlayActive = Boolean(
      document.querySelector('.modal, .modal-overlay, .add-picker, .note-window-overlay, .keynav:not([hidden])') ||
      (document.getElementById('floatingNav') && !document.getElementById('floatingNav').hasAttribute('hidden'))
    );
    if (!otherOverlayActive) {
      e.preventDefault();
      toggleNotificationPanel();
    }
  }
}

function handleTKeydown(e) {
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !isTypingContext(e.target)) {
    const otherOverlayActive = Boolean(
      document.querySelector('.modal, .modal-overlay, .add-picker, .note-window-overlay, .keynav:not([hidden])') ||
      (document.getElementById('floatingNav') && !document.getElementById('floatingNav').hasAttribute('hidden'))
    );
    if (!otherOverlayActive) {
      e.preventDefault();
      toggleTasksPanel();
    }
  }
}

function isGridNavigable(e) {
  const pageType = state.currentPage?.page_type;
  if (!state.currentPage || pageType === 'note' || pageType === 'whiteboard' || pageType === 'bpmn') {
    return false;
  }
  return !isTypingContext(e.target) && !isOverlayActive() && !document.querySelector('.group-card__menu:not([hidden])');
}

function handleGridHorizontalNav(e, groupCards, currentGroupIdx) {
  e.preventDefault();
  const nextGroupIdx = e.key === 'ArrowRight'
    ? Math.min(currentGroupIdx + 1, groupCards.length - 1)
    : Math.max(currentGroupIdx - 1, 0);

  groupCards.forEach((c, i) => {
    if (i === nextGroupIdx) {
      c.classList.add('group-card--focused');
      c.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      c.classList.remove('group-card--focused');
      c.querySelectorAll('.item--focused').forEach(item => item.classList.remove('item--focused'));
    }
  });
}

function getNextItemIndex(currentItemIdx, key, itemsCount) {
  if (currentItemIdx === -1) {
    return key === 'ArrowDown' ? 0 : itemsCount - 1;
  }
  if (key === 'ArrowDown') {
    return Math.min(currentItemIdx + 1, itemsCount - 1);
  }
  return Math.max(currentItemIdx - 1, 0);
}

function handleGridVerticalNav(e, currentGroup) {
  if (currentGroup.classList.contains('group-card--add')) return;

  const items = Array.from(currentGroup.querySelectorAll('.item'));
  if (items.length === 0) return;

  e.preventDefault();
  const currentItemIdx = items.findIndex(item => item.classList.contains('item--focused'));
  const nextItemIdx = getNextItemIndex(currentItemIdx, e.key, items.length);

  items.forEach((item, i) => {
    if (i === nextItemIdx) {
      item.classList.add('item--focused');
      item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      item.classList.remove('item--focused');
    }
  });
}

function activateItem(e, focusedItem) {
  if (e.key === ' ') {
    if (focusedItem.classList.contains('item--task')) {
      e.preventDefault();
      const checkbox = focusedItem.querySelector('.item__task-checkbox');
      checkbox?.click();
    }
    return;
  }

  e.preventDefault();
  const actionEl = focusedItem.querySelector('a') || 
                   focusedItem.querySelector('.item__note-title-btn') || 
                   focusedItem.querySelector('.item__password-title-btn') ||
                   focusedItem.querySelector('.item__task-title');
  actionEl?.click();
}

function handleGridActivation(e, currentGroup) {
  if (e.key === 'Enter' && currentGroup.classList.contains('group-card--add')) {
    e.preventDefault();
    const addBtn = currentGroup.querySelector('.group-card__add-btn');
    addBtn?.click();
    return;
  }

  const focusedItem = currentGroup.querySelector('.item--focused');
  if (focusedItem) {
    activateItem(e, focusedItem);
  }
}

function handleGridNavigation(e) {
  if (!isGridNavigable(e)) return;

  const grid = document.getElementById('pageGrid');
  if (!grid || grid.classList.contains('content__grid--edit-mode')) return;

  const groupCards = Array.from(grid.querySelectorAll('.group-card'));
  if (groupCards.length === 0) return;

  const currentGroupIdx = groupCards.findIndex(c => c.classList.contains('group-card--focused'));
  if (currentGroupIdx === -1) {
    if (e.key === 'Enter' || e.key === ' ') return;
    e.preventDefault();
    groupCards[0].classList.add('group-card--focused');
    groupCards[0].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }

  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    handleGridHorizontalNav(e, groupCards, currentGroupIdx);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    handleGridVerticalNav(e, groupCards[currentGroupIdx]);
  } else if (e.key === 'Enter' || e.key === ' ') {
    handleGridActivation(e, groupCards[currentGroupIdx]);
  }
}

function handleEscapeKeydown(e) {
  if (!isTypingContext(e.target) && !isOverlayActive()) {
    const focusedCards = document.querySelectorAll('.group-card--focused, .item--focused');
    focusedCards.forEach(el => el.classList.remove('group-card--focused', 'item--focused'));
  }
}

const keyHandlers = {
  '/': handleSlashKeydown,
  '.': handlePeriodKeydown,
  'g': handleGKeydown,
  's': handleSKeydown,
  'e': handleEKeydown,
  '+': handlePlusKeydown,
  'q': handleQKeydown,
  'w': handleWKeydown,
  'b': handleBKeydown,
  'p': handlePKeydown,
  'n': handleNKeydown,
  'N': handleNKeydown,
  't': handleTKeydown,
  'T': handleTKeydown,
};

const GRID_NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' ']);

function handleGlobalKeydown(e) {
  if (e.key === 'Escape') {
    handleEscapeKeydown(e);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    handleCtrlSKeydown(e);
    return;
  }
  if (GRID_NAV_KEYS.has(e.key)) {
    handleGridNavigation(e);
    return;
  }
  keyHandlers[e.key]?.(e);
}

export function initKeyNav() {
  keyNavEl      = /** @type {HTMLDivElement}   */ (document.getElementById('keyNav'));
  keyNavInput   = /** @type {HTMLInputElement} */ (document.getElementById('keyNavInput'));
  keyNavResults = /** @type {HTMLUListElement} */ (document.getElementById('keyNavResults'));

  if (!keyNavEl || !keyNavInput || !keyNavResults) return;

  // Backdrop click closes overlay
  keyNavEl.querySelector('.keynav__backdrop')?.addEventListener('click', closeKeyNav);

  // Sidebar + button dispatches this event to open the same picker as the + shortcut
  document.addEventListener('exodeck:open-add-picker', () => {
    if (!document.querySelector('.modal-overlay, .add-picker') && keyNavEl.hasAttribute('hidden')) {
      handleAddShortcut().catch(console.error);
    }
  });

  // Real-time filtering
  keyNavInput.addEventListener('input', () => {
    const query = keyNavInput.value.trim().toLowerCase();
    void renderKeyNavResults(query);
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', handleGlobalKeydown);
}

