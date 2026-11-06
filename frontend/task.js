// task.js — Task items component
import { state, apiFetch, withLocation } from './app.js';
import { renderPage } from './content.js';
import { renderMarkdownToElement } from './markdown-utils.js';
import { openConfirmModal } from './modal.js';
import { createWindowFrame, trapFocus } from './ui-utils.js';

/**
 * Decode a Base64-encoded UTF-8 string.
 * @param {string} base64
 * @returns {string}
 */
function decodeText(base64) {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.codePointAt(0)));
}

/**
 * Encode a UTF-8 string to Base64.
 * @param {string} str
 * @returns {string}
 */
function encodeText(str) {
  const bytes = new TextEncoder().encode(str ?? '');
  return btoa(Array.from(bytes, b => String.fromCodePoint(b)).join(''));
}

/**
 * Compute the due-date CSS modifier class for a task item.
 * Returns '' when done, or when no due date.
 * @param {object} item
 * @returns {''|'item--task--overdue'|'item--task--due-soon'}
 */
function dueDateClass(item) {
  if (item.task_checked || !item.task_due_date) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const due = new Date(item.task_due_date + 'T00:00:00');
  if (due <= today) return 'item--task--overdue';
  if (due.getTime() === tomorrow.getTime()) return 'item--task--due-soon';
  return '';
}

/**
 * Format an ISO date string for display.
 * @param {string} isoDate
 * @returns {string}
 */
function formatDate(isoDate) {
  if (!isoDate) return '';
  // Try to parse as date or datetime
  const d = new Date(isoDate.includes('T') ? isoDate : isoDate + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Task window (view / edit)
// ---------------------------------------------------------------------------

/**
 * Open a floating panel viewer/editor for a task item.
 *
 * @param {object}         item
 * @param {number}         itemIndex
 * @param {number}         groupIndex
 * @param {string}         slug
 * @param {string|null}    location
 * @param {'view'|'edit'}  initialMode
 */
export function openTaskWindow(item, itemIndex, groupIndex, slug, location, initialMode = 'view') {
  document.getElementById('_taskWindow')?.remove();

  let currentItem = { ...item };

  const {
    overlay,
    win,
    titleEl,
    errorEl,
    bodyDiv,
    closeHeaderBtn,
    restoreFocus,
  } = createWindowFrame({
    id: '_taskWindow',
    onClose: closeWindow,
  });

  // View elements
  const viewDiv = document.createElement('div');
  viewDiv.className = 'note-window__view';

  const viewMeta = document.createElement('div');
  viewMeta.className = 'task-window__meta';

  const viewDescription = document.createElement('div');
  viewDescription.className = 'item__note-body task-window__description';

  viewDiv.appendChild(viewMeta);
  viewDiv.appendChild(viewDescription);

  // Edit elements
  const editDiv = document.createElement('div');
  editDiv.className = 'note-window__edit';
  editDiv.hidden = true;

  const titleLabel = document.createElement('label');
  titleLabel.className = 'modal__label';
  titleLabel.textContent = 'Title';
  titleLabel.htmlFor = '_tw_title';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.id = '_tw_title';
  titleInput.className = 'modal__input';
  titleInput.required = true;

  const descLabel = document.createElement('label');
  descLabel.className = 'modal__label';
  descLabel.textContent = 'Description (Markdown, optional)';
  descLabel.htmlFor = '_tw_desc';

  const descArea = document.createElement('textarea');
  descArea.id = '_tw_desc';
  descArea.className = 'modal__input modal__textarea';
  descArea.rows = 10;

  const dueDateLabel = document.createElement('label');
  dueDateLabel.className = 'modal__label';
  dueDateLabel.textContent = 'Due date (optional)';
  dueDateLabel.htmlFor = '_tw_due';

  const dueDateInput = document.createElement('input');
  dueDateInput.type = 'date';
  dueDateInput.id = '_tw_due';
  dueDateInput.className = 'modal__input';

  const completedLabel = document.createElement('label');
  completedLabel.className = 'task-window__completed-label';
  completedLabel.htmlFor = '_tw_completed';

  const completedInput = document.createElement('input');
  completedInput.type = 'checkbox';
  completedInput.id = '_tw_completed';

  const completedSpan = document.createElement('span');
  completedSpan.textContent = 'Completed';

  completedLabel.appendChild(completedInput);
  completedLabel.appendChild(completedSpan);

  editDiv.appendChild(titleLabel);
  editDiv.appendChild(titleInput);
  editDiv.appendChild(descLabel);
  editDiv.appendChild(descArea);
  editDiv.appendChild(dueDateLabel);
  editDiv.appendChild(dueDateInput);
  editDiv.appendChild(completedLabel);

  const metaDiv = document.createElement('div');
  metaDiv.style.marginTop = '1rem';
  metaDiv.style.display = 'flex';
  metaDiv.style.gap = '1rem';
  metaDiv.style.fontSize = '0.85em';
  metaDiv.style.color = 'var(--text-color)';
  metaDiv.style.opacity = '0.7';
  editDiv.appendChild(metaDiv);

  bodyDiv.appendChild(viewDiv);
  bodyDiv.appendChild(editDiv);

  // -- Actions --
  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'note-window__actions';

  const primaryBtn = document.createElement('button');
  primaryBtn.type = 'button';
  primaryBtn.className = 'btn btn--primary';

  const secondaryBtn = document.createElement('button');
  secondaryBtn.type = 'button';
  secondaryBtn.className = 'btn btn--ghost';

  actionsDiv.appendChild(secondaryBtn);
  actionsDiv.appendChild(primaryBtn);

  // -- Assemble --
  win.appendChild(actionsDiv);
  document.body.appendChild(overlay);

  // ---- Mode helpers ----

  function switchToView(updatedItem) {
    if (updatedItem) currentItem = updatedItem;
    titleEl.textContent = currentItem.title;

    // Meta row: due date + created date
    viewMeta.innerHTML = '';
    if (currentItem.task_checked) {
      const completedPill = document.createElement('span');
      completedPill.className = 'task-window__meta-pill task-window__meta-pill--completed';
      completedPill.textContent = 'Completed';
      viewMeta.appendChild(completedPill);
    }
    if (currentItem.task_due_date) {
      const duePill = document.createElement('span');
      duePill.className = 'task-window__meta-pill';
      duePill.textContent = `Due: ${formatDate(currentItem.task_due_date)}`;
      const dc = dueDateClass(currentItem);
      if (dc === 'item--task--overdue') duePill.classList.add('task-window__meta-pill--overdue');
      if (dc === 'item--task--due-soon') duePill.classList.add('task-window__meta-pill--due-soon');
      viewMeta.appendChild(duePill);
    }
    if (currentItem.task_created) {
      const createdPill = document.createElement('span');
      createdPill.className = 'task-window__meta-pill task-window__meta-pill--muted';
      createdPill.textContent = `Created: ${formatDate(currentItem.task_created)}`;
      viewMeta.appendChild(createdPill);
    }

    // Description
    if (currentItem.text) {
      renderMarkdownToElement(decodeText(currentItem.text), viewDescription);
      viewDescription.hidden = false;
    } else {
      viewDescription.innerHTML = '';
      viewDescription.hidden = true;
    }

    viewDiv.hidden = false;
    editDiv.hidden = true;
    errorEl.hidden = true;
    closeHeaderBtn.hidden = false;
    primaryBtn.textContent = 'Edit';
    secondaryBtn.textContent = 'Close';
    primaryBtn.onclick = switchToEdit;
    secondaryBtn.onclick = closeWindow;
    primaryBtn.focus();
  }

  function switchToEdit() {
    titleInput.value = currentItem.title;
    descArea.value = currentItem.text ? decodeText(currentItem.text) : '';
    dueDateInput.value = currentItem.task_due_date ?? '';
    completedInput.checked = Boolean(currentItem.task_checked);

    metaDiv.innerHTML = '';
    const formatDateTime = (iso) => iso ? new Date(iso).toLocaleString() : '';
    if (currentItem.created_at) {
      metaDiv.innerHTML += `<div><strong>Created At:</strong> ${formatDateTime(currentItem.created_at)}</div>`;
    }
    if (currentItem.modified_at) {
      metaDiv.innerHTML += `<div><strong>Modified At:</strong> ${formatDateTime(currentItem.modified_at)}</div>`;
    }

    viewDiv.hidden = true;
    editDiv.hidden = false;
    errorEl.hidden = true;
    closeHeaderBtn.hidden = true;
    primaryBtn.textContent = 'Save';
    secondaryBtn.textContent = 'Cancel';
    primaryBtn.onclick = saveTask;
    secondaryBtn.onclick = () => { void requestSwitchToView(); };
    titleInput.focus();
  }

  const isEditDirty = () => {
    const origTitle = currentItem.title ?? '';
    const origDesc = currentItem.text ? decodeText(currentItem.text) : '';
    const origDue = currentItem.task_due_date ?? '';
    const origCompleted = Boolean(currentItem.task_checked);
    return titleInput.value !== origTitle ||
      descArea.value !== origDesc ||
      dueDateInput.value !== origDue ||
      completedInput.checked !== origCompleted;
  };

  async function requestSwitchToView() {
    if (isEditDirty()) {
      const discard = await openConfirmModal();
      if (!discard) return;
    }
    switchToView();
  }

  async function saveTask() {
    const newTitle = titleInput.value.trim();
    if (!newTitle) {
      errorEl.textContent = '"Title" is required.';
      errorEl.hidden = false;
      titleInput.focus();
      return;
    }
    errorEl.hidden = true;
    primaryBtn.disabled = true;

    const encoded = descArea.value.trim() ? encodeText(descArea.value) : undefined;
    const updated = {
      title: newTitle,
      task_checked: completedInput.checked,
      task_created: currentItem.task_created,
      ...(encoded !== undefined && { text: encoded }),
      ...(dueDateInput.value && { task_due_date: dueDateInput.value }),
    };

      await apiFetch(withLocation(`/pages/${slug}/groups/${groupIndex}/items/${itemIndex}`, location), {
        method: 'PUT',
        body: JSON.stringify(updated),
      });
      state.currentPage = await apiFetch(withLocation(`/pages/${slug}`, location));

    renderPage(state.currentPage);
    primaryBtn.disabled = false;
    switchToView(updated);
  }

  function closeWindow() {
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
    restoreFocus();
  }

  function onKeyDown(e) {
    if (document.getElementById('_confirmModalOverlay')) return;
    if (e.key === 'Tab') {
      trapFocus(e, win);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (editDiv.hidden) {
        closeWindow();
      } else {
        void requestSwitchToView();
      }
    }
  }

  document.addEventListener('keydown', onKeyDown);

  if (initialMode === 'edit') {
    switchToEdit();
  } else {
    switchToView();
  }
}

/**
 * Open the "Add Task" modal.
 * Calls `onSave(values)` each time the user confirms.
 * When "Add more" is checked the modal resets and stays open; otherwise it closes.
 *
 * @param {function({title:string, description:string, due_date:string}): Promise<void>} onSave
 */
export function openAddTaskModal(onSave) {
  document.getElementById('_addTaskModal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = '_addTaskModal';
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal modal--wide';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const h2 = document.createElement('h2');
  h2.className = 'modal__title';
  h2.textContent = 'Add Task';

  const errorEl = document.createElement('p');
  errorEl.className = 'modal__error';
  errorEl.hidden = true;

  const titleLabel = document.createElement('label');
  titleLabel.className = 'modal__label';
  titleLabel.textContent = 'Title';
  titleLabel.htmlFor = '_at_title';
  titleLabel.title = 'Task title or summary';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.id = '_at_title';
  titleInput.className = 'modal__input';

  const descLabel = document.createElement('label');
  descLabel.className = 'modal__label';
  descLabel.textContent = 'Description (Markdown, optional)';
  descLabel.htmlFor = '_at_desc';
  descLabel.title = 'Markdown formatted details and notes (optional)';
  const descArea = document.createElement('textarea');
  descArea.id = '_at_desc';
  descArea.className = 'modal__input modal__textarea';
  descArea.rows = 8;

  const dueDateLabel = document.createElement('label');
  dueDateLabel.className = 'modal__label';
  dueDateLabel.textContent = 'Due date (optional)';
  dueDateLabel.htmlFor = '_at_due';
  const dueDateInput = document.createElement('input');
  dueDateInput.type = 'date';
  dueDateInput.id = '_at_due';
  dueDateInput.className = 'modal__input';

  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'modal__actions';

  const addMoreLabel = document.createElement('label');
  addMoreLabel.className = 'modal__add-more';
  const addMoreCb = document.createElement('input');
  addMoreCb.type = 'checkbox';
  const addMoreSpan = document.createElement('span');
  addMoreSpan.textContent = 'Add more';
  addMoreLabel.appendChild(addMoreCb);
  addMoreLabel.appendChild(addMoreSpan);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn--ghost';
  cancelBtn.textContent = 'Cancel';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn--primary';
  saveBtn.textContent = 'Add';

  actionsDiv.appendChild(addMoreLabel);
  actionsDiv.appendChild(cancelBtn);
  actionsDiv.appendChild(saveBtn);

  modal.appendChild(h2);
  modal.appendChild(errorEl);
  modal.appendChild(titleLabel);
  modal.appendChild(titleInput);
  modal.appendChild(descLabel);
  modal.appendChild(descArea);
  modal.appendChild(dueDateLabel);
  modal.appendChild(dueDateInput);
  modal.appendChild(actionsDiv);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  titleInput.focus();

  function resetFields() {
    titleInput.value = '';
    descArea.value = '';
    dueDateInput.value = '';
    errorEl.hidden = true;
    titleInput.focus();
  }

  function close() {
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
  }

  async function handleSave() {
    if (document.getElementById('_confirmModalOverlay')) return;
    const title = titleInput.value.trim();
    if (!title) {
      errorEl.textContent = '"Title" is required.';
      errorEl.hidden = false;
      titleInput.focus();
      return;
    }
    errorEl.hidden = true;
    saveBtn.disabled = true;
    await onSave({ title, description: descArea.value, due_date: dueDateInput.value });
    saveBtn.disabled = false;
    if (addMoreCb.checked) {
      resetFields();
    } else {
      close();
    }
  }

  const isDirty = () => Boolean(titleInput.value.trim() || descArea.value.trim() || dueDateInput.value);

  async function requestClose() {
    if (isDirty()) {
      const discard = await openConfirmModal();
      if (!discard) {
        titleInput.focus();
        return;
      }
    }
    close();
  }

  cancelBtn.addEventListener('click', () => { void requestClose(); });
  saveBtn.addEventListener('click', () => handleSave().catch(console.error));
  overlay.addEventListener('click', e => { if (e.target === overlay) void requestClose(); });

  function onKeyDown(e) {
    if (document.getElementById('_confirmModalOverlay')) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      void requestClose();
      return;
    }
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      handleSave().catch(console.error);
      return;
    }
    if (e.key === 'Tab') {
      trapFocus(e, modal);
    }
  }
  document.addEventListener('keydown', onKeyDown);
}

// ---------------------------------------------------------------------------
// renderTaskItem
// ---------------------------------------------------------------------------

/**
 * Build a `<li class="item item--task">` element.
 *
 * @param {object}      item
 * @param {number}      itemIndex
 * @param {number}      groupIndex
 * @param {string}      slug
 * @param {string|null} location
 * @returns {HTMLLIElement}
 */
export function renderTaskItem(item, itemIndex, groupIndex, slug, location = null) {
  const li = document.createElement('li');
  const dc = dueDateClass(item);
  li.className = `item item--task${item.task_checked ? ' item--task--done' : ''}${dc ? ' ' + dc : ''}`;

  // -- Checkbox --
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'item__task-checkbox';
  checkbox.checked = !!item.task_checked;
  checkbox.setAttribute('aria-label', 'Mark as done');

  checkbox.addEventListener('change', async () => {
    const updated = { ...item, task_checked: checkbox.checked };
      await apiFetch(withLocation(`/pages/${slug}/groups/${groupIndex}/items/${itemIndex}`, location), {
        method: 'PUT',
        body: JSON.stringify(updated),
      });
      state.currentPage = await apiFetch(withLocation(`/pages/${slug}`, location));

    renderPage(state.currentPage);
  });

  // -- Title button --
  const titleBtn = document.createElement('button');
  titleBtn.type = 'button';
  titleBtn.className = 'item__task-title';
  titleBtn.textContent = item.title;
  titleBtn.addEventListener('click', () => openTaskWindow(item, itemIndex, groupIndex, slug, location, 'view'));

  // -- Edit button (hover-visible) --
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'item__task-edit';
  editBtn.setAttribute('aria-label', 'Edit Task');
  editBtn.title = 'Edit Task';
  editBtn.textContent = '✎';
  editBtn.addEventListener('click', e => {
    e.stopPropagation();
    openTaskWindow(item, itemIndex, groupIndex, slug, location, 'edit');
  });

  const iconWrapper = document.createElement('span');
  iconWrapper.className = 'item__type-icon';
  iconWrapper.appendChild(checkbox);

  const header = document.createElement('div');
  header.className = 'item__task-header';
  header.appendChild(iconWrapper);
  header.appendChild(titleBtn);
  header.appendChild(editBtn);

  li.appendChild(header);

  return li;
}
