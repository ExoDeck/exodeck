// note.js — note renderer and editor
import { state, refreshPages, withLocation, apiFetch, isHelpWorkspace } from './app.js';
import { renderMarkdownToElement, loadMarkdownDependencies } from './markdown-utils.js';
import { prepareMermaidForPrint } from './mermaid-viewer.js';
import { showImageManagerModal } from './media-modal.js';
import { showErrorBubble, parseApiError } from './ui-utils.js';
import { toggleOutlineSidebar, getIsSidebarOutlineActive, refreshOutlineSidebar } from './outline-nav.js';
import { createPageActionMenu, isPinned } from './sidebar.js';
import { openConfirmModal } from './modal.js';

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
  const lines = (rawMarkdown ?? '').split('\n');
  if (lines[0]?.startsWith('# ')) {
    const title = lines[0].slice(2).trim();
    const rest = lines.slice(1);
    if (rest[0] === '') rest.shift();
    return { title, body: rest.join('\n') };
  }
  return { title: null, body: rawMarkdown ?? '' };
}

/**
 * Render a note into the content area.
 * @param {{ 'page-name': string, page_type: 'note', rawMarkdown: string }} page
 */
export function renderNoteContent(page) {
  // 1. Page title — extract from rawMarkdown if present
  const titleEl = document.getElementById('pageTitle');
  const { title: extractedTitle, body: bodyMarkdown } = extractTitleFromMarkdown(page.rawMarkdown ?? '');
  if (titleEl) titleEl.textContent = extractedTitle ?? (page['page-name'] ?? page.page_name ?? '');

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

  // 3. Edit button in content actions
  const actionsEl = document.getElementById('contentActions');
  if (actionsEl) {
    actionsEl.innerHTML = '';
    
    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'page-header__icon-btn';
    uploadBtn.style.position = 'relative'; // For absolute badge placement
    uploadBtn.title = 'Manage Images';
    uploadBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`;
    uploadBtn.addEventListener('click', () => {
      showImageManagerModal(state.currentSlug, state.currentLocation);
    });
    
    const onMediaChange1 = () => {
      if (!document.body.contains(uploadBtn)) {
        document.removeEventListener('exodeck:media-changed', onMediaChange1);
        return;
      }
      void updateMediaCount(state.currentSlug, state.currentLocation, uploadBtn);
    };
    document.addEventListener('exodeck:media-changed', onMediaChange1);
    void updateMediaCount(state.currentSlug, state.currentLocation, uploadBtn);



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

    const outlineBtn = document.createElement('button');
    outlineBtn.type = 'button';
    outlineBtn.className = 'page-header__icon-btn';
    outlineBtn.title = 'Outline (o)';
    outlineBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>`;
    outlineBtn.addEventListener('click', toggleOutlineSidebar);
    outlineBtn.classList.toggle('active', isPinned());


    if (!isHelpWorkspace(state.currentLocation)) {
      const menuBtn = createPageActionMenu(state.currentSlug, page['page-name'], 'note', state.currentLocation, true);
      actionsEl.appendChild(editBtn);
      actionsEl.appendChild(outlineBtn);
      actionsEl.appendChild(uploadBtn);
      actionsEl.appendChild(menuBtn);
    }
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

  toolbar.appendChild(createBtn('H1', '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17 12l2-2v8"/>', () => insertMarkdown(textarea, '# ', '', 'Heading 1')));
  toolbar.appendChild(createBtn('H2', '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"/>', () => insertMarkdown(textarea, '## ', '', 'Heading 2')));
  toolbar.appendChild(createBtn('H3', '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2"/><path d="M17 17.5c2 1.5 4 .5 4-1.5a2 2 0 0 0-2-2"/>', () => insertMarkdown(textarea, '### ', '', 'Heading 3')));

  toolbar.appendChild(createSep());
  
  toolbar.appendChild(createBtn('Bullet List', '<line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line>', () => toggleListPrefix(textarea, 'ul')));
  toolbar.appendChild(createBtn('Numbered List', '<line x1="10" y1="6" x2="21" y2="6"></line><line x1="10" y1="12" x2="21" y2="12"></line><line x1="10" y1="18" x2="21" y2="18"></line><path d="M4 6h1v4"></path><path d="M4 10h2"></path><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"></path>', () => toggleListPrefix(textarea, 'ol')));
  toolbar.appendChild(createBtn('Task List', '<polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>', () => toggleListPrefix(textarea, 'check')));

  toolbar.appendChild(createSep());

  toolbar.appendChild(createBtn('Single Line Code', '<polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline>', () => insertMarkdown(textarea, '`', '`', 'code')));
  toolbar.appendChild(createBtn('Codeblock', '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><polyline points="10 13 8 15 10 17"></polyline><polyline points="14 13 16 15 14 17"></polyline>', () => insertMarkdown(textarea, '\n```\n', '\n```\n', 'code block')));

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

  document.addEventListener('click', (e) => {
    if (!tableContainer.contains(e.target)) {
      picker.classList.remove('active');
      cells.forEach(el => el.classList.remove('selected'));
      label.textContent = '0x0';
    }
  });

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

function setupEditorActions(actionsEl, slug, location, isNew, extractedTitle, textarea, updatePreviewRef) {
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

  if (!isNew) {
    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'page-header__icon-btn';
    uploadBtn.style.position = 'relative';
    uploadBtn.title = 'Manage Images';
    uploadBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`;
    uploadBtn.addEventListener('click', () => {
      showImageManagerModal(slug, location, (md) => {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.substring(0, start) + md + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + md.length;
        updatePreviewRef.current();
        textarea.focus();
      });
    });
    
    const onMediaChange2 = () => {
      if (!document.body.contains(uploadBtn)) {
        document.removeEventListener('exodeck:media-changed', onMediaChange2);
        return;
      }
      void updateMediaCount(slug, location, uploadBtn);
    };
    document.addEventListener('exodeck:media-changed', onMediaChange2);
    void updateMediaCount(slug, location, uploadBtn);

    const outlineBtn = document.createElement('button');
    outlineBtn.type = 'button';
    outlineBtn.className = 'page-header__icon-btn';
    outlineBtn.title = 'Outline (o)';
    outlineBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>`;
    outlineBtn.addEventListener('click', toggleOutlineSidebar);
    outlineBtn.classList.toggle('active', isPinned());

    actionsEl.appendChild(outlineBtn);
    actionsEl.appendChild(uploadBtn);
  }

  if (!isNew && !isHelpWorkspace(location)) {
    const menuBtn = createPageActionMenu(slug, extractedTitle, 'note', location, true);
    actionsEl.appendChild(menuBtn);
  }

  return { saveBtn, cancelBtn };
}

function attachMediaHandlers(textarea, saveBtn, slug, location, isNew, updatePreview) {
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
    if (isNew || !files || files.length === 0) return;
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
  const code = codeLines.join('\n');
  const highlighted = highlightCodeBlock(code, lang);
  return `<span class="hljs-code">${escapeHtml(openLine)}\n${highlighted}\n${escapeHtml(closeLine)}</span>`;
}

function tryParseFenceOpen(line) {
  const match = line.match(/^[ \t]*```+[ \t]*([a-zA-Z0-9-]+)?/);
  return match ? (match[1] || '') : null;
}

function isFenceClose(line) {
  return /^[ \t]*```+[ \t]*$/.test(line);
}

function flushCurrentMd(state) {
  if (state.currentMd.length === 0) return;
  state.html += hljs.highlight(state.currentMd.join('\n'), { language: 'markdown' }).value;
  state.currentMd = [];
}

function processLineInEditor(line, state, isLastLine) {
  if (!state.inCodeBlock) {
    const fenceLang = tryParseFenceOpen(line);
    if (fenceLang !== null) {
      flushCurrentMd(state);
      if (state.html.length > 0) state.html += '\n';
      state.inCodeBlock = true;
      state.codeBlockOpenLine = line;
      state.codeBlockLang = fenceLang;
      state.codeBlockLines = [];
      return;
    }
    state.currentMd.push(line);
    return;
  }

  if (isFenceClose(line)) {
    state.inCodeBlock = false;
    state.html += formatCodeBlockSpan(state.codeBlockOpenLine, state.codeBlockLines, line, state.codeBlockLang);
    if (!isLastLine) state.html += '\n';
    return;
  }
  state.codeBlockLines.push(line);
}

function updateEditorSyntaxHighlighting(text) {
  if (typeof hljs === 'undefined') return null;

  const lines = text.split('\n');
  const state = {
    html: '',
    currentMd: [],
    inCodeBlock: false,
    codeBlockLines: [],
    codeBlockLang: '',
    codeBlockOpenLine: '',
  };

  for (let i = 0; i < lines.length; i++) {
    processLineInEditor(lines[i], state, i === lines.length - 1);
  }

  if (state.inCodeBlock) {
    state.currentMd.push(state.codeBlockOpenLine, ...state.codeBlockLines);
  }
  flushCurrentMd(state);
  return state.html;
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
 * Open the inline editor layout for a note.
 *
 * @param {{ rawMarkdown: string, slug: string|null, isNew: boolean, location?: string|null, onSave?: (slug:string, name:string) => void, onCancel?: () => void }} opts
 */
export function openInlineNoteEditor({ rawMarkdown, slug, isNew, location = null, onSave, onCancel }) {
  // 1. Prepare Content Area
  const titleEl = document.getElementById('pageTitle');
  const { title: extractedTitle, body: bodyMarkdown } = isNew
    ? { title: '', body: '' }
    : extractTitleFromMarkdown(rawMarkdown);
  if (titleEl) {
    titleEl.textContent = extractedTitle ?? '';
    titleEl.setAttribute('contenteditable', 'plaintext-only');
    titleEl.classList.add('content__title--editing');
    titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault();
    });
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

  // Scroll sync
  textarea.addEventListener('scroll', () => {
    highlightPre.scrollTop = textarea.scrollTop;
    highlightPre.scrollLeft = textarea.scrollLeft;

    if (container.classList.contains('md-editor-container--preview-active')) {
      const taMaxScroll = textarea.scrollHeight - textarea.clientHeight;
      if (taMaxScroll > 0) {
        const scrollPercent = textarea.scrollTop / taMaxScroll;
        const prevMaxScroll = preview.scrollHeight - preview.clientHeight;
        preview.scrollTop = scrollPercent * prevMaxScroll;
      }
    }
  });

  const updatePreviewRef = { current: () => {} };
  const { saveBtn, cancelBtn } = setupEditorActions(actionsEl, slug, location, isNew, extractedTitle, textarea, updatePreviewRef);

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
  let initialRender = true;
  const updatePreview = () => {
    if (afRequest) cancelAnimationFrame(afRequest);
    afRequest = requestAnimationFrame(() => {
      // 1. Update syntax highlighting layer
      let text = textarea.value;
      if (text.endsWith('\n')) text += ' '; // ensure exact scroll height
      updateEditorHighlight(text, highlightCode);

      // 2. Update preview rendering unconditionally (so outline view can find headings)
      const isInitial = initialRender;
      initialRender = false;
      void renderMarkdownToElement(textarea.value, preview)
        .then(() => {
          if (isInitial && getIsSidebarOutlineActive()) {
            refreshOutlineSidebar();
          }
        })
        .catch(console.error);
      afRequest = null;
    });
  };
  textarea.addEventListener('input', updatePreview);
  updatePreviewRef.current = updatePreview;
  
  // Initial highlight call
  updatePreview();
  void loadMarkdownDependencies().then(updatePreview).catch(console.error);

  attachMediaHandlers(textarea, saveBtn, slug, location, isNew, updatePreview);

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
      updatePreview();
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
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
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
    document.getElementById('content')?.classList.remove('content--editing');
  }

  const initialTitle = extractedTitle ?? '';
  const initialBody = bodyMarkdown ?? '';
  const isDirty = () => (titleEl?.textContent?.trim() ?? '') !== initialTitle || textarea.value !== initialBody;

  const requestCancel = async () => {
    if (isDirty()) {
      const discard = await openConfirmModal();
      if (!discard) return;
    }
    cleanup();
    if (onCancel) onCancel();
  };

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

/**
 * Fetch and print a note page in a new popup window.
 * @param {string} slug
 * @param {string|null} location
 */
export async function printNotePage(slug, location = null) {
  let rawMarkdown;
    const path = withLocation(`/notes/${encodeURIComponent(slug)}`, location);
    const res = await fetch(`/api/v1${path}`);
    if (!res.ok) throw new Error(`Could not load note ${slug}`);
    rawMarkdown = await res.text();


  const h1Match = /^#\s+(.+)/m.exec(rawMarkdown);
  const title = h1Match ? h1Match[1].trim() : slug;

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
