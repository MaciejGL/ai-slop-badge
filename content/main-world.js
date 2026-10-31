// Runs in the page's MAIN world. Reads YouTube's own JSON (ytInitialData and
// youtubei/v1 responses) to learn which channel each video belongs to, and the
// "How this was made" section of the video being watched. Results are posted to
// the isolated content script. Everything is wrapped so a failure here can never
// break YouTube itself.
(() => {
  'use strict';

  const NS = 'ai-slop-badge';
  const MSG_MAP = `${NS}:map`;
  const MSG_WATCH = `${NS}:watch`;
  const MSG_READY = `${NS}:ready`;

  const API_RE = /\/youtubei\/v1\/(browse|search|next|player|reel\/reel_item_watch|reel\/reel_watch_sequence)(?:[?/]|$)/;
  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
  const LABEL_KEY = 'howThisWasMadeSectionViewModel';

  const WALK_MAX_NODES = 300000;
  const OWNER_MAX_NODES = 1500;
  const OWNER_MAX_DEPTH = 18;
  const KNOWN_LIMIT = 5000;
  const POST_CHUNK = 500;

  const known = new Map(); // videoId -> [channelId|null, handle|null]
  let lastWatch = null;

  function safely(fn) {
    try {
      fn();
    } catch (error) {
      console.debug('[ai-slop-badge]', error);
    }
  }

  function post(type, payload) {
    window.postMessage({ source: NS, type, ...payload }, window.location.origin);
  }

  function handleFromUrl(url) {
    if (typeof url !== 'string') return null;
    const match = /^(?:https:\/\/www\.youtube\.com)?\/@([^/?#]+)/.exec(url);
    return match ? match[1] : null;
  }

  /** First channel (browseId "UC...") and handle found inside a renderer, depth-first in key order. */
  function findOwner(root) {
    let budget = OWNER_MAX_NODES;
    let handle = null;
    let channelId = null;
    const visit = (node, depth) => {
      if (channelId || budget-- <= 0 || depth > OWNER_MAX_DEPTH || !node || typeof node !== 'object') return;
      if (typeof node.browseId === 'string' && CHANNEL_ID_RE.test(node.browseId)) {
        channelId = node.browseId;
        handle = handleFromUrl(node.canonicalBaseUrl) || handle;
        return;
      }
      if (!handle) handle = handleFromUrl(node.canonicalBaseUrl) || handleFromUrl(node.url);
      for (const key in node) visit(node[key], depth + 1);
    };
    visit(root, 0);
    return channelId || handle ? [channelId, handle] : null;
  }

  /** Walks a response and maps every video renderer to its channel. */
  function collectMappings(root) {
    const found = [];
    const stack = [root];
    let budget = WALK_MAX_NODES;
    while (stack.length && budget-- > 0) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (!Array.isArray(node)) {
        const id = typeof node.videoId === 'string' ? node.videoId : node.contentId;
        if (typeof id === 'string' && VIDEO_ID_RE.test(id)) {
          const owner = findOwner(node);
          if (owner) {
            found.push([id, ...owner]);
            continue; // the subtree belongs to this video
          }
        }
      }
      for (const key in node) {
        const value = node[key];
        if (value && typeof value === 'object') stack.push(value);
      }
    }
    return found;
  }

  function remember(entries) {
    const fresh = [];
    for (const [videoId, channelId, handle] of entries) {
      const previous = known.get(videoId);
      if (previous && previous[0] === channelId && previous[1] === handle) continue;
      known.delete(videoId);
      known.set(videoId, [channelId, handle]);
      fresh.push([videoId, channelId, handle]);
    }
    while (known.size > KNOWN_LIMIT) known.delete(known.keys().next().value);
    for (let i = 0; i < fresh.length; i += POST_CHUNK) post(MSG_MAP, { entries: fresh.slice(i, i + POST_CHUNK) });
  }

  /** Breadth-first search for the first value stored under `key`. */
  function findKey(root, key, maxNodes = 50000) {
    const queue = [root];
    for (let i = 0; i < queue.length && i < maxNodes; i++) {
      const node = queue[i];
      if (!node || typeof node !== 'object') continue;
      if (!Array.isArray(node) && node[key] && typeof node[key] === 'object') return node[key];
      for (const k in node) if (node[k] && typeof node[k] === 'object') queue.push(node[k]);
    }
    return null;
  }

  function collectLabelViewModels(root) {
    const found = [];
    const stack = [root];
    let budget = WALK_MAX_NODES;
    while (stack.length && budget-- > 0) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      for (const key in node) {
        const value = node[key];
        if (key === LABEL_KEY && value && typeof value === 'object') found.push(value);
        else if (value && typeof value === 'object') stack.push(value);
      }
    }
    return found;
  }

  /**
   * Watch or Shorts page data (ytInitialData, /next, /reel/reel_item_watch): the current
   * video, its channel and the "How this was made" section of its description.
   * Shorts responses do not name their own video, so the caller passes a hint
   * ({videoId, channelId?}); a hinted channel must match the description's channel.
   */
  function handleWatchData(data, hint) {
    const panels = data?.engagementPanels;
    if (!Array.isArray(panels)) return;
    const description = findKey(panels, 'structuredDescriptionContentRenderer');
    if (!description) return; // continuation responses carry no description
    const ownerSource = findKey(data.contents, 'videoOwnerRenderer') || findKey(description, 'videoDescriptionHeaderRenderer');
    const owner = ownerSource && findOwner(ownerSource);
    if (!owner || !owner[0]) return;
    const endpointVideoId = data.currentVideoEndpoint?.watchEndpoint?.videoId;
    let videoId = endpointVideoId;
    if (!videoId && hint?.videoId && (!hint.channelId || hint.channelId === owner[0])) videoId = hint.videoId;
    if (!VIDEO_ID_RE.test(videoId || '')) return;
    lastWatch = {
      videoId,
      channelId: owner[0],
      handle: owner[1],
      // Only plain JSON is posted; the service worker decides whether it is the AI label.
      viewModels: collectLabelViewModels(description).slice(0, 10),
    };
    post(MSG_WATCH, lastWatch);
  }

  function handlePlayer(player) {
    const details = player?.videoDetails;
    if (details && VIDEO_ID_RE.test(details.videoId || '') && CHANNEL_ID_RE.test(details.channelId || '')) {
      const previous = known.get(details.videoId);
      remember([[details.videoId, details.channelId, previous ? previous[1] : null]]);
    }
  }

  function playerHint(player) {
    const details = player?.videoDetails;
    return details ? { videoId: details.videoId, channelId: details.channelId } : null;
  }

  // The mapping walk covers the whole response; keep it off the critical path.
  const whenIdle = typeof window.requestIdleCallback === 'function'
    ? (fn) => window.requestIdleCallback(() => safely(fn), { timeout: 2000 })
    : (fn) => setTimeout(() => safely(fn), 0);

  function handleData(data, hint) {
    if (!data || typeof data !== 'object') return;
    safely(() => handleWatchData(data, hint)); // small, bounded lookups; run now
    whenIdle(() => remember(collectMappings(data)));
  }

  function readInitialData() {
    const player = window.ytInitialPlayerResponse;
    safely(() => handlePlayer(player));
    safely(() => handleData(window.ytInitialData, playerHint(player)));
  }

  // --- fetch observation -------------------------------------------------

  function apiKind(url) {
    return API_RE.exec(url)?.[1] || null;
  }

  /** Video ID from a /reel/reel_item_watch request body ({playerRequest: {videoId}}). */
  function requestedVideoId(input, init) {
    const parse = (text) => {
      try {
        const body = JSON.parse(text);
        return body?.playerRequest?.videoId || body?.videoId || null;
      } catch {
        return null;
      }
    };
    if (typeof init?.body === 'string') return Promise.resolve(parse(init.body));
    if (input instanceof Request) return input.clone().text().then(parse, () => null);
    return Promise.resolve(null);
  }

  function observe(kind, response, videoIdPromise) {
    if (!response?.ok) return;
    Promise.all([response.clone().json(), videoIdPromise]).then(([data, videoId]) => {
      safely(() => {
        if (kind === 'player') handlePlayer(data);
        else handleData(data, videoId ? { videoId } : null);
      });
    }, () => {});
  }

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    const wrappedFetch = function (...args) {
      let kind = null;
      let videoIdPromise = null;
      safely(() => {
        const input = args[0];
        const url = typeof input === 'string' ? input : input?.url || String(input || '');
        kind = apiKind(url);
        // Read the request body before fetch consumes it.
        if (kind === 'reel/reel_item_watch') videoIdPromise = requestedVideoId(input, args[1]);
      });
      const promise = nativeFetch.apply(this, args);
      if (kind) {
        promise.then((response) => safely(() => observe(kind, response, videoIdPromise)), () => {});
      }
      return promise;
    };
    window.fetch = wrappedFetch;
  }

  // --- page lifecycle ----------------------------------------------------

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', readInitialData, { once: true });
  } else {
    readInitialData();
  }

  // SPA navigations carry the new page's data in the event detail.
  document.addEventListener('yt-navigate-finish', (event) => {
    safely(() => {
      const response = event?.detail?.response;
      if (!response) return;
      handlePlayer(response.playerResponse);
      const hint = playerHint(response.playerResponse) || { videoId: response.endpoint?.reelWatchEndpoint?.videoId };
      handleData(response.response, hint);
    });
  });

  // The isolated script may start after us; replay what we know when it asks.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== NS || event.data.type !== MSG_READY) return;
    safely(() => {
      const entries = [...known].map(([videoId, [channelId, handle]]) => [videoId, channelId, handle]);
      for (let i = 0; i < entries.length; i += POST_CHUNK) post(MSG_MAP, { entries: entries.slice(i, i + POST_CHUNK) });
      if (lastWatch) post(MSG_WATCH, lastWatch);
    });
  });
})();
