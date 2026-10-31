import { test } from 'node:test';
import assert from 'node:assert/strict';
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
} from '../lib/policy.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 31, 12);

// Spec: suspect label checks at most 1 per 10 s and 30 per hour.
const LABEL_LIMIT = { minIntervalMs: 10 * SECOND, maxPerHour: 30 };

test('rate: first request goes out immediately', () => {
  assert.deepEqual(rateDecision(undefined, LABEL_LIMIT, NOW), { retryAt: 0, waitMs: 0, recent: [] });
});

test('rate: waits out the minimum interval', () => {
  const decision = rateDecision({ recent: [NOW - 4 * SECOND] }, LABEL_LIMIT, NOW);
  assert.equal(decision.retryAt, 0);
  assert.equal(decision.waitMs, 6 * SECOND);
});

test('rate: the 31st request within an hour is denied until the oldest expires', () => {
  const recent = Array.from({ length: 30 }, (_, i) => NOW - 50 * MINUTE + i * MINUTE);
  assert.equal(rateDecision({ recent }, LABEL_LIMIT, NOW).retryAt, NOW + 10 * MINUTE);
});

test('rate: requests older than an hour no longer count', () => {
  const recent = [NOW - 61 * MINUTE, ...Array.from({ length: 29 }, (_, i) => NOW - 40 * MINUTE + i * MINUTE)];
  const decision = rateDecision({ recent }, LABEL_LIMIT, NOW);
  assert.equal(decision.retryAt, 0);
  assert.equal(decision.recent.length, 29);
});

test('rate: a persisted backoff denies until it ends, then allows', () => {
  assert.equal(rateDecision({ recent: [], backoffUntil: NOW + HOUR }, LABEL_LIMIT, NOW).retryAt, NOW + HOUR);
  assert.equal(rateDecision({ recent: [], backoffUntil: NOW - 1 }, LABEL_LIMIT, NOW).retryAt, 0);
});

test('handle lookups: positive for 30 days, negative for 1 day', () => {
  assert.equal(handleLookupState(undefined, NOW), 'missing');
  assert.equal(handleLookupState({ id: 'UCBJycsmduvYEL83R_U4JriQ', at: NOW - 29 * DAY }, NOW), 'hit');
  assert.equal(handleLookupState({ id: 'UCBJycsmduvYEL83R_U4JriQ', at: NOW - 31 * DAY }, NOW), 'missing');
  assert.equal(handleLookupState({ id: null, at: NOW - 12 * HOUR }, NOW), 'negative');
  assert.equal(handleLookupState({ id: null, at: NOW - 25 * HOUR }, NOW), 'missing');
});

test('video lookups: positive for 30 days, unidentifiable for 1 day', () => {
  assert.equal(videoLookupState({ handle: 'mkbhd', channelId: null, at: NOW - 29 * DAY }, NOW), 'hit');
  assert.equal(videoLookupState({ handle: null, channelId: null, at: NOW - 2 * HOUR }, NOW), 'negative');
  assert.equal(videoLookupState({ handle: null, channelId: null, at: NOW - 2 * DAY }, NOW), 'missing');
});

test('label results expire after 7 days', () => {
  const record = {
    labels: {
      checked: { a: NOW - 1 * DAY, b: NOW - 6 * DAY, c: NOW - 8 * DAY },
      labeled: { a: NOW - 1 * DAY, c: NOW - 8 * DAY },
    },
  };
  assert.deepEqual(labelCounts(record, NOW), { checked: 2, labeled: 1 });
  assert.deepEqual(labelCounts(undefined, NOW), { checked: 0, labeled: 0 });
});

const CHANNEL = 'UCtH_UJdhBtJN9frodLYob0Q';
const RECENT = ['newestVideo', 'secondVideo', 'thirdVideo1'];
const analysed = (extra = {}) => ({ feedFetchedAt: NOW - HOUR, analysis: { latestVideoId: RECENT[0], recentVideoIds: RECENT }, ...extra });
const checkedOn = (dates) => ({ labels: { checked: dates, labeled: {} } });
const work = (overrides) =>
  channelWork({ channelId: CHANNEL, record: analysed(), grade: 'A', overridden: false, labelCheckEnabled: true, now: NOW, ...overrides });

test('feed: refetched after 24 h, retried 1 h after an error', () => {
  assert.deepEqual(work({ record: undefined }), ['feed']);
  assert.deepEqual(work({ record: analysed({ feedFetchedAt: NOW - 23 * HOUR }) }), []);
  assert.deepEqual(work({ record: analysed({ feedFetchedAt: NOW - 25 * HOUR }) }), ['feed']);
  assert.deepEqual(work({ record: { feedErrorAt: NOW - 30 * MINUTE } }), []);
  assert.deepEqual(work({ record: { feedErrorAt: NOW - 2 * HOUR } }), ['feed']);
  assert.deepEqual(work({ channelId: null }), []);
});

test('label check: only for C or D channels without fresh label data', () => {
  assert.deepEqual(work({ grade: 'C' }), ['label']);
  assert.deepEqual(work({ grade: 'D' }), ['label']);
  assert.deepEqual(work({ grade: 'B' }), []);
  assert.deepEqual(work({ grade: 'E' }), []);
  assert.deepEqual(work({ grade: 'C', overridden: true }), []);
  assert.deepEqual(work({ grade: 'C', labelCheckEnabled: false }), []);
  assert.deepEqual(work({ grade: 'C', record: analysed({ analysis: { latestVideoId: null, recentVideoIds: [] } }) }), []);
  // One fresh check leaves room for a second video; two fresh checks are enough.
  assert.deepEqual(work({ grade: 'D', record: analysed(checkedOn({ newestVideo: NOW - 2 * DAY })) }), ['label']);
  assert.deepEqual(work({ grade: 'D', record: analysed(checkedOn({ newestVideo: NOW - DAY, secondVideo: NOW - DAY })) }), []);
  assert.deepEqual(work({ grade: 'C', record: analysed(checkedOn({ a: NOW - 8 * DAY, b: NOW - 8 * DAY })) }), ['label']);
});

test('label candidates: up to 2 most recent unchecked videos, newest first', () => {
  assert.deepEqual(labelCandidates(analysed(), NOW), ['newestVideo', 'secondVideo']);
  // A video seen on a watch page counts and is skipped.
  assert.deepEqual(labelCandidates(analysed(checkedOn({ newestVideo: NOW - HOUR })), NOW), ['secondVideo']);
  // A check older than 7 days no longer counts.
  assert.deepEqual(labelCandidates(analysed(checkedOn({ newestVideo: NOW - 8 * DAY })), NOW), ['newestVideo', 'secondVideo']);
  assert.deepEqual(labelCandidates(analysed(checkedOn({ other1: NOW - HOUR, other2: NOW - HOUR })), NOW), []);
  // Records analysed before recentVideoIds existed fall back to the latest video.
  assert.deepEqual(labelCandidates({ analysis: { latestVideoId: 'onlyVideo11' } }, NOW), ['onlyVideo11']);
});

test('channel records are kept while any part was touched in the last 7 days', () => {
  assert.equal(isStaleChannel({ feedFetchedAt: NOW - 8 * DAY }, NOW), true);
  assert.equal(isStaleChannel({ feedFetchedAt: NOW - 8 * DAY, handleSeenAt: NOW - DAY }, NOW), false);
  assert.equal(isStaleChannel({ labels: { checked: { a: NOW - 2 * DAY } } }, NOW), false);
});

test('rate states merge to the stricter view (stored + in-memory)', () => {
  const stored = { recent: [NOW - 3 * MINUTE, NOW - MINUTE], backoffUntil: 0 };
  const memory = { recent: [NOW - MINUTE, NOW - 5 * SECOND], backoffUntil: NOW + HOUR };
  assert.deepEqual(mergeRateStates(stored, memory), {
    recent: [NOW - 3 * MINUTE, NOW - MINUTE, NOW - 5 * SECOND],
    backoffUntil: NOW + HOUR,
  });
  // A failed storage write must not lift a backoff: the merged state still denies.
  assert.equal(rateDecision(mergeRateStates(undefined, memory), LABEL_LIMIT, NOW).retryAt, NOW + HOUR);
  assert.deepEqual(mergeRateStates(undefined, undefined), { recent: [], backoffUntil: 0 });
});

test('video count from the handle mapping: fresh for 30 days, same channel only', () => {
  const entry = { id: CHANNEL, at: NOW - DAY, videoCount: 1900, videoCountAt: NOW - 10 * DAY };
  assert.equal(freshVideoCount(entry, CHANNEL, NOW), 1900);
  assert.equal(freshVideoCount(entry, null, NOW), 1900);
  assert.equal(freshVideoCount({ ...entry, videoCountAt: NOW - 31 * DAY }, CHANNEL, NOW), null);
  assert.equal(freshVideoCount(entry, 'UCBJycsmduvYEL83R_U4JriQ', NOW), null);
  assert.equal(freshVideoCount({ id: CHANNEL, at: NOW }, CHANNEL, NOW), null);
});

test('label results (watched video IDs) are dropped after 7 days and bounded per channel', () => {
  const labels = { checked: { a: NOW - DAY, b: NOW - 8 * DAY, c: NOW - 2 * HOUR }, labeled: { b: NOW - 8 * DAY } };
  assert.deepEqual(pruneLabels(labels, NOW), { checked: { c: NOW - 2 * HOUR, a: NOW - DAY }, labeled: {} });
  assert.deepEqual(Object.keys(pruneLabels(labels, NOW, 1).checked), ['c']);
  assert.deepEqual(pruneLabels(undefined, NOW), { checked: {}, labeled: {} });
});
