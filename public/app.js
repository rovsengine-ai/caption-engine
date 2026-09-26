/**
 * Caption Engine web UI
 *
 * Privacy: selected media is an in-memory File only.
 * No localStorage / sessionStorage / IndexedDB / Cache API / OPFS.
 */

/** @type {File | null} */
let currentFile = null;
/** @type {string | null} */
let objectUrl = null;
/** @type {EventSource | null} */
let eventSource = null;
/** @type {XMLHttpRequest | null} */
let activeUpload = null;
/** @type {Array<{value:string,label:string,description?:string,badge?:string}>} */
let providerMeta = [];

const TAGS = {
  step: '[STEP]',
  info: '[INFO]',
  warn: '[WARN]',
  error: '[ERROR]',
  done: '[DONE]',
  progress: '[PROGRESS]',
  queued: '[INFO]',
};

const FORMAT_LABELS = {
  mp4: 'MP4 Video',
  srt: 'SRT Subtitles',
  ass: 'ASS Subtitles',
  json: 'JSON Captions',
  transcript: 'Transcript JSON',
  clips: 'Clips JSON',
};

const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
};

const dropzone = $('dropzone');
const fileInput = /** @type {HTMLInputElement} */ ($('file-input'));
const preview = /** @type {HTMLVideoElement} */ ($('preview'));
const previewWrap = $('preview-wrap');
const dropEmpty = $('drop-empty');
const fileMeta = $('file-meta');
const btnClear = /** @type {HTMLButtonElement} */ ($('btn-clear'));
const btnPick = /** @type {HTMLButtonElement} */ ($('btn-pick'));
const btnGenerate = /** @type {HTMLButtonElement} */ ($('btn-generate'));
const form = /** @type {HTMLFormElement} */ ($('options-form'));
const languageSelect = /** @type {HTMLSelectElement} */ ($('language'));
const styleSelect = /** @type {HTMLSelectElement} */ ($('style'));
const providerSelect = /** @type {HTMLSelectElement} */ ($('provider'));
const providerHint = $('provider-hint');
const scriptInput = /** @type {HTMLInputElement} */ ($('script'));
const aspectInput = /** @type {HTMLInputElement} */ ($('aspect'));
const logEl = $('log');
const progressBar = $('progress-bar');
const progressLabel = $('progress-label');
const progressPct = $('progress-pct');
const jobStatus = $('job-status');
const uploadProgress = $('upload-progress');
const uploadPct = $('upload-pct');
const downloads = $('downloads');
const downloadLinks = $('download-links');

function revokePreviewUrl() {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}

function setStatus(kind, label) {
  jobStatus.textContent = label;
  jobStatus.className = `status ${kind}`;
}

function setProgress(pct, message) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  progressBar.style.width = `${clamped}%`;
  progressPct.textContent = `${Math.round(clamped)}%`;
  if (message) progressLabel.textContent = message;
}

function appendLog(kind, message) {
  const key = kind in TAGS ? kind : 'info';
  const li = document.createElement('li');
  li.className = key;
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = TAGS[key] || '[INFO]';
  const body = document.createElement('span');
  body.textContent = message;
  li.append(tag, body);
  logEl.appendChild(li);
  logEl.scrollTop = logEl.scrollHeight;
  while (logEl.children.length > 220) logEl.removeChild(logEl.firstChild);
}

function clearLog() {
  logEl.replaceChildren();
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateFileMetaPill() {
  if (!currentFile) {
    fileMeta.hidden = true;
    fileMeta.textContent = '';
    return;
  }
  const bits = [currentFile.name, formatBytes(currentFile.size)];
  const w = preview.videoWidth;
  const h = preview.videoHeight;
  const d = preview.duration;
  if (w && h) bits.splice(1, 0, `${w}×${h}`);
  if (Number.isFinite(d) && d > 0) bits.splice(w && h ? 2 : 1, 0, formatDuration(d));
  fileMeta.textContent = bits.filter(Boolean).join(' · ');
  fileMeta.hidden = false;
}

function setFile(file) {
  revokePreviewUrl();
  currentFile = file;

  if (!file) {
    previewWrap.hidden = true;
    preview.removeAttribute('src');
    preview.load();
    dropEmpty.hidden = false;
    dropzone.classList.remove('has-file');
    updateFileMetaPill();
    btnClear.disabled = true;
    btnGenerate.disabled = true;
    return;
  }

  objectUrl = URL.createObjectURL(file);
  preview.src = objectUrl;
  previewWrap.hidden = false;
  dropEmpty.hidden = true;
  dropzone.classList.add('has-file');
  updateFileMetaPill();
  btnClear.disabled = false;
  btnGenerate.disabled = false;
}

preview.addEventListener('loadedmetadata', updateFileMetaPill);

function closeEventSource() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function abortUpload() {
  if (activeUpload) {
    activeUpload.abort();
    activeUpload = null;
  }
}

function wireSegmented(containerId, hiddenInput) {
  const root = $(containerId);
  root.querySelectorAll('.seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      root.querySelectorAll('.seg').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      hiddenInput.value = btn.getAttribute('data-value') || '';
    });
  });
}

function updateProviderHint() {
  const selected = providerMeta.find((p) => p.value === providerSelect.value);
  providerHint.textContent = selected?.description || '';
}

async function loadMeta() {
  try {
    const res = await fetch('/api/meta');
    if (!res.ok) throw new Error(`meta ${res.status}`);
    const meta = await res.json();

    languageSelect.replaceChildren();
    for (const lang of meta.languages) {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = lang.code === 'auto'
        ? 'Auto-detect'
        : `${lang.name} (${lang.nativeName})`;
      languageSelect.appendChild(opt);
    }

    styleSelect.replaceChildren();
    for (const style of meta.styles) {
      const opt = document.createElement('option');
      opt.value = style;
      opt.textContent = style;
      styleSelect.appendChild(opt);
    }

    providerMeta = meta.providers || [];
    providerSelect.replaceChildren();
    for (const p of providerMeta) {
      const opt = document.createElement('option');
      opt.value = p.value;
      opt.textContent = p.badge ? `${p.label} · ${p.badge}` : p.label;
      providerSelect.appendChild(opt);
    }
    if (meta.defaultProvider) providerSelect.value = meta.defaultProvider;
    updateProviderHint();
  } catch {
    languageSelect.innerHTML = '<option value="auto">Auto-detect</option><option value="hi">Hindi</option><option value="en">English</option>';
    styleSelect.innerHTML = '<option value="default">default</option><option value="bold">bold</option>';
    providerSelect.innerHTML = '<option value="sarvam_fallback_elevenlabs">Sarvam AI + ElevenLabs Fallback</option><option value="elevenlabs">ElevenLabs Scribe</option>';
    providerHint.textContent = 'Sarvam first; ElevenLabs if Sarvam fails or lacks word timings.';
  }
}

function collectOptions() {
  const formats = [...form.querySelectorAll('input[name="formats"]:checked')]
    .map((el) => /** @type {HTMLInputElement} */ (el).value);

  if (formats.length === 0) {
    throw new Error('Select at least one output format.');
  }

  return {
    language: languageSelect.value || 'auto',
    script: scriptInput.value || 'native',
    style: styleSelect.value || 'default',
    aspect: aspectInput.value || 'portrait',
    provider: providerSelect.value || 'sarvam_fallback_elevenlabs',
    autoTrim: /** @type {HTMLInputElement} */ ($('auto-trim')).checked ? 'true' : 'false',
    codeSwitching: /** @type {HTMLInputElement} */ ($('code-switching')).checked ? 'true' : 'false',
    formats: formats.join(','),
  };
}

/**
 * @returns {Promise<{ jobId: string }>}
 */
function uploadJob(file, options) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    activeUpload = xhr;
    const body = new FormData();
    body.append('video', file, file.name);
    for (const [key, value] of Object.entries(options)) {
      body.append(key, value);
    }

    xhr.open('POST', '/api/jobs');
    xhr.responseType = 'json';

    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable) return;
      const pct = Math.round((ev.loaded / ev.total) * 100);
      uploadProgress.hidden = false;
      uploadPct.textContent = `${pct}%`;
      setProgress(Math.min(pct * 0.15, 15), `Uploading… ${pct}%`);
      setStatus('uploading', 'Uploading');
    };

    xhr.onload = () => {
      activeUpload = null;
      uploadProgress.hidden = true;
      const data = xhr.response ?? {};
      if (xhr.status >= 200 && xhr.status < 300 && data.jobId) {
        resolve(data);
        return;
      }
      reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };

    xhr.onerror = () => {
      activeUpload = null;
      reject(new Error('Network error during upload'));
    };

    xhr.onabort = () => {
      activeUpload = null;
      reject(new Error('Upload cancelled'));
    };

    xhr.send(body);
  });
}

async function fetchSize(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    const len = res.headers.get('content-length');
    return len ? Number(len) : NaN;
  } catch {
    return NaN;
  }
}

async function showDownloads(outputs) {
  downloadLinks.replaceChildren();
  const entries = Object.entries(outputs || {});
  if (entries.length === 0) {
    downloads.hidden = true;
    return;
  }

  downloads.hidden = false;
  for (const [format, url] of entries) {
    const card = document.createElement('article');
    card.className = 'dl-card';

    const header = document.createElement('header');
    const title = document.createElement('h4');
    title.textContent = FORMAT_LABELS[format] || format.toUpperCase();
    const sizeEl = document.createElement('span');
    sizeEl.className = 'size';
    sizeEl.textContent = '…';
    header.append(title, sizeEl);

    const actions = document.createElement('div');
    actions.className = 'dl-actions';

    const dl = document.createElement('a');
    dl.href = url;
    dl.download = '';
    dl.textContent = 'Download';

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy link';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(new URL(url, window.location.href).href);
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy link'; }, 1200);
      } catch {
        copy.textContent = 'Failed';
      }
    });

    actions.append(dl, copy);
    card.append(header, actions);
    downloadLinks.appendChild(card);

    const bytes = await fetchSize(url);
    sizeEl.textContent = formatBytes(bytes) || 'Ready';
  }
}

function connectProgress(jobId) {
  closeEventSource();
  setStatus('running', 'Running');
  setProgress(15, 'Connected — waiting for pipeline…');

  const es = new EventSource(`/api/progress/${jobId}`);
  eventSource = es;

  es.onmessage = (msg) => {
    let event;
    try {
      event = JSON.parse(msg.data);
    } catch {
      return;
    }

    switch (event.type) {
      case 'queued':
        appendLog('info', event.message);
        break;
      case 'step':
        appendLog('step', event.message);
        progressLabel.textContent = event.message;
        break;
      case 'info':
        appendLog('info', event.message);
        break;
      case 'warn':
        appendLog('warn', event.message);
        break;
      case 'progress':
        setProgress(15 + (Number(event.pct) || 0) * 0.84, event.message);
        appendLog('progress', `${Math.round(Number(event.pct) || 0)}% ${event.message}`);
        break;
      case 'done':
        appendLog('done', event.message);
        setProgress(100, event.message);
        setStatus('done', 'Done');
        void showDownloads(event.outputs);
        btnGenerate.disabled = !currentFile;
        closeEventSource();
        break;
      case 'error':
        appendLog('error', event.message);
        if (event.hint) appendLog('warn', event.hint);
        setStatus('error', 'Error');
        progressLabel.textContent = event.message;
        btnGenerate.disabled = !currentFile;
        closeEventSource();
        break;
      default:
        break;
    }
  };

  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      appendLog('warn', 'Progress stream closed');
    }
  };
}

async function onGenerate(ev) {
  ev.preventDefault();
  if (!currentFile) return;

  let options;
  try {
    options = collectOptions();
  } catch (err) {
    appendLog('error', err instanceof Error ? err.message : String(err));
    return;
  }

  abortUpload();
  closeEventSource();
  clearLog();
  downloads.hidden = true;
  downloadLinks.replaceChildren();
  btnGenerate.disabled = true;
  setStatus('uploading', 'Uploading');
  appendLog('step', `Uploading ${currentFile.name}`);
  appendLog('info', `Provider mode: ${options.provider}`);

  try {
    const { jobId } = await uploadJob(currentFile, options);
    appendLog('info', `Job ${jobId}`);
    connectProgress(jobId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog('error', message);
    setStatus('error', 'Error');
    progressLabel.textContent = message;
    btnGenerate.disabled = !currentFile;
  }
}

function onClear() {
  abortUpload();
  closeEventSource();
  clearLog();
  downloads.hidden = true;
  downloadLinks.replaceChildren();
  uploadProgress.hidden = true;
  setFile(null);
  setProgress(0, 'Waiting for media…');
  setStatus('idle', 'Idle');
}

function onUnload() {
  revokePreviewUrl();
  closeEventSource();
  abortUpload();
}

wireSegmented('script-pills', scriptInput);
wireSegmented('aspect-pills', aspectInput);
providerSelect.addEventListener('change', updateProviderHint);

dropzone.addEventListener('click', (ev) => {
  if (ev.target === preview || preview.contains(/** @type {Node} */ (ev.target))) return;
  fileInput.click();
});
dropzone.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    fileInput.click();
  }
});
dropzone.addEventListener('dragover', (ev) => {
  ev.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', (ev) => {
  if (ev.target === dropzone) dropzone.classList.remove('dragover');
});
dropzone.addEventListener('drop', (ev) => {
  ev.preventDefault();
  dropzone.classList.remove('dragover');
  const file = ev.dataTransfer?.files?.[0];
  if (file) setFile(file);
});

btnPick.addEventListener('click', () => fileInput.click());
btnClear.addEventListener('click', onClear);
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0] ?? null;
  fileInput.value = '';
  if (file) setFile(file);
});
form.addEventListener('submit', onGenerate);
window.addEventListener('pagehide', onUnload);
window.addEventListener('beforeunload', onUnload);

loadMeta();
setFile(null);
