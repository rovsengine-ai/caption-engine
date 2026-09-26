/**
 * Ephemeral pending media handoff between Dashboard → Editor.
 * In-memory File only — never serialized.
 */

/** @type {File | null} */
let pending = null;

/** @param {File | null} file */
export function setPendingMedia(file) {
  pending = file || null;
}

/** Take and clear the pending file (single-use). */
export function takePendingMedia() {
  const f = pending;
  pending = null;
  return f;
}

export function peekPendingMedia() {
  return pending;
}
