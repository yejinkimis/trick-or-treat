// Only enumerated product data crosses the analytics boundary. Never pass API bodies here.
export const EVENT_FIELDS = {
  auth_viewed: ['auth_mode'], auth_started: ['auth_mode'],
  auth_completed: ['auth_mode'], auth_failed: ['auth_mode', 'failure_reason', 'status'],
  game_entered: ['returning_player'], logout_completed: [],
  intro_started: [], intro_skipped: [], tutorial_started: [], tutorial_completed: [],
  costume_selected: ['costume', 'first_selection'], roof_changed: ['roof'],
  movement_started: [], pumpkin_collected: ['pumpkins'], basket_completed: [],
  knock_started: [], candy_game_started: ['level', 'game'],
  knock_completed: ['outcome', 'level', 'game', 'candy_moved', 'duration_seconds'],
  knock_choice: ['choice'], brew_completed: ['candy_gain'],
  decor_purchased: ['item', 'price'], mural_saved: ['painted_cells'],
  chat_opened: [], chat_sent: ['message_length'], note_sent: ['message_length'],
  bonk_sent: ['target_is_bot'], house_visited: [], village_changed: ['destination_village'],
  modal_opened: ['modal'], modal_closed: ['modal', 'duration_seconds'],
  panel_toggled: ['panel', 'collapsed'], round_started: [], round_scheduled: ['starts_in_seconds', 'duration_seconds'],
  round_cancelled: [], round_stopped: [],
  action_failed: ['action', 'status'],
};
const CONTEXT_FIELDS = ['game_mode', 'round_id', 'round_state', 'village', 'is_admin'];
const pick = (value, fields) => Object.fromEntries(fields
  .filter((key) => ['string', 'number', 'boolean'].includes(typeof value?.[key])
    && (typeof value[key] !== 'number' || Number.isFinite(value[key])))
  .map((key) => [key, typeof value[key] === 'string' ? value[key].slice(0, 100) : value[key]]));

export function sanitizeEvent(event) {
  if (!event?.properties) return event;
  // SDK page and first-touch properties can contain URL query strings.
  for (const props of [event.properties, event.properties.$set, event.properties.$set_once]) {
    if (!props) continue;
    for (const key of Object.keys(props)) {
      if (/url|referrer/i.test(key) && typeof props[key] === 'string') {
        props[key] = props[key].split(/[?#]/)[0];
      }
    }
  }
  return event;
}

export function createAnalytics({ sdk, config, win, doc, now = () => performance.now() }) {
  // Analytics outages must never prevent login, movement, or saving game state.
  const safe = (fn) => { try { return fn(); } catch { return undefined; } };
  const commonProperties = { app: 'trick-or-treat', analytics_schema: 1, environment: config.environment };
  const register = () => safe(() => sdk.register(commonProperties));
  safe(() => sdk.init(config.key, {
    api_host: config.host, defaults: '2026-08-30',
    capture_pageview: 'history_change', capture_pageleave: true,
    autocapture: { dom_event_allowlist: ['click', 'submit'], css_selector_allowlist: ['button', 'form'] },
    mask_all_text: true, mask_all_element_attributes: true,
    person_profiles: 'identified_only',
    disable_session_recording: false,
    session_recording: {
      maskAllInputs: true, maskTextSelector: '*', maskAllElementAttributes: true,
      blockSelector: '#admin, #auth',
      recordHeaders: false, recordBody: false, recordCrossOriginIframes: false,
      // The game canvas contains player names and chat bubbles. DOM masking cannot mask pixels.
      captureCanvas: { recordCanvas: false },
    },
    enable_recording_console_log: false, capture_performance: false, capture_exceptions: false,
    before_send: (event) => {
      if (event?.properties) Object.assign(event.properties, commonProperties);
      return sanitizeEvent(event);
    },
    loaded: register,
  }));
  let context = () => ({});
  const send = (event, properties, options) => safe(() => sdk.capture(event, {
    ...pick(context(), CONTEXT_FIELDS), ...properties,
  }, options));
  let visible = doc.visibilityState !== 'hidden';
  let previous = now(), lastInput = -Infinity, visibleMs = 0, activeMs = 0, sequence = 0;
  let engagementId = win.crypto.randomUUID();
  const accountTime = () => {
    const time = now();
    if (visible) {
      visibleMs += Math.max(0, time - previous);
      activeMs += Math.max(0, Math.min(time, lastInput + 60000) - previous);
    }
    previous = time;
  };
  const flush = (reason, beacon = false) => {
    accountTime();
    if (visibleMs < 1) return;
    send('engagement_sample', {
      engagement_id: engagementId, sample_sequence: ++sequence, reason,
      visible_seconds: visibleMs / 1000, active_seconds: activeMs / 1000,
    }, beacon ? { transport: 'sendBeacon', send_instantly: true } : undefined);
    visibleMs = 0; activeMs = 0;
  };
  const activity = () => { accountTime(); if (visible) lastInput = now(); };
  for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
    doc.addEventListener(event, activity, { passive: true, capture: true });
  }
  win.setInterval(() => flush('interval'), 30000);
  doc.addEventListener('visibilitychange', () => {
    flush('visibility', true);
    visible = doc.visibilityState !== 'hidden';
    lastInput = -Infinity;
  });
  win.addEventListener('pagehide', () => { flush('pagehide', true); visible = false; lastInput = -Infinity; });
  win.addEventListener('pageshow', () => { previous = now(); visible = doc.visibilityState !== 'hidden'; });
  let identified = null;
  return {
    setContext(getContext) { context = getContext; },
    capture(event, properties = {}) {
      if (Object.hasOwn(EVENT_FIELDS, event)) send(event, pick(properties, EVENT_FIELDS[event]));
    },
    activity,
    identify(uid) {
      if (!uid || uid === identified) return;
      flush('identify');
      if (identified) { safe(() => sdk.reset(true)); register(); }
      safe(() => sdk.identify(uid));
      identified = uid;
      engagementId = win.crypto.randomUUID(); sequence = 0; lastInput = -Infinity;
    },
    reset() {
      flush('logout', true);
      safe(() => sdk.reset(true));
      register();
      identified = null; engagementId = win.crypto.randomUUID(); sequence = 0; lastInput = -Infinity;
    },
  };
}
