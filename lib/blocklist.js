// AiSList community blocklist parsing and handle normalization.
// https://github.com/Override92/AiSList

const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE_RE = /^[^\s/?#@]{1,100}$/u;

/** Normalizes "@Name", "/@Name" or a percent-encoded handle to a lowercase handle without "@". */
export function normalizeHandle(raw) {
  if (typeof raw !== 'string') return null;
  let handle = raw.trim().replace(/^\/?@/, '');
  try {
    handle = decodeURIComponent(handle);
  } catch {
    // Keep the raw value when it is not valid percent-encoding.
  }
  handle = handle.toLowerCase();
  return HANDLE_RE.test(handle) ? handle : null;
}

/**
 * Parses the list: "@handle" and "UC..." lines are entries; "!" comments, blank lines
 * and anything else are skipped. Handles are lowercased; channel IDs are case-sensitive.
 */
export function parseBlocklist(text) {
  const handles = new Set();
  const ids = new Set();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('@')) {
      const handle = normalizeHandle(line);
      if (handle) handles.add(handle);
    } else if (CHANNEL_ID_RE.test(line)) {
      ids.add(line);
    }
  }
  return { handles: [...handles], ids: [...ids] };
}
