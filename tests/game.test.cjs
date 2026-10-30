// 의존성 없는 로직 회귀 검사. DOM/타이머는 대역이므로 실제 렌더링 검사를 대신하지 않는다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../prototype/trick-or-treat.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^boot\(\);$/m, '');
const tick = () => new Promise(setImmediate);

function game({ reducedMotion = true } = {}) {
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
    document, window, console, AbortController, performance: { now: () => now }, matchMedia: () => ({ matches: reducedMotion }),
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
  assert.equal(g.run('ranking()[0].id'), 'host');
  g.run(`S.event.id = 'round2'`);
  assert.equal(g.run('candiesOf(S.me)'), 10);
  assert.equal(g.run('candiesOf("host")'), 10);
});

test('candy challenge renders the server difficulty and moves the catch bar while held', () => {
  const g = game();
  g.run(`candyGame({ level: 3, duration: 18000, path: [{t:0,y:.5},{t:18000,y:.5}] })`);
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

test('candy challenge difficulty has five stages and an eighteen-second limit', () => {
  const g = game();
  assert.equal(g.run('CANDY_MAX_LEVEL'), 5);
  assert.equal(g.run('CANDY_GAME_MS'), 18000);
  assert.equal(g.run('localCandyPath(5).at(-1).t'), 18000);
});

test('holding the bar until the catch meter fills succeeds', async () => {
  const g = game();
  const result = g.run('candyGame({ level: 1, duration: 18000, path: [{t:0,y:.05},{t:18000,y:.05}] })');
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
  const result = g.run('candyGame({ level: 1, duration: 18000, path: [{t:0,y:.05},{t:18000,y:.05}] })');
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

test('a miss leaves candy unchanged; decor reduces rank balance', () => {
  const g = game(); g.players();
  g.run(`S.players.me.knocks = Array.from({length: 15}, (_, i) => ({h: 'host', r: 'lose', at: i + 1})); S.ledger = null`);
  assert.equal(g.run('candiesOf("me")'), 10);
  assert.equal(g.run('candiesOf("host")'), 10);
  g.run(`S.players.me.knocks = []; S.ledger = null; buyDecor('lantern')`);
  assert.equal(g.run('candiesOf("me")'), 8);
  assert.equal(g.run('ranking()[0].id'), 'host');
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

test('basket stays after harvesting more, alchemy tip explains the cauldron, and the bag caps at 100', async () => {
  const g = game(); g.players();
  g.run(`globalThis.messages = []; say = async (who, text) => messages.push(text);`);
  for (let i = 0; i < 3; i++) g.run('S.pumpkins = [{ x: 32, y: 32 }]; harvest(S.pumpkins[0])');
  await g.finish(g.run('alchemyTips()'));
  assert.equal(g.run('S.players.me.basket'), true);
  assert.match(g.run('messages.join(" ")'), /50개를 모아 광장 가운데 마녀 솥/);
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

test('brewing spends fifty pumpkins, adds rolled candy, keeps the basket and cools down', async () => {
  const g = game(); g.players();
  g.run(`globalThis.messages = []; say = async (who, text) => messages.push(text); Math.random = () => 0.5;
    S.players.me.pumpkins = 40; S.players.me.basket = true; S.nearCauldron = true; renderAction();`);
  assert.equal(g.elements.get('act-btn').disabled, true);
  g.run('S.players.me.pumpkins = 60; renderAction()');
  assert.equal(g.elements.get('act-btn').disabled, false);
  assert.match(g.elements.get('act-title').textContent, /마녀 솥 · 호박 60\/50/);
  await g.finish(g.run('brew()'));
  assert.equal(g.run('candiesOf("me")'), 12);
  assert.equal(g.run('S.players.me.pumpkins'), 10);
  assert.equal(g.run('hasBasket("me")'), true);
  assert.match(g.run('messages.join(" ")'), /사탕 2개가 떠올랐어요/);
  g.run('S.players.me.pumpkins = 60; S.nearCauldron = true; renderAction()');
  assert.equal(g.elements.get('act-btn').disabled, true);
  assert.match(g.elements.get('act-sub').textContent, /식는 중 · 10분 뒤/);
  await g.finish(g.run('brew()'));
  assert.equal(g.run('candiesOf("me")'), 12);
  assert.match(g.elements.get('toast').textContent, /식는 중/);
});
