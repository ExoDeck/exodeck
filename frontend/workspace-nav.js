// workspace-nav.js — Workspace navigation overlay
import { state } from './app.js';
import { loadPage, renderPageList, getWorkspaceList, closeFloatingNavigator } from './sidebar.js';

// ---------------------------------------------------------------------------
// DOM references (populated after DOMContentLoaded in initWorkspaceNav)
// ---------------------------------------------------------------------------
/** @type {HTMLDivElement} */
let workspaceNavEl;
/** @type {HTMLInputElement} */
let workspaceNavInput;
/** @type {HTMLUListElement} */
let workspaceNavResults;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
let activeIndex = -1;
let _docKeyHandler = null;
let currentWorkspaces = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTypingContext(el) {
  if (!(el instanceof Element)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

// ---------------------------------------------------------------------------
// Results rendering
// ---------------------------------------------------------------------------

function createResultItem(workspaceName, index) {
  const li = document.createElement('li');
  li.className = 'keynav__result-item';
  li.dataset.index = index;
  li.dataset.location = workspaceName;

  // Render workspace icon if possible
  const iconContainer = document.createElement('span');
  iconContainer.className = 'workspace-nav__icon';
  iconContainer.style.marginRight = '8px';
  iconContainer.style.display = 'inline-flex';
  iconContainer.style.alignItems = 'center';
  iconContainer.style.justifyContent = 'center';
  iconContainer.style.width = '20px';
  iconContainer.style.height = '20px';
  iconContainer.style.flexShrink = '0';

  const defaultSvg = `<svg width="20" height="20" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="0" y="6" width="36" height="78" fill="#d3d3d3"/>
    <rect x="42" y="6"  width="22" height="22" fill="#d3d3d3"/>
    <rect x="70" y="6"  width="22" height="22" fill="#d3d3d3"/>
    <rect x="42" y="34" width="22" height="22" fill="#d3d3d3"/>
    <rect x="70" y="34" width="22" height="22" fill="#d3d3d3"/>
    <rect x="42" y="62" width="22" height="22" fill="#d3d3d3"/>
    <rect x="70" y="62" width="22" height="22" fill="#d3d3d3"/>
  </svg>`;

  const img = document.createElement('img');
  const v = window._iconVersions?.[workspaceName] ? '&v=' + window._iconVersions[workspaceName] : '';
  const iconUrl = '/api/v1/media/.icon.svg?location=' + encodeURIComponent(workspaceName) + v;
  img.src = iconUrl;
  img.style.width = '20px';
  img.style.height = '20px';
  img.style.objectFit = 'contain';
  img.style.display = 'none';

  const defaultIcon = document.createElement('span');
  defaultIcon.innerHTML = defaultSvg;
  defaultIcon.style.display = 'block';

  img.onload = () => {
    img.style.display = 'block';
    defaultIcon.style.display = 'none';
  };

  iconContainer.appendChild(defaultIcon);
  iconContainer.appendChild(img);
  li.appendChild(iconContainer);

  const nameSpan = document.createElement('span');
  nameSpan.textContent = workspaceName;
  if (workspaceName === state.currentLocation) {
    nameSpan.style.fontWeight = 'bold';
    const activeLabel = document.createElement('span');
    activeLabel.textContent = ' (current)';
    activeLabel.style.opacity = '0.5';
    activeLabel.style.fontSize = '0.85em';
    activeLabel.style.fontWeight = 'normal';
    nameSpan.appendChild(activeLabel);
  }
  li.appendChild(nameSpan);

  li.addEventListener('click', () => handleResultClick(li));
  return li;
}

function renderWorkspaceResults(query) {
  const matched = currentWorkspaces.filter(ws => 
    !query || ws.toLowerCase().includes(query)
  );

  workspaceNavResults.innerHTML = '';
  activeIndex = -1;

  matched.forEach((ws, i) => {
    workspaceNavResults.appendChild(createResultItem(ws, i));
  });

  if (matched.length > 0) setActive(0);
}

// ---------------------------------------------------------------------------
// Active item highlight
// ---------------------------------------------------------------------------

function setActive(index) {
  const items = /** @type {NodeListOf<HTMLLIElement>} */ (
    workspaceNavResults.querySelectorAll('.keynav__result-item')
  );
  if (!items.length) return;

  activeIndex = ((index % items.length) + items.length) % items.length;

  items.forEach((el, i) => {
    el.classList.toggle('keynav__result-item--focused', i === activeIndex);
  });

  items[activeIndex].scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Open / Close
// ---------------------------------------------------------------------------

function positionWorkspaceNav() {
  const dialog = workspaceNavEl?.querySelector('.keynav__dialog');
  if (!dialog) return;

  let left = 48;
  let top = 54;
  const anchorEl = document.getElementById('hamburgerBtn') || document.getElementById('workspaceHeader');
  if (anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      left = rect.left;
      top = rect.bottom + 6;
    }
  }

  const dialogWidth = dialog.offsetWidth || 360;
  if (left + dialogWidth + 8 > window.innerWidth) {
    left = window.innerWidth - dialogWidth - 8;
  }
  if (left < 8) left = 8;

  dialog.style.left = `${left}px`;
  dialog.style.top = `${top}px`;
  dialog.style.maxHeight = `calc(100vh - ${top + 16}px)`;
}

export function openWorkspaceNav() {
  if (_docKeyHandler) return; // already open
  
  closeFloatingNavigator();
  currentWorkspaces = getWorkspaceList();

  workspaceNavEl.removeAttribute('hidden');
  positionWorkspaceNav();
  workspaceNavInput.value = '';
  renderWorkspaceResults('');

  _docKeyHandler = (e) => {
    if (e.key === 'Escape') {
      closeWorkspaceNav();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(activeIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(activeIndex - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const items = workspaceNavResults.querySelectorAll('.keynav__result-item');
      if (activeIndex >= 0 && activeIndex < items.length) {
        handleResultClick(/** @type {HTMLElement} */ (items[activeIndex]));
      }
    }
  };

  document.addEventListener('keydown', _docKeyHandler);
  
  // Defer focus so '-' keypress/beforeinput events complete first
  setTimeout(() => workspaceNavInput.focus(), 0);
}

export function closeWorkspaceNav() {
  workspaceNavEl.setAttribute('hidden', '');
  workspaceNavInput.value = '';
  workspaceNavResults.innerHTML = '';
  activeIndex = -1;
  currentWorkspaces = [];

  if (_docKeyHandler) {
    document.removeEventListener('keydown', _docKeyHandler);
    _docKeyHandler = null;
  }
}

// ---------------------------------------------------------------------------
// Navigate
// ---------------------------------------------------------------------------

async function handleResultClick(li) {
  const location = li.dataset.location;
  closeWorkspaceNav();
  
  if (location === state.currentLocation) return;
  
  state.currentLocation = location;
  renderPageList();
  
  // Try to load the first page of the workspace
  const visiblePages = state.pages.filter(p => !p.hidden);
  const pagesInLoc = visiblePages.filter(p => p.location === location);
  if (pagesInLoc && pagesInLoc.length > 0) {
    await loadPage(pagesInLoc[0].slug, location);
  } else {
    // If empty workspace, just update URL and clear content
    window.history.pushState({ location }, '', `/${encodeURIComponent(location)}`);
    document.getElementById('pageTitle').textContent = '';
    document.getElementById('pageGrid').innerHTML = '';
    state.currentPage = null;
    state.currentSlug = null;
    state.activePageType = null;
    document.dispatchEvent(new CustomEvent('exodeck:page-loaded', { detail: { location } }));
  }
}

// ---------------------------------------------------------------------------
// Public init
// ---------------------------------------------------------------------------

function handleHashKeydown(e) {
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !isTypingContext(e.target)) {
    if (!document.querySelector('.modal-overlay, .add-picker') && workspaceNavEl.hasAttribute('hidden')) {
      e.preventDefault();
      openWorkspaceNav();
    }
  }
}

export function initWorkspaceNav() {
  workspaceNavEl      = /** @type {HTMLDivElement}   */ (document.getElementById('workspaceNav'));
  workspaceNavInput   = /** @type {HTMLInputElement} */ (document.getElementById('workspaceNavInput'));
  workspaceNavResults = /** @type {HTMLUListElement} */ (document.getElementById('workspaceNavResults'));

  if (!workspaceNavEl || !workspaceNavInput || !workspaceNavResults) return;

  // Backdrop click closes overlay
  workspaceNavEl.querySelector('.keynav__backdrop')?.addEventListener('click', closeWorkspaceNav);

  // Real-time filtering
  workspaceNavInput.addEventListener('input', () => {
    const query = workspaceNavInput.value.trim().toLowerCase();
    renderWorkspaceResults(query);
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === '#') handleHashKeydown(e);
  });

  // Re-position and adjust max-height on window resize if open
  window.addEventListener('resize', () => {
    if (_docKeyHandler) {
      positionWorkspaceNav();
    }
  });
}
