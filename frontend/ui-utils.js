// ui-utils.js — Reusable UI helper functions

/**
 * Extracts a user-friendly error message from an Error, string, or API response.
 * Strips raw JSON wrappers like {"detail":"..."} and HTTP status prefixes like "API 401:".
 *
 * @param {any} input
 * @param {string} [fallback]
 * @returns {string}
 */
/**
 * Extracts raw string message from input object/Error/string.
 */
function extractRawMessage(input) {
  if (typeof input === 'string') return input;
  if (input instanceof Error) return input.message || String(input);
  if (typeof input === 'object' && input !== null) {
    const direct = input.detail || input.error || input.message;
    if (direct) return String(direct);
    try {
      return JSON.stringify(input);
    } catch {
      return '';
    }
  }
  return String(input);
}

/**
 * Attempts to parse JSON substring from message and return extracted error text.
 */
function extractJsonMessage(msg) {
  const start = msg.indexOf('{');
  const end = msg.lastIndexOf('}');
  if (start === -1 || end <= start) return msg;

  try {
    const parsed = JSON.parse(msg.slice(start, end + 1));
    if (parsed && typeof parsed === 'object') {
      const extracted = parsed.detail || parsed.error || parsed.message;
      if (typeof extracted === 'string' && extracted.trim()) {
        return extracted;
      }
    }
  } catch {
    // not valid JSON, ignore
  }
  return msg;
}

/**
 * Strips HTML tags using DOMParser without regex backtracking.
 */
function stripHtmlTags(str) {
  if (!str.includes('<') || !str.includes('>')) return str;
  try {
    const doc = new DOMParser().parseFromString(str, 'text/html');
    return (doc.body?.textContent || str).trim();
  } catch {
    return str;
  }
}

/**
 * Extracts a user-friendly error message from an Error, string, or API response.
 * Strips raw JSON wrappers like {"detail":"..."} and HTTP status prefixes like "API 401:".
 *
 * @param {any} input
 * @param {string} [fallback]
 * @returns {string}
 */
export function parseApiError(input, fallback = 'An unexpected error occurred.') {
  if (!input) return fallback;

  let msg = extractRawMessage(input);
  msg = extractJsonMessage(msg);
  msg = msg.replace(/^API\s+\d+:\s*/i, '');
  msg = stripHtmlTags(msg);
  msg = msg.trim();
  if (!msg) return fallback;

  // Capitalize first letter
  return msg.charAt(0).toUpperCase() + msg.slice(1);
}

/**
 * Show a transient error bubble anchored below a given element.
 * The bubble is appended to the element's parent (never inside a
 * contenteditable), positioned via offsetTop/offsetLeft.
 *
 * Dismisses automatically after 4 seconds or when the user types in `el`.
 *
 * @param {HTMLElement|string|null} el  - The element to anchor the bubble below, or msg if single arg.
 * @param {string}           [msg] - The error message to display.
 */
export function showErrorBubble(el, msg) {
  let targetEl = el;
  let text = msg;
  if (typeof el === 'string' && !msg) {
    targetEl = document.querySelector('.content__title');
    text = el;
  }
  targetEl?.parentElement?.querySelectorAll('.content__title-error-bubble').forEach(b => b.remove());
  if (!targetEl) return;
  const bubble = document.createElement('span');
  bubble.className = 'content__title-error-bubble';
  bubble.textContent = text;
  bubble.style.top = (targetEl.offsetTop + targetEl.offsetHeight + 7) + 'px';
  bubble.style.left = targetEl.offsetLeft + 'px';
  targetEl.parentElement.appendChild(bubble);
  const dismiss = () => bubble.remove();
  targetEl.addEventListener('input', dismiss, { once: true });
  setTimeout(dismiss, 4000);
}

let disconnectModalEl = null;
let reconnectPollId = null;

/**
 * Displays an error modal when the backend server is unreachable or down.
 * Automatically polls for recovery and includes a manual retry button.
 */
export function showBackendDisconnectedModal() {
  if (disconnectModalEl) return;

  const overlay = document.createElement('div');
  overlay.id = '_serverDisconnectedModal';
  overlay.className = 'modal-overlay';
  overlay.style.zIndex = '10000';

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.setAttribute('role', 'alertdialog');
  modal.setAttribute('aria-modal', 'true');

  modal.innerHTML = `
    <div style="display: flex; align-items: center; gap: var(--space-sm); margin-bottom: var(--space-xs);">
      <span class="material-symbols-outlined" style="font-size: 28px; color: var(--color-danger);">cloud_off</span>
      <h2 class="modal__title" style="margin: 0; font-size: var(--font-size-base);">Server Connection Lost</h2>
    </div>
    <p style="color: var(--color-text-muted); font-size: var(--font-size-sm); margin: var(--space-xs) 0 var(--space-md) 0; line-height: 1.5;">
      Unable to connect to the ExoDeck backend server. The server process may have stopped or is restarting.
    </p>
    <div class="_reconnect_status" style="font-size: var(--font-size-xs); color: var(--color-text-muted); margin-bottom: var(--space-sm); display: flex; align-items: center; gap: var(--space-xs);">
      <span class="material-symbols-outlined syncing" style="font-size: 16px;">sync</span>
      <span>Reconnecting automatically...</span>
    </div>
    <div class="modal__actions">
      <button type="button" class="btn btn--primary _reconnect_btn">Retry Connection</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  disconnectModalEl = overlay;

  const retryBtn = modal.querySelector('._reconnect_btn');
  const tryReconnect = async () => {
    retryBtn.disabled = true;
    retryBtn.textContent = 'Checking...';
    try {
      const res = await fetch('/api/v1/bootstrap');
      if (res.ok) {
        hideBackendDisconnectedModal();
        window.location.reload();
        return;
      }
    } catch {
      // still offline
    }
    retryBtn.disabled = false;
    retryBtn.textContent = 'Retry Connection';
  };

  retryBtn?.addEventListener('click', tryReconnect);

  reconnectPollId = setInterval(async () => {
    try {
      const res = await fetch('/api/v1/bootstrap');
      if (res.ok) {
        hideBackendDisconnectedModal();
        window.location.reload();
      }
    } catch {
      // still offline
    }
  }, 3000);
}

/**
 * Dismisses the disconnected modal and stops background polling.
 */
export function hideBackendDisconnectedModal() {
  if (reconnectPollId) {
    clearInterval(reconnectPollId);
    reconnectPollId = null;
  }
  if (disconnectModalEl) {
    disconnectModalEl.remove();
    disconnectModalEl = null;
  }
}

/**
 * Create a modal window frame overlay with header, maximize, and close buttons.
 * @param {object} options
 * @param {string} options.id - Overlay element ID
 * @param {string} [options.className] - Additional CSS class for window
 * @param {() => void} [options.onClose] - Close callback
 * @param {() => void} [options.onMaximize] - Custom maximize callback (default toggles .note-window--maximized)
 * @returns {{
 *   overlay: HTMLDivElement,
 *   win: HTMLDivElement,
 *   winHeader: HTMLDivElement,
 *   titleEl: HTMLHeadingElement,
 *   headerActions: HTMLDivElement,
 *   maximizeBtn: HTMLButtonElement,
 *   closeHeaderBtn: HTMLButtonElement,
 *   errorEl: HTMLParagraphElement,
 *   bodyDiv: HTMLDivElement,
 *   toggleMaximize: () => boolean,
 * }}
 */
export function createWindowFrame({ id, className, onClose, onMaximize }) {
  document.getElementById(id)?.remove();

  const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const overlay = document.createElement('div');
  overlay.id = id;
  overlay.className = 'note-window-overlay';

  const win = document.createElement('div');
  win.className = className ? `note-window ${className}` : 'note-window';
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-modal', 'true');
  win.setAttribute('tabindex', '-1');
  win.style.outline = 'none';

  const winHeader = document.createElement('div');
  winHeader.className = 'note-window__header';

  const titleEl = document.createElement('h2');
  titleEl.className = 'note-window__title';

  const headerActions = document.createElement('div');
  headerActions.className = 'note-window__header-actions';

  const maximizeBtn = document.createElement('button');
  maximizeBtn.type = 'button';
  maximizeBtn.className = 'note-window__maximize btn btn--ghost';
  maximizeBtn.setAttribute('aria-label', 'Maximize');
  maximizeBtn.title = 'Maximize';
  maximizeBtn.textContent = '⤢';

  const closeHeaderBtn = document.createElement('button');
  closeHeaderBtn.type = 'button';
  closeHeaderBtn.className = 'note-window__close btn btn--ghost';
  closeHeaderBtn.setAttribute('aria-label', 'Close');
  closeHeaderBtn.title = 'Close';
  closeHeaderBtn.textContent = '✕';

  headerActions.appendChild(maximizeBtn);
  headerActions.appendChild(closeHeaderBtn);
  winHeader.appendChild(titleEl);
  winHeader.appendChild(headerActions);

  const errorEl = document.createElement('p');
  errorEl.className = 'note-window__error';
  errorEl.hidden = true;

  const bodyDiv = document.createElement('div');
  bodyDiv.className = 'note-window__body';

  win.appendChild(winHeader);
  win.appendChild(errorEl);
  win.appendChild(bodyDiv);
  overlay.appendChild(win);

  const toggleMaximize = () => {
    const isMax = win.classList.toggle('note-window--maximized');
    maximizeBtn.textContent = isMax ? '⤡' : '⤢';
    maximizeBtn.setAttribute('aria-label', isMax ? 'Restore' : 'Maximize');
    maximizeBtn.title = isMax ? 'Restore' : 'Maximize';
    return isMax;
  };

  maximizeBtn.addEventListener('click', () => {
    if (onMaximize) {
      onMaximize();
    } else {
      toggleMaximize();
    }
  });

  if (onClose) {
    closeHeaderBtn.addEventListener('click', onClose);
  }

  const restoreFocus = () => {
    if (previousActive && document.contains(previousActive)) {
      try {
        previousActive.focus();
      } catch {
        // ignore
      }
    }
  };

  return {
    overlay,
    win,
    winHeader,
    titleEl,
    headerActions,
    maximizeBtn,
    closeHeaderBtn,
    errorEl,
    bodyDiv,
    toggleMaximize,
    restoreFocus,
  };
}

/**
 * Create Save and Cancel icon buttons for full-page editors.
 * @param {() => void} onSave
 * @param {() => void} onCancel
 * @returns {{ saveBtn: HTMLButtonElement, cancelBtn: HTMLButtonElement }}
 */
export function createEditorActionButtons(onSave, onCancel) {
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'page-header__icon-btn';
  saveBtn.title = 'Save (Ctrl+S)';
  saveBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 20px; color: #4caf50;">check</span>';
  saveBtn.addEventListener('click', onSave);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'page-header__icon-btn';
  cancelBtn.title = 'Cancel (Esc)';
  cancelBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 20px; color: #f44336;">close</span>';
  cancelBtn.addEventListener('click', onCancel);

  return { saveBtn, cancelBtn };
}

/**
 * Cycle tab navigation among a dynamic array of focusable elements.
 * @param {KeyboardEvent} e
 * @param {Array<HTMLElement|null|undefined>} elements
 */
export function handleTabNavigation(e, elements) {
  if (e.key !== 'Tab') return;
  const order = elements.filter(Boolean);
  const index = order.indexOf(e.target);
  if (index === -1) return;

  e.preventDefault();
  const direction = e.shiftKey ? -1 : 1;
  const nextIndex = (index + direction + order.length) % order.length;
  order[nextIndex]?.focus();
}

/**
 * Gets all visible, non-disabled focusable elements inside a container.
 * @param {HTMLElement} container
 * @returns {HTMLElement[]}
 */
export function getFocusableElements(container) {
  if (!container) return [];
  const selector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])';
  const candidates = Array.from(container.querySelectorAll(selector));
  return candidates.filter(el => {
    if (!(el instanceof HTMLElement)) return false;
    if (el.hidden || el.closest('[hidden]')) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

/**
 * Traps Tab key focus navigation inside a container.
 * @param {KeyboardEvent} e
 * @param {HTMLElement} container
 */
export function trapFocus(e, container) {
  if (e.key !== 'Tab') return;
  const focusable = getFocusableElements(container);
  if (focusable.length === 0) {
    e.preventDefault();
    container.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  const index = focusable.indexOf(/** @type {HTMLElement} */ (active));

  if (e.shiftKey) {
    if (index <= 0) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (index === -1 || index === focusable.length - 1) {
      e.preventDefault();
      first.focus();
    }
  }
}


/**
 * Navigates away from a canceled page creation to currentPage or first available page.
 * @param {string|null} targetLocation
 * @param {object} state
 * @param {(slug: string, loc: string|null) => Promise<void>} loadPageFn
 * @param {(type: string|null) => void} updateSidebarFn
 */
export async function navigateAfterPageCancel(targetLocation, state, loadPageFn, updateSidebarFn) {
  const effectiveLocation = targetLocation ?? state.currentLocation;
  if (state.currentPage && (state.currentPage.location ?? '') === (effectiveLocation ?? '')) {
    await loadPageFn(state.currentPage.slug, state.currentPage.location ?? null);
    return;
  }

  const visiblePages = (state.pages ?? []).filter(p => !p.hidden);
  const locPages = effectiveLocation
    ? visiblePages.filter(p => (p.location ?? '') === effectiveLocation)
    : visiblePages;
  const first = locPages[0] ?? visiblePages[0];
  if (first) {
    await loadPageFn(first.slug, first.location ?? null);
  } else {
    const grid = document.getElementById('pageGrid');
    const titleEl = document.getElementById('pageTitle');
    const actionsEl = document.getElementById('contentActions');
    if (grid) grid.innerHTML = '';
    if (titleEl) titleEl.textContent = '';
    if (actionsEl) actionsEl.innerHTML = '';
    updateSidebarFn(null);
  }
}

/**
 * Validate a newly created page title and check for name collisions.
 * @param {HTMLElement|null} titleEl
 * @param {string|null} targetLocation
 * @param {object} state
 * @param {(str: string) => string} slugifyFn
 * @returns {{ valid: boolean, title: string, slug: string }}
 */
export function validateNewPageTitle(titleEl, targetLocation, state, slugifyFn) {
  const newName = titleEl?.textContent.trim() ?? '';
  if (!newName) {
    titleEl?.classList.add('content__title--error');
    titleEl?.focus();
    return { valid: false, title: '', slug: '' };
  }
  titleEl?.classList.remove('content__title--error');

  const newSlug = slugifyFn(newName);
  const effectiveLocation = targetLocation ?? state.currentLocation;
  const duplicate = state.pages?.some(p => {
    const s = p.slug ?? slugifyFn(p.page_name ?? p['page-name'] ?? '');
    return s === newSlug && (p.location ?? '') === (effectiveLocation ?? '');
  });
  if (duplicate) {
    titleEl?.classList.add('content__title--error');
    titleEl?.focus();
    showErrorBubble(titleEl, 'A page with this name already exists.');
    return { valid: false, title: '', slug: '' };
  }

  return { valid: true, title: newName, slug: newSlug };
}

/**
 * Handle ArrowDown navigation in a sidebar/navigator tree list.
 * @param {{ getVisibleItems: () => HTMLElement[], getFocusedItem: (items: HTMLElement[]) => HTMLElement|null, setFocusedItem: (item: HTMLElement) => void, event: KeyboardEvent }} param0
 */
export function handleTreeNavArrowDown({ getVisibleItems, getFocusedItem, setFocusedItem, event }) {
  const items = getVisibleItems();
  if (items.length === 0) return;

  const current = getFocusedItem(items);
  const currentIndex = items.indexOf(current);
  let nextIndex = 0;
  if (currentIndex !== -1) {
    nextIndex = (currentIndex + 1) % items.length;
  }
  setFocusedItem(items[nextIndex]);
  event.preventDefault();
}

/**
 * Handle ArrowRight navigation in a sidebar/navigator tree list (expand folder or move to first child).
 * @param {{ getVisibleItems: () => HTMLElement[], getFocusedItem: (items: HTMLElement[]) => HTMLElement|null, setFocusedItem: (item: HTMLElement) => void, event: KeyboardEvent }} param0
 */
export function handleTreeNavArrowRight({ getVisibleItems, getFocusedItem, setFocusedItem, event }) {
  const items = getVisibleItems();
  if (items.length === 0) return;

  const current = getFocusedItem(items);
  if (!current) return;

  if (current.classList.contains('sidebar__group-summary')) {
    const details = current.closest('details.sidebar__group');
    if (details) {
      if (!details.open) {
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
        event.preventDefault();
        return;
      }
      const updatedItems = getVisibleItems();
      const currentIndex = updatedItems.indexOf(current);
      if (currentIndex !== -1 && currentIndex < updatedItems.length - 1) {
        setFocusedItem(updatedItems[currentIndex + 1]);
        event.preventDefault();
      }
    }
  }
}

/**
 * Handle ArrowLeft navigation in a sidebar/navigator tree list (collapse folder or jump to parent summary).
 * @param {{ getVisibleItems: () => HTMLElement[], getFocusedItem: (items: HTMLElement[]) => HTMLElement|null, setFocusedItem: (item: HTMLElement) => void, event: KeyboardEvent }} param0
 */
export function handleTreeNavArrowLeft({ getVisibleItems, getFocusedItem, setFocusedItem, event }) {
  const items = getVisibleItems();
  if (items.length === 0) return;

  const current = getFocusedItem(items);
  if (!current) return;

  const focusParent = (details) => {
    if (!details) return false;
    const parentSummary = details.querySelector(':scope > summary.sidebar__group-summary');
    if (parentSummary) {
      setFocusedItem(parentSummary);
      event.preventDefault();
      return true;
    }
    return false;
  };

  if (current.classList.contains('sidebar__group-summary')) {
    const details = current.closest('details.sidebar__group');
    if (details?.open) {
      details.open = false;
      details.dispatchEvent(new Event('toggle'));
      event.preventDefault();
      return;
    }
    const parentDetails = details?.parentElement?.closest('details.sidebar__group');
    focusParent(parentDetails);
  } else if (current.classList.contains('sidebar__page')) {
    const parentDetails = current.closest('details.sidebar__group');
    focusParent(parentDetails);
  }
}

/**
 * Handle End key navigation in a tree list (focuses last item).
 * @param {{ getVisibleItems: () => HTMLElement[], setFocusedItem: (item: HTMLElement) => void, event: KeyboardEvent }} param0
 */
export function handleTreeNavEnd({ getVisibleItems, setFocusedItem, event }) {
  const items = getVisibleItems();
  if (items.length > 0) {
    setFocusedItem(items.at(-1));
    event.preventDefault();
  }
}


