import { state } from './app.js';

let rendererInitialized = false;
let depsLoadingPromise = null;

function isExternalHref(href) {
  return /^(https?:\/\/|mailto:|tel:|data:|javascript:)/i.test(href);
}

function normalizeWorkspacePath(pathname) {
  const clean = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const segments = clean.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  // If link is a bare slug path (e.g. /page-a or page-a), scope it to current workspace.
  if (segments.length === 1 && state.currentLocation) {
    return `/${state.currentLocation}/${segments[0]}`;
  }

  return clean;
}

function resolveInternalPageTarget(rawHref) {
  if (!rawHref || rawHref.startsWith('#') || isExternalHref(rawHref)) return null;

  let pathname;
  if (rawHref.startsWith('/')) {
    pathname = rawHref;
  } else {
    const basePath = state.currentLocation ? `/${state.currentLocation}/` : '/';
    pathname = new URL(rawHref, `${window.location.origin}${basePath}`).pathname;
  }

  const normalizedPath = normalizeWorkspacePath(pathname);
  if (!normalizedPath) return null;

  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const [location, slug] = segments;
  const exists = state.pages.some(p => p.location === location && p.slug === slug);
  if (!exists) return null;

  return { location, slug, path: `/${location}/${slug}` };
}

async function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

export async function loadMarkdownDependencies() {
  if (typeof marked !== 'undefined' && typeof mermaid !== 'undefined' && typeof hljs !== 'undefined') {
    return;
  }
  if (!depsLoadingPromise) {
    depsLoadingPromise = Promise.all([
      loadScript('vendor/highlight.min.js'),
      loadScript('vendor/mermaid.min.js'),
      loadScript('vendor/marked.min.js')
    ]);
  }
  return depsLoadingPromise;
}

function initRenderer() {
  if (rendererInitialized || typeof marked === 'undefined') return;

  const renderer = new marked.Renderer();

  // Override the code block renderer
  renderer.code = function (codeInfo) {
    // marked v17 often passes a token object to the renderer function, 
    // although the signature renderer.code(code, language) works in older versions.
    // Let's handle both.
    const code = typeof codeInfo === 'object' ? codeInfo.text : arguments[0];
    const language = typeof codeInfo === 'object' ? codeInfo.lang : arguments[1];

    if (language === 'mermaid') {
      return `<div class="mermaid">${code}</div>`;
    }

    const copyIcon = '<span class="material-symbols-outlined copy-icon" style="font-size: 16px;" aria-hidden="true">content_copy</span>';

    if (language && typeof hljs !== 'undefined' && hljs.getLanguage(language)) {
      try {
        const highlighted = hljs.highlight(code, { language }).value;
        return `<div class="code-block-wrapper"><button class="code-copy-btn" title="Copy to clipboard">${copyIcon}</button><pre><code class="hljs language-${language}">${highlighted}</code></pre></div>`;
      } catch (err) {
        console.error('Highlight.js error:', err);
      }
    }

    // Default formatting (with hljs class so base CSS applies smoothly if desired)
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
    const escapedCode = code.replace(/[&<>"]/g, m => map[m]);
    return `<div class="code-block-wrapper"><button class="code-copy-btn" title="Copy to clipboard">${copyIcon}</button><pre><code class="hljs">${escapedCode}</code></pre></div>`;
  };

  // Override inline code renderer
  renderer.codespan = function(tokenInfo) {
    const text = typeof tokenInfo === 'object' ? tokenInfo.text : arguments[0];
    const copyIcon = '<span class="material-symbols-outlined copy-icon" style="font-size: 14px;" aria-hidden="true">content_copy</span>';
    return `<code class="inline-code-wrapper"><span class="inline-code-text">${text}</span><button class="inline-code-copy-btn" title="Copy to clipboard">${copyIcon}</button></code>`;
  };

  // Override image renderer for relative paths
  renderer.image = function(tokenInfo) {
    let href = typeof tokenInfo === 'object' ? tokenInfo.href : arguments[0];
    let title = typeof tokenInfo === 'object' ? tokenInfo.title : arguments[1];
    let text = typeof tokenInfo === 'object' ? tokenInfo.text : arguments[2];

    if (!href.match(/^(https?:\/\/|data:)/)) {
      // Import state dynamically to avoid circular dependencies if any
      // but since it's lazy we can just rely on the global object or a quick hack
      // Actually we can just find the location from the URL or state
      // For now, let's keep it simple: relative paths get /api/v1/media prepended
      // we need the location context.
      if (href.startsWith('_IMG_/')) {
        const slug = state.currentSlug || '';
        href = href.replace('_IMG_/', slug + '/');
      }
      const loc = state.currentLocation || '';
      href = `/api/v1/media/${href}${loc ? '?location=' + encodeURIComponent(loc) : ''}`;
    }

    let out = `<img src="${href}" alt="${text || ''}" class="md-img"`;
    if (title) {
      out += ` title="${title}"`;
    }
    out += ` />`;
    return out;
  };

  // Normalize internal markdown links so relative links include current workspace.
  renderer.link = function(tokenInfo) {
    let href = typeof tokenInfo === 'object' ? tokenInfo.href : arguments[0];
    let title = typeof tokenInfo === 'object' ? tokenInfo.title : arguments[1];
    let text = typeof tokenInfo === 'object' ? tokenInfo.text : arguments[2];

    const target = resolveInternalPageTarget(href);
    if (target) href = target.path;

    let out = `<a href="${href}"`;
    if (title) out += ` title="${title}"`;
    out += `>${text ?? ''}</a>`;
    return out;
  };

  renderer.checkbox = function(checked) {
    const isChecked = typeof checked === 'object' ? checked.checked : checked;
    const checkedAttr = isChecked ? 'checked' : '';
    return `<input type="checkbox" class="task-list-checkbox" ${checkedAttr} /> `;
  };

  marked.use({ renderer, breaks: true });

  // Initialize mermaid configuration if available
  if (typeof mermaid !== 'undefined') {
    mermaid.initialize({ startOnLoad: false, theme: 'dark' });
  }

  rendererInitialized = true;
}

function skipCodeBlock(lines, i) {
  let j = i + 1;
  while (j < lines.length && !lines[j].trim().startsWith('```')) j++;
  return j;
}

function isTableStart(lines, i) {
  return i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].includes('-');
}

function updateTableState(line, lines, i, state, targetIndex) {
  if (line.includes('|')) {
    if (!state.inTable && isTableStart(lines, i)) {
      state.inTable = true;
      state.mdTableIndex++;
      if (state.mdTableIndex === targetIndex) state.tableStart = i;
    }
    if (state.inTable && state.mdTableIndex === targetIndex) state.tableEnd = i;
  } else if (state.inTable) {
    state.inTable = false;
  }
}

function parseTableBoundaries(lines, targetIndex) {
  const state = {
    mdTableIndex: -1,
    inTable: false,
    tableStart: -1,
    tableEnd: -1
  };
  
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.startsWith('```')) {
      i = skipCodeBlock(lines, i) + 1;
    } else {
      updateTableState(line, lines, i, state, targetIndex);
      i++;
    }
  }
  return { tableStart: state.tableStart, tableEnd: state.tableEnd };
}

function getSeparatorRow(mdLines) {
  if (mdLines.length <= 1) return null;
  let sepLine = mdLines[1].trim();
  if (sepLine.startsWith('|')) sepLine = sepLine.slice(1);
  if (sepLine.endsWith('|')) sepLine = sepLine.slice(0, -1);
  return JSON.stringify(sepLine.split(/(?<!\\)\|/).map(s => s.trim()));
}

function populateRow(tr, content) {
  if (content.startsWith('|')) content = content.slice(1);
  if (content.endsWith('|')) content = content.slice(0, -1);
  const parts = content.split(/(?<!\\)\|/);
  
  const cells = tr.querySelectorAll('th, td');
  for (let c = 0; c < cells.length; c++) {
    cells[c].textContent = parts[c] !== undefined ? parts[c].trim() : '';
    cells[c].contentEditable = 'true';
  }
}

function loadMarkdownIntoTable(mdLines, trs, wrap) {
  const seps = getSeparatorRow(mdLines);
  if (seps) wrap.dataset.originalSeparators = seps;
  
  let htmlRowIdx = 0;
  for (let i = 0; i < mdLines.length; i++) {
    if (i === 1) continue; // skip separator
    if (htmlRowIdx < trs.length) {
      populateRow(trs[htmlRowIdx], mdLines[i].trim());
    }
    htmlRowIdx++;
  }
}

/**
 * Update the state of a checkbox in a markdown string by its index.
 * @param {string} rawMarkdown
 * @param {number} checkboxIndex
 * @param {boolean} isChecked
 * @returns {string}
 */
export function updateMarkdownCheckbox(rawMarkdown, checkboxIndex, isChecked) {
  const lines = (rawMarkdown ?? '').split('\n');
  let inCodeBlock = false;
  let matchCount = 0;
  const regex = /^([ \t>]*(?:[-*+]|\d+\.)[ \t]+)\[([ xX])\]/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```') || line.trim().startsWith('~~~')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    if (regex.test(line)) {
      if (matchCount === checkboxIndex) {
        lines[i] = line.replace(regex, (match, prefix) => `${prefix}[${isChecked ? 'x' : ' '}]`);
        return lines.join('\n');
      }
      matchCount++;
    }
  }

  return rawMarkdown;
}

/**
 * Render a markdown string to HTML and initialize any Mermaid diagrams.
 *
 * @param {string} markdown - The raw markdown text
 * @param {HTMLElement} containerElement - The DOM element to populate
 */
export async function renderMarkdownToElement(markdown, containerElement) {
  await loadMarkdownDependencies();
  initRenderer();

  if (typeof marked === 'undefined') {
    containerElement.textContent = markdown;
    return;
  }

  // Parse markdown
  containerElement.innerHTML = marked.parse(markdown || '');

  // Assign IDs to headings for outline navigation
  const headings = containerElement.querySelectorAll('h1, h2, h3, h4, h5, h6');
  headings.forEach((h, index) => {
    if (!h.id) {
      // Create a URL-friendly slug from the text, fallback to index. Prefix with 'h-' to avoid querySelector syntax errors if text starts with a number.
      const rawSlug = h.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const slug = rawSlug ? `h-${rawSlug}` : `heading-${index}`;
      
      // Ensure uniqueness
      let uniqueId = slug;
      let counter = 1;
      // We can safely use querySelector because uniqueId is guaranteed to start with 'h-'
      while (containerElement.querySelector(`#${uniqueId}`)) {
        uniqueId = `${slug}-${counter}`;
        counter++;
      }
      h.id = uniqueId;
    }
  });

  // Intercept internal link clicks and route through SPA page loader.
  if (containerElement._ExoDeckLinkHandler) {
    containerElement.removeEventListener('click', containerElement._ExoDeckLinkHandler);
  }
  containerElement._ExoDeckLinkHandler = async (event) => {
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor) return;

    const href = anchor.getAttribute('href') ?? '';
    const target = resolveInternalPageTarget(href);
    if (!target) return;

    event.preventDefault();
    try {
      const sidebar = await import('./sidebar.js');
      await sidebar.loadPage(target.slug, target.location, 'push');
    } catch (err) {
      console.error('[ExoDeck] Failed to route internal markdown link:', err);
      window.location.assign(target.path);
    }
  };
  containerElement.addEventListener('click', containerElement._ExoDeckLinkHandler);

  // Handle task list checkbox toggles
  if (containerElement._ExoDeckCheckboxHandler) {
    containerElement.removeEventListener('change', containerElement._ExoDeckCheckboxHandler);
  }
  containerElement._ExoDeckCheckboxHandler = async (event) => {
    if (!event.target.classList.contains('task-list-checkbox')) return;
    
    const isChecked = event.target.checked;

    if (containerElement.classList.contains('md-editor-preview')) {
      event.preventDefault();
      event.target.checked = !isChecked;
      return;
    }

    // Update the raw markdown in state.currentPage.rawMarkdown and save it
    if (state.currentPage?.page_type === 'note') {
      const checkboxes = Array.from(containerElement.querySelectorAll('.task-list-checkbox'));
      const index = checkboxes.indexOf(event.target);
      if (index === -1) return;
      
      const newRaw = updateMarkdownCheckbox(state.currentPage.rawMarkdown, index, isChecked);
      state.currentPage.rawMarkdown = newRaw;
      
      try {
        const { callSaveApi } = await import('./note.js');
        await callSaveApi(newRaw, state.currentSlug, false, state.currentLocation);
      } catch (err) {
        console.error('Failed to save checkbox state', err);
        event.target.checked = !isChecked; // revert UI
      }
    }
  };
  containerElement.addEventListener('change', containerElement._ExoDeckCheckboxHandler);

  // Render mermaid diagrams
  if (typeof mermaid !== 'undefined') {
    const mermaidNodes = containerElement.querySelectorAll('.mermaid');
    if (mermaidNodes.length > 0) {
      try {
        // use mermaid.run to process specifically these nodes
        await mermaid.run({
          nodes: mermaidNodes,
          suppressErrors: true
        });
      } catch (e) {
        console.error('Mermaid rendering error:', e);
      }
    }
  }

  // Initialize table editing
  initTableEditing(containerElement);
}

// Global listener for copy to clipboard in code blocks
document.addEventListener('click', async (event) => {
  const btn = event.target.closest('.code-copy-btn, .inline-code-copy-btn');
  if (!btn) return;
  
  let textToCopy;
  let successIcon;
  
  if (btn.classList.contains('inline-code-copy-btn')) {
    const wrapper = btn.closest('.inline-code-wrapper');
    if (!wrapper) return;
    const textEl = wrapper.querySelector('.inline-code-text');
    if (!textEl) return;
    textToCopy = textEl.textContent;
    successIcon = '<span class="material-symbols-outlined copy-icon-success" style="font-size: 14px;" aria-hidden="true">check</span>';
  } else {
    const wrapper = btn.closest('.code-block-wrapper');
    if (!wrapper) return;
    const codeEl = wrapper.querySelector('code');
    if (!codeEl) return;
    textToCopy = codeEl.textContent;
    successIcon = '<span class="material-symbols-outlined copy-icon-success" style="font-size: 16px;" aria-hidden="true">check</span>';
  }

  try {
    await navigator.clipboard.writeText(textToCopy);
    const originalHTML = btn.innerHTML;
    btn.innerHTML = successIcon;
    setTimeout(() => {
      // Revert if still in success state (to prevent overriding a subsequent click during the timeout)
      if (btn.querySelector('.copy-icon-success')) {
        btn.innerHTML = originalHTML;
      }
    }, 2000);
  } catch (err) {
    console.error('Failed to copy text: ', err);
  }
});

const SVG_SIGMA = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 4H6l7 8-7 8h12"/></svg>';

const activeAutoSumTables = new Set();

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Determine the decimal and grouping separators for the given (or current) locale.
 * Uses a 5-digit integer so locales with min2 grouping (e.g. es-ES, pl-PL) emit a group part.
 * @param {string|undefined} [locale]
 * @returns {{ decimal: string, group: string }}
 */
export function getLocaleSeparators(locale = undefined) {
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  const decimal = parts.find(p => p.type === 'decimal')?.value ?? '.';
  const group = parts.find(p => p.type === 'group')?.value ?? '';
  return { decimal, group };
}

/**
 * Strip symmetric outer Markdown inline formatting wrappers (used in table edit mode).
 * @param {string} text
 * @returns {string}
 */
export function stripMarkdownFormatting(text) {
  let s = (text ?? '').trim();
  const wrappers = ['**', '__', '~~', '*', '_', '`'];
  let changed = true;
  while (changed && s.length >= 2) {
    changed = false;
    for (const w of wrappers) {
      if (s.length > w.length * 2 && s.startsWith(w) && s.endsWith(w)) {
        s = s.slice(w.length, -w.length).trim();
        changed = true;
        break;
      }
    }
  }
  return s;
}

/**
 * Parse a numeric string strictly according to the given (or current) locale.
 * Returns null if empty or not a valid locale-formatted number.
 * @param {string} rawText
 * @param {string|undefined} [locale]
 * @returns {{ value: number, decimals: number }|null}
 */
export function parseLocaleNumber(rawText, locale = undefined) {
  if (typeof rawText !== 'string') return null;
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  const { decimal, group } = getLocaleSeparators(locale);
  const decPat = escapeRegExp(decimal);

  let groupPat = '';
  if (group && group !== decimal) {
    if (/^[\s\u00a0\u202f]$/.test(group)) {
      groupPat = String.raw`[\s\u00a0\u202f]`;
    } else if (/^['\u2019\u02bc]$/.test(group)) {
      groupPat = String.raw`['\u2019\u02bc]`;
    } else {
      groupPat = escapeRegExp(group);
    }
  }

  const intBranch = groupPat
    ? String.raw`(?:\d+|[1-9]\d{0,2}(?:${groupPat}\d{3})+)`
    : String.raw`\d+`;
  const numRegex = new RegExp(
    String.raw`^([+\-\u2212])?\s*(?:(${intBranch})(?:${decPat}(\d+))?|${decPat}(\d+))$`
  );

  const match = numRegex.exec(trimmed);
  if (!match) return null;

  const frac = match[3] ?? match[4] ?? '';
  const cleanInt = match[2] ? match[2].replace(/\D/g, '') : '0';
  const sign = (match[1] === '-' || match[1] === '\u2212') ? '-' : '';
  const normalized = frac ? `${sign}${cleanInt}.${frac}` : `${sign}${cleanInt}`;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;

  const value = Object.is(parsed, -0) ? 0 : parsed;
  return { value, decimals: frac.length };
}

/**
 * Format a numeric sum in the given (or current) locale without float drift or extra labels.
 * @param {number} sum
 * @param {number} [maxDecimals=0]
 * @param {string|undefined} [locale]
 * @returns {string}
 */
export function formatLocaleSum(sum, maxDecimals = 0, locale = undefined) {
  const precision = Math.min(Math.max(0, maxDecimals), 10);
  const rounded = Number(sum.toFixed(precision));
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: precision,
  }).format(normalized);
}

/**
 * Calculate row sums, column sums, and total sum for a table matrix.
 * @param {Array<{ isHeader: boolean, cells: string[] }>} matrix
 * @param {string|undefined} [locale]
 * @returns {{ rowSums: string[], colSums: string[], totalSum: string }}
 */
export function calculateMatrixSums(matrix, locale = undefined) {
  const colCount = matrix.reduce((max, row) => Math.max(max, row.cells.length), 0);
  const colStats = Array.from({ length: colCount }, () => ({ sum: 0, count: 0, maxDecimals: 0 }));
  const totalStats = { sum: 0, count: 0, maxDecimals: 0 };
  const rowSums = [];

  for (const row of matrix) {
    if (row.isHeader) {
      rowSums.push('');
      continue;
    }

    let rowSum = 0;
    let rowCount = 0;
    let rowMaxDecimals = 0;

    for (let c = 0; c < row.cells.length; c++) {
      const parsed = parseLocaleNumber(row.cells[c], locale);
      if (parsed === null) continue;

      rowSum += parsed.value;
      rowCount++;
      rowMaxDecimals = Math.max(rowMaxDecimals, parsed.decimals);

      colStats[c].sum += parsed.value;
      colStats[c].count++;
      colStats[c].maxDecimals = Math.max(colStats[c].maxDecimals, parsed.decimals);

      totalStats.sum += parsed.value;
      totalStats.count++;
      totalStats.maxDecimals = Math.max(totalStats.maxDecimals, parsed.decimals);
    }

    rowSums.push(rowCount > 0 ? formatLocaleSum(rowSum, rowMaxDecimals, locale) : '');
  }

  const colSums = colStats.map(s => (s.count > 0 ? formatLocaleSum(s.sum, s.maxDecimals, locale) : ''));
  const totalSum = totalStats.count > 0 ? formatLocaleSum(totalStats.sum, totalStats.maxDecimals, locale) : '';

  return { rowSums, colSums, totalSum };
}

function extractCleanCellText(cell, isEditing) {
  if (isEditing) {
    return stripMarkdownFormatting(cell.textContent ?? '');
  }
  if (!cell.querySelector('.inline-code-copy-btn, .copy-icon')) {
    return (cell.textContent ?? '').trim();
  }
  const clone = cell.cloneNode(true);
  clone.querySelectorAll('.inline-code-copy-btn, .copy-icon').forEach(el => el.remove());
  return (clone.textContent ?? '').trim();
}

function extractTableMatrix(table, isEditing) {
  const trs = Array.from(table.rows);
  const hasTHead = Boolean(table.tHead && table.tHead.rows.length > 0);

  return trs.map((tr, rIdx) => {
    const cells = Array.from(tr.cells);
    const isHeader = hasTHead
      ? tr.parentElement === table.tHead
      : (rIdx === 0 && cells.length > 0 && cells.every(c => c.tagName === 'TH'));
    return {
      isHeader,
      cells: cells.map(c => extractCleanCellText(c, isEditing)),
    };
  });
}

function syncSumElementCount(container, targetCount, className) {
  while (container.children.length > targetCount) {
    container.lastElementChild.remove();
  }
  while (container.children.length < targetCount) {
    const cell = document.createElement('div');
    cell.className = className;
    container.appendChild(cell);
  }
}

function resolveFlexJustify(textAlign) {
  if (textAlign === 'right' || textAlign === 'end') return 'flex-end';
  if (textAlign === 'center') return 'center';
  return 'flex-start';
}

function initTableEditing(containerElement) {
  if (!containerElement.classList.contains('md-page__content') || containerElement.classList.contains('md-editor-preview')) return;

  const isReadOnlyDoc = state.currentLocation === 'docs';
  const tables = containerElement.querySelectorAll('table');
  tables.forEach((table, index) => {
    if (table.closest('.md-table-wrapper')) return;

    const autoSumKey = `${state.currentLocation ?? ''}:${state.currentSlug ?? ''}:${index}`;

    const wrapper = document.createElement('div');
    wrapper.className = 'md-table-wrapper';

    const layout = document.createElement('div');
    layout.className = 'md-table-layout';

    const tableBox = document.createElement('div');
    tableBox.className = 'md-table-box';

    const actions = document.createElement('div');
    actions.className = 'md-table-actions';

    const autoSumBtn = document.createElement('button');
    autoSumBtn.type = 'button';
    autoSumBtn.className = 'md-table-autosum-btn';
    autoSumBtn.title = 'Toggle Auto Sum';
    autoSumBtn.setAttribute('aria-label', 'Toggle Auto Sum');
    autoSumBtn.setAttribute('aria-pressed', 'false');
    autoSumBtn.innerHTML = SVG_SIGMA;

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'md-table-edit-btn';
    editBtn.title = 'Edit Table';
    editBtn.setAttribute('aria-label', 'Edit Table');
    editBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">edit</span>';
    if (isReadOnlyDoc) editBtn.style.display = 'none';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'md-table-cancel-btn';
    cancelBtn.title = 'Cancel';
    cancelBtn.setAttribute('aria-label', 'Cancel');
    cancelBtn.style.display = 'none';
    cancelBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">close</span>';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'md-table-save-btn';
    saveBtn.title = 'Save';
    saveBtn.setAttribute('aria-label', 'Save');
    saveBtn.style.display = 'none';
    saveBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px;" aria-hidden="true">check</span>';

    actions.appendChild(autoSumBtn);
    actions.appendChild(editBtn);
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    const addColIndicator = document.createElement('div');
    addColIndicator.className = 'md-table-add-col';
    addColIndicator.innerHTML = '<div class="md-table-add-col-icon"><span class="material-symbols-outlined" style="font-size: 14px;" aria-hidden="true">add</span></div><div class="md-table-add-col-line"></div>';

    const rowSumsEl = document.createElement('div');
    rowSumsEl.className = 'md-table-row-sums';

    const colSumsEl = document.createElement('div');
    colSumsEl.className = 'md-table-col-sums';

    const totalSumEl = document.createElement('div');
    totalSumEl.className = 'md-table-total-sum';
    const totalCellEl = document.createElement('div');
    totalCellEl.className = 'md-table-sum-cell md-table-sum-cell--total';
    totalSumEl.appendChild(totalCellEl);

    table.parentNode.insertBefore(wrapper, table);
    tableBox.appendChild(actions);
    tableBox.appendChild(table);
    tableBox.appendChild(addColIndicator);
    layout.appendChild(tableBox);
    layout.appendChild(rowSumsEl);
    layout.appendChild(colSumsEl);
    layout.appendChild(totalSumEl);
    wrapper.appendChild(layout);

    let isEditing = false;
    let isAutoSum = false;
    let originalHTML = '';
    let insertColIndex = -1;
    let resizeRaf = null;

    function syncAutoSumDimensions() {
      if (!isAutoSum || !table.isConnected) return;

      const trs = Array.from(table.rows);
      if (trs.length === 0) return;

      const tableRect = table.getBoundingClientRect();
      const firstRowRect = trs[0].getBoundingClientRect();
      rowSumsEl.style.paddingTop = `${Math.max(0, firstRowRect.top - tableRect.top)}px`;

      for (let r = 0; r < trs.length && r < rowSumsEl.children.length; r++) {
        const rowHeight = trs[r].getBoundingClientRect().height;
        rowSumsEl.children[r].style.height = `${rowHeight}px`;
      }

      const refRow = trs[0];
      const firstBodyRow = Array.from(table.tBodies).flatMap(tb => Array.from(tb.rows))[0] ?? trs[1] ?? refRow;
      const refCells = Array.from(refRow.cells);
      if (refCells.length > 0) {
        const firstCellRect = refCells[0].getBoundingClientRect();
        colSumsEl.style.paddingLeft = `${Math.max(0, firstCellRect.left - tableRect.left)}px`;

        for (let c = 0; c < refCells.length && c < colSumsEl.children.length; c++) {
          const colWidth = refCells[c].getBoundingClientRect().width;
          const colSumCell = colSumsEl.children[c];
          colSumCell.style.width = `${colWidth}px`;
          colSumCell.style.minWidth = `${colWidth}px`;
          colSumCell.style.maxWidth = `${colWidth}px`;

          const alignCell = firstBodyRow.cells[c] ?? refCells[c];
          const textAlign = window.getComputedStyle(alignCell).textAlign;
          colSumCell.style.justifyContent = resolveFlexJustify(textAlign);
        }
      }
    }

    function updateAutoSum() {
      if (!isAutoSum) return;

      const matrix = extractTableMatrix(table, isEditing);
      const { rowSums, colSums, totalSum } = calculateMatrixSums(matrix);

      syncSumElementCount(rowSumsEl, rowSums.length, 'md-table-sum-cell md-table-sum-cell--row');
      for (let r = 0; r < rowSums.length; r++) {
        rowSumsEl.children[r].textContent = rowSums[r];
      }

      syncSumElementCount(colSumsEl, colSums.length, 'md-table-sum-cell md-table-sum-cell--col');
      for (let c = 0; c < colSums.length; c++) {
        colSumsEl.children[c].textContent = colSums[c];
      }

      totalCellEl.textContent = totalSum;
      syncAutoSumDimensions();
    }

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
        if (!table.isConnected) {
          resizeObserver.disconnect();
          return;
        }
        if (!isAutoSum) return;
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = null;
          syncAutoSumDimensions();
        });
      })
      : null;

    function setAutoSumState(enabled) {
      isAutoSum = enabled;
      if (isAutoSum) {
        activeAutoSumTables.add(autoSumKey);
      } else {
        activeAutoSumTables.delete(autoSumKey);
      }
      wrapper.classList.toggle('md-table-wrapper--autosum', isAutoSum);
      autoSumBtn.classList.toggle('md-table-autosum-btn--active', isAutoSum);
      autoSumBtn.setAttribute('aria-pressed', String(isAutoSum));

      if (isAutoSum) {
        updateAutoSum();
        resizeObserver?.observe(table);
      } else {
        resizeObserver?.unobserve(table);
      }
    }

    autoSumBtn.addEventListener('click', () => {
      setAutoSumState(!isAutoSum);
    });

    table.addEventListener('input', () => {
      if (isAutoSum) updateAutoSum();
    });

    wrapper.addEventListener('mousemove', (e) => {
      if (!isEditing) return;

      const tableRect = table.getBoundingClientRect();
      const boxRect = tableBox.getBoundingClientRect();
      const header = table.querySelector('thead');
      if (!header) return;
      const headerRect = header.getBoundingClientRect();

      // Allow hovering slightly above the header for the icon, down to the bottom of the header
      if (e.clientY >= headerRect.top - 20 && e.clientY <= headerRect.bottom) {
        if (e.clientX >= tableRect.left - 20 && e.clientX <= tableRect.right + 20) {
          const ths = Array.from(header.querySelectorAll('th'));
          let closestIndex = -1;
          let minDistance = 20;
          let closestX = 0;

          ths.forEach((th, idx) => {
            const rect = th.getBoundingClientRect();
            // check left edge
            if (Math.abs(e.clientX - rect.left) < minDistance) {
              minDistance = Math.abs(e.clientX - rect.left);
              closestIndex = idx;
              closestX = rect.left;
            }
            // check right edge (for end of table)
            if (idx === ths.length - 1) {
              if (Math.abs(e.clientX - rect.right) < minDistance) {
                minDistance = Math.abs(e.clientX - rect.right);
                closestIndex = idx + 1;
                closestX = rect.right;
              }
            }
          });

          if (closestIndex !== -1) {
            addColIndicator.classList.add('active');
            addColIndicator.style.left = (closestX - boxRect.left) + 'px';
            addColIndicator.style.height = tableRect.height + 'px';
            addColIndicator.style.top = (tableRect.top - boxRect.top) + 'px';
            insertColIndex = closestIndex;
            return;
          }
        }
      }

      addColIndicator.classList.remove('active');
      insertColIndex = -1;
    });

    wrapper.addEventListener('mouseleave', () => {
      addColIndicator.classList.remove('active');
      insertColIndex = -1;
    });

    addColIndicator.addEventListener('click', () => {
      if (!isEditing || insertColIndex === -1) return;

      const trs = table.querySelectorAll('tr');
      trs.forEach(tr => {
        const isHeader = tr.parentElement.tagName === 'THEAD';
        const cell = document.createElement(isHeader ? 'th' : 'td');
        cell.contentEditable = 'true';
        if (insertColIndex >= tr.children.length) {
          tr.appendChild(cell);
        } else {
          tr.insertBefore(cell, tr.children[insertColIndex]);
        }
      });

      addColIndicator.classList.remove('active');
      if (isAutoSum) updateAutoSum();

      // Auto-focus the newly created header cell
      const newHeaderCells = table.querySelectorAll('thead tr ' + (insertColIndex >= trs[0].children.length ? 'th:last-child' : `th:nth-child(${insertColIndex + 1})`));
      if (newHeaderCells.length > 0) newHeaderCells[0].focus();
    });

    editBtn.addEventListener('click', () => {
      isEditing = true;
      originalHTML = table.innerHTML;
      wrapper.classList.add('md-table-editing');
      editBtn.style.display = 'none';
      cancelBtn.style.display = '';
      saveBtn.style.display = '';

      const raw = state.currentPage?.rawMarkdown || '';
      const lines = raw.split('\n');
      const { tableStart, tableEnd } = parseTableBoundaries(lines, index);

      wrapper.dataset.tableStart = tableStart;
      wrapper.dataset.tableEnd = tableEnd;

      if (tableStart !== -1 && tableEnd !== -1) {
        const mdLines = lines.slice(tableStart, tableEnd + 1);
        const trs = table.querySelectorAll('tr');
        loadMarkdownIntoTable(mdLines, trs, wrapper);
      } else {
        const cells = table.querySelectorAll('th, td');
        cells.forEach(cell => { cell.contentEditable = 'true'; });
      }

      if (isAutoSum) updateAutoSum();

      const cells = table.querySelectorAll('th, td');
      if (cells.length > 0) cells[0].focus();
    });

    cancelBtn.addEventListener('click', () => {
      isEditing = false;
      wrapper.classList.remove('md-table-editing');
      editBtn.style.display = isReadOnlyDoc ? 'none' : '';
      cancelBtn.style.display = 'none';
      saveBtn.style.display = 'none';
      table.innerHTML = originalHTML;
      const cells = table.querySelectorAll('th, td');
      cells.forEach(cell => { cell.contentEditable = 'false'; });
      if (isAutoSum) updateAutoSum();
    });

    function handleTableTab(e, tbl) {
      const cells = Array.from(tbl.querySelectorAll('th, td'));
      if (cells.length === 0) return;
      const lastCell = cells.at(-1);
      if (e.target === lastCell && !e.shiftKey) {
        e.preventDefault();
        let tbody = tbl.querySelector('tbody');
        if (!tbody) {
          tbody = document.createElement('tbody');
          tbl.appendChild(tbody);
        }
        const tr = document.createElement('tr');
        const cols = tbl.querySelector('tr').children.length;
        for (let i = 0; i < cols; i++) {
          const td = document.createElement('td');
          td.contentEditable = 'true';
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
        if (isAutoSum) updateAutoSum();
        tr.children[0].focus();
      }

      setTimeout(() => {
        const newFocused = document.activeElement;
        if (newFocused && (newFocused.tagName === 'TD' || newFocused.tagName === 'TH') && tbl.contains(newFocused)) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(newFocused);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }, 0);
    }

    function handleTableArrowNav(e, tbl, focused) {
      if (e.key === 'Enter' && e.altKey) {
        e.preventDefault();
        document.execCommand('insertLineBreak'); // NOSONAR
        return;
      }

      const tr = focused.parentElement;
      const allRows = Array.from(tbl.querySelectorAll('tr'));
      const rowIdx = allRows.indexOf(tr);
      const colIdx = Array.from(tr.children).indexOf(focused);

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (rowIdx > 0) {
          const targetRow = allRows[rowIdx - 1];
          if (targetRow.children[colIdx]) {
            targetRow.children[colIdx].focus();
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(targetRow.children[colIdx]);
            selection.removeAllRanges();
            selection.addRange(range);
          }
        }
      } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        if (rowIdx < allRows.length - 1) {
          const targetRow = allRows[rowIdx + 1];
          if (targetRow.children[colIdx]) {
            targetRow.children[colIdx].focus();
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(targetRow.children[colIdx]);
            selection.removeAllRanges();
            selection.addRange(range);
          }
        }
      }
    }

    table.addEventListener('keydown', (e) => {
      if (!isEditing) return;

      const focused = document.activeElement;
      const isCell = focused && (focused.tagName === 'TD' || focused.tagName === 'TH') && table.contains(focused);

      if (e.key === 'Tab') {
        handleTableTab(e, table);
      } else if (isCell && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter')) {
        handleTableArrowNav(e, table, focused);
      } else if (e.key === 'Escape') {
        cancelBtn.click();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        saveBtn.click();
      }
    });

    saveBtn.addEventListener('click', async () => {
      const rows = [];
      const trs = table.querySelectorAll('tr');
      let colCount = 0;
      trs.forEach((tr, rIdx) => {
        const rowData = [];
        const cells = tr.querySelectorAll('th, td');
        cells.forEach(cell => {
          let txt = cell.innerText.trim();
          txt = txt.replaceAll('\n', '<br>');
          txt = txt.replace(/(?<!\\)\|/g, String.raw`\|`);
          rowData.push(txt);
        });
        if (rIdx === 0) colCount = rowData.length;
        rows.push(rowData);
      });

      if (rows.length === 0) return;

      let newMd = '';
      rows.forEach((row, rIdx) => {
        newMd += '| ' + row.join(' | ') + ' |\n';
        if (rIdx === 0) {
          let originalSeparators = [];
          try {
            originalSeparators = JSON.parse(wrapper.dataset.originalSeparators || '[]');
          } catch { /* ignore parse errors */ }
          const sep = [];
          for (let i = 0; i < colCount; i++) {
            sep.push(originalSeparators[i] || '---');
          }
          newMd += '| ' + sep.join(' | ') + ' |\n';
        }
      });

      let raw = state.currentPage?.rawMarkdown;
      if (!raw) return;
      const lines = raw.split('\n');
      const tableStart = Number.parseInt(wrapper.dataset.tableStart, 10);
      const tableEnd = Number.parseInt(wrapper.dataset.tableEnd, 10);

      if (!Number.isNaN(tableStart) && !Number.isNaN(tableEnd) && tableStart !== -1) {
        lines.splice(tableStart, tableEnd - tableStart + 1, newMd.trim());
        const newRaw = lines.join('\n');

        saveBtn.disabled = true;
        cancelBtn.disabled = true;

        try {
          const { callSaveApi } = await import('./note.js');
          await callSaveApi(newRaw, state.currentSlug, false, state.currentLocation);

          state.currentPage.rawMarkdown = newRaw;
          isEditing = false;
          wrapper.classList.remove('md-table-editing');
          editBtn.style.display = isReadOnlyDoc ? 'none' : '';
          cancelBtn.style.display = 'none';
          saveBtn.style.display = 'none';

          // Just triggering an update of the content view
          const { renderNoteContent } = await import('./note.js');
          renderNoteContent(state.currentPage);

        } catch (err) {
          console.error('Failed to save table', err);
          alert('Failed to save table: ' + err.message);
        } finally {
          saveBtn.disabled = false;
          cancelBtn.disabled = false;
        }
      }
    });

    if (activeAutoSumTables.has(autoSumKey)) {
      setAutoSumState(true);
    }
  });
}
