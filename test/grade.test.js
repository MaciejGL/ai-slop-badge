import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFeed, gradeChannel, findDisclosures } from '../lib/grade.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);

const strong = (id) => ({ id, strong: true, reason: id });
const weak = (id) => ({ id, strong: false, reason: id });

// A stored feed analysis as produced by analyzeFeed.
function feed({ heuristics = [], disclosed = false } = {}) {
  return {
    heuristics,
    disclosure: { detected: disclosed, count: disclosed ? 4 : 0, terms: disclosed ? ['ai-generated'] : [] },
    latestVideoId: 'aaaaaaaaaaa',
    stats: { entries: 15 },
  };
}

const labels = (labeled, checked = labeled) => ({ checked, labeled });

test('E: label on two videos', () => {
  assert.equal(gradeChannel({ feed: feed(), labels: labels(2) }).grade, 'E');
});

test('E: label on one video plus blocklist', () => {
  assert.equal(gradeChannel({ blocklisted: true, labels: labels(1) }).grade, 'E');
});

test('E: label on one video plus self-disclosure', () => {
  assert.equal(gradeChannel({ feed: feed({ disclosed: true }), labels: labels(1) }).grade, 'E');
});

test('D: label on one video alone', () => {
  assert.equal(gradeChannel({ feed: feed(), labels: labels(1) }).grade, 'D');
});

test('D: self-disclosure alone', () => {
  assert.equal(gradeChannel({ feed: feed({ disclosed: true }) }).grade, 'D');
});

test('D: blocklist plus two strong heuristics', () => {
  assert.equal(gradeChannel({ blocklisted: true, feed: feed({ heuristics: [strong('rate'), strong('burst')] }) }).grade, 'D');
});

test('C: blocklist plus one strong heuristic stays C (the community list can be wrong)', () => {
  assert.equal(gradeChannel({ blocklisted: true, feed: feed({ heuristics: [strong('template')] }) }).grade, 'C');
});

test('C: blocklist plus one strong and one weak heuristic stays C', () => {
  assert.equal(gradeChannel({ blocklisted: true, feed: feed({ heuristics: [strong('rate'), weak('schedule')] }) }).grade, 'C');
});

test('E: label on one video plus blocklist, whatever the heuristics', () => {
  assert.equal(gradeChannel({ blocklisted: true, feed: feed(), labels: labels(1, 2) }).grade, 'E');
});

test('C: blocklist only, graded before the feed is checked', () => {
  const result = gradeChannel({ blocklisted: true });
  assert.equal(result.grade, 'C');
  assert.equal(result.summary, 'Suspicious');
  assert.deepEqual(result.reasons, ['On the AiSList community list']);
});

test('C: three strong heuristics', () => {
  const result = gradeChannel({ feed: feed({ heuristics: [strong('rate'), strong('burst'), strong('young')] }) });
  assert.equal(result.grade, 'C');
});

test('B: two strong heuristics are not enough for C', () => {
  assert.equal(gradeChannel({ feed: feed({ heuristics: [strong('rate'), strong('burst')] }) }).grade, 'B');
});

test('B: two strong plus one weak heuristic is still B', () => {
  const heuristics = [strong('rate'), strong('burst'), weak('schedule')];
  assert.equal(gradeChannel({ feed: feed({ heuristics }) }).grade, 'B');
});

test('B: one weak heuristic', () => {
  assert.equal(gradeChannel({ feed: feed({ heuristics: [weak('schedule')] }) }).grade, 'B');
});

test('A: feed checked and nothing found', () => {
  const result = gradeChannel({ feed: feed(), labels: labels(0, 1) });
  assert.equal(result.grade, 'A');
  assert.equal(result.summary, 'No AI signs found');
  assert.deepEqual(result.reasons, ['Checked 15 recent uploads; no YouTube AI label on 1 checked video']);
});

test('pending: feed not checked yet and no other signal', () => {
  assert.equal(gradeChannel({}).grade, null);
  assert.equal(gradeChannel({ labels: labels(0, 3) }).grade, null);
});

test('override "not AI" beats every signal', () => {
  const result = gradeChannel({
    override: 'not_ai',
    blocklisted: true,
    feed: feed({ disclosed: true }),
    labels: labels(3),
  });
  assert.equal(result.grade, 'A');
  assert.deepEqual(result.reasons, ['Your override']);
});

test('override "AI" grades E even without signals', () => {
  const result = gradeChannel({ override: 'ai', feed: feed() });
  assert.equal(result.grade, 'E');
  assert.deepEqual(result.reasons, ['Your override']);
});

test('reasons list labels, heuristics and blocklist', () => {
  const result = gradeChannel({
    blocklisted: true,
    feed: feed({ heuristics: [{ id: 'rate', strong: true, reason: '~5.3 uploads per day' }] }),
    labels: labels(1, 2),
  });
  assert.equal(result.summary, 'AI-generated');
  assert.deepEqual(result.reasons, [
    'YouTube "Made with AI" label on 1 of 2 checked videos',
    '~5.3 uploads per day',
    'On the AiSList community list',
  ]);
});

test('lifetime output: at least 1 video per day over the channel life with 100+ videos is strong', () => {
  const old = (days) => ({ ...feed(), stats: { entries: 15, channelAgeDays: days } });
  // 400 videos in 200 days = 2/day; with two other strong heuristics that makes C.
  const three = { ...old(200), heuristics: [strong('rate'), strong('burst')] };
  assert.equal(gradeChannel({ feed: three, videoCount: 400 }).grade, 'C');
  assert.ok(gradeChannel({ feed: old(200), videoCount: 400 }).reasons[0].startsWith('~2 uploads per day since the channel started'));
  // 1,900 videos over 17 years (Luetin09) or 99 videos in 50 days do not count.
  assert.equal(gradeChannel({ feed: old(6300), videoCount: 1900 }).grade, 'A');
  assert.equal(gradeChannel({ feed: old(50), videoCount: 99 }).grade, 'A');
  assert.equal(gradeChannel({ feed: old(200), videoCount: null }).grade, 'A');
});

// --- Feed heuristics ---

// Short default titles stay below the templated-title length, so only the tested heuristic fires.
function entry(published, title = 'Clip', description = '') {
  return { videoId: 'v' + String(published).slice(-10), title, published, link: null, isShort: false, description };
}

const ids = (analysis) => analysis.heuristics.map((h) => h.id).sort();

test('upload rate: 5 uploads over 2 days is 2/day (strong); 4 entries are not rated', () => {
  const minute = 60 * 1000;
  const five = [0, 12 * HOUR - 7 * minute, 24 * HOUR - 14 * minute, 36 * HOUR - 21 * minute, 48 * HOUR].map((ago) => entry(NOW - ago));
  const analysis = analyzeFeed({ title: 'Chan', published: NOW - 1000 * DAY, entries: five }, NOW);
  assert.ok(ids(analysis).includes('rate'));

  const four = five.slice(0, 4);
  assert.ok(!ids(analyzeFeed({ title: 'Chan', published: NOW - 1000 * DAY, entries: four }, NOW)).includes('rate'));
});

test('burst: 3 uploads within 2 hours is strong; 3 uploads spread over 3 hours is not', () => {
  const tight = [entry(NOW), entry(NOW - 50 * 60 * 1000), entry(NOW - 110 * 60 * 1000)];
  assert.deepEqual(ids(analyzeFeed({ entries: tight }, NOW)), ['burst']);

  const loose = [entry(NOW), entry(NOW - 90 * 60 * 1000), entry(NOW - 180 * 60 * 1000)];
  assert.deepEqual(ids(analyzeFeed({ entries: loose }, NOW)), []);
});

test('young channel: under 6 months with a full feed of 15', () => {
  const entries = Array.from({ length: 15 }, (_, i) => entry(NOW - i * 3 * DAY - i * 61 * 1000));
  const young = analyzeFeed({ title: 'Chan', published: NOW - 60 * DAY, entries }, NOW);
  assert.ok(ids(young).includes('young'));
  const old = analyzeFeed({ title: 'Chan', published: NOW - 400 * DAY, entries }, NOW);
  assert.ok(!ids(old).includes('young'));
});

test('templated titles: shared prefix with varying numbers', () => {
  const entries = Array.from({ length: 6 }, (_, i) =>
    entry(NOW - i * 5 * DAY - i * 61 * 1000, `Day ${i + 1} of surviving in the frozen forest alone ${['wolf', 'bear', 'snow', 'ice', 'storm', 'night'][i]}`),
  );
  assert.ok(ids(analyzeFeed({ title: 'Chan', entries }, NOW)).includes('template'));
});

test('templated titles: a shared channel-name suffix is ignored', () => {
  const entries = ['Cooking pasta', 'Fixing a bike', 'Garden tour', 'Q&A night', 'Road trip', 'Moving day'].map((t, i) =>
    entry(NOW - i * 5 * DAY - i * 61 * 1000, `${t} | The Weekend Workshop Show`),
  );
  assert.ok(!ids(analyzeFeed({ title: 'The Weekend Workshop Show', entries }, NOW)).includes('template'));
});

// Regression: a 17-year-old human lore channel (Luetin09) was flagged because most
// titles end in the same series suffix.
test('templated titles: a recurring "| Series" suffix on varied titles is not templating', () => {
  const titles = [
    'THE EMPEROR WAS DEFEATED - BEFORE - THE SIEGE OF TERRA | Warhammer 40,000 Lore/History',
    '40K - THE SILENT DEATH OF STC - Anything goes now? | Warhammer 40,000 Lore/Discussion',
    '40K 11ED - VINDICATION FOR YARRICK - AMID LORE ARMAGEDDON | Warhammer 40,000 History/Rant/Lore',
    'THE RISE & FALL OF HUMAN CIVILIZATIONS [2] - SURVIVORS OF THE APOCALYPSE',
    'BELISARIUS CAWL - THE TRUE OMNISSIAH? | Warhammer 40,000 Lore/History',
    '40K - THE GREAT NACHMUND WAR [4]: PURIFICATION | Warhammer 40,000 Lore/History',
    '40K - THE DARK ANGELS - and return of THE LION | Warhammer 40,000 Lore/History',
    '40K - THE DARK AGE OF AI and THE STC LIE | Warhammer 40,000 Lore/Speculation',
    'THE SLEEPER LEGION - WHO WON THE HERESY | Warhammer 40,000 Lore/History',
    '40K PRIMARCHS - SANGUINIUS - THE RISE AND FALL OF AN ANGEL | Warhammer 40,000 Lore/History',
    'WHY DID THIS HAPPEN? - THE TERMINUS DECREE REVEALED | Warhammer 40,000 Lore/Discussion',
    'THE COST OF COURAGE IN M41 - The Tragedy of Lyubov | Warhammer 40,000 Lore/History',
    'ANGRON - THE RED ANGEL RETURNS | Warhammer 40,000 Lore/History',
    'THE NECRONS - SLEEPERS OF THE GALAXY | Warhammer 40,000 Lore/History',
    'HORUS LUPERCAL - THE FIRST WARMASTER | Warhammer 40,000 Lore/History',
  ];
  const entries = titles.map((title, i) => entry(NOW - i * 30 * DAY - i * 61 * 1000, title));
  const analysis = analyzeFeed({ title: 'Luetin09', published: NOW - 6300 * DAY, entries }, NOW);
  assert.deepEqual(analysis.heuristics, []);
});

test('templated titles: numbered template is still caught behind a series suffix', () => {
  const entries = ['wolf', 'bear', 'snow', 'ice', 'storm', 'night'].map((word, i) =>
    entry(NOW - i * 5 * DAY - i * 61 * 1000, `Day ${i + 1} of surviving in the frozen forest alone ${word} | Survival Series`),
  );
  assert.ok(ids(analyzeFeed({ title: 'Chan', entries }, NOW)).includes('template'));
});

test('fixed schedule: same minute of day on most uploads is a weak heuristic', () => {
  const at1500 = Date.UTC(2026, 9, 30, 15, 0, 0);
  const entries = Array.from({ length: 6 }, (_, i) => entry(at1500 - i * 4 * DAY));
  const analysis = analyzeFeed({ entries }, NOW);
  assert.deepEqual(analysis.heuristics.map((h) => [h.id, h.strong]), [['schedule', false]]);
});

test('self-disclosure needs several videos', () => {
  const spaced = (i) => NOW - i * 5 * DAY - i * 61 * 1000;
  const one = [entry(spaced(0), 'Clip', 'This video is AI-generated.'), entry(spaced(1)), entry(spaced(2))];
  assert.equal(analyzeFeed({ entries: one }, NOW).disclosure.detected, false);

  const two = [entry(spaced(0), 'Clip', 'Made with AI'), entry(spaced(1), 'Cat dance #aivideo'), entry(spaced(2))];
  const analysis = analyzeFeed({ entries: two }, NOW);
  assert.equal(analysis.disclosure.detected, true);
  assert.equal(analysis.disclosure.count, 2);
});

test('disclosure keywords are case-insensitive and avoid look-alikes', () => {
  assert.deepEqual(findDisclosures('AI Generated story'), ['ai generated']);
  assert.deepEqual(findDisclosures('narrated by an AI-voiced host'), ['ai-voiced']);
  assert.deepEqual(findDisclosures('#Sora dream'), ['#sora']);
  assert.deepEqual(findDisclosures('Generated with love by my family'), []);
  assert.deepEqual(findDisclosures('#soraya'), []);
});

test('empty feed yields no signals and grades A', () => {
  const analysis = analyzeFeed({ title: 'Quiet', published: null, entries: [] }, NOW);
  assert.deepEqual(analysis.heuristics, []);
  assert.equal(analysis.latestVideoId, null);
  assert.equal(gradeChannel({ feed: analysis }).grade, 'A');
});
