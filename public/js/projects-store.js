/**
 * Lightweight project metadata store.
 *
 * Stores ONLY small JSON fields (id, title, duration, aspect, timestamps).
 * Never stores File/Blob/ArrayBuffer/video bytes. Safe for sessionStorage.
 */

const STORAGE_KEY = 'ce_projects_meta_v1';
const QUOTA_KEY = 'ce_plan_quota_v1';

/** @typedef {{
 *   id: string,
 *   title: string,
 *   durationSec: number,
 *   aspect: 'portrait'|'landscape'|'square'|'original',
 *   createdAt: number,
 *   updatedAt: number,
 *   status?: string,
 *   posterColor?: string,
 * }} ProjectMeta */

function readList() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return /** @type {ProjectMeta[]} */ ([]);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeList(list) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, 40)));
  } catch {
    /* quota / private mode — ignore; in-memory callers still work for the session */
  }
}

/** @returns {ProjectMeta[]} */
export function listProjects() {
  return readList().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** @param {Partial<ProjectMeta> & { id: string }} patch */
export function upsertProject(patch) {
  const list = readList();
  const now = Date.now();
  const idx = list.findIndex((p) => p.id === patch.id);
  if (idx >= 0) {
    list[idx] = {
      ...list[idx],
      ...patch,
      updatedAt: patch.updatedAt ?? now,
    };
  } else {
    list.unshift({
      id: patch.id,
      title: patch.title || 'Untitled project',
      durationSec: Number(patch.durationSec) || 0,
      aspect: patch.aspect || 'portrait',
      createdAt: patch.createdAt || now,
      updatedAt: patch.updatedAt || now,
      status: patch.status || 'done',
      posterColor: patch.posterColor || pickPosterColor(patch.id),
    });
  }
  writeList(list);
  return list[idx >= 0 ? idx : 0];
}

export function removeProject(id) {
  writeList(readList().filter((p) => p.id !== id));
}

export function getProject(id) {
  return readList().find((p) => p.id === id) || null;
}

export function projectsStats() {
  const list = listProjects();
  const footageSec = list.reduce((n, p) => n + (Number(p.durationSec) || 0), 0);
  return {
    count: list.length,
    footageSec,
    captionMinutesLeft: getQuota().captionMinutesLeft,
    plan: getQuota().plan,
  };
}

function pickPosterColor(id) {
  const colors = ['#0f766e', '#155e75', '#365314', '#713f12', '#3f3f46', '#1e3a5f'];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return colors[h % colors.length];
}

export function getQuota() {
  try {
    const raw = sessionStorage.getItem(QUOTA_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {
    plan: 'Free',
    captionMinutesLeft: 0,
    autoTrimMinutesLeft: 0,
    captionMinutesTotal: 0,
    autoTrimMinutesTotal: 0,
  };
}

export function setQuota(partial) {
  const next = { ...getQuota(), ...partial };
  try {
    sessionStorage.setItem(QUOTA_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  return next;
}

export function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function formatRelative(ts) {
  const diff = Date.now() - Number(ts || 0);
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 45) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function aspectLabel(aspect) {
  if (aspect === 'portrait') return '9:16';
  if (aspect === 'landscape') return '16:9';
  if (aspect === 'square') return '1:1';
  return 'original';
}
