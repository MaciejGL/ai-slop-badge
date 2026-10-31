// Pure grading logic shared by the service worker and the node tests.
// Grades: A (checked, nothing found) ... E (fully AI-generated), null = pending.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// Feed heuristics
const FEED_MAX_ENTRIES = 15; // YouTube's RSS feed returns at most 15 entries
const MIN_ENTRIES_FOR_RATE = 5;
const HIGH_UPLOAD_RATE_PER_DAY = 2;
const BURST_MIN_UPLOADS = 3;
const BURST_WINDOW_MS = 2 * HOUR;
const YOUNG_CHANNEL_MAX_AGE_MS = 182 * DAY; // ~6 months
const TEMPLATE_MIN_TITLES = 6;
const TEMPLATE_AFFIX_LENGTH = 15;
const TEMPLATE_MIN_SHARE = 0.6;
const SCHEDULE_MIN_ENTRIES = 6;
const SCHEDULE_MIN_SHARE = 0.6;
const SCHEDULE_MIN_DAYS = 3;
// Lifetime output, from the channel's total video count (channel page) and creation date (feed).
const LIFETIME_MIN_VIDEOS = 100;
const LIFETIME_HIGH_RATE_PER_DAY = 1;
// How many recent video IDs to keep for YouTube label checks.
const RECENT_VIDEO_IDS = 5;

// Self-disclosure: must appear in several videos so a single video *about* AI
// does not mark a channel.
const DISCLOSURE_MIN_VIDEOS = 2;
const DISCLOSURE_MIN_SHARE = 0.25;

// Grade rules
const LABELS_FOR_E = 2;
const BLOCKLIST_STRONG_HEURISTICS_FOR_D = 2;
const STRONG_HEURISTICS_FOR_C = 3;

/** Plain-language meaning of each grade, shown before the reasons. */
export const GRADE_MEANINGS = Object.freeze({
  A: 'No AI signs found',
  B: 'Slight hints',
  C: 'Suspicious',
  D: 'Likely AI',
  E: 'AI-generated',
});

export const OVERRIDE_NOT_AI = 'not_ai';
export const OVERRIDE_AI = 'ai';

const DISCLOSURE_PATTERNS = [
  /\bai[\s-]?generated\b/i,
  /\b(?:generated|created|made|produced|animated)\s+(?:with|by|using)\s+(?:an?\s+)?(?:ai|artificial intelligence|sora|veo|kling|midjourney|runway|stable diffusion)\b/i,
  /\bai[\s-]?voice(?:d|over|s)?\b/i,
  /\bai[\s-]?narrat(?:ed|ion|or)\b/i,
  /\bsynthetic voices?\b/i,
  /\bmidjourney\b/i,
  /\bstable diffusion\b/i,
  /#ai(?:art|video|videos|generated|animation|music|film|shorts)\b/i,
  /#(?:sora|sora2|veo|veo2|veo3|kling|klingai|midjourney|runwayml|hailuo|pikalabs)\b/i,
];

/** Returns the AI self-disclosure terms found in a piece of text (lowercased). */
export function findDisclosures(text) {
  if (!text) return [];
  const found = [];
  for (const pattern of DISCLOSURE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) found.push(match[0].toLowerCase());
  }
  return found;
}

function formatRate(rate) {
  return rate >= 10 ? String(Math.round(rate)) : String(Math.round(rate * 10) / 10);
}

function uploadRate(entries) {
  if (entries.length < MIN_ENTRIES_FOR_RATE) return null;
  const span = Math.max(entries[entries.length - 1].published - entries[0].published, HOUR);
  return (entries.length - 1) / (span / DAY);
}

// Largest number of uploads inside any BURST_WINDOW_MS window (entries sorted oldest first).
function largestBurst(entries) {
  let best = { count: 0, spanMs: 0 };
  let start = 0;
  for (let end = 0; end < entries.length; end++) {
    while (entries[end].published - entries[start].published > BURST_WINDOW_MS) start++;
    const count = end - start + 1;
    if (count > best.count) {
      best = { count, spanMs: entries[end].published - entries[start].published };
    }
  }
  return best;
}

function normalizeTitle(title, channelTitle) {
  let text = (title || '').toLowerCase().replace(/#[^\s#]+/g, ' ');
  // Branding like "| Channel Name" is common on human channels; ignore it.
  if (channelTitle) text = text.split(channelTitle.toLowerCase()).join(' ');
  return text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

const SEGMENT_SEPARATOR_RE = /\s*(?:[|•·]|\s[-–—]\s)\s*/g;

/** Splits "Title | Series" at the last separator: [head, tail], or [title, null]. */
function splitTrailingSegment(title) {
  let last = null;
  for (const match of title.matchAll(SEGMENT_SEPARATOR_RE)) last = match;
  if (!last) return [title, null];
  return [title.slice(0, last.index).trim(), title.slice(last.index + last[0].length).trim()];
}

/**
 * Drops a trailing series or branding segment ("| Warhammer 40,000 Lore/History")
 * when it recurs across titles: human channels often tag every video that way.
 */
function withoutRecurringSuffix(titles) {
  const split = titles.map(splitTrailingSegment);
  const tailCounts = new Map();
  for (const [, tail] of split) if (tail) tailCounts.set(tail, (tailCounts.get(tail) || 0) + 1);
  return split.map(([head, tail], i) => (tail === null || (tail && tailCounts.get(tail) < 2) ? titles[i] : head));
}

function mostCommonCount(values) {
  const counts = new Map();
  let best = 0;
  for (const value of values) {
    const count = (counts.get(value) || 0) + 1;
    counts.set(value, count);
    if (count > best) best = count;
  }
  return best;
}

function templatedTitleCount(entries, channelTitle) {
  if (entries.length < TEMPLATE_MIN_TITLES) return 0;
  const titles = withoutRecurringSuffix(entries.map((entry) => normalizeTitle(entry.title, channelTitle))).filter(
    (title) => title.length >= TEMPLATE_AFFIX_LENGTH,
  );
  const prefixes = titles.map((title) => title.slice(0, TEMPLATE_AFFIX_LENGTH));
  const suffixes = titles.map((title) => title.slice(-TEMPLATE_AFFIX_LENGTH));
  const count = Math.max(mostCommonCount(prefixes), mostCommonCount(suffixes));
  return count / entries.length >= TEMPLATE_MIN_SHARE ? count : 0;
}

function fixedScheduleCount(entries) {
  if (entries.length < SCHEDULE_MIN_ENTRIES) return 0;
  // Minute of day (UTC) -> uploads at that minute and the distinct days they span.
  const byMinute = new Map();
  for (const entry of entries) {
    const minuteOfDay = Math.floor((entry.published % DAY) / MINUTE);
    const slot = byMinute.get(minuteOfDay) || { count: 0, days: new Set() };
    slot.count++;
    slot.days.add(Math.floor(entry.published / DAY));
    byMinute.set(minuteOfDay, slot);
  }
  let best = 0;
  for (const slot of byMinute.values()) {
    if (slot.days.size >= SCHEDULE_MIN_DAYS && slot.count > best) best = slot.count;
  }
  return best / entries.length >= SCHEDULE_MIN_SHARE ? best : 0;
}

/**
 * Turns a parsed RSS feed (see lib/rss.js) into storable signals.
 * @returns {{heuristics: {id: string, strong: boolean, reason: string}[],
 *   disclosure: {detected: boolean, count: number, terms: string[]},
 *   latestVideoId: string|null, stats: object}}
 */
export function analyzeFeed(feed, now = Date.now()) {
  const entries = (feed?.entries || [])
    .filter((entry) => Number.isFinite(entry.published))
    .sort((a, b) => a.published - b.published);
  const heuristics = [];
  const stats = { entries: entries.length };

  const rate = uploadRate(entries);
  if (rate !== null) {
    stats.uploadsPerDay = Math.round(rate * 10) / 10;
    if (rate >= HIGH_UPLOAD_RATE_PER_DAY) {
      heuristics.push({ id: 'rate', strong: true, reason: `~${formatRate(rate)} uploads per day` });
    }
  }

  const burst = largestBurst(entries);
  stats.maxBurst = burst.count;
  if (burst.count >= BURST_MIN_UPLOADS) {
    const hours = Math.max(1, Math.ceil(burst.spanMs / HOUR));
    heuristics.push({ id: 'burst', strong: true, reason: `${burst.count} uploads within ${plural(hours, 'hour')}` });
  }

  if (Number.isFinite(feed?.published)) {
    const age = now - feed.published;
    stats.channelAgeDays = Math.floor(age / DAY);
    if (age >= 0 && age < YOUNG_CHANNEL_MAX_AGE_MS && entries.length >= FEED_MAX_ENTRIES) {
      const months = Math.floor(age / (30 * DAY));
      const ageText = months < 1 ? 'under 1 month' : plural(months, 'month');
      heuristics.push({ id: 'young', strong: true, reason: `New channel (${ageText} old) with ${FEED_MAX_ENTRIES}+ uploads` });
    }
  }

  const templated = templatedTitleCount(entries, feed?.title);
  if (templated) {
    heuristics.push({ id: 'template', strong: true, reason: `Repetitive, templated titles (${templated} of ${entries.length})` });
  }

  const scheduled = fixedScheduleCount(entries);
  if (scheduled) {
    heuristics.push({ id: 'schedule', strong: false, reason: `Uploads at the exact same time of day (${scheduled} of ${entries.length})` });
  }

  const terms = new Set();
  let disclosed = 0;
  for (const entry of entries) {
    const found = findDisclosures(`${entry.title || ''}\n${entry.description || ''}`);
    if (found.length) disclosed++;
    found.forEach((term) => terms.add(term));
  }
  const disclosure = {
    detected: disclosed >= DISCLOSURE_MIN_VIDEOS && disclosed / Math.max(entries.length, 1) >= DISCLOSURE_MIN_SHARE,
    count: disclosed,
    terms: [...terms].slice(0, 5),
  };
  stats.disclosures = disclosed;

  const recentVideoIds = entries
    .slice(-RECENT_VIDEO_IDS)
    .reverse()
    .map((entry) => entry.videoId);
  return { heuristics, disclosure, latestVideoId: recentVideoIds[0] || null, recentVideoIds, stats };
}

/**
 * Strong heuristic from the channel's lifetime output: total videos (from its channel
 * page) over its age (from the feed). Returns null when either is unknown.
 */
function lifetimeHeuristic(videoCount, channelAgeDays) {
  if (!Number.isFinite(videoCount) || !Number.isFinite(channelAgeDays)) return null;
  const rate = videoCount / Math.max(channelAgeDays, 1);
  if (videoCount < LIFETIME_MIN_VIDEOS || rate < LIFETIME_HIGH_RATE_PER_DAY) return null;
  return {
    id: 'lifetime',
    strong: true,
    reason: `~${formatRate(rate)} uploads per day since the channel started (${videoCount.toLocaleString('en-US')} videos)`,
  };
}

/**
 * Applies the grade rules. First matching rule wins; an override beats everything.
 *   E: label on >= 2 videos, or label + (blocklist or disclosure)
 *   D: label on 1, or disclosure, or blocklist + >= 2 strong heuristics
 *   C: blocklist (alone or with weaker evidence), or >= 3 strong heuristics
 *   B: any other heuristic
 *   A: feed checked, nothing found
 * @param {object} input
 * @param {'not_ai'|'ai'|null} [input.override]
 * @param {boolean} [input.blocklisted]
 * @param {ReturnType<typeof analyzeFeed>|null} [input.feed] null until the RSS feed was checked
 * @param {boolean} [input.feedUnavailable] the last feed request failed
 * @param {{checked: number, labeled: number}} [input.labels] YouTube "Made with AI" label results
 * @param {number} [input.videoCount] total videos on the channel, when known
 * @returns {{grade: 'A'|'B'|'C'|'D'|'E'|null, summary: string, reasons: string[], stats: object}}
 */
export function gradeChannel({
  override = null,
  blocklisted = false,
  feed = null,
  feedUnavailable = false,
  labels = { checked: 0, labeled: 0 },
  videoCount = null,
} = {}) {
  const stats = {
    ...(feed?.stats || {}),
    labelsChecked: labels.checked,
    labelsFound: labels.labeled,
    videoCount,
    blocklisted,
  };
  const result = (grade, reasons) => ({ grade, summary: grade ? GRADE_MEANINGS[grade] : 'Checking…', reasons, stats });
  if (override === OVERRIDE_NOT_AI) return result('A', ['Your override']);
  if (override === OVERRIDE_AI) return result('E', ['Your override']);

  const heuristics = [...(feed?.heuristics || [])];
  const lifetime = lifetimeHeuristic(videoCount, feed?.stats?.channelAgeDays);
  if (lifetime) heuristics.push(lifetime);
  const strongCount = heuristics.filter((h) => h.strong).length;
  const disclosed = Boolean(feed?.disclosure?.detected);
  const labeled = labels.labeled;

  const reasons = [];
  if (labeled > 0) {
    reasons.push(`YouTube "Made with AI" label on ${labeled} of ${plural(Math.max(labels.checked, labeled), 'checked video')}`);
  }
  if (disclosed) {
    const term = feed.disclosure.terms[0];
    reasons.push(`Says it uses AI in ${feed.disclosure.count} of ${feed.stats.entries} recent videos${term ? ` ("${term}")` : ''}`);
  }
  for (const h of heuristics.sort((a, b) => Number(b.strong) - Number(a.strong))) reasons.push(h.reason);
  if (blocklisted) reasons.push('On the AiSList community list');

  if (labeled >= LABELS_FOR_E || (labeled >= 1 && (blocklisted || disclosed))) return result('E', reasons);
  if (labeled === 1 || disclosed || (blocklisted && strongCount >= BLOCKLIST_STRONG_HEURISTICS_FOR_D)) return result('D', reasons);
  if (blocklisted || strongCount >= STRONG_HEURISTICS_FOR_C) return result('C', reasons);
  if (heuristics.length >= 1) return result('B', reasons);
  if (feed) {
    const checked = labels.checked ? `; no YouTube AI label on ${plural(labels.checked, 'checked video')}` : '';
    return result('A', [`Checked ${plural(feed.stats?.entries || 0, 'recent upload')}${checked}`]);
  }
  return result(null, [feedUnavailable ? 'Channel feed unavailable; will retry later' : 'Checking channel…']);
}
