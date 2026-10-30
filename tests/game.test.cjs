// 의존성 없는 로직 회귀 검사. DOM/타이머는 대역이므로 실제 렌더링 검사를 대신하지 않는다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../prototype/trick-or-treat.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^boot\(\);$/m, '');
const tick = () => new Promise(setImmediate);

function game({ reducedMotion = true, storage } = {}) {
  const elements = new Map(), timers = new Map(), frames = new Map();
  let serial = 0, now = 0;
  const drawing = new Proxy({}, { get: (target, key) => target[key] ?? (() => ({ width: 40 })), set: (target, key, value) => (target[key] = value, true) });
  const document = {
    activeElement: null, fonts: { load: async () => {} }, listeners: {}, captureListeners: {},
    addEventListener(type, fn, capture = false) { (capture ? this.captureListeners : this.listeners)[type] = fn; },
    removeEventListener(type, fn, capture = false) {
      const handlers = capture ? this.captureListeners : this.listeners;
      if (handlers[type] === fn) delete handlers[type];
    },
  };
  function element(id = '', tag = 'div', attributes = '') {
    const classes = new Set((attributes.match(/class="([^"]*)"/)?.[1] || '').split(/\s+/).filter(Boolean));
    const el = {
      id, tagName: tag.toUpperCase(), hidden: /\shidden(?:\s|$|>)/.test(attributes), disabled: false,
      textContent: '', innerHTML: '', value: '', dataset: {}, style: { setProperty(key, value) { this[key] = value; } },
      classList: { add: (...names) => names.forEach((x) => classes.add(x)), remove: (...names) => names.forEach((x) => classes.delete(x)), contains: (x) => classes.has(x), toggle(x, force) { const on = force ?? !classes.has(x); on ? classes.add(x) : classes.delete(x); return on; } },
      width: 1024, height: 768, clientWidth: 1024, clientHeight: 768, rect: { left: 0, top: 0, width: 1024, height: 768 }, listeners: {},
      setAttribute(name, value) { this[name] = String(value); },
      getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; },
      getContext: () => drawing, toDataURL: () => 'data:image/png;base64,test',
      addEventListener(type, fn) { this.listeners[type] = fn; }, setPointerCapture() {}, focus() { document.activeElement = this; }, blur() { document.activeElement = null; },
      querySelector: () => element('', 'button'), querySelectorAll: () => [],
      firstChild: { textContent: '' },
    };
    Object.defineProperty(el, 'className', { get: () => [...classes].join(' '), set(value) { classes.clear(); value.split(/\s+/).forEach((x) => classes.add(x)); } });
    return el;
  }
  for (const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) elements.set(match[3], element(match[3], match[1], match[2]));
  document.querySelector = (selector) => {
    const id = selector.match(/^#([\w-]+)$/)?.[1];
    if (id) { assert.ok(elements.has(id), `HTML element exists: ${selector}`); return elements.get(id); }
    if (selector.startsWith('#')) return element('', 'button');
    return null;
  };
  document.querySelectorAll = () => [];
  document.createElement = (tag) => element('', tag);
  document.body = element();
  const window = { innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1, addEventListener() {} };
  const sandbox = {
    document, window, console, AbortController, performance: { now: () => now }, matchMedia: () => ({ matches: reducedMotion }), localStorage: storage,
    ResizeObserver: class { observe() {} }, HTMLInputElement: class {}, HTMLTextAreaElement: class {},
    requestAnimationFrame(fn) { const id = ++serial; frames.set(id, fn); return id; }, cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(fn, delay) { const id = ++serial; timers.set(id, { fn, delay, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval(fn, delay) { const id = ++serial; timers.set(id, { fn, delay, at: now + delay, interval: true }); return id; }, clearInterval(id) { timers.delete(id); },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  const run = (code) => vm.runInContext(code, context);
  function runTimer(id, timer) { now = timer.at; if (timer.interval) timer.at += timer.delay; else timers.delete(id); timer.fn(); }
  function fire(delay) { const found = [...timers].find(([, t]) => t.delay === delay); assert.ok(found, `Timer ${delay}ms exists`); runTimer(...found); }
  async function finish(promise) {
    let done = false, failure;
    promise.then(() => { done = true; }, (e) => { done = true; failure = e; });
    for (let i = 0; i < 100 && !done; i++) {
      await tick();
      if (done) break;
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      assert.ok(next, 'Async game flow can advance');
      runTimer(...next);
    }
    assert.ok(done, 'Async game flow finished');
    if (failure) throw failure;
    return promise;
  }
  function players() {
    run(`S.mode = 'practice'; S.me = 'me'; S.players = {
      me: { ...blankPlayer(), nick: '나', costume: 'ghost', pumpkins: 0, guideSeen: true },
      host: { ...blankPlayer(), nick: '친구', costume: 'witch', joinedAt: 1 }
    }; S.ledger = null; render();`);
  }
  return { run, elements, timers, frames, window, fire, finish, players, setNow: (value) => { now = value; } };
}

test('HTML contains every static script target and JavaScript loads', () => {
  const g = game();
  for (const [, id] of source.matchAll(/\$\(['"]#([\w-]+)['"]\)/g)) assert.ok(g.elements.has(id), id);
});

test('Firebase rankings use server balances and reset to ten for a new event', () => {
  const g = game(); g.players();
  g.run(`S.mode = 'firebase'; S.event = { id: 'round1', startedAt: 1, endsAt: Date.now() + 60000 };
    S.players.me.round = 'round1'; S.players.me.candies = 7;
    S.players.host.round = 'round1'; S.players.host.candies = 13;
    S.players.me.knocks = [{ h: 'host', r: 'win', at: Date.now() }];`);
  assert.equal(g.run('candiesOf(S.me)'), 7);
  assert.equal(g.run('rankingOf(S.players)[0].id'), 'host');
  g.run(`S.event.id = 'round2'`);
  assert.equal(g.run('candiesOf(S.me)'), 10);
  assert.equal(g.run('candiesOf("host")'), 10);
});

test('moderation excludes cached and finalized rankings and restoring eligibility reveals frozen scores', () => {
  const g = game(); g.players();
  g.run(`S.mode = 'firebase'; S.event = { id: 'round1', startedAt: 1, endsAt: Date.now() + 60000 };
    S.rankList = [{ id: 'host', n: 13 }, { id: 'me', n: 7 }]; S.excluded = ['host'];`);
  assert.equal(g.run('ranking().length'), 1);
  g.run(`S.event.endsAt = 1; S.event.results = S.rankList;`);
  assert.equal(g.run('ranking()[0].id'), 'me');
  g.run(`S.excluded = []`);
  assert.equal(g.run('ranking()[0].id'), 'host');
});

test('candy challenge renders the server difficulty and moves the catch bar while held', () => {
  const g = game();
  g.run(`candyGame({ level: 3, path: [{t:0,y:.5},{t:18000,y:.5}] })`);
  assert.equal(g.elements.get('timing').hidden, false);
  assert.match(g.elements.get('t-level').textContent, /난이도 3단계/);
  assert.equal(g.elements.get('t-bar').style.height, '25%');
  const before = g.elements.get('t-bar').style.top;
  g.run('S.candyControl(true)');
  g.setNow(20);
  [...g.frames.values()].at(-1)();
  assert.notEqual(g.elements.get('t-bar').style.top, before);
  g.run('S.candyControl(false)');
  assert.notEqual(g.run('S.candyControl'), null);
});

test('queued profile saves cannot change their destination after an account switch', async () => {
  const g = game(); g.players();
  g.run(`S.mode = 'account'; S.account = { auth: { currentUser: { uid: 'me', getIdToken: async () => 'me-token' } } };
    accountRequest = async () => { throw new Error('A stale save must not reach the API'); };
    const pending = saveAccountProfile({ costume: 'witch' });
    S.me = 'other'; S.account.auth.currentUser = { uid: 'other' };`);
  await assert.rejects(g.run('pending'), /Account changed/);
});

test('logout waits until a pending gameplay request has completed', async () => {
  const g = game(); g.players();
  g.run(`S.mode = 'firebase'; crypto = { randomUUID: () => 'test-request' };
    S.account = { auth: { currentUser: { uid: 'me', getIdToken: async () => 'token' } } };
    let finishRequest;
    accountRequest = async () => new Promise((resolve) => { finishRequest = resolve; });
    const pendingGameRequest = gameRequest({ type: 'harvest' });`);
  await tick();
  assert.equal(g.run('S.pendingGame'), 1);
  await g.run('logoutAccount()');
  assert.equal(g.run('S.me'), 'me');
  g.run('finishRequest({ pumpkins: 3 })');
  await g.run('pendingGameRequest');
  assert.equal(g.run('S.pendingGame'), 0);
});

test('logout saves the latest profile before ending the Firebase session', async () => {
  const g = game(); g.players();
  g.run(`S.mode = 'account'; const calls = [];
    S.account = { auth: { currentUser: { uid: 'me', getIdToken: async () => 'me-token' } },
      authSdk: { signOut: async () => { calls.push('signout'); } } };
    accountRequest = async (url, options) => {
      calls.push(JSON.parse(options.body).costume);
      return { profile: { uid: 'me' } };
    };`);
  await g.run('logoutAccount()');
  assert.equal(g.run('JSON.stringify(calls)'), '["ghost","signout"]');
  assert.equal(g.run('S.me'), null);
  assert.equal(g.elements.get('auth').hidden, false);
});

test('failed automatic login leaves a usable login form', async () => {
  const g = game();
  g.window.location = { protocol: 'https:' };
  g.run(`loadAccountClient = async () => {
    S.account = { auth: {}, authSdk: { signOut: async () => {} } };
    return { getIdToken: async () => 'expired-token' };
  }; accountRequest = async () => { throw new Error('Invalid session'); };`);
  await g.run('boot()');
  assert.equal(g.elements.get('auth').hidden, false);
  assert.equal(g.elements.get('auth-submit').disabled, false);
  assert.match(g.elements.get('auth-error').textContent, /다시 로그인/);
});

test('a failed multiplayer connection keeps the login form visible for retry', async () => {
  const g = game(); g.players();
  g.run(`S.account = { firestore: {} }; $('#auth').hidden = false;
    connectFirebaseGame = async () => { throw new Error('Database rules denied'); };`);
  await assert.rejects(g.run(`enterAccount('new-uid', { uid: 'new-uid', nick: '새주민', costume: 'witch', introSeen: true, guideSeen: true })`), /rules denied/);
  assert.equal(g.elements.get('auth').hidden, false);
});

test('entering another account resets movement and stun state', async () => {
  const g = game(); g.players();
  g.run(`S.pos.x = 9999; S.stunUntil = Date.now() + 30000; S.hits = 4;
    keys.add('r'); ghosts.set('old-peer', {});`);
  await g.run(`enterAccount('new-uid', { uid: 'new-uid', nick: '새주민', costume: 'witch', introSeen: true, guideSeen: true })`);
  assert.equal(g.run('S.pos.x'), g.run('SPAWN.x'));
  assert.equal(g.run('S.stunUntil'), 0);
  assert.equal(g.run('S.hits'), 0);
  assert.equal(g.run('keys.size + ghosts.size'), 0);
});

test('outside Claude, boot still opens practice and the name intro', async () => {
  const g = game(); await g.run('boot()');
  assert.equal(g.run('S.mode'), 'practice');
  assert.equal(g.elements.get('intro').hidden, false);
  assert.equal(g.elements.get('quest').hidden, true);
});

test('tutorial explains practice limits and unlocks the persistent quest after three messages', async () => {
  const g = game(); g.players();
  g.run('S.players.me.guideSeen = false');
  const welcome = g.run('welcomeTips()');
  await tick();
  assert.match(g.elements.get('dlg-text').textContent, /연습 결과는 저장되거나/);
  assert.equal(g.run('S.busy'), true);
  assert.equal(g.elements.get('quest').hidden, true);
  for (let i = 0; i < 3; i++) { g.run('advance()'); await tick(); }
  await g.finish(welcome);
  assert.equal(g.run('S.busy'), false);
  assert.equal(g.run('S.players.me.guideSeen'), true);
  assert.equal(g.elements.get('quest').dataset.step, 'pumpkins');
  assert.match(g.elements.get('toast').textContent, /새 퀘스트/);
});

test('three harvests update progress, unlock knocking, and restore from saved player data', () => {
  const g = game(); g.players();
  assert.equal(g.run('hasBasket(S.me)'), false);
  for (let i = 0; i < 3; i++) g.run('S.pumpkins = [{ x: 32, y: 32 }]; harvest(S.pumpkins[0])');
  assert.equal(g.run('hasBasket(S.me)'), true);
  assert.equal(g.elements.get('quest').dataset.step, 'knock');
  assert.equal(g.elements.get('quest-progress').hidden, true);
  assert.match(g.elements.get('toast').textContent, /바구니 완성/);
  const saved = g.run('JSON.stringify(S.players)');
  const next = game(); next.run(`S.me = 'me'; S.players = ${saved}; renderQuest()`);
  assert.equal(next.elements.get('quest').dataset.step, 'knock');
  next.run(`S.players.me.knocks = [{ r: 'lose' }]; renderQuest()`);
  assert.equal(next.elements.get('quest').dataset.step, 'compete');
  next.run(`S.event = { startedAt: 1, endsAt: 2 }; renderQuest()`);
  assert.equal(next.elements.get('quest').dataset.step, 'ended');
});

test('knock prerequisites and ended event disable the action', () => {
  const g = game(); g.players();
  g.run(`S.near = { owner: 'host' }; renderAction()`);
  assert.equal(g.elements.get('act-btn').disabled, true);
  g.run('S.players.me.pumpkins = 3; renderAction()');
  assert.equal(g.elements.get('act-btn').disabled, false);
  assert.match(g.elements.get('act-sub').textContent, /상대 사탕 1개 획득/);
  g.run('S.event = { startedAt: 1, endsAt: 2 }; renderAction()');
  assert.equal(g.elements.get('act-btn').disabled, true);
  assert.match(g.elements.get('act-sub').textContent, /문이 잠겼어요/);
});

test('candy challenge difficulty has five stages and keeps generating candy movement without a timer', () => {
  const g = game();
  assert.equal(g.run('CANDY_MAX_LEVEL'), 5);
  assert.equal(g.run('typeof CANDY_GAME_MS'), 'undefined');
  assert.equal(g.run('Number.isFinite(createCandyPathLookup(5, 42)(20000))'), true);
});

test('holding the bar until the catch meter fills succeeds', async () => {
  const g = game();
  const result = g.run('candyGame({ level: 1, path: [{t:0,y:.05},{t:18000,y:.05}] })');
  g.run('S.candyControl(true)');
  for (let now = 20; now <= 7000 && g.run('S.candyControl !== null'); now += 20) {
    g.setNow(now);
    [...g.frames.values()].at(-1)?.();
  }
  g.fire(0);
  assert.equal((await result).won, true);
  assert.equal(g.elements.get('timing').hidden, true);
});

test('letting the progress bar empty fails without a candy transfer', async () => {
  const g = game();
  const result = g.run('candyGame({ level: 1, path: [{t:0,y:.05},{t:18000,y:.05}] })');
  for (let now = 20; now <= 4000 && g.run('S.candyControl !== null'); now += 20) {
    g.setNow(now);
    [...g.frames.values()].at(-1)?.();
  }
  g.fire(0);
  assert.equal((await result).won, false);
  assert.equal(g.elements.get('timing').hidden, true);
});

for (const won of [true, false]) {
  test(`full knock ${won ? 'success takes' : 'failure leaves'} candy and announces the result`, async () => {
    const g = game(); g.players();
    g.run(`S.players.me.pumpkins = 3; globalThis.messages = [];
      say = async (who, text) => messages.push(text); choose = async () => 'bye';
      candyGame = async () => ({ won: ${won}, inputs: [], elapsedMs: 4200 });`);
    await g.finish(g.run(`knock(MAP.slots.find((s) => s.owner === 'host'))`));
    assert.equal(g.run('candiesOf("me")'), won ? 11 : 10);
    assert.equal(g.run('candiesOf("host")'), won ? 9 : 10);
    assert.equal(g.run('S.busy'), false);
    assert.equal(g.run('S.players.me.knocks.length'), won ? 1 : 0);
    assert.match(g.run('messages.join(" ")'), won ? /친구에게서 사탕 1개 가져옴/ : /사탕은 그대로야/);
    assert.equal(g.elements.get('quest').dataset.step, 'compete');
  });
}

for (const changeRound of [false, true]) {
  test(`retry grace blocks extra actions and ${changeRound ? 'cancels across rounds' : 'continues after the wait'}`, async () => {
    const g = game(); g.players();
    g.run(`S.players.me.pumpkins = 3; globalThis.attempts = 0;
      say = async () => {}; choose = async () => attempts === 1 ? 'again' : 'bye';
      candyGame = async () => { attempts++; return { won: false, inputs: [], elapsedMs: 4200 }; };`);
    const flow = g.run(`knock(MAP.slots.find((s) => s.owner === 'host'))`);
    for (let i = 0; i < 20; i++) {
      await tick();
      if ([...g.timers.values()].some((timer) => timer.delay === 1000)) break;
      const timer = [...g.timers.values()].sort((a, b) => a.at - b.at)[0];
      assert.ok(timer);
      g.fire(timer.delay);
    }
    assert.equal(g.run('S.busy'), true);
    await g.run(`knock(MAP.slots.find((s) => s.owner === 'host'))`);
    assert.equal(g.run('attempts'), 1);
    if (changeRound) g.run(`S.event = { id: 'another-round' }`);
    g.fire(1000);
    await g.finish(flow);
    assert.equal(g.run('attempts'), changeRound ? 1 : 2);
    assert.equal(g.run('S.busy'), false);
  });
}

test('a miss leaves candy unchanged; decor reduces rank balance', () => {
  const g = game(); g.players();
  g.run(`S.players.me.knocks = Array.from({length: 15}, (_, i) => ({h: 'host', r: 'lose', at: i + 1})); S.ledger = null`);
  assert.equal(g.run('candiesOf("me")'), 10);
  assert.equal(g.run('candiesOf("host")'), 10);
  g.run(`S.players.me.knocks = []; S.ledger = null; buyDecor('lantern')`);
  assert.equal(g.run('candiesOf("me")'), 8);
  assert.equal(g.run('rankingOf(S.players)[0].id'), 'host');
});

test('HUD explains rank and prizes before, during and after event', () => {
  const g = game(); g.players();
  g.run("S.mode = 'live'");
  for (const event of ['null', '{startedAt: Date.now() - 1000, endsAt: Date.now() + 60000}', '{startedAt: 1, endsAt: 2}']) {
    g.run(`S.event = ${event}; S.ledger = null; renderHud()`);
    const hud = g.elements.get('me').innerHTML;
    assert.match(hud, /보유 사탕 10개/); assert.match(hud, /내 순위/); assert.match(hud, /실제 선물 지급/);
  }
  g.run('renderRanking()');
  assert.match(html, /최종 사탕 순위에 따라 실제 선물을 드려요/);
});

test('bubble coordinates follow character, account for DPR and stay within edges', () => {
  const g = game();
  for (const size of [[1280, 900, 1], [390, 844, 3]]) {
    const [width, height, ratio] = size;
    g.window.innerWidth = width; g.window.innerHeight = height;
    g.run(`dpr = ${ratio}; Z = ${ratio}; camX = 0; camY = 0; S.pos.x = ${width / 2}; S.pos.y = ${height / 2}`);
    for (const id of ['action', 'dialog']) {
      const el = g.elements.get(id); el.rect = { left: 0, top: 0, width: Math.min(350, width - 40), height: 140 }; el.hidden = false;
    }
    for (const point of [[width / 2, height / 2], [4, 4], [width - 4, height - 4]]) {
      g.run(`S.pos.x = ${point[0]}; S.pos.y = ${point[1]}; positionActorBubbles()`);
      for (const id of ['action', 'dialog']) {
        const el = g.elements.get(id), left = parseFloat(el.style.left), top = parseFloat(el.style.top);
        assert.ok(left >= 20); assert.ok(left + el.rect.width <= width - 20);
        assert.ok(top >= 38); assert.ok(top + el.rect.height <= height - 96);
      }
    }
  }
  g.elements.get('wardrobe').hidden = false;
  g.run('positionActorBubbles()');
  assert.equal(g.elements.get('action').style.visibility, 'hidden');
  g.run('closeModal("wardrobe"); positionActorBubbles()');
  assert.equal(g.elements.get('action').style.visibility, '');
  assert.equal(g.elements.get('world'), g.run('document.activeElement'));
});

test('an active knock cannot lose keyboard focus to a modal or chat', () => {
  const g = game(); g.players(); g.run('S.busy = true; openModal("wardrobe")');
  assert.equal(g.elements.get('wardrobe').hidden, true);
  assert.match(g.elements.get('toast').textContent, /먼저 마쳐/);
  g.run('openChat()');
  assert.equal(g.elements.get('chatbar').hidden, true);
});

test('bubble placement also avoids a HUD above the character', () => {
  const g = game();
  g.run(`S.pos = {x: 512, y: 430}; Z = 1; dpr = 1`);
  const action = g.elements.get('action');
  action.hidden = false; action.rect = {left: 0, top: 0, width: 350, height: 140};
  g.run(`document.querySelectorAll = () => [{getBoundingClientRect: () => ({left: 300, right: 700, bottom: 300})}]; positionActorBubbles()`);
  assert.ok(parseFloat(action.style.top) >= 324);
  assert.equal(action.classList.contains('below'), true);
});

test('two mocked Claude clients share saved quests, candy transfers and event state', async () => {
  const one = game(), two = game(), collectionListeners = [], docListeners = new Map();
  const data = new Map([
    ['players/me', { nick: '나', costume: 'ghost', knocks: [], pumpkins: 0, guideSeen: true }],
    ['players/host', { nick: '친구', costume: 'witch', knocks: [], pumpkins: 3, guideSeen: true, joinedAt: 1 }],
  ]);
  const snapshot = (key) => ({ exists: data.has(key), data: () => structuredClone(data.get(key)) });
  const playersSnapshot = () => ({ docs: [...data.keys()].filter((k) => k.startsWith('players/')).map((key) => ({ id: key.split('/')[1], ...snapshot(key) })) });
  for (const [g, id] of [[one, 'me'], [two, 'host']]) {
    const db = {
      doc(key) {
        return {
          onSnapshot(fn) { const listeners = docListeners.get(key) || []; listeners.push(fn); docListeners.set(key, listeners); fn(snapshot(key)); },
          async set(value) {
            assert.ok(key === `players/${id}` || (id === 'me' && key.startsWith('game/')), 'Client writes only its player or owner game data');
            data.set(key, structuredClone(value));
            for (const fn of docListeners.get(key) || []) fn(snapshot(key));
            if (key.startsWith('players/')) for (const fn of collectionListeners) fn(playersSnapshot());
          },
        };
      },
      collection(name) { assert.equal(name, 'players'); return { onSnapshot(fn) { collectionListeners.push(fn); fn(playersSnapshot()); } }; },
    };
    const user = { id: async () => id, can: async () => true, isOwner: async () => id === 'me', profiles: async () => ({}) };
    const room = { on() {}, peers: () => [], presence: async () => {}, emit: async () => {} };
    g.window.claude = { use: async (name) => ({db, user, room})[name] };
    await g.run('boot()');
  }
  await tick();
  assert.equal(one.run('S.mode'), 'live'); assert.equal(two.run('S.mode'), 'live');
  one.run('saveEvent({startedAt: Date.now(), endsAt: Date.now() + EVENT_MS}); saveMe({pumpkins: 3})');
  await tick();
  assert.equal(two.run('hasBasket("me")'), true);
  assert.equal(two.run('eventState()'), 'running');
  one.run(`say = async () => {}; choose = async () => 'bye'; candyGame = async () => ({won:true, inputs:[], elapsedMs:4200})`);
  await one.finish(one.run(`knock(MAP.slots.find((s) => s.owner === 'host'))`));
  await tick();
  for (const g of [one, two]) {
    assert.equal(g.run('candiesOf("me")'), 11);
    assert.equal(g.run('candiesOf("host")'), 9);
    assert.equal(g.run('ranking()[0].id'), 'me');
  }
  one.run('saveEvent({...S.event, endsAt: Date.now()})');
  await tick();
  assert.equal(two.run('eventState()'), 'ended');
  assert.equal(two.elements.get('quest').dataset.step, 'ended');
});

test('creation, tutorial, quest notice and movement guide appear in sequence', async () => {
  const g = game(); g.players();
  g.run('S.players.me.guideSeen = false; renderHud()');
  const welcome = g.run('welcomeTips("유령 분장 완료. 마을에 우리 집도 생겼어요.")');
  await tick();
  assert.equal(g.elements.get('dialog').hidden, true);
  assert.equal(g.elements.get('hint').hidden, true);
  assert.match(g.elements.get('toast').textContent, /분장 완료/);
  assert.equal(g.run('S.busy'), true);
  g.fire(4000); await tick();
  assert.equal(g.elements.get('toast').hidden, true);
  assert.equal(g.elements.get('dialog').hidden, false);
  assert.match(g.elements.get('dlg-text').textContent, /연습 결과는 저장되거나/);
  for (let i = 0; i < 3; i++) { g.run('advance()'); await tick(); }
  assert.equal(g.elements.get('dialog').hidden, true);
  assert.equal(g.elements.get('quest').hidden, false);
  assert.match(g.elements.get('toast').textContent, /새 퀘스트/);
  assert.equal(g.elements.get('hint').hidden, true);
  assert.equal(g.run('S.busy'), true);
  g.fire(3000); await welcome;
  assert.equal(g.elements.get('toast').hidden, true);
  assert.equal(g.elements.get('hint').hidden, false);
  assert.equal(g.run('S.busy'), false);
  g.run('keys.add("r"); update(.05); renderMovementHint()');
  assert.equal(g.run('S.hintHidden'), true);
  assert.equal(g.elements.get('hint').hidden, true);
});

test('click without displacement and nearby actions do not dismiss movement guide', () => {
  const g = game(); g.players();
  assert.equal(g.elements.get('hint').hidden, false);
  g.elements.get('world').listeners.pointerdown({ clientX: 832, clientY: 288 });
  g.run('update(.05); renderMovementHint()');
  assert.equal(g.run('S.hintHidden'), false);
  assert.equal(g.elements.get('hint').hidden, false);
  g.run('S.near = {owner: "host"}; renderAction()');
  assert.equal(g.elements.get('hint').hidden, false);
});

test('replacement notifications finish before the tutorial starts', async () => {
  const g = game(); g.players();
  const welcome = g.run('welcomeTips("분장 완료")');
  await tick();
  g.run('toast("다른 알림")'); await tick();
  assert.equal(g.elements.get('dialog').hidden, true);
  g.fire(3000); await tick();
  assert.equal(g.elements.get('dialog').hidden, false);
  for (let i = 0; i < 3; i++) { g.run('advance()'); await tick(); }
  await g.finish(welcome);
});

test('intro skip cancels active typewriter and goes straight to name entry', async () => {
  const g = game({ reducedMotion: false });
  g.run('S.me = "me"; S.names.me = "테스터"');
  const intro = g.run('startIntro()');
  g.fire(40);
  assert.equal(g.elements.get('in-form').hidden, true);
  assert.ok([...g.timers.values()].some((t) => t.interval));
  // 실제 버튼의 위임 핸들러를 통해 건너뛴다.
  g.run(`document.listeners.click({target: {closest: () => ({id: 'in-skip', dataset: {}})}})`);
  await intro;
  assert.equal(g.elements.get('in-form').hidden, false);
  assert.equal(g.elements.get('in-skip').hidden, true);
  assert.match(g.elements.get('in-text').textContent, /뭐라고 불러/);
  assert.equal(g.elements.get('in-name').value, '테스터');
  assert.equal(g.run('typing'), null);
  assert.equal(g.timers.size, 0);
  assert.equal(g.elements.get('dialog').hidden, true);
});

test('intro skip cancels between-line wait and remains safe on repeat clicks', async () => {
  const g = game(); g.run('S.me = "me"');
  const intro = g.run('startIntro()'); await tick();
  assert.ok([...g.timers.values()].some((t) => t.delay === 250));
  g.run('skipIntro(); skipIntro()'); await intro;
  assert.equal(g.timers.size, 0);
  assert.equal(g.elements.get('in-form').hidden, false);
  g.elements.get('in-name').value = '입력중';
  g.run('skipIntro()');
  assert.equal(g.elements.get('in-name').value, '입력중');
});

test('intro still completes normally when skip is not used', async () => {
  const g = game(); g.run('S.me = "me"');
  await g.finish(g.run('startIntro()'));
  assert.equal(g.elements.get('in-form').hidden, false);
  assert.equal(g.elements.get('in-skip').hidden, true);
  assert.equal(g.run('introController'), null);
  assert.equal(g.timers.size, 0);
});

test('new account intro uses its registered nickname and opens the costume chooser', async () => {
  const g = game();
  g.run(`S.mode = 'account'; S.me = 'fixed-uid'; S.names['fixed-uid'] = '호박도둑';
    S.players = {'fixed-uid': {...blankPlayer(), nick: '호박도둑', introSeen: false}};
    saveAccountProfile = () => {}`);
  await g.finish(g.run('startIntro()'));
  assert.equal(g.elements.get('intro').hidden, true);
  assert.equal(g.elements.get('in-form').hidden, true);
  assert.equal(g.elements.get('wardrobe').hidden, false);
  assert.equal(g.elements.get('wr-name-row').hidden, true);
  assert.match(g.elements.get('wr-title').firstChild.textContent, /호박도둑/);
  assert.equal(g.run("S.players['fixed-uid'].nick"), '호박도둑');
});

test('new account can skip the story and keep its registered nickname', async () => {
  const g = game({ reducedMotion: false });
  g.run(`S.mode = 'account'; S.me = 'fixed-uid'; S.names['fixed-uid'] = '호박도둑';
    S.players = {'fixed-uid': {...blankPlayer(), nick: '호박도둑', introSeen: false}};
    saveAccountProfile = () => {}`);
  const intro = g.run('startIntro()');
  await tick();
  g.run('skipIntro()');
  await intro;
  assert.equal(g.elements.get('intro').hidden, true);
  assert.equal(g.elements.get('in-form').hidden, true);
  assert.equal(g.elements.get('wardrobe').hidden, false);
  assert.equal(g.run("S.players['fixed-uid'].nick"), '호박도둑');
});

test('account gate switches between login and unique nickname signup fields', () => {
  const g = game();
  g.run("S.account = {}; showAuthGate();");
  assert.equal(g.elements.get('auth').hidden, false);
  assert.equal(g.elements.get('auth-nickname').id, 'auth-nickname');
  assert.equal(g.elements.get('auth-confirm-wrap').hidden, true);
  g.run("toggleAuthMode('signup')");
  assert.equal(g.elements.get('auth-confirm-wrap').hidden, false);
  assert.equal(g.elements.get('auth-confirm').required, true);
  assert.match(g.elements.get('auth-title').firstChild.textContent, /계정 만들기/);
  g.run("toggleAuthMode('login')");
  assert.equal(g.elements.get('auth-confirm-wrap').hidden, true);
  assert.equal(g.elements.get('auth-password').value, '');
});

for (const composition of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
  test(`IME Enter does not confirm name or prevent composition (${JSON.stringify(composition)})`, () => {
    const g = game();
    g.run('globalThis.confirmations = 0; confirmName = () => confirmations++');
    let prevented = 0;
    g.elements.get('in-name').listeners.keydown({ key: 'Enter', ...composition, preventDefault() { prevented++; } });
    assert.equal(g.run('confirmations'), 0);
    assert.equal(prevented, 0);
  });
}

test('ordinary Enter still confirms a completed Korean name', () => {
  const g = game(); g.players();
  g.elements.get('intro').hidden = false;
  g.elements.get('in-name').value = '호박도둑';
  let prevented = 0;
  g.elements.get('in-name').listeners.keydown({ key: 'Enter', isComposing: false, keyCode: 13, preventDefault() { prevented++; } });
  assert.equal(g.run('S.players.me.nick'), '호박도둑');
  assert.equal(g.elements.get('intro').hidden, true);
  assert.equal(prevented, 1);
});

test('IME keys do not trigger timing or game shortcuts', () => {
  const g = game();
  g.run('globalThis.presses = 0; S.candyControl = () => presses++');
  g.run(`document.listeners.keydown({ target: null, key: ' ', code: 'Space', isComposing: true, preventDefault() { throw Error('Must allow IME'); } })`);
  assert.equal(g.run('presses'), 0);
});

test('click dismisses creation notice early without advancing the first tutorial message', async () => {
  const g = game(); g.players();
  const welcome = g.run('welcomeTips("분장 완료")'); await tick();
  assert.ok([...g.timers.values()].some((t) => t.delay === 4000));
  assert.equal(g.elements.get('dialog').hidden, true);
  let prevented = 0, stopped = 0;
  const dismiss = g.run('document.captureListeners.click');
  dismiss({ preventDefault() { prevented++; }, stopImmediatePropagation() { stopped++; } });
  await tick();
  assert.equal(prevented, 1); assert.equal(stopped, 1);
  assert.equal(g.elements.get('toast').hidden, true);
  assert.equal(g.elements.get('dialog').hidden, false);
  assert.match(g.elements.get('dlg-text').textContent, /연습 결과는 저장되거나/);
  assert.equal(g.run('document.captureListeners.click'), undefined);
  assert.equal([...g.timers.values()].some((t) => t.delay === 4000), false);
  for (let i = 0; i < 3; i++) { g.run('advance()'); await tick(); }
  await g.finish(welcome);
});

test('replacing a dismissible notice removes its click handler', async () => {
  const g = game();
  const oldNotice = g.run('toast("분장 완료", {duration: 4000, dismissOnClick: true})');
  assert.equal(typeof g.run('document.captureListeners.click'), 'function');
  const nextNotice = g.run('toast("일반 알림")');
  await oldNotice;
  assert.equal(g.run('document.captureListeners.click'), undefined);
  assert.equal([...g.timers.values()].some((t) => t.delay === 4000), false);
  g.fire(3000); await nextNotice;
});

for (const code of ['Space', 'ArrowRight']) {
  test(`${code} dismisses creation notice without moving or skipping tutorial`, async () => {
    const g = game(); g.players();
    const welcome = g.run('welcomeTips("분장 완료")'); await tick();
    assert.equal(g.elements.get('toast').textContent, '분장 완료');
    let prevented = 0, stopped = 0;
    g.run('document.captureListeners.keydown')({ code, repeat: false, target: null, isComposing: false, preventDefault() { prevented++; }, stopImmediatePropagation() { stopped++; } });
    await tick();
    assert.equal(prevented, 1); assert.equal(stopped, 1);
    assert.equal(g.run('keys.size'), 0);
    assert.equal(g.run('document.captureListeners.keydown'), undefined);
    assert.equal(g.run('document.captureListeners.click'), undefined);
    assert.match(g.elements.get('dlg-text').textContent, /연습 결과는 저장되거나/);
    // 키를 누르고 있어도 자동 반복으로 다음 설명까지 넘기지 않는다.
    g.run(`document.listeners.keydown({target: null, key: ' ', code: 'Space', repeat: true, preventDefault() {}})`);
    await tick();
    assert.match(g.elements.get('dlg-text').textContent, /연습 결과는 저장되거나/);
    for (let i = 0; i < 3; i++) { g.run('advance()'); await tick(); }
    await g.finish(welcome);
  });
}

test('held keys and composing keys leave the creation notice visible', async () => {
  const g = game();
  const notice = g.run('toast("분장 완료", {duration: 4000, dismissOnClick: true})');
  const keydown = g.run('document.captureListeners.keydown');
  for (const event of [
    { code: 'Space', repeat: true },
    { code: 'ArrowRight', isComposing: true },
    { code: 'Space', keyCode: 229 },
    { code: 'KeyA' },
  ]) keydown({ target: null, preventDefault() {}, stopImmediatePropagation() {}, ...event });
  assert.equal(g.elements.get('toast').hidden, false);
  g.fire(4000); await notice;
  assert.equal(g.run('document.captureListeners.keydown'), undefined);
  assert.equal(g.run('document.captureListeners.click'), undefined);
});

test('presence keeps one latest live session per account and drops silent ones', () => {
  const { run } = game();
  const peers = run(`livePresence({
    a: { old: { x: 1, y: 1, at: 1000 }, tab1: { x: 2, y: 2, at: 95000 }, tab2: { x: 3, y: 3, at: 99000 } },
    b: { gone: { x: 4, y: 4, at: 30000 } },
  }, 100000)`);
  assert.deepEqual(JSON.parse(JSON.stringify(peers)), [{ by: 'a', id: 'tab2', presence: { x: 3, y: 3, at: 99000 } }]);
});

test('an idle player still refreshes presence on the heartbeat', () => {
  const { run, setNow } = game();
  run(`var sent = 0; S.room = { presence: async () => { sent += 1; } }; presenceDirty = false; lastPresence = 0;`);
  setNow(1000); run('sendPresence()');
  assert.equal(run('sent'), 0);
  setNow(20000); run('sendPresence()');
  assert.equal(run('sent'), 1);
});

test('own costume survives until the village snapshot arrives', () => {
  const { run } = game();
  run(`S.me = 'u1'; S.players = { u1: { ...blankPlayer(), nick: '나', costume: 'cat' } }; S.firebasePlayers = {}; applyFirebasePlayers();`);
  assert.equal(run('myCostume()'), 'cat');
  run(`S.firebasePlayers = { u1: { ...blankPlayer(), nick: '나', costume: 'witch' } }; applyFirebasePlayers();`);
  assert.equal(run('myCostume()'), 'witch');
});

function roofSaves(g) {
  g.players();
  g.run(`S.mode = 'firebase'; S.firebasePlayers = {}; S.ownPlayer = { ...S.players.me, door: 1 };
    S.account = { auth: { currentUser: { uid: 'me', getIdToken: async () => 'token' } } };
    const sent = [], answers = [];
    accountRequest = (url, options) => new Promise((resolve, reject) => {
      sent.push(JSON.parse(options.body)); answers.push({ resolve, reject });
    });
    const serverSaw = (door) => { S.ownPlayer = { ...S.ownPlayer, door }; applyFirebasePlayers(); };`);
}

test('quick roof changes keep the last color while older saves come back, and send only the last one', async () => {
  const g = game(); roofSaves(g);
  g.run('saveMe({ door: 2 })');
  await tick();
  g.run('saveMe({ door: 3 }); saveMe({ door: 5 }); var last = queuedProfile.done;');
  assert.equal(g.run('JSON.stringify(sent)'), '[{"door":2}]');
  g.run('serverSaw(2)');
  assert.equal(g.run('S.players.me.door'), 5);
  g.run('answers[0].resolve({ profile: { door: 2 } })');
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(g.run('JSON.stringify(sent)'), '[{"door":2},{"door":5}]');
  g.run('serverSaw(2)');
  assert.equal(g.run('S.players.me.door'), 5);
  g.run('answers[1].resolve({ profile: { door: 5 } })');
  await g.run('last');
  g.run('serverSaw(5)');
  assert.equal(g.run('S.players.me.door'), 5);
  assert.equal(g.run('Object.keys(unsavedProfile.fields).length'), 0);
});

test('a failed roof save goes back to the color the server has', async () => {
  const g = game(); roofSaves(g);
  g.run(`saveMe({ door: 4 }); var failed = queuedProfile.done.catch(() => {});`);
  await tick();
  assert.equal(g.run('S.players.me.door'), 4);
  g.run(`answers[0].reject(new Error('offline'))`);
  await g.run('failed');
  await tick();
  assert.equal(g.run('S.players.me.door'), 1);
});

function village(g) {
  g.run(`S.mode = 'firebase'; S.me = 'me'; S.village = 1;
    S.villages = { 1: { n: 1, name: '태초마을' }, 2: { n: 2, name: '구리마을' }, 3: { n: 3, name: '안드로이드 제국' } };
    S.players = {
      me: { ...blankPlayer(), nick: '나', costume: 'ghost', village: 1, joinedAt: 1 },
      near: { ...blankPlayer(), nick: '이웃', costume: 'witch', village: 1, joinedAt: 2 },
      far: { ...blankPlayer(), nick: '먼집', costume: 'cat', village: 2, joinedAt: 3 },
    }; render();`);
}

test('an online village shows only its own eight lots and wraps its gates around', () => {
  const g = game(); village(g);
  assert.deepEqual(JSON.parse(g.run('JSON.stringify(houseOwners())')), ['me', 'near']);
  assert.equal(g.run('MAP.slots.length'), 8);
  assert.equal(g.run('MAP.gates'), true);
  assert.equal(g.run('nextVillage(1)'), 2);
  assert.equal(g.run('nextVillage(-1)'), 3);
  g.run('S.village = 3; render();');
  assert.equal(g.run('nextVillage(1)'), 1);
  assert.deepEqual(JSON.parse(g.run('JSON.stringify(houseOwners())')), []);
  g.run('S.villages = { 1: { n: 1 } }; S.village = 1; render();');
  assert.equal(g.run('MAP.gates'), false);
});

test('walking through the bottom sign moves to the next village and arrives at its top sign', async () => {
  const g = game(); village(g);
  g.run(`var entered = []; S.room = { peers: () => [], presence: async () => {},
    enterVillage: async (n) => { entered.push(n); S.village = n; } };
    S.pos.x = 13 * T; S.pos.y = (MAP.rows - 2) * T + 14; keys.add('d');`);
  for (let i = 0; i < 10 && !g.run('S.busy'); i++) g.run('update(0.05)');
  assert.equal(g.run('S.busy'), true);
  assert.equal(g.elements.get('veil').classList.contains('on'), true);
  assert.equal(g.elements.get('veil').textContent, '구리마을');
  g.fire(300); await tick(); await tick();
  g.fire(200); await tick();
  assert.equal(g.run('JSON.stringify(entered)'), '[2]');
  assert.equal(g.run('S.pos.y'), g.run('T + 10'));
  assert.equal(g.run('S.busy'), false);
  assert.equal(g.elements.get('veil').classList.contains('on'), false);
});

test('visits from another village are read from the host document without double counting', () => {
  const g = game(); village(g);
  g.run(`S.seenAt = 0; var toasts = []; toast = (m) => toasts.push(m);
    S.players.near.knocks = [{ h: 'me', r: 'win', at: 50, c: 'witch', moved: true }];
    S.players.me.guests = [
      { v: 'near', r: 'win', at: 50, c: 'witch', moved: true },
      { v: 'far', nick: '먼집', r: 'win', at: 60, c: 'cat', moved: false },
      { v: 'far', nick: '먼집', text: '또 올게', at: 70, c: 'cat' },
    ];
    delete S.players.far;`);
  assert.equal(g.run('visitsTo(S.me).length'), 3);
  g.run(`S.names.far = '먼집'; notifyKnocks();`);
  assert.equal(g.run('toasts.length'), 3);
  assert.match(g.run('toasts.at(-1)'), /먼집이 방명록에 글을 남겼어요: 또 올게/);
  assert.match(g.run('guestbookHtml(S.me)'), /또 올게/);
});

test('online rankings come from the shared server list and are not refetched within thirty seconds', async () => {
  const g = game(); village(g);
  g.run(`var calls = []; S.event = { id: 'r1', startedAt: 1, endsAt: Date.now() + 60000 };
    accountRequest = async (url) => { calls.push(url); return { players: [
      { id: 'far', nick: '먼집', costume: 'cat', n: 12, village: 2 }, { id: 'me', nick: '나', costume: 'ghost', n: 9, village: 1 },
    ] }; };`);
  assert.equal(g.run('ranking().length'), 0);
  g.run(`openModal('rank')`);
  await tick(); await tick();
  assert.equal(g.run('JSON.stringify(calls)'), '["/api/game/leaderboard"]');
  assert.equal(g.run('ranking()[0].id'), 'far');
  assert.match(g.run('eventLine()'), /내 순위 2등/);
  assert.match(g.elements.get('rk-list').innerHTML, /먼집/);
  g.run(`closeModal('rank'); openModal('rank')`);
  await tick();
  assert.equal(g.run('calls.length'), 1, 'reopening right away reuses the list');
});

test('chat reaches every village but shows a bubble only for people in the same village', () => {
  const g = game(); village(g);
  g.run(`onChat({ data: { text: '옆 마을 안녕', v: 2 }, by: 'far', peer: 'far:tab' });
    onChat({ data: { text: '여기 안녕', v: 1 }, by: 'near', peer: 'near:tab' });`);
  assert.equal(g.run(`chatBubbles.has('far:tab')`), false);
  assert.equal(g.run(`chatBubbles.has('near:tab')`), true);
  const log = g.elements.get('chatlog').innerHTML;
  assert.match(log, /\[구리마을\]<\/small> 먼집<\/b>옆 마을 안녕/);
  assert.match(log, /<b>이웃<\/b>여기 안녕/);
});

test('the village map lists villages top to bottom in sign order and travels to the chosen one', async () => {
  const g = game(); village(g);
  g.run(`S.online = [
    { by: 'far', presence: { v: 2, at: 1 } }, { by: 'me', presence: { v: 1, at: 1 } }, { by: 'near', presence: { v: 1, at: 1 } },
  ]; S.networkConnected = true; openModal('online'); renderHud();
    var entered = []; S.room = { peers: () => [], presence: async () => {}, enterVillage: async (n) => { entered.push(n); S.village = n; } };`);
  const ring = g.elements.get('on-chain').innerHTML, list = g.elements.get('on-list').innerHTML;
  assert.ok(ring.indexOf('태초마을') < ring.indexOf('구리마을') && ring.indexOf('구리마을') < ring.indexOf('안드로이드 제국'), 'villages run top to bottom in sign order');
  assert.match(ring, /aria-current="true">\s*<span class="no">1<\/span><b>태초마을/, 'the current village is marked');
  assert.match(ring, /안드로이드 제국<\/b><small>접속 0명/);
  assert.doesNotMatch(ring, /data-go="1"/);
  assert.match(ring, /data-go="3"/);
  assert.match(ring, /1번에서 위로 가면 3번/);
  assert.match(ring, /3번에서 아래로 가면 1번/);
  assert.ok(list.indexOf('1. 태초마을') < list.indexOf('2. 구리마을'));
  assert.match(list, /나 \(나\), 이웃/);
  assert.match(g.elements.get('on-sub').textContent, /마을 3개 · 접속 3명/);
  assert.match(g.elements.get('me').innerHTML, /전체 3명/);
  assert.equal(g.elements.get('open-online').hidden, false);
  g.run(`document.listeners.click({ target: { classList: { contains: () => false }, closest: () => ({ dataset: { go: '3' } }) } })`);
  assert.equal(g.elements.get('online').hidden, true);
  g.fire(300); await tick(); await tick();
  g.fire(200); await tick();
  assert.equal(g.run('JSON.stringify(entered)'), '[3]');
  assert.equal(g.run('S.pos.y'), g.run('SPAWN.y'));
});

test('basket stays after harvesting more, alchemy tip explains the cauldron, and the bag caps at 100', async () => {
  const g = game(); g.players();
  g.run(`globalThis.messages = []; say = async (who, text) => messages.push(text);`);
  for (let i = 0; i < 3; i++) g.run('S.pumpkins = [{ x: 32, y: 32 }]; harvest(S.pumpkins[0])');
  await g.finish(g.run('alchemyTips()'));
  assert.equal(g.run('S.players.me.basket'), true);
  assert.match(g.run('messages.join(" ")'), /30개를 모아 광장 가운데 마녀 솥/);
  assert.equal(g.run('S.busy'), false);
  const told = g.run('messages.length');
  g.run('S.pumpkins = [{ x: 32, y: 32 }]; harvest(S.pumpkins[0])');
  await g.finish(g.run('waitForToasts()'));
  assert.equal(g.run('S.players.me.pumpkins'), 4);
  assert.equal(g.run('messages.length'), told);
  g.run('S.players.me.pumpkins = 100; S.pumpkins = [{ x: 32, y: 32 }]; harvest(S.pumpkins[0])');
  assert.equal(g.run('S.players.me.pumpkins'), 100);
  assert.match(g.elements.get('toast').textContent, /꽉 찼어요/);
});

test('brewing spends thirty pumpkins, adds rolled candy, keeps the basket and cools down', async () => {
  const g = game(); g.players();
  g.run(`globalThis.messages = []; say = async (who, text) => messages.push(text); Math.random = () => 0.5;
    S.players.me.pumpkins = 20; S.players.me.basket = true; S.nearCauldron = true; renderAction();`);
  assert.equal(g.elements.get('act-btn').disabled, true);
  g.run('S.players.me.pumpkins = 60; renderAction()');
  assert.equal(g.elements.get('act-btn').disabled, false);
  assert.match(g.elements.get('act-title').textContent, /마녀 솥 · 호박 60\/30/);
  await g.finish(g.run('brew()'));
  assert.equal(g.run('candiesOf("me")'), 12);
  assert.equal(g.run('S.players.me.pumpkins'), 30);
  assert.equal(g.run('hasBasket("me")'), true);
  assert.match(g.run('messages.join(" ")'), /사탕 2개가 떠올랐어요/);
  g.run('S.players.me.pumpkins = 60; S.nearCauldron = true; renderAction()');
  assert.equal(g.elements.get('act-btn').disabled, true);
  assert.match(g.elements.get('act-sub').textContent, /식는 중 · 10분 뒤/);
  await g.finish(g.run('brew()'));
  assert.equal(g.run('candiesOf("me")'), 12);
  assert.match(g.elements.get('toast').textContent, /식는 중/);
});

test('an online harvest shows at once while the server answers, and rolls back if the server refuses', async () => {
  const g = game(); g.players();
  g.run(`S.mode = 'firebase'; crypto = { randomUUID: () => 'harvest-request' };
    S.account = { auth: { currentUser: { uid: 'me', getIdToken: async () => 'token' } } };
    var answer; accountRequest = () => new Promise((resolve, reject) => { answer = { resolve, reject }; });
    S.pumpkins = [{ x: 32, y: 32 }]; var first = harvest(S.pumpkins[0]);`);
  await tick();
  assert.equal(g.run('S.pumpkins.length'), 0, 'the pumpkin disappears before the server answers');
  assert.equal(g.run('S.players.me.pumpkins'), 1);
  assert.equal(g.run('S.floats.some((f) => f.text === "호박 +1")'), true);
  g.run('answer.resolve({ pumpkins: 1, basket: false })');
  await g.run('first');
  assert.equal(g.run('S.players.me.pumpkins'), 1);

  g.run(`S.pumpkins = [{ x: 48, y: 48 }]; var second = harvest(S.pumpkins[0]);`);
  await tick();
  assert.equal(g.run('S.players.me.pumpkins'), 2);
  g.run(`const refused = new Error('조금 뒤 다른 호박을 따 주세요.'); refused.status = 429; answer.reject(refused);`);
  await g.run('second');
  assert.equal(g.run('S.players.me.pumpkins'), 1, 'a refused harvest is taken back');
  assert.equal(g.run('S.pumpkins.length'), 1, 'and the pumpkin returns');
  assert.match(g.elements.get('toast').textContent, /조금 뒤 다른 호박/);
});

test('dialog text cannot be selected and any later click, Space, → or ↓ moves to the next line', async () => {
  assert.match(html, /\.dialog\{[^}]*user-select:none/);
  const g = game(); g.players();
  const click = (timeStamp, button = null) => g.run(`document.listeners.click({ timeStamp: ${timeStamp}, preventDefault() {},
    target: { classList: { contains: () => false }, closest: () => (${JSON.stringify(button)}) } })`);
  const key = (code, repeat = false) => g.run(`document.listeners.keydown({ code: '${code}', key: '${code}', repeat: ${repeat}, target: null, preventDefault() {} })`);
  g.setNow(100);
  g.run(`globalThis.lines = []; (async () => { for (const line of ['하나', '둘', '셋', '넷']) { await say('안내', line); lines.push(line); } })();`);
  await tick();
  click(50);
  await tick();
  assert.equal(g.run('lines.length'), 0, 'the click that opened the dialog does not skip it');
  g.elements.get('world').listeners.pointerdown({ clientX: 500, clientY: 500 });
  assert.equal(g.run('S.target'), null, 'clicking the map while talking does not walk');
  click(150, { id: 'open-rank', dataset: {} });
  await tick();
  assert.equal(g.run('lines.length'), 1, 'a click anywhere, even on a HUD button, moves on');
  assert.equal(g.elements.get('rank').hidden, true);
  key('ArrowRight'); await tick();
  assert.equal(g.run('lines.length'), 2);
  assert.equal(g.run('keys.has("r")'), false, '→ only turns the page');
  key('ArrowDown', true); await tick();
  assert.equal(g.run('lines.length'), 2, 'a held key turns only one page');
  key('ArrowDown'); await tick();
  assert.equal(g.run('lines.length'), 3);
  key('Space'); await tick();
  assert.equal(g.run('lines.length'), 4);
  assert.equal(g.run('dialogWaiting()'), true, 'the last line still waits until the caller closes it');
});

test('choices start on the first option, move with ← →, pick with Space or Enter, and Esc closes only when allowed', async () => {
  const g = game(); g.players();
  const key = (code, extra = '') => g.run(`document.listeners.keydown({ code: '${code}', key: '${code === 'Escape' ? 'Escape' : code}', repeat: false, target: null, preventDefault() {} ${extra} })`);
  const options = `[['again', '한 번 더'], ['note', '방명록'], ['bye', '그만']]`;
  g.run(`$('#dialog').hidden = false; var picked = choose(${options}, { cancel: 'bye' });`);
  assert.equal(g.run('choice.index'), 0, 'the first option is chosen by default');
  key('ArrowRight'); key('ArrowRight'); key('ArrowRight');
  assert.equal(g.run('choice.index'), 2, 'stops at the last option');
  key('ArrowLeft');
  key('Enter');
  assert.equal(await g.run('picked'), 'note');
  assert.equal(g.run('choice'), null);

  g.run(`var spaced = choose(${options}, { cancel: 'bye' });`);
  key('Space');
  assert.equal(await g.run('spaced'), 'again');

  g.run(`var escaped = choose(${options}, { cancel: 'bye' });`);
  key('Escape');
  assert.equal(await g.run('escaped'), 'bye', 'Esc closes with the cancel option');

  g.run(`var settled = false; var required = choose([['a', '가'], ['b', '나']]).then((v) => { settled = true; return v; });`);
  key('Escape');
  await tick();
  assert.equal(g.run('settled'), false, 'a required choice ignores Esc');
  key('KeyD'); key('Space');
  assert.equal(await g.run('required'), 'b');
});

function memoryStorage(items = {}) {
  return { items, getItem: (key) => items[key] ?? null, setItem: (key, value) => { items[key] = value; } };
}
// 진짜 오디오 대신 어떤 효과음을 냈는지만 기록한다.
function soundSpy(g) {
  g.run(`globalThis.played = []; globalThis.contexts = 0;
    window.AudioContext = class { constructor() { contexts++; this.state = 'running'; this.currentTime = 0; this.destination = {}; }
      createGain() { return { gain: { value: 1 }, connect: (node) => node }; } resume() { return Promise.resolve(); } };
    for (const name of Object.keys(SFX)) SFX[name] = () => played.push(name);`);
}

test('sound starts with music off and effects on, and the sound window saves each switch', () => {
  const storage = memoryStorage();
  const g = game({ storage });
  g.run(`openModal('sound')`);
  assert.equal(g.elements.get('sound').hidden, false);
  assert.equal(g.elements.get('sd-bgm').textContent, '꺼짐');
  assert.equal(g.elements.get('sd-sfx').textContent, '켜짐');
  g.run(`setSound('sfx', false)`);
  assert.equal(g.elements.get('sd-sfx').textContent, '꺼짐');
  assert.equal(g.elements.get('sd-sfx')['aria-pressed'], 'false');
  assert.deepEqual(JSON.parse(storage.items['trick-or-treat:sound']), { bgm: false, sfx: false });
  const again = game({ storage });
  assert.equal(again.run('sound.sfx'), false);
});

test('broken or missing sound storage falls back to the defaults', () => {
  for (const storage of [memoryStorage({ 'trick-or-treat:sound': '{broken' }), memoryStorage({ 'trick-or-treat:sound': '{"bgm":"yes"}' }), undefined]) {
    const g = game({ storage });
    assert.equal(g.run('sound.bgm'), false);
    assert.equal(g.run('sound.sfx'), true);
  }
});

test('turned-off effects make no sound and never create audio', () => {
  const g = game(); g.players(); soundSpy(g);
  g.run(`setSound('sfx', false); S.pumpkins = [{ x: 32, y: 32 }]; harvest(S.pumpkins[0])`);
  assert.equal(g.run('played.length'), 0);
  assert.equal(g.run('contexts'), 0);
});

test('harvest, bonk, stun, knock news and a new trick each make their own sound once', () => {
  const g = game(); g.players(); soundSpy(g);
  g.run(`S.pumpkins = [{ x: 32, y: 32 }]; harvest(S.pumpkins[0])`);
  g.run(`S.myPeer = 'mine'; for (let i = 0; i < BONK_TO_STUN; i++) onBonk({ data: { to: 'mine' }, by: 'host' })`);
  g.run(`onBonk({ data: { to: 'someone-else' }, by: 'host' })`);
  g.run(`S.seenAt = 0; toast = () => {}; S.players.me.guests = [
    { v: 'host', r: 'win', at: 50, c: 'witch' }, { v: 'host', r: 'lose', at: 60, c: 'witch' }]; notifyKnocks()`);
  g.run(`S.players.me.knocks = [{ h: 'host', r: 'lose', k: 'slow', at: Date.now() }]; renderHud(); renderHud()`);
  assert.deepEqual(JSON.parse(g.run('JSON.stringify(played)')), ['pumpkin', 'hit', 'hit', 'hit', 'hit', 'stun', 'knocks', 'trick']);
});

test('a knock taps the door three times and the candy catch result sounds', async () => {
  const g = game(); g.players(); soundSpy(g);
  g.run(`S.players.me.pumpkins = 3; say = async () => {}; choose = async () => 'bye';
    candyGame = async () => ({ won: true, inputs: [], elapsedMs: 4200 });`);
  await g.finish(g.run(`knock(MAP.slots.find((s) => s.owner === 'host'))`));
  assert.deepEqual(JSON.parse(g.run('JSON.stringify(played)')), ['knock', 'knock', 'knock']);

  const miss = game(); soundSpy(miss);
  const result = miss.run('candyGame({ level: 1, path: [{t:0,y:.05},{t:18000,y:.05}] })');
  for (let now = 20; now <= 4000 && miss.run('S.candyControl !== null'); now += 20) {
    miss.setNow(now);
    [...miss.frames.values()].at(-1)?.();
  }
  miss.fire(0);
  await result;
  assert.deepEqual(JSON.parse(miss.run('JSON.stringify(played)')), ['miss']);
});

test('the cauldron bubbles while brewing', async () => {
  const g = game(); g.players(); soundSpy(g);
  g.run(`say = async () => {}; Math.random = () => 0.5; S.players.me.pumpkins = 60; S.players.me.basket = true;`);
  await g.finish(g.run('brew()'));
  assert.deepEqual(JSON.parse(g.run('JSON.stringify(played)')), ['bubble', 'bubble', 'bubble']);
});
