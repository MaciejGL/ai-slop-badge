import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocklist, normalizeHandle } from '../lib/blocklist.js';

test('keeps @handles (lowercased) and channel IDs, skips comments and junk', () => {
  const text = [
    '! Title: AISList - Blocklist',
    '! - @channelhandle (YouTube handle format)',
    '',
    '@ChickofHonor-l',
    '  @Some.Channel  ',
    'UCtH_UJdhBtJN9frodLYob0Q',
    'not a handle',
    '@',
  ].join('\r\n');
  assert.deepEqual(parseBlocklist(text), {
    handles: ['chickofhonor-l', 'some.channel'],
    ids: ['UCtH_UJdhBtJN9frodLYob0Q'],
  });
});

test('handles from URLs are decoded and lowercased', () => {
  assert.equal(normalizeHandle('/@MKBHD'), 'mkbhd');
  assert.equal(normalizeHandle('@%C3%85se-Kanal'), 'åse-kanal');
  assert.equal(normalizeHandle('/@bad/path'), null);
});
