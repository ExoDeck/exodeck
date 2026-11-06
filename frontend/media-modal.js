import { apiFetch, withLocation } from './app.js';
import { openModal } from './modal.js';

export function showImageManagerModal(slug, location, insertCallback) {
  document.getElementById('mediaModal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'mediaModal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal modal--large" role="dialog" aria-modal="true" aria-labelledby="mediaModalTitle">
      <div class="modal__header">
        <h2 class="modal__title" id="mediaModalTitle">Manage Images</h2>
        <button class="btn btn--icon" id="mediaModalClose" aria-label="Close" title="Close">
          <span class="material-symbols-outlined" style="font-size: 20px;" aria-hidden="true">close</span>
        </button>
      </div>
      <div class="media-modal__content">
        <div class="media-modal__dropzone" id="mediaDropzone">
          <p>Drag &amp; drop images here, <strong>click to select</strong>, or <button type="button" id="mediaPasteBtn" class="media-modal__paste-btn">paste from clipboard</button></p>
          <input type="file" id="mediaFileInput" accept="image/*" multiple hidden />
        </div>
        <div class="media-modal__grid" id="mediaGrid">
          <!-- images will be injected here -->
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const closeBtn = overlay.querySelector('#mediaModalClose');
  const dropzone = overlay.querySelector('#mediaDropzone');
  const fileInput = overlay.querySelector('#mediaFileInput');
  const mediaGrid = overlay.querySelector('#mediaGrid');

  const close = () => {
    document.removeEventListener('paste', handlePaste);
    overlay.remove();
  };

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.getElementById('mediaModal')) close(); });

  const loadImages = async () => {
    mediaGrid.innerHTML = '<p class="media-modal__loading">Loading...</p>';
    try {
      const items = await apiFetch(withLocation(`/pages/${slug}/media`, location));
      mediaGrid.innerHTML = '';
      const imageItems = items.filter(item => {
        const ext = item.filename.split('.').pop().toLowerCase();
        return ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext);
      });
      if (imageItems.length === 0) {
        mediaGrid.innerHTML = '<p class="media-modal__empty">No images uploaded yet.</p>';
        return;
      }

      imageItems.forEach(item => {
        const card = document.createElement('div');
        card.className = 'media-modal__card';
        
        const locQuery = location ? `?location=${encodeURIComponent(location)}` : '';
        const imgUrl = `/api/v1/media/${slug}/${item.filename}${locQuery}`;
        
        const img = document.createElement('img');
        img.src = imgUrl;
        img.alt = item.filename;
        img.className = 'media-modal__img';
        img.loading = 'lazy';

        const info = document.createElement('div');
        info.className = 'media-modal__info';
        
        const name = document.createElement('div');
        name.className = 'media-modal__name';
        name.textContent = item.filename;
        name.title = item.filename;

        const actions = document.createElement('div');
        actions.className = 'media-modal__actions';

        const extIdx = item.filename.lastIndexOf('.');
        const nameWithoutExt = extIdx > 0 ? item.filename.substring(0, extIdx) : item.filename;

        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn btn--icon';
        copyBtn.title = 'Copy Markdown';
        copyBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 18px;" aria-hidden="true">content_copy</span>`;
        copyBtn.addEventListener('click', async () => {
          const md = `![${nameWithoutExt}](_IMG_/${encodeURIComponent(item.filename)})`;
          if (insertCallback) {
             insertCallback(md);
             close();
          } else {
            try {
              await navigator.clipboard.writeText(md);
            } catch {
              // clipboard API unavailable
            }
          }
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn btn--icon btn--danger';
        deleteBtn.title = 'Delete';
        deleteBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 18px;" aria-hidden="true">delete</span>`;
        deleteBtn.addEventListener('click', async () => {
          const result = await openModal({
            title: `Delete ${item.filename}?`,
            fields: [],
            confirmLabel: 'Delete',
            isDanger: true
          });
          if (result === null) return;
          try {
            await apiFetch(withLocation(`/pages/${slug}/media/${item.filename}`, location), { method: 'DELETE' });
            loadImages();
          } catch (e) {
            alert('Error deleting file: ' + e.message);
          }
        });

        actions.appendChild(copyBtn);
        actions.appendChild(deleteBtn);
        info.appendChild(name);
        info.appendChild(actions);
        card.appendChild(img);
        card.appendChild(info);

        mediaGrid.appendChild(card);
      });
    } catch (e) {
      mediaGrid.innerHTML = `<p class="media-modal__error">Failed to load images: ${e.message}</p>`;
    }
  };

  loadImages();

  dropzone.addEventListener('click', () => fileInput.click());

  dropzone.addEventListener('dragover', e => {
    e.preventDefault();
    dropzone.classList.add('media-modal__dropzone--active');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('media-modal__dropzone--active');
  });

  dropzone.addEventListener('drop', async e => {
    e.preventDefault();
    dropzone.classList.remove('media-modal__dropzone--active');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await uploadFiles(e.dataTransfer.files);
    }
  });

  fileInput.addEventListener('change', async () => {
    if (fileInput.files.length > 0) {
      await uploadFiles(fileInput.files);
      fileInput.value = ''; // reset
    }
  });

  const pasteBtn = overlay.querySelector('#mediaPasteBtn');
  pasteBtn.addEventListener('click', async e => {
    e.stopPropagation();
    try {
      const clipItems = await navigator.clipboard.read();
      for (const item of clipItems) {
        const imageType = item.types.find(t => t.startsWith('image/'));
        if (imageType) {
          const blob = await item.getType(imageType);
          const ext = imageType.split('/')[1] || 'png';
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const file = new File([blob], `clipboard-${timestamp}.${ext}`, { type: imageType });
          await uploadFiles([file]);
          return;
        }
      }
      alert('No image found in clipboard.');
    } catch (err) {
      alert('Could not read clipboard: ' + err.message);
    }
  });

  document.addEventListener('paste', handlePaste);

  async function handlePaste(e) {
    if (!document.getElementById('mediaModal')) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageItems = Array.from(items).filter(i => i.type.startsWith('image/'));
    if (imageItems.length === 0) return;
    e.preventDefault();
    const files = imageItems.map(i => {
      const blob = i.getAsFile();
      const ext = i.type.split('/')[1] || 'png';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      return new File([blob], `clipboard-${timestamp}.${ext}`, { type: i.type });
    });
    await uploadFiles(files);
  }

  async function uploadFiles(files) {
    dropzone.classList.add('media-modal__dropzone--uploading');
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const formData = new FormData();
      formData.append('file', file);
      
      try {
        const response = await fetch(withLocation(`/api/v1/pages/${slug}/media`, location), {
          method: 'POST',
          body: formData
        });
        if (!response.ok) {
          console.error(await response.text());
        }
      } catch (e) {
        console.error(e);
      }
    }
    dropzone.classList.remove('media-modal__dropzone--uploading');
    loadImages();
  }
}
