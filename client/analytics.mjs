import posthog from 'posthog-js';
import { createAnalytics } from './analytics-core.mjs';

try {
  window.gameAnalytics = createAnalytics({
    sdk: posthog, config: __ANALYTICS_CONFIG__, win: window, doc: document,
  });
} catch {
  // Missing browser APIs or a blocked SDK must leave the game usable.
}
