// Storage keys and defaults shared by the service worker and the popup.

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  useBlocklist: true,
  labelCheck: true,
});

export const STORAGE_KEYS = Object.freeze({
  settings: 'settings',
  overrides: 'overrides', // { [channelId | "@handle"]: {value, channelId, handle, title, at} }
  blocklist: 'blocklist', // { handles: string[], ids: string[] }
  blocklistMeta: 'blocklistMeta', // { fetchedAt, count, lastAttemptAt, error }
  cacheEpoch: 'cacheEpoch', // bumped by "Clear cache" so open tabs re-request grades
});

// Per-item cache prefixes in chrome.storage.local.
export const CHANNEL_PREFIX = 'ch:'; // channelId -> feed analysis + label results
export const HANDLE_PREFIX = 'h2c:'; // handle -> {id, at}
export const VIDEO_PREFIX = 'vh:'; // videoId -> {handle, channelId, at} (from oEmbed)
export const RATE_PREFIX = 'rate:'; // rate limiter state

export function withDefaultSettings(stored) {
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}
