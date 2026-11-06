// add-picker.js — Lightweight sequential picker overlay

/**
 * Present a small popup panel of labelled choices and resolve with the
 * selected value.  Returns null if the user cancels (Escape or backdrop).
 *
 * @param {string} title
 * @param {Array<{label:string, value:*, description?:string}>} options
 * @param {*} [preselect]  Optional value to pre-highlight (matched against option.value)
 * @returns {Promise<*|null>}
 */
export function openPicker(title, options, preselect) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'add-picker';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);

    const backdrop = document.createElement('div');
    backdrop.className = 'add-picker__backdrop';

    const panel = document.createElement('div');
    panel.className = 'add-picker__panel';
    panel.setAttribute('tabindex', '-1');

    const titleEl = document.createElement('div');
    titleEl.className = 'add-picker__title';
    titleEl.textContent = title;

    const list = document.createElement('ul');
    list.className = 'add-picker__list';
    list.setAttribute('role', 'listbox');

    const preselectedIndex = preselect !== undefined
      ? options.findIndex(o => o.value === preselect)
      : -1;
    let focusedIndex = Math.max(preselectedIndex, 0);

    const buttons = options.map((opt, i) => {
      const li = document.createElement('li');
      li.dataset.index = String(i);

      if (opt.isDivider) {
        li.className = 'add-picker__separator';
        li.style.height = '1px';
        li.style.backgroundColor = 'var(--color-border)';
        li.style.margin = 'var(--space-xs) 0';
        li.setAttribute('role', 'separator');
        list.appendChild(li);
        return li;
      }

      li.className = 'add-picker__item';
      li.setAttribute('role', 'option');

      const topRow = document.createElement('div');
      topRow.style.display = 'flex';
      topRow.style.alignItems = 'center';

      if (opt.icon) {
        const iconEl = document.createElement('span');
        iconEl.className = 'add-picker__item-icon material-symbols-outlined';
        iconEl.setAttribute('aria-hidden', 'true');
        iconEl.style.fontSize = '18px';
        iconEl.style.marginRight = '8px';
        iconEl.textContent = opt.icon;
        topRow.appendChild(iconEl);
      }

      const labelEl = document.createElement('span');
      labelEl.className = 'add-picker__item-label';
      labelEl.textContent = opt.label;
      topRow.appendChild(labelEl);

      li.appendChild(topRow);

      if (opt.description) {
        const descEl = document.createElement('span');
        descEl.className = 'add-picker__item-desc';
        descEl.textContent = opt.description;
        li.appendChild(descEl);
      }

      li.addEventListener('click', () => pick(i));
      li.addEventListener('mouseenter', () => setFocus(i));
      list.appendChild(li);
      return li;
    });

    panel.appendChild(titleEl);
    panel.appendChild(list);
    overlay.appendChild(backdrop);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    function setFocus(i) {
      if (buttons[focusedIndex] && !options[focusedIndex].isDivider) {
        buttons[focusedIndex].classList.remove('add-picker__item--focused');
      }
      
      let step = i > focusedIndex ? 1 : -1;
      // Handle wrap around safely
      if (Math.abs(i - focusedIndex) > 1 && i === options.length - 1) step = -1;
      if (Math.abs(i - focusedIndex) > 1 && i === 0) step = 1;
      
      focusedIndex = ((i % options.length) + options.length) % options.length;
      
      while (options[focusedIndex]?.isDivider) {
        focusedIndex = (((focusedIndex + step) % options.length) + options.length) % options.length;
      }

      if (buttons[focusedIndex]) {
        buttons[focusedIndex].classList.add('add-picker__item--focused');
        buttons[focusedIndex].scrollIntoView({ block: 'nearest' });
      }
    }

    function pick(i) {
      cleanup();
      resolve(options[i].value);
    }

    function cancel() {
      cleanup();
      resolve(null);
    }

    function cleanup() {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocus(focusedIndex + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocus(focusedIndex - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        pick(focusedIndex);
      }
    }

    backdrop.addEventListener('click', cancel);
    document.addEventListener('keydown', onKeyDown);

    // Initial highlight + focus so keyboard events are captured immediately
    setFocus(focusedIndex);
    panel.focus();
  });
}
