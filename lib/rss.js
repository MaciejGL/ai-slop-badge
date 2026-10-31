// Minimal parser for YouTube channel Atom feeds (no DOMParser in service workers).
// https://www.youtube.com/feeds/videos.xml?channel_id=UC...

const CHANNEL_ID_IN_URL_RE = /\/channel\/(UC[A-Za-z0-9_-]{22})/;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? match;
  });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Text content of the first <name> element in `xml`, decoded; null when absent. */
function tagText(xml, name) {
  const tag = escapeRegExp(name);
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!match) return null;
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(match[1]);
  return cdata ? cdata[1] : decodeXmlEntities(match[1]);
}

function attributes(tag) {
  const attrs = {};
  for (const [, name, value] of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
    attrs[name] = decodeXmlEntities(value);
  }
  return attrs;
}

function alternateLink(xml) {
  for (const [tag] of xml.matchAll(/<link\b[^>]*>/g)) {
    const attrs = attributes(tag);
    if (attrs.rel === 'alternate' && attrs.href) return attrs.href;
  }
  return null;
}

function parseDate(text) {
  const time = text ? Date.parse(text.trim()) : NaN;
  return Number.isFinite(time) ? time : null;
}

function parseEntry(xml) {
  const idText = tagText(xml, 'id') || '';
  const videoId = (tagText(xml, 'yt:videoId') || idText.replace(/^yt:video:/, '')).trim();
  if (!videoId) return null;
  const link = alternateLink(xml);
  return {
    videoId,
    title: (tagText(xml, 'title') || '').trim(),
    published: parseDate(tagText(xml, 'published')),
    link,
    isShort: Boolean(link && link.includes('/shorts/')),
    description: tagText(xml, 'media:description') || '',
  };
}

/**
 * @returns {{channelId: string|null, title: string, published: number|null,
 *   entries: {videoId: string, title: string, published: number|null, link: string|null,
 *   isShort: boolean, description: string}[]}}
 */
export function parseFeed(xml) {
  const text = typeof xml === 'string' ? xml : '';
  const firstEntry = text.indexOf('<entry');
  const head = firstEntry === -1 ? text : text.slice(0, firstEntry);

  const uri = tagText(head, 'uri') || alternateLink(head) || '';
  let channelId = CHANNEL_ID_IN_URL_RE.exec(uri)?.[1] || null;
  if (!channelId) {
    // The feed-level <yt:channelId> omits the "UC" prefix.
    const raw = (tagText(head, 'yt:channelId') || '').trim();
    if (/^UC[A-Za-z0-9_-]{22}$/.test(raw)) channelId = raw;
    else if (/^[A-Za-z0-9_-]{22}$/.test(raw)) channelId = `UC${raw}`;
  }

  const entries = [];
  for (const [, body] of text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = parseEntry(body);
    if (entry) entries.push(entry);
  }

  return {
    channelId,
    title: (tagText(head, 'title') || '').trim(),
    published: parseDate(tagText(head, 'published')),
    entries,
  };
}
