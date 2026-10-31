// Service worker: owns the per-channel cache, the network queue and grading.
// MV3 workers are short-lived, so durable state lives in chrome.storage.local; the
// in-memory maps below only hold work that is in flight right now.

import { analyzeFeed, gradeChannel, OVERRIDE_AI, OVERRIDE_NOT_AI } from './lib/grade.js';
import { parseFeed } from './lib/rss.js';
import { detectAiLabelInHtml, extractChannelIdFromPage, extractVideoCountFromPage, observationHasAiLabel } from './lib/label.js';
import { parseBlocklist, normalizeHandle } from './lib/blocklist.js';
import {
  rateDecision,
  handleLookupState,
  videoLookupState,
  labelCounts,
  labelCandidates,
  channelWork,
  isStaleChannel,
  mergeRateStates,
  freshVideoCount,
  pruneLabels,
  HANDLE_TOUCH_MS,
} from './lib/policy.js';
import {
  STORAGE_KEYS,
  CHANNEL_PREFIX,
  HANDLE_PREFIX,
  VIDEO_PREFIX,
  RATE_PREFIX,
  withDefaultSettings,
} from './lib/settings.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const BLOCKLIST_URL = 'https://raw.githubusercontent.com/Override92/AiSList/main/AiSList/aislist_blocklist.txt';
const BLOCKLIST_TTL_MS = DAY;
const BLOCKLIST_RETRY_MS = HOUR;
const BLOCKLIST_MIN_ENTRIES = 100; // refuse to replace a good list with a truncated one

const LABEL_MAX_PER_CHANNEL = 50;
const TRANSIENT_RETRY_MS = 10 * MINUTE;
const STORAGE_FAILURE_RETRY_MS = 5 * MINUTE; // limiter state could not be saved
const MAX_ITEMS_PER_REQUEST = 100;

// Feeds, lookups (handle page / oEmbed) and label checks run in separate lanes so a
// rate-limited lookup that is waiting for its slot never holds up feed requests.
const LANES = {
  feed: { concurrency: 2, spacingMs: 300 },
  lookup: { concurrency: 2, spacingMs: 0 }, // paced by their rate limiters
  label: { concurrency: 1, spacingMs: 0 },
};

const LIMITS = {
  feed: { minIntervalMs: 0, maxPerHour: 300, backoffMs: 10 * MINUTE },
  handle: { minIntervalMs: 2 * 1000, maxPerHour: 120, backoffMs: HOUR },
  oembed: { minIntervalMs: 500, maxPerHour: 600, backoffMs: 15 * MINUTE },
  label: { minIntervalMs: 10 * 1000, maxPerHour: 30, backoffMs: HOUR },
};

const MAINTENANCE_ALARM = 'maintenance';
const MAINTENANCE_PERIOD_MINUTES = 60; // blocklist refresh itself is limited to once per 24h
const PRUNE_INTERVAL_MS = DAY;
const LAST_PRUNE_KEY = 'lastPruneAt';

const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const store = chrome.storage.local;

// ---------------------------------------------------------------------------
// Storage helpers

const LOG = '[ai-slop-badge]';

async function getOne(key) {
  return (await store.get(key))[key];
}

/** chrome.storage.local.set that logs instead of throwing (e.g. when the quota is full). */
async function save(items) {
  try {
    await store.set(items);
    return true;
  } catch (error) {
    console.warn(LOG, 'storage write failed', Object.keys(items), error);
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Serializes read-modify-write cycles per key within this worker.
const locks = new Map();
function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  const result = previous.then(fn, fn);
  const tail = result.catch(() => {});
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return result;
}

function updateChannel(channelId, mutate) {
  const key = CHANNEL_PREFIX + channelId;
  return withLock(key, async () => {
    const record = (await getOne(key)) || { channelId };
    mutate(record);
    await save({ [key]: record });
    return record;
  });
}

// ---------------------------------------------------------------------------
// Rate limiting (persisted, so worker restarts keep budgets and backoffs)

class RateLimiter {
  constructor(name, limit) {
    this.key = RATE_PREFIX + name;
    this.limit = limit;
    this.chain = Promise.resolve();
    this.memory = null; // mirror of the last state, in case storage can't be read or written
  }

  serialize(fn) {
    const result = this.chain.then(fn, fn);
    this.chain = result.catch(() => {});
    return result;
  }

  async readState() {
    let stored;
    try {
      stored = await getOne(this.key);
    } catch (error) {
      console.warn(LOG, 'rate state unreadable', this.key, error);
    }
    return mergeRateStates(stored, this.memory);
  }

  /**
   * Waits for the next slot. Resolves 0 when granted, otherwise the time it may retry.
   * Fails closed: if the new state can't be saved, the request is denied.
   */
  acquire() {
    return this.serialize(async () => {
      const state = await this.readState();
      const decision = rateDecision(state, this.limit, Date.now());
      if (decision.retryAt) return decision.retryAt;
      if (decision.waitMs) await sleep(decision.waitMs);
      this.memory = { recent: [...decision.recent, Date.now()], backoffUntil: state.backoffUntil };
      if (!(await save({ [this.key]: this.memory }))) return Date.now() + STORAGE_FAILURE_RETRY_MS;
      return 0;
    });
  }

  /** Stops this kind of request for backoffMs; returns when it may resume. Holds in memory even if saving fails. */
  backOff() {
    return this.serialize(async () => {
      const state = await this.readState();
      const backoffUntil = Math.max(state.backoffUntil, Date.now() + this.limit.backoffMs);
      this.memory = { recent: state.recent, backoffUntil };
      await save({ [this.key]: this.memory });
      return backoffUntil;
    });
  }
}

const limiters = Object.fromEntries(Object.entries(LIMITS).map(([name, limit]) => [name, new RateLimiter(name, limit)]));

// ---------------------------------------------------------------------------
// Network

class FetchError extends Error {
  constructor(status, message) {
    super(message || `HTTP ${status}`);
    this.status = status;
  }
}

/** Anonymous GET to YouTube; throws FetchError on non-OK or when redirected off www.youtube.com (consent page). */
async function fetchYouTube(url, as = 'text', headers = {}) {
  const response = await fetch(url, { credentials: 'omit', headers });
  if (!response.ok) throw new FetchError(response.status);
  if (new URL(response.url).hostname !== 'www.youtube.com') throw new FetchError(0, 'Redirected away from YouTube');
  return as === 'json' ? response.json() : response.text();
}

// ---------------------------------------------------------------------------
// Job queue. Jobs are deduped by ID; every job remembers which content keys wait
// for it so they can be re-graded and pushed to their tabs when it finishes.

const jobs = new Map(); // id -> {id, lane, run, dependents:Set<string>}
const laneState = Object.fromEntries(Object.keys(LANES).map((name) => [name, { queue: [], running: 0, lastStart: 0, timer: null }]));
const blockedJobs = new Map(); // job id -> time before which it must not run again

// contentKey -> {item, tabs:Set<number>}
const waiters = new Map();

function isBlocked(jobId) {
  const until = blockedJobs.get(jobId) || 0;
  if (until > Date.now()) return true;
  blockedJobs.delete(jobId);
  return false;
}

function requestJob(need, dependentKey) {
  let job = jobs.get(need.id);
  if (!job) {
    job = { ...need, dependents: new Set() };
    jobs.set(job.id, job);
    laneState[job.lane].queue.push(job);
    pump(job.lane);
  }
  if (dependentKey) job.dependents.add(dependentKey);
}

function pump(laneName) {
  const lane = laneState[laneName];
  const { concurrency, spacingMs } = LANES[laneName];
  if (lane.timer) return;
  while (lane.running < concurrency && lane.queue.length) {
    const now = Date.now();
    const wait = lane.lastStart + spacingMs - now;
    if (wait > 0) {
      lane.timer = setTimeout(() => {
        lane.timer = null;
        pump(laneName);
      }, wait);
      return;
    }
    const job = lane.queue.shift();
    lane.running++;
    lane.lastStart = now;
    runJob(job).finally(() => {
      lane.running--;
      pump(laneName);
    });
  }
}

async function runJob(job) {
  try {
    const retryAt = await job.run();
    if (retryAt) blockedJobs.set(job.id, retryAt);
  } catch (error) {
    console.warn(LOG, 'job failed', job.id, error);
    blockedJobs.set(job.id, Date.now() + TRANSIENT_RETRY_MS);
  } finally {
    jobs.delete(job.id);
  }
  try {
    await regrade(job.dependents);
  } catch (error) {
    console.warn(LOG, 'regrade failed', error);
  }
}

// ---------------------------------------------------------------------------
// Jobs. Each returns 0 when done, or a time before which it must not be retried.

const JOB_FACTORIES = {
  feed: (channelId) => ({ id: `feed:${channelId}`, lane: 'feed', run: () => refreshFeed(channelId) }),
  label: (channelId) => ({ id: `label:${channelId}`, lane: 'label', run: () => checkLabel(channelId) }),
};
const handleJob = (handle) => ({ id: `handle:${handle}`, lane: 'lookup', run: () => resolveHandle(handle) });
const videoJob = (videoId) => ({ id: `video:${videoId}`, lane: 'lookup', run: () => resolveVideo(videoId) });

async function refreshFeed(channelId) {
  const retryAt = await limiters.feed.acquire();
  if (retryAt) return retryAt;
  let xml;
  try {
    xml = await fetchYouTube(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  } catch (error) {
    await updateChannel(channelId, (record) => {
      record.feedErrorAt = Date.now();
    });
    return error.status === 429 ? limiters.feed.backOff() : 0;
  }
  const feed = parseFeed(xml);
  const analysis = analyzeFeed(feed, Date.now());
  await updateChannel(channelId, (record) => {
    record.title = feed.title || record.title || null;
    record.analysis = analysis;
    record.feedFetchedAt = Date.now();
    delete record.feedErrorAt;
  });
  return 0;
}

async function resolveHandle(handle) {
  const retryAt = await limiters.handle.acquire();
  if (retryAt) return retryAt;
  let channelId = null;
  let videoCount = null;
  try {
    // English, so the header's "1.8K videos" can be read; the page is fetched for the ID anyway.
    const html = await fetchYouTube(`https://www.youtube.com/@${encodeURIComponent(handle)}?hl=en`, 'text', {
      'Accept-Language': 'en-US,en;q=0.8',
    });
    channelId = extractChannelIdFromPage(html);
    videoCount = extractVideoCountFromPage(html);
  } catch (error) {
    if (error.status === 429) return limiters.handle.backOff();
    if (error.status !== 404) return Date.now() + TRANSIENT_RETRY_MS; // transient; do not cache
  }
  if (!channelId) {
    await save({ [HANDLE_PREFIX + handle]: { id: null, at: Date.now() } });
    return 0;
  }
  await rememberHandle(handle, channelId);
  if (videoCount !== null) {
    // Kept on the handle mapping (30 days), which outlives the 7-day channel cache.
    const key = HANDLE_PREFIX + handle;
    await withLock(key, async () => {
      const entry = (await getOne(key)) || { id: channelId, at: Date.now() };
      await save({ [key]: { ...entry, videoCount, videoCountAt: Date.now() } });
    });
  }
  return 0;
}

async function resolveVideo(videoId) {
  const retryAt = await limiters.oembed.acquire();
  if (retryAt) return retryAt;
  const videoUrl = `https://www.youtube.com/shorts/${videoId}`;
  let entry = { handle: null, channelId: null, at: Date.now() };
  try {
    const data = await fetchYouTube(`https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`, 'json');
    const authorUrl = typeof data?.author_url === 'string' ? data.author_url : '';
    const handleMatch = /\/(@[^/?#]+)/.exec(authorUrl);
    const channelMatch = /\/channel\/(UC[A-Za-z0-9_-]{22})/.exec(authorUrl);
    entry = { ...entry, handle: handleMatch ? normalizeHandle(handleMatch[1]) : null, channelId: channelMatch?.[1] || null };
  } catch (error) {
    if (error.status === 429) return limiters.oembed.backOff();
    if (![400, 401, 403, 404].includes(error.status)) return Date.now() + TRANSIENT_RETRY_MS;
    // Private, removed or not embeddable: remember that it cannot be identified.
  }
  await save({ [VIDEO_PREFIX + videoId]: entry });
  return 0;
}

async function checkLabel(channelId) {
  const settings = withDefaultSettings(await getOne(STORAGE_KEYS.settings));
  // Turned off meanwhile: drop the job. evaluate() will not ask for it while it stays off.
  if (!settings.enabled || !settings.labelCheck) return 0;
  const record = await getOne(CHANNEL_PREFIX + channelId);
  const [videoId] = labelCandidates(record, Date.now());
  if (!videoId) return 0;

  const retryAt = await limiters.label.acquire();
  if (retryAt) return retryAt;
  let result;
  try {
    result = detectAiLabelInHtml(await fetchYouTube(`https://www.youtube.com/watch?v=${videoId}`));
  } catch (error) {
    console.warn(LOG, 'label check failed, backing off', error.status);
    return limiters.label.backOff();
  }
  if (!result.checked) {
    // Consent or bot-check page instead of a watch page: stop for a while.
    console.warn(LOG, 'watch page without video data, backing off');
    return limiters.label.backOff();
  }
  await recordLabel(channelId, videoId, result.aiLabel);
  return 0;
}

function recordLabel(channelId, videoId, aiLabel) {
  return updateChannel(channelId, (record) => {
    const now = Date.now();
    const labels = pruneLabels(record.labels, now, LABEL_MAX_PER_CHANNEL);
    labels.checked[videoId] = now;
    if (aiLabel) labels.labeled[videoId] = now;
    else delete labels.labeled[videoId];
    record.labels = labels;
  });
}

// ---------------------------------------------------------------------------
// Blocklist

let blocklistMemo = null;
let blocklistRefresh = null;

async function loadBlocklist() {
  if (!blocklistMemo) {
    const data = (await getOne(STORAGE_KEYS.blocklist)) || {};
    blocklistMemo = { handles: new Set(data.handles || []), ids: new Set(data.ids || []) };
  }
  return blocklistMemo;
}

function refreshBlocklist() {
  blocklistRefresh ||= doRefreshBlocklist().finally(() => {
    blocklistRefresh = null;
  });
  return blocklistRefresh;
}

async function doRefreshBlocklist() {
  const settings = withDefaultSettings(await getOne(STORAGE_KEYS.settings));
  if (!settings.useBlocklist) return;
  const now = Date.now();
  const meta = (await getOne(STORAGE_KEYS.blocklistMeta)) || {};
  if (meta.fetchedAt && now - meta.fetchedAt < BLOCKLIST_TTL_MS) return;
  if (meta.lastAttemptAt && now - meta.lastAttemptAt < BLOCKLIST_RETRY_MS) return;

  await save({ [STORAGE_KEYS.blocklistMeta]: { ...meta, lastAttemptAt: now } });
  try {
    // GitHub raw serves "Access-Control-Allow-Origin: *", so no host permission is needed.
    const response = await fetch(BLOCKLIST_URL, { credentials: 'omit', cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const list = parseBlocklist(await response.text());
    const count = list.handles.length + list.ids.length;
    if (count < BLOCKLIST_MIN_ENTRIES) throw new Error(`Only ${count} entries`);
    await save({
      [STORAGE_KEYS.blocklist]: list,
      [STORAGE_KEYS.blocklistMeta]: { fetchedAt: now, lastAttemptAt: now, count, error: null },
    });
    blocklistMemo = null;
    console.info(LOG, `AiSList updated: ${count} channels`);
  } catch (error) {
    console.warn(LOG, 'AiSList update failed', error);
    await save({ [STORAGE_KEYS.blocklistMeta]: { ...meta, lastAttemptAt: now, error: String(error.message || error) } });
  }
}

// ---------------------------------------------------------------------------
// Grading

async function loadContext() {
  const data = await store.get([STORAGE_KEYS.settings, STORAGE_KEYS.overrides]);
  const settings = withDefaultSettings(data[STORAGE_KEYS.settings]);
  return {
    settings,
    overrides: data[STORAGE_KEYS.overrides] || {},
    blocklist: settings.useBlocklist ? await loadBlocklist() : null,
    now: Date.now(),
  };
}

const rememberedHandles = new Map(); // handle -> channelId already written by this worker

/**
 * Stores a handle <-> channel pair: handle -> ID (expires after 30 days unless used)
 * and the handle on the channel record, so channel-ID-only tiles can be matched
 * against the handle-based blocklist.
 */
async function rememberHandle(handle, channelId) {
  if (rememberedHandles.get(handle) === channelId) return;
  rememberedHandles.set(handle, channelId);
  const now = Date.now();
  const key = HANDLE_PREFIX + handle;
  await withLock(key, async () => {
    const existing = await getOne(key);
    if (existing?.id === channelId && now - (existing.at || 0) <= HANDLE_TOUCH_MS) return;
    // Keep the stored video count only while the handle still points to the same channel.
    const kept = existing?.id === channelId ? existing : {};
    await save({ [key]: { ...kept, id: channelId, at: now } });
  });
  const record = await getOne(CHANNEL_PREFIX + channelId);
  if (record?.handle !== handle || now - (record.handleSeenAt || 0) > HANDLE_TOUCH_MS) {
    await updateChannel(channelId, (rec) => {
      rec.handle = handle;
      rec.handleSeenAt = now;
    });
  }
}

const UNIDENTIFIED = { grade: null, unidentified: true, reasons: [] };

/**
 * Grades one requested item ({channelId?, handle?, videoId?}) from cached data.
 * Returns the result plus the jobs that would improve it.
 */
async function evaluate(item, ctx) {
  const needs = [];
  const need = (job) => {
    if (!isBlocked(job.id)) needs.push(job);
  };
  let { channelId, handle } = item;

  if (!channelId && !handle && item.videoId) {
    const video = await getOne(VIDEO_PREFIX + item.videoId);
    const state = videoLookupState(video, ctx.now);
    if (state === 'negative') return { result: UNIDENTIFIED, needs };
    if (state === 'missing') {
      need(videoJob(item.videoId));
      return { result: { grade: null, reasons: ['Finding channel…'] }, needs };
    }
    ({ channelId, handle } = video);
  }

  let unresolvableHandle = false;
  let handleEntry = null;
  if (!channelId && handle) {
    const lookup = await getOne(HANDLE_PREFIX + handle);
    handleEntry = lookup;
    const state = handleLookupState(lookup, ctx.now);
    if (state === 'hit') {
      channelId = lookup.id;
      await rememberHandle(handle, channelId); // refreshes the mapping's expiry when due
    } else if (state === 'negative') {
      unresolvableHandle = true;
    } else {
      need(handleJob(handle));
    }
  } else if (channelId && handle) {
    await rememberHandle(handle, channelId);
  }

  const record = channelId ? await getOne(CHANNEL_PREFIX + channelId) : null;
  if (!handle && record?.handle) handle = record.handle;
  if (handle && !handleEntry) handleEntry = await getOne(HANDLE_PREFIX + handle);

  const override = ctx.overrides[channelId] || (handle && ctx.overrides[`@${handle}`]) || null;
  const blocklisted = Boolean(
    ctx.blocklist && ((handle && ctx.blocklist.handles.has(handle)) || (channelId && ctx.blocklist.ids.has(channelId))),
  );
  const grade = gradeChannel({
    override: override?.value || null,
    blocklisted,
    feed: record?.analysis || null,
    feedUnavailable: Boolean(record?.feedErrorAt && !record?.analysis),
    labels: labelCounts(record, ctx.now),
    videoCount: freshVideoCount(handleEntry, channelId, ctx.now),
  });

  // A handle that resolves to no channel cannot be checked further.
  if (unresolvableHandle && grade.grade === null) return { result: UNIDENTIFIED, needs };

  const work = channelWork({
    channelId,
    record,
    grade: grade.grade,
    overridden: Boolean(override),
    labelCheckEnabled: ctx.settings.labelCheck,
    now: ctx.now,
  });
  work.forEach((kind) => need(JOB_FACTORIES[kind](channelId)));

  return {
    result: {
      ...grade,
      channelId: channelId || null,
      handle: handle || null,
      title: record?.title || null,
      override: override?.value || null,
    },
    needs,
  };
}

async function regrade(keys) {
  if (!keys.size) return;
  const ctx = await loadContext();
  if (!ctx.settings.enabled) {
    keys.forEach((key) => waiters.delete(key));
    return;
  }
  const byTab = new Map();
  for (const key of keys) {
    const waiter = waiters.get(key);
    if (!waiter) continue;
    const { result, needs } = await evaluate(waiter.item, ctx);
    for (const tabId of waiter.tabs) {
      if (!byTab.has(tabId)) byTab.set(tabId, []);
      byTab.get(tabId).push({ key, result });
    }
    if (needs.length) needs.forEach((job) => requestJob(job, key));
    else waiters.delete(key);
  }
  for (const [tabId, results] of byTab) {
    chrome.tabs.sendMessage(tabId, { type: 'grades', results }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Messages

function cleanItem(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string' || raw.key.length > 200) return null;
  const item = {
    key: raw.key,
    channelId: CHANNEL_ID_RE.test(raw.channelId) ? raw.channelId : null,
    handle: normalizeHandle(raw.handle),
    videoId: VIDEO_ID_RE.test(raw.videoId) ? raw.videoId : null,
  };
  return item.channelId || item.handle || item.videoId ? item : null;
}

async function handleGetGrades(message, sender) {
  const items = (Array.isArray(message.items) ? message.items : []).slice(0, MAX_ITEMS_PER_REQUEST).map(cleanItem).filter(Boolean);
  const ctx = await loadContext();
  if (!ctx.settings.enabled) return { results: [] };
  const tabId = sender.tab?.id;
  const results = [];
  for (const item of items) {
    const { result, needs } = await evaluate(item, ctx);
    results.push({ key: item.key, result });
    if (!needs.length) continue;
    const waiter = waiters.get(item.key) || { item, tabs: new Set() };
    waiter.item = item;
    if (tabId !== undefined) waiter.tabs.add(tabId);
    waiters.set(item.key, waiter);
    needs.forEach((job) => requestJob(job, item.key));
  }
  return { results };
}

async function handleWatchObservation(message) {
  const { videoId, channelId, viewModels } = message;
  if (!VIDEO_ID_RE.test(videoId) || !CHANNEL_ID_RE.test(channelId) || !Array.isArray(viewModels)) return { ok: false };
  const handle = normalizeHandle(message.handle);
  if (handle) await rememberHandle(handle, channelId);
  await recordLabel(channelId, videoId, observationHasAiLabel(viewModels.slice(0, 10)));
  return { ok: true };
}

async function handleSetOverride(message) {
  const value = [OVERRIDE_AI, OVERRIDE_NOT_AI].includes(message.value) ? message.value : null;
  const channelId = CHANNEL_ID_RE.test(message.channelId) ? message.channelId : null;
  const handle = normalizeHandle(message.handle);
  const keys = [channelId, handle && `@${handle}`].filter(Boolean);
  if (typeof message.key === 'string') keys.push(message.key);
  if (!keys.length) return { ok: false };

  await withLock(STORAGE_KEYS.overrides, async () => {
    const overrides = (await getOne(STORAGE_KEYS.overrides)) || {};
    keys.forEach((key) => delete overrides[key]);
    if (value && (channelId || handle)) {
      const record = channelId ? await getOne(CHANNEL_PREFIX + channelId) : null;
      overrides[keys[0]] = { value, channelId, handle, title: record?.title || null, at: Date.now() };
    }
    await save({ [STORAGE_KEYS.overrides]: overrides });
  });
  return { ok: true };
}

async function handleClearCache() {
  const all = await store.get(null);
  const prefixes = [CHANNEL_PREFIX, HANDLE_PREFIX, VIDEO_PREFIX];
  const keys = Object.keys(all).filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));
  await store.remove(keys);
  rememberedHandles.clear();
  blockedJobs.clear();
  await save({ [STORAGE_KEYS.cacheEpoch]: Date.now() });
  return { ok: true, removed: keys.length };
}

const handlers = {
  getGrades: handleGetGrades,
  watchObservation: handleWatchObservation,
  setOverride: handleSetOverride,
  clearCache: handleClearCache,
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message, sender).then(sendResponse, (error) => {
    console.warn(LOG, message.type, error);
    sendResponse({ error: String(error?.message || error) });
  });
  return true;
});

// ---------------------------------------------------------------------------
// Maintenance: blocklist refresh and pruning of stale cache entries

async function prune() {
  const now = Date.now();
  if (now - ((await getOne(LAST_PRUNE_KEY)) || 0) < PRUNE_INTERVAL_MS) return;
  await save({ [LAST_PRUNE_KEY]: now });
  const all = await store.get(null);
  const stale = Object.entries(all)
    .filter(([key, value]) => {
      if (key.startsWith(CHANNEL_PREFIX)) return isStaleChannel(value, now);
      if (key.startsWith(VIDEO_PREFIX)) return videoLookupState(value, now) === 'missing';
      if (key.startsWith(HANDLE_PREFIX)) return handleLookupState(value, now) === 'missing';
      return false;
    })
    .map(([key]) => key);
  if (stale.length) await store.remove(stale);

  // Records still in use may hold label results (video IDs) older than 7 days; drop those.
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(CHANNEL_PREFIX) || stale.includes(key) || !value?.labels) continue;
    const count = (labels) => Object.keys(labels?.checked || {}).length + Object.keys(labels?.labeled || {}).length;
    if (count(pruneLabels(value.labels, now, LABEL_MAX_PER_CHANNEL)) === count(value.labels)) continue;
    await updateChannel(value.channelId || key.slice(CHANNEL_PREFIX.length), (record) => {
      record.labels = pruneLabels(record.labels, now, LABEL_MAX_PER_CHANNEL);
    });
  }
}

async function ensureAlarm() {
  if (!(await chrome.alarms.get(MAINTENANCE_ALARM))) {
    await chrome.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: MAINTENANCE_PERIOD_MINUTES, delayInMinutes: 1 });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  await refreshBlocklist();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await refreshBlocklist();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== MAINTENANCE_ALARM) return;
  try {
    await refreshBlocklist();
    await prune();
  } catch (error) {
    console.warn(LOG, 'maintenance failed', error);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE_KEYS.settings]) {
    const before = withDefaultSettings(changes[STORAGE_KEYS.settings].oldValue);
    const after = withDefaultSettings(changes[STORAGE_KEYS.settings].newValue);
    if (after.useBlocklist && !before.useBlocklist) refreshBlocklist();
  }
  if (changes[STORAGE_KEYS.blocklist]) blocklistMemo = null;
});
