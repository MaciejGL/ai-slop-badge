import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  observationHasAiLabel,
  detectAiLabelInHtml,
  extractChannelIdFromPage,
  extractVideoCountFromPage,
  viewModelHasAiLabel,
} from '../lib/label.js';

function howThisWasMade({ header, body, answer }) {
  return {
    sectionTitle: { content: 'How this was made' },
    bodyHeader: { content: header },
    bodyText: {
      content: `${body} Learn more`,
      commandRuns: [
        {
          startIndex: body.length + 1,
          length: 10,
          onTap: {
            innertubeCommand: {
              commandMetadata: { webCommandMetadata: { url: `//support.google.com/youtube/answer/${answer}?hl=en` } },
              urlEndpoint: { url: `//support.google.com/youtube/answer/${answer}?hl=en`, target: 'TARGET_NEW_WINDOW' },
            },
          },
        },
      ],
    },
    attributionText: {},
  };
}

// Mirrors the shape of ytInitialData / youtubei/v1/next on a watch page.
function watchData(items) {
  return {
    currentVideoEndpoint: { watchEndpoint: { videoId: 'KCi6qQ5N5oc' } },
    engagementPanels: [
      {
        engagementPanelSectionListRenderer: {
          content: { structuredDescriptionContentRenderer: { items } },
        },
      },
    ],
  };
}

const AI_LABEL = howThisWasMade({
  header: 'Laget med KI', // localized header must not matter
  body: 'Sounds or visuals were altered or fully generated.',
  answer: '15447836',
});
const AUTO_DUBBED = howThisWasMade({ header: 'Auto-dubbed', body: 'Audio was dubbed automatically.', answer: '15569972' });

// Watch observations from the page carry the raw view models; the service worker decides.
test('observation with the AI help link is labeled, whatever the localized header', () => {
  assert.equal(observationHasAiLabel([AUTO_DUBBED, AI_LABEL]), true);
});

test('"Auto-dubbed" section alone is not an AI label', () => {
  assert.equal(observationHasAiLabel([AUTO_DUBBED]), false);
});

test('no section means no AI label', () => {
  assert.equal(observationHasAiLabel([]), false);
  assert.equal(observationHasAiLabel(undefined), false);
});

test('help link must be the exact answer id', () => {
  const lookalike = howThisWasMade({ header: 'x', body: 'y', answer: '154478360' });
  assert.equal(viewModelHasAiLabel(lookalike), false);
});

function watchHtml(data) {
  // Renderer-name lists also mention the key without an object; they must be ignored.
  return `<html><script>var ytcfg={"names":["howThisWasMadeSectionViewModel","videoDescriptionTranscriptSectionRenderer"]};</script>
<script>var ytInitialData = ${JSON.stringify(data)};</script></html>`;
}

test('HTML: AI label detected in embedded ytInitialData', () => {
  const html = watchHtml(watchData([{ howThisWasMadeSectionViewModel: AUTO_DUBBED }, { howThisWasMadeSectionViewModel: AI_LABEL }]));
  assert.deepEqual(detectAiLabelInHtml(html), { checked: true, aiLabel: true });
});

test('HTML: Auto-dubbed only is checked but not labeled', () => {
  assert.deepEqual(detectAiLabelInHtml(watchHtml(watchData([{ howThisWasMadeSectionViewModel: AUTO_DUBBED }]))), {
    checked: true,
    aiLabel: false,
  });
});

test('HTML: description without a section is checked but not labeled', () => {
  assert.deepEqual(detectAiLabelInHtml(watchHtml(watchData([]))), { checked: true, aiLabel: false });
});

test('HTML: a page without watch data (consent page) is not checked', () => {
  assert.deepEqual(detectAiLabelInHtml('<html><body>Before you continue to YouTube</body></html>'), {
    checked: false,
    aiLabel: false,
  });
});

test('channel ID is read from a channel page', () => {
  const html = '<link rel="canonical" href="https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ">';
  assert.equal(extractChannelIdFromPage(html), 'UCBJycsmduvYEL83R_U4JriQ');
  assert.equal(extractChannelIdFromPage('{"externalId":"UCtH_UJdhBtJN9frodLYob0Q"}'), 'UCtH_UJdhBtJN9frodLYob0Q');
  assert.equal(extractChannelIdFromPage('<html></html>'), null);
});

test('channel video count comes from the English page header only', () => {
  const header = (content) =>
    `<script>var ytInitialData = {"header":{"pageHeaderRenderer":{"content":{"pageHeaderViewModel":{"metadata":{"contentMetadataViewModel":{"metadataRows":[{"metadataParts":[{"text":{"content":"@luetin09"}}]},{"metadataParts":[{"text":{"content":"983K subscribers"}},{"text":{"content":"${content}"}}]}]}}}}}}};</script>`;
  assert.equal(extractVideoCountFromPage(header('1.9K videos')), 1900);
  assert.equal(extractVideoCountFromPage(header('1,234 videos')), 1234);
  assert.equal(extractVideoCountFromPage(header('1 video')), 1);
  // Localized headers (e.g. Norwegian) are ignored rather than misread.
  assert.equal(extractVideoCountFromPage(header('1,8k videoer')), null);
  assert.equal(extractVideoCountFromPage('<html></html>'), null);
});
