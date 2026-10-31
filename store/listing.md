# Chrome Web Store listing: AI Slop Badge for YouTube

Copy each section into the matching field of the Chrome Web Store developer dashboard.

## Name

AI Slop Badge for YouTube

## Short description (summary, max 132 characters)

Shows an A–E badge on YouTube thumbnails rating how likely the channel posts AI-generated videos (AI slop).

## Detailed description

Tired of AI slop in your feed? AI Slop Badge for YouTube adds a small round badge to the corner of every video thumbnail. It shows how likely that video's channel is to publish AI-generated content.

Grades:
• A – No AI signs found
• B – Slight hints
• C – Suspicious
• D – Likely AI
• E – AI-generated

Hover a badge to see why in plain words, for example "YouTube 'Made with AI' label on 1 of 2 checked videos", "On the AiSList community list" or "~6 uploads per day". Click it to see the details and mark the channel as "Not AI" or "AI" yourself. Your choice always wins.

How it decides:
• YouTube's own "Made with AI" label on the channel's videos
• The channel describing its own videos as AI-generated
• Upload patterns typical of mass-produced channels: many uploads per day, bursts of uploads, brand-new channels with lots of videos, and templated titles
• The community-maintained AiSList blocklist (optional; it can be wrong, so a listing alone only gives a C)

Works on the home feed, search results, watch-page recommendations, channel pages and Shorts shelves, in light and dark themes.

Privacy: everything runs locally in your browser. No account, no tracking, no analytics, and no data is sent to the developer. A small local cache (channels you saw and videos it checked) is kept for 7–30 days and can be cleared at any time. The extension only reads public YouTube pages and feeds, plus the public AiSList blocklist from GitHub.

Grades are heuristics, not proof. "A" means no AI signs were found, not that a human made the video.

Blocklist data by AiSList (https://github.com/Override92/AiSList), a community project with its own licence. It is not bundled with the extension.

## Category

Productivity is a reasonable fit. Social & Communication is an alternative.

## Single purpose

Show a badge on YouTube video thumbnails that estimates how likely the video's channel publishes AI-generated content, with the reasons and a way for the user to override it.

## Permission justifications

**storage**
Stores the user's settings, their per-channel "AI / Not AI" overrides, the downloaded community blocklist and a local cache of channel grades, so channels aren't re-checked on every page view. All data stays on the device.

**alarms**
Runs a periodic maintenance task: refreshes the community blocklist at most once a day and deletes stale cache entries so local storage stays small.

**Host permission: https://www.youtube.com/***
Needed for the content scripts that read video tiles and draw the badges on YouTube pages. It's also needed for anonymous, rate-limited requests to public YouTube data that the grade relies on: channel RSS feeds (upload history), oEmbed (which channel a Short belongs to), channel pages (channel ID and video count) and video pages (YouTube's "Made with AI" label). No other site is accessed with elevated permissions.

## Remote code

**No, I am not using remote code.**

All JavaScript ships inside the package. The extension downloads only data: RSS/XML feeds, JSON and HTML from www.youtube.com, and a plain-text blocklist from raw.githubusercontent.com. It parses all of it as text and never executes it (no `eval`, no remote scripts, no `new Function`).

## Privacy practices: data usage

The Chrome Web Store counts data an extension captures from web pages as handled user data, and it must be disclosed even when it never leaves the device (User Data FAQ: https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).

**What user data do you plan to collect?** Tick these two:

- [x] **Website content.** The extension reads YouTube page content (video and channel IDs, channel handles, and the "How this was made" section) to compute and show the badges.
- [x] **Web history.** For each channel it stores, locally, the IDs of videos whose "Made with AI" label it checked, with timestamps. These include videos the user opens and up to 2 recent videos of suspected channels. They are kept for 7 days and then deleted (at the latest during the next daily cleanup). It also caches which channels and Shorts appeared on the user's pages: channel data for about 7 days after the channel last appeared, and Shorts video→channel lookups and handle→channel mappings for up to 30 days after last use. See PRIVACY.md for the full table.

Leave these unticked: personally identifiable information, health information, financial and payment information, authentication information, personal communications, location, user activity.

Explanation for reviewers: all of this data stays in `chrome.storage.local` on the user's device and is used only to grade channels. It is never sent to the developer or any third party. The only network requests are anonymous fetches of public YouTube pages and feeds and of the public AiSList blocklist on GitHub; they carry no cookies and no stored data. The popup's "Clear cache" deletes the cached data immediately, and removing the extension deletes everything.

**Certifications.** Tick all three:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Privacy policy URL

`https://github.com/MaciejGL/ai-slop-badge/blob/main/PRIVACY.md`

## Assets

- Small promo tile (440×280): `store/promo-small-440x280.png` (source: `store/promo-small-440x280.svg`)
- Icon: `icons/icon128.png`
- Screenshots (1280×800 or 640×400): not included. Take them on youtube.com with the extension loaded.
