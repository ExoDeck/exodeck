// note.js — note renderer and editor
import { state, refreshPages, withLocation, apiFetch, isHelpWorkspace } from './app.js';
import { renderMarkdownToElement, loadMarkdownDependencies } from './markdown-utils.js';
import { prepareMermaidForPrint } from './mermaid-viewer.js';
import { showImageManagerModal } from './media-modal.js';
import { showErrorBubble, parseApiError } from './ui-utils.js';
import { toggleOutlineSidebar, getIsSidebarOutlineActive, refreshOutlineSidebar } from './outline-nav.js';
import { createPageActionMenu, isPinned, setHeaderBreadcrumbs, updateSidebarVisibility, closeFloatingNavigator } from './sidebar.js';
import { openConfirmModal, openModal } from './modal.js';
import { renderPage } from './content.js';
import { isEditModeActive, exitEditMode } from './reorganize.js';

let activeEditorCleanup = null;

/**
 * Clean up any active inline note editor listeners and DOM state.
 */
export function cleanupActiveNoteEditor() {
  activeEditorCleanup?.();
}

/**
 * Decode a Base64-encoded UTF-8 string.
 * @param {string} base64
 * @returns {string}
 */
export function decodeNote(base64) {
  if (!base64) return '';
  return new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.codePointAt(0)));
}

/**
 * Encode a string to a Base64-encoded UTF-8 string.
 * @param {string} text
 * @returns {string}
 */
export function encodeNote(text) {
  const bytes = new TextEncoder().encode(text ?? '');
  return btoa(Array.from(bytes, b => String.fromCodePoint(b)).join(''));
}

/**
 * Whether the active view is displaying a Note Page or a full-screen Grid Note.
 * @returns {boolean}
 */
export function isActiveNoteView() {
  return state.currentPage?.page_type === 'note' || Boolean(state.activeGridNote);
}

/**
 * Return the raw Markdown of the currently displayed Note Page or Grid Note.
 * @returns {string}
 */
export function getActiveNoteMarkdown() {
  if (state.activeGridNote) {
    return state.activeGridNote.rawMarkdown ?? '';
  }
  return state.currentPage?.rawMarkdown ?? '';
}

/**
 * Persist updated raw Markdown for the active Note Page or Grid Note.
 * @param {string} newRaw
 */
export async function saveActiveNoteMarkdown(newRaw) {
  const gn = state.activeGridNote;
  if (gn) {
    const payload = gn.isEncrypted
      ? { title: gn.title, enc_text: newRaw }
      : { title: gn.title, text: encodeNote(newRaw) };
    await apiFetch(
      withLocation(`/pages/${encodeURIComponent(gn.slug)}/groups/${gn.groupIndex}/items/${gn.itemIndex}`, gn.location),
      { method: 'PUT', body: JSON.stringify(payload) }
    );
    gn.rawMarkdown = newRaw;
    if (gn.item) {
      if (gn.isEncrypted) gn.item.enc_text = newRaw;
      else gn.item.text = payload.text;
    }
    const target = state.currentPage?.groups?.[gn.groupIndex]?.items?.[gn.itemIndex];
    if (target) {
      if (gn.isEncrypted) target.enc_text = newRaw;
      else target.text = payload.text;
    }
    return;
  }

  state.currentPage.rawMarkdown = newRaw;
  await callSaveApi(newRaw, state.currentSlug, false, state.currentLocation);
}

async function updateMediaCount(slug, location, btn) {
  if (!slug) return;
  try {
    const items = await apiFetch(withLocation(`/pages/${slug}/media`, location));
    let badge = btn.querySelector('.media-count-badge');
    if (items && items.length > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'media-count-badge';
        btn.appendChild(badge);
      }
      badge.textContent = items.length;
    } else {
      badge?.remove();
    }
  } catch {
    // ignore fetch errors (e.g. page not saved yet)
  }
}

function createUploadButton(slug, location, insertCallback = null) {
  const uploadBtn = document.createElement('button');
  uploadBtn.type = 'button';
  uploadBtn.className = 'page-header__icon-btn';
  uploadBtn.style.position = 'relative';
  uploadBtn.title = 'Manage Images';
  uploadBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`;
  uploadBtn.addEventListener('click', () => {
    showImageManagerModal(slug, location, insertCallback ?? undefined);
  });

  const onMediaChange = () => {
    if (!document.body.contains(uploadBtn)) {
      document.removeEventListener('exodeck:media-changed', onMediaChange);
      return;
    }
    void updateMediaCount(slug, location, uploadBtn);
  };
  document.addEventListener('exodeck:media-changed', onMediaChange);
  void updateMediaCount(slug, location, uploadBtn);

  return uploadBtn;
}

function createOutlineButton() {
  const outlineBtn = document.createElement('button');
  outlineBtn.type = 'button';
  outlineBtn.className = 'page-header__icon-btn';
  outlineBtn.title = 'Outline (o)';
  outlineBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>`;
  outlineBtn.addEventListener('click', toggleOutlineSidebar);
  outlineBtn.classList.toggle('active', isPinned());
  return outlineBtn;
}

function buildGridNoteInfoContent(gridNote) {
  const formatDate = (iso) => (iso ? new Date(iso).toLocaleString() : '');
  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.fontSize = 'var(--font-size-sm)';
  table.style.color = 'var(--color-text)';

  const rows = [
    ['Note Name', gridNote.title || ''],
    ['Type', gridNote.isEncrypted ? 'Encrypted Note' : 'Note'],
    ['Group', gridNote.groupTitle || ''],
    ['Grid Page', gridNote.pageName || ''],
    ['Creation Date', formatDate(gridNote.item?.created_at)],
    ['Last Modified', formatDate(gridNote.item?.modified_at)],
  ];
  for (const [label, value] of rows) {
    const tr = document.createElement('tr');
    const tdLabel = document.createElement('td');
    tdLabel.style.padding = 'var(--space-xs) var(--space-sm) var(--space-xs) 0';
    tdLabel.style.color = 'var(--color-text-muted)';
    tdLabel.style.whiteSpace = 'nowrap';
    tdLabel.innerHTML = `<strong>${label}:</strong>`;

    const tdValue = document.createElement('td');
    tdValue.style.padding = 'var(--space-xs) 0';
    tdValue.style.wordBreak = 'break-all';
    tdValue.textContent = value;

    tr.appendChild(tdLabel);
    tr.appendChild(tdValue);
    table.appendChild(tr);
  }
  return table;
}

function createGridNoteActionMenu(gridNote) {
  const menuWrapper = document.createElement('div');
  menuWrapper.className = 'page-header__page-menu';

  const menuTrigger = document.createElement('button');
  menuTrigger.type = 'button';
  menuTrigger.className = 'page-header__icon-btn';
  menuTrigger.setAttribute('aria-label', `Actions for "${gridNote.title}"`);
  menuTrigger.title = 'Note actions';
  menuTrigger.innerHTML = '<span class="material-symbols-outlined" style="font-size: 20px;">more_horiz</span>';

  const menuPanel = document.createElement('div');
  menuPanel.className = 'sidebar__page-menu-panel add-page-menu';

  const closeMenu = () => menuPanel.classList.remove('add-page-menu--open');

  const infoItem = document.createElement('button');
  infoItem.type = 'button';
  infoItem.className = 'add-page-menu__item';
  infoItem.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px; margin-right: 8px;">info</span> Info';
  infoItem.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    await openModal({
      title: 'Note Info',
      contentNode: buildGridNoteInfoContent(gridNote),
      confirmLabel: 'OK',
      hideCancel: true,
      dynamicWidth: true,
    });
  });

  const sep = document.createElement('hr');
  sep.className = 'add-page-menu__separator';
  sep.setAttribute('aria-hidden', 'true');

  const printItem = document.createElement('button');
  printItem.type = 'button';
  printItem.className = 'add-page-menu__item';
  printItem.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">print</span> Print';
  printItem.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    void printActiveNote(gridNote.slug, gridNote.location).catch(console.error);
  });

  const deleteItem = document.createElement('button');
  deleteItem.type = 'button';
  deleteItem.className = 'add-page-menu__item add-page-menu__item--danger';
  deleteItem.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">delete</span> Delete';
  deleteItem.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    const confirmed = await openModal({
      title: `Delete note “${gridNote.title}”?`,
      fields: [],
      confirmLabel: 'Delete',
      isDanger: true,
    });
    if (!confirmed) return;
    try {
      await apiFetch(
        withLocation(`/pages/${encodeURIComponent(gridNote.slug)}/groups/${gridNote.groupIndex}/items/${gridNote.itemIndex}`, gridNote.location),
        { method: 'DELETE' }
      );
      state.currentPage = await apiFetch(withLocation(`/pages/${encodeURIComponent(gridNote.slug)}`, gridNote.location));
      gridNote.itemIndex = null;
      await closeActiveGridNote({ force: true });
    } catch (err) {
      console.error('[ExoDeck] Failed to delete grid note:', err);
    }
  });

  menuPanel.appendChild(infoItem);
  menuPanel.appendChild(sep);
  menuPanel.appendChild(printItem);
  menuPanel.appendChild(deleteItem);

  menuWrapper.appendChild(menuTrigger);
  menuWrapper.appendChild(menuPanel);

  menuTrigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll('.sidebar__page-menu-panel.add-page-menu--open, .sidebar__location-menu-panel.add-page-menu--open').forEach(el => {
      if (el !== menuPanel) el.classList.remove('add-page-menu--open');
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
      if (left < 8) left = 8;

      menuPanel.style.left = `${left}px`;
      menuPanel.style.top = `${rect.bottom + 4}px`;
      menuPanel.style.bottom = '';
    }
    menuPanel.classList.toggle('add-page-menu--open');
  });

  return menuWrapper;
}

/**
 * Open a Grid Note (standard or encrypted) in full-screen Note view or editor mode.
 *
 * @param {{ item: object|null, itemIndex: number|null, groupIndex: number, slug: string, location?: string|null, isEncrypted?: boolean, initialMode?: 'view'|'edit' }} opts
 */
export async function openGridNoteView({
  item,
  itemIndex,
  groupIndex,
  slug,
  location = null,
  isEncrypted = false,
  initialMode = 'view',
}) {
  const resolvedLocation = location ?? state.currentLocation ?? null;
  if (
    !state.currentPage ||
    state.currentSlug !== slug ||
    (state.currentLocation ?? '') !== (resolvedLocation ?? '')
  ) {
    state.currentPage = await apiFetch(withLocation(`/pages/${encodeURIComponent(slug)}`, resolvedLocation));
    state.currentSlug = slug;
    state.currentLocation = resolvedLocation;
  }

  if (isEditModeActive()) {
    exitEditMode();
  }
  cleanupActiveNoteEditor();

  const page = state.currentPage;
  const pageName = page?.['page-name'] ?? page?.page_name ?? slug;
  const groupTitle = page?.groups?.[groupIndex]?.title ?? `Group ${groupIndex + 1}`;
  const isNew = item === null;
  const rawMarkdown = isNew
    ? ''
    : (isEncrypted ? (item.enc_text ?? '') : decodeNote(item.text ?? ''));

  state.activeGridNote = {
    item,
    itemIndex,
    groupIndex,
    slug,
    location: resolvedLocation,
    isEncrypted,
    isNew,
    pageName,
    groupTitle,
    title: isNew ? '' : (item.title ?? ''),
    rawMarkdown,
    isEditing: false,
    requestClose: null,
  };

  setHeaderBreadcrumbs({ pageName, groupTitle, isEncrypted });
  updateSidebarVisibility('note');
  closeFloatingNavigator();

  const contentEl = document.getElementById('content');
  if (contentEl) {
    contentEl.scrollTop = 0;
  }

  if (initialMode === 'edit' || isNew) {
    openInlineNoteEditor({
      rawMarkdown,
      slug,
      isNew,
      location: resolvedLocation,
      isGridNote: true,
      gridNote: state.activeGridNote,
      editFromView: false,
    });
  } else {
    renderNoteContent(page);
  }
}

/**
 * Exit full-screen Grid Note view/editor and return to the parent Grid Page.
 * @param {{ force?: boolean }} [opts]
 */
export async function closeActiveGridNote({ force = false } = {}) {
  const gn = state.activeGridNote;
  if (!gn) return;

  if (!force && gn.isEditing && typeof gn.requestClose === 'function') {
    await gn.requestClose('grid');
    return;
  }

  cleanupActiveNoteEditor();
  const { groupIndex, itemIndex, slug, location } = gn;
  state.activeGridNote = null;
  setHeaderBreadcrumbs(null);

  if (
    !state.currentPage ||
    state.currentSlug !== slug ||
    (state.currentLocation ?? '') !== (location ?? '')
  ) {
    state.currentPage = await apiFetch(withLocation(`/pages/${encodeURIComponent(slug)}`, location));
    state.currentSlug = slug;
    state.currentLocation = location;
  }

  renderPage(state.currentPage);

  const grid = document.getElementById('pageGrid');
  const card = grid?.querySelector(`.group-card[data-group-index="${groupIndex}"]`);
  if (card) {
    card.classList.add('group-card--focused');
    if (itemIndex != null) {
      const itemEl = card.querySelector(`.item[data-item-index="${itemIndex}"]`);
      itemEl?.classList.add('item--focused');
    }
  }
}

/**
 * Slugify a string — mirrors backend + sidebar logic.
 * @param {string} name
 * @returns {string}
 */
function slugify(name) {
  let s = name.toLowerCase();
  s = s.replaceAll('ä', 'ae');
  s = s.replaceAll('ö', 'oe');
  s = s.replaceAll('ü', 'ue');
  s = s.replaceAll('ß', 'ss');
  
  const slug = s.replace(/[^a-z0-9]+/g, '-');
  let start = 0;
  while (start < slug.length && slug[start] === '-') start++;
  let end = slug.length;
  while (end > start && slug[end - 1] === '-') end--;
  return slug.slice(start, end);
}

/**
 * Splits rawMarkdown into a title (from a leading `# ` heading) and body.
 * @param {string} rawMarkdown
 * @returns {{ title: string|null, body: string }}
 */
function extractTitleFromMarkdown(rawMarkdown) {
  const normalized = (rawMarkdown ?? '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.startsWith('# ')) {
    const title = lines[0].slice(2).trim();
    const rest = lines.slice(1);
    if (rest[0] === '') rest.shift();
    return { title, body: rest.join('\n') };
  }
  return { title: null, body: normalized };
}

/**
 * Render a note (or full-screen Grid Note) into the content area.
 * @param {{ 'page-name': string, page_type?: string, rawMarkdown?: string }} page
 */
export function renderNoteContent(page) {
  cleanupActiveNoteEditor();
  const gridNote = state.activeGridNote;

  // 1. Page title & body
  const titleEl = document.getElementById('pageTitle');
  let bodyMarkdown;
  if (gridNote) {
    gridNote.isEditing = false;
    gridNote.requestClose = null;
    setHeaderBreadcrumbs({
      pageName: gridNote.pageName,
      groupTitle: gridNote.groupTitle,
      isEncrypted: gridNote.isEncrypted,
    });
    if (titleEl) titleEl.textContent = gridNote.title ?? '';
    bodyMarkdown = gridNote.rawMarkdown ?? '';
  } else {
    setHeaderBreadcrumbs(null);
    const { title: extractedTitle, body } = extractTitleFromMarkdown(page.rawMarkdown ?? '');
    if (titleEl) titleEl.textContent = extractedTitle ?? (page['page-name'] ?? page.page_name ?? '');
    bodyMarkdown = body;
  }

  // Mark content area for tighter markdown layout
  const contentEl = document.getElementById('content');
  contentEl?.classList.add('content--markdown');
  contentEl?.classList.remove('content--editing');

  // 2. Render markdown into grid
  const grid = document.getElementById('pageGrid');
  if (!grid) return;
  grid.innerHTML = '';

  const contentDiv = document.createElement('div');
  contentDiv.className = 'md-page__content';
  grid.appendChild(contentDiv);
  void renderMarkdownToElement(bodyMarkdown, contentDiv).then(() => {
    if (getIsSidebarOutlineActive()) {
      refreshOutlineSidebar();
    }
  }).catch(console.error);

  // 3. Action buttons in header
  const actionsEl = document.getElementById('contentActions');
  if (!actionsEl) return;
  actionsEl.innerHTML = '';

  if (gridNote) {
    const outlineBtn = createOutlineButton();
    if (!isHelpWorkspace(gridNote.location)) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.id = 'editMdPageBtn';
      editBtn.className = 'page-header__icon-btn';
      editBtn.title = 'Edit (e)';
      editBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 20px;">edit</span>';
      editBtn.addEventListener('click', () => {
        openInlineNoteEditor({
          rawMarkdown: gridNote.rawMarkdown,
          slug: gridNote.slug,
          location: gridNote.location,
          isNew: false,
          isGridNote: true,
          gridNote,
          editFromView: true,
        });
      });

      const uploadBtn = createUploadButton(gridNote.slug, gridNote.location);
      const menuBtn = createGridNoteActionMenu(gridNote);
      actionsEl.appendChild(editBtn);
      actionsEl.appendChild(outlineBtn);
      actionsEl.appendChild(uploadBtn);
      actionsEl.appendChild(menuBtn);
    } else {
      actionsEl.appendChild(outlineBtn);
    }

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'page-header__icon-btn';
    backBtn.title = 'Back to Grid (Esc)';
    backBtn.setAttribute('aria-label', 'Back to Grid');
    backBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 20px;">close</span>';
    backBtn.addEventListener('click', () => {
      void closeActiveGridNote();
    });
    actionsEl.appendChild(backBtn);
    return;
  }

  const uploadBtn = createUploadButton(state.currentSlug, state.currentLocation);

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.id = 'editMdPageBtn';
  editBtn.className = 'page-header__icon-btn';
  editBtn.title = 'Edit (e)';
  editBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 20px;">edit</span>';
  editBtn.addEventListener('click', () => {
    openInlineNoteEditor({
      rawMarkdown: page.rawMarkdown,
      slug: state.currentSlug,
      location: state.currentLocation,
      isNew: false,
      onSave: applyNotePageEdit,
      onCancel: () => renderNoteContent(page),
    });
  });

  const outlineBtn = createOutlineButton();

  if (!isHelpWorkspace(state.currentLocation)) {
    const menuBtn = createPageActionMenu(state.currentSlug, page['page-name'], 'note', state.currentLocation, true);
    actionsEl.appendChild(editBtn);
    actionsEl.appendChild(outlineBtn);
    actionsEl.appendChild(uploadBtn);
    actionsEl.appendChild(menuBtn);
  }
}

export async function callSaveApi(content, slug, isNew, location = null) {
  const path = isNew
    ? withLocation('/notes', location)
    : withLocation(`/notes/${encodeURIComponent(slug)}`, location);
  const result = await fetch(`/api/v1${path}`, {
    method: isNew ? 'POST' : 'PUT',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: content,
  });
  if (!result.ok) {
    const msg = await result.text().catch(() => result.statusText);
    throw new Error(parseApiError(msg, `API ${result.status}: ${result.statusText}`));
  }
  return result.json();
}

function applyNotePageEdit(newSlug, pageName) {
  void (async () => {
    const saveLocation = state.currentLocation;
    await refreshPages();
    state.currentLocation = saveLocation;

    state.currentSlug = newSlug;
    // Notify sidebar to re-render (avoids circular import)
    document.dispatchEvent(
      new CustomEvent('exodeck:pages-changed', { detail: { newSlug } })
    );
    // Re-render content area with latest markdown
    const updatedPage = {
      'page-name': pageName,
      page_type: 'note',
      rawMarkdown: state.currentPage?.rawMarkdown ?? '',
    };
    renderNoteContent(updatedPage);
  })();
}

/**
 * Insert markdown syntax around the selection in a textarea.
 */
function insertMarkdown(textarea, prefix, suffix, defaultText = '') {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  const selected = text.substring(start, end) || defaultText;
  const replacement = prefix + selected + suffix;

  textarea.focus();
  if (typeof textarea.setRangeText === 'function') {
    textarea.setRangeText(replacement, start, end, 'end');
    textarea.selectionStart = start + prefix.length;
    textarea.selectionEnd = start + prefix.length + selected.length;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }

  // Fallback if setRangeText is unavailable
  const before = text.substring(0, start);
  const after = text.substring(end);
  textarea.value = before + replacement + after;
  textarea.selectionStart = start + prefix.length;
  textarea.selectionEnd = start + prefix.length + selected.length;
}

function toggleListPrefix(textarea, listType) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  
  const before = text.substring(0, start);
  const lineStart = before.lastIndexOf('\n') + 1;
  const selectedText = text.substring(lineStart, end);
  const lines = selectedText.split('\n');
  
  let allMatch = true;
  for (const line of lines) {
    if (listType === 'ul' && !/^[ \t]*[-*] (?!\[[ xX]\])/.test(line)) allMatch = false;
    if (listType === 'ol' && !/^[ \t]*\d+\. /.test(line)) allMatch = false;
    if (listType === 'check' && !/^[ \t]*[-*] \[[ xX]\] /.test(line)) allMatch = false;
  }

  const newLines = lines.map((line, i) => {
    const indentMatch = line.match(/^[ \t]*/);
    const indent = indentMatch ? indentMatch[0] : '';
    const cleanLine = line.replace(/^[ \t]*([-*] (?:\[[ xX]\] )?|\d+\. )/, '');
    if (allMatch) {
      return indent + cleanLine.trimStart();
    } else {
      let p = '- ';
      if (listType === 'ol') p = `${i + 1}. `;
      if (listType === 'check') p = '- [ ] ';
      return indent + p + cleanLine.trimStart();
    }
  });

  const replacement = newLines.join('\n');
  textarea.focus();
  textarea.setSelectionRange(lineStart, end);
  
  textarea.setRangeText(replacement, lineStart, end);
  
  if (start === end) {
    const newPos = Math.max(0, start + (replacement.length - selectedText.length));
    textarea.selectionStart = textarea.selectionEnd = newPos;
  } else {
    textarea.selectionStart = lineStart;
    textarea.selectionEnd = lineStart + replacement.length;
  }
}

/**
 * Creates the markdown editor toolbar.
 */
function createToolbar(textarea) {
  const toolbar = document.createElement('div');
  toolbar.className = 'md-toolbar';

  const createBtn = (title, svgPath, action) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'md-toolbar-btn';
    btn.title = title;
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svgPath}</svg>`;
    btn.addEventListener('click', () => {
      action();
      textarea.dispatchEvent(new Event('input')); // Trigger preview update
    });
    return btn;
  };

  const createSep = () => {
    const sep = document.createElement('div');
    sep.className = 'md-toolbar-separator';
    return sep;
  };

  toolbar.appendChild(createBtn('Bold', '<path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"></path><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"></path>', () => insertMarkdown(textarea, '**', '**', 'bold')));
  toolbar.appendChild(createBtn('Italic', '<line x1="19" y1="4" x2="10" y2="4"></line><line x1="14" y1="20" x2="5" y2="20"></line><line x1="15" y1="4" x2="9" y2="20"></line>', () => insertMarkdown(textarea, '*', '*', 'italic')));
  toolbar.appendChild(createBtn('Underline', '<path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3"></path><line x1="4" y1="21" x2="20" y2="21"></line>', () => insertMarkdown(textarea, '<u>', '</u>', 'underline')));

  toolbar.appendChild(createSep());

  toolbar.appendChild(createBtn('H2', '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"/>', () => insertMarkdown(textarea, '## ', '', 'Heading 2')));
  toolbar.appendChild(createBtn('H3', '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2"/><path d="M17 17.5c2 1.5 4 .5 4-1.5a2 2 0 0 0-2-2"/>', () => insertMarkdown(textarea, '### ', '', 'Heading 3')));
  toolbar.appendChild(createBtn('H4', '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17 10v4h4"/><path d="M21 10v8"/>', () => insertMarkdown(textarea, '#### ', '', 'Heading 4')));

  toolbar.appendChild(createSep());
  
  toolbar.appendChild(createBtn('Bullet List', '<line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line>', () => toggleListPrefix(textarea, 'ul')));
  toolbar.appendChild(createBtn('Numbered List', '<line x1="10" y1="6" x2="21" y2="6"></line><line x1="10" y1="12" x2="21" y2="12"></line><line x1="10" y1="18" x2="21" y2="18"></line><path d="M4 6h1v4"></path><path d="M4 10h2"></path><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"></path>', () => toggleListPrefix(textarea, 'ol')));
  toolbar.appendChild(createBtn('Task List', '<polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>', () => toggleListPrefix(textarea, 'check')));

  toolbar.appendChild(createSep());

  toolbar.appendChild(createBtn('Single Line Code', '<polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline>', () => insertMarkdown(textarea, '`', '`', 'code')));
  toolbar.appendChild(createBtn('Codeblock', '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><polyline points="10 13 8 15 10 17"></polyline><polyline points="14 13 16 15 14 17"></polyline>', () => insertMarkdown(textarea, '\n```\n', '\n```\n', 'code block')));

  toolbar.appendChild(createSep());

  toolbar.appendChild(createBtn('Link', '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>', () => insertMarkdown(textarea, '[', '](url)', 'link')));

  toolbar.appendChild(createSep());

  // Table Picker
  const tableContainer = document.createElement('div');
  tableContainer.className = 'md-table-picker-container';
  
  const picker = document.createElement('div');
  picker.className = 'md-table-picker';
  
  const tableBtn = createBtn('Table', '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line><line x1="9" y1="3" x2="9" y2="21"></line><line x1="15" y1="3" x2="15" y2="21"></line>', () => {
    picker.classList.toggle('active');
  });
  tableContainer.appendChild(tableBtn);
  
  const label = document.createElement('div');
  label.className = 'md-table-picker-label';
  label.textContent = '0x0';
  picker.appendChild(label);

  const grid = document.createElement('div');
  grid.className = 'md-table-picker-grid';
  
  const cells = [];
  const maxRows = 10;
  const maxCols = 10;

  for (let r = 0; r < maxRows; r++) {
    for (let c = 0; c < maxCols; c++) {
      const cell = document.createElement('div');
      cell.className = 'md-table-picker-cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      grid.appendChild(cell);
      cells.push(cell);

      cell.addEventListener('mouseover', () => {
        cells.forEach(el => {
          if (el.dataset.r <= r && el.dataset.c <= c) {
            el.classList.add('selected');
          } else {
            el.classList.remove('selected');
          }
        });
        label.textContent = `${c + 1}x${r + 1}`;
      });

      cell.addEventListener('click', () => {
        const rows = r + 1;
        const cols = c + 1;
        let tableMd = '\n';
        for (let i = 0; i < cols; i++) tableMd += '| ';
        tableMd += '|\n';
        for (let i = 0; i < cols; i++) tableMd += '|---';
        tableMd += '|\n';
        for (let i = 0; i < rows; i++) {
          for (let j = 0; j < cols; j++) tableMd += '| ';
          tableMd += '|\n';
        }
        insertMarkdown(textarea, tableMd, '');
        textarea.dispatchEvent(new Event('input'));
        picker.classList.remove('active');
        cells.forEach(el => el.classList.remove('selected'));
        label.textContent = '0x0';
      });
    }
  }
  
  picker.appendChild(grid);
  tableContainer.appendChild(picker);
  toolbar.appendChild(tableContainer);

  const onToolbarDocClick = (e) => {
    if (!toolbar.isConnected) {
      document.removeEventListener('click', onToolbarDocClick);
      return;
    }
    if (!tableContainer.contains(e.target)) {
      picker.classList.remove('active');
      cells.forEach(el => el.classList.remove('selected'));
      label.textContent = '0x0';
    }
  };
  document.addEventListener('click', onToolbarDocClick);

  return toolbar;
}

function handleEditorEnter(e, textArea, updatePreviewFn) {
  const start = textArea.selectionStart;
  const val = textArea.value;
  const beforeCursor = val.substring(0, start);
  const lastLineMatch = /(?:^|\n)([ \t]*)([-*] (?:\[[ xX]\] )?|\d+\. (?:\[[ xX]\] )?)(.*)$/.exec(beforeCursor);
  if (lastLineMatch) {
    const indent = lastLineMatch[1];
    const marker = lastLineMatch[2];
    const text = lastLineMatch[3];

    if (text.trim() === '') {
      // Empty list item: remove it and insert a plain newline
      e.preventDefault();
      const lineStart = start - indent.length - marker.length;
      textArea.focus();
      textArea.setRangeText('\n', lineStart, start, 'end');
    } else {
      // Continue list
      e.preventDefault();
      let nextMarker = marker;
      nextMarker = nextMarker.replace(/\[[xX]\]/, '[ ]');
      if (/^\d+\. /.test(marker)) {
        const num = Number.parseInt(marker, 10);
        nextMarker = nextMarker.replace(/^\d+/, num + 1);
      }
      const insertStr = '\n' + indent + nextMarker;
      textArea.focus();
      textArea.setRangeText(insertStr, start, start, 'end');
    }
    if (typeof updatePreviewFn === 'function') updatePreviewFn();
  }
}

function handleEditorTab(e, textArea, updatePreviewFn) {
  e.preventDefault();
  // Need to stop propagation so `handleNewPageTabOrder` doesn't steal focus
  e.stopImmediatePropagation();
  
  const start = textArea.selectionStart;
  const end = textArea.selectionEnd;
  const val = textArea.value;

  if (start === end) {
    // No selection: insert 2 spaces
    const insertStr = '  ';
    textArea.value = val.substring(0, start) + insertStr + val.substring(end);
    textArea.selectionStart = textArea.selectionEnd = start + insertStr.length;
  } else {
    // Selection: indent or unindent lines
    const before = val.substring(0, start);
    let lineStart = before.lastIndexOf('\n') + 1;
    
    const selectedLines = val.substring(lineStart, end);
    let newLines;
    if (e.shiftKey) {
      // Unindent
      newLines = selectedLines.replace(/^( {1,2}|\t)/gm, '');
    } else {
      // Indent
      newLines = selectedLines.replace(/^/gm, '  ');
    }
    
    textArea.value = val.substring(0, lineStart) + newLines + val.substring(end);
    textArea.selectionStart = start + (e.shiftKey ? Math.max(-2, newLines.length - selectedLines.length) : 2);
    textArea.selectionEnd = lineStart + newLines.length;
  }
  if (typeof updatePreviewFn === 'function') updatePreviewFn();
}

function setupEditorActions(actionsEl, slug, location, isNew, extractedTitle, textarea, updatePreviewRef, gridNote = null) {
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'page-header__icon-btn';
  saveBtn.title = 'Save (Ctrl+S)';
  saveBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 20px; color: #4caf50;">check</span>';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'page-header__icon-btn';
  cancelBtn.title = 'Cancel (Esc)';
  cancelBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 20px; color: #f44336;">close</span>';

  if (!actionsEl) return { saveBtn, cancelBtn };

  actionsEl.appendChild(saveBtn);
  actionsEl.appendChild(cancelBtn);

  if (slug) {
    const uploadBtn = createUploadButton(slug, location, (md) => {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = textarea.value.substring(0, start) + md + textarea.value.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + md.length;
      updatePreviewRef.current();
      textarea.focus();
    });
    const outlineBtn = createOutlineButton();
    actionsEl.appendChild(outlineBtn);
    actionsEl.appendChild(uploadBtn);
  }

  if (!isNew && !isHelpWorkspace(location)) {
    const menuBtn = gridNote
      ? createGridNoteActionMenu(gridNote)
      : createPageActionMenu(slug, extractedTitle, 'note', location, true);
    actionsEl.appendChild(menuBtn);
  }

  return { saveBtn, cancelBtn };
}

function attachMediaHandlers(textarea, saveBtn, slug, location, updatePreview) {
  async function uploadSingleMediaFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const response = await fetch(withLocation(`/api/v1/pages/${slug}/media`, location), {
        method: 'POST',
        body: formData
      });
      if (!response.ok) return null;
      const res = await response.json();
      const extIdx = res.filename.lastIndexOf('.');
      const nameWithoutExt = extIdx > 0 ? res.filename.substring(0, extIdx) : res.filename;
      return `![${nameWithoutExt}](_IMG_/${res.filename})\n`;
    } catch (e) {
      console.error('Media upload failed', e);
      return null;
    }
  }

  async function handleMediaUploads(files) {
    if (!slug || !files || files.length === 0) return;
    const imageFiles = Array.from(files).filter(file => file.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    saveBtn.disabled = true;
    const uploadedMarkdown = await Promise.all(imageFiles.map(uploadSingleMediaFile));
    const insertedMd = uploadedMarkdown.filter(Boolean).join('');
    if (insertedMd) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = textarea.value.substring(0, start) + insertedMd + textarea.value.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + insertedMd.length;
      document.dispatchEvent(new CustomEvent('exodeck:media-changed'));
    }
    updatePreview();
    saveBtn.disabled = false;
  }

  textarea.addEventListener('paste', e => {
    const items = e.clipboardData.items;
    const imageFiles = [];
    for (const item of items) {
      if (item.type.includes('image/')) {
        const file = item.getAsFile();
        let ext = file.name?.substring(file.name.lastIndexOf('.')) ?? '';
        if (!ext || ext.includes('/')) ext = '.png'; // fallback extension
        
        // Use ISO timestamp for pasted image names
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const renamedFile = new File([file], `${timestamp}${ext}`, { type: file.type });
        imageFiles.push(renamedFile);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      void handleMediaUploads(imageFiles);
    }
  });

  textarea.addEventListener('drop', e => {
    // Only intercept if they drop files
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      e.preventDefault();
      void handleMediaUploads(e.dataTransfer.files);
    }
  });
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}

function highlightCodeBlock(code, lang) {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang }).value;
    } catch {
      return escapeHtml(code);
    }
  }
  return escapeHtml(code);
}

function formatCodeBlockSpan(openLine, codeLines, closeLine, lang) {
  if (codeLines.length === 0) {
    return `<span class="hljs-code">${escapeHtml(openLine)}\n${escapeHtml(closeLine)}</span>`;
  }
  const code = codeLines.join('\n');
  const highlighted = highlightCodeBlock(code, lang);
  return `<span class="hljs-code">${escapeHtml(openLine)}\n${highlighted}\n${escapeHtml(closeLine)}</span>`;
}

const ATX_HEADING_RE = /^[ \t]{0,3}#{1,6}(?:[ \t]+.*|$)/;

function tryParseFenceOpen(line) {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^`~\r\n]*)$/);
  if (!match) return null;
  const fence = match[1];
  const info = match[2].trim();
  const langMatch = info.match(/^([a-zA-Z0-9_-]+)/);
  return {
    fenceChar: fence[0],
    fenceLen: fence.length,
    lang: langMatch ? langMatch[1] : '',
  };
}

function isFenceClose(line, fenceChar, fenceLen) {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
  if (!match) return false;
  const fence = match[1];
  return fence[0] === fenceChar && fence.length >= fenceLen;
}

function highlightMarkdownLine(line) {
  if (line.length === 0) return '';
  if (ATX_HEADING_RE.test(line)) {
    return `<span class="hljs-section">${escapeHtml(line)}</span>`;
  }
  return hljs.highlight(line, { language: 'markdown' }).value;
}

function processLineInEditor(line, state) {
  if (!state.inCodeBlock) {
    const fence = tryParseFenceOpen(line);
    if (fence !== null) {
      state.inCodeBlock = true;
      state.codeBlockOpenLine = line;
      state.codeBlockLang = fence.lang;
      state.codeBlockFenceChar = fence.fenceChar;
      state.codeBlockFenceLen = fence.fenceLen;
      state.codeBlockLines = [];
      return;
    }
    state.segments.push(highlightMarkdownLine(line));
    return;
  }

  if (isFenceClose(line, state.codeBlockFenceChar, state.codeBlockFenceLen)) {
    state.inCodeBlock = false;
    state.segments.push(formatCodeBlockSpan(state.codeBlockOpenLine, state.codeBlockLines, line, state.codeBlockLang));
    return;
  }
  state.codeBlockLines.push(line);
}

function updateEditorSyntaxHighlighting(text) {
  if (typeof hljs === 'undefined') return null;

  const lines = text.split('\n');
  const state = {
    segments: [],
    inCodeBlock: false,
    codeBlockLines: [],
    codeBlockLang: '',
    codeBlockFenceChar: '',
    codeBlockFenceLen: 0,
    codeBlockOpenLine: '',
  };

  for (const line of lines) {
    processLineInEditor(line, state);
  }

  if (state.inCodeBlock) {
    state.segments.push(highlightMarkdownLine(state.codeBlockOpenLine));
    for (const line of state.codeBlockLines) {
      state.segments.push(highlightMarkdownLine(line));
    }
  }
  return state.segments.join('\n');
}

function updateEditorHighlight(text, highlightCode) {
  if (typeof hljs === 'undefined') {
    highlightCode.textContent = text;
    return;
  }
  const html = updateEditorSyntaxHighlighting(text);
  highlightCode.innerHTML = html ?? text;
}

/**
 * Open the inline editor layout for a note (Note Page or full-screen Grid Note).
 *
 * @param {{ rawMarkdown: string, slug: string|null, isNew: boolean, location?: string|null, isGridNote?: boolean, gridNote?: object|null, editFromView?: boolean, onSave?: (slug:string, name:string) => void, onCancel?: () => void }} opts
 */
export function openInlineNoteEditor({
  rawMarkdown,
  slug,
  isNew,
  location = null,
  isGridNote = false,
  gridNote = null,
  editFromView = false,
  onSave,
  onCancel,
}) {
  cleanupActiveNoteEditor();
  const effectiveGridNote = isGridNote ? (gridNote ?? state.activeGridNote) : null;

  // 1. Prepare Content Area
  const titleEl = document.getElementById('pageTitle');
  let extractedTitle;
  let bodyMarkdown;
  if (effectiveGridNote) {
    extractedTitle = isNew ? '' : (effectiveGridNote.title ?? '');
    bodyMarkdown = isNew ? '' : (effectiveGridNote.rawMarkdown ?? '');
    effectiveGridNote.isEditing = true;
    setHeaderBreadcrumbs({
      pageName: effectiveGridNote.pageName,
      groupTitle: effectiveGridNote.groupTitle,
      isEncrypted: effectiveGridNote.isEncrypted,
    });
  } else {
    setHeaderBreadcrumbs(null);
    const parsed = isNew
      ? { title: '', body: '' }
      : extractTitleFromMarkdown(rawMarkdown);
    extractedTitle = parsed.title ?? '';
    bodyMarkdown = parsed.body;
  }

  const onTitleEnterKeyDown = (e) => {
    if (e.key === 'Enter') e.preventDefault();
  };
  const onTitleInput = () => {
    if (titleEl?.textContent?.trim()) {
      titleEl.classList.remove('content__title--error');
    }
  };

  if (titleEl) {
    titleEl.textContent = extractedTitle;
    titleEl.setAttribute('contenteditable', 'plaintext-only');
    titleEl.classList.add('content__title--editing');
    titleEl.addEventListener('keydown', onTitleEnterKeyDown);
    titleEl.addEventListener('input', onTitleInput);
  }
  const grid = document.getElementById('pageGrid');
  if (!grid) return;
  grid.innerHTML = '';

  const actionsEl = document.getElementById('contentActions');
  if (actionsEl) actionsEl.innerHTML = '';

  const contentEl = document.getElementById('content');
  if (contentEl) {
    contentEl.classList.add('content--markdown', 'content--editing');
    contentEl.scrollTop = 0;
  }

  // 2. Build Editor Layout
  const container = document.createElement('div');
  container.className = 'md-editor-container';
  container.id = 'mdEditorContainer';
  
  const col = document.createElement('div');
  col.className = 'md-editor-col';

  const editorWrapper = document.createElement('div');
  editorWrapper.className = 'md-editor-textarea-wrapper';

  const highlightPre = document.createElement('pre');
  highlightPre.className = 'md-editor-highlight';
  highlightPre.setAttribute('aria-hidden', 'true');
  const highlightCode = document.createElement('code');
  highlightCode.className = 'language-markdown hljs';
  highlightPre.appendChild(highlightCode);

  const textarea = document.createElement('textarea');
  textarea.className = 'md-editor-textarea';
  textarea.value = bodyMarkdown;
  textarea.setAttribute('aria-label', 'Markdown content');
  textarea.spellcheck = false;
  
  editorWrapper.appendChild(highlightPre);
  editorWrapper.appendChild(textarea);

  const toolbar = createToolbar(textarea);
  col.appendChild(toolbar);
  col.appendChild(editorWrapper);

  const SVG_CHEVRON_LEFT = `<svg width="6" height="10" viewBox="0 0 6 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4.5 1.5 1.5 5 4.5 8.5"></polyline></svg>`;
  const SVG_CHEVRON_RIGHT = `<svg width="6" height="10" viewBox="0 0 6 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1.5 1.5 4.5 5 1.5 8.5"></polyline></svg>`;

  const resizer = document.createElement('div');
  resizer.className = 'md-editor-resizer';
  resizer.title = 'Expand preview';

  const resizerIcon = document.createElement('button');
  resizerIcon.type = 'button';
  resizerIcon.className = 'md-editor-resizer-icon';
  resizerIcon.title = 'Expand preview';
  resizerIcon.setAttribute('aria-label', 'Expand preview');
  resizerIcon.innerHTML = SVG_CHEVRON_LEFT;
  resizer.appendChild(resizerIcon);

  const preview = document.createElement('div');
  preview.className = 'md-editor-preview md-page__content';

  container.appendChild(col);
  container.appendChild(resizer);
  container.appendChild(preview);
  grid.appendChild(container);

  // Overlay geometry & scroll sync (match textarea scrollbar width and scroll offsets)
  const syncEditorOverlay = () => {
    if (!textarea.isConnected) return;
    const scrollbarWidth = Math.max(0, textarea.offsetWidth - textarea.clientWidth);
    highlightPre.style.paddingRight = scrollbarWidth > 0 ? `${scrollbarWidth}px` : '0px';
    highlightPre.scrollTop = textarea.scrollTop;
    highlightPre.scrollLeft = textarea.scrollLeft;
  };

  // Scroll sync
  textarea.addEventListener('scroll', () => {
    syncEditorOverlay();

    if (container.classList.contains('md-editor-container--preview-active')) {
      const taMaxScroll = textarea.scrollHeight - textarea.clientHeight;
      if (taMaxScroll > 0) {
        const scrollPercent = textarea.scrollTop / taMaxScroll;
        const prevMaxScroll = preview.scrollHeight - preview.clientHeight;
        preview.scrollTop = scrollPercent * prevMaxScroll;
      }
    }
  });

  const resizeObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => {
      if (!textarea.isConnected) {
        resizeObserver.disconnect();
        return;
      }
      syncEditorOverlay();
    })
    : null;
  resizeObserver?.observe(textarea);
  window.addEventListener('resize', syncEditorOverlay);

  const updatePreviewRef = { current: () => {} };
  const { saveBtn, cancelBtn } = setupEditorActions(
    actionsEl,
    slug,
    location,
    isNew,
    extractedTitle,
    textarea,
    updatePreviewRef,
    effectiveGridNote
  );

  const handleNewPageTabOrder = (e) => {
    if (!isNew || e.key !== 'Tab') return;

    const order = [titleEl, textarea, cancelBtn, saveBtn].filter(Boolean);
    const index = order.indexOf(e.target);
    if (index === -1) return;

    e.preventDefault();
    const direction = e.shiftKey ? -1 : 1;
    const nextIndex = (index + direction + order.length) % order.length;
    order[nextIndex]?.focus();
  };

  if (isNew) {
    titleEl?.addEventListener('keydown', handleNewPageTabOrder);
    cancelBtn.addEventListener('keydown', handleNewPageTabOrder);
    saveBtn.addEventListener('keydown', handleNewPageTabOrder);
  }

  // 4. Behaviors

  // Editor specific keyboard handling (Tab and Auto-lists)
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      handleEditorEnter(e, textarea, updatePreview);
    } else if (e.key === 'Tab') {
      handleEditorTab(e, textarea, updatePreview);
    }
  });

  // Live Preview & Highlighting Update
  let afRequest = null;
  let previewTimer = null;
  let initialRender = true;
  let pendingImmediatePreview = false;
  const PREVIEW_DEBOUNCE_MS = 200;

  const renderPreviewContent = () => {
    if (!preview.isConnected) return;
    const isInitial = initialRender;
    initialRender = false;
    const isPreviewActive = container.classList.contains('md-editor-container--preview-active');
    void renderMarkdownToElement(textarea.value, preview, { skipMermaid: !isPreviewActive })
      .then(() => {
        if (isInitial && getIsSidebarOutlineActive()) {
          refreshOutlineSidebar();
        }
      })
      .catch(console.error);
  };

  const updatePreview = (options) => {
    if (options?.immediate === true) {
      pendingImmediatePreview = true;
    }
    if (afRequest) cancelAnimationFrame(afRequest);
    afRequest = requestAnimationFrame(() => {
      // 1. Update syntax highlighting layer
      let text = textarea.value;
      if (text.endsWith('\n')) text += ' '; // ensure exact scroll height
      updateEditorHighlight(text, highlightCode);
      syncEditorOverlay();

      // 2. Update preview rendering (immediate on load/expand, debounced during typing)
      if (previewTimer) {
        clearTimeout(previewTimer);
        previewTimer = null;
      }
      const shouldRenderNow = pendingImmediatePreview || initialRender;
      pendingImmediatePreview = false;
      if (shouldRenderNow) {
        renderPreviewContent();
      } else {
        previewTimer = setTimeout(() => {
          previewTimer = null;
          renderPreviewContent();
        }, PREVIEW_DEBOUNCE_MS);
      }
      afRequest = null;
    });
  };
  textarea.addEventListener('input', updatePreview);
  updatePreviewRef.current = updatePreview;
  
  // Initial highlight call
  updatePreview({ immediate: true });
  void loadMarkdownDependencies().then(() => updatePreview({ immediate: true })).catch(console.error);

  attachMediaHandlers(textarea, saveBtn, slug, location, updatePreview);

  textarea.addEventListener('dragover', e => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
    }
  });

  // Toggle Preview
  const togglePreview = () => {
    const isActivating = container.classList.toggle('md-editor-container--preview-active');
    if (isActivating) {
      if (!preview.style.width || preview.style.width === '0px') {
        preview.style.width = '50%';
        preview.style.flex = 'none';
      }
      resizerIcon.innerHTML = SVG_CHEVRON_RIGHT;
      resizerIcon.title = 'Collapse preview';
      resizerIcon.setAttribute('aria-label', 'Collapse preview');
      resizer.title = 'Drag to resize';
      updatePreview({ immediate: true });
    } else {
      preview.style.width = '0px';
      resizerIcon.innerHTML = SVG_CHEVRON_LEFT;
      resizerIcon.title = 'Expand preview';
      resizerIcon.setAttribute('aria-label', 'Expand preview');
      resizer.title = 'Expand preview';
    }
  };

  resizerIcon.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePreview();
  });

  resizer.addEventListener('click', () => {
    if (!container.classList.contains('md-editor-container--preview-active')) {
      togglePreview();
    }
  });

  // Drag-to-resize logic
  let isDragging = false;
  resizer.addEventListener('mousedown', (e) => {
    if (!container.classList.contains('md-editor-container--preview-active') || e.target.closest('.md-editor-resizer-icon')) return;
    isDragging = true;
    resizer.classList.add('md-editor-resizer--dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  
  const onMouseMove = (e) => {
    if (!isDragging) return;
    const containerRect = container.getBoundingClientRect();
    // Calculate new width for preview pane
    // Distance from the right edge of container to the mouse position
    let newPreviewWidth = containerRect.right - e.clientX;
    // Bound the preview width between 100px and containerWidth - 100px
    newPreviewWidth = Math.max(100, Math.min(newPreviewWidth, containerRect.width - 100));
    preview.style.width = `${newPreviewWidth}px`;
    preview.style.flex = 'none';
  };
  
  const onMouseUp = () => {
    if (isDragging) {
      isDragging = false;
      resizer.classList.remove('md-editor-resizer--dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  };
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  function cleanup() {
    if (activeEditorCleanup === cleanup) {
      activeEditorCleanup = null;
    }
    if (afRequest) {
      cancelAnimationFrame(afRequest);
      afRequest = null;
    }
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
    resizeObserver?.disconnect();
    window.removeEventListener('resize', syncEditorOverlay);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    if (titleEl) {
      titleEl.removeEventListener('keydown', onTitleEnterKeyDown);
      titleEl.removeEventListener('input', onTitleInput);
    }
    if (isNew) {
      titleEl?.removeEventListener('keydown', handleNewPageTabOrder);
      textarea.removeEventListener('keydown', handleNewPageTabOrder);
      cancelBtn.removeEventListener('keydown', handleNewPageTabOrder);
      saveBtn.removeEventListener('keydown', handleNewPageTabOrder);
    }
    if (titleEl) {
      titleEl.removeAttribute('contenteditable');
      titleEl.classList.remove('content__title--editing', 'content__title--error');
    }
    if (effectiveGridNote) {
      effectiveGridNote.isEditing = false;
      effectiveGridNote.requestClose = null;
    }
    document.getElementById('content')?.classList.remove('content--editing');
  }
  activeEditorCleanup = cleanup;

  const initialTitle = titleEl?.textContent?.trim() ?? '';
  const initialBody = textarea.value;
  const isDirty = () => (titleEl?.textContent?.trim() ?? '') !== initialTitle || textarea.value !== initialBody;

  const requestCancel = async (target = 'default') => {
    if (isDirty()) {
      const discard = await openConfirmModal();
      if (!discard) return;
    }
    cleanup();
    if (effectiveGridNote) {
      if (target === 'grid' || !editFromView) {
        await closeActiveGridNote({ force: true });
        return;
      }
      renderNoteContent(state.currentPage);
      return;
    }
    if (onCancel) onCancel();
  };

  if (effectiveGridNote) {
    effectiveGridNote.requestClose = requestCancel;
  }

  // Cancel
  cancelBtn.addEventListener('click', () => {
    void requestCancel();
  });

  // Save
  async function save() {
    const title = titleEl?.textContent?.trim() ?? '';
    if (!title) {
      titleEl?.classList.add('content__title--error');
      titleEl?.focus();
      return;
    }
    titleEl?.classList.remove('content__title--error');

    if (effectiveGridNote) {
      const body = textarea.value ?? '';
      const payload = effectiveGridNote.isEncrypted
        ? { title, enc_text: body }
        : { title, text: encodeNote(body) };

      saveBtn.disabled = true;
      try {
        let savedItemIndex = effectiveGridNote.itemIndex;
        if (effectiveGridNote.isNew) {
          const res = await apiFetch(
            withLocation(`/pages/${encodeURIComponent(effectiveGridNote.slug)}/groups/${effectiveGridNote.groupIndex}/items`, effectiveGridNote.location),
            { method: 'POST', body: JSON.stringify(payload) }
          );
          if (typeof res?.item_index === 'number') {
            savedItemIndex = res.item_index;
          }
        } else {
          await apiFetch(
            withLocation(`/pages/${encodeURIComponent(effectiveGridNote.slug)}/groups/${effectiveGridNote.groupIndex}/items/${effectiveGridNote.itemIndex}`, effectiveGridNote.location),
            { method: 'PUT', body: JSON.stringify(payload) }
          );
        }

        const freshPage = await apiFetch(
          withLocation(`/pages/${encodeURIComponent(effectiveGridNote.slug)}`, effectiveGridNote.location)
        );
        state.currentPage = freshPage;

        const items = freshPage?.groups?.[effectiveGridNote.groupIndex]?.items ?? [];
        if (savedItemIndex == null || !items[savedItemIndex]) {
          savedItemIndex = items.findIndex(it => it.title === title);
        }
        const savedItem = savedItemIndex >= 0 ? items[savedItemIndex] : payload;

        effectiveGridNote.item = savedItem;
        effectiveGridNote.itemIndex = savedItemIndex >= 0 ? savedItemIndex : null;
        effectiveGridNote.isNew = false;
        effectiveGridNote.title = title;
        effectiveGridNote.rawMarkdown = body;

        cleanup();
        renderNoteContent(freshPage);
      } catch (err) {
        alert(err.message);
        saveBtn.disabled = false;
      }
      return;
    }

    // Duplicate check for new pages
    if (isNew) {
      const newSlug = slugify(title);
      const effectiveLocation = location ?? state.currentLocation;
      const duplicate = state.pages?.some(p => {
        const s = p.slug ?? slugify(p.page_name ?? p['page-name'] ?? '');
        return s === newSlug && (p.location ?? '') === (effectiveLocation ?? '');
      });
      if (duplicate) {
        titleEl?.classList.add('content__title--error');
        titleEl?.focus();
        showErrorBubble(titleEl, `A page named "${title}" already exists.`);
        return;
      }
    }

    const content = `# ${title}\n\n${textarea.value}`;
    saveBtn.disabled = true;

    try {
        const { slug: newSlug, page_name } = await callSaveApi(content, slug, isNew, location);
        // Update in-memory current page
        state.currentPage = { 'page-name': page_name, page_type: 'note', rawMarkdown: content };
        cleanup();
        if (onSave) onSave(newSlug, page_name);

    } catch (err) {
      // Show error in title or alert
      alert(err.message);
      saveBtn.disabled = false;
    }
  }

  saveBtn.addEventListener('click', save);

  function onKeyDown(e) {
    if (document.getElementById('_confirmModalOverlay')) return;
    if (document.querySelector('.modal-overlay, .add-picker, .keynav:not([hidden])')) return;
    if (!document.getElementById('floatingNav')?.hasAttribute('hidden')) return;
    if (document.getElementById('notificationMenuPanel')?.classList.contains('notification-panel--open')) return;
    if (document.querySelector('.add-page-menu--open')) return;
    if (e.key === 'Escape') {
      void requestCancel();
    } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    }
  }
  document.addEventListener('keydown', onKeyDown);

  // Focus editor
  if (isNew) {
    titleEl?.focus({ preventScroll: true });
  } else {
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(0, 0);
    textarea.scrollTop = 0;
  }
}

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------

async function renderAndPrintMarkdown(title, rawMarkdown) {
  // Render markdown to HTML in a temporary element attached to DOM (so mermaid can measure)
  const tmp = document.createElement('div');
  tmp.dataset.isPrint = 'true';
  tmp.style.position = 'absolute';
  tmp.style.visibility = 'hidden';
  tmp.style.left = '-9999px';
  document.body.appendChild(tmp);
  
  await renderMarkdownToElement(rawMarkdown, tmp);
  prepareMermaidForPrint(tmp);
  const bodyHtml = tmp.innerHTML;
  
  tmp.remove();

  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) return;

  win.document.documentElement.innerHTML = `
<head>
<meta charset="utf-8">
<title>${title.replaceAll('<', '&lt;')}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    color: #111;
    background: #fff;
    margin: 0;
    padding: 0;
    width: 100%;
  }
  h1 { font-size: 1.8rem; margin-bottom: 0.5rem; }
  h2 { font-size: 1.3rem; }
  h3 { font-size: 1.1rem; }
  h1, h2, h3, h4, h5, h6 { margin-top: 1.2em; }
  p, li { line-height: 1.6; }
  pre { background: #f4f4f4; padding: 0.8rem 1rem; border-radius: 4px; overflow-x: auto; }
  code { font-family: "JetBrains Mono", "Fira Code", monospace; font-size: 0.875em; background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 3px; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #ccc; margin: 0; padding-left: 1rem; color: #555; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; }
  th { background: #f0f0f0; }
  a { color: #2563eb; }
  .code-copy-btn, .inline-code-copy-btn { display: none !important; }
  .md-table-actions, .md-table-autosum-btn, .md-table-edit-btn, .md-table-add-col { display: none !important; }
  
  /* Mermaid Diagram Printing */
  .mermaid {
    width: 100%;
    margin: 1.5rem 0 !important;
    text-align: left !important;
    overflow: visible !important;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .mermaid svg {
    max-width: 100%;
    height: auto !important;
    display: block !important;
    margin: 0 !important;
    filter: invert(1) hue-rotate(180deg);
  }

  /* Safety resets in case any mermaid-viewer markup is present */
  .mermaid-viewer {
    border: none !important;
    box-shadow: none !important;
    background: transparent !important;
    overflow: visible !important;
    margin: 1.5rem 0 !important;
    max-width: 100% !important;
    width: 100% !important;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .mermaid-viewer__toolbar,
  .mermaid-viewer__minimap,
  .mermaid-viewer__hint,
  .mermaid-viewer__badge,
  .mermaid-viewer__btn,
  .mermaid-viewer__expand-btn {
    display: none !important;
  }
  .mermaid-viewer__viewport {
    height: auto !important;
    max-height: none !important;
    width: 100% !important;
    overflow: visible !important;
    background: transparent !important;
  }
  .mermaid-viewer__canvas {
    position: static !important;
    transform: none !important;
    width: 100% !important;
    display: block !important;
  }
  .mermaid-viewer__canvas .mermaid,
  .mermaid-viewer__canvas .mermaid svg {
    max-width: 100% !important;
    height: auto !important;
    display: block !important;
    margin: 0 !important;
  }
</style>
</head>
<body>
${bodyHtml}
<script>window.onload = () => window.print();</script>
</body>`;
}

/**
 * Fetch and print a note page in a new popup window.
 * @param {string} slug
 * @param {string|null} location
 */
export async function printNotePage(slug, location = null) {
  const path = withLocation(`/notes/${encodeURIComponent(slug)}`, location);
  const res = await fetch(`/api/v1${path}`);
  if (!res.ok) throw new Error(`Could not load note ${slug}`);
  const rawMarkdown = await res.text();

  const h1Match = /^#\s+(.+)/m.exec(rawMarkdown);
  const title = h1Match ? h1Match[1].trim() : slug;
  await renderAndPrintMarkdown(title, rawMarkdown);
}

/**
 * Print the currently displayed Note Page or full-screen Grid Note.
 * @param {string} slug
 * @param {string|null} location
 */
export async function printActiveNote(slug, location = null) {
  if (state.activeGridNote) {
    const gn = state.activeGridNote;
    const title = gn.title || 'Note';
    const rawMarkdown = gn.rawMarkdown ? `# ${title}\n\n${gn.rawMarkdown}` : `# ${title}`;
    await renderAndPrintMarkdown(title, rawMarkdown);
    return;
  }
  await printNotePage(slug, location);
}
