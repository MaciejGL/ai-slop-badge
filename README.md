# AI Slop Badge for YouTube

A Chrome extension (Manifest V3, plain JavaScript, no build step) that puts a small round badge in the top-left corner of YouTube video thumbnails: home feed, search results, watch-page recommendations, Shorts shelves and channel grids. The badge grades the video's **channel** from **A** to **E**:

| Grade | Meaning |
| --- | --- |
| A | No AI signs found |
| B | Slight hints |
| C | Suspicious |
| D | Likely AI |
| E | AI-generated |

- Hover a badge to see the grade's meaning and the reasons, for example `On the AiSList community list`, `YouTube "Made with AI" label on 1 of 2 checked videos` or `~6 uploads per day`.
- Click a badge to open a small popover with the reasons and two buttons: **Not AI** and **Mark as AI** (plus **Clear override**). Your override takes priority over the computed grade. When the AiSList is one of the reasons, the popover links to AiSList's "Removal request" issue form on GitHub so you can report a mistake. Clicking a badge never opens the video.
- A grey "…" badge means the check is still running. A tile gets no badge when its channel can't be identified.

Grades are heuristics, not proof. **A** means no AI signs were found; it does not prove a human made the content.

## Install

**From the Chrome Web Store:** link coming soon (TBD).

**From source (load unpacked):**

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder (the one that contains `manifest.json`).
4. Open or reload https://www.youtube.com/.

The toolbar popup has the main on/off switch, the data-source toggles, a grade legend, your overrides and **Clear cache**.

## How grades work

The extension collects signals for each channel:

| Signal | Source |
| --- | --- |
| YouTube's **"Made with AI"** label | The "How this was made" section of a watch page or Short. Detected only by its link to the AI help article (`support.google.com/youtube/answer/15447836`). The header text is localized, and the same section is also used for "Auto-dubbed". |
| **AiSList** community blocklist | https://github.com/Override92/AiSList, downloaded at most once a day. Community lists make mistakes, so a listing alone only reaches C. |
| **Self-disclosure** | Phrases such as "AI-generated", "made with AI", "AI voice", `#aiart` or `#sora` in recent titles and descriptions. Must appear in at least 2 videos and at least 25% of the feed. |
| **Upload heuristics** from the channel RSS feed (last 15 uploads) | ≥2 uploads per day (strong); ≥3 uploads within 2 hours (strong); channel under 6 months old with 15+ uploads (strong); templated titles (strong; a recurring "\| Series" suffix is ignored); most uploads at the exact same minute of day (weak) |
| **Lifetime output** | ≥1 video per day on average since the channel started, with ≥100 videos (strong). This signal only applies when the extension had already loaded the channel's page to look up a handle; it never fetches the page just for this. The count is kept with the handle mapping for 30 days. |

The first matching rule decides the grade. Your override comes before all of them:

- **E**: AI label on ≥2 videos, or an AI label plus a blocklist hit or self-disclosure
- **D**: AI label on 1 video, or self-disclosure, or a blocklist hit plus ≥2 strong heuristics
- **C**: a blocklist hit (alone or with weaker evidence), or ≥3 strong heuristics
- **B**: any other heuristic
- **A**: the feed was checked and nothing was found

Thresholds are named constants at the top of `lib/grade.js`.

**Where label results come from.** Every watch page or Short you open is checked for the label as you browse, at no extra cost. For channels graded C or D, the extension also checks up to the 2 most recent videos not checked yet (see below).

**Requests the extension makes in the background.** All of these are anonymous (no cookies) and rate-limited:

- **Channel RSS feeds** for channels shown on the page, at most 300 per hour and once per channel per day. YouTube's feeds only accept channel IDs.
- **Channel pages (`https://www.youtube.com/@handle?hl=en`)** when a tile shows only a handle, to look up the channel ID. The same page also gives the channel's total video count (read from the English header). At most one every 2 seconds and 120 per hour. Results are cached for 30 days.
- **oEmbed lookups** for Shorts tiles that show neither a channel ID nor a handle.
- **Watch pages of suspected channels.** When **Check suspected channels for YouTube's AI label** is on (the default), the extension downloads up to the 2 newest video pages of each channel graded C or D. It makes at most one request every 10 seconds and 30 per hour, and stops for an hour after a 429 or any other error. Turn the toggle off to stop these downloads.
- **The AiSList blocklist** from GitHub, at most once a day (only while that toggle is on).

## Files

| Path | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker: cache, request queue, rate limits, grading, blocklist refresh |
| `lib/grade.js` | Pure feed analysis, grade rules and grade meanings |
| `lib/rss.js` | Atom feed parser (no DOMParser in service workers) |
| `lib/label.js` | AI-label detection in watch pages; channel ID and video count from channel pages |
| `lib/blocklist.js` | AiSList parsing and handle normalization |
| `lib/policy.js` | Pure cache-freshness, fetch-planning and rate-limit decisions |
| `lib/settings.js` | Storage keys and default settings |
| `content/main-world.js` | Page-world script that reads YouTube's JSON (`ytInitialData`, `youtubei/v1/*` responses) to map videos to channels |
| `content/content.js`, `content/badge.css` | Finds tiles, renders badges and the popover |
| `popup/*` | Toolbar popup |
| `test/*.test.js` | `node --test` unit tests for the pure modules |
| `scripts/package.sh` | Builds the Chrome Web Store zip in `dist/` |
| `store/` | Store listing text and promo tile |

## Development

```sh
node --test              # unit tests (Node 22+)
node --check background.js
scripts/package.sh       # dist/ai-slop-badge-<version>.zip with runtime files only
```

Service worker logs: `chrome://extensions` → AI Slop Badge for YouTube → **Inspect views: service worker**. Content script logs appear in the YouTube tab's DevTools console. Use the context selector to choose the extension's isolated world. All logs start with `[ai-slop-badge]`.

## Permissions

- `storage`: settings, overrides and the per-channel cache (`chrome.storage.local`).
- `alarms`: refreshes the blocklist daily and prunes stale cache entries.
- Host `https://www.youtube.com/*`: content scripts, plus anonymous requests (no cookies) to public RSS feeds, oEmbed, channel pages and watch pages.

The AiSList blocklist is downloaded from `raw.githubusercontent.com`, which allows cross-origin reads (`Access-Control-Allow-Origin: *`), so it needs no host permission. No `tabs` permission is needed either: grade updates go back to the tab that asked for them.

## Publishing to the Chrome Web Store

- Run `scripts/package.sh` and upload `dist/ai-slop-badge-<version>.zip`. It contains only the runtime files.
- Listing text, permission justifications and data-usage answers are in `store/listing.md`. The 440×280 promo tile is `store/promo-small-440x280.png`. Screenshots aren't included.
- The privacy policy is `PRIVACY.md`. Publish it at a public URL (for example on GitHub) and enter that URL in the dashboard.
- The extension contains no remote code. It only downloads data (XML, JSON and HTML) and parses it as text.

## License

The extension's code is under the MIT License (see `LICENSE`).

The AiSList blocklist is **not** bundled. It's downloaded at runtime from its own repository and keeps its own licence (CC BY-NC 4.0 at the time of writing). See https://github.com/Override92/AiSList.
