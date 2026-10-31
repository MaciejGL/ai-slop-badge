// Isolated-world content script: finds video tiles, shows a grade badge on each
// thumbnail and the details popover. Grades come from the service worker.
(() => {
  'use strict';

  const NS = 'ai-slop-badge';
  const MSG_MAP = `${NS}:map`;
  const MSG_WATCH = `${NS}:watch`;
  const MSG_READY = `${NS}:ready`;

  // Elements that represent one video tile. Nested matches (e.g. a lockup inside a
  // rich item) resolve to the same thumbnail and get a single badge.
  const TILE_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-reel-item-renderer',
    'yt-lockup-view-model',
    'ytm-shorts-lockup-view-model',
    'ytm-shorts-lockup-view-model-v2',
  ].join(',');
  const THUMBNAIL_SELECTOR = 'ytd-thumbnail, yt-thumbnail-view-model, .shortsLockupViewModelHostThumbnailContainer';
  const VIDEO_LINK_SELECTOR = 'a[href*="/watch?v="], a[href*="/shorts/"]';
  const HANDLE_LINK_SELECTOR = 'a[href^="/@"], a[href^="https://www.youtube.com/@"]';
  const CHANNEL_LINK_SELECTOR = 'a[href^="/channel/UC"]';
  // DOM changes inside the video player (progress, captions) never affect tiles.
  const PLAYER_SELECTOR = '#movie_player, .html5-video-player, ytd-player';

  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
  const HANDLE_RE = /^[^\s/?#@]{1,100}$/u;

  const SCAN_DELAY_MS = 250;
  const VIDEO_ONLY_GRACE_MS = 1500; // wait for page data before falling back to oEmbed
  const REPOLL_MS = 10 * 1000;
  const RESULT_TTL_MS = 5 * 60 * 1000;
  const REQUEST_CHUNK = 50;
  const VIDEO_MAP_LIMIT = 20000;
  const MAP_ENTRIES_PER_MESSAGE = 500; // main-world.js posts at most this many per message
  const HELD_WATCH_LIMIT = 10;
  const MAX_VIEW_MODELS_CHARS = 100000;

  const videoMap = new Map(); // videoId -> {channelId, handle}
  const results = new Map(); // key -> {result, at}
  const requestedAt = new Map(); // key -> time of the last request
  const outbox = new Map(); // key -> item waiting to be sent
  const firstSeen = new WeakMap(); // thumbnail host -> {videoId, time}

  let enabled = false;
  let observer = null;
  let scanTimer = null;
  let repollTimer = null;
  let popover = null;
  // Watch observations wait here until their video is the one in the address bar
  // (Shorts responses can arrive before the URL changes). Only one is accepted per
  // navigation, so a page script cannot flood the service worker with forged labels.
  const heldWatch = new Map(); // videoId -> observation
  let watchAcceptedFor = null;

  // ------------------------------------------------------------------------
  // Messaging

  function contextAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  async function send(message) {
    if (!contextAlive()) {
      stop(); // the extension was reloaded or removed
      return null;
    }
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      if (!contextAlive()) stop();
      return null;
    }
  }

  function normalizeHandle(raw) {
    if (typeof raw !== 'string') return null;
    let handle = raw.replace(/^\/?@/, '');
    try {
      handle = decodeURIComponent(handle);
    } catch {
      // keep raw
    }
    handle = handle.toLowerCase();
    return HANDLE_RE.test(handle) ? handle : null;
  }

  // Messages from content/main-world.js. Only same-window, well-formed messages are accepted.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== NS) return;
    if (data.type === MSG_MAP && Array.isArray(data.entries)) onMapEntries(data.entries);
    else if (data.type === MSG_WATCH) onWatch(data);
  });

  function onMapEntries(entries) {
    if (entries.length > MAP_ENTRIES_PER_MESSAGE) return;
    let added = false;
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 3 || !VIDEO_ID_RE.test(entry[0])) continue;
      const channelId = CHANNEL_ID_RE.test(entry[1]) ? entry[1] : null;
      const handle = typeof entry[2] === 'string' && entry[2].length <= 300 ? normalizeHandle(entry[2]) : null;
      if (!channelId && !handle) continue;
      videoMap.delete(entry[0]);
      videoMap.set(entry[0], { channelId, handle });
      added = true;
    }
    while (videoMap.size > VIDEO_MAP_LIMIT) videoMap.delete(videoMap.keys().next().value);
    if (added) scheduleScan();
  }

  function pageVideoId() {
    const { pathname, searchParams } = new URL(window.location.href);
    const id = pathname === '/watch' ? searchParams.get('v') : pathname.match(/^\/shorts\/([^/]+)/)?.[1];
    return VIDEO_ID_RE.test(id || '') ? id : null;
  }

  function onWatch(data) {
    if (!VIDEO_ID_RE.test(data.videoId) || !CHANNEL_ID_RE.test(data.channelId) || !Array.isArray(data.viewModels)) return;
    if (data.viewModels.length > 10 || !data.viewModels.every((vm) => vm && typeof vm === 'object')) return;
    try {
      if (JSON.stringify(data.viewModels).length > MAX_VIEW_MODELS_CHARS) return;
    } catch {
      return;
    }
    heldWatch.delete(data.videoId);
    heldWatch.set(data.videoId, {
      videoId: data.videoId,
      channelId: data.channelId,
      handle: typeof data.handle === 'string' ? normalizeHandle(data.handle) : null,
      viewModels: data.viewModels,
    });
    while (heldWatch.size > HELD_WATCH_LIMIT) heldWatch.delete(heldWatch.keys().next().value);
    acceptHeldWatch();
  }

  /** An observation must agree with the channel YouTube's own data gave for that video, if known. */
  function matchesKnownChannel(videoId, observation) {
    const known = videoMap.get(videoId);
    if (!known) return true;
    if (known.channelId) return known.channelId === observation.channelId;
    return !known.handle || !observation.handle || known.handle === observation.handle;
  }

  async function acceptHeldWatch() {
    if (!enabled) return;
    const videoId = pageVideoId();
    if (!videoId || videoId === watchAcceptedFor || !heldWatch.has(videoId)) return;
    const observation = heldWatch.get(videoId);
    heldWatch.delete(videoId);
    if (!matchesKnownChannel(videoId, observation)) return;
    watchAcceptedFor = videoId;
    videoMap.set(videoId, { channelId: observation.channelId, handle: observation.handle });
    const response = await send({ type: 'watchObservation', ...observation });
    if (response?.ok) {
      // The channel's grade may have changed; ask again.
      forget(observation.channelId);
      if (observation.handle) forget(`@${observation.handle}`);
      scheduleScan();
    }
  }

  function forget(key) {
    results.delete(key);
    requestedAt.delete(key);
  }

  function requestGrade(key, item) {
    const cached = results.get(key);
    const now = Date.now();
    if (cached && cached.result.grade !== null && now - cached.at < RESULT_TTL_MS) return;
    if (cached?.result.unidentified) return;
    if (now - (requestedAt.get(key) || 0) < REPOLL_MS) return;
    requestedAt.set(key, now);
    outbox.set(key, { key, ...item });
  }

  async function flush() {
    if (!outbox.size) return;
    const items = [...outbox.values()];
    outbox.clear();
    for (let i = 0; i < items.length; i += REQUEST_CHUNK) {
      const response = await send({ type: 'getGrades', items: items.slice(i, i + REQUEST_CHUNK) });
      if (response?.results) applyResults(response.results);
    }
  }

  function applyResults(list) {
    if (!Array.isArray(list)) return;
    const now = Date.now();
    for (const entry of list) {
      const key = entry?.key;
      const result = entry?.result;
      if (typeof key !== 'string' || !result || typeof result !== 'object') continue;
      // Also file the result under the resolved channel ID, which tiles may switch to later.
      const keys = result.channelId && result.channelId !== key ? [key, result.channelId] : [key];
      for (const k of keys) {
        results.set(k, { result, at: now });
        for (const badge of document.querySelectorAll(`.ytaib-badge[data-key="${CSS.escape(k)}"]`)) {
          renderBadge(badge, result);
        }
      }
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'grades') applyResults(message.results);
  });

  // ------------------------------------------------------------------------
  // Tile discovery

  function videoIdFromHref(href) {
    if (!href) return null;
    try {
      const url = new URL(href, window.location.origin);
      if (url.searchParams.has('list')) return null; // playlists and mixes
      const id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/shorts\/([^/]+)/)?.[1];
      return VIDEO_ID_RE.test(id || '') ? id : null;
    } catch {
      return null;
    }
  }

  function findThumbnailHost(tile, link) {
    const thumbnail = tile.querySelector(THUMBNAIL_SELECTOR);
    if (thumbnail) return thumbnail;
    const image = link.querySelector('img') ? link : tile.querySelector('a img')?.closest('a');
    return image || null;
  }

  function channelRef(tile, videoId) {
    // Prefer YouTube's own data, as a pair: the DOM byline of a recycled tile can be stale.
    const mapped = videoMap.get(videoId);
    if (mapped) return { videoId, channelId: mapped.channelId, handle: mapped.handle };
    const handleLink = tile.querySelector(HANDLE_LINK_SELECTOR);
    const channelLink = tile.querySelector(CHANNEL_LINK_SELECTOR);
    const domHandle = handleLink ? normalizeHandle(new URL(handleLink.href).pathname.split('/')[1]) : null;
    const domChannelId = channelLink ? channelLink.getAttribute('href').split('/')[2] : null;
    return {
      videoId,
      channelId: CHANNEL_ID_RE.test(domChannelId || '') ? domChannelId : null,
      handle: domHandle,
    };
  }

  function keyFor(ref, host) {
    if (ref.channelId) return ref.channelId;
    if (ref.handle) return `@${ref.handle}`;
    const seen = firstSeen.get(host);
    if (!seen || seen.videoId !== ref.videoId) {
      firstSeen.set(host, { videoId: ref.videoId, time: Date.now() });
      setTimeout(scheduleScan, VIDEO_ONLY_GRACE_MS + 50);
      return null;
    }
    return Date.now() - seen.time >= VIDEO_ONLY_GRACE_MS ? `v:${ref.videoId}` : null;
  }

  function processTile(tile, seenHosts) {
    const link = tile.querySelector(VIDEO_LINK_SELECTOR);
    const videoId = link && videoIdFromHref(link.getAttribute('href'));
    if (!videoId) return;
    const host = findThumbnailHost(tile, link);
    if (!host || seenHosts.has(host)) return;
    seenHosts.add(host);

    let badge = host.querySelector(':scope > .ytaib-badge');
    const ref = channelRef(tile, videoId);
    const key = keyFor(ref, host);
    if (!key || results.get(key)?.result.unidentified) {
      badge?.remove();
      return;
    }
    if (!badge) badge = createBadge(host);
    if (badge.dataset.key !== key || badge.dataset.videoId !== videoId) {
      // New tile content (YouTube recycles tile elements).
      badge.dataset.key = key;
      badge.dataset.videoId = videoId;
      renderBadge(badge, results.get(key)?.result);
    }
    requestGrade(key, { channelId: ref.channelId, handle: ref.handle, videoId: ref.channelId || ref.handle ? null : videoId });
  }

  function scan() {
    if (!enabled || !contextAlive()) return;
    acceptHeldWatch();
    const seenHosts = new Set();
    for (const tile of document.querySelectorAll(TILE_SELECTOR)) {
      try {
        processTile(tile, seenHosts);
      } catch (error) {
        console.debug('[ai-slop-badge] tile skipped', error);
      }
    }
    flush();
  }

  function onMutations(records) {
    for (const record of records) {
      const node = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
      if (!node || !node.closest(PLAYER_SELECTOR)) {
        scheduleScan();
        return;
      }
    }
  }

  function scheduleScan() {
    if (scanTimer || !enabled) return;
    scanTimer = setTimeout(() => {
      requestIdleCallback(
        () => {
          scanTimer = null;
          scan();
        },
        { timeout: 1000 },
      );
    }, SCAN_DELAY_MS);
  }

  // ------------------------------------------------------------------------
  // Badge

  function createBadge(host) {
    if (getComputedStyle(host).position === 'static') host.classList.add('ytaib-host');
    const badge = document.createElement('span');
    badge.className = 'ytaib-badge';
    badge.setAttribute('role', 'button');
    badge.tabIndex = 0;
    const ai = document.createElement('span');
    ai.className = 'ytaib-badge__ai';
    ai.textContent = 'AI';
    const grade = document.createElement('span');
    grade.className = 'ytaib-badge__grade';
    badge.append(ai, grade);
    host.append(badge);
    return badge;
  }

  // AiSList's own "Removal request" issue template (opens on GitHub).
  const AISLIST_REMOVAL_URL = 'https://github.com/Override92/AiSList/issues/new?template=removal-request.md';

  function reasonsOf(result) {
    return Array.isArray(result?.reasons) ? result.reasons.filter((reason) => typeof reason === 'string') : [];
  }

  /** "C · Suspicious", or the pending status. */
  function headline(result) {
    if (!result?.grade) return reasonsOf(result)[0] || 'Checking channel…';
    return `${result.grade} · ${result.summary || ''}`;
  }

  function renderBadge(badge, result) {
    if (result?.unidentified) {
      badge.remove();
      return;
    }
    const grade = /^[A-E]$/.test(result?.grade) ? result.grade : null;
    badge.dataset.grade = grade || 'pending';
    badge.querySelector('.ytaib-badge__grade').textContent = grade || '…';
    const lines = grade ? [`AI grade ${headline(result)}`, ...reasonsOf(result).map((reason) => `• ${reason}`)] : [headline(result)];
    badge.title = `${lines.join('\n')}\nClick for details`;
    badge.setAttribute('aria-label', grade ? `AI grade ${headline(result)}. ${reasonsOf(result).join('. ')}` : headline(result));
  }

  // ------------------------------------------------------------------------
  // Popover

  function closePopover() {
    popover?.remove();
    popover = null;
  }

  function button(label, onClick) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'ytaib-popover__button';
    el.textContent = label;
    el.addEventListener('click', onClick);
    return el;
  }

  async function setOverride(result, value) {
    closePopover();
    await send({ type: 'setOverride', channelId: result.channelId, handle: result.handle, value });
    // storage.onChanged re-requests grades in every tab.
  }

  function openPopover(badge) {
    closePopover();
    const result = results.get(badge.dataset.key)?.result;
    popover = document.createElement('div');
    popover.className = 'ytaib-popover';
    popover.setAttribute('role', 'dialog');

    const title = document.createElement('div');
    title.className = 'ytaib-popover__title';
    title.textContent = result?.title || (result?.handle ? `@${result.handle}` : 'This channel');

    const grade = document.createElement('div');
    grade.className = 'ytaib-popover__grade';
    if (result?.grade) grade.dataset.grade = result.grade;
    grade.textContent = result?.grade ? `AI grade ${headline(result)}` : headline(result);

    const reasons = document.createElement('ul');
    reasons.className = 'ytaib-popover__reasons';
    for (const reason of result?.grade ? reasonsOf(result) : []) {
      const li = document.createElement('li');
      li.textContent = reason;
      reasons.append(li);
    }

    const note = document.createElement('div');
    note.className = 'ytaib-popover__note';
    note.textContent = 'Heuristic grade, not proof. A means no AI signs were found.';

    popover.append(title, grade);
    if (reasons.childElementCount) popover.append(reasons);
    popover.append(note);
    if (result?.stats?.blocklisted && !result.override) {
      const report = document.createElement('a');
      report.className = 'ytaib-popover__link';
      report.href = AISLIST_REMOVAL_URL;
      report.target = '_blank';
      report.rel = 'noopener noreferrer';
      report.textContent = 'Wrong? Request removal from AiSList (GitHub)';
      popover.append(report);
    }
    if (result && (result.channelId || result.handle)) {
      const actions = document.createElement('div');
      actions.className = 'ytaib-popover__actions';
      if (result.override !== 'not_ai') actions.append(button('Not AI', () => setOverride(result, 'not_ai')));
      if (result.override !== 'ai') actions.append(button('Mark as AI', () => setOverride(result, 'ai')));
      if (result.override) actions.append(button('Clear override', () => setOverride(result, null)));
      popover.append(actions);
    }

    document.body.append(popover);
    const rect = badge.getBoundingClientRect();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below;
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    popover.querySelector('button')?.focus({ preventScroll: true });
  }

  // Capture on window runs before any YouTube handler, so a click on the badge never
  // reaches the surrounding link (no navigation, no inline preview).
  function onPointerEvent(event) {
    const badge = event.target instanceof Element ? event.target.closest('.ytaib-badge') : null;
    if (badge) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'click') openPopover(badge);
      return;
    }
    if (popover && event.type === 'mousedown' && !popover.contains(event.target)) closePopover();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && popover) {
      closePopover();
      return;
    }
    const badge = event.target instanceof Element ? event.target.closest('.ytaib-badge') : null;
    if (badge && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openPopover(badge);
    }
  }

  const POINTER_EVENTS = ['click', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick'];

  // ------------------------------------------------------------------------
  // Lifecycle

  function onNavigateStart() {
    closePopover();
    watchAcceptedFor = null; // allow one observation for the next page
  }

  function start() {
    if (enabled) return;
    enabled = true;
    POINTER_EVENTS.forEach((type) => window.addEventListener(type, onPointerEvent, true));
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', closePopover, { capture: true, passive: true });
    document.addEventListener('yt-navigate-start', onNavigateStart);
    document.addEventListener('yt-navigate-finish', scheduleScan);
    observer = new MutationObserver(onMutations);
    const attach = () => {
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
      scheduleScan();
    };
    if (document.documentElement) attach();
    else document.addEventListener('DOMContentLoaded', attach, { once: true });
    repollTimer = setInterval(scheduleScan, REPOLL_MS);
  }

  function stop() {
    enabled = false;
    POINTER_EVENTS.forEach((type) => window.removeEventListener(type, onPointerEvent, true));
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', closePopover, { capture: true });
    document.removeEventListener('yt-navigate-start', onNavigateStart);
    document.removeEventListener('yt-navigate-finish', scheduleScan);
    observer?.disconnect();
    observer = null;
    clearInterval(repollTimer);
    clearTimeout(scanTimer);
    scanTimer = null;
    closePopover();
    document.querySelectorAll('.ytaib-badge').forEach((badge) => badge.remove());
    document.querySelectorAll('.ytaib-host').forEach((host) => host.classList.remove('ytaib-host'));
  }

  function resetResults() {
    results.clear();
    requestedAt.clear();
    scheduleScan();
  }

  chrome.storage.local
    .get('settings')
    .then(({ settings }) => {
      if (settings?.enabled !== false) start();
    })
    .catch((error) => console.debug('[ai-slop-badge] settings unavailable', error));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      const on = changes.settings.newValue?.enabled !== false;
      if (on) {
        start();
        resetResults();
      } else {
        stop();
      }
    }
    if (changes.overrides || changes.cacheEpoch) resetResults();
  });

  window.postMessage({ source: NS, type: MSG_READY }, window.location.origin);
})();
