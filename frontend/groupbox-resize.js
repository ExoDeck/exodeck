// groupbox-resize.js — Viewport max-height enforcement, vertical resize handle, and localStorage persistence

const STORAGE_GROUP_HEIGHTS_KEY = 'exodeck_group_heights';
const MIN_GROUP_CARD_HEIGHT = 76;
const RESET_SNAP_THRESHOLD = 4;

/**
 * Read the saved card height map from browser localStorage.
 * @returns {Record<string, number>}
 */
function readStoredHeights() {
  try {
    const raw = localStorage.getItem(STORAGE_GROUP_HEIGHTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (err) {
    console.warn('[ExoDeck] Failed to read group heights from localStorage:', err);
  }
  return {};
}

/**
 * Persist the card height map to browser localStorage.
 * @param {Record<string, number>} map
 */
function writeStoredHeights(map) {
  try {
    if (Object.keys(map).length === 0) {
      localStorage.removeItem(STORAGE_GROUP_HEIGHTS_KEY);
    } else {
      localStorage.setItem(STORAGE_GROUP_HEIGHTS_KEY, JSON.stringify(map));
    }
  } catch (err) {
    console.warn('[ExoDeck] Failed to write group heights to localStorage:', err);
  }
}

/**
 * Build a stable storage key for a group box or sticky note.
 * Uses workspace location, page slug, group title, and same-title occurrence index
 * so heights survive group reordering.
 * @param {string|null|undefined} location
 * @param {string} slug
 * @param {string|null|undefined} title
 * @param {number} [occurrenceIndex=0]
 * @returns {string}
 */
export function buildGroupHeightKey(location, slug, title, occurrenceIndex = 0) {
  return `${location || ''}::${slug || ''}::${title ?? ''}::${occurrenceIndex}`;
}

/**
 * Count how many groups before `groupIndex` share the same title on a page.
 * @param {Array<{title?: string}>|null|undefined} groups
 * @param {number} groupIndex
 * @returns {number}
 */
export function getGroupOccurrenceIndex(groups, groupIndex) {
  if (!Array.isArray(groups) || groupIndex < 0 || groupIndex >= groups.length) {
    return 0;
  }
  const targetTitle = groups[groupIndex]?.title ?? '';
  let count = 0;
  for (let i = 0; i < groupIndex; i++) {
    if ((groups[i]?.title ?? '') === targetTitle) {
      count += 1;
    }
  }
  return count;
}

/**
 * Measure the maximum height a group card may occupy inside the visible viewport.
 * @returns {number}
 */
export function getScreenMaxGroupHeightPx() {
  const contentEl = document.getElementById('content');
  const available = contentEl && contentEl.clientHeight > 0
    ? contentEl.clientHeight - 18
    : window.innerHeight - 68;
  return Math.max(MIN_GROUP_CARD_HEIGHT, Math.floor(available));
}

/**
 * Read a saved custom max-height (in px) for a card key, if valid.
 * @param {string} key
 * @returns {number|null}
 */
export function getSavedGroupMaxHeight(key) {
  if (!key) return null;
  const map = readStoredHeights();
  const value = map[key];
  if (typeof value === 'number' && Number.isFinite(value) && value >= MIN_GROUP_CARD_HEIGHT) {
    return Math.round(value);
  }
  return null;
}

/**
 * Save a custom max-height (in px) for a card key.
 * @param {string} key
 * @param {number} heightPx
 */
export function saveGroupMaxHeight(key, heightPx) {
  if (!key || !Number.isFinite(heightPx)) return;
  const map = readStoredHeights();
  map[key] = Math.max(MIN_GROUP_CARD_HEIGHT, Math.round(heightPx));
  writeStoredHeights(map);
}

/**
 * Remove any saved custom max-height for a card key.
 * @param {string} key
 */
export function clearGroupMaxHeight(key) {
  if (!key) return;
  const map = readStoredHeights();
  if (!(key in map)) return;
  delete map[key];
  writeStoredHeights(map);
}

/**
 * Move a saved custom max-height from one key to another (e.g., on rename or page move).
 * @param {string} oldKey
 * @param {string} newKey
 */
export function migrateGroupMaxHeight(oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) return;
  const map = readStoredHeights();
  if (!(oldKey in map)) return;
  map[newKey] = map[oldKey];
  delete map[oldKey];
  writeStoredHeights(map);
}

function syncResetButton(card, resetBtn) {
  if (!resetBtn) return;
  resetBtn.hidden = !card.classList.contains('group-card--resized');
}

function setCardCustomHeight(card, heightPx, resetBtn = null) {
  card.style.setProperty('--group-card-custom-max-height', `${Math.round(heightPx)}px`);
  card.classList.add('group-card--resized');
  syncResetButton(card, resetBtn);
}

function clearCardCustomHeight(card, resetBtn = null) {
  card.style.removeProperty('--group-card-custom-max-height');
  card.style.removeProperty('--group-card-row-floor');
  card.classList.remove('group-card--resized');
  syncResetButton(card, resetBtn);
}

function resetCardHeight(card, key, resetBtn = null) {
  clearGroupMaxHeight(key);
  clearCardCustomHeight(card, resetBtn);
}

/**
 * Group `.group-card` elements in `#pageGrid` by CSS Grid visual row (`top` coordinate).
 * @param {HTMLElement} grid
 * @returns {HTMLElement[][]}
 */
function collectGridRows(grid) {
  const rows = [];
  for (const el of grid.children) {
    if (!el.classList.contains('group-card')) continue;
    const top = el.getBoundingClientRect().top;
    const existing = rows.find(row => Math.abs(row.top - top) <= 4);
    if (existing) {
      existing.cards.push(el);
    } else {
      rows.push({ top, cards: [el] });
    }
  }
  return rows.map(r => r.cards);
}

/**
 * Ensure every resized card in `#pageGrid` has a row floor at least equal to the
 * tallest other box in the same row so resized boxes never sit shorter than row peers.
 * @param {HTMLElement|null} grid
 */
export function syncGridRowFloors(grid) {
  if (!grid) return;
  const allCards = Array.from(grid.children).filter(el => el.classList.contains('group-card'));
  const hasAnyResized = allCards.some(el => el.classList.contains('group-card--resized'));
  if (!hasAnyResized) {
    for (const el of allCards) {
      el.style.removeProperty('--group-card-row-floor');
    }
    return;
  }

  const rows = collectGridRows(grid);
  for (const rowCards of rows) {
    if (!rowCards.some(el => el.classList.contains('group-card--resized'))) {
      for (const el of rowCards) el.style.removeProperty('--group-card-row-floor');
      continue;
    }

    const saved = rowCards.map(el => ({
      el,
      alignSelf: el.style.alignSelf,
      floor: el.style.getPropertyValue('--group-card-row-floor'),
    }));
    for (const entry of saved) {
      entry.el.style.alignSelf = 'start';
      entry.el.style.removeProperty('--group-card-row-floor');
    }

    const heights = rowCards.map(el => Math.ceil(el.getBoundingClientRect().height));

    for (const entry of saved) {
      entry.el.style.alignSelf = entry.alignSelf;
    }

    for (let i = 0; i < rowCards.length; i++) {
      const card = rowCards[i];
      if (!card.classList.contains('group-card--resized')) {
        card.style.removeProperty('--group-card-row-floor');
        continue;
      }
      let biggestOther = 0;
      for (let j = 0; j < rowCards.length; j++) {
        if (i !== j && heights[j] > biggestOther) {
          biggestOther = heights[j];
        }
      }
      if (biggestOther > 0) {
        card.style.setProperty('--group-card-row-floor', `${biggestOther}px`);
      } else {
        card.style.removeProperty('--group-card-row-floor');
      }
    }
  }
}

/**
 * Measure the card's own un-resized natural height and the height of the
 * tallest other `.group-card` in the same CSS Grid row (ignoring row stretching).
 * @param {HTMLElement} card
 * @returns {{ ownNaturalHeight: number, biggestOtherInRow: number, hasRowPeers: boolean }}
 */
function measureRowHeightBounds(card) {
  const grid = card.parentElement;
  if (!grid) {
    return {
      ownNaturalHeight: Math.ceil(card.getBoundingClientRect().height),
      biggestOtherInRow: 0,
      hasRowPeers: false,
    };
  }

  const cardRect = card.getBoundingClientRect();
  const rowPeers = [];
  for (const el of grid.children) {
    if (el === card || !el.classList.contains('group-card')) continue;
    const rect = el.getBoundingClientRect();
    if (Math.abs(rect.top - cardRect.top) <= 4) {
      rowPeers.push(el);
    }
  }

  const savedAlign = [card, ...rowPeers].map(el => ({
    el,
    alignSelf: el.style.alignSelf,
    floor: el.style.getPropertyValue('--group-card-row-floor'),
  }));
  const prevCustomVar = card.style.getPropertyValue('--group-card-custom-max-height');
  const hadResizedClass = card.classList.contains('group-card--resized');

  for (const entry of savedAlign) {
    entry.el.style.alignSelf = 'start';
    entry.el.style.removeProperty('--group-card-row-floor');
  }
  card.style.removeProperty('--group-card-custom-max-height');
  card.classList.remove('group-card--resized');

  const ownNaturalHeight = Math.ceil(card.getBoundingClientRect().height);
  let biggestOtherInRow = 0;
  for (const peer of rowPeers) {
    const peerHeight = Math.ceil(peer.getBoundingClientRect().height);
    if (peerHeight > biggestOtherInRow) {
      biggestOtherInRow = peerHeight;
    }
  }

  if (prevCustomVar) {
    card.style.setProperty('--group-card-custom-max-height', prevCustomVar);
  }
  if (hadResizedClass) {
    card.classList.add('group-card--resized');
  }
  for (const entry of savedAlign) {
    entry.el.style.alignSelf = entry.alignSelf;
    if (entry.floor) {
      entry.el.style.setProperty('--group-card-row-floor', entry.floor);
    }
  }

  return {
    ownNaturalHeight,
    biggestOtherInRow,
    hasRowPeers: rowPeers.length > 0,
  };
}

/**
 * Apply any persisted custom max-height from localStorage onto a card element
 * and synchronize the visibility of its header reset button.
 * @param {HTMLElement} card
 * @param {string} key
 * @param {HTMLButtonElement|null} [resetBtn=null]
 */
export function applyGroupHeight(card, key, resetBtn = null) {
  const saved = getSavedGroupMaxHeight(key);
  if (saved !== null) {
    setCardCustomHeight(card, saved, resetBtn);
  } else {
    clearCardCustomHeight(card, resetBtn);
  }
}

/**
 * Attach the bottom vertical resize handle and wire header reset button behavior.
 * @param {{ card: HTMLElement, getKey: () => string, resetBtn?: HTMLButtonElement|null }} opts
 */
export function attachGroupResizeHandle({ card, getKey, resetBtn = null }) {
  const handle = document.createElement('div');
  handle.className = 'group-card__resize-handle';
  handle.title = 'Drag to resize height (double-click to match row or reset)';
  handle.setAttribute('aria-hidden', 'true');
  card.appendChild(handle);

  if (resetBtn) {
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      resetCardHeight(card, getKey(), resetBtn);
      syncGridRowFloors(card.parentElement);
    });
  }

  handle.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    const key = getKey();
    if (card.classList.contains('group-card--resized')) {
      resetCardHeight(card, key, resetBtn);
      syncGridRowFloors(card.parentElement);
      return;
    }

    const screenMax = getScreenMaxGroupHeightPx();
    const { ownNaturalHeight, biggestOtherInRow, hasRowPeers } = measureRowHeightBounds(card);
    if (!hasRowPeers) return;

    const targetHeight = Math.max(MIN_GROUP_CARD_HEIGHT, Math.min(screenMax, biggestOtherInRow));
    if (targetHeight < ownNaturalHeight - 1) {
      saveGroupMaxHeight(key, targetHeight);
      setCardCustomHeight(card, targetHeight, resetBtn);
      syncGridRowFloors(card.parentElement);
    }
  });

  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const startY = e.clientY;
    const startHeight = Math.round(card.getBoundingClientRect().height);
    const screenMax = getScreenMaxGroupHeightPx();
    const { ownNaturalHeight, biggestOtherInRow, hasRowPeers } = measureRowHeightBounds(card);
    const dragMinHeight = hasRowPeers
      ? Math.max(MIN_GROUP_CARD_HEIGHT, Math.min(screenMax, biggestOtherInRow))
      : MIN_GROUP_CARD_HEIGHT;
    const dragMaxHeight = Math.max(
      dragMinHeight,
      Math.min(screenMax, Math.max(ownNaturalHeight, biggestOtherInRow))
    );
    let currentHeight = Math.max(dragMinHeight, Math.min(dragMaxHeight, startHeight));
    let didMove = false;

    const hadDraggableAttr = card.hasAttribute('draggable');
    const prevDraggableVal = card.getAttribute('draggable');
    if (hadDraggableAttr) {
      card.setAttribute('draggable', 'false');
    }

    card.classList.add('group-card--resizing');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onPointerMove = (moveEv) => {
      const deltaY = moveEv.clientY - startY;
      if (Math.abs(deltaY) > 1) didMove = true;
      currentHeight = Math.max(
        dragMinHeight,
        Math.min(dragMaxHeight, Math.round(startHeight + deltaY))
      );
      setCardCustomHeight(card, currentHeight, resetBtn);
    };

    const cleanup = () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerCancel);
      card.classList.remove('group-card--resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (hadDraggableAttr && prevDraggableVal !== null) {
        card.setAttribute('draggable', prevDraggableVal);
      }
    };

    const onPointerUp = () => {
      cleanup();
      if (!didMove) return;

      const key = getKey();
      const renderedHeight = Math.round(card.getBoundingClientRect().height);
      const isAtMaxLimit = currentHeight >= dragMaxHeight - RESET_SNAP_THRESHOLD;
      const isUnconstrained = renderedHeight < currentHeight - 2;

      if (isAtMaxLimit || isUnconstrained) {
        resetCardHeight(card, key, resetBtn);
      } else {
        saveGroupMaxHeight(key, currentHeight);
        setCardCustomHeight(card, currentHeight, resetBtn);
      }
      syncGridRowFloors(card.parentElement);
    };

    const onPointerCancel = () => {
      cleanup();
      applyGroupHeight(card, getKey(), resetBtn);
      syncGridRowFloors(card.parentElement);
    };

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
  });
}

let _rowFloorRaf = 0;
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('resize', () => {
    if (_rowFloorRaf) return;
    _rowFloorRaf = requestAnimationFrame(() => {
      _rowFloorRaf = 0;
      syncGridRowFloors(document.getElementById('pageGrid'));
    });
  });
}
