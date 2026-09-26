/**
 * Projects dashboard at /app
 */

import {
  listProjects,
  projectsStats,
  formatDuration,
  formatRelative,
  aspectLabel,
} from './projects-store.js';
import { setPendingMedia } from './pending-media.js';
import { mountUserChrome, userMenuButtonHtml } from './user-session.js';

const el = (id) => document.getElementById(id);

/** @type {(path: string) => void} */
let navigateFn = (path) => {
  window.location.href = path;
};

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = el('dash-theme-toggle');
  if (btn) {
    btn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
    const knob = btn.querySelector('.knob');
    if (knob) knob.textContent = theme === 'light' ? '☀️' : '🌙';
  }
}

function renderStats() {
  const s = projectsStats();
  const projects = el('stat-projects');
  const footage = el('stat-footage');
  const caption = el('stat-caption-left');
  const plan = el('stat-plan');
  if (projects) projects.textContent = String(s.count);
  if (footage) footage.textContent = formatDuration(s.footageSec);
  if (caption) caption.textContent = `${s.captionMinutesLeft} min`;
  if (plan) plan.textContent = s.plan;
}

function renderProjects() {
  const grid = el('projects-grid');
  const list = listProjects();
  if (!grid) return;

  if (list.length === 0) {
    grid.innerHTML = `
      <div class="projects-empty" style="grid-column:1/-1">
        No projects on this device yet. Drop a video above to start your first caption job.
      </div>`;
    return;
  }

  grid.innerHTML = list.map((p) => {
    const aspectClass = p.aspect === 'landscape' || p.aspect === 'original'
      ? 'landscape'
      : p.aspect === 'square' ? 'square' : '';
    return `
      <button type="button" class="project-card" data-id="${p.id}">
        <div class="project-thumb ${aspectClass}" style="background:${p.posterColor || '#0f766e'}">
          <div class="shine"></div>
          <span class="pill">${aspectLabel(p.aspect)}</span>
        </div>
        <div class="project-meta">
          <strong title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</strong>
          <div class="project-badges">
            <span>${formatDuration(p.durationSec)}</span>
            <span>${aspectLabel(p.aspect)}</span>
            <span>${formatRelative(p.updatedAt)}</span>
          </div>
        </div>
      </button>`;
  }).join('');

  grid.querySelectorAll('.project-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-id');
      if (id) navigateFn(`/app/p/${id}`);
    });
  });
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function acceptFile(file) {
  if (!file) return;
  // In-memory File only — never written to localStorage / IndexedDB / Cache.
  setPendingMedia(file);
  navigateFn('/app/new');
}

function wireDropzone() {
  const zone = el('dash-dropzone');
  const input = el('dash-file-input');
  if (!zone || !input || zone.dataset.wired === '1') return;
  zone.dataset.wired = '1';

  const openPicker = () => input.click();
  el('btn-new-project')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openPicker();
  });
  zone.addEventListener('click', openPicker);
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  });
  input.addEventListener('change', () => {
    const file = input.files?.[0] || null;
    input.value = '';
    acceptFile(file);
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', (e) => {
    if (e.target === zone) zone.classList.remove('dragover');
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    acceptFile(e.dataTransfer?.files?.[0] || null);
  });
}

export function showDashboard() {
  const dash = el('view-dashboard');
  const editor = el('view-editor');
  if (dash) dash.hidden = false;
  if (editor) editor.hidden = true;
  document.title = 'Caption Engine — Projects';
  renderStats();
  renderProjects();
  mountUserChrome();
}

/** @param {{ navigate?: (path: string) => void }} [opts] */
export function initDashboardChrome(opts = {}) {
  if (typeof opts.navigate === 'function') navigateFn = opts.navigate;

  const slot = el('dash-user-slot');
  if (slot && !slot.dataset.ready) {
    slot.innerHTML = userMenuButtonHtml();
    slot.dataset.ready = '1';
  }
  applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');

  const themeBtn = el('dash-theme-toggle');
  if (themeBtn && themeBtn.dataset.wired !== '1') {
    themeBtn.dataset.wired = '1';
    themeBtn.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      applyTheme(next);
    });
  }
  el('btn-affiliate')?.addEventListener('click', () => {
    window.location.href = '/#creators';
  });
  el('btn-console')?.addEventListener('click', () => {
    window.alert('Pipeline console opens inside each project after you generate captions.');
  });
  wireDropzone();
  mountUserChrome();
}
