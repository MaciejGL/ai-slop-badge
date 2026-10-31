import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, decodeXmlEntities } from '../lib/rss.js';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=UCBJycsmduvYEL83R_U4JriQ"/>
 <id>yt:channel:BJycsmduvYEL83R_U4JriQ</id>
 <yt:channelId>BJycsmduvYEL83R_U4JriQ</yt:channelId>
 <title>Tom &amp; Jerry&#39;s &quot;Lab&quot;</title>
 <link rel="alternate" href="https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ"/>
 <author>
  <name>Tom &amp; Jerry</name>
  <uri>https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ</uri>
 </author>
 <published>2008-03-21T15:25:54+00:00</published>
 <entry>
  <id>yt:video:2reQut8WNGc</id>
  <yt:videoId>2reQut8WNGc</yt:videoId>
  <yt:channelId>UCBJycsmduvYEL83R_U4JriQ</yt:channelId>
  <title>Fish &lt;3 &amp; chips &#x1F41F;</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=2reQut8WNGc"/>
  <published>2026-10-29T02:50:34+00:00</published>
  <updated>2026-10-31T20:29:02+00:00</updated>
  <media:group>
   <media:title>Fish &lt;3 &amp; chips</media:title>
   <media:description>Line one
#aiart &amp; more</media:description>
  </media:group>
 </entry>
 <entry>
  <id>yt:video:ai1gIWacf0I</id>
  <yt:videoId>ai1gIWacf0I</yt:videoId>
  <title>This can SEE Sound!</title>
  <link rel="alternate" href="https://www.youtube.com/shorts/ai1gIWacf0I"/>
  <published>2026-10-27T20:14:55+00:00</published>
  <media:group>
   <media:description></media:description>
  </media:group>
 </entry>
</feed>`;

test('parses feed metadata, entries and entities', () => {
  const feed = parseFeed(FEED);
  assert.equal(feed.channelId, 'UCBJycsmduvYEL83R_U4JriQ');
  assert.equal(feed.title, 'Tom & Jerry\'s "Lab"');
  assert.equal(feed.published, Date.UTC(2008, 2, 21, 15, 25, 54));
  assert.equal(feed.entries.length, 2);

  const [first, second] = feed.entries;
  assert.equal(first.videoId, '2reQut8WNGc');
  assert.equal(first.title, 'Fish <3 & chips \u{1F41F}');
  assert.equal(first.published, Date.UTC(2026, 9, 29, 2, 50, 34));
  assert.equal(first.description, 'Line one\n#aiart & more');
  assert.equal(first.isShort, false);

  assert.equal(second.videoId, 'ai1gIWacf0I');
  assert.equal(second.link, 'https://www.youtube.com/shorts/ai1gIWacf0I');
  assert.equal(second.isShort, true);
  assert.equal(second.description, '');
});

test('falls back to the prefixed feed-level yt:channelId', () => {
  const feed = parseFeed('<feed><yt:channelId>BJycsmduvYEL83R_U4JriQ</yt:channelId><title>X</title></feed>');
  assert.equal(feed.channelId, 'UCBJycsmduvYEL83R_U4JriQ');
});

test('empty feed has no entries', () => {
  const feed = parseFeed(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <title>New channel</title><published>2026-10-01T00:00:00+00:00</published></feed>`);
  assert.deepEqual(feed.entries, []);
  assert.equal(feed.title, 'New channel');
  assert.equal(feed.published, Date.UTC(2026, 9, 1));
});

test('garbage input does not throw', () => {
  assert.deepEqual(parseFeed('').entries, []);
  assert.deepEqual(parseFeed(undefined).entries, []);
});

test('entity decoding is single-pass', () => {
  assert.equal(decodeXmlEntities('&amp;lt; &#65;&#x42; &unknown;'), '&lt; AB &unknown;');
});
