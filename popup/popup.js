import { STORAGE_KEYS, withDefaultSettings } from '../lib/settings.js';
import { GRADE_MEANINGS } from '../lib/grade.js';

const store = chrome.storage.local;
const toggles = ['enabled', 'useBlocklist', 'labelCheck'];

function timeAgo(time) {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 60) return `${Math.max(minutes, 1)} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

async function renderSettings() {
  const settings = withDefaultSettings(await store.get(STORAGE_KEYS.settings).then((data) => data[STORAGE_KEYS.settings]));
  for (const name of toggles) document.getElementById(name).checked = settings[name];
  document.body.classList.toggle('disabled', !settings.enabled);
}

async function renderBlocklistStatus() {
  const meta = (await store.get(STORAGE_KEYS.blocklistMeta))[STORAGE_KEYS.blocklistMeta];
  const status = document.getElementById('blocklistStatus');
  if (meta?.fetchedAt) status.textContent = `${Number(meta.count || 0).toLocaleString()} channels, updated ${timeAgo(meta.fetchedAt)}`;
  else if (meta?.error) status.textContent = `Not downloaded yet (${meta.error})`;
  else status.textContent = 'Downloads once a day from GitHub.';
}

function channelUrl(entry) {
  if (entry.handle) return `https://www.youtube.com/@${encodeURIComponent(entry.handle)}`;
  if (entry.channelId) return `https://www.youtube.com/channel/${entry.channelId}`;
  return null;
}

async function renderOverrides() {
  const overrides = (await store.get(STORAGE_KEYS.overrides))[STORAGE_KEYS.overrides] || {};
  const list = document.getElementById('overrides');
  list.replaceChildren();
  const entries = Object.entries(overrides)
    .filter(([, entry]) => entry && typeof entry === 'object')
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  for (const [key, entry] of entries) {
    const item = document.createElement('li');
    const name = entry.title || (entry.handle ? `@${entry.handle}` : entry.channelId || key);
    const url = channelUrl(entry);
    const label = document.createElement(url ? 'a' : 'span');
    label.className = 'name';
    label.textContent = name;
    if (url) {
      label.href = url;
      label.target = '_blank';
      label.rel = 'noopener';
    }
    const value = document.createElement('span');
    value.className = `value value--${entry.value}`;
    value.textContent = entry.value === 'ai' ? 'AI' : 'Not AI';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.textContent = '×';
    remove.title = `Remove override for ${name}`;
    remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', () => {
      chrome.runtime
        .sendMessage({ type: 'setOverride', key, channelId: entry.channelId, handle: entry.handle, value: null })
        .catch((error) => console.warn('[ai-slop-badge] could not remove override', error));
    });
    item.append(label, value, remove);
    list.append(item);
  }
  document.getElementById('noOverrides').hidden = entries.length > 0;
}

for (const name of toggles) {
  document.getElementById(name).addEventListener('change', async (event) => {
    const current = withDefaultSettings((await store.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings]);
    await store.set({ [STORAGE_KEYS.settings]: { ...current, [name]: event.target.checked } });
  });
}

document.getElementById('clearCache').addEventListener('click', async () => {
  const status = document.getElementById('cacheStatus');
  status.textContent = 'Clearing…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'clearCache' });
    status.textContent = response?.ok ? 'Cache cleared' : 'Could not clear cache';
  } catch {
    status.textContent = 'Could not clear cache';
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE_KEYS.settings]) renderSettings();
  if (changes[STORAGE_KEYS.overrides]) renderOverrides();
  if (changes[STORAGE_KEYS.blocklistMeta]) renderBlocklistStatus();
});

function renderLegend() {
  const list = document.getElementById('legend');
  for (const [grade, meaning] of Object.entries(GRADE_MEANINGS)) {
    const item = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'grade-dot';
    dot.dataset.grade = grade;
    dot.textContent = grade;
    item.append(dot, meaning);
    list.append(item);
  }
}

renderLegend();
renderSettings();
renderOverrides();
renderBlocklistStatus();
