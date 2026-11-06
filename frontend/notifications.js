// notifications.js — Task due/overdue, all tasks, and Git sync notification system
import { apiFetch, state } from './app.js';
import { loadPage } from './sidebar.js';

const STORAGE_NOTIFICATION_WIDTH_KEY = 'notification-panel-width';

// Restore persisted notification / task panel width
const savedNotificationWidth = localStorage.getItem(STORAGE_NOTIFICATION_WIDTH_KEY);
if (savedNotificationWidth) {
  document.documentElement.style.setProperty('--notification-panel-width', savedNotificationWidth);
}

let dueTasks = [];
let allTasks = [];
let syncWorkspaces = [];
let isPanelOpen = false;
let currentPanelMode = 'notifications'; // 'notifications' or 'tasks'
let refreshDebounceTimer = null;

/**
 * Format due date for friendly notification display.
 * @param {string} isoDate YYYY-MM-DD
 * @returns {string}
 */
function formatDueDate(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.split('-').map(Number);
  const due = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((due - today) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays === -1) return 'Yesterday';
  if (diffDays < -1) return `${Math.abs(diffDays)}d overdue`;
  return due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Format created date for display.
 * @param {string} isoDate
 * @returns {string}
 */
function formatCreatedDate(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Sort tasks across workspaces:
 * 1. Tasks with a due date (earliest due date first, tie-break by created date)
 * 2. Tasks without a due date (earliest created date first)
 * @param {Array<object>} tasks
 * @returns {Array<object>}
 */
function sortTasksList(tasks) {
  return [...tasks].sort((a, b) => {
    const hasDueA = Boolean(a.due_date);
    const hasDueB = Boolean(b.due_date);
    if (hasDueA !== hasDueB) {
      return hasDueA ? -1 : 1;
    }
    if (hasDueA && hasDueB && a.due_date !== b.due_date) {
      return a.due_date.localeCompare(b.due_date);
    }
    const cA = a.task_created || a.created_at || '';
    const cB = b.task_created || b.created_at || '';
    if (cA !== cB) {
      if (!cA) return 1;
      if (!cB) return -1;
      const tA = new Date(cA).getTime();
      const tB = new Date(cB).getTime();
      if (!Number.isNaN(tA) && !Number.isNaN(tB) && tA !== tB) {
        return tA - tB;
      }
      return cA.localeCompare(cB);
    }
    const locComp = (a.location || '').localeCompare(b.location || '');
    if (locComp !== 0) return locComp;
    return (a.title || '').localeCompare(b.title || '');
  });
}

/**
 * Update the notification badge count and bell status color.
 */
function updateBadgeAndPanel() {
  const btn = document.getElementById('notificationBtn');
  const badge = document.getElementById('notificationBadge');
  const panel = document.getElementById('notificationMenuPanel');

  if (!btn || !badge) return;

  const totalCount = dueTasks.length + syncWorkspaces.length;
  if (totalCount === 0) {
    btn.hidden = true;
    if (currentPanelMode === 'notifications') {
      closeNotificationPanel();
    }
    return;
  }

  btn.hidden = false;
  badge.textContent = totalCount > 99 ? '99+' : String(totalCount);

  const hasOverdue = dueTasks.some(t => t.due_status === 'overdue');
  const hasSyncError = syncWorkspaces.some(w => w.isError);
  const isUrgent = hasOverdue || hasSyncError;

  btn.classList.toggle('notification--overdue', isUrgent);
  btn.classList.toggle('notification--due-soon', !isUrgent);

  const parts = [];
  if (dueTasks.length > 0) {
    parts.push(`${dueTasks.length} task${dueTasks.length === 1 ? '' : 's'}`);
  }
  if (syncWorkspaces.length > 0) {
    parts.push(`${syncWorkspaces.length} workspace${syncWorkspaces.length === 1 ? '' : 's'} requiring git sync`);
  }
  const label = `${parts.join(', ')} (n)`;
  btn.title = label;
  btn.setAttribute('aria-label', label);

  if (isPanelOpen && panel && !panel.hidden && currentPanelMode === 'notifications') {
    renderNotificationPanel();
  }
}

/**
 * Update due tasks and recompute notifications.
 * @param {Array<object>} tasks
 */
export function updateNotificationBadge(tasks) {
  dueTasks = Array.isArray(tasks) ? tasks : [];
  updateBadgeAndPanel();
}

/**
 * Update all tasks across all workspaces.
 * @param {Array<object>} tasks
 */
export function updateAllTasks(tasks) {
  allTasks = Array.isArray(tasks) ? sortTasksList(tasks) : [];
  if (isPanelOpen && currentPanelMode === 'tasks') {
    renderNotificationPanel();
  }
}

function formatUncommittedSummary(count) {
  if (count <= 0) {
    return 'Uncommitted changes';
  }
  const suffix = count === 1 ? '' : 's';
  return `${count} uncommitted file${suffix}`;
}

function parseSyncWorkspaceEntry(loc, statusData) {
  if (!statusData?.enabled) {
    return null;
  }
  if (statusData.error) {
    return {
      location: loc,
      isError: true,
      summary: `Error: ${statusData.error}`,
      output: statusData.error,
    };
  }
  if (statusData.uncommitted) {
    const raw = (statusData.output || '').trim();
    const lines = raw ? raw.split('\n').filter(Boolean) : [];
    return {
      location: loc,
      isError: false,
      summary: formatUncommittedSummary(lines.length),
      output: raw,
    };
  }
  return null;
}

/**
 * Update workspaces requiring Git sync based on the current sync status map.
 * @param {Record<string, object>} syncStatusMap
 */
export function updateSyncNotifications(syncStatusMap) {
  syncWorkspaces = [];
  if (syncStatusMap && typeof syncStatusMap === 'object') {
    for (const [loc, statusData] of Object.entries(syncStatusMap)) {
      const entry = parseSyncWorkspaceEntry(loc, statusData);
      if (entry) {
        syncWorkspaces.push(entry);
      }
    }
  }
  updateBadgeAndPanel();
}

function highlightTaskOnGrid(task) {
  setTimeout(() => {
    let itemEl = document.querySelector(
      `.item[data-group-index="${task.group_index}"][data-item-index="${task.item_index}"]`
    );
    if (!itemEl) {
      itemEl = Array.from(document.querySelectorAll('.item--task')).find(
        el => el.querySelector('.item__task-title')?.textContent?.trim() === task.title.trim()
      );
    }
    if (itemEl) {
      document.querySelectorAll('.group-card--focused, .item--focused').forEach(el => {
        el.classList.remove('group-card--focused', 'item--focused');
      });
      const groupCard = itemEl.closest('.group-card');
      if (groupCard) {
        groupCard.classList.add('group-card--focused');
      }
      itemEl.classList.add('item--focused');

      itemEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      itemEl.classList.add('item--notif-highlight');
      setTimeout(() => itemEl.classList.remove('item--notif-highlight'), 2200);
    }
  }, 120);
}

function createNotificationItem(task) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'notification-item';
  const isOverdue = task.due_status === 'overdue';
  const isDueSoon = task.due_status === 'due_soon';
  const isUpcoming = task.due_status === 'upcoming';
  if (isOverdue) {
    item.classList.add('notification-item--overdue');
  } else if (isDueSoon) {
    item.classList.add('notification-item--due-soon');
  } else if (isUpcoming) {
    item.classList.add('notification-item--upcoming');
  } else {
    item.classList.add('notification-item--no-due');
  }

  const statusPill = document.createElement('span');
  statusPill.className = 'notification-item__pill';
  if (isOverdue) {
    statusPill.textContent = 'Overdue';
  } else if (isDueSoon) {
    statusPill.textContent = 'Due Soon';
  } else if (isUpcoming) {
    statusPill.textContent = 'Upcoming';
  } else {
    statusPill.textContent = 'Task';
  }

  const mainCol = document.createElement('div');
  mainCol.className = 'notification-item__main';

  const titleEl = document.createElement('div');
  titleEl.className = 'notification-item__title';
  titleEl.textContent = task.title;

  const metaEl = document.createElement('div');
  metaEl.className = 'notification-item__meta';
  metaEl.textContent = task.location
    ? `[${task.location}] ${task.page_name} › ${task.group_title}`
    : `${task.page_name} › ${task.group_title}`;

  mainCol.appendChild(titleEl);
  mainCol.appendChild(metaEl);

  const dateEl = document.createElement('span');
  dateEl.className = 'notification-item__date';
  if (task.due_date) {
    dateEl.textContent = formatDueDate(task.due_date);
    dateEl.title = `Due: ${task.due_date}`;
  } else {
    const createdStr = task.task_created || task.created_at;
    if (createdStr) {
      dateEl.textContent = formatCreatedDate(createdStr);
      dateEl.title = `Created: ${createdStr.split('T')[0]}`;
    }
  }

  item.appendChild(statusPill);
  item.appendChild(mainCol);
  if (dateEl.textContent) {
    item.appendChild(dateEl);
  }

  item.addEventListener('click', async () => {
    closeNotificationPanel();
    await loadPage(task.slug, task.location || null);
    highlightTaskOnGrid(task);
  });

  item.addEventListener('mouseenter', () => {
    setFocusedItem(item);
  });

  return item;
}

function createSyncNotificationItem(item) {
  const el = document.createElement('div');
  el.className = 'notification-item notification-item--sync';
  if (item.isError) el.classList.add('notification-item--sync-error');
  el.tabIndex = 0;
  el.setAttribute('role', 'button');

  const tooltip = item.output || item.summary || '';
  if (tooltip) {
    el.title = tooltip;
  }

  const statusPill = document.createElement('span');
  statusPill.className = 'notification-item__pill';
  statusPill.textContent = item.isError ? 'Sync Error' : 'Git Sync';

  const mainCol = document.createElement('div');
  mainCol.className = 'notification-item__main';

  const titleEl = document.createElement('div');
  titleEl.className = 'notification-item__title';
  titleEl.textContent = `Workspace "${item.location}"`;

  const metaEl = document.createElement('div');
  metaEl.className = 'notification-item__meta';
  metaEl.textContent = item.summary;
  if (tooltip) {
    metaEl.title = tooltip;
  }

  mainCol.appendChild(titleEl);
  mainCol.appendChild(metaEl);

  const actionCol = document.createElement('div');
  actionCol.className = 'notification-item__action';

  const syncBtn = document.createElement('button');
  syncBtn.type = 'button';
  syncBtn.className = 'notification-item__sync-btn';
  syncBtn.textContent = 'Sync';
  syncBtn.title = `Sync workspace "${item.location}"`;

  const doSync = (e) => {
    e?.stopPropagation?.();
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing...';
    document.dispatchEvent(new CustomEvent('exodeck:trigger-sync', {
      detail: { location: item.location },
    }));
  };

  syncBtn.addEventListener('click', doSync);

  el.addEventListener('click', (e) => {
    if (e.target !== syncBtn) {
      doSync(e);
    }
  });

  el.addEventListener('mouseenter', () => {
    setFocusedItem(el);
  });

  actionCol.appendChild(syncBtn);

  el.appendChild(statusPill);
  el.appendChild(mainCol);
  el.appendChild(actionCol);

  return el;
}

function createPanelHeaderBadge(isTasksMode) {
  const countBadge = document.createElement('span');
  countBadge.className = 'notification-panel__count';

  if (isTasksMode) {
    if (allTasks.some(t => t.due_status === 'overdue')) {
      countBadge.classList.add('notification-panel__count--overdue');
    } else if (allTasks.some(t => t.due_status === 'due_soon')) {
      countBadge.classList.add('notification-panel__count--due-soon');
    } else {
      countBadge.classList.add('notification-panel__count--tasks');
    }
    countBadge.textContent = String(allTasks.length);
  } else {
    const totalCount = dueTasks.length + syncWorkspaces.length;
    const isUrgent = dueTasks.some(t => t.due_status === 'overdue') || syncWorkspaces.some(w => w.isError);
    countBadge.classList.add(isUrgent ? 'notification-panel__count--overdue' : 'notification-panel__count--due-soon');
    countBadge.textContent = String(totalCount);
  }

  return countBadge;
}

function createPanelHeader(isTasksMode) {
  const header = document.createElement('div');
  header.className = 'notification-panel__header';

  const title = document.createElement('span');
  title.className = 'notification-panel__title';
  title.textContent = isTasksMode ? 'Tasks' : 'Notifications';

  header.appendChild(title);
  header.appendChild(createPanelHeaderBadge(isTasksMode));
  return header;
}

function renderTasksList(list) {
  if (allTasks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'notification-panel__empty';
    empty.textContent = 'No tasks';
    list.appendChild(empty);
    return;
  }
  for (const task of allTasks) {
    list.appendChild(createNotificationItem(task));
  }
}

function appendNotificationSection(list, title, items, createFn) {
  if (items.length === 0) return;
  if (title) {
    const secHeader = document.createElement('div');
    secHeader.className = 'notification-panel__section';
    secHeader.textContent = title;
    list.appendChild(secHeader);
  }
  for (const item of items) {
    list.appendChild(createFn(item));
  }
}

function renderNotificationsList(list) {
  const totalCount = dueTasks.length + syncWorkspaces.length;
  if (totalCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'notification-panel__empty';
    empty.textContent = 'No notifications';
    list.appendChild(empty);
    return;
  }

  const showSectionTitles = syncWorkspaces.length > 0 && dueTasks.length > 0;
  appendNotificationSection(
    list,
    showSectionTitles ? `Git Sync (${syncWorkspaces.length})` : '',
    syncWorkspaces,
    createSyncNotificationItem
  );
  appendNotificationSection(
    list,
    showSectionTitles ? `Due Tasks (${dueTasks.length})` : '',
    dueTasks,
    createNotificationItem
  );
}

function createPanelList(isTasksMode) {
  const list = document.createElement('div');
  list.className = 'notification-panel__list';
  if (isTasksMode) {
    renderTasksList(list);
  } else {
    renderNotificationsList(list);
  }
  return list;
}

function createPanelResizeHandle() {
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'notification-panel__resize-handle';
  resizeHandle.id = 'notificationResizeHandle';
  resizeHandle.setAttribute('aria-hidden', 'true');
  resizeHandle.title = 'Resize panel';
  return resizeHandle;
}

/**
 * Renders the contents of the notification dropdown panel.
 */
function renderNotificationPanel() {
  const panel = document.getElementById('notificationMenuPanel');
  if (!panel) return;

  panel.innerHTML = '';
  const isTasksMode = currentPanelMode === 'tasks';
  panel.setAttribute('aria-label', isTasksMode ? 'Tasks' : 'Notifications');

  panel.appendChild(createPanelHeader(isTasksMode));
  panel.appendChild(createPanelList(isTasksMode));
  panel.appendChild(createPanelResizeHandle());
}

/**
 * Focus and highlight a notification item.
 * @param {HTMLElement|null} item
 */
function setFocusedItem(item) {
  const panel = document.getElementById('notificationMenuPanel');
  if (!panel) return;
  panel.querySelectorAll('.notification-item--focused').forEach(el => {
    el.classList.remove('notification-item--focused');
  });
  if (item) {
    item.classList.add('notification-item--focused');
    item.focus();
  }
}

/**
 * Open the notification panel positioned below the bell button or hamburger button.
 * @param {'notifications'|'tasks'} mode
 */
export function openNotificationPanel(mode = 'notifications') {
  currentPanelMode = mode;
  const btn = document.getElementById('notificationBtn');
  const overlay = document.getElementById('notificationOverlay');
  const panel = document.getElementById('notificationMenuPanel');
  if (!panel) return;

  renderNotificationPanel();

  if (overlay) {
    overlay.hidden = false;
  }
  panel.hidden = false;
  if (typeof panel.show === 'function' && !panel.open) {
    panel.show();
  }

  panel.style.visibility = 'hidden';
  panel.style.display = 'flex';
  const panelWidth = panel.offsetWidth || 360;
  panel.style.display = '';
  panel.style.visibility = '';

  let left = 48;
  let top = 54;
  const anchorEl = (currentPanelMode === 'tasks' || !btn || btn.hidden)
    ? (document.getElementById('hamburgerBtn') || btn)
    : btn;

  if (anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      left = rect.left;
      top = rect.bottom + 6;
    }
  }

  if (left + panelWidth + 8 > window.innerWidth) {
    left = window.innerWidth - panelWidth - 8;
  }
  if (left < 8) left = 8;

  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.maxHeight = `calc(100vh - ${top + 16}px)`;

  panel.classList.add('notification-panel--open');
  if (currentPanelMode === 'notifications') {
    btn?.classList.add('notification-btn--open');
  }
  isPanelOpen = true;

  const firstItem = panel.querySelector('.notification-item');
  if (firstItem) {
    setFocusedItem(firstItem);
  }

  if (currentPanelMode === 'tasks' && allTasks.length === 0) {
    void refreshTasks();
  }
}

/**
 * Open the panel in Tasks mode.
 */
export function openTasksPanel() {
  openNotificationPanel('tasks');
}

/**
 * Close the notification panel.
 */
export function closeNotificationPanel() {
  const btn = document.getElementById('notificationBtn');
  const overlay = document.getElementById('notificationOverlay');
  const panel = document.getElementById('notificationMenuPanel');
  if (!panel) return;

  panel.hidden = true;
  if (overlay) overlay.hidden = true;
  if (typeof panel.close === 'function' && panel.open) {
    panel.close();
  }
  panel.classList.remove('notification-panel--open');
  btn?.classList.remove('notification-btn--open');
  isPanelOpen = false;

  panel.querySelectorAll('.notification-item--focused').forEach(el => {
    el.classList.remove('notification-item--focused');
  });
}

/**
 * Toggle the notification panel in Notifications mode.
 */
export function toggleNotificationPanel() {
  if (isPanelOpen && currentPanelMode === 'notifications') {
    closeNotificationPanel();
  } else {
    openNotificationPanel('notifications');
  }
}

/**
 * Toggle the notification panel in Tasks mode.
 */
export function toggleTasksPanel() {
  if (isPanelOpen && currentPanelMode === 'tasks') {
    closeNotificationPanel();
  } else {
    openTasksPanel();
  }
}

/**
 * Fetch latest all tasks from backend and update UI.
 */
export async function refreshTasks() {
  try {
    const tasks = await apiFetch('/tasks');
    updateAllTasks(tasks);
  } catch (err) {
    console.warn('[ExoDeck] Failed to fetch tasks:', err);
  }
}

/**
 * Fetch latest due tasks and all tasks from backend and update UI.
 */
export async function refreshNotifications() {
  try {
    const [tasks, all] = await Promise.all([
      apiFetch('/tasks/due'),
      apiFetch('/tasks').catch(() => []),
    ]);
    updateNotificationBadge(tasks);
    if (Array.isArray(all)) {
      updateAllTasks(all);
    }
  } catch (err) {
    console.warn('[ExoDeck] Failed to fetch notifications/tasks:', err);
  }
}

/**
 * Debounced refresh for API mutations.
 */
function debouncedRefresh() {
  if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
  refreshDebounceTimer = setTimeout(() => {
    void refreshNotifications();
  }, 250);
}

function getNextNotificationIndex(currentIdx, length, isDown) {
  if (isDown) {
    return currentIdx < length - 1 ? currentIdx + 1 : 0;
  }
  return currentIdx > 0 ? currentIdx - 1 : length - 1;
}

function handlePanelArrowNav(panel, e) {
  const items = Array.from(panel.querySelectorAll('.notification-item'));
  if (items.length === 0) return;
  e.preventDefault();
  e.stopPropagation();
  const currentIdx = items.findIndex(el => el === document.activeElement || el.classList.contains('notification-item--focused'));
  const nextIdx = getNextNotificationIndex(currentIdx, items.length, e.key === 'ArrowDown');
  setFocusedItem(items[nextIdx]);
}

function handlePanelKeydown(panel, e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    handlePanelArrowNav(panel, e);
    return;
  }
  if (e.key === 'Enter') {
    const focused = panel.querySelector('.notification-item--focused') || (document.activeElement?.classList.contains('notification-item') ? document.activeElement : null);
    if (focused) {
      e.preventDefault();
      e.stopPropagation();
      focused.click();
    }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    const wasTasks = currentPanelMode === 'tasks';
    closeNotificationPanel();
    const target = wasTasks ? document.getElementById('hamburgerBtn') : document.getElementById('notificationBtn');
    if (target && !target.hidden) target.focus();
  }
}

/**
 * Initialize the notification bell and events.
 * @param {Array<object>} initialTasks
 */
export function initNotifications(initialTasks = []) {
  updateNotificationBadge(initialTasks);

  if (state.syncStatus) {
    updateSyncNotifications(state.syncStatus);
  }

  // Listen to Git sync status events dispatched by the existing sidebar sync mechanism
  document.addEventListener('exodeck:sync-status', (e) => {
    updateSyncNotifications(e.detail);
  });

  const btn = document.getElementById('notificationBtn');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleNotificationPanel();
    });
  }

  // Close on backdrop click
  const backdrop = document.getElementById('notificationBackdrop');
  backdrop?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeNotificationPanel();
  });

  // Close on outside click fallback
  document.addEventListener('click', (e) => {
    if (isPanelOpen) {
      if (!e.target.closest('#notificationMenuPanel') && !e.target.closest('#notificationBtn') && !e.target.closest('#hamburgerBtn')) {
        closeNotificationPanel();
      }
    }
  });

  // Keyboard navigation inside dropdown
  const panel = document.getElementById('notificationMenuPanel');
  panel?.addEventListener('keydown', (e) => handlePanelKeydown(panel, e));

  // Escape key capture when panel is open
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isPanelOpen) {
      e.preventDefault();
      e.stopPropagation();
      const wasTasks = currentPanelMode === 'tasks';
      closeNotificationPanel();
      const target = wasTasks ? document.getElementById('hamburgerBtn') : document.getElementById('notificationBtn');
      if (target && !target.hidden) target.focus();
    }
  }, { capture: true });

  // Refresh due tasks whenever an API mutation happens (task checked/created/edited)
  document.addEventListener('exodeck:api-mutation', debouncedRefresh);
  document.addEventListener('exodeck:pages-changed', debouncedRefresh);

  // Periodic refresh (60 seconds) to detect date rollover across midnight
  setInterval(() => {
    void refreshNotifications();
  }, 60000);

  // Re-position and adjust max-height on window resize if open
  window.addEventListener('resize', () => {
    if (isPanelOpen) {
      openNotificationPanel(currentPanelMode);
    }
  });

  // Resize handle for Notification and Task modal
  if (panel) {
    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    panel.addEventListener('mousedown', (e) => {
      const handle = e.target.closest('#notificationResizeHandle') || e.target.closest('.notification-panel__resize-handle');
      if (!handle) return;
      dragging = true;
      startX = e.clientX;
      startWidth = panel.getBoundingClientRect().width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const maxAllowed = panel.offsetLeft > 0
        ? Math.min(850, window.innerWidth - panel.offsetLeft - 8)
        : Math.min(850, window.innerWidth - 16);
      const newWidth = Math.max(240, Math.min(maxAllowed, startWidth + (e.clientX - startX)));
      const val = `${newWidth}px`;
      document.documentElement.style.setProperty('--notification-panel-width', val);
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const current = getComputedStyle(document.documentElement).getPropertyValue('--notification-panel-width').trim();
      localStorage.setItem(STORAGE_NOTIFICATION_WIDTH_KEY, current);
    });
  }
}
