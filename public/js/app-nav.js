/**
 * Tiny client router helpers for the /app SPA shell.
 * Keeps File handoffs in memory by avoiding full page reloads.
 */

/** @type {((path: string) => void) | null} */
let onNavigate = null;

/** @param {(path: string) => void} fn */
export function setNavigateHandler(fn) {
  onNavigate = fn;
}

/** @param {string} path */
export function navigate(path) {
  const next = path.startsWith('/') ? path : `/${path}`;
  if (window.location.pathname !== next) {
    window.history.pushState({}, '', next);
  }
  onNavigate?.(next);
}

export function currentPath() {
  return window.location.pathname;
}
