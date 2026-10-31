# Privacy policy: AI Slop Badge for YouTube

**Short version:** AI Slop Badge for YouTube sends no data to the developer or anyone else. It reads YouTube pages and keeps a small, short-lived cache in your browser (see below).

## What the extension processes

- **The YouTube pages you view.** It reads which videos and channels appear on the page, and the "How this was made" section of the videos you watch, so it can grade channels. This happens only inside your browser.
- **Local storage.** Everything below is stored in `chrome.storage.local` on your device and never leaves it:

| Data | Why | Kept for |
| --- | --- | --- |
| Your settings and per-channel "AI / Not AI" overrides | So your choices stick | Until you change or remove them |
| IDs of videos whose "Made with AI" label was checked (videos you opened, and up to 2 recent videos of suspected channels), with timestamps | To grade the channel | 7 days, then deleted (at the latest during the next daily cleanup) |
| Channel data for channels shown on your pages: channel ID, handle, title, analysis of recent uploads | To avoid re-checking every page view | About 7 days after the channel last appeared (removed by the daily cleanup) |
| Handle → channel ID mappings (with the channel's video count) and Shorts video → channel lookups | To identify channels without new requests | Up to 30 days after last use |
| The AiSList blocklist, and the times of recent background requests | Grading and rate limiting | Blocklist replaced daily; request times from the last hour |

"Clear cache" in the popup deletes the cached video and channel data immediately. Removing the extension deletes everything.

## Network requests

The extension only requests public data, without cookies or any identifier of you:

- `https://www.youtube.com/`: public channel RSS feeds, oEmbed lookups, channel pages (`/@handle`) and video watch pages. It uses them to find a video's channel, to analyse the channel's recent uploads, and (when "Check suspected channels" is on) to read YouTube's "Made with AI" label on up to 2 of a suspected channel's newest videos.
- `https://raw.githubusercontent.com/Override92/AiSList/`: the public AiSList community blocklist, at most once a day, only while the blocklist option is on.

Like any web request, these requests reach YouTube/Google and GitHub, which see your IP address. No other servers are contacted.

## What is not collected

The developer receives no data. The extension has no analytics, tracking, advertising or remote logging. It has no accounts and does not read your YouTube account, history or subscriptions.

## Chrome Web Store user data disclosure

- **Website content and web history.** The extension handles website content (video and channel identifiers and YouTube's AI label on YouTube pages). It also keeps a short-lived local record of checked video IDs and of channels shown on your pages, as listed in the table above. This data is processed and stored only on your device, and is never sent to the developer or any third party.
- **Not handled:** personally identifiable information, health, financial, authentication, personal-communication, location or user-activity data.
- **Use:** data is never sold, never transferred to third parties, never used for purposes unrelated to the extension's single purpose (grading YouTube channels for AI-generated content), and never used to determine creditworthiness or for lending purposes.

## Contact

Questions about this policy can be raised through the extension's store listing.
