/**
 * Browser-side ASR API key store.
 * Keys only — never videos, blobs, or transcripts.
 */

const STORAGE_KEY = 'ce_asr_keys_v1';

/** @typedef {{ sarvamApiKey: string, elevenlabsApiKey: string, deepgramApiKey: string }} ApiKeys */

/** @returns {ApiKeys} */
export function loadApiKeys() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyKeys();
    const parsed = JSON.parse(raw);
    return {
      sarvamApiKey: typeof parsed.sarvamApiKey === 'string' ? parsed.sarvamApiKey : '',
      elevenlabsApiKey: typeof parsed.elevenlabsApiKey === 'string' ? parsed.elevenlabsApiKey : '',
      deepgramApiKey: typeof parsed.deepgramApiKey === 'string' ? parsed.deepgramApiKey : '',
    };
  } catch {
    return emptyKeys();
  }
}

/** @returns {ApiKeys} */
function emptyKeys() {
  return { sarvamApiKey: '', elevenlabsApiKey: '', deepgramApiKey: '' };
}

/** @param {Partial<ApiKeys>} partial */
export function saveApiKeys(partial) {
  const next = { ...loadApiKeys(), ...partial };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sarvamApiKey: String(next.sarvamApiKey || '').trim(),
      elevenlabsApiKey: String(next.elevenlabsApiKey || '').trim(),
      deepgramApiKey: String(next.deepgramApiKey || '').trim(),
    }));
  } catch {
    /* private mode / quota */
  }
  return loadApiKeys();
}

export function clearApiKeys() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}

/** True when at least one primary ASR key is present (Sarvam or ElevenLabs). */
export function hasPrimaryApiKey() {
  const k = loadApiKeys();
  return Boolean(k.sarvamApiKey.trim() || k.elevenlabsApiKey.trim());
}

/** Append non-empty keys onto a FormData for /api/jobs. */
export function appendApiKeysToFormData(formData) {
  const k = loadApiKeys();
  if (k.sarvamApiKey) formData.append('sarvamApiKey', k.sarvamApiKey);
  if (k.elevenlabsApiKey) formData.append('elevenlabsApiKey', k.elevenlabsApiKey);
  if (k.deepgramApiKey) formData.append('deepgramApiKey', k.deepgramApiKey);
}

export function maskKey(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (v.length <= 8) return '••••••••';
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}
