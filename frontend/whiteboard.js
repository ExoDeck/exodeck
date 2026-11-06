// whiteboard.js — Whiteboard page type using Excalidraw (lazy-loaded from CDN)
import { state, withLocation, refreshPages } from './app.js';
import { renderPageList, slugify, createPageActionMenu, updateSidebarVisibility } from './sidebar.js';
import { showErrorBubble, parseApiError, createEditorActionButtons, handleTabNavigation, navigateAfterPageCancel, validateNewPageTitle } from './ui-utils.js';
import { openConfirmModal } from './modal.js';

// ---------------------------------------------------------------------------
// CDN lazy loading
// ---------------------------------------------------------------------------

const LIBRARY_URLS = [
  'https://libraries.excalidraw.com/libraries/youritjang/software-architecture.excalidrawlib',
  'https://libraries.excalidraw.com/libraries/rohanp/system-design.excalidrawlib',
  'https://libraries.excalidraw.com/libraries/anna-pastushko/architecture-diagram-components.excalidrawlib',
  'https://libraries.excalidraw.com/libraries/BjoernKW/UML-ER-library.excalidrawlib',
  'https://libraries.excalidraw.com/libraries/aretecode/system-design-template.excalidrawlib',
];

let depsPromise = null;
let libraryPromise = null;

/**
 * Fetch and normalise all preset library files.
 * Handles both v1 ({ library: [[elements]] }) and v2 ({ libraryItems: [...] }) formats.
 * @returns {Promise<Array>}
 */
async function loadLibraryItems() {
  if (!libraryPromise) {
    libraryPromise = (async () => {
      const results = await Promise.allSettled(
        LIBRARY_URLS.map(url => fetch(url).then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      );
      const items = [];
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          console.warn('[ExoDeck] Failed to load library %s:', LIBRARY_URLS[i], result.reason);
          return;
        }
        const data = result.value;
        if (Array.isArray(data.libraryItems)) {
          // v2 format — already the right shape
          items.push(...data.libraryItems);
        } else if (Array.isArray(data.library)) {
          // v1 format — each entry is an array of elements
          data.library.forEach((elements, idx) => {
            items.push({ id: `lib-${i}-${idx}`, status: 'published', elements });
          });
        }
      });
      return items;
    })();
  }
  return libraryPromise;
}

/** @returns {Promise<{React: *, ReactDOM: *, Excalidraw: *}>} */
async function loadWhiteboardDeps() {
  if (!depsPromise) {
    depsPromise = (async () => {
      // Inject Excalidraw CSS once.
      // CSS lives at /dist/prod/index.css in the npm package (not /index.css).
      // Use unpkg which reliably serves raw package files.
      const CSS_ID = 'excalidraw-css';
      if (!document.getElementById(CSS_ID)) {
        const link = document.createElement('link');
        link.id = CSS_ID;
        link.rel = 'stylesheet';
        link.href = 'https://unpkg.com/@excalidraw/excalidraw@0.18.1/dist/prod/index.css';
        document.head.appendChild(link);
        // Wait for CSS to load before mounting
        await new Promise((resolve) => {
          link.onload = resolve;
          link.onerror = resolve; // continue even if CSS fails
        });
      }

      const [reactMod, reactDomMod, excalidrawMod] = await Promise.all([
        import('https://esm.sh/react@19'),
        import('https://esm.sh/react-dom@19/client'),
        // ?deps= pins Excalidraw's internal react/react-dom imports to the same
        // URLs as above, preventing the "multiple React instances" crash where
        // useMemo/useState return null because the dispatcher isn't set.
        import('https://esm.sh/@excalidraw/excalidraw@0.18.1?deps=react@19,react-dom@19'),
      ]);
      return {
        React: reactMod.default,
        ReactDOM: reactDomMod,
        Excalidraw: excalidrawMod.Excalidraw,
      };
    })();
  }
  return depsPromise;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

/** Fetch a whiteboard page's raw JSON from the backend. */
export async function fetchWhiteboardPage(slug, resolvedLocation) {
  const path = withLocation(`/whiteboards/${encodeURIComponent(slug)}`, resolvedLocation);
  const res = await fetch(`/api/v1${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(parseApiError(text, `Could not load whiteboard page ${slug}`));
  }
  const json = await res.json();
  return { 'page-name': json['page-name'] ?? slug, page_type: 'whiteboard', wbData: json };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Track the active React root so we can unmount when navigating away. */
let activeRoot = null;

/** Track the active theme observer so we can disconnect when navigating away. */
let activeThemeObserver = null;

/** Unmount any previously mounted Excalidraw instance. */
export function unmountWhiteboard() {
  if (activeThemeObserver) {
    activeThemeObserver.disconnect();
    activeThemeObserver = null;
  }
  if (activeRoot) {
    activeRoot.unmount();
    activeRoot = null;
  }
}

/**
 * Build sanitised Excalidraw initialData from stored page data.
 * Strips viewport/layout fields that cause canvas errors, and removes
 * collaborators (which round-trips as a plain object, breaking Excalidraw).
 */
function buildInitialData(page, libraryItems) {
  const sceneData = page.wbData?.excalidraw ?? null;
  // eslint-disable-next-line no-unused-vars
  const { scrollX, scrollY, zoom, collaborators, width, height, offsetLeft, offsetTop, ...safeAppState } =
    sceneData?.appState ?? {};
  return sceneData
    ? {
        elements: sceneData.elements ?? [],
        appState: safeAppState,
        files: sceneData.files ?? null,
        scrollToContent: !!(sceneData.elements?.length),
        libraryItems,
      }
    : { libraryItems };
}

/**
 * Mount Excalidraw into `container`, set up theme sync, and track the root.
 * Must only be called after unmountWhiteboard() and after the container is in
 * the DOM. Returns the rerender function so callers can re-theme if needed.
 */
function mountExcalidraw(React, ReactDOM, Excalidraw, container, initialData, { viewMode = false, onChange = null } = {}) {
  const getAppTheme = () =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

  let currentTheme = getAppTheme();
  activeRoot = ReactDOM.createRoot(container);

  const rerender = (theme) => {
    const props = { initialData, theme, viewModeEnabled: viewMode };
    if (onChange) props.onChange = onChange;
    activeRoot?.render(React.createElement(Excalidraw, props));
  };

  const observer = new MutationObserver(() => {
    const newTheme = getAppTheme();
    if (newTheme !== currentTheme) {
      currentTheme = newTheme;
      rerender(currentTheme);
    }
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  activeThemeObserver = observer;

  rerender(currentTheme);
}

/**
 * Render a whiteboard page in read-only view mode.
 * @param {{ 'page-name': string, page_type: 'whiteboard', wbData: object }} page
 * @param {string} slug
 * @param {string|null} location
 * @param {object|null} cachedDeps       - already-loaded { React, ReactDOM, Excalidraw }
 * @param {Array|null}  cachedLibItems
 */
async function renderWhiteboardView(page, slug, location, cachedDeps = null, cachedLibItems = null) {
  const contentEl = document.getElementById('content');
  const titleEl   = document.getElementById('pageTitle');
  const actionsEl = document.getElementById('contentActions');
  const grid      = document.getElementById('pageGrid');

  if (!grid) return;

  contentEl?.classList.remove('content--markdown');
  contentEl?.classList.add('content--whiteboard');

  if (titleEl) titleEl.textContent = page['page-name'] ?? '';
  if (actionsEl) actionsEl.innerHTML = '';

  // Unmount before touching the DOM so React can clean up while its
  // container node is still attached.
  unmountWhiteboard();
  grid.innerHTML = '';

  // Loading indicator
  const loader = document.createElement('div');
  loader.className = 'whiteboard-loading';
  loader.textContent = 'Loading Excalidraw…';
  grid.appendChild(loader);

  let deps, libraryItems;
  try {
    ([deps, libraryItems] = await Promise.all([
      cachedDeps    ? Promise.resolve(cachedDeps)    : loadWhiteboardDeps(),
      cachedLibItems ? Promise.resolve(cachedLibItems) : loadLibraryItems(),
    ]));
  } catch (err) {
    loader.textContent = `Failed to load Excalidraw: ${err.message}`;
    loader.className = 'whiteboard-loading whiteboard-loading--error';
    return;
  }

  loader.remove();

  const container = document.createElement('div');
  container.className = 'whiteboard-container';
  grid.appendChild(container);

  const { React, ReactDOM, Excalidraw } = deps;
  mountExcalidraw(React, ReactDOM, Excalidraw, container, buildInitialData(page, libraryItems), { viewMode: true });

  // Edit button
  if (actionsEl) {
    actionsEl.innerHTML = '';
    const editBtn = document.createElement('button');
    editBtn.id = 'editWbPageBtn';
    editBtn.type = 'button';
    editBtn.className = 'page-header__icon-btn';
    editBtn.title = 'Edit (e)';
    editBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 20px;">edit</span>';
    editBtn.addEventListener('click', () => enterEditMode(page, slug, location, deps, libraryItems));
    if (location !== 'docs') {
      const menuBtn = createPageActionMenu(slug, page['page-name'], 'whiteboard', location, true);
      actionsEl.appendChild(editBtn);
      actionsEl.appendChild(menuBtn);
    }
  }
}

/**
 * Switch to interactive edit mode: make title editable, enable drawing,
 * show Save / Cancel.
 */
async function enterEditMode(page, slug, location, deps, libraryItems) {
  const titleEl   = document.getElementById('pageTitle');
  const actionsEl = document.getElementById('contentActions');
  const grid      = document.getElementById('pageGrid');

  if (!grid) return;

  const originalPage = structuredClone(page);
  const originalSlug = slug;

  // Initialise pendingScene from stored data so Save works even without drawing.
  const sceneData = page.wbData?.excalidraw ?? null;
  let pendingScene = {
    elements: sceneData?.elements ?? [],
    appState: sceneData?.appState ?? {},
    files:    sceneData?.files ?? null,
  };

  // Make title editable
  if (titleEl) {
    titleEl.setAttribute('contenteditable', 'plaintext-only');
    titleEl.classList.add('content__title--editing');
    titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    titleEl.focus();
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    range.collapse(false);
    const sel = globalThis.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Unmount view-mode instance before clearing DOM.
  unmountWhiteboard();
  grid.innerHTML = '';

  const container = document.createElement('div');
  container.className = 'whiteboard-container';
  container.id = 'wbEditorContainer';
  grid.appendChild(container);

  const { React, ReactDOM, Excalidraw } = deps;
  mountExcalidraw(React, ReactDOM, Excalidraw, container, buildInitialData(page, libraryItems), {
    viewMode: false,
    onChange: (elements, appState, files) => { pendingScene = { elements, appState, files }; },
  });

  // Save / Cancel toolbar
  if (actionsEl) {
    actionsEl.innerHTML = '';

    const cancel = () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true });
      if (titleEl) {
        titleEl.removeAttribute('contenteditable');
        titleEl.classList.remove('content__title--editing', 'content__title--error');
      }
      renderWhiteboardView(originalPage, originalSlug, location, deps, libraryItems);
    };

    const initialTitle = originalPage['page-name'] ?? '';
    const initialElementsJson = JSON.stringify(originalPage.wbData?.excalidraw?.elements || []);

    const isDirty = () => {
      if ((titleEl?.textContent.trim() ?? '') !== initialTitle) return true;
      if (pendingScene.elements && JSON.stringify(pendingScene.elements) !== initialElementsJson) return true;
      return false;
    };

    const requestCancel = async () => {
      if (isDirty()) {
        const discard = await openConfirmModal();
        if (!discard) return;
      }
      cancel();
    };

    const save = async () => {
      const newName = titleEl?.textContent.trim() ?? '';
      if (!newName) {
        titleEl?.classList.add('content__title--error');
        return;
      }
      titleEl?.classList.remove('content__title--error');

      const payload = JSON.stringify({
        'page-name': newName,
        excalidraw: { elements: pendingScene.elements, appState: pendingScene.appState, files: pendingScene.files },
      });

      try {
          const path = withLocation(`/whiteboards/${encodeURIComponent(originalSlug)}`, location);
          const res = await fetch(`/api/v1${path}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
          });
          if (!res.ok) {
            const msg = await res.text().catch(() => res.statusText);
            showErrorBubble(titleEl, parseApiError(msg, 'Failed to save whiteboard.'));
            return;
          }
          const result = await res.json();
          state.currentSlug = result.slug ?? originalSlug;
          await refreshPages();
          renderPageList();

        const updatedPage = {
          'page-name': newName,
          page_type: 'whiteboard',
          wbData: { 'page-name': newName, excalidraw: { elements: pendingScene.elements, appState: pendingScene.appState, files: pendingScene.files } },
        };

        if (titleEl) {
          titleEl.removeAttribute('contenteditable');
          titleEl.classList.remove('content__title--editing');
        }

        document.removeEventListener('keydown', onKeyDown, { capture: true });
        renderWhiteboardView(updatedPage, state.currentSlug, location, deps, libraryItems);
      } catch (err) {
        showErrorBubble(`Save failed: ${err.message}`);
      }
    };

    const { saveBtn, cancelBtn } = createEditorActionButtons(
      save,
      () => { void requestCancel(); },
    );

    actionsEl.appendChild(saveBtn);
    actionsEl.appendChild(cancelBtn);
    if (location !== 'docs') {
      const menuBtn = createPageActionMenu(slug, originalPage['page-name'], 'whiteboard', location, true);
      actionsEl.appendChild(menuBtn);
    }

    function onKeyDown(e) {
      if (document.getElementById('_confirmModalOverlay')) return;
      // If the user is editing text inside a shape, let Excalidraw handle it
      const inExcalidrawTextEdit =
        document.activeElement?.closest('#wbEditorContainer') &&
        (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.isContentEditable);

      if (e.key === 'Escape') {
        if (inExcalidrawTextEdit) return;
        e.stopPropagation();
        void requestCancel();
      } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (inExcalidrawTextEdit) {
          // Commit the shape text by blurring, then save after Excalidraw's onChange fires
          document.activeElement.blur();
          setTimeout(save, 50);
        } else {
          save();
        }
      }
    }
    document.addEventListener('keydown', onKeyDown, { capture: true });
  }
}

/**
 * Entry point called from content.js — renders the page in read-only view mode.
 * @param {{ 'page-name': string, page_type: 'whiteboard', wbData: object }} page
 * @param {string} slug
 * @param {string|null} location
 */
export async function renderWhiteboardPage(page, slug, location) {
  return renderWhiteboardView(page, slug, location);
}

// ---------------------------------------------------------------------------
// Create whiteboard page
// ---------------------------------------------------------------------------

export function createWhiteboardPage(targetLocation = null) {
  updateSidebarVisibility('whiteboard');
  const contentEl = document.getElementById('content');
  const titleEl   = document.getElementById('pageTitle');
  const actionsEl = document.getElementById('contentActions');
  const grid      = document.getElementById('pageGrid');

  if (!grid) return;

  contentEl?.classList.remove('content--markdown');
  contentEl?.classList.add('content--whiteboard');

  // Empty editable title
  if (titleEl) {
    titleEl.textContent = '';
    titleEl.setAttribute('contenteditable', 'plaintext-only');
    titleEl.classList.add('content__title--editing');
    titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  }

  // Unmount any previous whiteboard and clear the area
  unmountWhiteboard();
  grid.innerHTML = '';
  if (actionsEl) actionsEl.innerHTML = '';

  // Loading indicator while deps load
  const loader = document.createElement('div');
  loader.className = 'whiteboard-loading';
  loader.textContent = 'Loading Excalidraw…';
  loader.tabIndex = 0;
  grid.appendChild(loader);

  // Track the pending scene (starts empty)
  let pendingScene = { elements: [], appState: {}, files: null };

  // Save / Cancel toolbar — shown immediately so Cancel works during load
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

  const getContentFocusElement = () => document.getElementById('wbNewContainer') ?? loader;

  const handleCreateTabOrder = (e) => {
    handleTabNavigation(e, [titleEl, getContentFocusElement(), cancelBtn, saveBtn]);
  };

  titleEl?.addEventListener('keydown', handleCreateTabOrder);
  loader.addEventListener('keydown', handleCreateTabOrder);
  cancelBtn.addEventListener('keydown', handleCreateTabOrder);
  saveBtn.addEventListener('keydown', handleCreateTabOrder);

  // Focus title so the user can type the name while Excalidraw loads
  titleEl?.focus();

  const cleanup = () => {
    document.removeEventListener('keydown', onKeyDown, { capture: true });
    titleEl?.removeEventListener('keydown', handleCreateTabOrder);
    loader.removeEventListener('keydown', handleCreateTabOrder);
    cancelBtn.removeEventListener('keydown', handleCreateTabOrder);
    saveBtn.removeEventListener('keydown', handleCreateTabOrder);
    document.getElementById('wbNewContainer')?.removeEventListener('keydown', handleCreateTabOrder);
    if (titleEl) {
      titleEl.removeAttribute('contenteditable');
      titleEl.classList.remove('content__title--editing', 'content__title--error');
    }
  };

  const cancel = async () => {
    cleanup();
    unmountWhiteboard();
    // Navigate to the current page if applicable, or first visible page for this location
    const { loadPage } = await import('./sidebar.js');
    await navigateAfterPageCancel(targetLocation, state, loadPage, updateSidebarVisibility);
  };

  const save = async () => {
    const { valid, title: newName, slug: newSlug } = validateNewPageTitle(titleEl, targetLocation, state, slugify);
    if (!valid) return;
    const effectiveLocation = targetLocation ?? state.currentLocation;

    const payload = JSON.stringify({
      'page-name': newName,
      excalidraw: { elements: pendingScene.elements, appState: pendingScene.appState, files: pendingScene.files },
    });

    saveBtn.disabled = true;
    try {
      const path = withLocation('/whiteboards', targetLocation);
      const res = await fetch(`/api/v1${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => res.statusText);
        if (res.status === 409) {
          titleEl?.classList.add('content__title--error');
          titleEl?.focus();
          showErrorBubble(titleEl, 'A page with this name already exists.');
          saveBtn.disabled = false;
          return;
        }
        throw new Error(parseApiError(msg, 'Failed to create whiteboard.'));
      }
      await refreshPages();

      cleanup();
      // Dynamically import loadPage to avoid circular deps at module init time
      const { loadPage } = await import('./sidebar.js');
      renderPageList();
      const match = state.pages.find(
        p => p.slug === newSlug && (p.location ?? '') === (effectiveLocation ?? '')
      ) ?? state.pages.find(p => p.slug === newSlug);
      if (match) await loadPage(match.slug, match.location ?? null);
    } catch (err) {
      showErrorBubble(titleEl, `Save failed: ${err.message}`);
      saveBtn.disabled = false;
    }
  };

  const isDirty = () => Boolean(titleEl?.textContent.trim()) || (pendingScene.elements && pendingScene.elements.length > 0);

  const requestCancel = async () => {
    if (isDirty()) {
      const discard = await openConfirmModal();
      if (!discard) return;
    }
    await cancel();
  };

  cancelBtn.addEventListener('click', () => { void requestCancel(); });
  saveBtn.addEventListener('click', () => { void save(); });

  function onKeyDown(e) {
    if (document.getElementById('_confirmModalOverlay')) return;
    const inExcalidrawTextEdit =
      document.activeElement?.closest('#wbNewContainer') &&
      (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.isContentEditable);

    if (e.key === 'Escape') {
      if (inExcalidrawTextEdit) return;
      e.stopPropagation();
      void requestCancel();
    } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (inExcalidrawTextEdit) {
        document.activeElement.blur();
        setTimeout(() => { void save(); }, 50);
      } else {
        void save();
      }
    }
  }
  document.addEventListener('keydown', onKeyDown, { capture: true });

  // Load Excalidraw deps and mount in interactive (edit) mode
  Promise.all([loadWhiteboardDeps(), loadLibraryItems()])
    .then(([deps, libraryItems]) => {
      loader.remove();
      const container = document.createElement('div');
      container.className = 'whiteboard-container';
      container.id = 'wbNewContainer';
      container.tabIndex = 0;
      grid.appendChild(container);
      container.addEventListener('keydown', handleCreateTabOrder);

      const { React, ReactDOM, Excalidraw } = deps;
      mountExcalidraw(React, ReactDOM, Excalidraw, container, { libraryItems }, {
        viewMode: false,
        onChange: (elements, appState, files) => { pendingScene = { elements, appState, files }; },
      });
    })
    .catch(err => {
      loader.textContent = `Failed to load Excalidraw: ${err.message}`;
      loader.className = 'whiteboard-loading whiteboard-loading--error';
    });
}

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------

/**
 * Export the whiteboard as a PNG and open a print popup window.
 * @param {string} slug
 * @param {string|null} location
 */
export async function printWhiteboardPage(slug, location = null) {
  const page = await fetchWhiteboardPage(slug, location);
  const sceneData = page.wbData?.excalidraw ?? null;
  const elements = sceneData?.elements ?? [];
  const files = sceneData?.files ?? null;
  // eslint-disable-next-line no-unused-vars
  const { scrollX, scrollY, zoom, collaborators, width, height, offsetLeft, offsetTop, ...safeAppState } =
    sceneData?.appState ?? {};

  const excalidrawMod = await import('https://esm.sh/@excalidraw/excalidraw@0.18.1?deps=react@19,react-dom@19');
  const { exportToBlob } = excalidrawMod;

  const blob = await exportToBlob({
    elements,
    appState: { ...safeAppState, exportBackground: true },
    files,
    getDimensions: () => ({ width: 2480, height: 1754, scale: 2 }),
  });

  const objectUrl = URL.createObjectURL(blob);
  const pageName = page['page-name'] ?? slug;

  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) {
    URL.revokeObjectURL(objectUrl);
    return;
  }

  win.document.documentElement.innerHTML = `
<head>
<meta charset="utf-8">
<title>${pageName.replaceAll('<', '&lt;')}</title>
<style>
  @page { margin: 0; size: landscape; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  img { max-width: 100%; max-height: 100vh; object-fit: contain; display: block; }
</style>
</head>
<body>
<img id="print-img">
<script>
  const img = document.getElementById('print-img');
  img.onload = function() {
    window.print();
    setTimeout(() => URL.revokeObjectURL(this.src), 60000);
  };
</script>
</body>`;
  const printImg = win.document.getElementById('print-img');
  printImg.src = objectUrl;
  printImg.alt = pageName;
}
