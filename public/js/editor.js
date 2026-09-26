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
  getCuts,
  setCutRestored,
  sourceUrl,
  downloadUrl,
} from './api.js';
import { takePendingMedia } from './pending-media.js';
import { upsertProject, getProject } from './projects-store.js';
import { mountUserChrome, userMenuButtonHtml, openAccountModal } from './user-session.js';
import {
  hasPrimaryApiKey,
  loadApiKeys,
  saveApiKeys,
  appendApiKeysToFormData,
} from './api-keys.js';

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
  captionsEnabled: true,
  maxWordsPerCue: 4,
  intelligentCaptions: true,
  captionDelayMs: 0,
  delayScope: 'all',
  selectWordsMode: false,
  selectedCueIndexes: new Set(),
  /** Snapshot of words at first transcript load — used by Reset to original. */
  originalWords: null,
  pendingGenerateDemo: false,
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
      if (state.locked) {
        toast('Template locks in once a project starts. Create a new project to change it.', 'info');
        return;
      }
      state.selectedTemplate = t.id;
      qsa('.template-mini', grid).forEach((b) => b.classList.toggle('active', b === btn));
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
  el('template-note').textContent = 'Template locked for this project.';
  qsa('.seg', el('aspect-select')).forEach((b) => (b.disabled = true));
}

function openApiKeyModal() {
  const modal = el('apikey-modal');
  if (!modal) return;
  const keys = loadApiKeys();
  const s = el('modal-key-sarvam');
  const e11 = el('modal-key-eleven');
  if (s && !s.value) s.placeholder = keys.sarvamApiKey ? '•••• saved' : 'SARVAM_API_KEY';
  if (e11 && !e11.value) e11.placeholder = keys.elevenlabsApiKey ? '•••• saved' : 'ELEVENLABS_API_KEY';
  modal.hidden = false;
  document.body.classList.add('modal-open');
}

function closeApiKeyModal() {
  const modal = el('apikey-modal');
  if (!modal) return;
  modal.hidden = true;
  if (!document.getElementById('account-modal') || document.getElementById('account-modal').hidden) {
    document.body.classList.remove('modal-open');
  }
}

function isMissingKeyError(err) {
  if (!err) return false;
  if (err.body?.code === 'missing_api_key' || err.code === 'missing_api_key') return true;
  const msg = String(err.message || err || '');
  return /api key/i.test(msg) && /sarvam|elevenlabs|transcribe/i.test(msg);
}

async function submitGenerate(e, { forceDemo = false } = {}) {
  e?.preventDefault?.();
  if (!state.mediaFile) { toast('Choose a video or audio file first.', 'error'); return; }

  const useDemo = forceDemo || state.pendingGenerateDemo;
  if (!useDemo && !hasPrimaryApiKey()) {
    openApiKeyModal();
    return;
  }

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
  formData.append('maxWordsPerCue', String(state.maxWordsPerCue));
  if (useDemo) formData.append('demoMode', 'true');
  else appendApiKeysToFormData(formData);

  state.pendingGenerateDemo = false;
  closeApiKeyModal();
  lockGenerateInputs();
  el('btn-generate').disabled = true;
  el('btn-generate').textContent = 'Uploading…';
  showProgressOverlay();
  setProgress(0, useDemo ? 'Starting demo sample…' : 'Uploading your file…');

  try {
    const { jobId } = await createJob(formData, {
      onUploadProgress: (frac) => setProgress(Math.round(frac * 15), 'Uploading your file…'),
    });
    state.jobId = jobId;
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
    if (isMissingKeyError(err)) {
      hideProgressOverlay();
      unlockGenerateSoft();
      openApiKeyModal();
      toast(err.message || 'API key required.', 'error');
      return;
    }
    showProgressError(err.message || 'Upload failed.', err.hint);
  }
}

function unlockGenerateSoft() {
  state.locked = false;
  qsa('#generate-form input, #generate-form select, #generate-form button[type="button"]').forEach((i) => {
    i.disabled = false;
  });
  el('dropzone')?.removeAttribute('aria-disabled');
  qsa('.seg', el('aspect-select')).forEach((b) => { b.disabled = false; });
  el('btn-generate').disabled = !state.mediaFile;
  el('btn-generate').textContent = 'Generate captions';
  el('generate-hint').textContent = state.mediaFile
    ? 'Ready — review options, then generate.'
    : 'Choose a file to get started.';
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

function showProgressError(message, hint, code) {
  const missingKey = code === 'missing_api_key' || isMissingKeyError({ message, code });
  if (missingKey) {
    hideProgressOverlay();
    unlockGenerateSoft();
    openApiKeyModal();
    toast(message || 'API key required to transcribe audio.', 'error');
    return;
  }
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
      showProgressError(evt.message, evt.hint, evt.code);
      break;
    default:
      break;
  }
}

async function onJobDone(jobId) {
  hideProgressOverlay();
  el('btn-generate').textContent = 'Generated ✓';
  toast('Captions generated.', 'success');
  await refreshJobData(jobId);
  await loadTranscriptAndCuts(jobId);
  ensureVideoSource(jobId);
  el('btn-export').disabled = false;
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
    await loadTranscriptAndCuts(jobId);
  } else if (job.status === 'error') {
    showProgressError(job.error || 'Generation failed.');
  } else {
    showProgressOverlay();
    setProgress(50, 'Reconnecting to your project…');
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

function wordLabel(w) {
  return state.script === 'roman' && w.roman ? w.roman : w.text;
}

function cueDelaySec(cue) {
  if (cue && Number.isFinite(cue.delayMs)) return cue.delayMs / 1000;
  return (state.captionDelayMs || 0) / 1000;
}

function cueTimeWithDelay(sec, cue) {
  return Math.max(0, Number(sec) + cueDelaySec(cue));
}

function buildCues(words) {
  const MAX_WORDS = Math.max(1, Math.min(12, state.maxWordsPerCue || 4));
  const GAP = state.intelligentCaptions ? 0.45 : 0.85;
  const SENTENCE_END = /[.!?।॥]$/;
  const spoken = (words ?? []).filter((w) => w.type === 'word' && w.keep !== false);
  const groups = [];
  let current = null;
  for (let i = 0; i < spoken.length; i++) {
    const w = spoken[i];
    if (!current) current = { words: [] };
    current.words.push(w);
    const next = spoken[i + 1];
    if (!next) continue;
    const gap = next.start - w.end;
    const atLimit = current.words.length >= MAX_WORDS;
    const sentenceBreak = state.intelligentCaptions && SENTENCE_END.test(String(w.text || '').trim());
    if (gap >= GAP || atLimit || sentenceBreak) {
      groups.push(current);
      current = null;
    }
  }
  if (current) groups.push(current);

  return groups.map((g, i) => ({
    index: i,
    start: g.words[0].start,
    end: g.words[g.words.length - 1].end,
    words: g.words,
    text: g.words.map(wordLabel).join(' '),
  }));
}

function updateTextMeta() {
  const meta = el('text-meta');
  if (!meta) return;
  if (!state.cues.length) {
    meta.textContent = 'No captions yet';
    return;
  }
  const lang = state.transcript?.language || state.transcript?.detectedLanguageRaw || 'auto';
  const script = state.script === 'roman' ? 'roman' : 'native';
  meta.textContent = `${state.cues.length} lines · ${lang} · ${script}`;
}

function regenerateCuesFromWords() {
  if (!state.transcript?.words?.length && !state.originalWords?.length) {
    toast('Generate captions first.', 'error');
    return;
  }
  const words = state.transcript?.words || state.originalWords;
  state.cues = buildCues(words);
  state.selectedCueIndexes.clear();
  renderCueList();
  buildTimeline();
  updateTextMeta();
  updateCaptionOverlay(el('preview-video')?.currentTime || 0);
}

async function loadTranscriptAndCuts(jobId) {
  try {
    state.transcript = await getTranscript(jobId);
    if (!state.originalWords) {
      state.originalWords = structuredClone(state.transcript.words);
    }
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
  updateTextMeta();
  if (el('btn-generate-layer')) el('btn-generate-layer').disabled = false;
}

function seekToCue(cue) {
  const video = el('preview-video');
  if (!video || !cue) return;
  video.currentTime = cueTimeWithDelay(cue.start, cue);
  if (video.paused) video.play().catch(() => {});
  state.activeCueIndex = -1;
  updateCaptionOverlay(video.currentTime);
  updatePlayhead(video.currentTime);
}

function renderCueList() {
  const list = el('cue-list');
  if (!list) return;
  list.innerHTML = '';
  list.classList.toggle('select-mode', state.selectWordsMode);
  updateTextMeta();
  if (!state.cues.length) {
    list.innerHTML = '<div class="empty-state"><div class="es-ic">📝</div>No cues yet.</div>';
    return;
  }
  for (const cue of state.cues) {
    const row = document.createElement('div');
    const selected = state.selectedCueIndexes.has(cue.index);
    row.className = `cue-item${selected ? ' selected' : ''}`;
    row.setAttribute('data-cue-index', String(cue.index));
    row.innerHTML = `
      <div class="cue-card-head">
        <span class="cue-num">${cue.index + 1}</span>
        <span class="cue-time">${formatTime(cueTimeWithDelay(cue.start, cue))} → ${formatTime(cueTimeWithDelay(cue.end, cue))}</span>
      </div>
      <div class="cue-text" contenteditable="true" spellcheck="false" role="textbox">${escapeHtml(cue.text)}</div>
    `;
    row.addEventListener('click', (e) => {
      if (e.target.closest('.cue-text')) return;
      if (state.selectWordsMode) {
        if (state.selectedCueIndexes.has(cue.index)) state.selectedCueIndexes.delete(cue.index);
        else state.selectedCueIndexes.add(cue.index);
        row.classList.toggle('selected', state.selectedCueIndexes.has(cue.index));
        return;
      }
      seekToCue(cue);
    });
    const textEl = qs('.cue-text', row);
    textEl.addEventListener('blur', () => {
      const next = textEl.textContent?.trim() || '';
      if (next === cue.text) return;
      cue.text = next;
      // Keep word timings; treat edit as display override.
      if (cue.words?.length === 1) cue.words[0].text = next;
      buildTimeline();
      updateCaptionOverlay(el('preview-video')?.currentTime || 0);
    });
    textEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        textEl.blur();
      }
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
        toast(nextRestored ? 'Cut restored — will be kept in export.' : 'Cut re-applied.', 'success');
      } catch (err) {
        toast(err.message || 'Could not update cut.', 'error');
      }
    });
    list.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Bottom timeline — ruler + V1 (cuts) / T1 (cues) / A1 (mock waveform)
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
    clip.className = 't-clip tl-clip';
    clip.style.left = `${40 + cue.start * px}px`;
    clip.style.width = `${Math.max((cue.end - cue.start) * px - 2, 24)}px`;
    clip.textContent = cue.text;
    clip.title = cue.text;
    clip.setAttribute('data-cue-index', String(cue.index));
    clip.addEventListener('click', (e) => {
      e.stopPropagation();
      seekToCue(cue);
    });
    t1.appendChild(clip);
  }

  // A1 — decorative mock waveform (deterministic pseudo-random bars)
  const a1 = el('track-a1');
  a1.innerHTML = '';
  const wf = document.createElement('div');
  wf.className = 'tl-clip a-clip';
  wf.style.left = '40px';
  wf.style.width = `${Math.max(duration * px - 2, 20)}px`;
  const bars = Math.max(20, Math.floor(duration * 3));
  for (let i = 0; i < bars; i++) {
    const bar = document.createElement('div');
    bar.className = 'a-bar';
    const seed = Math.sin(i * 12.9898) * 43758.5453;
    const h = 20 + (Math.abs(seed % 1) * 70);
    bar.style.height = `${h}%`;
    wf.appendChild(bar);
  }
  a1.appendChild(wf);

  // Seeking by clicking the ruler / V1 / A1 / empty track space
  const seekFromEvent = (e) => {
    if (e.target.closest('.t-clip')) return;
    const innerRect = inner.getBoundingClientRect();
    const relX = e.clientX - innerRect.left - 40;
    const t = Math.max(0, Math.min(duration, relX / px));
    const video = el('preview-video');
    video.currentTime = t;
    updatePlayhead(t);
    updateCaptionOverlay(t);
  };
  inner.onclick = seekFromEvent;
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
  return state.cues.findIndex((c) => {
    const d = cueDelaySec(c);
    return t >= c.start + d && t < c.end + d;
  });
}

function updateCaptionOverlay(t) {
  const overlay = el('caption-overlay');
  if (overlay) overlay.hidden = !state.captionsEnabled;
  if (!state.captionsEnabled) {
    el('caption-text').innerHTML = '';
    return;
  }

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
  cueRow?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const tClip = qs(`.t-clip[data-cue-index="${idx}"]`, el('track-t1'));
  tClip?.classList.add('active');

  highlightActiveWord(t, state.cues[idx]);
}

function highlightActiveWord(t, cue) {
  const delay = cueDelaySec(cue);
  // Prefer edited cue text when it no longer matches word join.
  const joined = (cue.words || []).map(wordLabel).join(' ');
  if (cue.text && cue.text !== joined) {
    el('caption-text').textContent = cue.text;
    return;
  }
  const html = cue.words
    .map((w) => {
      const label = escapeHtml(wordLabel(w));
      const active = t >= (w.start + delay) && t < (w.end + delay);
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
  }, { lockable: true });
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
  hideProgressOverlay();
  renderCueList();
  el('trim-results').hidden = true;
  clearTimelineTracks();

  qsa('#generate-form input, #generate-form select').forEach((i) => { i.disabled = false; });
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

function syncMaxWordsUi() {
  const label = el('max-words-value');
  if (label) label.textContent = String(state.maxWordsPerCue);
}

function initTextPanel() {
  el('f-captions-enabled')?.addEventListener('change', (e) => {
    state.captionsEnabled = e.target.checked;
    updateCaptionOverlay(el('preview-video')?.currentTime || 0);
  });

  el('max-words-dec')?.addEventListener('click', () => {
    state.maxWordsPerCue = Math.max(1, state.maxWordsPerCue - 1);
    syncMaxWordsUi();
    if (state.transcript?.words?.length) regenerateCuesFromWords();
  });
  el('max-words-inc')?.addEventListener('click', () => {
    state.maxWordsPerCue = Math.min(12, state.maxWordsPerCue + 1);
    syncMaxWordsUi();
    if (state.transcript?.words?.length) regenerateCuesFromWords();
  });
  syncMaxWordsUi();

  el('f-intelligent')?.addEventListener('change', (e) => {
    state.intelligentCaptions = e.target.checked;
    if (state.transcript?.words?.length) regenerateCuesFromWords();
  });
  el('intelligent-tip')?.addEventListener('click', () => {
    toast('Uses audio prosody and natural semantic clauses for natural sentence breaks.', 'info');
  });

  wireSegmented(el('delay-scope'), (value) => {
    state.delayScope = value;
  });

  const delay = el('caption-delay');
  const delayLabel = el('caption-delay-value');
  delay?.addEventListener('input', () => {
    const ms = Number(delay.value) || 0;
    if (delayLabel) delayLabel.textContent = `${ms} ms`;
    if (state.delayScope === 'selected' && state.selectedCueIndexes.size) {
      for (const idx of state.selectedCueIndexes) {
        const cue = state.cues[idx];
        if (cue) cue.delayMs = ms;
      }
      renderCueList();
      buildTimeline();
      updateCaptionOverlay(el('preview-video')?.currentTime || 0);
      return;
    }
    state.captionDelayMs = ms;
    renderCueList();
    updateCaptionOverlay(el('preview-video')?.currentTime || 0);
  });

  el('btn-reset-cues')?.addEventListener('click', () => {
    if (!state.originalWords?.length) {
      toast('Nothing to reset yet.', 'error');
      return;
    }
    if (state.transcript) state.transcript.words = structuredClone(state.originalWords);
    state.captionDelayMs = 0;
    if (delay) delay.value = '0';
    if (delayLabel) delayLabel.textContent = '0 ms';
    regenerateCuesFromWords();
    toast('Restored original transcription.', 'success');
  });

  el('btn-regenerate-cues')?.addEventListener('click', () => {
    regenerateCuesFromWords();
    toast('Captions regenerated with current settings.', 'success');
  });

  el('btn-select-words')?.addEventListener('click', () => {
    state.selectWordsMode = !state.selectWordsMode;
    el('btn-select-words')?.classList.toggle('active', state.selectWordsMode);
    if (!state.selectWordsMode) state.selectedCueIndexes.clear();
    renderCueList();
  });

  el('btn-generate-layer')?.addEventListener('click', () => {
    if (state.cues.length) {
      toast('Layer captions are ready — use Export when you are done editing.', 'info');
      return;
    }
    el('btn-generate')?.click();
  });
}

function initApiKeyUi() {
  el('btn-api-keys')?.addEventListener('click', () => openAccountModal('keys'));

  el('apikey-modal')?.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.hasAttribute('data-close-apikey') || t.closest('[data-close-apikey]')) {
      closeApiKeyModal();
    }
  });

  el('btn-save-continue-generate')?.addEventListener('click', () => {
    const sarvam = el('modal-key-sarvam')?.value?.trim();
    const eleven = el('modal-key-eleven')?.value?.trim();
    if (!sarvam && !eleven && !hasPrimaryApiKey()) {
      toast('Enter a Sarvam or ElevenLabs key first.', 'error');
      return;
    }
    const patch = {};
    if (sarvam) patch.sarvamApiKey = sarvam;
    if (eleven) patch.elevenlabsApiKey = eleven;
    if (Object.keys(patch).length) saveApiKeys(patch);
    closeApiKeyModal();
    submitGenerate(null, { forceDemo: false });
  });

  el('btn-demo-mode')?.addEventListener('click', () => {
    state.pendingGenerateDemo = true;
    closeApiKeyModal();
    submitGenerate(null, { forceDemo: true });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeApiKeyModal();
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
  initTitleEditing();
  initExportPanel();
  initRetryButton();
  initHomeButton();
  initTextPanel();
  initApiKeyUi();

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
