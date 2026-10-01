// Caption Engine — thin fetch layer over /api/*. No caching, no storage.
// Every function returns a Promise resolving to parsed JSON, or throws an
// Error with a human-readable `.message` (server error/hint text when present).

const API_BASE = '/api';

/** @param {Response} res */
async function parseJsonOrThrow(res) {
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const message = body?.error || body?.hint || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.hint = body?.hint;
    err.body = body;
    throw err;
  }
  return body ?? {};
}

export async function fetchMeta() {
  const res = await fetch(`${API_BASE}/meta`);
  return parseJsonOrThrow(res);
}

export async function fetchHealth() {
  const res = await fetch(`${API_BASE}/health`);
  return parseJsonOrThrow(res);
}

/**
 * Create a captioning job. `formData` must include a `video` File field.
 * Returns `{ jobId, progressUrl }`.
 */
export async function createJob(formData, { onUploadProgress } = {}) {
  if (typeof onUploadProgress === 'function' && typeof XMLHttpRequest !== 'undefined') {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/jobs`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onUploadProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        let body = null;
        try { body = JSON.parse(xhr.responseText); } catch { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(body ?? {});
        } else {
          const err = new Error(body?.error || body?.hint || `Upload failed (${xhr.status})`);
          err.status = xhr.status;
          err.hint = body?.hint;
          reject(err);
        }
      };
      xhr.onerror = () => reject(new Error('Network error during upload.'));
      xhr.send(formData);
    });
  }

  const res = await fetch(`${API_BASE}/jobs`, { method: 'POST', body: formData });
  return parseJsonOrThrow(res);
}

/**
 * Open an SSE connection to /api/progress/:jobId.
 * `handlers` = { onEvent(evt), onError(err) }. Returns the EventSource so the
 * caller can `.close()` it.
 */
export function openProgressStream(jobId, { onEvent, onError } = {}) {
  const es = new EventSource(`${API_BASE}/progress/${encodeURIComponent(jobId)}`);
  es.onmessage = (msg) => {
    if (!msg.data) return;
    try {
      const evt = JSON.parse(msg.data);
      onEvent?.(evt);
    } catch {
      /* heartbeat / malformed frame — ignore */
    }
  };
  es.onerror = (err) => onError?.(err);
  return es;
}

export async function getJob(jobId) {
  const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}`);
  return parseJsonOrThrow(res);
}

export async function setProjectTitle(jobId, title) {
  const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectTitle: title }),
  });
  return parseJsonOrThrow(res);
}

export async function getTranscript(jobId) {
  const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}/transcript`);
  return parseJsonOrThrow(res);
}

/**
 * Persist in-editor transcript edits.
 * Body: `{ words }`, `{ cues }`, or `{ wordIndex, text, start?, end? }`.
 */
export async function updateTranscript(jobId, body) {
  const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}/transcript`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return parseJsonOrThrow(res);
}

export async function getCuts(jobId) {
  const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}/cuts`);
  return parseJsonOrThrow(res);
}

/** Real audio peak envelope for timeline track A1. */
export async function getWaveform(jobId) {
  const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}/waveform`);
  return parseJsonOrThrow(res);
}

export async function getClips(jobId) {
  const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}/clips`);
  return parseJsonOrThrow(res);
}

/** Find viral clip candidates (LLM when keyed, else rule-based). */
export async function generateClips(jobId) {
  const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}/clips/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return parseJsonOrThrow(res);
}

/** Export one clip as a captioned 9:16 reel. */
export async function exportClip(jobId, clipId) {
  const res = await fetch(
    `${API_BASE}/jobs/${encodeURIComponent(jobId)}/clips/${encodeURIComponent(clipId)}/export`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  return parseJsonOrThrow(res);
}

export async function setCutRestored(jobId, cutId, restored) {
  const res = await fetch(
    `${API_BASE}/jobs/${encodeURIComponent(jobId)}/cuts/${encodeURIComponent(cutId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restored }),
    },
  );
  return parseJsonOrThrow(res);
}

/**
 * Re-render a finished job from its cached transcript (no ASR).
 * `options` may include style, aspect, animationTemplate, toneStyle, template.
 * Progress streams on the existing SSE channel `/api/progress/:jobId`.
 */
export async function reRenderJob(jobId, options = {}) {
  const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options ?? {}),
  });
  return parseJsonOrThrow(res);
}

export function sourceUrl(jobId) {
  return `${API_BASE}/jobs/${encodeURIComponent(jobId)}/source`;
}

export function downloadUrl(jobId, format) {
  return `${API_BASE}/download/${encodeURIComponent(jobId)}/${encodeURIComponent(format)}`;
}

export async function deleteJob(jobId) {
  const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
  return parseJsonOrThrow(res);
}
