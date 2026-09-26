/**
 * Caption Engine web UI
 *
 * Privacy contract: the selected video is held only as an in-memory File.
 * No localStorage, sessionStorage, IndexedDB, Cache API, or OPFS is used.
 * Preview uses URL.createObjectURL / revokeObjectURL only.
 */

/** @type {File | null} */
let currentFile = null;
/** @type {string | null} */
let objectUrl = null;
/** @type {EventSource | null} */
let eventSource = null;
/** @type {XMLHttpRequest | null} */
let activeUpload = null;

const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
};

const dropzone = $('dropzone');
const fileInput = /** @type {HTMLInputElement} */ ($('file-input'));
const preview = /** @type {HTMLVideoElement} */ ($('preview'));
const dropEmpty = $('drop-empty');
const fileMeta = $('file-meta');
const btnClear = /** @type {HTMLButtonElement} */ ($('btn-clear'));
const btnPick = /** @type {HTMLButtonElement} */ ($('btn-pick'));
const btnGenerate = /** @type {HTMLButtonElement} */ ($('btn-generate'));
const form = /** @type {HTMLFormElement} */ ($('options-form'));
const languageSelect = /** @type {HTMLSelectElement} */ ($('language'));
const styleSelect = /** @type {HTMLSelectElement} */ ($('style'));
const logEl = $('log');
const progressBar = $('progress-bar');
const progressLabel = $('progress-label');
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
  jobStatus.className = `status-pill ${kind}`;
}

function setProgress(pct, message) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  progressBar.style.width = `${clamped}%`;
  if (message) progressLabel.textContent = message;
}

function appendLog(kind, message) {
  const li = document.createElement('li');
  li.className = kind;
  li.textContent = message;
  logEl.appendChild(li);
  logEl.scrollTop = logEl.scrollHeight;
  while (logEl.children.length > 200) {
    logEl.removeChild(logEl.firstChild);
  }
}

function clearLog() {
  logEl.replaceChildren();
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function setFile(file) {
  revokePreviewUrl();
  currentFile = file;

  if (!file) {
    preview.hidden = true;
    preview.removeAttribute('src');
    preview.load();
    dropEmpty.hidden = false;
    dropzone.classList.remove('has-file');
    fileMeta.textContent = '';
    btnClear.disabled = true;
    btnGenerate.disabled = true;
    return;
  }

  objectUrl = URL.createObjectURL(file);
  preview.src = objectUrl;
  preview.hidden = false;
  dropEmpty.hidden = true;
  dropzone.classList.add('has-file');
  fileMeta.textContent = `${file.name} · ${formatBytes(file.size)}`;
  btnClear.disabled = false;
  btnGenerate.disabled = false;
}

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

function resetJobUi() {
  closeEventSource();
  downloads.hidden = true;
  downloadLinks.replaceChildren();
  uploadProgress.hidden = true;
  uploadPct.textContent = '0%';
  setProgress(0, 'Ready');
  setStatus('idle', 'Idle');
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
  } catch {
    languageSelect.innerHTML = '<option value="auto">Auto-detect</option><option value="hi">Hindi</option><option value="en">English</option>';
    styleSelect.innerHTML = '<option value="default">default</option><option value="bold">bold</option>';
  }
}

function collectOptions() {
  const fd = new FormData(form);
  const formats = [...form.querySelectorAll('input[name="formats"]:checked')]
    .map((el) => /** @type {HTMLInputElement} */ (el).value);

  if (formats.length === 0) {
    throw new Error('Select at least one output format.');
  }

  return {
    language: String(fd.get('language') || 'auto'),
    script: String(fd.get('script') || 'native'),
    style: String(fd.get('style') || 'default'),
    aspect: String(fd.get('aspect') || 'portrait'),
    autoTrim: form.querySelector('#auto-trim')?.checked ? 'true' : 'false',
    codeSwitching: form.querySelector('#code-switching')?.checked ? 'true' : 'false',
    formats: formats.join(','),
  };
}

/**
 * Upload with progress via XHR (fetch cannot report upload progress).
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

function showDownloads(outputs) {
  downloadLinks.replaceChildren();
  const entries = Object.entries(outputs || {});
  if (entries.length === 0) {
    downloads.hidden = true;
    return;
  }
  for (const [format, url] of entries) {
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    a.textContent = `Download .${format}`;
    downloadLinks.appendChild(a);
  }
  downloads.hidden = false;
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
        // Map engine 0–100 into remaining 15–99 of the overall bar.
        setProgress(15 + (Number(event.pct) || 0) * 0.84, event.message);
        break;
      case 'done':
        appendLog('done', event.message);
        setProgress(100, event.message);
        setStatus('done', 'Done');
        showDownloads(event.outputs);
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
    // EventSource reconnects automatically; only surface if job likely gone.
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

function onPickClick() {
  fileInput.click();
}

function onFileInputChange() {
  const file = fileInput.files?.[0] ?? null;
  // Allow re-selecting the same file later.
  fileInput.value = '';
  if (file) setFile(file);
}

function onDropzoneKey(ev) {
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    fileInput.click();
  }
}

function onDragOver(ev) {
  ev.preventDefault();
  dropzone.classList.add('dragover');
}

function onDragLeave(ev) {
  if (ev.target === dropzone) dropzone.classList.remove('dragover');
}

function onDrop(ev) {
  ev.preventDefault();
  dropzone.classList.remove('dragover');
  const file = ev.dataTransfer?.files?.[0];
  if (file) setFile(file);
}

function onClear() {
  abortUpload();
  resetJobUi();
  clearLog();
  setFile(null);
  setProgress(0, 'Waiting for a video…');
}

function onUnload() {
  revokePreviewUrl();
  closeEventSource();
  abortUpload();
}

dropzone.addEventListener('click', (ev) => {
  if (ev.target === preview || preview.contains(/** @type {Node} */ (ev.target))) return;
  fileInput.click();
});
dropzone.addEventListener('keydown', onDropzoneKey);
dropzone.addEventListener('dragover', onDragOver);
dropzone.addEventListener('dragleave', onDragLeave);
dropzone.addEventListener('drop', onDrop);

btnPick.addEventListener('click', onPickClick);
btnClear.addEventListener('click', onClear);
fileInput.addEventListener('change', onFileInputChange);
form.addEventListener('submit', onGenerate);
window.addEventListener('pagehide', onUnload);
window.addEventListener('beforeunload', onUnload);

loadMeta();
setFile(null);
