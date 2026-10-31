const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyticsConfig, prepareSite } = require('../scripts/analytics-build.cjs');
const core = import('../client/analytics-core.mjs');

async function analytics() {
  const { createAnalytics } = await core;
  let time = 0, identity = 'anonymous', serial = 0;
  const events = [], calls = [], listeners = {}, documentListeners = {};
  const sdk = {
    init(key, config) { this.config = config; config.loaded(this); }, register() {},
    capture(event, properties, options) { events.push({ event, properties, options, identity }); },
    identify(uid) { identity = uid; calls.push(['identify', uid]); },
    reset(all) { identity = 'anonymous'; calls.push(['reset', all]); },
  };
  const doc = { visibilityState: 'visible', addEventListener(type, callback) { documentListeners[type] = callback; } };
  const win = {
    crypto: { randomUUID: () => `view-${++serial}` },
    addEventListener(type, callback) { listeners[type] = callback; },
    setInterval(callback) { this.interval = callback; },
  };
  const api = createAnalytics({ sdk, config: { key: 'phc_test', host: 'https://us.i.posthog.com', environment: 'test' }, win, doc, now: () => time });
  return { api, sdk, events, calls, win, doc, listeners, documentListeners,
    at(value) { time = value; },
    visibility(value) { doc.visibilityState = value; documentListeners.visibilitychange(); },
  };
}

test('engagement distinguishes visible time, active input, idle time, and hidden tabs without duplicate exits', async () => {
  const g = await analytics();
  g.at(10000); g.documentListeners.keydown();
  g.at(90000); g.win.interval();
  assert.equal(g.events[0].properties.visible_seconds, 90);
  assert.equal(g.events[0].properties.active_seconds, 60);
  g.at(100000); g.visibility('hidden');
  assert.equal(g.events[1].properties.visible_seconds, 10);
  assert.equal(g.events[1].properties.active_seconds, 0);
  assert.equal(g.events[1].options.transport, 'sendBeacon');
  g.at(200000); g.win.interval();
  assert.equal(g.events.length, 2);
  g.visibility('visible');
  g.at(205000); g.documentListeners.pointerdown();
  g.at(210000); g.listeners.pagehide(); g.listeners.pagehide();
  assert.equal(g.events.length, 3);
  assert.equal(g.events[2].properties.visible_seconds, 10);
  assert.equal(g.events[2].properties.active_seconds, 5);
  g.at(500000); g.listeners.pageshow();
  g.at(501000); g.win.interval();
  assert.equal(g.events[3].properties.visible_seconds, 1);
  assert.equal(g.events[3].properties.active_seconds, 0);
});

test('identity transitions flush under the old identity and start a fresh engagement segment', async () => {
  const g = await analytics();
  g.at(5000); g.api.identify('uid-one');
  assert.equal(g.events[0].identity, 'anonymous');
  g.api.identify('uid-one');
  assert.equal(g.calls.length, 1);
  g.at(10000); g.api.capture('chat_sent', { message_length: 4 }); g.api.reset();
  assert.equal(g.events.at(-1).identity, 'uid-one');
  assert.equal(g.events.at(-1).properties.visible_seconds, 5);
  g.at(15000); g.api.identify('uid-two');
  assert.equal(g.events.at(-1).identity, 'anonymous');
  assert.equal(g.events.at(-1).properties.visible_seconds, 5);
  assert.notEqual(g.events[0].properties.engagement_id, g.events.at(-1).properties.engagement_id);
  assert.deepEqual(g.calls, [['identify', 'uid-one'], ['reset', true], ['identify', 'uid-two']]);
});

test('event boundary drops raw chat, credentials, UIDs and unknown events; SDK failures do not escape', async () => {
  const g = await analytics();
  g.api.setContext(() => ({ game_mode: 'firebase', nickname: 'private', village: 2 }));
  g.api.capture('chat_sent', { message_length: 8, text: 'private', password: 'secret', host: 'uid' });
  assert.deepEqual(g.events[0].properties, { game_mode: 'firebase', village: 2, message_length: 8 });
  g.api.capture('raw_payload', { text: 'private' });
  assert.equal(g.events.length, 1);
  g.sdk.capture = () => { throw new Error('offline'); };
  assert.doesNotThrow(() => g.api.capture('knock_started'));
  assert.equal(g.sdk.config.mask_all_text, true);
  assert.equal(g.sdk.config.mask_all_element_attributes, true);
  assert.equal(g.sdk.config.session_recording.maskAllInputs, true);
  assert.equal(g.sdk.config.session_recording.captureCanvas.recordCanvas, false);
  assert.equal(g.sdk.config.session_recording.recordBody, false);
  const automatic = g.sdk.config.before_send({ properties: {} });
  assert.equal(automatic.properties.environment, 'test');
  assert.equal(automatic.properties.app, 'trick-or-treat');
});

test('URLs and first-touch person properties omit queries and fragments', async () => {
  const { sanitizeEvent } = await core;
  const event = { properties: { $current_url: 'https://game.test/?password=secret#token',
    $referrer: 'https://ref.test/?private=yes', $set_once: { $initial_current_url: 'https://game.test/?nickname=private' } } };
  const result = sanitizeEvent(event);
  assert.equal(result.properties.$current_url, 'https://game.test/');
  assert.equal(result.properties.$referrer, 'https://ref.test/');
  assert.equal(result.properties.$set_once.$initial_current_url, 'https://game.test/');
});

test('collection requires a public key and production or explicit opt-in; builds expose only public analytics config', () => {
  assert.equal(analyticsConfig({ POSTHOG_PROJECT_KEY: 'phc_test' }), null);
  assert.equal(analyticsConfig({ VERCEL_ENV: 'preview', POSTHOG_PROJECT_KEY: 'phc_test' }), null);
  assert.equal(analyticsConfig({ VERCEL_ENV: 'production' }), null);
  assert.equal(analyticsConfig({ VERCEL_ENV: 'production', POSTHOG_ENABLED: 'false', POSTHOG_PROJECT_KEY: 'phc_test' }), null);
  assert.throws(() => analyticsConfig({ POSTHOG_ENABLED: 'true', POSTHOG_PROJECT_KEY: 'phx_personal' }));
  assert.throws(() => analyticsConfig({ POSTHOG_ENABLED: 'true', POSTHOG_PROJECT_KEY: 'phc_test' }));
  assert.throws(() => analyticsConfig({ POSTHOG_ENABLED: 'true', POSTHOG_PROJECT_KEY: 'phc_test', POSTHOG_HOST: 'http://other.test' }));
  const site = prepareSite({ VERCEL_ENV: 'production', POSTHOG_PROJECT_KEY: 'phc_test', POSTHOG_HOST: 'https://eu.i.posthog.com', FIREBASE_SERVICE_ACCOUNT_JSON: 'server-secret-must-not-appear' });
  assert.ok(site.html.includes('<script src="/analytics.js"></script>'));
  assert.ok(site.analytics.includes('phc_test'));
  assert.ok(site.analytics.includes('https://eu.i.posthog.com'));
  assert.ok(!site.analytics.includes('server-secret-must-not-appear'));
  new (require('node:vm').Script)(site.analytics);
  assert.equal(prepareSite({}).analytics, null);
});
