// Caption Engine — editor workspace logic.
//
// Privacy: the uploaded video is held ONLY as an in-memory File in module
// state. Preview uses URL.createObjectURL()/revokeObjectURL(). Nothing here
// touches localStorage, sessionStorage, IndexedDB, or the Cache API. Theme
// preference lives in memory only (falls back to system preference).

import {
  fetchMeta,
  createJob,
  openProgressStream,
  getJob,
  setProjectTitle as apiSetProjectTitle,
  getTranscript,
  updateTranscript,
  getCuts,
  getWaveform,
  getClips,
  generateClips,
  exportClip,
  setCutRestored,
  reRenderJob,
  sourceUrl,
  downloadUrl,
} from './api.js';
import { takePendingMedia } from './pending-media.js';
import { upsertProject, getProject } from './projects-store.js';
import { mountUserChrome, userMenuButtonHtml } from './user-session.js';

// ---------------------------------------------------------------------------
// Module state (in memory only — never persisted)
// ---------------------------------------------------------------------------

const state = {
  // In-memory only, never persisted. Dark is the designed default; the header
  // toggle is the supported way to switch for this session.
  theme: 'dark',
  meta: null,
  mediaFile: null,
  mediaObjectUrl: null,
  jobId: null,
  jobData: null,
  transcript: null,
  cuts: [],
  cues: [],
  duration: 0,
  script: 'native',
  aspect: 'portrait',
  provider: null,
  aggression: 'balanced',
  autoTrimEnabled: false,
  trimToggles: { removeSilences: true, removeFillers: true, removeRepetitions: true, removeOffTopic: false },
  selectedTemplate: null,
  mode: 'original',
  sse: null,
  pxPerSecond: 42,
  activeCueIndex: -1,
  locked: false, // true once a job has been created — generation inputs freeze
  /** True when cuts/style/aspect changed since the last finished render. */
  needsRender: false,
  /** Distinguishes initial generate SSE vs re-render SSE completion toasts. */
  renderMode: null, // 'generate' | 'rerender' | null
  /** Selected cue index for the Cue inspector (-1 = none). */
  selectedCueIndex: -1,
  transcriptSaveTimer: null,
  transcriptSaving: false,
  clips: [],
  clipsSource: null,
  /** When set, playback loops within [start, end). */
  clipLoop: null,
  /**
   * Real audio peaks from GET /waveform:
   * `{ peaks: number[], durationSec, peaksPerSecond } | null`
   */
  waveform: null,
  waveformLoading: false,
};

const el = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Format seconds as MM:SS.mmm for cue boundary fields. */
function formatCueTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const rest = sec - m * 60;
  const s = Math.floor(rest);
  const ms = Math.round((rest - s) * 1000);
  const carry = ms === 1000 ? 1 : 0;
  const ms3 = ms === 1000 ? 0 : ms;
  return `${String(m).padStart(2, '0')}:${String(s + carry).padStart(2, '0')}.${String(ms3).padStart(3, '0')}`;
}

/** Parse MM:SS.mmm / M:SS / plain seconds into seconds. */
function parseCueTime(raw) {
  const str = String(raw ?? '').trim();
  if (!str) return NaN;
  if (/^\d+(\.\d+)?$/.test(str)) return Number(str);
  const m = str.match(/^(\d+):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return NaN;
  const mins = Number(m[1]);
  const secs = Number(m[2]);
  const frac = m[3] ? Number(m[3].padEnd(3, '0')) / 1000 : 0;
  if (secs >= 60) return NaN;
  return mins * 60 + secs + frac;
}

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toast(message, kind = 'info') {
  let stack = qs('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  stack.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

// ---------------------------------------------------------------------------
// Theme (in-memory / attribute only, never persisted)
// ---------------------------------------------------------------------------

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  el('theme-toggle')?.setAttribute('aria-pressed', String(theme === 'light'));
}

function initTheme() {
  applyTheme(state.theme);
  el('theme-toggle')?.addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark'));
}

// ---------------------------------------------------------------------------
// Routing helpers — shell owns /app vs /app/new vs /app/p/:id
// ---------------------------------------------------------------------------

/** @type {(path: string) => void} */
let navigateFn = (path) => {
  window.history.pushState({}, '', path);
};

function navigateToProject(jobId) {
  navigateFn(`/app/p/${jobId}`);
}

function navigateToDashboard() {
  navigateFn('/app');
}

function navigateToNew() {
  resetForNewProject();
  navigateFn('/app/new');
}

function syncProjectMeta(extra = {}) {
  const id = state.jobId || extra.id;
  if (!id) return;
  const title = el('project-title')?.value?.trim() || extra.title || 'Untitled project';
  upsertProject({
    id,
    title,
    durationSec: Number.isFinite(state.duration) ? state.duration : (extra.durationSec ?? 0),
    aspect: state.aspect || 'portrait',
    status: state.jobData?.status || extra.status || 'draft',
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Generic segmented-control wiring
// ---------------------------------------------------------------------------

function wireSegmented(container, onChange, { lockable = false } = {}) {
  if (!container) return;
  qsa('.seg', container).forEach((btn) => {
    btn.addEventListener('click', () => {
      if (lockable && state.locked) return;
      qsa('.seg', container).forEach((b) => b.classList.toggle('active', b === btn));
      onChange(btn.getAttribute('data-value'));
    });
  });
}

// ---------------------------------------------------------------------------
// Meta loading — populates language/provider selects, templates, auto trim UI
// ---------------------------------------------------------------------------

async function loadMeta() {
  try {
    state.meta = await fetchMeta();
  } catch (err) {
    toast('Could not load server options — using defaults.', 'error');
    state.meta = { languages: [], providers: [], templates: [], autoTrim: { aggression: [], toggles: [], default: state.trimToggles } };
  }

  const langSel = el('f-language');
  langSel.innerHTML = '';
  for (const l of state.meta.languages ?? []) {
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = l.code === 'auto' ? l.name : `${l.name} · ${l.nativeName}`;
    langSel.appendChild(opt);
  }

  const provSel = el('f-provider');
  provSel.innerHTML = '';
  for (const p of state.meta.providers ?? []) {
    const opt = document.createElement('option');
    opt.value = p.value;
    opt.textContent = p.badge ? `${p.label} · ${p.badge}` : p.label;
    provSel.appendChild(opt);
  }
  state.provider = state.meta.defaultProvider ?? state.meta.providers?.[0]?.value ?? 'sarvam_fallback_elevenlabs';
  provSel.value = state.provider;
  provSel.addEventListener('change', () => {
    state.provider = provSel.value;
    const p = state.meta.providers?.find((x) => x.value === state.provider);
    el('provider-hint').textContent = p?.description ?? '';
  });
  const initialProvider = state.meta.providers?.find((x) => x.value === state.provider);
  el('provider-hint').textContent = initialProvider?.description ?? '';

  renderTemplateGrid();
  renderAggressionGrid();
  renderTrimToggles();
}

function renderTemplateGrid() {
  const grid = el('template-grid');
  grid.innerHTML = '';
  const templates = state.meta.templates ?? [];
  if (!state.selectedTemplate && templates.length) state.selectedTemplate = templates[0].id;

  for (const t of templates) {
    const hue = hashString(t.id) % 360;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `template-mini${t.id === state.selectedTemplate ? ' active' : ''}`;
    btn.setAttribute('data-template-id', t.id);
    btn.innerHTML = `
      <div class="tm-preview" style="background:linear-gradient(160deg, hsl(${hue} 45% 20%), hsl(${hue} 45% 10%));">${t.name}</div>
      <span class="tm-name">${t.name}</span>
    `;
    btn.title = t.blurb ?? '';
    btn.addEventListener('click', () => {
      if (state.locked && !state.jobId) {
        toast('Template locks in once a project starts. Create a new project to change it.', 'info');
        return;
      }
      if (state.locked && state.jobData?.status === 'running') {
        toast('Wait for the current render to finish before changing the template.', 'info');
        return;
      }
      state.selectedTemplate = t.id;
      qsa('.template-mini', grid).forEach((b) => b.classList.toggle('active', b === btn));
      if (state.jobId && state.jobData?.status === 'done') {
        markNeedsRender('Template changed — re-render to bake it into the video.');
      }
    });
    grid.appendChild(btn);
  }
}

function renderAggressionGrid() {
  const grid = el('aggression-grid');
  grid.innerHTML = '';
  const options = state.meta.autoTrim?.aggression ?? [];
  state.aggression = state.meta.autoTrim?.default?.aggression ?? 'balanced';
  for (const opt of options) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = `aggr-pill${opt.value === state.aggression ? ' active' : ''}`;
    pill.textContent = opt.label;
    pill.addEventListener('click', () => {
      if (state.locked) return;
      state.aggression = opt.value;
      qsa('.aggr-pill', grid).forEach((b) => b.classList.toggle('active', b === pill));
      el('aggression-blurb').textContent = opt.blurb;
    });
    grid.appendChild(pill);
  }
  const current = options.find((o) => o.value === state.aggression);
  el('aggression-blurb').textContent = current?.blurb ?? '';
}

function renderTrimToggles() {
  const container = el('trim-toggles');
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.gap = '12px';
  container.innerHTML = '';
  const toggles = state.meta.autoTrim?.toggles ?? [];
  const defaults = state.meta.autoTrim?.default ?? state.trimToggles;
  for (const key in defaults) if (key !== 'enabled' && key !== 'aggression') state.trimToggles[key] = defaults[key];

  for (const t of toggles) {
    const row = document.createElement('div');
    row.className = 'switch-row';
    const checked = state.trimToggles[t.key] ? 'checked' : '';
    row.innerHTML = `
      <span class="switch-copy"><strong>${t.label}</strong></span>
      <label class="switch"><input type="checkbox" data-trim-key="${t.key}" ${checked} /><span class="knob"></span></label>
    `;
    qs('input', row).addEventListener('change', (e) => {
      if (state.locked) { e.target.checked = state.trimToggles[t.key]; return; }
      state.trimToggles[t.key] = e.target.checked;
    });
    container.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Left rail + panel switching (Media / Text / Auto Trim)
// ---------------------------------------------------------------------------

function initRail() {
  qsa('.rail-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-rail');
      qsa('.rail-btn').forEach((b) => b.classList.toggle('active', b === btn));
      qsa('.panel-tabbed').forEach((p) => p.classList.toggle('active', p.getAttribute('data-panel') === key));
    });
  });
}

function initInspectorTabs() {
  const tabs = qsa('[data-inspector-tab]');
  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-inspector-tab');
      tabs.forEach((b) => b.classList.toggle('active', b === btn));
      qsa('.inspector-tabpanel').forEach((p) => p.classList.toggle('active', p.getAttribute('data-inspector-panel') === key));
    });
  });
}

// ---------------------------------------------------------------------------
// Media handling — dropzone, file select, in-memory preview only
// ---------------------------------------------------------------------------

function initMediaPanel() {
  const dropzone = el('dropzone');
  const fileInput = el('file-input');

  dropzone.addEventListener('click', () => { if (!state.locked) fileInput.click(); });
  dropzone.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !state.locked) { e.preventDefault(); fileInput.click(); }
  });
  ['dragenter', 'dragover'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); if (!state.locked) dropzone.classList.add('drag-over'); }),
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('drag-over'); }),
  );
  dropzone.addEventListener('drop', (e) => {
    if (state.locked) return;
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) handleFile(file);
  });

  el('btn-clear-file').addEventListener('click', (e) => {
    e.stopPropagation();
    clearFile();
  });
}

function handleFile(file) {
  state.mediaFile = file;
  if (state.mediaObjectUrl) URL.revokeObjectURL(state.mediaObjectUrl);
  state.mediaObjectUrl = URL.createObjectURL(file);

  const video = el('preview-video');
  video.src = state.mediaObjectUrl;
  el('upload-empty-video').hidden = true;

  el('file-meta-card').hidden = false;
  el('file-name').textContent = file.name;
  el('file-size').textContent = formatFileSize(file.size);

  el('btn-generate').disabled = false;
  el('generate-hint').textContent = 'Ready — review options, then generate.';

  const baseTitle = file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Untitled project';
  const titleInput = el('project-title');
  if (titleInput && (!titleInput.value || titleInput.value === 'Untitled project')) {
    titleInput.value = baseTitle;
  }

  // Probe duration for dashboard metadata — never store the File itself.
  const onMeta = () => {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      state.duration = video.duration;
      if (state.jobId) syncProjectMeta({ durationSec: video.duration });
    }
  };
  video.addEventListener('loadedmetadata', onMeta, { once: true });
}

function clearFile() {
  if (state.locked) return;
  state.mediaFile = null;
  if (state.mediaObjectUrl) { URL.revokeObjectURL(state.mediaObjectUrl); state.mediaObjectUrl = null; }
  const video = el('preview-video');
  video.removeAttribute('src');
  video.load();
  el('upload-empty-video').hidden = false;
  el('file-meta-card').hidden = true;
  el('file-input').value = '';
  el('btn-generate').disabled = true;
  el('generate-hint').textContent = 'Choose a file to get started.';
}

// ---------------------------------------------------------------------------
// Generate — POST /api/jobs, then navigate to /app/p/:jobId
// ---------------------------------------------------------------------------

function collectFormats() {
  return qsa('input[name="formats"]:checked').map((i) => i.value);
}

function lockGenerateInputs() {
  state.locked = true;
  qsa('#generate-form input, #generate-form select, #generate-form button[type="button"]').forEach((i) => {
    if (i.id !== 'btn-clear-file') i.disabled = true;
  });
  el('dropzone').setAttribute('aria-disabled', 'true');
  el('template-note').textContent = 'Template locked while generating.';
  qsa('.seg', el('aspect-select')).forEach((b) => (b.disabled = true));
}

/** After a successful generate, unlock style/aspect so the user can re-render. */
function unlockReRenderControls() {
  // Keep ASR/language/provider/auto-trim locked — those would require re-transcription.
  qsa('#template-grid .template-mini').forEach((b) => { b.disabled = false; });
  qsa('.seg', el('aspect-select')).forEach((b) => (b.disabled = false));
  el('template-note').textContent =
    'Change the template or aspect, restore cuts, then use Apply & Render Video — no re-transcription.';
}

function markNeedsRender(toastMsg) {
  if (!state.jobId) return;
  state.needsRender = true;
  updateRenderStatusUi();
  if (toastMsg) toast(toastMsg, 'info');
}

function clearNeedsRender() {
  state.needsRender = false;
  updateRenderStatusUi();
}

function updateRenderStatusUi() {
  const badge = el('render-status-badge');
  const applyBtn = el('btn-apply-render');
  const canRender = Boolean(state.jobId) && state.jobData?.status === 'done';
  if (badge) badge.hidden = !(canRender && state.needsRender);
  if (applyBtn) {
    applyBtn.disabled = !canRender;
    applyBtn.classList.toggle('btn-primary', state.needsRender && canRender);
    applyBtn.classList.toggle('btn-outline', !(state.needsRender && canRender));
  }
}

async function submitGenerate(e) {
  e.preventDefault();
  if (!state.mediaFile) { toast('Choose a video or audio file first.', 'error'); return; }

  const formData = new FormData();
  formData.append('video', state.mediaFile);
  formData.append('language', el('f-language').value);
  formData.append('script', state.script);
  formData.append('template', state.selectedTemplate ?? '');
  formData.append('aspect', state.aspect);
  formData.append('provider', el('f-provider').value);
  for (const f of collectFormats()) formData.append('formats', f);
  formData.append('codeSwitching', String(el('f-code-switching').checked));
  formData.append('autoTrim', String(el('f-autotrim').checked));
  formData.append('trimAggression', state.aggression);
  formData.append('removeSilences', String(state.trimToggles.removeSilences));
  formData.append('removeFillers', String(state.trimToggles.removeFillers));
  formData.append('removeRepetitions', String(state.trimToggles.removeRepetitions));
  formData.append('removeOffTopic', String(state.trimToggles.removeOffTopic));

  lockGenerateInputs();
  el('btn-generate').disabled = true;
  el('btn-generate').textContent = 'Uploading…';
  showProgressOverlay();
  setProgress(0, 'Uploading your file…');

  try {
    const { jobId } = await createJob(formData, {
      onUploadProgress: (frac) => setProgress(Math.round(frac * 15), 'Uploading your file…'),
    });
    state.jobId = jobId;
    state.renderMode = 'generate';
    syncProjectMeta({
      id: jobId,
      title: el('project-title')?.value?.trim() || 'Untitled project',
      durationSec: state.duration || 0,
      aspect: state.aspect,
      status: 'running',
    });
    navigateToProject(jobId);

    const titleInput = el('project-title');
    if (titleInput.value.trim() && titleInput.value.trim() !== 'Untitled project') {
      apiSetProjectTitle(jobId, titleInput.value.trim()).catch(() => {});
    }

    subscribeProgress(jobId);
  } catch (err) {
    showProgressError(err.message || 'Upload failed.');
  }
}

// ---------------------------------------------------------------------------
// Progress overlay + SSE handling (shared by fresh submit and reload/hydrate)
// ---------------------------------------------------------------------------

function showProgressOverlay() {
  el('progress-overlay').hidden = false;
  el('po-error').hidden = true;
  el('btn-retry').hidden = true;
  qs('.spinner', el('progress-overlay')).style.display = '';
  qs('.po-track', el('progress-overlay')).style.display = '';
}

function hideProgressOverlay() {
  el('progress-overlay').hidden = true;
}

function setProgress(pct, message) {
  el('po-fill').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (message) el('po-msg').textContent = message;
}

function appendLog(message) {
  const log = el('po-log');
  const line = document.createElement('div');
  line.textContent = message;
  log.appendChild(line);
  while (log.children.length > 60) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function showProgressError(message, hint) {
  showProgressOverlay();
  qs('.spinner', el('progress-overlay')).style.display = 'none';
  qs('.po-track', el('progress-overlay')).style.display = 'none';
  el('po-msg').textContent = 'Something went wrong.';
  el('po-error').hidden = false;
  el('po-error').textContent = hint ? `${message} — ${hint}` : message;
  el('btn-retry').hidden = false;
  el('btn-generate').textContent = 'Generation failed';
  el('generate-hint').textContent = 'Start a new project to try again.';
}

function subscribeProgress(jobId) {
  if (state.sse) state.sse.close();
  state.sse = openProgressStream(jobId, {
    onEvent: (evt) => handleProgressEvent(jobId, evt),
    onError: () => {
      // EventSource retries automatically; only report if the job is long dead.
    },
  });
}

async function handleProgressEvent(jobId, evt) {
  switch (evt.type) {
    case 'queued':
      setProgress(16, evt.message);
      appendLog(evt.message);
      break;
    case 'step':
    case 'info':
      appendLog(evt.message);
      el('po-msg').textContent = evt.message;
      break;
    case 'warn':
      appendLog(`⚠ ${evt.message}`);
      break;
    case 'progress':
      setProgress(16 + Math.round(evt.pct * 0.84), evt.message);
      appendLog(evt.message);
      break;
    case 'done':
      appendLog(evt.message);
      setProgress(100, evt.message);
      await onJobDone(jobId);
      break;
    case 'error':
      showProgressError(evt.message, evt.hint);
      break;
    default:
      break;
  }
}

async function onJobDone(jobId) {
  hideProgressOverlay();
  el('btn-generate').textContent = 'Generated ✓';
  const wasRerender = state.renderMode === 'rerender';
  state.renderMode = null;
  if (wasRerender) {
    toast('Render complete! Updated files ready for export', 'success');
  } else {
    toast('Captions generated.', 'success');
  }
  await refreshJobData(jobId);
  await loadTranscriptAndCuts(jobId);
  ensureVideoSource(jobId);
  el('btn-export').disabled = false;
  unlockReRenderControls();
  clearNeedsRender();
  updateRenderStatusUi();
  renderExportChips();
  await loadClips(jobId);
  await loadWaveform(jobId);
  syncProjectMeta({
    id: jobId,
    title: el('project-title')?.value?.trim() || state.jobData?.projectTitle || 'Untitled project',
    durationSec: state.duration || 0,
    aspect: state.aspect,
    status: 'done',
  });
}

// ---------------------------------------------------------------------------
// Project hydration — GET /api/jobs/:id + reconnect SSE if still running
// ---------------------------------------------------------------------------

async function hydrateProject(jobId) {
  resetPreviewOnly();
  state.jobId = jobId;
  lockGenerateInputs();
  ensureVideoSource(jobId);

  let job;
  try {
    job = await getJob(jobId);
  } catch (err) {
    showProgressError('This project could not be found — it may have expired.', 'Start a new upload.');
    return;
  }

  state.jobData = job;
  const local = getProject(jobId);
  if (job.projectTitle) el('project-title').value = job.projectTitle;
  else if (local?.title) el('project-title').value = local.title;

  syncProjectMeta({
    id: jobId,
    title: el('project-title')?.value?.trim() || local?.title || 'Untitled project',
    durationSec: state.duration || local?.durationSec || 0,
    aspect: state.aspect || local?.aspect || 'portrait',
    status: job.status,
  });

  if (job.status === 'done') {
    hideProgressOverlay();
    el('btn-export').disabled = false;
    unlockReRenderControls();
    updateRenderStatusUi();
    await loadTranscriptAndCuts(jobId);
    await loadClips(jobId);
    await loadWaveform(jobId);
  } else if (job.status === 'error') {
    showProgressError(job.error || 'Generation failed.');
  } else {
    showProgressOverlay();
    setProgress(50, 'Reconnecting to your project…');
    state.renderMode = state.renderMode || 'generate';
    subscribeProgress(jobId);
  }
}

async function refreshJobData(jobId) {
  try {
    state.jobData = await getJob(jobId);
  } catch {
    /* keep previous */
  }
}

function ensureVideoSource(jobId) {
  const video = el('preview-video');
  if (state.mediaFile && state.mediaObjectUrl) {
    if (video.getAttribute('src') !== state.mediaObjectUrl) video.src = state.mediaObjectUrl;
  } else {
    video.src = sourceUrl(jobId);
  }
  video.addEventListener('error', () => {
    if (video.src !== sourceUrl(jobId)) video.src = sourceUrl(jobId);
  }, { once: true });
  el('upload-empty-video').hidden = true;
}

// ---------------------------------------------------------------------------
// Transcript → cues, cuts → removed clips + V1 timeline
// ---------------------------------------------------------------------------

function buildCues(words) {
  const MAX_WORDS = 5;
  const GAP = 0.45;
  const spoken = [];
  (words ?? []).forEach((w, i) => {
    if (w.type === 'word') spoken.push({ word: w, index: i });
  });
  const groups = [];
  let current = null;
  for (const entry of spoken) {
    const prevEnd = current?.entries[current.entries.length - 1]?.word.end;
    if (current && (entry.word.start - prevEnd >= GAP || current.entries.length >= MAX_WORDS)) {
      groups.push(current);
      current = null;
    }
    if (!current) current = { entries: [] };
    current.entries.push(entry);
  }
  if (current) groups.push(current);

  return groups.map((g, i) => {
    const cueWords = g.entries.map((e) => e.word);
    return {
      index: i,
      start: cueWords[0].start,
      end: cueWords[cueWords.length - 1].end,
      words: cueWords,
      wordIndices: g.entries.map((e) => e.index),
      text: cueWords.map((w) => (state.script === 'roman' && w.roman ? w.roman : w.text)).join(' '),
    };
  });
}

async function loadTranscriptAndCuts(jobId) {
  try {
    state.transcript = await getTranscript(jobId);
    state.cues = buildCues(state.transcript.words);
    state.duration = state.transcript.duration || state.duration;
  } catch {
    state.transcript = null;
    state.cues = [];
  }

  try {
    const cutsRes = await getCuts(jobId);
    state.cuts = cutsRes.cuts ?? [];
  } catch {
    state.cuts = [];
  }

  renderCueList();
  renderRemovedClips();
  buildTimeline();
  renderCueInspector();
  updateClipsUiEnabled();
}

function renderCueList() {
  const list = el('cue-list');
  list.innerHTML = '';
  if (!state.cues.length) {
    list.innerHTML = '<div class="empty-state"><div class="es-ic">📝</div>No cues yet.</div>';
    return;
  }
  for (const cue of state.cues) {
    const row = document.createElement('div');
    row.className = `cue-item${cue.index === state.selectedCueIndex ? ' is-selected' : ''}`;
    row.setAttribute('data-cue-index', String(cue.index));
    row.innerHTML = `<span class="cue-time">${formatTime(cue.start)}</span><span class="cue-text">${escapeHtml(cue.text)}</span>`;
    row.addEventListener('click', () => {
      selectCue(cue.index, { seek: true, play: true });
    });
    list.appendChild(row);
  }
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderRemovedClips() {
  const results = el('trim-results');
  const list = el('removed-clip-list');
  if (!state.cuts.length) {
    results.hidden = true;
    return;
  }
  results.hidden = false;
  list.innerHTML = '';

  const active = state.cuts.filter((c) => !c.restored);
  const restored = state.cuts.filter((c) => c.restored);
  const seconds = active.reduce((n, c) => n + (c.end - c.start), 0);
  el('ts-removed').textContent = String(active.length);
  el('ts-seconds').textContent = `${seconds.toFixed(1)}s`;
  el('ts-restored').textContent = String(restored.length);

  for (const cut of state.cuts) {
    const row = document.createElement('div');
    row.className = `removed-clip${cut.restored ? ' is-restored' : ''}`;
    row.innerHTML = `
      <div class="rc-info">
        <strong>${escapeHtml(cut.reason.replace('_', ' '))}</strong>
        <span>${formatTime(cut.start)} – ${formatTime(cut.end)} · ${(cut.end - cut.start).toFixed(2)}s</span>
        ${cut.label ? `<div class="rc-label">"${escapeHtml(cut.label)}"</div>` : ''}
      </div>
      <button type="button" class="btn btn-sm ${cut.restored ? 'btn-outline' : 'btn-ghost'}" data-cut-id="${cut.id}">
        ${cut.restored ? 'Re-apply' : 'Restore'}
      </button>
    `;
    qs('button', row).addEventListener('click', async () => {
      try {
        const nextRestored = !cut.restored;
        await setCutRestored(state.jobId, cut.id, nextRestored);
        cut.restored = nextRestored;
        renderRemovedClips();
        buildTimeline();
        markNeedsRender(
          nextRestored
            ? 'Cut restored — Apply & Render Video to keep it in the export.'
            : 'Cut re-applied — Apply & Render Video to bake the trim.',
        );
      } catch (err) {
        toast(err.message || 'Could not update cut.', 'error');
      }
    });
    list.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Bottom timeline — ruler + V1 (cuts) / T1 (cues) / A1 (real waveform)
// ---------------------------------------------------------------------------

function effectiveDuration() {
  const video = el('preview-video');
  return state.duration || video.duration || 60;
}

function buildTimelineSegments(duration, cuts) {
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  const segments = [];
  let cursor = 0;
  for (const cut of sorted) {
    if (cut.start > cursor) segments.push({ start: cursor, end: cut.start, cut: false });
    segments.push({ start: cut.start, end: cut.end, cut: !cut.restored });
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < duration) segments.push({ start: cursor, end: duration, cut: false });
  return segments;
}

/**
 * Draw real audio peaks onto a canvas sized to `duration * pxPerSecond`.
 * Active (non-restored) cuts are dimmed with a crosshatch overlay.
 */
function renderTrackA1(container, duration, px) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'tl-clip a-clip tl-waveform-wrap';
  wrap.style.left = '40px';
  wrap.style.width = `${Math.max(duration * px - 2, 20)}px`;

  const peaks = state.waveform?.peaks;
  if (!peaks || !peaks.length) {
    wrap.classList.add(state.waveformLoading ? 'is-loading' : 'is-empty');
    wrap.textContent = state.waveformLoading ? 'Measuring audio…' : 'No waveform';
    container.appendChild(wrap);
    return;
  }

  const cssW = Math.max(duration * px - 2, 20);
  const cssH = 36;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.className = 'tl-waveform-canvas';
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    wrap.textContent = 'No waveform';
    container.appendChild(wrap);
    return;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const mid = cssH / 2;
  const n = peaks.length;
  const waveDur = state.waveform.durationSec || duration;
  // Map each peak index → x via true time so zoom only changes px/sec, not bar density math.
  const barW = Math.max(1, (cssW / Math.max(n, 1)) * 0.85);

  ctx.fillStyle = 'rgba(94, 234, 212, 0.55)';
  for (let i = 0; i < n; i++) {
    const t = (i / n) * waveDur;
    const x = (t / Math.max(duration, 0.001)) * cssW;
    const amp = peaks[i] ?? 0;
    const h = Math.max(1, amp * (cssH * 0.9));
    ctx.fillRect(x, mid - h / 2, barW, h);
  }

  // Dim + crosshatch regions under active cuts.
  const cutSegs = buildTimelineSegments(duration, state.cuts).filter((s) => s.cut);
  if (cutSegs.length) {
    for (const seg of cutSegs) {
      const x0 = (seg.start / Math.max(duration, 0.001)) * cssW;
      const x1 = (seg.end / Math.max(duration, 0.001)) * cssW;
      const w = Math.max(x1 - x0, 1);
      ctx.fillStyle = 'rgba(8, 12, 18, 0.55)';
      ctx.fillRect(x0, 0, w, cssH);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, w, cssH);
      ctx.clip();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0 - cssH; x < x1 + cssH; x += 6) {
        ctx.moveTo(x, cssH);
        ctx.lineTo(x + cssH, 0);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  wrap.appendChild(canvas);
  container.appendChild(wrap);
}

function buildTimeline() {
  const duration = effectiveDuration();
  const px = state.pxPerSecond;
  const inner = el('timeline-inner');
  inner.style.width = `${Math.max(duration * px + 40, 600)}px`;
  el('timeline-duration-label').textContent = `${formatTime(duration)} total`;

  // Ruler
  const ruler = el('timeline-ruler');
  ruler.innerHTML = '';
  const step = duration > 240 ? 30 : duration > 90 ? 15 : duration > 30 ? 5 : 2;
  for (let t = 0; t <= duration; t += step) {
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.left = `${40 + t * px}px`;
    tick.textContent = formatTime(t);
    ruler.appendChild(tick);
  }

  // V1 — video segments from cuts
  const v1 = el('track-v1');
  v1.innerHTML = '';
  const segments = buildTimelineSegments(duration, state.cuts);
  for (const seg of segments) {
    const clip = document.createElement('div');
    clip.className = `tl-clip v-clip${seg.cut ? ' is-cut' : ''}`;
    clip.style.left = `${40 + seg.start * px}px`;
    clip.style.width = `${Math.max((seg.end - seg.start) * px - 2, 2)}px`;
    v1.appendChild(clip);
  }

  // T1 — caption cues
  const t1 = el('track-t1');
  t1.innerHTML = '';
  for (const cue of state.cues) {
    const clip = document.createElement('div');
    clip.className = `t-clip tl-clip${cue.index === state.selectedCueIndex ? ' is-selected' : ''}`;
    clip.style.left = `${40 + cue.start * px}px`;
    clip.style.width = `${Math.max((cue.end - cue.start) * px - 2, 24)}px`;
    clip.textContent = cue.text;
    clip.title = cue.text;
    clip.setAttribute('data-cue-index', String(cue.index));
    clip.addEventListener('click', (e) => {
      e.stopPropagation();
      selectCue(cue.index, { seek: true, play: false });
    });
    t1.appendChild(clip);
  }

  renderTrackA1(el('track-a1'), duration, px);

  // Seeking by clicking the ruler/tracks
  const inner2 = inner;
  inner2.onclick = (e) => {
    if (e.target.closest('.t-clip')) return;
    const rect = inner2.getBoundingClientRect();
    const x = e.clientX - rect.left - 40;
    const t = Math.max(0, x / px);
    el('preview-video').currentTime = t;
  };
}

async function loadWaveform(jobId) {
  if (!jobId) return;
  state.waveformLoading = true;
  buildTimeline();
  try {
    const data = await getWaveform(jobId);
    state.waveform = data && Array.isArray(data.peaks) ? data : null;
  } catch {
    state.waveform = null;
  } finally {
    state.waveformLoading = false;
    buildTimeline();
  }
}

function updatePlayhead(t) {
  const px = state.pxPerSecond;
  el('tl-playhead').style.left = `${40 + t * px}px`;
  // keep playhead in view
  const scroll = el('timeline-scroll');
  const left = 40 + t * px;
  if (left < scroll.scrollLeft + 60 || left > scroll.scrollLeft + scroll.clientWidth - 60) {
    scroll.scrollLeft = Math.max(0, left - scroll.clientWidth / 2);
  }
}

// ---------------------------------------------------------------------------
// Caption overlay live preview + cue/T1 highlight sync
// ---------------------------------------------------------------------------

function findActiveCue(t) {
  return state.cues.findIndex((c) => t >= c.start && t < c.end);
}

function updateCaptionOverlay(t) {
  const idx = findActiveCue(t);
  if (idx === state.activeCueIndex) {
    if (idx >= 0) highlightActiveWord(t, state.cues[idx]);
    return;
  }
  state.activeCueIndex = idx;

  qsa('.cue-item.active', el('cue-list')).forEach((n) => n.classList.remove('active'));
  qsa('.t-clip.active', el('track-t1')).forEach((n) => n.classList.remove('active'));

  if (idx < 0) {
    el('caption-text').innerHTML = '';
    return;
  }
  const cueRow = qs(`.cue-item[data-cue-index="${idx}"]`, el('cue-list'));
  cueRow?.classList.add('active');
  cueRow?.scrollIntoView({ block: 'nearest' });
  const tClip = qs(`.t-clip[data-cue-index="${idx}"]`, el('track-t1'));
  tClip?.classList.add('active');

  highlightActiveWord(t, state.cues[idx]);
}

function highlightActiveWord(t, cue) {
  const html = cue.words
    .map((w) => {
      const label = escapeHtml(state.script === 'roman' && w.roman ? w.roman : w.text);
      const active = t >= w.start && t < w.end;
      return active ? `<span class="word-active">${label}</span>` : label;
    })
    .join(' ');
  el('caption-text').innerHTML = html;
}

// ---------------------------------------------------------------------------
// Auto-trimmed playback: skip over active (non-restored) cuts live
// ---------------------------------------------------------------------------

function maybeSkipCut(t) {
  if (state.mode !== 'auto-trimmed') return;
  const video = el('preview-video');
  for (const cut of state.cuts) {
    if (cut.restored) continue;
    if (t >= cut.start && t < cut.end - 0.02) {
      video.currentTime = cut.end;
      return;
    }
  }
}

function maybeLoopClip(t) {
  if (!state.clipLoop) return;
  const { start, end } = state.clipLoop;
  const video = el('preview-video');
  if (t >= end - 0.04) {
    video.currentTime = start;
  }
}

// ---------------------------------------------------------------------------
// Transport (play/pause, scrub, time label) + video event wiring
// ---------------------------------------------------------------------------

function initTransport() {
  const video = el('preview-video');
  const playBtn = el('btn-play');
  const scrub = el('transport-scrub');

  playBtn.addEventListener('click', () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  });
  video.addEventListener('play', () => { playBtn.textContent = '⏸'; });
  video.addEventListener('pause', () => { playBtn.textContent = '▶'; });

  video.addEventListener('loadedmetadata', () => {
    if (!state.duration) state.duration = video.duration;
    buildTimeline();
  });

  video.addEventListener('timeupdate', () => {
    const t = video.currentTime;
    const d = video.duration || state.duration || 0;
    el('transport-time').textContent = `${formatTime(t)} / ${formatTime(d)}`;
    const frac = d ? t / d : 0;
    el('scrub-fill').style.width = `${frac * 100}%`;
    el('scrub-knob').style.left = `${frac * 100}%`;
    updatePlayhead(t);
    updateCaptionOverlay(t);
    maybeSkipCut(t);
    maybeLoopClip(t);
  });

  function seekFromEvent(e) {
    const rect = scrub.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const d = video.duration || state.duration || 0;
    video.currentTime = frac * d;
  }
  scrub.addEventListener('click', seekFromEvent);
  let dragging = false;
  scrub.addEventListener('mousedown', () => { dragging = true; });
  window.addEventListener('mousemove', (e) => { if (dragging) seekFromEvent(e); });
  window.addEventListener('mouseup', () => { dragging = false; });
}

// ---------------------------------------------------------------------------
// Mode pills, safe zone toggle, aspect select
// ---------------------------------------------------------------------------

function initModePills() {
  qsa('.mode-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.mode = btn.getAttribute('data-mode');
      qsa('.mode-pill').forEach((b) => b.classList.toggle('active', b === btn));
      el('center-stage').setAttribute('data-mode', state.mode);
    });
  });
}

function initSafeZone() {
  el('btn-safe-zone').addEventListener('click', () => {
    const overlay = el('safe-zone-overlay');
    const showing = overlay.classList.toggle('show');
    el('btn-safe-zone').classList.toggle('btn-outline', showing);
  });
}

function initAspectSelect() {
  wireSegmented(el('aspect-select'), (value) => {
    state.aspect = value;
    el('phone-frame')?.setAttribute('data-aspect', value);
    if (state.jobId) syncProjectMeta({ aspect: value });
    if (state.jobId && state.jobData?.status === 'done') {
      markNeedsRender('Aspect changed — re-render to update the exported video.');
    }
  }, { lockable: false });
}

// ---------------------------------------------------------------------------
// Script pills (native / roman) — also relabels cues live
// ---------------------------------------------------------------------------

function initScriptPills() {
  wireSegmented(el('script-pills'), (value) => {
    state.script = value;
    if (state.cues.length) {
      state.cues = buildCues(state.transcript?.words ?? []);
      renderCueList();
      buildTimeline();
      if (state.selectedCueIndex >= 0) renderCueInspector();
      refreshLivePreview();
    }
  }, { lockable: true });
}

// ---------------------------------------------------------------------------
// Auto Trim master switch
// ---------------------------------------------------------------------------

function initAutoTrimSwitch() {
  const box = el('f-autotrim');
  box.addEventListener('change', () => {
    state.autoTrimEnabled = box.checked;
    const dim = !box.checked;
    el('aggression-grid').style.opacity = dim ? '0.45' : '1';
    el('trim-toggles').style.opacity = dim ? '0.45' : '1';
  });
  box.dispatchEvent(new Event('change'));
}

// ---------------------------------------------------------------------------
// Right inspector — Text tab live caption styling
// ---------------------------------------------------------------------------

function initCaptionStyleControls() {
  const overlay = el('caption-overlay');

  el('cap-font-select').addEventListener('change', (e) => {
    overlay.style.setProperty('--cap-font', e.target.value);
  });
  el('cap-size-range').addEventListener('input', (e) => {
    overlay.style.setProperty('--cap-size', `${e.target.value}px`);
    el('cap-size-value').textContent = `${e.target.value}px`;
  });
  el('cap-color').addEventListener('input', (e) => overlay.style.setProperty('--cap-color', e.target.value));
  el('cap-active-color').addEventListener('input', (e) => overlay.style.setProperty('--cap-active', e.target.value));
  el('fx-uppercase').addEventListener('change', (e) => overlay.classList.toggle('uppercase', e.target.checked));
  el('fx-glow').addEventListener('change', (e) => overlay.classList.toggle('glow', e.target.checked));
  el('fx-boxed').addEventListener('change', (e) => overlay.classList.toggle('boxed', e.target.checked));
}

// ---------------------------------------------------------------------------
// Cue inspector — edit cue text, boundaries, and per-word spelling
// ---------------------------------------------------------------------------

function switchInspectorTab(key) {
  qsa('[data-inspector-tab]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-inspector-tab') === key));
  qsa('.inspector-tabpanel').forEach((p) => p.classList.toggle('active', p.getAttribute('data-inspector-panel') === key));
}

function selectCue(index, { seek = false, play = false } = {}) {
  if (!Number.isInteger(index) || index < 0 || index >= state.cues.length) {
    clearCueSelection();
    return;
  }
  state.selectedCueIndex = index;
  const cue = state.cues[index];
  renderCueList();
  buildTimeline();
  renderCueInspector();
  switchInspectorTab('cue');

  const video = el('preview-video');
  if (seek && cue) {
    video.currentTime = cue.start;
    if (play) video.play().catch(() => {});
  }
  // Force overlay refresh for the selected cue
  state.activeCueIndex = -1;
  updateCaptionOverlay(video.currentTime || cue.start);
}

function clearCueSelection() {
  state.selectedCueIndex = -1;
  renderCueList();
  buildTimeline();
  renderCueInspector();
}

function displayWordText(w) {
  return state.script === 'roman' && w.roman ? w.roman : w.text;
}

function renderCueInspector() {
  const empty = el('cue-inspector-empty');
  const panel = el('cue-inspector');
  if (!empty || !panel) return;

  const cue = state.cues[state.selectedCueIndex];
  if (!cue) {
    empty.hidden = false;
    panel.hidden = true;
    return;
  }

  empty.hidden = true;
  panel.hidden = false;
  el('cue-inspector-label').textContent = `Cue ${cue.index + 1}`;
  el('cue-text-edit').value = cue.text;
  el('cue-start-edit').value = formatCueTime(cue.start);
  el('cue-end-edit').value = formatCueTime(cue.end);
  renderCueWordChips(cue);
}

function renderCueWordChips(cue) {
  const box = el('cue-word-chips');
  if (!box) return;
  box.innerHTML = '';
  cue.wordIndices.forEach((wi, localIdx) => {
    const w = state.transcript?.words?.[wi];
    if (!w) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'cue-word-chip';
    chip.textContent = displayWordText(w);
    chip.title = `Word ${wi} · ${formatCueTime(w.start)}–${formatCueTime(w.end)}`;
    chip.addEventListener('click', () => beginWordChipEdit(chip, wi, localIdx));
    box.appendChild(chip);
  });
}

function beginWordChipEdit(chip, wordIndex) {
  const w = state.transcript?.words?.[wordIndex];
  if (!w) return;
  chip.classList.add('is-editing');
  const input = document.createElement('input');
  input.type = 'text';
  input.value = displayWordText(w);
  input.setAttribute('aria-label', 'Edit word');
  chip.textContent = '';
  chip.appendChild(input);
  input.focus();
  input.select();

  const commit = async () => {
    const next = input.value;
    chip.classList.remove('is-editing');
    if (next === displayWordText(w)) {
      chip.textContent = displayWordText(w);
      return;
    }
    // Optimistic local update for live preview
    if (state.script === 'roman' && w.roman !== undefined) {
      w.roman = next;
    } else {
      w.text = next;
      if (w.roman !== undefined) w.roman = next;
    }
    rebuildCuesFromTranscript();
    const cueIdx = state.cues.findIndex((c) => c.wordIndices.includes(wordIndex));
    if (cueIdx >= 0) state.selectedCueIndex = cueIdx;
    renderCueInspector();
    refreshLivePreview();
    scheduleTranscriptSave({ wordIndex, text: next, start: w.start, end: w.end });
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') {
      e.preventDefault();
      chip.classList.remove('is-editing');
      chip.textContent = displayWordText(w);
    }
  });
  input.addEventListener('blur', () => { commit().catch(() => {}); });
}

function rebuildCuesFromTranscript() {
  state.cues = buildCues(state.transcript?.words ?? []);
  // Keep selection if still valid
  if (state.selectedCueIndex >= state.cues.length) state.selectedCueIndex = -1;
  renderCueList();
  buildTimeline();
}

function refreshLivePreview() {
  const video = el('preview-video');
  state.activeCueIndex = -1;
  updateCaptionOverlay(video?.currentTime || 0);
}

function applyCueFormToLocalState() {
  const cue = state.cues[state.selectedCueIndex];
  if (!cue || !state.transcript?.words) return null;

  const text = el('cue-text-edit').value;
  const start = parseCueTime(el('cue-start-edit').value);
  const end = parseCueTime(el('cue-end-edit').value);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    toast('Cue times must be valid and start ≤ end (MM:SS.mmm).', 'error');
    return null;
  }

  const wordsPayload = cue.wordIndices.map((wi) => {
    const w = state.transcript.words[wi];
    return {
      wordIndex: wi,
      text: displayWordText(w),
      start: w.start,
      end: w.end,
      ...(w.roman !== undefined ? { roman: w.roman } : {}),
    };
  });

  return {
    index: cue.index,
    start,
    end,
    text,
    wordIndices: [...cue.wordIndices],
    words: wordsPayload,
  };
}

function scheduleTranscriptSave(singleWordPatch = null) {
  if (!state.jobId) return;
  clearTimeout(state.transcriptSaveTimer);
  state.transcriptSaveTimer = setTimeout(() => {
    persistTranscriptEdits(singleWordPatch).catch((err) => {
      toast(err.message || 'Could not save transcript.', 'error');
    });
  }, 600);
}

async function persistTranscriptEdits(singleWordPatch = null) {
  if (!state.jobId || state.transcriptSaving) return;
  state.transcriptSaving = true;
  try {
    let body;
    if (singleWordPatch && Number.isInteger(singleWordPatch.wordIndex)) {
      body = singleWordPatch;
    } else {
      const cuePatch = applyCueFormToLocalState();
      if (!cuePatch) return;
      body = { cues: [cuePatch] };
    }

    await updateTranscript(state.jobId, body);

    // Refresh from server so timings/romanisation stay canonical.
    state.transcript = await getTranscript(state.jobId);
    rebuildCuesFromTranscript();
    if (state.selectedCueIndex >= 0) renderCueInspector();
    refreshLivePreview();
    markNeedsRender();
    showTranscriptSavedBadge();
    toast('Transcript saved', 'success');
  } finally {
    state.transcriptSaving = false;
  }
}

function showTranscriptSavedBadge() {
  const badge = el('cue-save-badge');
  if (!badge) return;
  badge.hidden = false;
  clearTimeout(showTranscriptSavedBadge._t);
  showTranscriptSavedBadge._t = setTimeout(() => { badge.hidden = true; }, 1800);
}

function initCueInspector() {
  el('cue-text-edit')?.addEventListener('input', () => {
    const cue = state.cues[state.selectedCueIndex];
    if (!cue) return;
    cue.text = el('cue-text-edit').value;
    // Optimistic redistribute for overlay
    const tokens = cue.text.trim().split(/\s+/).filter(Boolean);
    const idxs = cue.wordIndices;
    if (tokens.length && idxs.length) {
      for (let i = 0; i < idxs.length; i++) {
        const wi = idxs[i];
        const w = state.transcript?.words?.[wi];
        if (!w) continue;
        const assigned = i < idxs.length - 1
          ? (tokens[i] ?? '')
          : tokens.slice(i).join(' ') || (tokens[i] ?? '');
        if (state.script === 'roman' && w.roman !== undefined) w.roman = assigned;
        else {
          w.text = assigned;
          if (w.roman !== undefined) w.roman = assigned;
        }
      }
    }
    renderCueList();
    buildTimeline();
    refreshLivePreview();
    scheduleTranscriptSave();
  });

  const onTimeBlur = () => {
    if (state.selectedCueIndex < 0) return;
    scheduleTranscriptSave();
  };
  el('cue-start-edit')?.addEventListener('change', onTimeBlur);
  el('cue-end-edit')?.addEventListener('change', onTimeBlur);
  el('cue-start-edit')?.addEventListener('blur', onTimeBlur);
  el('cue-end-edit')?.addEventListener('blur', onTimeBlur);

  el('btn-save-transcript')?.addEventListener('click', () => {
    clearTimeout(state.transcriptSaveTimer);
    persistTranscriptEdits().catch((err) => toast(err.message || 'Could not save transcript.', 'error'));
  });
  el('btn-clear-cue-selection')?.addEventListener('click', () => clearCueSelection());
}

// ---------------------------------------------------------------------------
// Viral clips panel
// ---------------------------------------------------------------------------

function formatClipRange(start, end) {
  return `${formatTime(start)} – ${formatTime(end)}`;
}

function updateClipsUiEnabled() {
  const btn = el('btn-find-clips');
  const ready = Boolean(state.jobId) && state.jobData?.status === 'done' && Boolean(state.transcript);
  if (btn) btn.disabled = !ready;
  if (el('clips-hint') && ready && !state.clips.length) {
    el('clips-hint').textContent = 'Scan the transcript for self-contained moments worth clipping.';
  }
}

function renderClipsList() {
  const list = el('clips-list');
  if (!list) return;
  list.innerHTML = '';

  const badge = el('clips-source-badge');
  if (badge) {
    if (state.clipsSource) {
      badge.hidden = false;
      badge.textContent = state.clipsSource === 'llm'
        ? 'Scored with Vision LLM'
        : 'Rule-based scores (no LLM key)';
    } else {
      badge.hidden = true;
    }
  }

  if (!state.clips.length) {
    list.innerHTML = '<div class="empty-state"><div class="es-ic">⚡</div>No clips yet.</div>';
    return;
  }

  for (const clip of state.clips) {
    const card = document.createElement('div');
    const looping = state.clipLoop && Math.abs(state.clipLoop.start - clip.start) < 0.01
      && Math.abs(state.clipLoop.end - clip.end) < 0.01;
    card.className = `clip-card${looping ? ' is-looping' : ''}`;
    card.setAttribute('data-clip-id', clip.id);
    const dur = Math.round(clip.durationSec || (clip.end - clip.start));
    card.innerHTML = `
      <div class="clip-card-top">
        <strong>${escapeHtml(clip.hook || clip.title)}</strong>
        <span class="clip-score">Score: ${Math.round(clip.viralityScore)}/100</span>
      </div>
      <div class="clip-meta">${dur}s · ${formatClipRange(clip.start, clip.end)}</div>
      ${clip.reasoning ? `<div class="clip-reason">${escapeHtml(clip.reasoning)}</div>` : ''}
      <div class="clip-actions">
        <button type="button" class="btn btn-outline btn-sm" data-clip-preview>Preview on Timeline</button>
        <button type="button" class="btn btn-primary btn-sm" data-clip-export>Export Reel (9:16)</button>
        ${clip.downloadUrl
          ? `<a class="btn btn-ghost btn-sm" data-clip-download href="${escapeHtml(clip.downloadUrl)}" download>Download</a>`
          : ''}
      </div>
    `;
    qs('[data-clip-preview]', card)?.addEventListener('click', () => previewClipOnTimeline(clip));
    qs('[data-clip-export]', card)?.addEventListener('click', (e) => {
      exportClipReel(clip, e.currentTarget).catch((err) => {
        toast(err.message || 'Clip export failed.', 'error');
      });
    });
    list.appendChild(card);
  }
}

function previewClipOnTimeline(clip) {
  state.clipLoop = { start: clip.start, end: clip.end };
  const video = el('preview-video');
  video.currentTime = clip.start;
  video.play().catch(() => {});
  renderClipsList();
  toast(`Looping ${formatClipRange(clip.start, clip.end)} — click Preview again on another clip to switch.`, 'info');
}

async function exportClipReel(clip, btn) {
  if (!state.jobId) return;
  const label = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Exporting…';
  }
  try {
    const res = await exportClip(state.jobId, clip.id);
    clip.exported = true;
    clip.downloadUrl = res.downloadUrl;
    renderClipsList();
    toast('Reel ready — download started.', 'success');
    if (res.downloadUrl) {
      const a = document.createElement('a');
      a.href = res.downloadUrl;
      a.setAttribute('download', '');
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label || 'Export Reel (9:16)';
    }
  }
}

async function loadClips(jobId) {
  try {
    const res = await getClips(jobId);
    state.clips = res.clips ?? [];
  } catch {
    state.clips = [];
  }
  renderClipsList();
  updateClipsUiEnabled();
}

async function findViralClips() {
  if (!state.jobId) return;
  const btn = el('btn-find-clips');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Finding clips…';
  }
  const hint = el('clips-hint');
  if (hint) hint.textContent = 'Scoring moments in your transcript…';
  try {
    const res = await generateClips(state.jobId);
    state.clips = res.clips ?? [];
    state.clipsSource = res.source ?? null;
    renderClipsList();
    if (hint) {
      hint.textContent = state.clips.length
        ? `${state.clips.length} candidate${state.clips.length === 1 ? '' : 's'} — preview, then export as 9:16.`
        : 'No strong clip candidates found. Try a longer video or LLM scoring with ANTHROPIC_API_KEY.';
    }
    toast(state.clips.length ? `Found ${state.clips.length} clip(s).` : 'No clips found.', 'success');
  } catch (err) {
    toast(err.message || 'Could not find clips.', 'error');
    if (hint) hint.textContent = 'Clip finding failed — try again.';
  } finally {
    if (btn) {
      btn.textContent = 'Find viral clips';
      updateClipsUiEnabled();
    }
  }
}

function initClipsPanel() {
  el('btn-find-clips')?.addEventListener('click', () => {
    findViralClips().catch((err) => toast(err.message || 'Could not find clips.', 'error'));
  });
}

// ---------------------------------------------------------------------------
// Project title (header) — editable, PATCH /api/jobs/:id
// ---------------------------------------------------------------------------

function initTitleEditing() {
  const input = el('project-title');
  let debounceTimer = null;
  input.addEventListener('input', () => {
    if (state.jobId) syncProjectMeta({ title: input.value.trim() || 'Untitled project' });
    if (!state.jobId) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        await apiSetProjectTitle(state.jobId, input.value);
        el('title-save-hint').textContent = 'Saved';
        el('title-save-hint').classList.add('show');
        setTimeout(() => el('title-save-hint').classList.remove('show'), 1200);
      } catch {
        /* non-fatal */
      }
    }, 500);
  });
}

// ---------------------------------------------------------------------------
// Export panel
// ---------------------------------------------------------------------------

const OUTPUT_LABELS = {
  mp4: 'Captioned video (MP4)',
  srt: 'Subtitles (SRT)',
  ass: 'Styled subtitles (ASS)',
  json: 'Render manifest (JSON)',
  transcript: 'Transcript (JSON)',
  cuts: 'Auto Trim cuts (JSON)',
  clips: 'Clip candidates (JSON)',
};

function initExportPanel() {
  el('btn-export').addEventListener('click', () => {
    renderExportChips();
    el('export-backdrop').classList.add('show');
  });
  el('btn-export-close').addEventListener('click', () => el('export-backdrop').classList.remove('show'));
  el('export-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'export-backdrop') el('export-backdrop').classList.remove('show');
  });
}

async function applyAndRender() {
  if (!state.jobId) return;
  if (state.jobData?.status === 'running' || state.jobData?.status === 'queued') {
    toast('A render is already in progress.', 'info');
    return;
  }
  if (state.jobData?.status !== 'done') {
    toast('Generate captions first before re-rendering.', 'error');
    return;
  }

  const applyBtn = el('btn-apply-render');
  if (applyBtn) applyBtn.disabled = true;

  showProgressOverlay();
  setProgress(0, 'Starting re-render from cached transcript…');
  el('po-log').innerHTML = '';
  appendLog('Re-render — ASR skipped (using cached transcript)');

  try {
    state.renderMode = 'rerender';
    if (state.jobData) state.jobData.status = 'running';
    updateRenderStatusUi();
    syncProjectMeta({ status: 'running' });

    await reRenderJob(state.jobId, {
      template: state.selectedTemplate || undefined,
      aspect: state.aspect || undefined,
    });
    subscribeProgress(state.jobId);
  } catch (err) {
    state.renderMode = null;
    if (state.jobData) state.jobData.status = 'done';
    updateRenderStatusUi();
    showProgressError(err.message || 'Re-render failed.', err.hint);
  }
}

function initApplyRenderButton() {
  el('btn-apply-render')?.addEventListener('click', () => {
    applyAndRender().catch((err) => toast(err.message || 'Re-render failed.', 'error'));
  });
}

function renderExportChips() {
  const grid = el('export-chip-grid');
  grid.innerHTML = '';
  const outputs = state.jobData?.outputs ?? {};
  const keys = Object.keys(OUTPUT_LABELS);
  for (const key of keys) {
    const available = Boolean(outputs[key]);
    const a = document.createElement('a');
    a.className = `export-chip${available ? '' : ' disabled'}`;
    a.href = available ? downloadUrl(state.jobId, key) : '#';
    if (available) a.setAttribute('download', '');
    a.innerHTML = `<strong>${key.toUpperCase()}</strong><span>${OUTPUT_LABELS[key]}${available ? '' : ' — not generated'}</span>`;
    grid.appendChild(a);
  }
}

// ---------------------------------------------------------------------------
// Reset helpers
// ---------------------------------------------------------------------------

function resetPreviewOnly() {
  state.transcript = null;
  state.cues = [];
  state.cuts = [];
  state.activeCueIndex = -1;
}

function clearTimelineTracks() {
  el('timeline-ruler').innerHTML = '';
  el('track-v1').innerHTML = '';
  el('track-t1').innerHTML = '';
  el('track-a1').innerHTML = '';
  el('timeline-inner').style.width = '600px';
  el('timeline-duration-label').textContent = '0:00 total';
  const playhead = el('tl-playhead');
  if (playhead) playhead.style.left = '0px';
}

function resetForNewProject() {
  if (state.sse) { state.sse.close(); state.sse = null; }
  if (state.mediaObjectUrl) { URL.revokeObjectURL(state.mediaObjectUrl); state.mediaObjectUrl = null; }
  state.mediaFile = null;
  state.jobId = null;
  state.jobData = null;
  state.locked = false;
  state.duration = 0;
  state.needsRender = false;
  state.renderMode = null;
  state.selectedCueIndex = -1;
  state.clips = [];
  state.clipsSource = null;
  state.clipLoop = null;
  state.waveform = null;
  state.waveformLoading = false;
  if (state.transcriptSaveTimer) {
    clearTimeout(state.transcriptSaveTimer);
    state.transcriptSaveTimer = null;
  }
  resetPreviewOnly();

  const video = el('preview-video');
  video.pause();
  video.removeAttribute('src');
  video.load();
  el('upload-empty-video').hidden = false;
  el('file-meta-card').hidden = true;
  el('file-input').value = '';
  el('btn-generate').disabled = true;
  el('btn-generate').textContent = 'Generate captions';
  el('generate-hint').textContent = 'Choose a file to get started.';
  el('project-title').value = 'Untitled project';
  el('btn-export').disabled = true;
  if (el('btn-apply-render')) el('btn-apply-render').disabled = true;
  if (el('render-status-badge')) el('render-status-badge').hidden = true;
  hideProgressOverlay();
  renderCueList();
  el('trim-results').hidden = true;
  clearTimelineTracks();
  renderClipsList();
  updateClipsUiEnabled();

  qsa('#generate-form input, #generate-form select').forEach((i) => { i.disabled = false; });
  qsa('#template-grid .template-mini').forEach((b) => { b.disabled = false; });
  qsa('.seg', el('aspect-select')).forEach((b) => (b.disabled = false));
  el('template-note').textContent = 'Pick a look before you generate — the template locks in once rendering starts.';
}

function initRetryButton() {
  el('btn-retry')?.addEventListener('click', () => navigateToNew());
}

function initHomeButton() {
  el('btn-home')?.addEventListener('click', (e) => {
    // Logo returns to Projects dashboard (SPA), not marketing home.
    e.preventDefault();
    if (state.jobId && state.jobData?.status !== 'done' && state.jobData?.status !== 'error') {
      if (!window.confirm('A project is still generating. Leave anyway?')) return;
    }
    navigateToDashboard();
  });
}

function ensureEditorUserMenu() {
  const slot = el('editor-user-slot');
  if (slot && !slot.dataset.ready) {
    slot.innerHTML = userMenuButtonHtml();
    slot.dataset.ready = '1';
  }
  mountUserChrome();
}

export function consumePendingIntoEditor() {
  const file = takePendingMedia();
  if (file) handleFile(file);
  return file;
}

/**
 * @param {{ navigate?: (path: string) => void }} [opts]
 */
export async function initEditor(opts = {}) {
  if (typeof opts.navigate === 'function') navigateFn = opts.navigate;

  ensureEditorUserMenu();
  initTheme();
  initRail();
  initInspectorTabs();
  initMediaPanel();
  initScriptPills();
  initAspectSelect();
  initModePills();
  initSafeZone();
  initTransport();
  initAutoTrimSwitch();
  initCaptionStyleControls();
  initCueInspector();
  initClipsPanel();
  initTitleEditing();
  initExportPanel();
  initApplyRenderButton();
  initRetryButton();
  initHomeButton();

  el('generate-form')?.addEventListener('submit', submitGenerate);

  await loadMeta();
}

/**
 * @param {{ mode: 'new'|'project', id?: string }} route
 */
export async function showEditor(route) {
  const dash = el('view-dashboard');
  const editor = el('view-editor');
  if (dash) dash.hidden = true;
  if (editor) editor.hidden = false;
  document.title = 'Caption Engine — Editor';
  document.body.classList.add('editor');
  ensureEditorUserMenu();

  if (route.mode === 'project' && route.id) {
    if (state.jobId !== route.id) {
      await hydrateProject(route.id);
    }
    return;
  }

  // /app/new — draft workspace; pull pending File from dashboard handoff.
  if (!state.jobId) {
    resetForNewProject();
  } else if (route.mode === 'new') {
    resetForNewProject();
  }
  consumePendingIntoEditor();
}
