// Pure cache and rate-limit policy used by the service worker: what is fresh,
// what needs fetching, and whether a rate-limited request may go out now.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const FEED_TTL_MS = DAY;
const FEED_RETRY_MS = HOUR; // after a failed feed request
const LABEL_TTL_MS = 7 * DAY;
const HANDLE_TTL_MS = 30 * DAY; // handle -> channel ID, refreshed when used
export const HANDLE_TOUCH_MS = DAY; // how often a used mapping gets its timestamp refreshed
const VIDEO_LOOKUP_TTL_MS = 30 * DAY; // video -> channel via oEmbed
const NEGATIVE_LOOKUP_TTL_MS = DAY; // "could not be identified" results
const STALE_CHANNEL_MS = 7 * DAY;
const SUSPECT_LABEL_CHECKS = 2; // videos checked per suspected channel, so E is reachable

/**
 * Decides whether a rate-limited request may go out.
 * @param {{recent?: number[], backoffUntil?: number}|undefined} state persisted limiter state
 * @param {{minIntervalMs: number, maxPerHour: number}} limit
 * @returns {{retryAt: number, waitMs: number, recent: number[]}} retryAt > 0 means denied until then;
 *   otherwise wait waitMs, then record the request in `recent`.
 */
export function rateDecision(state, { minIntervalMs, maxPerHour }, now) {
  const recent = (state?.recent || []).filter((time) => now - time < HOUR);
  const backoffUntil = state?.backoffUntil || 0;
  if (backoffUntil > now) return { retryAt: backoffUntil, waitMs: 0, recent };
  if (recent.length >= maxPerHour) return { retryAt: recent[0] + HOUR, waitMs: 0, recent };
  const last = recent[recent.length - 1];
  const waitMs = last === undefined ? 0 : Math.max(0, last + minIntervalMs - now);
  return { retryAt: 0, waitMs, recent };
}

/**
 * State of a cached lookup ({id|handle|channelId..., at}).
 * @returns {'hit'|'negative'|'missing'} 'missing' also covers expired entries.
 */
function lookupState(entry, found, positiveTtlMs, now) {
  if (!entry || !Number.isFinite(entry.at)) return 'missing';
  const age = now - entry.at;
  if (found) return age < positiveTtlMs ? 'hit' : 'missing';
  return age < NEGATIVE_LOOKUP_TTL_MS ? 'negative' : 'missing';
}

export const handleLookupState = (entry, now) => lookupState(entry, Boolean(entry?.id), HANDLE_TTL_MS, now);
export const videoLookupState = (entry, now) =>
  lookupState(entry, Boolean(entry?.handle || entry?.channelId), VIDEO_LOOKUP_TTL_MS, now);

/** YouTube "Made with AI" results that are still fresh. */
export function labelCounts(record, now) {
  const count = (map) => Object.values(map || {}).filter((time) => now - time < LABEL_TTL_MS).length;
  return { checked: count(record?.labels?.checked), labeled: count(record?.labels?.labeled) };
}

/**
 * Recent videos of a suspected channel that still need a label check, newest first.
 * Checks (passive or active) of the last 7 days count toward SUSPECT_LABEL_CHECKS.
 */
export function labelCandidates(record, now) {
  const checked = record?.labels?.checked || {};
  const fresh = (videoId) => Number.isFinite(checked[videoId]) && now - checked[videoId] < LABEL_TTL_MS;
  const remaining = SUSPECT_LABEL_CHECKS - labelCounts(record, now).checked;
  if (remaining <= 0) return [];
  const recent = record?.analysis?.recentVideoIds || [record?.analysis?.latestVideoId];
  return recent.filter((videoId) => videoId && !fresh(videoId)).slice(0, remaining);
}

/**
 * Which network work would improve a channel's grade.
 * @returns {('feed'|'label')[]}
 */
export function channelWork({ channelId, record, grade, overridden, labelCheckEnabled, now }) {
  if (!channelId) return [];
  const work = [];
  const fresh = record?.feedFetchedAt && now - record.feedFetchedAt < FEED_TTL_MS;
  const recentError = record?.feedErrorAt && now - record.feedErrorAt < FEED_RETRY_MS;
  if (!fresh && !recentError) work.push('feed');

  const suspect = grade === 'C' || grade === 'D';
  if (labelCheckEnabled && suspect && !overridden && labelCandidates(record, now).length) {
    work.push('label');
  }
  return work;
}

/** Whether a cached channel record can be dropped. */
export function isStaleChannel(record, now) {
  const touched = Math.max(
    record?.feedFetchedAt || 0,
    record?.feedErrorAt || 0,
    record?.handleSeenAt || 0,
    ...Object.values(record?.labels?.checked || {}),
  );
  return now - touched > STALE_CHANNEL_MS;
}

/**
 * Combines two limiter states (e.g. stored and in-memory), keeping the stricter of each:
 * every request either side has seen, and the later backoff.
 */
export function mergeRateStates(a, b) {
  const recent = [...new Set([...(a?.recent || []), ...(b?.recent || [])])].filter(Number.isFinite).sort((x, y) => x - y);
  return { recent, backoffUntil: Math.max(a?.backoffUntil || 0, b?.backoffUntil || 0) };
}

/**
 * Total video count of a channel, from its handle mapping ({id, videoCount, videoCountAt}).
 * Only used while fresh and when the mapping belongs to the channel being graded.
 */
export function freshVideoCount(handleEntry, channelId, now) {
  if (!handleEntry || !Number.isFinite(handleEntry.videoCount) || !Number.isFinite(handleEntry.videoCountAt)) return null;
  if (channelId && handleEntry.id !== channelId) return null;
  return now - handleEntry.videoCountAt < HANDLE_TTL_MS ? handleEntry.videoCount : null;
}

/**
 * Drops label results older than LABEL_TTL_MS and keeps at most `max` per list, newest first.
 * The stored video IDs are browsing data, so they must not outlive their use.
 */
export function pruneLabels(labels, now, max = 50) {
  const keep = (map) =>
    Object.fromEntries(
      Object.entries(map || {})
        .filter(([, time]) => Number.isFinite(time) && now - time < LABEL_TTL_MS)
        .sort((a, b) => b[1] - a[1])
        .slice(0, max),
    );
  return { checked: keep(labels?.checked), labeled: keep(labels?.labeled) };
}
