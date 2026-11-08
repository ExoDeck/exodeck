// sidebar.js — Sidebar component
import { state, apiFetch, refreshPages, withLocation, isHelpWorkspace, showStyledConfirmModal } from './app.js';
import {
  parseApiError,
  handleTreeNavArrowDown,
  handleTreeNavEnd
} from './ui-utils.js';
import { renderPage } from './content.js';
import { openInlineNoteEditor, printNotePage } from './note.js';
import { fetchWhiteboardPage, createWhiteboardPage, printWhiteboardPage, unmountWhiteboard } from './whiteboard.js';
import { fetchBpmnPage, createBpmnPage, printBpmnPage, unmountBpmn } from './bpmn.js';
import { openModal, openConfirmModal } from './modal.js';
import { updateVaultBadge } from './vault.js';

const STORAGE_PINNED_KEY = 'sidebar-pinned';
const STORAGE_WIDTH_KEY = 'sidebar-width';
const STORAGE_FOLDER_VIEW_KEY = 'sidebar-folder-view-locations';
const STORAGE_FLOATING_WIDTH_KEY = 'floating-nav-width';

const folderViewLocations = new Set(JSON.parse(localStorage.getItem(STORAGE_FOLDER_VIEW_KEY) || '[]'));
window._iconVersions = {};

let isSidebarPinned = localStorage.getItem(STORAGE_PINNED_KEY) === 'true';
let isFloatingNavOpen = false;
let floatingNavLocation = null;
let docsVisible = false;

document.addEventListener('exodeck:workspace-icon-changed', (e) => {
    window._iconVersions[e.detail.location] = Date.now();
    const switcher = document.getElementById('floatingNavSwitcher');
    if (switcher) switcher.dataset.workspacesKey = '';
    renderPageList();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the first capital letter of str, or first char uppercased.
 * @param {string} str
 * @returns {string}
 */
function getAbbr(str) {
  const cap = /[A-Z]/.exec(str);
  return cap ? cap[0] : str.charAt(0).toUpperCase();
}

/**
 * Slugify a page name — mirrors backend logic.
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
  let slug = name.toLowerCase();
  slug = slug.replaceAll('ä', 'ae');
  slug = slug.replaceAll('ö', 'oe');
  slug = slug.replaceAll('ü', 'ue');
  slug = slug.replaceAll('ß', 'ss');
  slug = slug.replaceAll(/[^a-z0-9]+/g, '-');
  while (slug.startsWith('-')) slug = slug.slice(1);
  while (slug.endsWith('-')) slug = slug.slice(0, -1);
  return slug;
}

/**
 * Build the browser path for a page.
 * @param {string} slug
 * @param {string|null} location
 * @returns {string}
 */
export function buildPagePath(slug, location) {
  return location ? `/${encodeURIComponent(location)}/${encodeURIComponent(slug)}` : `/${encodeURIComponent(slug)}`;
}

/**
 * Build a workspace-agnostic internal link path for markdown/copy actions.
 * @param {string} slug
 * @returns {string}
 */
export function buildInternalLinkPath(slug) {
  return `/${slug}`;
}

function insertPageIntoTree(root, page) {
  const rawName = page.page_name ?? page['page-name'] ?? '';
  const segments = rawName.split('/').map(s => s.trim()).filter(Boolean);
  if (segments.length === 0) return;

  let current = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    let child = current.children.find(n => n.type === 'group' && n.name === seg);
    if (!child) {
      // Promote an existing same-named page node into a group, preserving its slug
      const existingPage = current.children.find(n => n.type === 'page' && n.name === seg);
      if (existingPage) {
        child = { type: 'group', name: seg, slug: existingPage.slug, page_type: existingPage.page_type, children: [], task_status: existingPage.task_status || '' };
        current.children.splice(current.children.indexOf(existingPage), 1);
      } else {
        child = { type: 'group', name: seg, children: [], task_status: '' };
      }
      current.children.push(child);
    }
    current = child;
  }

  const leafName = segments[segments.length - 1];
  const existingGroup = current.children.find(n => n.type === 'group' && n.name === leafName);
  if (existingGroup) {
    // Attach the slug to the group so its header becomes clickable
    existingGroup.slug = page.slug;
    existingGroup.page_type = page.page_type;
    if (page.task_status) existingGroup.task_status = page.task_status;
  } else {
    current.children.push({ type: 'page', name: leafName, slug: page.slug, page_type: page.page_type, task_status: page.task_status || '' });
  }
}

function computeTaskStatus(node) {
  let status = node.task_status || '';
  if (node.children) {
    for (const child of node.children) {
      const childStatus = computeTaskStatus(child);
      if (childStatus === 'overdue') status = 'overdue';
      else if (childStatus === 'due_soon' && status !== 'overdue') status = 'due_soon';
    }
    node.task_status = status;
  }
  return status;
}

/**
 * Build a recursive tree from a flat list of page metadata.
 * Page names are split on '/' (each segment trimmed) to determine nesting.
 * Supports unlimited depth.
 * @param {Array<{slug:string, page_name:string, hidden:boolean, task_status?:string}>} pages
 * @returns {Array}
 */
function buildTree(pages) {
  const visible = pages.filter(p => !p.hidden);
  const root = { type: 'group', name: '', children: [], task_status: '' };

  for (const page of visible) insertPageIntoTree(root, page);

  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  function sortNode(node) {
    node.children.sort(byName);
    for (const child of node.children) {
      if (child.type === 'group') sortNode(child);
    }
  }
  sortNode(root);
  computeTaskStatus(root);

  return root.children;
}

function samePageTarget(slug, location, compareSlug, compareLocation) {
  return slug === compareSlug && (location ?? '') === (compareLocation ?? '');
}

/**
 * Attaches a sync button to a given container for a specific location.
 * Returns the button element.
 * @param {HTMLElement} container
 * @param {string} location
 * @returns {HTMLButtonElement|null}
 */

function triggerGitSync(location) {
  const gitDot = document.getElementById('workspaceGitDot');
  if (gitDot) {
    gitDot.classList.add('git-dot--syncing');
    gitDot.title = 'Git Sync in progress...';
  }

  apiFetch(withLocation('/sync', location), { method: 'POST' })
    .then(async () => {
      await refreshPages();
      renderPageList();
      if (state.currentSlug) {
        await loadPage(state.currentSlug, state.currentLocation);
      }
      checkStatusForLocation(location);
    })
    .catch(err => {
      alert(`Sync failed: ${parseApiError(err, 'Unknown error')}`);
      checkStatusForLocation(location);
    })
    .finally(() => {
      if (gitDot) {
        gitDot.classList.remove('git-dot--syncing');
      }
    });
}

function checkStatusForLocation(location) {
  apiFetch(withLocation('/sync/status', location))
    .then(statusData => {
      if (!state.syncStatus) state.syncStatus = {};
      state.syncStatus[location] = statusData;
      applySyncStatusToDOM(location, statusData);
      document.dispatchEvent(new CustomEvent('exodeck:sync-status', { detail: state.syncStatus }));
    })
    .catch(err => console.warn('[ExoDeck] Sync status check failed:', err));
}

function getSyncStatusInfo(statusData) {
  if (!statusData?.enabled) {
    return { enabled: false, textClass: '', textTitle: '', dotClass: '', dotTitle: '' };
  }
  if (statusData.error) {
    return {
      enabled: true,
      textClass: 'sync-text--error',
      textTitle: `Git Sync Error: ${statusData.error}`,
      dotClass: 'git-dot--error',
      dotTitle: `Git Sync Error: ${statusData.error} (Click to Sync)`,
    };
  }
  if (statusData.uncommitted) {
    const summary = statusData.output?.substring(0, 300) || '';
    return {
      enabled: true,
      textClass: 'sync-text--uncommitted',
      textTitle: `Git Sync: Uncommitted changes\n\n${summary}`,
      dotClass: 'git-dot--uncommitted',
      dotTitle: `Git Sync: Uncommitted changes (Click to Sync)\n\n${summary}`,
    };
  }
  const fullOutput = statusData.output || '';
  return {
    enabled: true,
    textClass: 'sync-text--clean',
    textTitle: `Git Sync: Clean\n\n${fullOutput}`,
    dotClass: 'git-dot--clean',
    dotTitle: `Git Sync: Clean (Click to Sync)\n\n${fullOutput}`,
  };
}

function applySyncTextClass(el, info) {
  if (!el) return;
  el.classList.remove('sync-text--clean', 'sync-text--uncommitted', 'sync-text--error');
  el.title = info.enabled ? info.textTitle : '';
  if (info.enabled && info.textClass) {
    el.classList.add(info.textClass);
  }
}

function updateGitDot(gitDot, info) {
  if (!gitDot) return;
  gitDot.classList.remove('git-dot--clean', 'git-dot--uncommitted', 'git-dot--error');
  if (!info.enabled) {
    gitDot.style.display = 'none';
    gitDot.title = '';
    return;
  }
  gitDot.style.display = 'inline-block';
  gitDot.title = info.dotTitle;
  if (info.dotClass) gitDot.classList.add(info.dotClass);
}

function applySyncStatusToDOM(loc, statusData) {
  const info = getSyncStatusInfo(statusData);

  if (state.currentLocation === loc) {
    applySyncTextClass(document.getElementById('currentWorkspaceName'), info);
    updateGitDot(document.getElementById('workspaceGitDot'), info);
  }

  const wsArea = document.getElementById('workspaceSelectionArea');
  if (wsArea) {
    const items = wsArea.querySelectorAll('.sidebar__workspace-item');
    for (const item of items) {
      if (item.dataset.location === loc) applySyncTextClass(item, info);
    }
  }
}

// ---------------------------------------------------------------------------
// DOM builders
// ---------------------------------------------------------------------------

const SVG_LINK = `<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">open_in_new</span>`;
const SVG_TRASH = `<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">delete</span>`;
const SVG_MOVE = `<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">open_with</span>`;
const SVG_PRINT = `<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">print</span>`;
const SVG_GRID = `<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">grid_view</span>`;
const SVG_NOTE = `<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">description</span>`;
const SVG_WHITEBOARD = `<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">draw</span>`;
const SVG_BPMN = `<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">schema</span>`;

/**
 * Build the hover-reveal "⋯" action menu for a page (leaf or linked group).
 * @param {string} slug
 * @param {string} name
 * @param {string|undefined} pageType
 * @param {string|null} location
 * @returns {HTMLDivElement}
 */
function addInfoRow(table, label, value, copyable = false) {
  const tr = document.createElement('tr');
  const tdLabel = document.createElement('td');
  tdLabel.style.padding = 'var(--space-xs) var(--space-sm) var(--space-xs) 0';
  tdLabel.style.color = 'var(--color-text-muted)';
  tdLabel.style.whiteSpace = 'nowrap';
  tdLabel.style.verticalAlign = 'middle';
  tdLabel.innerHTML = `<strong>${label}:</strong>`;

  const tdValue = document.createElement('td');
  tdValue.style.padding = 'var(--space-xs) 0';
  tdValue.style.verticalAlign = 'middle';
  tdValue.style.wordBreak = 'break-all';

  if (copyable) {
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.gap = '8px';

    const valSpan = document.createElement('span');
    valSpan.textContent = value;
    
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn--ghost';
    copyBtn.style.padding = '0 8px';
    copyBtn.title = 'Copy to clipboard';
    copyBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 18px;">content_copy</span>';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(value).catch(console.error);
      const orig = copyBtn.innerHTML;
      copyBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 18px; color: #4caf50;">check</span>';
      setTimeout(() => { copyBtn.innerHTML = orig; }, 1500);
    });

    wrapper.appendChild(valSpan);
    wrapper.appendChild(copyBtn);
    tdValue.appendChild(wrapper);
  } else {
    tdValue.textContent = value;
  }

  tr.appendChild(tdLabel);
  tr.appendChild(tdValue);
  table.appendChild(tr);
}

function getRecentGridEvents(pageData) {
  if (!pageData?.groups) return [];
  
  const inferItemType = (it) => {
    if (it.url !== undefined) return 'link';
    if (it.password !== undefined || it.otp_secret !== undefined) return 'password';
    if (it.enc_text !== undefined) return 'enc_note';
    if (it.task_checked !== undefined) return 'task';
    return 'note';
  };
  
  const events = [];
  for (const group of pageData.groups) {
    if (!group.items) continue;
    for (const item of group.items) {
      const actualType = inferItemType(item);
      if (item.created_at) events.push({ type: 'A', itemType: actualType, group: group.title, name: item.title || 'Untitled', time: new Date(item.created_at) });
      if (item.modified_at && item.modified_at !== item.created_at) events.push({ type: 'M', itemType: actualType, group: group.title, name: item.title || 'Untitled', time: new Date(item.modified_at) });
    }
  }

  events.sort((a, b) => b.time - a.time);
  return events.slice(0, 10);
}

function appendRecentChangesDOM(contentContainer, recent) {
  if (recent.length === 0) return;

  const hr = document.createElement('hr');
  hr.style.margin = 'var(--space-md) 0 var(--space-sm)';
  hr.style.border = 'none';
  hr.style.borderTop = '1px solid var(--color-border)';
  contentContainer.appendChild(hr);

  const ul = document.createElement('ul');
  ul.style.listStyle = 'none';
  ul.style.padding = '0';
  ul.style.margin = '0';
  ul.style.fontSize = 'var(--font-size-sm)';
  ul.style.color = 'var(--color-text-muted)';
  ul.style.display = 'flex';
  ul.style.flexDirection = 'column';
  ul.style.gap = '8px';

  const typeShortMap = { link: 'link', password: 'pwd', enc_note: 'enc', task: 'task', note: 'note' };
  for (const ev of recent) {
    const li = document.createElement('li');
    
    const typeNode = document.createElement('strong');
    typeNode.textContent = ev.type;
    typeNode.style.color = ev.type === 'A' ? 'var(--color-success, #4caf50)' : 'var(--color-accent, #2196f3)';
    li.appendChild(typeNode);
    
    const displayType = typeShortMap[ev.itemType] || 'item';
    const textNode = document.createTextNode(` ${displayType}: ${ev.group} / ${ev.name} - ${ev.time.toLocaleString()}`);
    li.appendChild(textNode);
    
    ul.appendChild(li);
  }
  contentContainer.appendChild(ul);
}

async function buildInfoModalContent(pageMeta, location, slug) {
  const formatDate = (iso) => iso ? new Date(iso).toLocaleString() : '';
  const contentContainer = document.createElement('div');
  
  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.fontSize = 'var(--font-size-sm)';
  table.style.color = 'var(--color-text)';

  addInfoRow(table, 'Page Name', pageMeta.page_name);
  addInfoRow(table, 'Filename', pageMeta.file_name, true);
  addInfoRow(table, 'Creation Date', formatDate(pageMeta.created_at));
  addInfoRow(table, 'Last Modified', formatDate(pageMeta.modified_at));
  
  contentContainer.appendChild(table);

  if (pageMeta.page_type === 'grid') {
    let pageData = (state.currentPage && state.currentSlug === slug) ? state.currentPage : await apiFetch(withLocation(`/pages/${slug}`, location));
    const recent = getRecentGridEvents(pageData);
    appendRecentChangesDOM(contentContainer, recent);
  }
  return contentContainer;
}

export function createPageActionMenu(slug, name, pageType, location, inHeader = false) {
  const menuWrapper = document.createElement('div');
  menuWrapper.className = inHeader ? 'page-header__page-menu' : 'sidebar__page-menu';

  const menuTrigger = document.createElement('button');
  menuTrigger.type = 'button';
  menuTrigger.className = inHeader ? 'page-header__icon-btn' : 'sidebar__page-menu-trigger';
  menuTrigger.setAttribute('aria-label', `Actions for "${name}"`);
  menuTrigger.title = 'Page actions';
  if (inHeader) {
    menuTrigger.innerHTML = '<span class="material-symbols-outlined" style="font-size: 20px;">more_horiz</span>';
  } else {
    menuTrigger.textContent = '\u22EF';
  }

  const menuPanel = document.createElement('div');
  menuPanel.className = 'sidebar__page-menu-panel add-page-menu';

  const closeMenu = () => menuPanel.classList.remove('add-page-menu--open');



  const infoItem = document.createElement('button');
  infoItem.type = 'button';
  infoItem.className = 'add-page-menu__item';
  infoItem.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px; margin-right: 8px;">info</span> Info`;
  infoItem.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    const pageMeta = state.pages.find(p => p.slug === slug && (location ? p.location === location : true));
    if (pageMeta) {
      const { openModal } = await import('./modal.js');
      const contentContainer = await buildInfoModalContent(pageMeta, location, slug);

      await openModal({
        title: 'Page Info',
        contentNode: contentContainer,
        confirmLabel: 'OK',
        hideCancel: true,
        dynamicWidth: true
      });
    }
  });
  menuPanel.appendChild(infoItem);
  
  const infoSep = document.createElement('hr');
  infoSep.className = 'add-page-menu__separator';
  infoSep.setAttribute('aria-hidden', 'true');
  menuPanel.appendChild(infoSep);

  /** Briefly show 'Copied!' feedback on a button, then restore original label. */
  const showCopiedFeedback = (btn, originalHTML) => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.innerHTML = originalHTML; }, 1500);
  };

  const copyLinkItem = document.createElement('button');
  copyLinkItem.type = 'button';
  copyLinkItem.className = 'add-page-menu__item';
  copyLinkItem.innerHTML = `${SVG_LINK} Copy Link`;
  copyLinkItem.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    const url = window.location.origin + buildInternalLinkPath(slug);
    navigator.clipboard.writeText(url).catch(console.error);
    showCopiedFeedback(copyLinkItem, `${SVG_LINK} Copy Link`);
  });

  const copyMdItem = document.createElement('button');
  copyMdItem.type = 'button';
  copyMdItem.className = 'add-page-menu__item';
  copyMdItem.innerHTML = `${SVG_LINK} Copy Link as Markdown`;
  copyMdItem.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    const pageMeta = state.pages.find(p => p.slug === slug && (location ? p.location === location : true));
    const fullName = pageMeta?.page_name ?? pageMeta?.['page-name'] ?? name;
    const md = `[${fullName}](${buildInternalLinkPath(slug)})`;
    navigator.clipboard.writeText(md).catch(console.error);
    showCopiedFeedback(copyMdItem, `${SVG_LINK} Copy Link as Markdown`);
  });

  const copyGroupSep = document.createElement('hr');
  copyGroupSep.className = 'add-page-menu__separator';
  copyGroupSep.setAttribute('aria-hidden', 'true');

  const deleteItem = document.createElement('button');
  deleteItem.type = 'button';
  deleteItem.className = 'add-page-menu__item add-page-menu__item--danger';
  deleteItem.innerHTML = `${SVG_TRASH} Delete`;
  deleteItem.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    deletePage(slug, name, pageType, location).catch(console.error);
  });

  const moveItem = document.createElement('button');
  moveItem.type = 'button';
  moveItem.className = 'add-page-menu__item';
  moveItem.innerHTML = `${SVG_MOVE} Move to \u2026`;
  moveItem.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    showMoveToLocationModal(slug, name, pageType, location);
  });

  menuPanel.appendChild(copyLinkItem);
  menuPanel.appendChild(copyMdItem);
  menuPanel.appendChild(copyGroupSep);
  menuPanel.appendChild(deleteItem);
  menuPanel.appendChild(moveItem);

  if (pageType === 'note' || pageType === 'whiteboard' || pageType === 'bpmn') {
    const printItem = document.createElement('button');
    printItem.type = 'button';
    printItem.className = 'add-page-menu__item';
    printItem.innerHTML = `${SVG_PRINT} Print`;
    printItem.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      const resolvedLocation = location ?? state.currentLocation ?? null;
      let fn;
      if (pageType === 'note') fn = printNotePage;
      else if (pageType === 'whiteboard') fn = printWhiteboardPage;
      else if (pageType === 'bpmn') fn = printBpmnPage;
      fn?.(slug, resolvedLocation).catch(console.error);
    });
    menuPanel.appendChild(printItem);
  }

  menuWrapper.appendChild(menuTrigger);
  menuWrapper.appendChild(menuPanel);

  menuTrigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll('.sidebar__page-menu-panel.add-page-menu--open').forEach(el => {
      if (el !== menuPanel) el.classList.remove('add-page-menu--open');
    });
    document.querySelectorAll('.sidebar__location-menu-panel.add-page-menu--open').forEach(el => {
      el.classList.remove('add-page-menu--open');
    });
    const isOpen = menuPanel.classList.contains('add-page-menu--open');
    if (!isOpen) {
      menuPanel.style.visibility = 'hidden';
      menuPanel.style.display = 'block';
      const panelWidth = menuPanel.offsetWidth;
      menuPanel.style.display = '';
      menuPanel.style.visibility = '';

      const rect = menuTrigger.getBoundingClientRect();
      let left = rect.left;
      
      if (left + panelWidth + 8 > window.innerWidth) {
        left = rect.right - panelWidth;
      }
      if (left < 8) {
        left = 8;
      }

      menuPanel.style.left = `${left}px`;
      menuPanel.style.top = `${rect.bottom + 4}px`;
      menuPanel.style.bottom = '';
    }
    menuPanel.classList.toggle('add-page-menu--open');
  });

  return menuWrapper;
}

/**
 * Create a sidebar page `<button>` element.
 * @param {{type:'page', name:string, slug:string}} node
 * @param {number} [depth] Nesting depth (0 = root level)
 * @returns {HTMLButtonElement}
 */
function createPageButton(node, depth = 0, location = null, isFloating = false) {
  const a = document.createElement('a');
  a.className = 'sidebar__page' + (depth > 0 ? ' sidebar__page--child' : '');
  a.href = buildPagePath(node.slug, location);
  a.draggable = false;
  a.dataset.slug = node.slug;
  a.dataset.depth = String(depth);
  if (location) a.dataset.location = location;
  if (node.page_type) a.dataset.pageType = node.page_type;
  if (node.task_status === 'overdue') a.classList.add('sidebar__page--task-overdue');
  else if (node.task_status === 'due_soon') a.classList.add('sidebar__page--task-due-soon');
  a.title = node.name;

  const abbr = document.createElement('span');
  abbr.className = 'sidebar__abbr';
  abbr.textContent = getAbbr(node.name);

  const label = document.createElement('span');
  label.className = 'sidebar__label';
  label.textContent = node.name;

  a.appendChild(abbr);

  const icon = document.createElement('span');
  icon.className = 'sidebar__page-type-icon';
  icon.setAttribute('aria-hidden', 'true');
  
  if (node.page_type === 'note') {
    icon.innerHTML = SVG_NOTE;
    icon.title = 'Note';
  } else if (node.page_type === 'whiteboard') {
    icon.innerHTML = SVG_WHITEBOARD;
    icon.title = 'Whiteboard';
  } else if (node.page_type === 'bpmn') {
    icon.innerHTML = SVG_BPMN;
    icon.title = 'Business Process';
  } else {
    icon.innerHTML = SVG_GRID;
    icon.title = 'Grid';
  }
  a.appendChild(icon);

  a.appendChild(label);
  if (!isHelpWorkspace(location)) {
    a.appendChild(createPageActionMenu(node.slug, node.name, node.page_type, location));
  }

  a.addEventListener('click', (e) => {
    if (e.target.closest('.sidebar__page-menu')) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (isFloating) closeFloatingNavigator();
    void loadPage(node.slug, location);
  });
  a.addEventListener('mouseenter', () => {
    if (isFloatingNavOpen && isFloating) {
      setFloatingNavFocusedItem(a);
    }
  });
  return a;
}

function renderGroupNode(node, container, depth, location, isFloating = false) {
  const details = document.createElement('details');
  details.className = 'sidebar__group';
  details.open = false;

  const summary = document.createElement('summary');
  summary.className = 'sidebar__group-summary';
  if (node.task_status === 'overdue') summary.classList.add('sidebar__group-summary--task-overdue');
  else if (node.task_status === 'due_soon') summary.classList.add('sidebar__group-summary--task-due-soon');
  summary.title = node.name;
  const chevron = document.createElement('span');
  chevron.className = 'sidebar__group-chevron material-symbols-outlined';
  chevron.style.fontSize = '16px';
  chevron.textContent = 'keyboard_arrow_right'; // starts closed

  const abbr = document.createElement('span');
  abbr.className = 'sidebar__abbr';
  abbr.textContent = getAbbr(node.name);

  summary.appendChild(chevron);
  summary.appendChild(abbr);

  summary.addEventListener('mouseenter', () => {
    if (isFloatingNavOpen && isFloating) {
      setFloatingNavFocusedItem(summary);
    }
  });

  if (node.slug) {
    summary.dataset.slug = node.slug;
    if (location) summary.dataset.location = location;
    summary.classList.add('sidebar__group-summary--linked');

    const link = document.createElement('a');
    link.className = 'sidebar__group-link';
    link.href = buildPagePath(node.slug, location);
    link.draggable = false;

    const icon = document.createElement('span');
    icon.className = 'sidebar__page-type-icon';
    icon.setAttribute('aria-hidden', 'true');
    if (node.page_type === 'note') {
      icon.innerHTML = SVG_NOTE;
      icon.title = 'Note';
    } else if (node.page_type === 'whiteboard') {
      icon.innerHTML = SVG_WHITEBOARD;
      icon.title = 'Whiteboard';
    } else if (node.page_type === 'bpmn') {
      icon.innerHTML = SVG_BPMN;
      icon.title = 'Business Process';
    } else {
      icon.innerHTML = SVG_GRID;
      icon.title = 'Grid';
    }
    link.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'sidebar__label';
    label.textContent = node.name;
    link.appendChild(label);

    link.addEventListener('click', (e) => {
      if (e.target.closest('.sidebar__page-menu')) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      if (isFloating) closeFloatingNavigator();
      void loadPage(node.slug, location);
    });

    summary.appendChild(link);
    if (!isHelpWorkspace(location)) {
      summary.appendChild(createPageActionMenu(node.slug, node.name, node.page_type, location));
    }
  } else {
    const label = document.createElement('span');
    label.className = 'sidebar__label';
    label.textContent = node.name;
    summary.appendChild(label);
  }
  details.appendChild(summary);

  details.addEventListener('toggle', () => {
    chevron.textContent = details.open ? 'keyboard_arrow_down' : 'keyboard_arrow_right';
  });

  renderNodes(node.children, details, depth + 1, location, isFloating);
  container.appendChild(details);
}

/**
 * Recursively render a list of tree nodes into a container element.
 * @param {Array} nodes
 * @param {HTMLElement} container
 * @param {number} depth
 * @param {string|null} location
 * @param {boolean} isFloating
 */
function renderNodes(nodes, container, depth = 0, location = null, isFloating = false) {
  for (const node of nodes) {
    if (node.type === 'page') {
      const btn = createPageButton(node, depth, location, isFloating);
      if (depth >= 2) btn.classList.add('sidebar__page--deep');
      container.appendChild(btn);
    } else {
      renderGroupNode(node, container, depth, location, isFloating);
    }
  }
}




function fetchAndApplySyncStatus(locations) {
  setTimeout(() => {
    apiFetch('/sync/status/all')
      .then(statusMap => {
        state.syncStatus = statusMap ?? {};
        for (const loc of locations) {
          applySyncStatusToDOM(loc, statusMap?.[loc] ?? null);
        }
        document.dispatchEvent(new CustomEvent('exodeck:sync-status', { detail: state.syncStatus }));
      })
      .catch(err => console.warn('[ExoDeck] Sync status check failed:', err));
  }, 300);
}

function groupPagesByLocation(visiblePages, allLocations) {
  const byLocation = new Map();
  for (const loc of allLocations) byLocation.set(loc, []);
  for (const page of visiblePages) {
    const loc = page.location;
    if (!loc || !byLocation.has(loc)) continue;
    byLocation.get(loc).push(page);
  }
  return byLocation;
}

function getOrderedLocations(byLocation) {
  const configOrder = state.locations.length > 0 ? state.locations : [...byLocation.keys()];
  let order = [
    ...configOrder.filter(loc => byLocation.has(loc)),
    ...[...byLocation.keys()].filter(loc => !configOrder.includes(loc)),
  ];
  if (order.some(isHelpWorkspace)) {
    const helpLoc = order.find(isHelpWorkspace);
    order = [helpLoc, ...order.filter(l => !isHelpWorkspace(l))];
  }
  return order;
}

function hasNonDocsWorkspacesWithPages() {
  const otherLocations = (state.locations ?? []).filter(l => !isHelpWorkspace(l));
  return otherLocations.length > 0 && state.pages.some(p => otherLocations.includes(p.location) && !p.hidden);
}

export function getWorkspaceList() {
  const visiblePages = state.pages.filter(p => !p.hidden && !p.slug?.startsWith('.') && !p.page_name?.startsWith('.') && (docsVisible || !isHelpWorkspace(p.location)));
  const pageLocations = [...new Set(visiblePages.map(p => p.location).filter(Boolean))];
  const configuredLocations = state.locations ?? [];
  const allLocations = [...new Set([...configuredLocations, ...pageLocations])];
  const byLocation = groupPagesByLocation(visiblePages, allLocations);
  return getOrderedLocations(byLocation);
}

/**
 * Re-render the page list from `state.pages`.
 */

function renderWorkspaceSelectionArea(wsArea, orderedLocations, activeLocation, byLocation) {
  if (!wsArea) return;
  wsArea.innerHTML = '';
  orderedLocations.forEach((loc, i) => {
    const pagesInLoc = byLocation.get(loc) || [];
    const firstSlug = pagesInLoc.length > 0 ? pagesInLoc[0].slug : '';
    const a = document.createElement('a');
    a.className = 'sidebar__workspace-item';
    a.dataset.location = loc;
    a.href = '/' + encodeURIComponent(loc) + (firstSlug ? '/' + encodeURIComponent(firstSlug) : '');
    if (loc === activeLocation) {
      a.classList.add('sidebar__workspace-item--active');
    }
    a.textContent = loc;
    a.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      state.currentLocation = loc;
      renderPageList();
      const pagesInLoc = byLocation.get(loc);
      if (pagesInLoc && pagesInLoc.length > 0) {
        void loadPage(pagesInLoc[0].slug, loc);
      }
    });

    wsArea.appendChild(a);

    if (i < orderedLocations.length - 1) {
      const sep = document.createElement('span');
      sep.className = 'sidebar__workspace-sep';
      sep.textContent = '|';
      wsArea.appendChild(sep);
    }
  });
}

export function renderFloatingNavWorkspaces() {
  const switcher = document.getElementById('floatingNavSwitcher');
  if (!switcher) return;

  const workspaces = getWorkspaceList();
  if (workspaces.length === 0) {
    switcher.style.display = 'none';
    return;
  }
  switcher.style.display = 'flex';

  const activeLocation = (isFloatingNavOpen && floatingNavLocation)
    ? floatingNavLocation
    : (state.currentLocation ?? workspaces[0] ?? null);

  const cacheKey = workspaces.join('||');
  if (switcher.dataset.workspacesKey === cacheKey) {
    switcher.querySelectorAll('.floating-nav__switcher-btn').forEach(btn => {
      btn.classList.toggle('floating-nav__switcher-btn--active', btn.dataset.location === activeLocation);
    });
    return;
  }

  switcher.dataset.workspacesKey = cacheKey;
  switcher.innerHTML = '';

  workspaces.forEach(ws => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'floating-nav__switcher-btn';
    btn.dataset.location = ws;
    btn.title = ws;
    btn.setAttribute('aria-label', ws);
    if (ws === activeLocation) {
      btn.classList.add('floating-nav__switcher-btn--active');
    }

    const iconContainer = document.createElement('span');
    iconContainer.className = 'floating-nav__switcher-icon';

    const defaultSvg = `<svg width="18" height="18" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="0" y="6" width="36" height="78" fill="currentColor"/>
      <rect x="42" y="6" width="22" height="22" fill="currentColor"/>
      <rect x="70" y="6" width="22" height="22" fill="currentColor"/>
      <rect x="42" y="34" width="22" height="22" fill="currentColor"/>
      <rect x="70" y="34" width="22" height="22" fill="currentColor"/>
      <rect x="42" y="62" width="22" height="22" fill="currentColor"/>
      <rect x="70" y="62" width="22" height="22" fill="currentColor"/>
    </svg>`;

    const defaultIcon = document.createElement('span');
    defaultIcon.className = 'floating-nav__switcher-default-icon';
    if (isHelpWorkspace(ws)) {
      defaultIcon.innerHTML = `<span class="material-symbols-outlined" style="font-size: 20px;" aria-hidden="true">help</span>`;
    } else {
      defaultIcon.innerHTML = defaultSvg;
    }

    const img = document.createElement('img');
    img.className = 'floating-nav__switcher-custom-icon';
    const v = window._iconVersions?.[ws] ? '&v=' + window._iconVersions[ws] : '';
    const iconUrl = '/api/v1/media/.icon.svg?location=' + encodeURIComponent(ws) + v;
    img.src = iconUrl;
    img.alt = '';
    img.style.display = 'none';

    img.onload = () => {
      img.style.display = 'block';
      defaultIcon.style.display = 'none';
    };
    img.onerror = () => {
      img.style.display = 'none';
      defaultIcon.style.display = 'inline-flex';
    };

    iconContainer.appendChild(defaultIcon);
    iconContainer.appendChild(img);
    btn.appendChild(iconContainer);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const currentLoc = (isFloatingNavOpen && floatingNavLocation) ? floatingNavLocation : state.currentLocation;
      if (currentLoc === ws) return;
      floatingNavLocation = ws;
      renderFloatingNavContent();
      initFloatingNavKeyboardFocus();
    });

    switcher.appendChild(btn);
  });
}

function renderFloatingNavContent() {
  const floatNav = document.getElementById('floatingNavPageList');
  if (floatNav) renderSinglePageList(floatNav, true);
  updateFolderViewBtnUI();
  renderFloatingNavWorkspaces();
  updateActiveClass();
}

function renderLocationTree(nav, pages, isFolderView, activeLocation, isFloating = false) {
  let pagesToTree = pages;
  if (isFolderView) {
    pagesToTree = pages.map(p => {
      let ext = '.grid';
      if (p.page_type === 'note') ext = '.md';
      if (p.page_type === 'whiteboard') ext = '.excalidraw';
      if (p.page_type === 'bpmn') ext = '.bpmn';
      const fallbackName = p.slug + ext;
      return { ...p, page_name: p.file_name || fallbackName };
    });
  }

  const inner = document.createElement('div');
  inner.className = 'sidebar__location-list';
  if (isFolderView) inner.classList.add('sidebar__location-list--folder-view');
  renderNodes(buildTree(pagesToTree), inner, 0, activeLocation, isFloating);
  nav.appendChild(inner);
}


function applyWorkspaceLogo(activeLocation) {
  const customLogo = document.getElementById('customWorkspaceLogo');
  const defaultLogo = document.getElementById('defaultLogo');
  
  if (!activeLocation) {
      if (customLogo && defaultLogo) {
          customLogo.style.display = 'none';
          defaultLogo.style.display = 'block';
          customLogo.dataset.currentSrc = '';
      }
      updateBrowserMetadata('ExoDeck', 'logo.svg');
      return;
  }

  if (customLogo && defaultLogo) {
    const v = window._iconVersions?.[activeLocation] ? '&v=' + window._iconVersions[activeLocation] : '';
    const iconUrl = '/api/v1/media/.icon.svg?location=' + encodeURIComponent(activeLocation) + v;
    if (customLogo.dataset.currentSrc !== iconUrl) {
        customLogo.dataset.currentSrc = iconUrl;
        customLogo.src = iconUrl;
        customLogo.onload = () => {
            customLogo.style.display = 'block';
            defaultLogo.style.display = 'none';
            updateBrowserMetadata(activeLocation, iconUrl);
        };
        customLogo.onerror = () => {
            customLogo.style.display = 'none';
            defaultLogo.style.display = 'block';
            updateBrowserMetadata(activeLocation, 'logo.svg');
        };
    } else if (customLogo.dataset.currentSrc === iconUrl) {
        if (customLogo.style.display === 'block') {
            updateBrowserMetadata(activeLocation, iconUrl);
        } else {
            updateBrowserMetadata(activeLocation, 'logo.svg');
        }
    }
  }
}

function updateBackgroundWorkspaceUI(allLocations, visiblePages) {
  const wsName = document.getElementById('currentWorkspaceName');
  const wsArea = document.getElementById('workspaceSelectionArea');
  const byLocation = groupPagesByLocation(visiblePages, allLocations);
  const orderedLocations = getOrderedLocations(byLocation);
  const activeLocation = state.currentLocation ?? orderedLocations[0] ?? null;
  if (!state.currentLocation && activeLocation) {
    state.currentLocation = activeLocation;
  }

  if (wsName) {
    wsName.textContent = activeLocation || '';
    wsName.title = '';
  }

  renderWorkspaceSelectionArea(wsArea, orderedLocations, activeLocation, byLocation);
  applyWorkspaceLogo(activeLocation);
  fetchAndApplySyncStatus(orderedLocations);
}

function renderBackendMode(nav, visiblePages, allLocations, isFloating = false) {
  const byLocation = groupPagesByLocation(visiblePages, allLocations);
  const orderedLocations = getOrderedLocations(byLocation);
  const activeLocation = (isFloating && floatingNavLocation)
    ? floatingNavLocation
    : (state.currentLocation ?? orderedLocations[0] ?? null);

  const pages = byLocation.get(activeLocation) || [];
  renderLocationTree(nav, pages, folderViewLocations.has(activeLocation), activeLocation, isFloating);
}

function renderFallbackMode(nav, visiblePages, isFloating = false) {
  const defaultLocation = visiblePages[0]?.location ?? null;
  renderNodes(buildTree(visiblePages), nav, 0, defaultLocation, isFloating);
}

function renderSinglePageList(nav, isFloating = false) {
  if (!nav) return;
  nav.innerHTML = '';

  const visiblePages = state.pages.filter(p => !p.hidden && !p.slug?.startsWith('.') && !p.page_name?.startsWith('.') && (docsVisible || !isHelpWorkspace(p.location)));
  const pageLocations = [...new Set(visiblePages.map(p => p.location).filter(Boolean))];
  const configuredLocations = state.locations ?? [];
  const allLocations = [...new Set([...configuredLocations, ...pageLocations])];

  if (allLocations.length > 0) {
    renderBackendMode(nav, visiblePages, allLocations, isFloating);
  } else {
    renderFallbackMode(nav, visiblePages, isFloating);
  }
}

export function renderPageList(targetNav = null, isFloating = false) {
  const visiblePages = state.pages.filter(p => !p.hidden && !p.slug?.startsWith('.') && !p.page_name?.startsWith('.') && (docsVisible || !isHelpWorkspace(p.location)));
  const pageLocations = [...new Set(visiblePages.map(p => p.location).filter(Boolean))];
  const configuredLocations = state.locations ?? [];
  const allLocations = [...new Set([...configuredLocations, ...pageLocations])];

  if (allLocations.length > 0) {
    updateBackgroundWorkspaceUI(allLocations, visiblePages);
  } else {
    const wsName = document.getElementById('currentWorkspaceName');
    if (wsName) wsName.textContent = 'ExoDeck';
    applyWorkspaceLogo(null);
  }

  if (targetNav) {
    renderSinglePageList(targetNav, isFloating);
  } else {
    const mainNav = document.getElementById('pageList');
    if (mainNav) renderSinglePageList(mainNav, false);
    const floatNav = document.getElementById('floatingNavPageList');
    if (floatNav) renderSinglePageList(floatNav, true);
  }

  updateFolderViewBtnUI();
  renderFloatingNavWorkspaces();
  updateActiveClass();
}

/**
 * Sync the `.sidebar__page--active` class across all page buttons.
 */

function updateActiveClass() {
  const containers = [
    document.getElementById('pageList'),
    document.getElementById('floatingNavPageList')
  ].filter(Boolean);

  for (const nav of containers) {
    const expandParents = (el) => {
      let parent = el.parentElement;
      while (parent && parent !== nav) {
        if (parent.tagName === 'DETAILS' && !parent.open) {
          parent.open = true;
          parent.dispatchEvent(new Event('toggle'));
        }
        parent = parent.parentElement;
      }
    };

    nav.querySelectorAll('.sidebar__page').forEach(btn => {
      const isActive = samePageTarget(btn.dataset.slug, btn.dataset.location, state.currentSlug, state.currentLocation);
      btn.classList.toggle('sidebar__page--active', isActive);
      if (isActive) {
        expandParents(btn);
      }
    });
    
    nav.querySelectorAll('.sidebar__group-summary--linked').forEach(summary => {
      const isActive = samePageTarget(summary.dataset.slug, summary.dataset.location, state.currentSlug, state.currentLocation);
      summary.classList.toggle('sidebar__group-summary--active', isActive);
      if (isActive) {
        expandParents(summary);
        const groupDetails = summary.parentElement;
        if (groupDetails?.tagName === 'DETAILS' && !groupDetails.open) {
          groupDetails.open = true;
          groupDetails.dispatchEvent(new Event('toggle'));
        }
      }
    });
  }
}

// ---------------------------------------------------------------------------
// loadPage
// ---------------------------------------------------------------------------

async function fetchNotePage(slug, resolvedLocation) {
  let rawMarkdown;
    const mdPath = withLocation(`/notes/${encodeURIComponent(slug)}`, resolvedLocation);
    const res = await fetch(`/api/v1${mdPath}`);
    if (!res.ok) throw new Error(`Could not load note ${slug}`);
    rawMarkdown = await res.text();

  const h1Match = /^#\s+(.+)/m.exec(rawMarkdown);
  const pageName = h1Match ? h1Match[1].trim() : slug;
  return { 'page-name': pageName, page_type: 'note', rawMarkdown };
}

async function fetchJsonPage(slug, resolvedLocation) {
  return apiFetch(withLocation(`/pages/${slug}`, resolvedLocation));
}

/**
 * Load a page by slug, update state, and render it.
 * @param {string} slug
 */
export async function loadPage(slug, location = null, historyOp = 'push') {
  try {
    const resolvedLocation = location ?? state.currentLocation ?? state.pages.find(p => p.slug === slug)?.location ?? null;
    const pageMeta = state.pages.find(
      p => p.slug === slug && (p.location ?? "") === (resolvedLocation ?? "")
    ) ?? state.pages.find(p => p.slug === slug);
    const pageType = pageMeta?.page_type;

    let page;
    if (pageType === 'note') {
      page = await fetchNotePage(slug, resolvedLocation);
    } else if (pageType === 'whiteboard') {
      page = await fetchWhiteboardPage(slug, resolvedLocation);
    } else if (pageType === 'bpmn') {
      page = await fetchBpmnPage(slug, resolvedLocation);
    } else {
      page = await fetchJsonPage(slug, resolvedLocation);
    }

    state.currentPage = page;
    state.currentSlug = slug;
    const oldLocation = state.currentLocation;
    state.currentLocation = resolvedLocation;

    if (isHelpWorkspace(resolvedLocation) && !docsVisible) {
      docsVisible = true;
      renderPageList();
    } else if (oldLocation !== state.currentLocation) {
      renderPageList();
    }

    updateSidebarVisibility(pageType);
    closeFloatingNavigator();

    renderPage(page);
    updateActiveClass();
    document.dispatchEvent(new CustomEvent('exodeck:page-loaded', { detail: { slug, location: resolvedLocation } }));

    const contentEl = document.getElementById('content');
    if (contentEl) {
      contentEl.scrollTop = 0;
    }

    // Update browser URL so the page can be bookmarked / shared
    if (historyOp !== 'none') {
      const path = buildPagePath(slug, resolvedLocation);
      const histState = { slug, location: resolvedLocation };
      if (historyOp === 'replace') {
        history.replaceState(histState, '', path);
      } else {
        history.pushState(histState, '', path);
      }
    }

    const titleEl = document.getElementById('pageTitle');
    if (titleEl) titleEl.textContent = page['page-name'] ?? '';
  } catch (err) {
    console.error('[ExoDeck] Failed to load page:', err);
  }
}

// ---------------------------------------------------------------------------
// Add Note
// ---------------------------------------------------------------------------

export function createNote(targetLocation = null) {
  const effectiveLocation = (targetLocation && !isHelpWorkspace(targetLocation))
    ? targetLocation
    : ((state.currentLocation && !isHelpWorkspace(state.currentLocation))
      ? state.currentLocation
      : ((state.locations ?? []).find(l => !isHelpWorkspace(l)) ?? null));
  if (!effectiveLocation) {
    void showStyledConfirmModal(
      'No Workspace Configured',
      'Please configure a workspace in Configuration before creating pages.'
    ).then((confirmed) => {
      if (confirmed) {
        void import('./config.js').then(m => m.openConfigModal()).catch(console.error);
      }
    });
    return;
  }
  updateSidebarVisibility('note');
  openInlineNoteEditor({
    rawMarkdown: '',
    slug: null,
    isNew: true,
    location: effectiveLocation,
    onSave: (newSlug) => {
      void (async () => {
        const createdLocation = effectiveLocation;
        await refreshPages();

        renderPageList();
        const match = state.pages.find(
          p => p.slug === newSlug && (p.location ?? "") === (createdLocation ?? "")
        ) ?? state.pages.find(p => p.slug === newSlug);
        if (match) await loadPage(match.slug, match.location ?? null);
      })();
    },
    onCancel: () => {
      if (state.currentPage && (state.currentPage.location ?? '') === (effectiveLocation ?? '')) {
        void loadPage(state.currentPage.slug, state.currentPage.location ?? null);
        return;
      }
      const visiblePages = state.pages.filter(p => !p.hidden && (docsVisible || !isHelpWorkspace(p.location)));
      const locPages = effectiveLocation
        ? visiblePages.filter(p => (p.location ?? '') === effectiveLocation)
        : visiblePages;
      const first = locPages.length > 0 ? locPages[0] : visiblePages[0];
      if (first) {
        void loadPage(first.slug, first.location ?? null);
      } else {
        document.getElementById('pageGrid').innerHTML = '';
        document.getElementById('pageTitle').textContent = '';
        document.getElementById('contentActions').innerHTML = '';
        updateSidebarVisibility(null);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Add Grid page (inline)
// ---------------------------------------------------------------------------

export function createGridPage(targetLocation = null) {
  const effectiveLocation = (targetLocation && !isHelpWorkspace(targetLocation))
    ? targetLocation
    : ((state.currentLocation && !isHelpWorkspace(state.currentLocation))
      ? state.currentLocation
      : ((state.locations ?? []).find(l => !isHelpWorkspace(l)) ?? null));
  if (!effectiveLocation) {
    void showStyledConfirmModal(
      'No Workspace Configured',
      'Please configure a workspace in Configuration before creating pages.'
    ).then((confirmed) => {
      if (confirmed) {
        void import('./config.js').then(m => m.openConfigModal()).catch(console.error);
      }
    });
    return;
  }
  updateSidebarVisibility('grid');
  const contentEl = document.getElementById('content');
  const titleEl = document.getElementById('pageTitle');
  const actionsEl = document.getElementById('contentActions');
  const grid = document.getElementById('pageGrid');

  if (!grid) return;

  unmountWhiteboard();
  unmountBpmn();
  contentEl?.classList.remove('content--whiteboard', 'content--markdown', 'content--bpmn');

  if (titleEl) {
    titleEl.textContent = '';
    titleEl.setAttribute('contenteditable', 'plaintext-only');
    titleEl.classList.add('content__title--editing');
    titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault();
    });
  }

  grid.innerHTML = '';
  if (actionsEl) actionsEl.innerHTML = '';

  const hint = document.createElement('p');
  hint.className = 'content__empty';
  hint.textContent = 'Enter a page title, then save to create an empty grid page.';
  grid.appendChild(hint);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn--ghost';
  cancelBtn.textContent = 'Cancel';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn--primary';
  saveBtn.textContent = 'Save';

  if (actionsEl) {
    actionsEl.appendChild(cancelBtn);
    actionsEl.appendChild(saveBtn);
  }

  titleEl?.focus();

  const cleanup = () => {
    document.removeEventListener('keydown', onKeyDown, { capture: true });
    if (titleEl) {
      titleEl.removeAttribute('contenteditable');
      titleEl.classList.remove('content__title--editing', 'content__title--error');
    }
  };

  const cancel = async () => {
    cleanup();
    if (state.currentPage && (state.currentPage.location ?? '') === (effectiveLocation ?? '')) {
      await loadPage(state.currentPage.slug, state.currentPage.location ?? null);
      return;
    }
    const visiblePages = (state.pages ?? []).filter(p => !p.hidden && (docsVisible || !isHelpWorkspace(p.location)));
    const locPages = effectiveLocation
      ? visiblePages.filter(p => (p.location ?? '') === effectiveLocation)
      : visiblePages;
    const first = locPages[0] ?? visiblePages[0];
    if (first) {
      await loadPage(first.slug, first.location ?? null);
    } else {
      grid.innerHTML = '';
      if (titleEl) titleEl.textContent = '';
      if (actionsEl) actionsEl.innerHTML = '';
      updateSidebarVisibility(null);
    }
  };

  const save = async () => {
    const name = titleEl?.textContent.trim() ?? '';
    if (!name) {
      titleEl?.classList.add('content__title--error');
      titleEl?.focus();
      return;
    }
    titleEl?.classList.remove('content__title--error');

    const newSlug = slugify(name);
    const duplicate = (state.pages ?? []).some(p => {
      const s = p.slug ?? slugify(p.page_name ?? p['page-name'] ?? '');
      return s === newSlug && (p.location ?? '') === (effectiveLocation ?? '');
    });
    if (duplicate) {
      titleEl?.classList.add('content__title--error');
      titleEl?.focus();
      return;
    }

    const newPagePayload = { 'page-name': name, hidden: false, groups: [] };
    saveBtn.disabled = true;

    try {
        await apiFetch(withLocation('/pages', effectiveLocation), {
          method: 'POST',
          body: JSON.stringify(newPagePayload),
        });
        await refreshPages();


      cleanup();
      renderPageList();
      const match = state.pages.find(
        p => p.slug === newSlug && (p.location ?? "") === (effectiveLocation ?? "")
      ) ?? state.pages.find(p => p.slug === newSlug);
      if (match) await loadPage(match.slug, match.location ?? null);
    } catch {
      titleEl?.classList.add('content__title--error');
      titleEl?.focus();
      saveBtn.disabled = false;
    }
  };

  const isDirty = () => Boolean(titleEl?.textContent.trim());

  const requestCancel = async () => {
    if (isDirty()) {
      const discard = await openConfirmModal();
      if (!discard) {
        titleEl?.focus();
        return;
      }
    }
    await cancel();
  };

  cancelBtn.addEventListener('click', () => { void requestCancel(); });
  saveBtn.addEventListener('click', () => { void save(); });

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      void requestCancel();
    } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      void save();
    }
  }
  document.addEventListener('keydown', onKeyDown, { capture: true });
}

export function showAddPageModal(targetLocation = null) {
  createGridPage(targetLocation);
}

// ---------------------------------------------------------------------------
// Delete page
// ---------------------------------------------------------------------------

/**
 * Delete a page by slug after a modal confirmation.
 * @param {string} slug
 * @param {string} name
 * @param {string|undefined} pageType
 * @param {string|null} location
 */
async function deletePage(slug, name, pageType, location) {

  const confirmed = await openModal({
    title: `Delete page “${name}”?`,
    fields: [],
    confirmLabel: 'Delete',
    isDanger: true,
  });
  if (!confirmed) return;

  try {
    let apiPath;
    if (pageType === 'note') {
      apiPath = withLocation(`/notes/${encodeURIComponent(slug)}`, location);
    } else if (pageType === 'whiteboard') {
      apiPath = withLocation(`/whiteboards/${encodeURIComponent(slug)}`, location);
    } else if (pageType === 'bpmn') {
      apiPath = withLocation(`/bpmn/${encodeURIComponent(slug)}`, location);
    } else {
      apiPath = withLocation(`/pages/${encodeURIComponent(slug)}`, location);
    }
    await apiFetch(apiPath, { method: 'DELETE' });
    await refreshPages();
    renderPageList();
    // If the deleted page was the active one, clear the content area
    if (state.currentSlug === slug) {
      state.currentSlug = null;
      state.currentPage = null;
      document.getElementById('pageGrid').innerHTML = '';
      document.getElementById('pageTitle').textContent = '';
      document.getElementById('contentActions').innerHTML = '';
      updateSidebarVisibility(null);
    }
  } catch (err) {
    console.error('[ExoDeck] Failed to delete page:', err);
  }
}

// ---------------------------------------------------------------------------
// Move page to another location
// ---------------------------------------------------------------------------

async function movePage(slug, pageType, sourceLocation, targetLocation) {
  let apiPath;
  if (pageType === 'note') {
    apiPath = withLocation(`/notes/${encodeURIComponent(slug)}/move-to`, sourceLocation);
  } else if (pageType === 'whiteboard') {
    apiPath = withLocation(`/whiteboards/${encodeURIComponent(slug)}/move-to`, sourceLocation);
  } else if (pageType === 'bpmn') {
    apiPath = withLocation(`/bpmn/${encodeURIComponent(slug)}/move-to`, sourceLocation);
  } else {
    apiPath = withLocation(`/pages/${encodeURIComponent(slug)}/move-to`, sourceLocation);
  }
  await apiFetch(apiPath, { method: 'POST', body: JSON.stringify({ target_location: targetLocation }) });
}

function showMoveToLocationModal(slug, name, pageType, location) {

  const currentLocation = location ?? state.currentLocation ?? state.locations[0] ?? null;
  const otherLocations = state.locations.filter(loc => loc !== currentLocation);
  if (otherLocations.length === 0) return;

  document.getElementById('_moveToModal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = '_moveToModal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="_moveToModalTitle">
      <h2 class="modal__title" id="_moveToModalTitle">Move \u201c${name}\u201d to\u2026</h2>
      <p class="modal__error" id="_moveToError" hidden></p>
      <div class="modal__location-list" id="_moveToLocationList"></div>
      <div class="modal__actions">
        <button class="btn btn--ghost" id="_moveToCancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const errorEl = overlay.querySelector('#_moveToError');
  const listEl = overlay.querySelector('#_moveToLocationList');
  const cancelBtn = overlay.querySelector('#_moveToCancel');

  const close = () => overlay.remove();
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  for (const loc of otherLocations) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--ghost modal__location-option';
    btn.textContent = loc;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      errorEl.hidden = true;
      try {
        await movePage(slug, pageType, currentLocation, loc);
        await refreshPages();
        close();
        renderPageList();
        if (state.currentSlug === slug && (state.currentLocation ?? '') === (currentLocation ?? '')) {
          state.currentSlug = null;
          state.currentPage = null;
          document.getElementById('pageGrid').innerHTML = '';
          document.getElementById('pageTitle').textContent = '';
          document.getElementById('contentActions').innerHTML = '';
          updateSidebarVisibility(null);
        }
      } catch (err) {
        errorEl.textContent = parseApiError(err, 'Failed to move page.');
        errorEl.hidden = false;
        btn.disabled = false;
      }
    });
    listEl.appendChild(btn);
  }

  cancelBtn.focus();
}

// ---------------------------------------------------------------------------
// Pinning & Floating Navigator
// ---------------------------------------------------------------------------

export function isPinned() {
  return isSidebarPinned;
}

export function setSidebarPinned(pinned, shouldFocus = true) {
  isSidebarPinned = pinned;
  localStorage.setItem(STORAGE_PINNED_KEY, String(pinned));
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.classList.toggle('sidebar--unpinned', !pinned);
  }
  updatePinButtonUI();
  if (pinned && isFloatingNavOpen) {
    closeFloatingNavigator();
  }
  if (pinned && shouldFocus && state.currentPage?.page_type === 'note') {
    void import('./outline-nav.js').then(m => {
      m.syncActiveOutlineItem();
      m.focusOutline();
    }).catch(console.error);
  } else if (!pinned) {
    const container = document.getElementById('sidebarOutlineList');
    container?.querySelectorAll('.sidebar__item--focused').forEach(el => {
      el.classList.remove('sidebar__item--focused');
    });
    if (document.activeElement && container?.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    if (shouldFocus) {
      const content = document.getElementById('content');
      if (content) {
        content.tabIndex = -1;
        content.focus({ preventScroll: true });
      }
    }
  }
}

export function toggleSidebarPin() {
  setSidebarPinned(!isSidebarPinned);
}

const SVG_NAV_CLOSE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M9 3v18"></path><path d="m14 9-3 3 3 3"></path></svg>`;

export function updatePinButtonUI() {
  const sidebarPinBtn = document.getElementById('sidebarPinBtn');

  if (sidebarPinBtn) {
    sidebarPinBtn.title = 'Close outline (s)';
    sidebarPinBtn.innerHTML = SVG_NAV_CLOSE;
    sidebarPinBtn.classList.remove('nav-header__btn--active');
  }
  const outlineActionBtn = document.querySelector('.page-header__icon-btn[title="Outline (o)"]');
  if (outlineActionBtn) {
    outlineActionBtn.classList.toggle('active', isSidebarPinned);
  }
}

export function updateSidebarVisibility(pageType) {
  if (pageType) {
    state.activePageType = pageType;
  } else {
    state.activePageType = state.currentPage ? 'grid' : null;
  }
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const isNote = (pageType === 'note');
  if (isNote) {
    sidebar.removeAttribute('hidden');
    sidebar.classList.remove('sidebar--hidden');
    updateSidebarViewUI();
  } else {
    sidebar.setAttribute('hidden', '');
    sidebar.classList.add('sidebar--hidden');
  }
  updatePinButtonUI();
  void updateVaultBadge();
}

export function openFloatingNavigator() {
  const floatingNav = document.getElementById('floatingNav');
  const wsBtn = document.getElementById('workspaceHeader');
  if (!floatingNav) return;

  floatingNavLocation = state.currentLocation;
  isFloatingNavOpen = true;
  floatingNav.removeAttribute('hidden');
  if (wsBtn) wsBtn.classList.add('workspace-btn--active');

  updateFloatingNavViewUI();
  initFloatingNavKeyboardFocus();
}

export function closeFloatingNavigator() {
  const floatingNav = document.getElementById('floatingNav');
  const wsBtn = document.getElementById('workspaceHeader');
  if (!floatingNav) return;

  isFloatingNavOpen = false;
  floatingNavLocation = null;
  floatingNav.setAttribute('hidden', '');
  if (wsBtn) {
    wsBtn.classList.remove('workspace-btn--active');
    wsBtn.blur();
  }

  const container = document.getElementById('floatingNavPageList');
  container?.querySelectorAll('.sidebar__item--focused').forEach(el => {
    el.classList.remove('sidebar__item--focused');
  });
}

export function toggleFloatingNavigator() {
  if (isFloatingNavOpen) {
    closeFloatingNavigator();
  } else {
    openFloatingNavigator();
  }
}

/**
 * Returns all currently visible navigable items in the floating navigator tree.
 * Respects folded (<details>) parent branches.
 * @returns {Array<HTMLElement>}
 */
function getVisibleFloatingNavItems() {
  const container = document.getElementById('floatingNavPageList');
  if (!container) return [];

  const candidates = container.querySelectorAll('.sidebar__page, .sidebar__group-summary');
  return Array.from(candidates).filter(el => {
    let parent = el.parentElement;
    while (parent && parent !== container) {
      if (parent.tagName === 'DETAILS' && !parent.open) {
        if (el.tagName === 'SUMMARY' && el.parentElement === parent) {
          parent = parent.parentElement;
          continue;
        }
        return false;
      }
      parent = parent.parentElement;
    }
    return el.offsetParent !== null || el.getClientRects().length > 0;
  });
}

/**
 * Focuses a specific item in the floating navigator and updates selection classes.
 * @param {HTMLElement} item
 */
function setFloatingNavFocusedItem(item) {
  const container = document.getElementById('floatingNavPageList');
  if (!container || !item) return;

  container.querySelectorAll('.sidebar__item--focused').forEach(el => {
    el.classList.remove('sidebar__item--focused');
  });

  item.classList.add('sidebar__item--focused');
  item.tabIndex = 0;
  item.focus({ preventScroll: true });
  item.scrollIntoView({ block: 'nearest' });
}

/**
 * Finds the currently focused item in the floating navigator, or falls back to the first visible item.
 * @param {HTMLElement} container
 * @param {Array<HTMLElement>} items
 * @returns {HTMLElement|null}
 */
function getFloatingNavFocusedItem(container, items) {
  let current = document.activeElement;
  if (!current || !container.contains(current) || !current.matches('.sidebar__page, .sidebar__group-summary')) {
    current = container.querySelector('.sidebar__item--focused');
  }
  if (!current || !items.includes(current)) {
    return items.length > 0 ? items[0] : null;
  }
  return current;
}

/**
 * Initializes keyboard focus when the floating navigator opens.
 */
function initFloatingNavKeyboardFocus() {
  const container = document.getElementById('floatingNavPageList');
  if (!container) return;

  const activeItem = container.querySelector('.sidebar__page--active, .sidebar__group-summary--active');
  if (activeItem) {
    setFloatingNavFocusedItem(activeItem);
    return;
  }

  const items = getVisibleFloatingNavItems();
  if (items.length > 0) {
    setFloatingNavFocusedItem(items[0]);
    return;
  }

  const switcher = document.getElementById('floatingNavSwitcher');
  const activeBtn = switcher?.querySelector('.floating-nav__switcher-btn--active')
                 || switcher?.querySelector('.floating-nav__switcher-btn');
  if (activeBtn) {
    activeBtn.focus();
  }
}

function handleFloatingNavArrowDown(e) {
  const container = document.getElementById('floatingNavPageList');
  if (!container) return;
  handleTreeNavArrowDown({
    getVisibleItems: getVisibleFloatingNavItems,
    getFocusedItem: (items) => getFloatingNavFocusedItem(container, items),
    setFocusedItem: setFloatingNavFocusedItem,
    event: e
  });
}

function handleFloatingNavArrowUp(e) {
  const container = document.getElementById('floatingNavPageList');
  if (!container) return;
  const items = getVisibleFloatingNavItems();
  if (items.length === 0) return;

  const current = getFloatingNavFocusedItem(container, items);
  const currentIndex = items.indexOf(current);
  if (currentIndex === 0) {
    const switcher = document.getElementById('floatingNavSwitcher');
    if (switcher && switcher.style.display !== 'none') {
      const activeBtn = switcher.querySelector('.floating-nav__switcher-btn--active')
                     || switcher.querySelector('.floating-nav__switcher-btn');
      if (activeBtn) {
        e.preventDefault();
        container.querySelectorAll('.sidebar__item--focused').forEach(el => el.classList.remove('sidebar__item--focused'));
        activeBtn.focus();
        return;
      }
    }
  }

  let prevIndex = items.length - 1;
  if (currentIndex !== -1) {
    prevIndex = (currentIndex - 1 + items.length) % items.length;
  }
  setFloatingNavFocusedItem(items[prevIndex]);
  e.preventDefault();
}

function activateLinkWithModifiers(linkOrEl, e) {
  if (e.ctrlKey || e.metaKey) {
    window.open(linkOrEl.href, '_blank');
  } else if (e.shiftKey) {
    window.open(linkOrEl.href, '_blank', 'popup=yes');
  } else {
    linkOrEl.click();
  }
}

function handleFloatingNavGroupEnter(current, e) {
  if (current.classList.contains('sidebar__group-summary--linked')) {
    const link = current.querySelector('.sidebar__group-link');
    if (link) {
      activateLinkWithModifiers(link, e);
    } else {
      current.click();
    }
    return;
  }
  const details = current.closest('details.sidebar__group');
  if (details) {
    details.open = !details.open;
    details.dispatchEvent(new Event('toggle'));
  }
}

function handleFloatingNavEnter(e) {
  const container = document.getElementById('floatingNavPageList');
  if (!container) return;
  const items = getVisibleFloatingNavItems();
  if (items.length === 0) return;

  const current = getFloatingNavFocusedItem(container, items);
  if (!current) return;

  if (current.classList.contains('sidebar__page')) {
    e.preventDefault();
    activateLinkWithModifiers(current, e);
  } else if (current.classList.contains('sidebar__group-summary')) {
    e.preventDefault();
    handleFloatingNavGroupEnter(current, e);
  }
}

function handleFloatingNavHome(e) {
  const switcher = document.getElementById('floatingNavSwitcher');
  if (switcher && switcher.style.display !== 'none') {
    const activeBtn = switcher.querySelector('.floating-nav__switcher-btn--active')
                   || switcher.querySelector('.floating-nav__switcher-btn');
    if (activeBtn) {
      e.preventDefault();
      const container = document.getElementById('floatingNavPageList');
      container?.querySelectorAll('.sidebar__item--focused').forEach(el => el.classList.remove('sidebar__item--focused'));
      activeBtn.focus();
      return;
    }
  }
  const items = getVisibleFloatingNavItems();
  if (items.length > 0) {
    setFloatingNavFocusedItem(items[0]);
    e.preventDefault();
  }
}

function handleFloatingNavEnd(e) {
  handleTreeNavEnd({
    getVisibleItems: getVisibleFloatingNavItems,
    setFocusedItem: setFloatingNavFocusedItem,
    event: e
  });
}

function cycleFloatingNavWorkspace(direction) {
  const workspaces = getWorkspaceList();
  if (workspaces.length <= 1) return;

  const currentLoc = (isFloatingNavOpen && floatingNavLocation)
    ? floatingNavLocation
    : (state.currentLocation ?? workspaces[0] ?? null);

  let idx = workspaces.indexOf(currentLoc);
  if (idx === -1) idx = 0;

  const nextIdx = (idx + direction + workspaces.length) % workspaces.length;
  const targetLoc = workspaces[nextIdx];

  if (targetLoc && targetLoc !== currentLoc) {
    floatingNavLocation = targetLoc;
    renderFloatingNavContent();

    const isSwitcherFocused = Boolean(document.activeElement?.closest('.floating-nav__switcher'));
    if (isSwitcherFocused) {
      const updatedBtns = Array.from(document.querySelectorAll('.floating-nav__switcher-btn'));
      updatedBtns[nextIdx]?.focus();
    } else {
      initFloatingNavKeyboardFocus();
    }
  }
}

function switchFloatingNavWorkspace(targetBtn) {
  if (!targetBtn) return;
  const targetLoc = targetBtn.dataset.location;
  const currentLoc = (isFloatingNavOpen && floatingNavLocation) ? floatingNavLocation : state.currentLocation;
  if (targetLoc && currentLoc !== targetLoc) {
    floatingNavLocation = targetLoc;
    renderFloatingNavContent();
  }
}

function handleFloatingNavSwitcherKeydown(e) {
  const switcherBtns = Array.from(document.querySelectorAll('.floating-nav__switcher-btn'));
  const currentBtn = e.target.closest('.floating-nav__switcher-btn');
  const idx = switcherBtns.indexOf(currentBtn);
  if (idx === -1) return;

  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    cycleFloatingNavWorkspace(e.key === 'ArrowRight' ? 1 : -1);
    return;
  }

  if (e.key === 'ArrowDown' || e.key === 'Enter') {
    e.preventDefault();
    const items = getVisibleFloatingNavItems();
    if (items.length > 0) setFloatingNavFocusedItem(items[0]);
    return;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    const items = getVisibleFloatingNavItems();
    if (items.length > 0) setFloatingNavFocusedItem(items.at(-1));
    return;
  }

  if (e.key === 'Home') {
    e.preventDefault();
    const targetBtn = switcherBtns[0];
    switchFloatingNavWorkspace(targetBtn);
    const updatedBtns = Array.from(document.querySelectorAll('.floating-nav__switcher-btn'));
    updatedBtns[0]?.focus();
    return;
  }

  if (e.key === 'End') {
    e.preventDefault();
    const lastIdx = switcherBtns.length - 1;
    const targetBtn = switcherBtns[lastIdx];
    switchFloatingNavWorkspace(targetBtn);
    const updatedBtns = Array.from(document.querySelectorAll('.floating-nav__switcher-btn'));
    updatedBtns[lastIdx]?.focus();
  }
}

function handleFloatingNavListKeydown(e) {
  switch (e.key) {
    case 'ArrowDown':
      handleFloatingNavArrowDown(e);
      break;
    case 'ArrowUp':
      handleFloatingNavArrowUp(e);
      break;
    case 'ArrowRight':
      e.preventDefault();
      cycleFloatingNavWorkspace(1);
      break;
    case 'ArrowLeft':
      e.preventDefault();
      cycleFloatingNavWorkspace(-1);
      break;
    case 'Enter':
      handleFloatingNavEnter(e);
      break;
    case 'Home':
      handleFloatingNavHome(e);
      break;
    case 'End':
      handleFloatingNavEnd(e);
      break;
    default:
      break;
  }
}

export function getSidebarView() {
  return 'outline';
}

export function getSidebarActiveView() {
  return 'outline';
}

export function getFloatingNavView() {
  return 'navigator';
}

export function setSidebarView(_mode) {
  updateSidebarViewUI();
}

export function setFloatingNavView(_mode) {
  updateFloatingNavViewUI();
}

export function setSidebarOutlineMode(_isActive) {
  updateSidebarViewUI();
}

export function updateSidebarViewUI() {
  const sidebarNavTitle = document.getElementById('sidebarNavTitle');
  const sidebarOutlineList = document.getElementById('sidebarOutlineList');

  if (sidebarNavTitle) sidebarNavTitle.textContent = 'Outline';
  if (sidebarOutlineList) {
    sidebarOutlineList.removeAttribute('hidden');
    void import('./outline-nav.js').then(m => m.renderOutlineInSidebar()).catch(console.error);
  }
  updatePinButtonUI();
}

export function updateFolderViewBtnUI() {
  const folderBtn = document.getElementById('floatingNavFolderBtn');
  if (!folderBtn) return;
  const loc = (isFloatingNavOpen && floatingNavLocation) ? floatingNavLocation : (state.currentLocation ?? state.locations?.[0] ?? null);
  const isFolder = folderViewLocations.has(loc);
  const title = isFolder ? 'Title View' : 'Folder View';
  folderBtn.title = title;
  folderBtn.setAttribute('aria-label', title);
  const icon = folderBtn.querySelector('.material-symbols-outlined');
  if (icon) {
    icon.textContent = isFolder ? 'view_list' : 'folder';
  }
}

export function updateFloatingNavViewUI() {
  const floatingNavTitle = document.getElementById('floatingNavTitle');
  const floatingPageList = document.getElementById('floatingNavPageList');

  if (floatingNavTitle) floatingNavTitle.textContent = 'Navigator';
  updateFolderViewBtnUI();
  renderFloatingNavWorkspaces();
  if (floatingPageList) {
    floatingPageList.removeAttribute('hidden');
    renderSinglePageList(floatingPageList, true);
    updateActiveClass();
  }
}

function handleExpandCollapse(container) {
  if (!container) return;
  const groups = container.querySelectorAll('details.sidebar__group');
  if (groups.length === 0) return;

  const anyClosed = Array.from(groups).some(g => !g.open);
  const targetOpen = anyClosed;

  groups.forEach(g => {
    g.open = targetOpen;
    const chevron = g.querySelector('.sidebar__group-chevron');
    if (chevron) {
      chevron.textContent = targetOpen ? 'keyboard_arrow_down' : 'keyboard_arrow_right';
    }
  });

  const expandIcon = targetOpen ? 'unfold_less' : 'unfold_more';
  const expandTitle = targetOpen ? 'Collapse all (x)' : 'Expand all (x)';

  const btn1 = document.getElementById('sidebarExpandCollapseBtn');
  const btn2 = document.getElementById('floatingNavExpandCollapseBtn');
  [btn1, btn2].forEach(b => {
    if (!b) return;
    b.title = expandTitle;
    const icon = b.querySelector('.material-symbols-outlined');
    if (icon) icon.textContent = expandIcon;
  });
}

export function toggleSidebar() {
  if (state.currentPage?.page_type !== 'note') return;
  toggleSidebarPin();
}

// ---------------------------------------------------------------------------
// initSidebar
// ---------------------------------------------------------------------------

export function initSidebar() {
  const sidebar = document.getElementById('sidebar');
  const segments = window.location.pathname.split('/').filter(Boolean);
  const isDocsUrl = isHelpWorkspace(segments[0]);
  docsVisible = isDocsUrl || !hasNonDocsWorkspacesWithPages();

  // Initialize pin state and views
  setSidebarPinned(isSidebarPinned, false);
  updateSidebarViewUI();
  updateFloatingNavViewUI();
  updateSidebarVisibility(state.currentPage?.page_type ?? null);

  // Pin / unpin buttons
  document.getElementById('sidebarPinBtn')?.addEventListener('click', () => toggleSidebarPin());

  // Unpinned slim strip button & strip click: expands the left sidebar itself
  document.getElementById('sidebarOpenBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setSidebarPinned(true);
  });
  document.getElementById('sidebarUnpinnedStrip')?.addEventListener('click', () => {
    setSidebarPinned(true);
  });

  // Expand / collapse all buttons
  document.getElementById('sidebarExpandCollapseBtn')?.addEventListener('click', () => {
    const container = document.getElementById('sidebarOutlineList');
    handleExpandCollapse(container);
  });
  document.getElementById('floatingNavFolderBtn')?.addEventListener('click', () => {
    const loc = (isFloatingNavOpen && floatingNavLocation) ? floatingNavLocation : (state.currentLocation ?? state.locations?.[0] ?? null);
    if (folderViewLocations.has(loc)) {
      folderViewLocations.delete(loc);
    } else {
      folderViewLocations.add(loc);
    }
    localStorage.setItem(STORAGE_FOLDER_VIEW_KEY, JSON.stringify([...folderViewLocations]));
    updateFolderViewBtnUI();
    const floatNav = document.getElementById('floatingNavPageList');
    if (floatNav) renderSinglePageList(floatNav, true);
  });
  document.getElementById('floatingNavExpandCollapseBtn')?.addEventListener('click', () => {
    const container = document.getElementById('floatingNavPageList');
    handleExpandCollapse(container);
  });
  document.getElementById('floatingNavWorkspaceBtn')?.addEventListener('click', () => {
    closeFloatingNavigator();
    void import('./workspace-nav.js').then(m => m.openWorkspaceNav()).catch(console.error);
  });

  // Workspace button click and keyboard activation
  const wsHeader = document.getElementById('workspaceHeader');
  if (wsHeader) {
    wsHeader.addEventListener('click', (e) => {
      if (e.target.closest('#workspaceGitDot')) return;
      toggleFloatingNavigator();
    });
    wsHeader.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        if (e.target.closest('#workspaceGitDot')) return;
        e.preventDefault();
        toggleFloatingNavigator();
      }
    });
  }

  // Restore persisted floating nav width
  const savedFloatingWidth = localStorage.getItem(STORAGE_FLOATING_WIDTH_KEY);
  if (savedFloatingWidth) {
    document.documentElement.style.setProperty('--floating-nav-width', savedFloatingWidth);
  }

  // Floating nav resize handle
  const floatingResizeHandle = document.getElementById('floatingNavResizeHandle');
  const floatingNavPanel = document.getElementById('floatingNavPanel');
  if (floatingResizeHandle && floatingNavPanel) {
    let draggingFloating = false;
    let startXFloating = 0;
    let startWidthFloating = 0;

    floatingResizeHandle.addEventListener('mousedown', (e) => {
      draggingFloating = true;
      startXFloating = e.clientX;
      startWidthFloating = floatingNavPanel.getBoundingClientRect().width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener('mousemove', (e) => {
      if (!draggingFloating) return;
      const newWidth = Math.max(240, Math.min(850, startWidthFloating + (e.clientX - startXFloating)));
      const val = `${newWidth}px`;
      document.documentElement.style.setProperty('--floating-nav-width', val);
    });

    document.addEventListener('mouseup', () => {
      if (!draggingFloating) return;
      draggingFloating = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const current = getComputedStyle(document.documentElement).getPropertyValue('--floating-nav-width').trim();
      localStorage.setItem(STORAGE_FLOATING_WIDTH_KEY, current);
    });
  }

  // Interactive Git sync dot in workspace button
  const gitDot = document.getElementById('workspaceGitDot');
  if (gitDot) {
    gitDot.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      triggerGitSync(state.currentLocation);
    });
  }

  // Floating navigator backdrop
  document.getElementById('floatingNavBackdrop')?.addEventListener('click', () => {
    closeFloatingNavigator();
  });

  // Hamburger menu
  const hamburgerBtn = document.getElementById('hamburgerBtn') ?? document.getElementById('sidebarMenuBtn');
  const hamburgerMenuPanel = document.getElementById('hamburgerMenuPanel') ?? document.getElementById('sidebarMenuPanel');

  function closeHamburgerMenu() {
    hamburgerMenuPanel?.classList.remove('add-page-menu--open');
    hamburgerBtn?.classList.remove('app-header__hamburger-btn--open');
  }

  if (hamburgerBtn && hamburgerMenuPanel) {
    hamburgerBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const isOpen = hamburgerMenuPanel.classList.contains('add-page-menu--open');
      document.querySelectorAll('.add-page-menu--open').forEach(el => el.classList.remove('add-page-menu--open'));
      document.querySelectorAll('.app-header__hamburger-btn--open').forEach(el => el.classList.remove('app-header__hamburger-btn--open'));

      if (!isOpen) {
        hamburgerMenuPanel.innerHTML = '';
        const loc = (state.currentLocation && !isHelpWorkspace(state.currentLocation))
          ? state.currentLocation
          : ((state.locations ?? []).find(l => !isHelpWorkspace(l)) ?? null);

        const addGridBtn = document.createElement('button');
        addGridBtn.className = 'add-page-menu__item';
        addGridBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">grid_view</span> <span>Add Grid</span> <span class="menu-shortcut">g</span>`;
        addGridBtn.onclick = () => { closeHamburgerMenu(); createGridPage(loc); };

        const addNoteBtn = document.createElement('button');
        addNoteBtn.className = 'add-page-menu__item';
        addNoteBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">description</span> <span>Add Note</span> <span class="menu-shortcut">q</span>`;
        addNoteBtn.onclick = () => { closeHamburgerMenu(); createNote(loc); };

        const addWhiteboardBtn = document.createElement('button');
        addWhiteboardBtn.className = 'add-page-menu__item';
        addWhiteboardBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">draw</span> <span>Add Whiteboard</span> <span class="menu-shortcut">w</span>`;
        addWhiteboardBtn.onclick = () => { closeHamburgerMenu(); createWhiteboardPage(loc); };

        const addBpmnBtn = document.createElement('button');
        addBpmnBtn.className = 'add-page-menu__item';
        addBpmnBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">schema</span> <span>Add Business Process</span> <span class="menu-shortcut">b</span>`;
        addBpmnBtn.onclick = () => { closeHamburgerMenu(); createBpmnPage(loc); };

        hamburgerMenuPanel.appendChild(addGridBtn);
        hamburgerMenuPanel.appendChild(addNoteBtn);
        hamburgerMenuPanel.appendChild(addWhiteboardBtn);
        hamburgerMenuPanel.appendChild(addBpmnBtn);

        const sep1 = document.createElement('hr');
        sep1.className = 'add-page-menu__separator';
        hamburgerMenuPanel.appendChild(sep1);

        const navigatorBtn = document.createElement('button');
        navigatorBtn.className = 'add-page-menu__item';
        navigatorBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">view_list</span> <span>Navigator</span> <span class="menu-shortcut">.</span>`;
        navigatorBtn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          closeHamburgerMenu();
          toggleFloatingNavigator();
        };
        hamburgerMenuPanel.appendChild(navigatorBtn);

        const switchWsBtn = document.createElement('button');
        switchWsBtn.className = 'add-page-menu__item';
        switchWsBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">workspaces</span> <span>Switch Workspace</span> <span class="menu-shortcut">#</span>`;
        switchWsBtn.onclick = () => {
          closeHamburgerMenu();
          void import('./workspace-nav.js').then(m => m.openWorkspaceNav()).catch(console.error);
        };
        hamburgerMenuPanel.appendChild(switchWsBtn);

        const tasksBtn = document.createElement('button');
        tasksBtn.className = 'add-page-menu__item';
        tasksBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">check</span> <span>Tasks</span> <span class="menu-shortcut">t</span>`;
        tasksBtn.onclick = () => {
          closeHamburgerMenu();
          void import('./notifications.js').then(m => m.toggleTasksPanel()).catch(console.error);
        };
        hamburgerMenuPanel.appendChild(tasksBtn);

        const statusData = state.syncStatus?.[loc];
        if (statusData?.enabled) {
          const syncBtn = document.createElement('button');
          syncBtn.className = 'add-page-menu__item';
          syncBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">sync</span> <span>Git Sync</span>`;
          syncBtn.onclick = () => { closeHamburgerMenu(); triggerGitSync(loc); };
          hamburgerMenuPanel.appendChild(syncBtn);
        }

        const sep2 = document.createElement('hr');
        sep2.className = 'add-page-menu__separator';
        hamburgerMenuPanel.appendChild(sep2);

        const configBtn = document.createElement('button');
        configBtn.className = 'add-page-menu__item';
        configBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">settings</span> <span>Configuration</span>`;
        configBtn.onclick = () => { closeHamburgerMenu(); void import('./config.js').then(m => m.openConfigModal()).catch(console.error); };
        hamburgerMenuPanel.appendChild(configBtn);

        const helpBtn = document.createElement('button');
        helpBtn.className = 'add-page-menu__item';
        helpBtn.innerHTML = docsVisible 
            ? `<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">help_center</span> <span>Hide Help</span>`
            : `<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">help</span> <span>Help</span>`;
        helpBtn.onclick = () => { 
          closeHamburgerMenu();
          if (docsVisible) {
            const allLocations = getWorkspaceList();
            const availableWorkspaces = allLocations.filter(w => !isHelpWorkspace(w) && state.pages.some(p => p.location === w && !p.hidden));
            if (availableWorkspaces.length > 0) {
              docsVisible = false;
              renderPageList();
              const target = availableWorkspaces[0];
              const firstPage = state.pages.find(p => p.location === target && !p.hidden);
              if (firstPage) void loadPage(firstPage.slug, target);
            }
          } else {
            docsVisible = true;
            renderPageList();
            const firstDocsPage = state.pages.find(p => isHelpWorkspace(p.location) && !p.hidden);
            if (firstDocsPage) void loadPage(firstDocsPage.slug, firstDocsPage.location ?? 'ExoDeck');
          }
        };
        hamburgerMenuPanel.appendChild(helpBtn);

        hamburgerMenuPanel.style.visibility = 'hidden';
        hamburgerMenuPanel.style.display = 'block';
        const panelWidth = hamburgerMenuPanel.offsetWidth;
        hamburgerMenuPanel.style.display = '';
        hamburgerMenuPanel.style.visibility = '';

        const rect = hamburgerBtn.getBoundingClientRect();
        let left = rect.left;
        if (left + panelWidth + 8 > window.innerWidth) {
          left = rect.right - panelWidth;
        }
        if (left < 8) left = 8;

        hamburgerMenuPanel.style.left = `${left}px`;
        hamburgerMenuPanel.style.top = `${rect.bottom + 4}px`;
        hamburgerMenuPanel.style.bottom = '';
        hamburgerMenuPanel.classList.add('add-page-menu--open');
        hamburgerBtn.classList.add('app-header__hamburger-btn--open');
      }
    });
  }

  // Restore persisted sidebar width
  const savedWidth = localStorage.getItem(STORAGE_WIDTH_KEY);
  if (savedWidth) {
    document.documentElement.style.setProperty('--sidebar-width', savedWidth);
  }

  // Resize handle
  const resizeHandle = document.getElementById('sidebarResizeHandle');
  if (resizeHandle && sidebar) {
    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    resizeHandle.addEventListener('mousedown', (e) => {
      if (!isSidebarPinned) return;
      dragging = true;
      startX = e.clientX;
      startWidth = sidebar.getBoundingClientRect().width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const newWidth = Math.max(140, Math.min(600, startWidth + (e.clientX - startX)));
      const val = `${newWidth}px`;
      document.documentElement.style.setProperty('--sidebar-width', val);
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const current = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width').trim();
      localStorage.setItem(STORAGE_WIDTH_KEY, current);
    });
  }

  renderPageList();

  const hasRouteInUrl = window.location.pathname.split('/').some(Boolean);
  if (!hasRouteInUrl) {
    const first = state.pages.find(p => !p.hidden && (docsVisible || !isHelpWorkspace(p.location)));
    if (first) void loadPage(first.slug, first.location ?? null);
  }

  // Global click & Escape handlers
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.sidebar__page-menu') && !e.target.closest('#hamburgerBtn') && !e.target.closest('#hamburgerMenuPanel') && !e.target.closest('#sidebarMenuBtn') && !e.target.closest('#sidebarMenuPanel')) {
      closeHamburgerMenu();
      document.querySelectorAll('.add-page-menu--open').forEach(el => el.classList.remove('add-page-menu--open'));
    }
    if (isFloatingNavOpen) {
      if (!e.target.closest('#floatingNavPanel') && !e.target.closest('#workspaceHeader') && !e.target.closest('#sidebarUnpinnedStrip') && !e.target.closest('#sidebarOpenBtn') && !e.target.closest('#hamburgerMenuPanel') && !e.target.closest('#hamburgerBtn')) {
        closeFloatingNavigator();
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeHamburgerMenu();
      document.querySelectorAll('.add-page-menu--open').forEach(el => el.classList.remove('add-page-menu--open'));
      if (isFloatingNavOpen) {
        closeFloatingNavigator();
      }
      return;
    }

    if (!isFloatingNavOpen) return;

    if (e.target.closest('.floating-nav__switcher')) {
      handleFloatingNavSwitcherKeydown(e);
      return;
    }
    if (e.target.closest('.nav-header')) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        cycleFloatingNavWorkspace(e.key === 'ArrowRight' ? 1 : -1);
        return;
      }
      return;
    }

    handleFloatingNavListKeydown(e);
  });

  document.addEventListener('exodeck:pages-changed', () => {
    if (!hasNonDocsWorkspacesWithPages()) {
      docsVisible = true;
    }
    renderPageList();
  });

  document.addEventListener('exodeck:api-mutation', () => {
    const orderedLocations = getOrderedLocations(groupPagesByLocation(
      state.pages.filter(p => !p.hidden && (docsVisible || !isHelpWorkspace(p.location))),
      [...new Set([...(state.locations ?? []), ...state.pages.map(p => p.location).filter(Boolean)])]
    ));
    fetchAndApplySyncStatus(orderedLocations);
  });

  document.addEventListener('exodeck:trigger-sync', (e) => {
    if (e.detail?.location) {
      triggerGitSync(e.detail.location);
    }
  });
}

function updateBrowserMetadata(title, iconUrl) {
  document.title = title === 'ExoDeck' ? 'ExoDeck' : title;
  let link = document.querySelector("link[rel='icon']");
  if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
  }
  link.href = iconUrl;
  link.type = iconUrl.endsWith('.svg') || iconUrl.includes('.svg') ? 'image/svg+xml' : 'image/x-icon';
}
