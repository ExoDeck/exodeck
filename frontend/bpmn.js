// bpmn.js — Business Process page type using bpmn-js (lazy-loaded from CDN)
import { state, withLocation, refreshPages } from './app.js';
import { renderPageList, slugify, createPageActionMenu, updateSidebarVisibility } from './sidebar.js';
import { showErrorBubble, parseApiError, createEditorActionButtons, handleTabNavigation, navigateAfterPageCancel, validateNewPageTitle } from './ui-utils.js';
import { openConfirmModal } from './modal.js';

// ---------------------------------------------------------------------------
// CDN lazy loading
// ---------------------------------------------------------------------------

const BPMN_VERSION = '18.28.0';
const CSS_URLS = [
  `https://unpkg.com/bpmn-js@${BPMN_VERSION}/dist/assets/diagram-js.css`,
  `https://unpkg.com/bpmn-js@${BPMN_VERSION}/dist/assets/bpmn-js.css`,
  `https://unpkg.com/bpmn-js@${BPMN_VERSION}/dist/assets/bpmn-font/css/bpmn.css`,
];

const DEFAULT_BPMN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
                  id="Definitions_1"
                  targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="_BPMNShape_StartEvent_2" bpmnElement="StartEvent_1">
        <dc:Bounds x="179" y="159" width="36" height="36"/>
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

let depsPromise = null;

/**
 * Lazy-load bpmn-js stylesheets and ES modules.
 * @returns {Promise<{ BpmnModeler: *, BpmnViewer: * }>}
 */
async function loadBpmnDeps() {
  if (!depsPromise) {
    depsPromise = (async () => {
      // Inject stylesheets once
      const cssLoads = CSS_URLS.map((url, i) => {
        const id = `bpmn-css-${i}`;
        if (document.getElementById(id)) return Promise.resolve();
        const link = document.createElement('link');
        link.id = id;
        link.rel = 'stylesheet';
        link.href = url;
        const ref = document.querySelector('link[href*="style.css"]') || document.head.firstChild;
        if (ref) {
          document.head.insertBefore(link, ref);
        } else {
          document.head.appendChild(link);
        }
        return new Promise((resolve) => {
          link.onload = resolve;
          link.onerror = resolve; // Continue even if a stylesheet fails to load
        });
      });
      await Promise.all(cssLoads);

      const [modelerMod, viewerMod] = await Promise.all([
        import(`https://esm.sh/bpmn-js@${BPMN_VERSION}/lib/Modeler`),
        import(`https://esm.sh/bpmn-js@${BPMN_VERSION}/lib/NavigatedViewer`),
      ]);

      return {
        BpmnModeler: modelerMod.default,
        BpmnViewer: viewerMod.default,
      };
    })();
  }
  return depsPromise;
}

// ---------------------------------------------------------------------------
// Instance and Lifecycle Management
// ---------------------------------------------------------------------------

let activeInstance = null;
let activeThemeObserver = null;
let activeResizeObserver = null;

/** Unmount and destroy any active bpmn-js viewer or modeler. */
export function unmountBpmn() {
  if (activeThemeObserver) {
    activeThemeObserver.disconnect();
    activeThemeObserver = null;
  }
  if (activeResizeObserver) {
    activeResizeObserver.disconnect();
    activeResizeObserver = null;
  }
  if (activeInstance) {
    try {
      activeInstance.destroy();
    } catch (err) {
      console.warn('[ExoDeck] Error destroying bpmn-js instance:', err);
    }
    activeInstance = null;
  }
}

/**
 * Center and fit the BPMN diagram within the viewport.
 * @param {*} instance - Modeler or Viewer instance
 */
function centerBpmnDiagram(instance) {
  try {
    const canvas = instance.get('canvas');
    canvas.resized();
    const { inner } = canvas.viewbox();
    if (inner && inner.width > 0 && inner.height > 0) {
      const center = {
        x: inner.x + inner.width / 2,
        y: inner.y + inner.height / 2,
      };
      canvas.zoom('fit-viewport', center);
      // Avoid excessive magnification on small diagrams
      if (canvas.zoom() > 1.0) {
        canvas.zoom(1.0, center);
      }
    } else {
      canvas.zoom('fit-viewport', 'auto');
    }
  } catch (err) {
    console.warn('[ExoDeck] Error centering BPMN diagram:', err);
  }
}

/**
 * Configure fine-grained zoom steps for the mouse wheel.
 * Default diagram-js uses 10 steps across 0.2..4.0 range (~16% zoom jump per notch).
 * We adjust this to ~4.4% per notch for smooth, fine-grained control.
 * @param {*} instance - Modeler or Viewer instance
 */
function configureFineGrainedZoom(instance) {
  try {
    const zoomScroll = instance.get('zoomScroll');
    if (!zoomScroll) return;

    const RANGE = { min: 0.2, max: 4.0 };
    const FINE_NUM_STEPS = 35;
    const stepSize = (Math.log10(RANGE.max) - Math.log10(RANGE.min)) / (FINE_NUM_STEPS * 2);

    zoomScroll.zoom = function(delta, position) {
      this._totalDelta += delta;
      if (Math.abs(this._totalDelta) > 0.1) {
        this._zoom(delta, position, stepSize);
        this._totalDelta = 0;
      }
    };

    zoomScroll._zoom = function(delta, position, customStepSize) {
      const canvas = this._canvas;
      const currentZoom = canvas.zoom();
      if (!currentZoom || Number.isNaN(currentZoom)) return;

      const direction = delta > 0 ? 1 : -1;
      const effectiveStep = customStepSize || stepSize;

      const currentLinear = Math.log10(currentZoom);
      let newLinear = Math.round(currentLinear / effectiveStep) * effectiveStep;
      newLinear += effectiveStep * direction;

      const newZoom = Math.pow(10, newLinear);
      const clampedZoom = Math.min(Math.max(newZoom, RANGE.min), RANGE.max);

      canvas.zoom(clampedZoom, position);
    };
  } catch (err) {
    console.warn('[ExoDeck] Could not configure fine-grained zoom:', err);
  }
}

function getRendererConfig() {
  const isLight = document.documentElement.dataset.theme === 'light';
  return {
    defaultFillColor: isLight ? '#ffffff' : '#222226',
    defaultStrokeColor: isLight ? '#1a1a1a' : '#e0e0e0',
    defaultLabelColor: isLight ? '#1a1a1a' : '#e0e0e0',
  };
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

/** Fetch a BPMN page's data from the backend. */
export async function fetchBpmnPage(slug, resolvedLocation) {
  const path = withLocation(`/bpmn/${encodeURIComponent(slug)}`, resolvedLocation);
  const res = await fetch(`/api/v1${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(parseApiError(text, `Could not load BPMN page ${slug}`));
  }
  const json = await res.json();
  return { 'page-name': json['page-name'] ?? slug, page_type: 'bpmn', bpmnData: json };
}

// ---------------------------------------------------------------------------
// Render: View Mode
// ---------------------------------------------------------------------------

/**
 * Render a Business Process page in read-only view mode.
 * @param {{ 'page-name': string, page_type: 'bpmn', bpmnData: object }} page
 * @param {string} slug
 * @param {string|null} location
 * @param {object|null} cachedDeps
 */
async function renderBpmnView(page, slug, location, cachedDeps = null) {
  const contentEl = document.getElementById('content');
  const titleEl   = document.getElementById('pageTitle');
  const actionsEl = document.getElementById('contentActions');
  const grid      = document.getElementById('pageGrid');

  if (!grid) return;

  contentEl?.classList.remove('content--markdown', 'content--whiteboard');
  contentEl?.classList.add('content--bpmn');

  if (titleEl) titleEl.textContent = page['page-name'] ?? '';
  if (actionsEl) actionsEl.innerHTML = '';

  unmountBpmn();
  grid.innerHTML = '';

  // Loading indicator
  const loader = document.createElement('div');
  loader.className = 'bpmn-loading';
  loader.textContent = 'Loading bpmn-js…';
  grid.appendChild(loader);

  let deps;
  try {
    deps = cachedDeps ?? await loadBpmnDeps();
  } catch (err) {
    loader.textContent = `Failed to load bpmn-js: ${err.message}`;
    loader.className = 'bpmn-loading bpmn-loading--error';
    return;
  }

  loader.remove();

  const container = document.createElement('div');
  container.className = 'bpmn-container';
  container.id = 'bpmnViewerContainer';
  grid.appendChild(container);

  const { BpmnViewer } = deps;
  const viewer = new BpmnViewer({
    container,
    bpmnRenderer: getRendererConfig(),
  });
  activeInstance = viewer;
  configureFineGrainedZoom(viewer);

  const xml = page.bpmnData?.bpmn_xml || DEFAULT_BPMN_XML;
  try {
    await viewer.importXML(xml);
    centerBpmnDiagram(viewer);
    requestAnimationFrame(() => centerBpmnDiagram(viewer));
  } catch (err) {
    console.error('[ExoDeck] BPMN import failed:', err);
    showErrorBubble(`Could not render diagram: ${err.message}`);
  }

  // Observe container size changes (e.g. sidebar toggle or window resize)
  activeResizeObserver = new ResizeObserver(() => {
    try {
      viewer.get('canvas')?.resized();
    } catch {
      // ignore
    }
  });
  activeResizeObserver.observe(container);

  // Theme change observer
  let currentTheme = document.documentElement.dataset.theme;
  const observer = new MutationObserver(() => {
    const newTheme = document.documentElement.dataset.theme;
    if (newTheme !== currentTheme) {
      currentTheme = newTheme;
      void renderBpmnView(page, slug, location, deps);
    }
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  activeThemeObserver = observer;

  // Actions: Edit button & menu
  if (actionsEl) {
    actionsEl.innerHTML = '';
    const editBtn = document.createElement('button');
    editBtn.id = 'editBpmnPageBtn';
    editBtn.type = 'button';
    editBtn.className = 'page-header__icon-btn';
    editBtn.title = 'Edit (e)';
    editBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 20px;">edit</span>';
    editBtn.addEventListener('click', () => { void enterEditMode(page, slug, location, deps); });
    actionsEl.appendChild(editBtn);

    if (location !== 'docs') {
      const menuBtn = createPageActionMenu(slug, page['page-name'], 'bpmn', location, true);
      actionsEl.appendChild(menuBtn);
    }
  }
}

// ---------------------------------------------------------------------------
// Render: Edit Mode
// ---------------------------------------------------------------------------

function createBpmnKeyHandler({ requestCancel, save }) {
  return function onKeyDown(e) {
    if (document.getElementById('_confirmModalOverlay')) return;
    const inBpmnDirectEditing = document.querySelector('.djs-direct-editing-content');
    if (inBpmnDirectEditing?.contains(document.activeElement)) {
      if (e.key === 'Escape') return;
    }

    if (e.key === 'Escape') {
      e.stopPropagation();
      void requestCancel();
    } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (inBpmnDirectEditing) {
        document.activeElement?.blur();
        setTimeout(() => { void save(); }, 50);
      } else {
        void save();
      }
    }
  };
}

/**
 * Switch to interactive edit mode: make title editable, enable BPMN modeler,
 * show Save / Cancel toolbar.
 */
async function enterEditMode(page, slug, location, deps) {
  const titleEl   = document.getElementById('pageTitle');
  const actionsEl = document.getElementById('contentActions');
  const grid      = document.getElementById('pageGrid');

  if (!grid) return;

  const originalPage = structuredClone(page);
  const originalSlug = slug;

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

  unmountBpmn();
  grid.innerHTML = '';

  const container = document.createElement('div');
  container.className = 'bpmn-container';
  container.id = 'bpmnEditorContainer';
  grid.appendChild(container);

  const { BpmnModeler } = deps;
  const modeler = new BpmnModeler({
    container,
    bpmnRenderer: getRendererConfig(),
  });
  activeInstance = modeler;
  configureFineGrainedZoom(modeler);

  const xml = page.bpmnData?.bpmn_xml || DEFAULT_BPMN_XML;
  try {
    await modeler.importXML(xml);
    centerBpmnDiagram(modeler);
    requestAnimationFrame(() => centerBpmnDiagram(modeler));
  } catch (err) {
    console.error('[ExoDeck] BPMN modeler import failed:', err);
    showErrorBubble(`Could not load diagram into editor: ${err.message}`);
  }

  // Observe container size changes (e.g. sidebar toggle or window resize)
  activeResizeObserver = new ResizeObserver(() => {
    try {
      modeler.get('canvas')?.resized();
    } catch {
      // ignore
    }
  });
  activeResizeObserver.observe(container);

  // Save / Cancel toolbar
  if (actionsEl) {
    actionsEl.innerHTML = '';

    let onKeyDown;
    const cancel = () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true });
      if (titleEl) {
        titleEl.removeAttribute('contenteditable');
        titleEl.classList.remove('content__title--editing', 'content__title--error');
      }
      void renderBpmnView(originalPage, originalSlug, location, deps);
    };

    let isDiagramDirty = false;
    modeler.on('commandStack.changed', () => { isDiagramDirty = true; });

    const initialTitle = originalPage['page-name'] ?? '';
    const isDirty = () => (titleEl?.textContent.trim() ?? '') !== initialTitle || isDiagramDirty;

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

      let exportedXml;
      try {
        const result = await modeler.saveXML({ format: true });
        exportedXml = result.xml;
      } catch (err) {
        showErrorBubble(`Exporting diagram XML failed: ${err.message}`);
        return;
      }

      const payload = JSON.stringify({
        'page-name': newName,
        bpmn_xml: exportedXml,
      });

      try {
        const path = withLocation(`/bpmn/${encodeURIComponent(originalSlug)}`, location);
        const res = await fetch(`/api/v1${path}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        });
        if (!res.ok) {
          const msg = await res.text().catch(() => res.statusText);
          showErrorBubble(titleEl, parseApiError(msg, 'Failed to save BPMN diagram.'));
          return;
        }
        const result = await res.json();
        state.currentSlug = result.slug ?? originalSlug;
        await refreshPages();
        renderPageList();

        const updatedPage = {
          'page-name': newName,
          page_type: 'bpmn',
          bpmnData: { 'page-name': newName, bpmn_xml: exportedXml },
        };

        if (titleEl) {
          titleEl.removeAttribute('contenteditable');
          titleEl.classList.remove('content__title--editing');
        }

        document.removeEventListener('keydown', onKeyDown, { capture: true });
        await renderBpmnView(updatedPage, state.currentSlug, location, deps);
      } catch (err) {
        showErrorBubble(`Save failed: ${err.message}`);
      }
    };

    const { saveBtn, cancelBtn } = createEditorActionButtons(
      () => { void save(); },
      () => { void requestCancel(); },
    );
    actionsEl.appendChild(saveBtn);
    actionsEl.appendChild(cancelBtn);

    if (location !== 'docs') {
      const menuBtn = createPageActionMenu(slug, originalPage['page-name'], 'bpmn', location, true);
      actionsEl.appendChild(menuBtn);
    }

    onKeyDown = createBpmnKeyHandler({ requestCancel, save });
    document.addEventListener('keydown', onKeyDown, { capture: true });
  }
}

/**
 * Entry point called from content.js — renders the page in read-only view mode.
 * @param {{ 'page-name': string, page_type: 'bpmn', bpmnData: object }} page
 * @param {string} slug
 * @param {string|null} location
 */
export async function renderBpmnPage(page, slug, location) {
  return renderBpmnView(page, slug, location);
}

// ---------------------------------------------------------------------------
// Create Business Process page
// ---------------------------------------------------------------------------

export function createBpmnPage(targetLocation = null) {
  updateSidebarVisibility('bpmn');
  const contentEl = document.getElementById('content');
  const titleEl   = document.getElementById('pageTitle');
  const actionsEl = document.getElementById('contentActions');
  const grid      = document.getElementById('pageGrid');

  if (!grid) return;

  contentEl?.classList.remove('content--markdown', 'content--whiteboard');
  contentEl?.classList.add('content--bpmn');

  // Empty editable title
  if (titleEl) {
    titleEl.textContent = '';
    titleEl.setAttribute('contenteditable', 'plaintext-only');
    titleEl.classList.add('content__title--editing');
    titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  }

  unmountBpmn();
  grid.innerHTML = '';
  if (actionsEl) actionsEl.innerHTML = '';

  // Loading indicator while deps load
  const loader = document.createElement('div');
  loader.className = 'bpmn-loading';
  loader.textContent = 'Loading bpmn-js…';
  loader.tabIndex = 0;
  grid.appendChild(loader);

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

  const getContentFocusElement = () => document.getElementById('bpmnNewContainer') ?? loader;

  const handleCreateTabOrder = (e) => {
    handleTabNavigation(e, [titleEl, getContentFocusElement(), cancelBtn, saveBtn]);
  };

  titleEl?.addEventListener('keydown', handleCreateTabOrder);
  loader.addEventListener('keydown', handleCreateTabOrder);
  cancelBtn.addEventListener('keydown', handleCreateTabOrder);
  saveBtn.addEventListener('keydown', handleCreateTabOrder);

  titleEl?.focus();

  let onKeyDown;
  const cleanup = () => {
    document.removeEventListener('keydown', onKeyDown, { capture: true });
    titleEl?.removeEventListener('keydown', handleCreateTabOrder);
    loader.removeEventListener('keydown', handleCreateTabOrder);
    cancelBtn.removeEventListener('keydown', handleCreateTabOrder);
    saveBtn.removeEventListener('keydown', handleCreateTabOrder);
    document.getElementById('bpmnNewContainer')?.removeEventListener('keydown', handleCreateTabOrder);
    if (titleEl) {
      titleEl.removeAttribute('contenteditable');
      titleEl.classList.remove('content__title--editing', 'content__title--error');
    }
  };

  const cancel = async () => {
    cleanup();
    unmountBpmn();
    const { loadPage } = await import('./sidebar.js');
    await navigateAfterPageCancel(targetLocation, state, loadPage, updateSidebarVisibility);
  };

  const save = async () => {
    const { valid, title: newName, slug: newSlug } = validateNewPageTitle(titleEl, targetLocation, state, slugify);
    if (!valid) return;
    const effectiveLocation = targetLocation ?? state.currentLocation;

    if (!activeInstance) {
      showErrorBubble(titleEl, 'BPMN editor is still loading.');
      return;
    }

    let exportedXml;
    try {
      const result = await activeInstance.saveXML({ format: true });
      exportedXml = result.xml;
    } catch (err) {
      showErrorBubble(titleEl, `Exporting diagram failed: ${err.message}`);
      return;
    }

    const payload = JSON.stringify({
      'page-name': newName,
      bpmn_xml: exportedXml,
    });

    saveBtn.disabled = true;
    try {
      const path = withLocation('/bpmn', targetLocation);
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
        throw new Error(parseApiError(msg, 'Failed to create BPMN diagram.'));
      }
      await refreshPages();

      cleanup();
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

  let isDiagramDirty = false;
  const isDirty = () => Boolean(titleEl?.textContent.trim()) || isDiagramDirty;

  const requestCancel = async () => {
    if (isDirty()) {
      const discard = await openConfirmModal();
      if (!discard) return;
    }
    await cancel();
  };

  cancelBtn.addEventListener('click', () => { void requestCancel(); });
  saveBtn.addEventListener('click', () => { void save(); });

  onKeyDown = createBpmnKeyHandler({ requestCancel, save });
  document.addEventListener('keydown', onKeyDown, { capture: true });

  void loadBpmnDeps()
    .then(async (deps) => {
      loader.remove();
      const container = document.createElement('div');
      container.className = 'bpmn-container';
      container.id = 'bpmnNewContainer';
      container.tabIndex = 0;
      grid.appendChild(container);
      container.addEventListener('keydown', handleCreateTabOrder);

      const { BpmnModeler } = deps;
      const modeler = new BpmnModeler({
        container,
        bpmnRenderer: getRendererConfig(),
      });
      activeInstance = modeler;

      await modeler.importXML(DEFAULT_BPMN_XML);
      modeler.get('canvas').zoom('fit-viewport');
      modeler.on('commandStack.changed', () => { isDiagramDirty = true; });
    })
    .catch((err) => {
      loader.textContent = `Failed to load bpmn-js: ${err.message}`;
      loader.className = 'bpmn-loading bpmn-loading--error';
    });
}

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------

/**
 * Export the BPMN diagram as SVG and open a print popup window.
 * @param {string} slug
 * @param {string|null} location
 */
export async function printBpmnPage(slug, location = null) {
  const page = await fetchBpmnPage(slug, location);
  const xml = page.bpmnData?.bpmn_xml || DEFAULT_BPMN_XML;
  const deps = await loadBpmnDeps();

  // Create temporary off-screen container for rendering SVG export
  const offscreen = document.createElement('div');
  offscreen.style.position = 'fixed';
  offscreen.style.left = '-9999px';
  offscreen.style.top = '-9999px';
  offscreen.style.width = '1600px';
  offscreen.style.height = '1200px';
  document.body.appendChild(offscreen);

  const { BpmnViewer } = deps;
  const viewer = new BpmnViewer({
    container: offscreen,
    bpmnRenderer: {
      defaultFillColor: '#ffffff',
      defaultStrokeColor: '#000000',
      defaultLabelColor: '#000000',
    },
  });

  let svgData;
  try {
    await viewer.importXML(xml);
    viewer.get('canvas').zoom('fit-viewport');
    const result = await viewer.saveSVG();
    svgData = result.svg;
  } finally {
    viewer.destroy();
    offscreen.remove();
  }

  const blob = new Blob([svgData], { type: 'image/svg+xml' });
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
