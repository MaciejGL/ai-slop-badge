// Helpers for reading data out of YouTube watch and channel pages.
//
// YouTube's "How this was made" section (howThisWasMadeSectionViewModel) is used for
// both "Made with AI" (altered or synthetic content) and other disclosures such as
// "Auto-dubbed". Its texts are localized, so the only reliable marker for the AI label
// is the help-center link it points to.

const LABEL_VIEW_MODEL_KEY = 'howThisWasMadeSectionViewModel';
const AI_LABEL_HELP_RE = /support\.google\.com(?:\/|%2F)youtube(?:\/|%2F)answer(?:\/|%2F)15447836(?!\d)/i;

const DESCRIPTION_PANEL_MARKER = '"structuredDescriptionContentRenderer"';
const MAX_VIEW_MODEL_CHARS = 50000;
const CHANNEL_ID_PATTERNS = [
  /"externalId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/,
  /<meta\s+itemprop="identifier"\s+content="(UC[A-Za-z0-9_-]{22})"/,
  /<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/,
];

/** True when a howThisWasMadeSectionViewModel object links to the AI disclosure help page. */
export function viewModelHasAiLabel(viewModel) {
  if (!viewModel || typeof viewModel !== 'object') return false;
  try {
    return AI_LABEL_HELP_RE.test(JSON.stringify(viewModel));
  } catch {
    return false;
  }
}

/** True when any "How this was made" section observed on a watch page is the AI label. */
export function observationHasAiLabel(viewModels) {
  return Array.isArray(viewModels) && viewModels.some(viewModelHasAiLabel);
}

/**
 * Returns the JSON object literal that starts at `start` (which must be "{"),
 * respecting strings and escapes, or null if it is unbalanced or too large.
 */
function extractJsonObject(text, start, maxChars = MAX_VIEW_MODEL_CHARS) {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  const end = Math.min(text.length, start + maxChars);
  for (let i = start; i < end; i++) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Looks for the AI label in a raw watch-page HTML document.
 * `checked` is false when the page lacks the description data (e.g. a consent or bot-check page),
 * in which case `aiLabel` says nothing.
 */
export function detectAiLabelInHtml(html) {
  const text = typeof html === 'string' ? html : '';
  const marker = `"${LABEL_VIEW_MODEL_KEY}"`;
  let found = 0;
  let aiLabel = false;
  for (let index = text.indexOf(marker); index !== -1; index = text.indexOf(marker, index + marker.length)) {
    // Skip mentions that are not an object property (e.g. renderer name lists).
    const match = /^\s*:\s*/.exec(text.slice(index + marker.length, index + marker.length + 10));
    if (!match) continue;
    const raw = extractJsonObject(text, index + marker.length + match[0].length);
    if (!raw) continue;
    found++;
    let labeled;
    try {
      labeled = viewModelHasAiLabel(JSON.parse(raw));
    } catch {
      labeled = AI_LABEL_HELP_RE.test(raw.replace(/\\\//g, '/'));
    }
    if (labeled) aiLabel = true;
  }
  return { checked: found > 0 || text.includes(DESCRIPTION_PANEL_MARKER), aiLabel };
}

const PAGE_HEADER_MARKER = '"pageHeaderViewModel":';
const VIDEO_COUNT_RE = /^([\d.,]+)\s*([KMB])?\s+videos?$/i;
const COUNT_SUFFIX = { K: 1e3, M: 1e6, B: 1e9 };

/** Parses an English channel-header count such as "62 videos", "1,234 videos" or "1.8K videos". */
function parseVideoCount(text) {
  const match = VIDEO_COUNT_RE.exec(String(text || '').trim());
  if (!match) return null;
  const number = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(number)) return null;
  return Math.round(number * (match[2] ? COUNT_SUFFIX[match[2].toUpperCase()] : 1));
}

/**
 * Total video count from the header of an English channel page, or null.
 * The header text is localized, so the page must be requested with Accept-Language: en.
 */
export function extractVideoCountFromPage(html) {
  const text = typeof html === 'string' ? html : '';
  const index = text.indexOf(PAGE_HEADER_MARKER);
  if (index === -1) return null;
  const raw = extractJsonObject(text, text.indexOf('{', index + PAGE_HEADER_MARKER.length), 200000);
  if (!raw) return null;
  let header;
  try {
    header = JSON.parse(raw);
  } catch {
    return null;
  }
  const rows = header?.metadata?.contentMetadataViewModel?.metadataRows;
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const part of Array.isArray(row?.metadataParts) ? row.metadataParts : []) {
      const count = parseVideoCount(part?.text?.content);
      if (count !== null) return count;
    }
  }
  return null;
}

/** Reads the channel ID ("UC...") from a channel page such as https://www.youtube.com/@handle. */
export function extractChannelIdFromPage(html) {
  const text = typeof html === 'string' ? html : '';
  for (const pattern of CHANNEL_ID_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[1];
  }
  return null;
}
