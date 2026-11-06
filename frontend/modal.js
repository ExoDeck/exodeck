/**
 * modal.js — Reusable modal helper
 *
 * Usage:
 *   const values = await openModal({
 *     title: 'Add link',
 *     fields: [
 *       { label: 'URL',   name: 'url',   type: 'url',  placeholder: 'https://…', required: true },
 *       { label: 'Title', name: 'title', type: 'text', placeholder: 'Google',    required: true },
 *     ],
 *   });
 *   if (values) { ... }
 */

import { trapFocus } from './ui-utils.js';

/**
 * @typedef {Object} ModalField
 * @property {string} label
 * @property {string} name
 * @property {'text'|'url'|'textarea'|'date'} [type]
 * @property {string} [placeholder]
 * @property {boolean} [required]
 * @property {number} [rows]
 * @property {function(Event): void} [onBlur]
 */

function createInputEl(field) {
  let input;
  if (field.type === 'textarea') {
    input = document.createElement('textarea');
    input.className = 'modal__input modal__textarea';
    input.rows = field.rows ?? 14;
  } else if (field.type === 'date') {
    input = document.createElement('input');
    input.className = 'modal__input';
    input.type = 'date';
  } else if (field.type === 'static') {
    input = document.createElement('div');
    input.className = 'modal__static-text';
  } else {
    input = document.createElement('input');
    input.className = 'modal__input';
    input.type = field.type ?? 'text';
  }
  return input;
}

function buildField(field) {
  const label = document.createElement('label');
  label.className = 'modal__label';
  label.textContent = field.label;
  label.htmlFor = `_modal_${field.name}`;

  const helpText = field.help || field.placeholder;
  if (helpText) {
    label.title = helpText;
  }

  const input = createInputEl(field);
  input.name = field.name;
  input.id = `_modal_${field.name}`;

  if (field.type !== 'static') {
    if (field.required) input.required = true;
    if (field.value !== undefined) input.value = field.value;
    if (field.readonly) {
      input.readOnly = true;
      input.classList.add('modal__input--readonly');
    }
  } else {
    input.textContent = field.value ?? '';
  }

  if (field.onBlur) input.addEventListener('blur', field.onBlur);

  if (!field.copyable) {
    return { label, input, wrapper: input };
  }

  const wrapper = document.createElement('div');
  wrapper.style.display = 'flex';
  wrapper.style.gap = '8px';
  wrapper.style.alignItems = 'center';
  input.style.flex = '1';
  
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn btn--ghost';
  copyBtn.style.padding = '0 8px';
  copyBtn.title = 'Copy to clipboard';
  copyBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 18px;">content_copy</span>';
  copyBtn.addEventListener('click', () => {
    const textToCopy = field.type === 'static' ? input.textContent : input.value;
    navigator.clipboard.writeText(textToCopy).catch(console.error);
    const orig = copyBtn.innerHTML;
    copyBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 18px; color: #4caf50;">check</span>';
    setTimeout(() => { copyBtn.innerHTML = orig; }, 1500);
  });

  wrapper.appendChild(input);
  wrapper.appendChild(copyBtn);
  return { label, input, wrapper };
}

/**
 * Open a modal dialog with dynamic form fields.
 * @param {{ title: string, fields?: ModalField[], contentNode?: HTMLElement, confirmLabel?: string, isDanger?: boolean, hideCancel?: boolean, dynamicWidth?: boolean }} opts
 * @returns {Promise<Record<string,string>|null>} Resolved with field values on confirm, null on cancel.
 */
export function openModal({ title, fields = [], contentNode = null, confirmLabel = 'Confirm', isDanger = false, hideCancel = false, dynamicWidth = false }) {
  return new Promise(resolve => {
    // Remove any stale modal
    document.getElementById('_dynamicModal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = '_dynamicModal';
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal' + (fields.some(f => f.type === 'textarea') ? ' modal--wide' : '') + (dynamicWidth ? ' modal--dynamic' : '');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const h2 = document.createElement('h2');
    h2.className = 'modal__title';
    h2.textContent = title;
    modal.appendChild(h2);

    const errorEl = document.createElement('p');
    errorEl.className = 'modal__error';
    errorEl.hidden = true;
    modal.appendChild(errorEl);

    if (contentNode) {
      modal.appendChild(contentNode);
    }

    /** @type {Array<HTMLInputElement|HTMLTextAreaElement>} */
    const inputs = [];

    for (const field of fields) {
      const { label, input, wrapper } = buildField(field);
      modal.appendChild(label);
      modal.appendChild(wrapper);
      inputs.push(input);
    }

    const actions = document.createElement('div');
    actions.className = 'modal__actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn--ghost';
    cancelBtn.textContent = 'Cancel';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = isDanger ? 'btn btn--danger' : 'btn btn--primary';
    confirmBtn.textContent = confirmLabel;

    if (!hideCancel) {
      actions.appendChild(cancelBtn);
    }
    actions.appendChild(confirmBtn);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Focus first input or confirm button if no inputs
    if (inputs.length > 0) {
      inputs[0].focus();
    } else {
      confirmBtn.focus();
    }

    const initialValues = Object.fromEntries(inputs.map(i => [i.name, i.value]));
    const isDirty = () => inputs.some(i => i.value !== initialValues[i.name]);

    const requestClose = async result => {
      if (result === null && isDirty()) {
        const discard = await openConfirmModal();
        if (!discard) return;
      }
      overlay.remove();
      resolve(result);
    };

    overlay.addEventListener('mousedown', e => {
      if (e.target === overlay) {
        void requestClose(null);
      }
    });

    const confirm = () => {
      // Validate required fields
      for (const input of inputs) {
        if (input.required && !input.value.trim()) {
          errorEl.textContent = `"${input.name}" is required.`;
          errorEl.hidden = false;
          input.focus();
          return;
        }
      }
      const values = Object.fromEntries(inputs.map(i => [i.name, i.value]));
      void requestClose(values);
    };

    cancelBtn.addEventListener('click', () => { void requestClose(null); });
    confirmBtn.addEventListener('click', confirm);

    overlay.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); void requestClose(null); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); confirm(); }

      if (e.key === 'Tab') {
        trapFocus(e, modal);
      }
    });

    /**
     * @param {MouseEvent} e
     */
    const confirmBtnClickHandler = e => {
      if (e.key === 'Enter') confirm();
    };
    confirmBtn.addEventListener('keydown', confirmBtnClickHandler);
  });
}

/**
 * Open a confirmation dialog for discarding unsaved changes.
 * @param {{ title?: string, message?: string, confirmLabel?: string, cancelLabel?: string, isDanger?: boolean }} [opts]
 * @returns {Promise<boolean>} Resolves true if confirmed (discard), false if canceled (keep editing).
 */
export function openConfirmModal({
  title = 'Discard unsaved changes?',
  message = 'You have unsaved changes. Are you sure you want to discard them?',
  confirmLabel = 'Discard',
  cancelLabel = 'Keep editing',
  isDanger = true,
} = {}) {
  return new Promise(resolve => {
    document.getElementById('_confirmModalOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = '_confirmModalOverlay';
    overlay.className = 'modal-overlay modal-overlay--confirm';

    const modal = document.createElement('div');
    modal.className = 'modal modal--confirm';
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-modal', 'true');

    const h2 = document.createElement('h2');
    h2.className = 'modal__title';
    h2.textContent = title;
    modal.appendChild(h2);

    const msg = document.createElement('p');
    msg.className = 'modal__message';
    msg.textContent = message;
    modal.appendChild(msg);

    const actions = document.createElement('div');
    actions.className = 'modal__actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn--ghost';
    cancelBtn.textContent = cancelLabel;

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = isDanger ? 'btn btn--danger' : 'btn btn--primary';
    confirmBtn.textContent = confirmLabel;

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const previousActive = document.activeElement;

    // Focus Discard button by default per user specification
    confirmBtn.focus();

    const close = (confirmed) => {
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      if (!confirmed && previousActive && typeof previousActive.focus === 'function') {
        previousActive.focus();
      }
      resolve(confirmed);
    };

    overlay.addEventListener('mousedown', e => {
      if (e.target === overlay) {
        close(false);
      }
    });

    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
        close(false);
      } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
        close(document.activeElement !== cancelBtn);
      } else if (e.key === 'Tab') {
        trapFocus(e, modal);
      } else {
        // Prevent background shortcuts from firing while confirmation dialog is active
        e.stopPropagation();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
  });
}
