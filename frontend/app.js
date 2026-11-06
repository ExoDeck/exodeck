/**
 * app.js — Bootstrap module
 * Detects operating mode, initialises global state, and kicks off the app.
 */

import { initSidebar, loadPage } from './sidebar.js';
import { initTheme } from './theme.js';
import { initKeyNav } from './keyboard-nav.js';
import { initOutlineNav } from './outline-nav.js';
import { initWorkspaceNav } from './workspace-nav.js';
import { loadConfig, applyConfig, openConfigModal } from './config.js';
import { loadMarkdownDependencies } from './markdown-utils.js';
import { updateVaultBadge } from './vault.js';
import { initNotifications, updateNotificationBadge, updateAllTasks } from './notifications.js';
import { parseApiError, showBackendDisconnectedModal, hideBackendDisconnectedModal } from './ui-utils.js';

export { parseApiError, showBackendDisconnectedModal, hideBackendDisconnectedModal };
export const API_BASE = '/api/v1';

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
export const state = {
  /** Array of page-metadata objects { slug, page_name, hidden } */
  pages: [],

  /** Configured backend data locations (names only) */
  locations: [],

  /** Full Page object currently displayed */
  currentPage: null,

  /** Slug of the currently displayed page */
  currentSlug: null,

  /** Name of the currently selected data location */
  currentLocation: null,

  /** Type of the active page/view ('grid', 'note', 'whiteboard', 'bpmn', or null) */
  activePageType: null,

  /** Active configuration (set by config.js) */
  config: null,

  /** Sync status by location name, populated by bootstrap { [location]: {enabled, uncommitted, output} } */
  syncStatus: {},

  /** Vault status by location name, populated by bootstrap or vault.js { [location]: {configured, unlocked, has_legacy_key, expires_in_seconds} } */
  vaultStatus: {},
};

/**
 * Append the active location to an API path.
 * @param {string} path
 * @param {string|null} [location]
 * @returns {string}
 */
export function withLocation(path, location = state.currentLocation) {
  if (!location) return path;
  const [pathname, queryString = ''] = path.split('?');
  const params = new URLSearchParams(queryString);
  if (!params.has('location')) params.set('location', location);
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

/**
 * Thin fetch wrapper for backend mode.
 * @param {string} path  Path relative to API_BASE (e.g. '/pages').
 * @param {RequestInit} [options]
 * @returns {Promise<any>} Parsed JSON response.
 * @throws {Error} On non-2xx HTTP status.
 */
export async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  let res;
  try {
    res = await fetch(API_BASE + path, { ...options, headers });
  } catch (err) {
    showBackendDisconnectedModal();
    throw err;
  }

  if (res.status === 502 || res.status === 503 || res.status === 504) {
    showBackendDisconnectedModal();
  } else if (res.ok) {
    hideBackendDisconnectedModal();
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    const message = parseApiError(text, `API ${res.status}: ${res.statusText}`);
    const err = new Error(message);
    err.status = res.status;
    err.rawResponse = text;
    throw err;
  }

  const method = (options.method || 'GET').toUpperCase();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !path.startsWith('/sync')) {
    document.dispatchEvent(new CustomEvent('exodeck:api-mutation'));
  }

  // 204 No Content — return null
  if (res.status === 204) return null;

  return res.json();
}

// ---------------------------------------------------------------------------
// Disk-mode helpers
// ---------------------------------------------------------------------------

/**
 * Shows a styled confirmation modal and returns a Promise resolving to a boolean.
 * @param {string} title
 * @param {string} message
 * @returns {Promise<boolean>}
 */
export function showConfirmModal(title, message) {
  return window.confirm(`${title}\n\n${message}`);
}

export function showStyledConfirmModal(title, message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <h2 class="modal__title">${title}</h2>
      <div style="margin-bottom: var(--space-xl); color: var(--color-text-muted);">${message}</div>
      <div class="modal__actions">
        <button class="btn btn--ghost" id="_confirm_cancel">Cancel</button>
        <button class="btn btn--primary" id="_confirm_ok">Confirm</button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const cleanup = () => overlay.remove();

    modal.querySelector('#_confirm_cancel').addEventListener('click', () => {
      cleanup();
      resolve(false);
    });

    modal.querySelector('#_confirm_ok').addEventListener('click', () => {
      cleanup();
      resolve(true);
    });
  });
}
// ---------------------------------------------------------------------------

/**
 * Refresh pages and locations in state.
 */
export async function refreshPages() {
  const data = await apiFetch('/bootstrap');
  state.locations = data.locations;
  if (data.vault_status) {
    state.vaultStatus = data.vault_status;
  }
  if (data.due_tasks) {
    updateNotificationBadge(data.due_tasks);
  }
  if (data.all_tasks) {
    updateAllTasks(data.all_tasks);
  }
  state.pages = [...data.locations, 'docs'].flatMap(name =>
    (data.pages[name] ?? [])
      .filter(p => !p.slug?.startsWith('.') && !p.page_name?.startsWith('.') && !p.file_name?.startsWith('.'))
      .map(p => ({ ...p, location: p.location ?? name }))
  );
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  // Initialise UI modules
  initTheme();
  initKeyNav();
  initOutlineNav();
  initWorkspaceNav();
  initNotifications();

  // Load config and pages list in parallel
  try {
    const [cfg] = await Promise.all([
      loadConfig(),
      refreshPages().catch(err => {
        console.error('[ExoDeck] Failed to load page list:', err);
        state.pages = [];
        showBackendDisconnectedModal();
      }),
    ]);
    applyConfig(cfg);
  } catch (err) {
    console.warn('[ExoDeck] Could not load config:', err);
    showBackendDisconnectedModal();
  }

  // Render sidebar (populates nav from state.pages)
  initSidebar();

  // Handle browser back/forward navigation
  window.addEventListener('popstate', (event) => {
    if (event.state?.slug) {
      loadPage(event.state.slug, event.state.location ?? null, 'none').catch(console.error);
    }
  });

  // Deep-link: navigate to the page indicated by the current URL on first load
  {
    const segments = window.location.pathname.split('/').filter(Boolean).map(s => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
    if (segments.length === 2) {
      const [loc, slugFromUrl] = segments;
      const match = state.pages.find(p => p.location === loc && p.slug === slugFromUrl);
      if (match) {
        loadPage(match.slug, match.location, 'replace').catch(console.error);
      }
    } else if (segments.length === 1) {
      const [slugOrLoc] = segments;
      if (state.locations.includes(slugOrLoc)) {
        const first = state.pages.find(p => p.location === slugOrLoc && !p.hidden);
        if (first) {
          loadPage(first.slug, first.location, 'replace').catch(console.error);
        }
      } else {
        const match = state.pages.find(p => p.slug === slugOrLoc);
        if (match) {
          loadPage(match.slug, match.location ?? null, 'replace').catch(console.error);
        }
      }
    }
  }

  // Wire config button
  document.getElementById('configBtn')?.addEventListener('click', openConfigModal);

  // Vault status badge updates
  document.addEventListener('exodeck:page-loaded', () => {
    void updateVaultBadge();
  });
  void updateVaultBadge();

  // Preload vendor libs in the background so note pages open instantly
  loadMarkdownDependencies().catch(() => {});
});
