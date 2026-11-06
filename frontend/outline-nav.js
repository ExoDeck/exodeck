// outline-nav.js — Outline navigation overlay
import { state } from './app.js';
import {
  handleTreeNavArrowDown,
  handleTreeNavArrowRight,
  handleTreeNavArrowLeft,
  handleTreeNavEnd
} from './ui-utils.js';

// ---------------------------------------------------------------------------
// DOM references (populated after DOMContentLoaded in initOutlineNav)
// ---------------------------------------------------------------------------
/** @type {HTMLDivElement} */
let outlineNavEl;
/** @type {HTMLInputElement} */
let outlineNavInput;
/** @type {HTMLUListElement} */
let outlineNavResults;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
let activeIndex = -1;
let _docKeyHandler = null;
let currentHeadings = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let trackedOutlineNodes = [];
let currentActiveOutlineNode = null;
let scrollTimeout = null;
let suppressScrollSyncUntil = 0;

function handleOutlineScroll() {
  if (!isSidebarOutlineActive || trackedOutlineNodes.length === 0) return;
  if (Date.now() < suppressScrollSyncUntil) return;
  if (scrollTimeout) return;
  
  scrollTimeout = setTimeout(() => {
    scrollTimeout = null;
    if (Date.now() < suppressScrollSyncUntil) return;
    syncActiveOutlineItem();
  }, 50);
}

function getActiveOutlineNode() {
  if (trackedOutlineNodes.length === 0) return null;

  const contentEl = document.getElementById('content');
  if (contentEl) {
    if (contentEl.scrollTop <= 10) {
      return trackedOutlineNodes[0];
    }
    const canScroll = contentEl.scrollHeight > contentEl.clientHeight + 20;
    if (canScroll && (contentEl.scrollHeight - contentEl.scrollTop - contentEl.clientHeight <= 15)) {
      return trackedOutlineNodes.at(-1);
    }
  }

  const contentTop = contentEl ? contentEl.getBoundingClientRect().top : 50;
  const threshold = contentTop + 50; // offset below top of content area

  for (let i = trackedOutlineNodes.length - 1; i >= 0; i--) {
    const node = trackedOutlineNodes[i];
    if (node.headingEl.id === 'pageTitle') {
      // pageTitle is fixed in app-header and does not scroll with content
      continue;
    }
    const rect = node.headingEl.getBoundingClientRect();
    if (rect.top <= threshold) {
      return node;
    }
  }
  return trackedOutlineNodes[0];
}

function expandParentGroups(node) {
  let current = node.sidebarEl.parentElement;
  while (current?.tagName === 'DETAILS' && current.classList.contains('sidebar__group')) {
    current.open = true;
    current = current.parentElement;
  }
}

function scrollNodeIntoViewIfNeeded(node) {
  const container = document.getElementById('sidebarOutlineList') || document.getElementById('pageList');
  if (!container) return;
  
  const elRect = node.sidebarEl.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  if (elRect.top < containerRect.top || elRect.bottom > containerRect.bottom) {
    node.sidebarEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

export function setActiveOutlineNode(activeNode, lockDurationMs = 0) {
  if (!activeNode) return;
  currentActiveOutlineNode = activeNode;
  if (lockDurationMs > 0) {
    suppressScrollSyncUntil = Date.now() + lockDurationMs;
  }

  for (const node of trackedOutlineNodes) {
    const isActive = (node === activeNode);
    if (node.isGroup) {
      node.sidebarEl.classList.toggle('sidebar__group-summary--active', isActive);
    } else {
      node.sidebarEl.classList.toggle('sidebar__page--active', isActive);
    }

    if (isActive) {
      expandParentGroups(node);
      scrollNodeIntoViewIfNeeded(node);
    }
  }
}

export function syncActiveOutlineItem() {
  if (Date.now() < suppressScrollSyncUntil) return;
  const activeNode = getActiveOutlineNode();
  if (!activeNode || activeNode === currentActiveOutlineNode) return;
  setActiveOutlineNode(activeNode);
}

function isTypingContext(el) {
  if (!(el instanceof Element)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

// ---------------------------------------------------------------------------
// Results rendering
// ---------------------------------------------------------------------------

function createResultItem(heading, index) {
  const li = document.createElement('li');
  li.className = 'keynav__result-item';
  li.dataset.index = index;

  const levelStr = heading.dataset.outlineLevel || heading.tagName.substring(1);
  const level = Number.parseInt(levelStr, 10);
  
  const nameSpan = document.createElement('span');
  nameSpan.textContent = heading.textContent;
  
  // Indent based on heading level for visual hierarchy (h1 is 0 indent, h2 is some, etc.)
  if (level > 1) {
    nameSpan.style.marginLeft = `${(level - 1) * 12}px`;
    nameSpan.style.opacity = `${1 - (level - 1) * 0.1}`; // slightly fade deeper headings
  }
  
  li.appendChild(nameSpan);
  li.addEventListener('click', () => handleResultClick(li));
  
  return li;
}

function renderOutlineResults(query) {
  const matched = currentHeadings.filter(h => 
    !query || h.textContent.toLowerCase().includes(query)
  );

  outlineNavResults.innerHTML = '';
  activeIndex = -1;

  matched.forEach((h) => {
    outlineNavResults.appendChild(createResultItem(h.element, h.originalIndex));
  });

  if (matched.length > 0) setActive(0);
}

// ---------------------------------------------------------------------------
// Active item highlight
// ---------------------------------------------------------------------------

function setActive(index) {
  const items = /** @type {NodeListOf<HTMLLIElement>} */ (
    outlineNavResults.querySelectorAll('.keynav__result-item')
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

export function openOutlineNav() {
  if (_docKeyHandler) return; // already open
  
  // Extract headings from the page grid
  const pageGrid = document.getElementById('pageGrid');
  if (!pageGrid) return;
  
  const headingElements = [];
  const contentHeadings = Array.from(pageGrid.querySelectorAll('h1, h2, h3, h4, h5, h6'));
  let minLevel = 1;
  if (contentHeadings.length > 0) {
    minLevel = Math.min(...contentHeadings.map(el => Number.parseInt(el.tagName.substring(1), 10)));
  }

  const pageTitle = document.getElementById('pageTitle');
  if (pageTitle?.textContent.trim()) {
    pageTitle.dataset.outlineLevel = minLevel;
    headingElements.push(pageTitle);
  }
  headingElements.push(...contentHeadings);
  
  if (headingElements.length === 0) return; // No headings to show
  
  currentHeadings = headingElements.map((el, i) => ({
    element: el,
    textContent: el.textContent.trim(),
    originalIndex: i
  }));

  outlineNavEl.removeAttribute('hidden');
  outlineNavInput.value = '';
  renderOutlineResults('');

  _docKeyHandler = (e) => {
    if (e.key === 'Escape') {
      closeOutlineNav();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(activeIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(activeIndex - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const items = outlineNavResults.querySelectorAll('.keynav__result-item');
      if (activeIndex >= 0 && activeIndex < items.length) {
        handleResultClick(/** @type {HTMLElement} */ (items[activeIndex]));
      }
    }
  };

  document.addEventListener('keydown', _docKeyHandler);
  
  // Defer focus so 'o' keypress/beforeinput events complete first
  setTimeout(() => outlineNavInput.focus(), 0);
}

export function closeOutlineNav() {
  outlineNavEl.setAttribute('hidden', '');
  outlineNavInput.value = '';
  outlineNavResults.innerHTML = '';
  activeIndex = -1;
  currentHeadings = [];

  if (_docKeyHandler) {
    document.removeEventListener('keydown', _docKeyHandler);
    _docKeyHandler = null;
  }
}

// ---------------------------------------------------------------------------
// Navigate
// ---------------------------------------------------------------------------

function scrollToHeading(element) {
  const textarea = document.querySelector('.md-editor-textarea');
  const isEditorVisible = textarea && textarea.offsetParent !== null;

  if (!isEditorVisible) {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  if (element.id === 'pageTitle') {
    scrollToEditorTitle(textarea);
  } else if (element.closest('.md-editor-preview')) {
    scrollToEditorHeading(textarea, element);
  } else {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function scrollToEditorTitle(textarea) {
  const contentEl = document.getElementById('content');
  if (contentEl) contentEl.scrollTo({ top: 0, behavior: 'smooth' });
  textarea.setSelectionRange(0, 0);
  textarea.focus({ preventScroll: true });
}

function scrollToEditorHeading(textarea, element) {
  const preview = element.closest('.md-editor-preview');
  const allPreviewHeadings = Array.from(preview.querySelectorAll('h1, h2, h3, h4, h5, h6'));
  const headingIndex = allPreviewHeadings.indexOf(element);
  const highlight = document.querySelector('.md-editor-highlight');
  
  if (!highlight || headingIndex === -1) return;

  const sections = Array.from(highlight.querySelectorAll('.hljs-section'));
  const targetSection = sections[headingIndex];
  
  if (targetSection) {
    scrollToTargetSection(textarea, highlight, targetSection);
  } else {
    const percentage = element.offsetTop / preview.scrollHeight;
    textarea.scrollTo({ top: percentage * textarea.scrollHeight, behavior: 'smooth' });
  }
}

function scrollToTargetSection(textarea, highlight, targetSection) {
  const highlightCode = highlight.querySelector('code');
  if (highlightCode) {
    const range = document.createRange();
    range.setStart(highlightCode, 0);
    range.setEndBefore(targetSection);
    const charIndex = range.toString().length;
    
    textarea.setSelectionRange(charIndex, charIndex);
    textarea.focus({ preventScroll: true });
  }
  
  textarea.scrollTo({ top: Math.max(0, targetSection.offsetTop - 20), behavior: 'smooth' });
}

function handleResultClick(li) {
  const index = Number.parseInt(li.dataset.index, 10);
  const heading = currentHeadings.find(h => h.originalIndex === index);
  
  closeOutlineNav();
  
  if (heading?.element) {
    const tracked = trackedOutlineNodes.find(t => t.headingEl === heading.element);
    if (tracked) {
      setOutlineFocusedItem(tracked.sidebarEl);
      setActiveOutlineNode(tracked, 600);
    }
    scrollToHeading(heading.element);
    highlightHeading(heading.element);
  }
}

// ---------------------------------------------------------------------------
// Sidebar Outline Integration
// ---------------------------------------------------------------------------

let isSidebarOutlineActive = false;

export function getIsSidebarOutlineActive() {
  return isSidebarOutlineActive;
}

function buildOutlineTree(headingElements) {
  const root = { level: 0, children: [] };
  const stack = [root];

  for (const el of headingElements) {
    const levelStr = el.dataset.outlineLevel || el.tagName.substring(1);
    const level = Number.parseInt(levelStr, 10);
    const node = { level, element: el, textContent: el.textContent.trim(), children: [] };

    while (stack.length > 1 && stack.at(-1).level >= level) {
      stack.pop();
    }
    stack.at(-1).children.push(node);
    stack.push(node);
  }
  return root.children;
}

function highlightHeading(el) {
  const originalColor = el.style.color;
  el.style.transition = 'color 0.3s ease';
  el.style.color = 'var(--color-accent, #6c8ef5)';
  setTimeout(() => {
    el.style.color = originalColor;
    setTimeout(() => {
      el.style.transition = '';
    }, 300);
  }, 1000);
}

function renderOutlineNode(node, isFloating = false) {
  if (node.children.length > 0) {
    const details = document.createElement('details');
    details.className = 'sidebar__group';
    details.open = false; // Collapsed by default

    const summary = document.createElement('summary');
    summary.className = 'sidebar__group-summary';
    summary.title = node.textContent;

    const chevron = document.createElement('span');
    chevron.className = 'sidebar__group-chevron material-symbols-outlined';
    chevron.style.fontSize = '16px';
    chevron.textContent = 'keyboard_arrow_right';

    const label = document.createElement('span');
    label.className = 'sidebar__label';
    label.textContent = node.textContent;

    summary.appendChild(chevron);
    summary.appendChild(label);
    
    if (!isFloating) {
      trackedOutlineNodes.push({ headingEl: node.element, sidebarEl: summary, isGroup: true });
    }
    
    summary.addEventListener('click', (e) => {
      setOutlineFocusedItem(summary);
      if (e.target !== chevron) {
        e.preventDefault(); // Don't toggle details if clicking label/summary
        const tracked = trackedOutlineNodes.find(t => t.headingEl === node.element);
        if (tracked) {
          setActiveOutlineNode(tracked, 600);
        }
        scrollToHeading(node.element);
        highlightHeading(node.element);
        if (isFloating) {
          import('./sidebar.js').then(m => m.closeFloatingNavigator());
        }
      }
    });

    summary.addEventListener('mouseenter', () => {
      if (isOutlineFocused()) {
        setOutlineFocusedItem(summary);
      }
    });

    details.addEventListener('toggle', () => {
      chevron.textContent = details.open ? 'keyboard_arrow_down' : 'keyboard_arrow_right';
    });

    details.appendChild(summary);

    for (const child of node.children) {
      details.appendChild(renderOutlineNode(child, isFloating));
    }
    return details;
  } else {
    // Leaf node
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sidebar__page sidebar__page--child';
    btn.title = node.textContent;
    
    const label = document.createElement('span');
    label.className = 'sidebar__label';
    label.textContent = node.textContent;
    btn.appendChild(label);

    if (!isFloating) {
      trackedOutlineNodes.push({ headingEl: node.element, sidebarEl: btn, isGroup: false });
    }

    btn.addEventListener('click', () => {
      setOutlineFocusedItem(btn);
      const tracked = trackedOutlineNodes.find(t => t.headingEl === node.element);
      if (tracked) {
        setActiveOutlineNode(tracked, 600);
      }
      scrollToHeading(node.element);
      highlightHeading(node.element);
      if (isFloating) {
        import('./sidebar.js').then(m => m.closeFloatingNavigator());
      }
    });

    btn.addEventListener('mouseenter', () => {
      if (isOutlineFocused()) {
        setOutlineFocusedItem(btn);
      }
    });

    return btn;
  }
}

function getPageHeadings() {
  const pageGrid = document.getElementById('pageGrid');
  if (!pageGrid) return [];

  const headingElements = [];
  const contentHeadings = Array.from(pageGrid.querySelectorAll('h1, h2, h3, h4, h5, h6'));
  let minLevel = 1;
  if (contentHeadings.length > 0) {
    minLevel = Math.min(...contentHeadings.map(el => Number.parseInt(el.tagName.substring(1), 10)));
  }

  const pageTitle = document.getElementById('pageTitle');
  if (pageTitle?.textContent.trim()) {
    pageTitle.dataset.outlineLevel = minLevel;
    headingElements.push(pageTitle);
  }
  headingElements.push(...contentHeadings);
  return headingElements;
}

function createOutlineTreeContainer(headings, isFloating) {
  const tree = buildOutlineTree(headings);
  const container = document.createElement('div');
  container.className = 'sidebar__outline-tree';

  if (tree.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sidebar__empty';
    empty.textContent = 'No headings found.';
    empty.style.padding = '12px 16px';
    empty.style.color = 'var(--color-text-muted)';
    empty.style.fontSize = '0.85rem';
    container.appendChild(empty);
  } else {
    for (const node of tree) {
      container.appendChild(renderOutlineNode(node, isFloating));
    }
  }
  return container;
}

export function renderOutlineInSidebar() {
  const sidebarOutlineList = document.getElementById('sidebarOutlineList');
  if (!sidebarOutlineList) return;
  sidebarOutlineList.innerHTML = '';

  trackedOutlineNodes = [];
  currentActiveOutlineNode = null;
  suppressScrollSyncUntil = 0;
  isSidebarOutlineActive = true;

  const headings = getPageHeadings();
  sidebarOutlineList.appendChild(createOutlineTreeContainer(headings, false));
  syncActiveOutlineItem();

  import('./sidebar.js').then(m => {
    m.updatePinButtonUI?.();
  });
}

export function renderOutlineInFloatingNav() {
  const floatingOutlineList = document.getElementById('floatingNavOutlineList');
  if (!floatingOutlineList) return;
  floatingOutlineList.innerHTML = '';

  const headings = getPageHeadings();
  floatingOutlineList.appendChild(createOutlineTreeContainer(headings, true));
}

export function refreshOutlineSidebar() {
  const sidebarOutlineList = document.getElementById('sidebarOutlineList');
  if (sidebarOutlineList && !sidebarOutlineList.hasAttribute('hidden')) {
    renderOutlineInSidebar();
  }
}

export function toggleOutlineSidebar() {
  import('./sidebar.js').then(m => {
    m.toggleSidebarPin();
  });
}

export function toggleOutlineFloatingNav() {
  // Navigator overlay only shows navigator
}

// ---------------------------------------------------------------------------
// Outline Keyboard Navigation (Sidebar)
// ---------------------------------------------------------------------------

function getVisibleOutlineItems() {
  const container = document.getElementById('sidebarOutlineList');
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

export function setOutlineFocusedItem(item) {
  const container = document.getElementById('sidebarOutlineList');
  if (!container || !item) return;

  container.querySelectorAll('.sidebar__item--focused').forEach(el => {
    el.classList.remove('sidebar__item--focused');
  });

  item.classList.add('sidebar__item--focused');
  item.tabIndex = 0;
  item.focus({ preventScroll: true });
  item.scrollIntoView({ block: 'nearest' });
}

function getOutlineFocusedItem(container, items) {
  let current = document.activeElement;
  if (!current || !container.contains(current) || !current.matches('.sidebar__page, .sidebar__group-summary')) {
    current = container.querySelector('.sidebar__item--focused');
  }
  if (!current || !items.includes(current)) {
    const activeItem = container.querySelector('.sidebar__page--active, .sidebar__group-summary--active');
    if (activeItem && items.includes(activeItem)) return activeItem;
    return items.length > 0 ? items[0] : null;
  }
  return current;
}

export function isOutlineFocused() {
  const container = document.getElementById('sidebarOutlineList');
  if (!container?.offsetParent) return false;
  const active = document.activeElement;
  if (active && container.contains(active)) return true;
  return container.querySelector('.sidebar__item--focused') !== null && document.getElementById('sidebar')?.contains(active);
}

export function focusOutline() {
  const container = document.getElementById('sidebarOutlineList');
  if (!container?.offsetParent) return;

  setTimeout(() => {
    const activeItem = container.querySelector('.sidebar__page--active, .sidebar__group-summary--active');
    if (activeItem && activeItem.offsetParent !== null) {
      setOutlineFocusedItem(activeItem);
      return;
    }
    const items = getVisibleOutlineItems();
    if (items.length > 0) {
      setOutlineFocusedItem(items[0]);
    }
  }, 50);
}

function handleOutlineArrowDown(e) {
  const container = document.getElementById('sidebarOutlineList');
  if (!container) return;
  handleTreeNavArrowDown({
    getVisibleItems: getVisibleOutlineItems,
    getFocusedItem: (items) => getOutlineFocusedItem(container, items),
    setFocusedItem: setOutlineFocusedItem,
    event: e
  });
}

function handleOutlineArrowUp(e) {
  const container = document.getElementById('sidebarOutlineList');
  if (!container) return;
  const items = getVisibleOutlineItems();
  if (items.length === 0) return;

  const current = getOutlineFocusedItem(container, items);
  const currentIndex = items.indexOf(current);
  let prevIndex = items.length - 1;
  if (currentIndex !== -1) {
    prevIndex = (currentIndex - 1 + items.length) % items.length;
  }
  setOutlineFocusedItem(items[prevIndex]);
  e.preventDefault();
}

function handleOutlineArrowRight(e) {
  const container = document.getElementById('sidebarOutlineList');
  if (!container) return;
  handleTreeNavArrowRight({
    getVisibleItems: getVisibleOutlineItems,
    getFocusedItem: (items) => getOutlineFocusedItem(container, items),
    setFocusedItem: setOutlineFocusedItem,
    event: e
  });
}

function handleOutlineArrowLeft(e) {
  const container = document.getElementById('sidebarOutlineList');
  if (!container) return;
  handleTreeNavArrowLeft({
    getVisibleItems: getVisibleOutlineItems,
    getFocusedItem: (items) => getOutlineFocusedItem(container, items),
    setFocusedItem: setOutlineFocusedItem,
    event: e
  });
}

function handleOutlineHome(e) {
  const items = getVisibleOutlineItems();
  if (items.length > 0) {
    setOutlineFocusedItem(items[0]);
    e.preventDefault();
  }
}

function handleOutlineEnd(e) {
  handleTreeNavEnd({
    getVisibleItems: getVisibleOutlineItems,
    setFocusedItem: setOutlineFocusedItem,
    event: e
  });
}

function handleOutlineEnter(e) {
  const container = document.getElementById('sidebarOutlineList');
  if (!container) return;
  const items = getVisibleOutlineItems();
  if (items.length === 0) return;

  const current = getOutlineFocusedItem(container, items);
  if (!current) return;

  e.preventDefault();
  const tracked = trackedOutlineNodes.find(t => t.sidebarEl === current);
  if (tracked?.headingEl) {
    setActiveOutlineNode(tracked, 600);
    scrollToHeading(tracked.headingEl);
    highlightHeading(tracked.headingEl);
  } else if (current.classList.contains('sidebar__page')) {
    current.click();
  }

  // Remove outline keyboard focus highlight since focus transfers to content
  container.querySelectorAll('.sidebar__item--focused').forEach(el => {
    el.classList.remove('sidebar__item--focused');
  });
  if (document.activeElement && container.contains(document.activeElement)) {
    document.activeElement.blur();
  }

  // Option A: Transfer focus to content area so cursor keys immediately scroll
  const content = document.getElementById('content');
  if (content) {
    content.tabIndex = -1;
    content.focus({ preventScroll: true });
  }
}

function handleOutlineSpace(e) {
  const container = document.getElementById('sidebarOutlineList');
  if (!container) return;
  const items = getVisibleOutlineItems();
  if (items.length === 0) return;

  const current = getOutlineFocusedItem(container, items);
  if (!current) return;

  e.preventDefault();
  const tracked = trackedOutlineNodes.find(t => t.sidebarEl === current);
  if (tracked?.headingEl) {
    setActiveOutlineNode(tracked, 600);
    scrollToHeading(tracked.headingEl);
    highlightHeading(tracked.headingEl);
  } else if (current.classList.contains('sidebar__page')) {
    current.click();
  }
  // Focus remains in the outline for auditioning/peeking
}

function handleOutlineEscape(e) {
  const container = document.getElementById('sidebarOutlineList');
  if (!container) return;
  container.querySelectorAll('.sidebar__item--focused').forEach(el => {
    el.classList.remove('sidebar__item--focused');
  });
  if (document.activeElement && container.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  const content = document.getElementById('content');
  if (content) {
    content.tabIndex = -1;
    content.focus({ preventScroll: true });
  }
  e.preventDefault();
}

function handleOutlineKeydown(e) {
  if (isTypingContext(e.target)) return;
  if (!isOutlineFocused()) return;

  if (e.key === 'ArrowDown') {
    handleOutlineArrowDown(e);
  } else if (e.key === 'ArrowUp') {
    handleOutlineArrowUp(e);
  } else if (e.key === 'ArrowRight') {
    handleOutlineArrowRight(e);
  } else if (e.key === 'ArrowLeft') {
    handleOutlineArrowLeft(e);
  } else if (e.key === 'Enter') {
    handleOutlineEnter(e);
  } else if (e.key === ' ' || e.key === 'Spacebar') {
    handleOutlineSpace(e);
  } else if (e.key === 'Home') {
    handleOutlineHome(e);
  } else if (e.key === 'End') {
    handleOutlineEnd(e);
  } else if (e.key === 'Escape') {
    handleOutlineEscape(e);
  }
}

// ---------------------------------------------------------------------------
// Public init
// ---------------------------------------------------------------------------

function handleOKeydown(e) {
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !isTypingContext(e.target)) {
    // Only open if we are on a note page with a pageGrid
    const pageType = state.currentPage?.page_type;
    if (pageType === 'note') {
      e.preventDefault();
      if (e.key === 'O') {
        openOutlineNav();
      } else {
        import('./sidebar.js').then(m => {
          if (!m.isPinned()) {
            m.setSidebarPinned(true, true);
          } else if (!isOutlineFocused()) {
            syncActiveOutlineItem();
            focusOutline();
          } else {
            m.setSidebarPinned(false, true);
          }
        });
      }
    }
  }
}

function handleSKeydown(e) {
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !isTypingContext(e.target)) {
    const pageType = state.currentPage?.page_type;
    if (pageType === 'note') {
      e.preventDefault();
      toggleOutlineSidebar();
    }
  }
}

function handleXKeydown(e) {
  if (e.ctrlKey || e.altKey || e.metaKey || isTypingContext(e.target)) return;

  e.preventDefault();
  const floatingNav = document.getElementById('floatingNav');
  const btn = (floatingNav && !floatingNav.hasAttribute('hidden'))
    ? document.getElementById('floatingNavExpandCollapseBtn')
    : document.getElementById('sidebarExpandCollapseBtn');
  btn?.click();
}

export function initOutlineNav() {
  outlineNavEl      = /** @type {HTMLDivElement}   */ (document.getElementById('outlineNav'));
  outlineNavInput   = /** @type {HTMLInputElement} */ (document.getElementById('outlineNavInput'));
  outlineNavResults = /** @type {HTMLUListElement} */ (document.getElementById('outlineNavResults'));

  if (!outlineNavEl || !outlineNavInput || !outlineNavResults) return;

  // Backdrop click closes overlay
  outlineNavEl.querySelector('.keynav__backdrop')?.addEventListener('click', closeOutlineNav);

  // Real-time filtering
  outlineNavInput.addEventListener('input', () => {
    const query = outlineNavInput.value.trim().toLowerCase();
    renderOutlineResults(query);
  });

  // Sidebar outline container click handling to switch focus
  const sidebarOutlineList = document.getElementById('sidebarOutlineList');
  if (sidebarOutlineList) {
    sidebarOutlineList.addEventListener('click', (e) => {
      const item = e.target.closest('.sidebar__page, .sidebar__group-summary');
      if (item) {
        setOutlineFocusedItem(item);
      } else {
        focusOutline();
      }
    });
  }

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'o' || e.key === 'O') handleOKeydown(e);
    if (e.key === 's' || e.key === 'S') handleSKeydown(e);
    if (e.key === 'x' || e.key === 'X') handleXKeydown(e);
    handleOutlineKeydown(e);
  });
  
  const contentEl = document.getElementById('content');
  if (contentEl) {
    contentEl.addEventListener('scroll', handleOutlineScroll, { passive: true });
  }
}
