// mermaid-viewer.js — Interactive pan, zoom, and mini-map viewer for Mermaid diagrams

const SVG_ZOOM_IN = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>';
const SVG_ZOOM_OUT = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>';
const SVG_RESET = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
const SVG_MAP = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>';
const SVG_EXPAND = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
const SVG_COLLAPSE = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
const SVG_CLOSE = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

function createViewerButton(title, svgIcon) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mermaid-viewer__btn';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML = svgIcon;
  return btn;
}

/**
 * Extract natural coordinates (viewBox or bounding box) from an SVG element.
 */
function getSvgNaturalBounds(svg) {
  let vbX = 0;
  let vbY = 0;
  let vbW = 0;
  let vbH = 0;

  const viewBoxAttr = svg.getAttribute('viewBox');
  if (viewBoxAttr) {
    const parts = viewBoxAttr.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(n => !Number.isNaN(n))) {
      [vbX, vbY, vbW, vbH] = parts;
    }
  }

  if (!vbW || !vbH) {
    try {
      const bbox = svg.getBBox();
      vbX = bbox.x;
      vbY = bbox.y;
      vbW = bbox.width;
      vbH = bbox.height;
    } catch {
      const rect = svg.getBoundingClientRect();
      vbW = rect.width || 500;
      vbH = rect.height || 350;
    }
  }

  if (!vbW || !vbH) {
    vbW = 500;
    vbH = 350;
  }

  return { vbX, vbY, vbW, vbH };
}

/**
 * Initialize pan, zoom, and mini-map capabilities on a rendered Mermaid node.
 * @param {HTMLElement} mermaidNode
 */
export function initMermaidViewer(mermaidNode) {
  if (!mermaidNode) return;

  // Do not wrap inside Grid Note Windows or modals per user preference
  if (mermaidNode.closest('.note-window__view, .item__note-body, .modal')) return;

  const svg = mermaidNode.querySelector('svg');
  if (!svg) return;

  // Avoid wrapping if already initialized
  if (mermaidNode.closest('.mermaid-viewer')) return;

  const { vbX, vbY, vbW, vbH } = getSvgNaturalBounds(svg);

  // Configure original SVG styling for scalable rendering
  if (!svg.getAttribute('viewBox')) {
    svg.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
  }
  svg.style.maxWidth = 'none';
  svg.style.width = `${vbW}px`;
  svg.style.height = `${vbH}px`;
  svg.style.display = 'block';

  // Construct viewer DOM hierarchy
  const viewer = document.createElement('div');
  viewer.className = 'mermaid-viewer';
  viewer.tabIndex = 0;

  const toolbar = document.createElement('div');
  toolbar.className = 'mermaid-viewer__toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Mermaid Diagram Controls');

  const badge = document.createElement('span');
  badge.className = 'mermaid-viewer__badge';
  badge.textContent = '100%';
  badge.title = 'Reset to fit (0)';

  const zoomInBtn = createViewerButton('Zoom in (+)', SVG_ZOOM_IN);
  const zoomOutBtn = createViewerButton('Zoom out (-)', SVG_ZOOM_OUT);
  const resetBtn = createViewerButton('Fit to view (0)', SVG_RESET);
  const minimapBtn = createViewerButton('Toggle mini-map (m)', SVG_MAP);
  const fullscreenBtn = createViewerButton('Fullscreen (f)', SVG_EXPAND);

  toolbar.appendChild(badge);
  toolbar.appendChild(zoomInBtn);
  toolbar.appendChild(zoomOutBtn);
  toolbar.appendChild(resetBtn);
  toolbar.appendChild(minimapBtn);
  toolbar.appendChild(fullscreenBtn);

  const viewport = document.createElement('div');
  viewport.className = 'mermaid-viewer__viewport';

  const canvas = document.createElement('div');
  canvas.className = 'mermaid-viewer__canvas';

  // Reparent mermaidNode inside canvas
  mermaidNode.parentNode.insertBefore(viewer, mermaidNode);
  canvas.appendChild(mermaidNode);
  viewport.appendChild(canvas);

  // Hint element for in-place wheel scrolling
  const hint = document.createElement('div');
  hint.className = 'mermaid-viewer__hint';
  hint.textContent = 'Hold Ctrl + scroll to zoom diagram';
  hint.hidden = true;
  viewport.appendChild(hint);

  // Mini-map widget (hidden by default at 100%)
  const minimap = document.createElement('div');
  minimap.className = 'mermaid-viewer__minimap';
  minimap.hidden = true;

  const minimapHeader = document.createElement('div');
  minimapHeader.className = 'mermaid-viewer__minimap-header';
  const minimapTitle = document.createElement('span');
  minimapTitle.textContent = 'Mini-map';
  const minimapCloseBtn = document.createElement('button');
  minimapCloseBtn.type = 'button';
  minimapCloseBtn.className = 'mermaid-viewer__minimap-close';
  minimapCloseBtn.title = 'Close mini-map';
  minimapCloseBtn.setAttribute('aria-label', 'Close mini-map');
  minimapCloseBtn.innerHTML = SVG_CLOSE;
  minimapHeader.appendChild(minimapTitle);
  minimapHeader.appendChild(minimapCloseBtn);

  const minimapCanvas = document.createElement('div');
  minimapCanvas.className = 'mermaid-viewer__minimap-canvas';

  // Clone SVG for mini-map thumbnail
  const clonedSvg = svg.cloneNode(true);
  clonedSvg.removeAttribute('id');
  clonedSvg.style.width = '100%';
  clonedSvg.style.height = '100%';
  clonedSvg.style.maxWidth = 'none';
  clonedSvg.style.pointerEvents = 'none';
  clonedSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  clonedSvg.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
  minimapCanvas.appendChild(clonedSvg);

  const minimapViewport = document.createElement('div');
  minimapViewport.className = 'mermaid-viewer__minimap-viewport';
  minimapViewport.title = 'Drag to pan view';

  minimap.appendChild(minimapHeader);
  minimap.appendChild(minimapCanvas);
  minimap.appendChild(minimapViewport);
  viewport.appendChild(minimap);

  viewer.appendChild(toolbar);
  viewer.appendChild(viewport);

  // Mini-map dimensions calculation
  const MM_BASE_WIDTH = 150;
  const mmAspect = vbH / vbW;
  const mmWidth = MM_BASE_WIDTH;
  const mmHeight = Math.max(70, Math.min(130, Math.round(mmWidth * mmAspect)));
  minimap.style.width = `${mmWidth}px`;
  minimapCanvas.style.height = `${mmHeight}px`;

  // State
  let currentScale = 1;
  let fitScale = 1;
  let panX = 0;
  let panY = 0;
  let isFullscreen = false;
  let isMinimapVisible = false;
  let manuallyToggledAt100 = false;
  let userManuallyClosedAbove100 = false;
  let hintTimeout = null;

  // Bounds limits
  const MIN_SCALE_FACTOR = 0.2;
  const MAX_SCALE_FACTOR = 10;

  function updateMinimap() {
    if (!isMinimapVisible || !viewport.isConnected) return;

    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    if (!vw || !vh || !currentScale) return;

    const scaleX = mmWidth / vbW;
    const scaleY = mmHeight / vbH;

    // Current visible rectangle in diagram content coordinates
    const visLeft = -panX / currentScale;
    const visTop = -panY / currentScale;
    const visW = vw / currentScale;
    const visH = vh / currentScale;

    // Mapped into mini-map pixel space
    const boxLeft = Math.max(0, Math.min(mmWidth, visLeft * scaleX));
    const boxTop = Math.max(0, Math.min(mmHeight, visTop * scaleY));
    const boxRight = Math.max(0, Math.min(mmWidth, (visLeft + visW) * scaleX));
    const boxBottom = Math.max(0, Math.min(mmHeight, (visTop + visH) * scaleY));

    const boxW = Math.max(6, boxRight - boxLeft);
    const boxH = Math.max(6, boxBottom - boxTop);

    minimapViewport.style.left = `${boxLeft}px`;
    minimapViewport.style.top = `${boxTop}px`;
    minimapViewport.style.width = `${boxW}px`;
    minimapViewport.style.height = `${boxH}px`;
  }

  function setMinimapVisible(visible) {
    isMinimapVisible = visible;
    minimap.hidden = !visible;
    minimapBtn.classList.toggle('mermaid-viewer__btn--active', visible);
    minimapBtn.setAttribute('aria-pressed', String(visible));
    if (visible) updateMinimap();
  }

  function syncMinimapWithZoom(pct) {
    if (pct > 100) {
      manuallyToggledAt100 = false;
      // Show automatically when > 100% unless user closed it explicitly while zoomed
      if (!userManuallyClosedAbove100 && !isMinimapVisible) {
        setMinimapVisible(true);
      }
    } else {
      userManuallyClosedAbove100 = false;
      // Hide when <= 100% unless user manually turned it on at 100%
      if (!manuallyToggledAt100 && isMinimapVisible) {
        setMinimapVisible(false);
      }
    }
  }

  function updateTransform() {
    canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${currentScale})`;
    const pct = Math.round((currentScale / fitScale) * 100);
    badge.textContent = `${pct}%`;
    syncMinimapWithZoom(pct);
    updateMinimap();
  }

  function clampPan() {
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    if (!vw || !vh) return;

    const contentW = vbW * currentScale;
    const contentH = vbH * currentScale;

    const marginX = Math.min(vw * 0.7, 100);
    const marginY = Math.min(vh * 0.7, 100);

    const minPanX = -contentW + marginX;
    const maxPanX = vw - marginX;
    const minPanY = -contentH + marginY;
    const maxPanY = vh - marginY;

    panX = Math.max(minPanX, Math.min(maxPanX, panX));
    panY = Math.max(minPanY, Math.min(maxPanY, panY));
  }

  /**
   * Adjust zoom by fixed percentage steps (e.g. +10% or -10%), centered at a point.
   * @param {number} stepPercent - e.g. +10 or -10
   * @param {number} [clientX] - mouse/cursor X position in viewport
   * @param {number} [clientY] - mouse/cursor Y position in viewport
   */
  function zoomByPercentStep(stepPercent, clientX, clientY) {
    const currentPercent = Math.round((currentScale / fitScale) * 100);
    let targetPercent;

    if (stepPercent > 0) {
      targetPercent = Math.floor(currentPercent / 10) * 10 + stepPercent;
    } else {
      targetPercent = Math.ceil(currentPercent / 10) * 10 + stepPercent;
    }

    const minPercent = Math.round(MIN_SCALE_FACTOR * 100);
    const maxPercent = Math.round(MAX_SCALE_FACTOR * 100);
    targetPercent = Math.max(minPercent, Math.min(maxPercent, targetPercent));

    const targetScale = fitScale * (targetPercent / 100);
    if (Math.abs(targetScale - currentScale) < 0.0001) return;

    const rect = viewport.getBoundingClientRect();
    const cursorX = clientX != null ? clientX - rect.left : rect.width / 2;
    const cursorY = clientY != null ? clientY - rect.top : rect.height / 2;

    panX = cursorX - (cursorX - panX) * (targetScale / currentScale);
    panY = cursorY - (cursorY - panY) * (targetScale / currentScale);
    currentScale = targetScale;

    clampPan();
    updateTransform();
  }

  function fitDiagram() {
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    if (!vw || !vh) return;

    const pad = 24;
    const availW = Math.max(60, vw - pad * 2);
    const availH = Math.max(60, vh - pad * 2);

    fitScale = Math.min(availW / vbW, availH / vbH, 1.25);
    currentScale = fitScale;
    panX = Math.round((vw - vbW * currentScale) / 2);
    panY = Math.round((vh - vbH * currentScale) / 2);

    manuallyToggledAt100 = false;
    userManuallyClosedAbove100 = false;
    setMinimapVisible(false);

    updateTransform();
  }

  function toggleFullscreen() {
    isFullscreen = !isFullscreen;
    viewer.classList.toggle('mermaid-viewer--fullscreen', isFullscreen);
    fullscreenBtn.innerHTML = isFullscreen ? SVG_COLLAPSE : SVG_EXPAND;
    fullscreenBtn.title = isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen (f)';
    fullscreenBtn.setAttribute('aria-label', fullscreenBtn.title);

    if (isFullscreen) {
      document.body.classList.add('mermaid-viewer-open');
    } else {
      document.body.classList.remove('mermaid-viewer-open');
    }

    requestAnimationFrame(() => {
      fitDiagram();
    });
  }

  // --- Interaction Listeners ---

  // Toolbar actions with 10% steps
  zoomInBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    zoomByPercentStep(10);
  });

  zoomOutBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    zoomByPercentStep(-10);
  });

  resetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fitDiagram();
  });

  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    fitDiagram();
  });

  minimapBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const pct = Math.round((currentScale / fitScale) * 100);
    const newState = !isMinimapVisible;
    if (pct <= 100) {
      manuallyToggledAt100 = newState;
    } else {
      userManuallyClosedAbove100 = !newState;
    }
    setMinimapVisible(newState);
  });

  minimapCloseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const pct = Math.round((currentScale / fitScale) * 100);
    if (pct <= 100) {
      manuallyToggledAt100 = false;
    } else {
      userManuallyClosedAbove100 = true;
    }
    setMinimapVisible(false);
  });

  fullscreenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFullscreen();
  });

  // Mouse wheel zoom handling: 10% step per wheel click
  let wheelDeltaY = 0;
  let wheelResetTimer = null;
  const WHEEL_STEP_THRESHOLD = 80;

  viewport.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey || isFullscreen) {
      e.preventDefault();

      // Normalize deltaY across pixel, line, and page delta modes
      const normalizedDeltaY = e.deltaMode === 1
        ? e.deltaY * 33
        : (e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY);

      wheelDeltaY += normalizedDeltaY;

      if (wheelResetTimer) clearTimeout(wheelResetTimer);
      wheelResetTimer = setTimeout(() => {
        wheelDeltaY = 0;
      }, 150);

      if (Math.abs(wheelDeltaY) >= WHEEL_STEP_THRESHOLD) {
        const steps = Math.trunc(wheelDeltaY / WHEEL_STEP_THRESHOLD);
        wheelDeltaY -= steps * WHEEL_STEP_THRESHOLD;
        const stepPercent = -steps * 10;
        zoomByPercentStep(stepPercent, e.clientX, e.clientY);
      }
    } else {
      // Show subtle hint if user scrolls on diagram without Ctrl in in-place mode
      hint.hidden = false;
      hint.classList.add('mermaid-viewer__hint--visible');
      if (hintTimeout) clearTimeout(hintTimeout);
      hintTimeout = setTimeout(() => {
        hint.classList.remove('mermaid-viewer__hint--visible');
        setTimeout(() => { hint.hidden = true; }, 300);
      }, 1500);
    }
  }, { passive: false });

  // Main canvas mouse dragging
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let initialPanX = 0;
  let initialPanY = 0;

  viewport.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.mermaid-viewer__toolbar, .mermaid-viewer__minimap')) return;

    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    initialPanX = panX;
    initialPanY = panY;
    viewport.classList.add('mermaid-viewer__viewport--dragging');
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    panX = initialPanX + (e.clientX - dragStartX);
    panY = initialPanY + (e.clientY - dragStartY);
    clampPan();
    updateTransform();
  });

  window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    viewport.classList.remove('mermaid-viewer__viewport--dragging');
  });

  // Touch pan & pinch-to-zoom
  let initialPinchDist = null;
  let initialPinchScale = currentScale;

  viewport.addEventListener('touchstart', (e) => {
    if (e.target.closest('.mermaid-viewer__toolbar, .mermaid-viewer__minimap')) return;

    if (e.touches.length === 1) {
      isDragging = true;
      dragStartX = e.touches[0].clientX;
      dragStartY = e.touches[0].clientY;
      initialPanX = panX;
      initialPanY = panY;
    } else if (e.touches.length === 2) {
      isDragging = false;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      initialPinchDist = Math.hypot(dx, dy);
      initialPinchScale = currentScale;
    }
  }, { passive: true });

  viewport.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && isDragging) {
      panX = initialPanX + (e.touches[0].clientX - dragStartX);
      panY = initialPanY + (e.touches[0].clientY - dragStartY);
      clampPan();
      updateTransform();
    } else if (e.touches.length === 2 && initialPinchDist) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const currentDist = Math.hypot(dx, dy);
      const factor = currentDist / initialPinchDist;
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

      const targetScale = initialPinchScale * factor;
      const minScale = fitScale * MIN_SCALE_FACTOR;
      const maxScale = fitScale * MAX_SCALE_FACTOR;
      const clamped = Math.min(maxScale, Math.max(minScale, targetScale));

      const rect = viewport.getBoundingClientRect();
      const cursorX = midX - rect.left;
      const cursorY = midY - rect.top;

      panX = cursorX - (cursorX - panX) * (clamped / currentScale);
      panY = cursorY - (cursorY - panY) * (clamped / currentScale);
      currentScale = clamped;

      clampPan();
      updateTransform();
    }
  }, { passive: true });

  viewport.addEventListener('touchend', () => {
    isDragging = false;
    initialPinchDist = null;
  });

  // Mini-map Viewport Dragging
  let isMmDragging = false;
  let mmStartX = 0;
  let mmStartY = 0;
  let mmStartPanX = 0;
  let mmStartPanY = 0;

  minimapViewport.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    isMmDragging = true;
    mmStartX = e.clientX;
    mmStartY = e.clientY;
    mmStartPanX = panX;
    mmStartPanY = panY;
    minimapViewport.classList.add('mermaid-viewer__minimap-viewport--active');
  });

  window.addEventListener('mousemove', (e) => {
    if (!isMmDragging) return;
    const dx = e.clientX - mmStartX;
    const dy = e.clientY - mmStartY;

    const scaleX = mmWidth / vbW;
    const scaleY = mmHeight / vbH;

    panX = mmStartPanX - (dx / scaleX) * currentScale;
    panY = mmStartPanY - (dy / scaleY) * currentScale;

    clampPan();
    updateTransform();
  });

  window.addEventListener('mouseup', () => {
    if (!isMmDragging) return;
    isMmDragging = false;
    minimapViewport.classList.remove('mermaid-viewer__minimap-viewport--active');
  });

  // Mini-map Click to Jump
  minimapCanvas.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = minimapCanvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const scaleX = mmWidth / vbW;
    const scaleY = mmHeight / vbH;

    const targetContentX = clickX / scaleX;
    const targetContentY = clickY / scaleY;

    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;

    panX = (vw / 2) - targetContentX * currentScale;
    panY = (vh / 2) - targetContentY * currentScale;

    clampPan();
    updateTransform();
  });

  // Keyboard navigation when viewer has focus or is in fullscreen
  viewer.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'Escape' && isFullscreen) {
      e.preventDefault();
      e.stopPropagation();
      toggleFullscreen();
      return;
    }

    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomByPercentStep(10);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomByPercentStep(-10);
    } else if (e.key === '0') {
      e.preventDefault();
      fitDiagram();
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      const pct = Math.round((currentScale / fitScale) * 100);
      const newState = !isMinimapVisible;
      if (pct <= 100) {
        manuallyToggledAt100 = newState;
      } else {
        userManuallyClosedAbove100 = !newState;
      }
      setMinimapVisible(newState);
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleFullscreen();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      panY += 40;
      clampPan();
      updateTransform();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      panY -= 40;
      clampPan();
      updateTransform();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      panX += 40;
      clampPan();
      updateTransform();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      panX -= 40;
      clampPan();
      updateTransform();
    }
  });

  // ResizeObserver to handle container layout changes
  const resizeObserver = new ResizeObserver(() => {
    if (!viewer.isConnected) {
      resizeObserver.disconnect();
      return;
    }
    clampPan();
    updateTransform();
  });
  resizeObserver.observe(viewport);

  // Initial fit after DOM attachment
  requestAnimationFrame(() => {
    fitDiagram();
  });
}
