/**
 * Caption Engine app shell — routes /app, /app/new, /app/p/:id
 */

import { setNavigateHandler, navigate, currentPath } from './app-nav.js';
import { initDashboardChrome, showDashboard } from './dashboard.js';
import { initEditor, showEditor, consumePendingIntoEditor } from './editor.js';
import { mountUserChrome } from './user-session.js';

function parseRoute(pathname = currentPath()) {
  if (pathname === '/app' || pathname === '/app/') {
    return { view: 'dashboard' };
  }
  if (pathname === '/app/new' || pathname === '/app/new/') {
    return { view: 'editor', mode: 'new' };
  }
  const m = pathname.match(/^\/app\/p\/([^/]+)\/?$/);
  if (m) return { view: 'editor', mode: 'project', id: m[1] };
  return { view: 'dashboard' };
}

function setBodyMode(view) {
  document.body.classList.toggle('editor', view === 'editor');
  document.body.classList.toggle('dashboard-page', view === 'dashboard');
}

async function route(pathname = currentPath()) {
  const r = parseRoute(pathname);
  const dash = document.getElementById('view-dashboard');
  const editor = document.getElementById('view-editor');
  if (!dash || !editor) return;

  if (r.view === 'dashboard') {
    editor.hidden = true;
    dash.hidden = false;
    setBodyMode('dashboard');
    showDashboard();
    mountUserChrome();
    return;
  }

  dash.hidden = true;
  editor.hidden = false;
  setBodyMode('editor');
  await showEditor(r);
  mountUserChrome();
}

async function boot() {
  setNavigateHandler((path) => {
    route(path);
  });

  window.addEventListener('popstate', () => {
    route(currentPath());
  });

  initDashboardChrome({ navigate });
  await initEditor({ navigate });

  // If we landed on /app/new with a pending File from same-document navigation,
  // editor will consume it in showEditor. Fresh hard loads of /app/new have no File.
  await route(currentPath());

  // Expose for debugging / external hooks
  window.__ceNavigate = navigate;
  window.__ceConsumePending = consumePendingIntoEditor;
}

document.addEventListener('DOMContentLoaded', () => {
  boot().catch((err) => {
    console.error('App shell failed to boot', err);
  });
});
