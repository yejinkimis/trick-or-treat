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
      insertAdjacentHTML(position, markup) { this.innerHTML += markup; }, scrollTop: 0, scrollHeight: 0,
      children: [], append(...kids) { this.children.push(...kids); }, replaceChildren() { this.children = []; },
      firstChild: { textContent: '' },
    };
    Object.defineProperty(el, 'className', { get: () => [...classes].join(' '), set(value) { classes.clear(); value.split(/\s+/).forEach((x) => classes.add(x)); } });
    let markup = '';
    Object.defineProperty(el, 'innerHTML', {
      get: () => markup,
      set(value) {
        el.htmlReplacements = (el.htmlReplacements || 0) + 1;
        markup = String(value);
        for (const match of markup.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
          elements.set(match[3], element(match[3], match[1], match[2]));
        }
      },
    });
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

test('duel clock ticks preserve the stake select, selected value and accept controls', () => {
  const g = game(); g.players();
  g.run(`S.mode = 'firebase'; S.players.me.round = 'practice'; S.players.me.candies = 10;
    S.nearPeer = 'host:peer'; ghosts.set('host:peer', { by: 'host', peer: 'host:peer' });
    renderDuelModal();`);
  const select = g.elements.get('du-stake');
  select.value = '7';
  for (let i = 0; i < 5; i++) g.run('renderDuelModal()');
  assert.equal(g.elements.get('du-stake'), select, 'an open native select must not be detached by a clock tick');
  assert.equal(select.value, '7');
  g.run(`S.duels = [{ id: 'invite', players: ['host', 'me'], challenger: 'host', opponent: 'me',
    stake: 3, status: 'pending', expiresAt: Date.now() + 60000 }]; renderDuelModal();`);
  const content = g.elements.get('du-content');
  const replacements = content.htmlReplacements;
  g.run(`Date.now = () => S.duels[0].expiresAt - 30000; renderDuelModal();`);
  assert.equal(content.htmlReplacements, replacements, 'countdown changes must not replace the accept button during a click');
  g.run(`S.duelActionPending = true; renderDuelModal();`);
  assert.equal(content.htmlReplacements, replacements + 1, 'a real action state change still disables controls');
});

test('denied duel subscription falls back to authenticated reads and queues invites while busy', async () => {
  const g = game(); g.players();
  // Exercise the actual subscription setup without booting the unrelated map/chat subscriptions.
  const begin = source.indexOf('async function connectFirebaseGame(uid) {');
  const end = source.indexOf('  const sid = crypto.randomUUID()', begin);
  g.run(source.slice(begin, end) + '\n}');
  g.run(`var subscriptionError, delivered = [];
    S.mode = 'firebase'; S.busy = true; $('#duel').hidden = true;
    S.account = { auth: { currentUser: { getIdToken: async () => 'token' } },
      firestoreSdk: { collection() {}, where() {}, orderBy() {}, limit() {}, query() {},
        onSnapshot(q, options, next, error) { subscriptionError = error; return () => {}; } } };
    accountRequest = async (url, options) => {
      if (url === '/api/game/session') return { village: 1, isAdmin: false };
      if (options.headers.authorization !== 'Bearer token') throw new Error('missing authentication');
      return { duels: JSON.parse(JSON.stringify(delivered)) };
    };`);
  await g.run(`connectFirebaseGame('me')`);
  g.run(`delivered = [{ id: 'invite', players: ['host', 'me'], challenger: 'host', opponent: 'me',
    stake: 3, status: 'pending', expiresAt: Date.now() + 60000 }];
    subscriptionError({ code: 'permission-denied' });`);
  await tick();
  assert.equal(g.run('S.duel.status'), 'pending');
  assert.equal(g.elements.get('duel').hidden, true, 'the invite waits while a knock is in progress');
  g.run('S.busy = false; S.account.promptDuel()');
  assert.equal(g.elements.get('duel').hidden, false);
  assert.match(g.elements.get('du-content').innerHTML, /수락하고 대전/);
  g.run(`delivered[0] = { ...delivered[0], status: 'active', hits: {}, hardDeadline: Date.now() + 90000 };`);
  await g.run('S.account.refreshDuels()');
  assert.equal(g.elements.get('duel').hidden, true);
  assert.equal(g.elements.get('duel-start').hidden, false);
  g.fire(900);
  assert.equal(g.elements.get('duel-start-text').textContent, '땅!');
  g.run(`delivered[0].hits.me = { count: 1, at: Date.now() };`);
  await g.run('S.account.refreshDuels()');
  assert.equal(g.run('S.floats.at(-1).text'), '뿅! 1/5', 'a victim sees a hit from the API poll without an RTDB event');
  const swings = g.run('S.swings.length');
  await g.run('S.account.refreshDuels()');
  assert.equal(g.run('S.swings.length'), swings, 'repeated polls do not replay hit effects');
  g.run("openModal('duel')");
  await g.run('S.account.refreshDuels()');
  assert.equal(g.elements.get('duel').hidden, false, 'an unchanged active snapshot must not close a manually opened window');
  g.run(`delivered[0] = { ...delivered[0], status: 'completed', winner: 'host', loser: 'me', updatedAt: Date.now(),
    hits: { me: { count: 5, at: delivered[0].hits.me.at + 1 } } };`);
  await g.run('S.account.refreshDuels()');
  assert.equal(g.run('S.floats.at(-1).text'), '기절!');
  assert.equal(g.run('S.stunUntil > Date.now()'), true, 'the victim is stunned even without any RTDB message');
});

test('both duel clients show authoritative hit effects once regardless of API/snapshot order', () => {
  const attacker = game(), victim = game();
  for (const [g, me, other] of [[attacker, 'me', 'host'], [victim, 'host', 'me']]) {
    g.players();
    g.run(`S.me = '${me}'; var sounds = []; playSfx = (name) => sounds.push(name);
      ghosts.set('peer', { by: '${other}', x: 100, y: 100 });
      var duel = { id: 'match', players: ['me', 'host'], status: 'active', hits: {} };
      var previous = JSON.parse(JSON.stringify(duel));
      duel.hits.host = { count: 1, at: 1000 };`);
  }
  attacker.run('showDuelHit(duel, "host", duel.hits.host); syncDuelHitEffects(duel, previous)');
  victim.run('syncDuelHitEffects(duel, previous); showDuelHit(duel, "host", duel.hits.host)');
  for (const g of [attacker, victim]) {
    assert.equal(g.run('S.swings.length'), 1);
    assert.equal(g.run('S.floats.at(-1).text'), '뿅! 1/5');
    assert.equal(g.run('sounds.join()'), 'hit');
    g.run(`previous = JSON.parse(JSON.stringify(duel)); duel.hits.host = { count: 1, at: 8000 };
      syncDuelHitEffects(duel, previous);`);
    assert.equal(g.run('S.swings.length'), 2, 'a hit after the count resets still plays');
    g.run(`previous = JSON.parse(JSON.stringify(duel)); duel.status = 'completed';
      duel.hits.host = { count: 5, at: 11000 }; syncDuelHitEffects(duel, previous);
      syncDuelHitEffects(duel, previous);`);
    assert.equal(g.run('S.swings.length'), 3);
    assert.equal(g.run('S.floats.at(-1).text'), '기절!');
  }
  assert.equal(victim.run('sounds.at(-1)'), 'stun');
  assert.equal(attacker.run('sounds.at(-1)'), 'hit');
});

test('reconnecting and repeated snapshots do not replay historic duel hits', () => {
  const g = game(); g.players();
  g.run(`var duel = { id: 'old', players: ['me', 'host'], status: 'active',
    hits: { me: { count: 3, at: Date.now() - 10000 } } };
    syncDuelHitEffects(duel, null); syncDuelHitEffects(duel, duel);`);
  assert.equal(g.run('S.swings.length'), 0);
});

test('item purchases and uses cannot overlap or overwrite a newer inventory', async () => {
  const g = game(); g.players();
  g.run(`S.mode = 'firebase'; S.players.me.round = 'practice'; S.players.me.candies = 10;
    S.ownPrivate = { inventory: { 'house-ward': 1 } }; renderHouse();
    var requests = [];
    gameRequest = (input) => new Promise((resolve, reject) => requests.push({ input, resolve, reject }));
    var purchase = buyItem('house-ward');`);
  assert.equal(g.elements.get('item-buy-house-ward').disabled, true);
  assert.equal(g.elements.get('item-use-house-ward').disabled, true);
  await g.run(`buyItem('house-ward')`);
  await g.run(`useItem('house-ward')`);
  assert.equal(g.run('requests.length'), 1, 'rapid clicks cannot send overlapping inventory writes');
  await g.run(`requests[0].resolve({ round: 'practice', candies: 5, inventory: { 'house-ward': 2 },
    purchase: { item: 'house-ward', price: 5, at: Date.now() } }); purchase`);
  assert.equal(g.run(`itemInventory()['house-ward']`), 2);
  assert.equal(g.run(`candiesOf('me')`), 5);
  assert.equal(g.elements.get('item-buy-house-ward').disabled, false);
  assert.equal(g.elements.get('item-use-house-ward').disabled, false);
  g.run(`var use = useItem('house-ward')`);
  await g.run(`buyItem('house-ward')`);
  await g.run(`useItem('house-ward')`);
  assert.equal(g.run('requests.length'), 2, 'use shares the purchase lock');
  await g.run(`requests[1].resolve({ inventory: { 'house-ward': 1 }, usedAt: Date.now(), guardUntil: Date.now() + 300000 }); use`);
  assert.equal(g.run(`itemInventory()['house-ward']`), 1);
  assert.equal(g.elements.get('item-buy-house-ward').disabled, false);
  assert.equal(g.elements.get('item-use-house-ward').disabled, true, 'cooldown still applies after unlocking');
});

test('failed item actions unlock both buttons and allow another purchase', async () => {
  const g = game(); g.players();
  g.run(`S.mode = 'firebase'; S.players.me.round = 'practice'; S.players.me.candies = 10;
    S.ownPrivate = { inventory: { 'house-ward': 1 } }; renderHouse();
    gameRequest = async () => { throw new Error('잠시 뒤 다시 시도해 주세요.'); };`);
  for (const action of ['buyItem', 'useItem']) {
    await g.run(`${action}('house-ward')`);
    assert.equal(g.elements.get('item-buy-house-ward').disabled, false);
    assert.equal(g.elements.get('item-use-house-ward').disabled, false);
    assert.equal(g.run(`itemInventory()['house-ward']`), 1);
  }
  g.run(`gameRequest = async () => ({ round: 'practice', candies: 5, inventory: { 'house-ward': 2 },
    purchase: { item: 'house-ward', price: 5, at: Date.now() } });`);
  await g.run(`buyItem('house-ward')`);
  assert.equal(g.run(`itemInventory()['house-ward']`), 2);
});

test('practice items deduct candy, protect for five minutes and wait twenty minutes between uses', async () => {
  const g = game(); g.players();
  g.run('Date.now = () => 1800000000000; renderHouse()');
  await g.run(`buyItem('house-ward')`);
  assert.equal(g.run(`candiesOf('me')`), 5);
  await g.run(`useItem('house-ward')`);
  assert.equal(g.run('S.players.me.guardUntil'), 1800000300000);
  await g.run(`buyItem('house-ward')`);
  assert.equal(g.run(`candiesOf('me')`), 0);
  for (const elapsed of [300000, 1199999]) {
    g.run(`Date.now = () => ${1800000000000 + elapsed}`);
    await g.run(`useItem('house-ward')`);
    assert.equal(g.run(`itemInventory()['house-ward']`), 1);
  }
  g.run('Date.now = () => 1800001200000');
  await g.run(`useItem('house-ward')`);
  assert.equal(g.run(`itemInventory()['house-ward']`), 0);
});

for (const activeAtFinish of [true, false]) {
  test(`local challenge ${activeAtFinish ? 'respects a newly activated ward' : 'allows transfers after the ward expires'}`, async () => {
    const g = game(); g.players();
    g.run(`Date.now = () => 1800000000000; S.players.me.pumpkins = 3;
      say = async () => {}; choose = async () => 'bye';
      candyGame = async () => {
        S.players.host = { ...S.players.host, guardUntil: Date.now() ${activeAtFinish ? '+' : '-'} 300000 };
        return { won: true, inputs: [], elapsedMs: 6000 };
      };`);
    await g.finish(g.run(`knock(MAP.slots.find((s) => s.owner === 'host'))`));
    assert.equal(g.run(`candiesOf('host')`), activeAtFinish ? 10 : 9);
    assert.equal(g.run(`candiesOf('me')`), activeAtFinish ? 10 : 11);
    assert.equal(g.run('Boolean(S.players.me.knocks.at(-1).protected)'), activeAtFinish);
    // 보호가 끝난 뒤 장부를 다시 계산해도 사탕이 뒤늦게 빠지지 않는다.
    g.run('Date.now = () => 1800000600000; S.ledger = null');
    assert.equal(g.run(`candiesOf('host')`), activeAtFinish ? 10 : 9);
    assert.equal(g.run('wasMoved(S.players.me.knocks.at(-1))'), !activeAtFinish);
  });
}

test('the wardrobe doodle paints only on the body, survives a costume change inside the new body, and hides under poop', () => {
  const g = game(); g.players();
  const pad = g.elements.get('doodle');
  Object.assign(pad, { clientWidth: 160, clientHeight: 160, clientLeft: 0, clientTop: 0, rect: { left: 0, top: 0, width: 160, height: 160 } });
  const cell = (x, y) => ({ pointerId: 1, clientX: x * 10 + 5, clientY: y * 10 + 5 });
  const click = (target) => g.run(`document.listeners.click({ target: { closest: () => (${JSON.stringify(target)}) } })`);
  g.run(`openModal('wardrobe')`);
  click({ id: '', dataset: { dc: '7' } });
  pad.listeners.pointerdown(cell(0, 2));
  pad.listeners.pointermove(cell(7, 2));
  pad.listeners.pointermove(cell(7, 9));
  pad.listeners.pointerup();
  click({ id: 'doodle-save', dataset: {} });
  const saved = g.run('S.players.me.doodle');
  assert.equal(saved.length, 256);
  assert.equal(saved[2 * 16 + 0], '.', 'outside the ghost body nothing is painted');
  assert.equal(saved[2 * 16 + 7], '7');
  assert.equal(saved[9 * 16 + 7], '7');
  assert.equal(g.run(`bodyDoodle(S.players.me.doodle, 'cat')[2 * 16 + 7]`), '.', 'the cat has no body on that cell, so it is hidden');
  assert.equal(g.run(`bodyDoodle(S.players.me.doodle, 'cat')[9 * 16 + 7]`), '7', 'the cat body still shows the shared cell');
  assert.equal(g.run(`doodleSprite('.'.repeat(256), 'ghost')`), null);
  assert.equal(g.run(`doodleSprite(S.players.me.doodle, 'ghost') === doodleSprite(S.players.me.doodle, 'ghost')`), true, 'the sprite is cached');

  g.run(`var drawn = []; ctx.drawImage = (img) => drawn.push(img); var sprite = doodleSprite(S.players.me.doodle, 'ghost');
    var actor = { x: 100, y: 100, f: -1, m: false, walk: 0 };`);
  g.run(`drawActor(actor, 'ghost', '', '', null, false, false, '', sprite)`);
  assert.equal(g.run('drawn.includes(sprite.l) && !drawn.includes(sprite.r)'), true, 'facing left draws the mirrored doodle');
  g.run(`drawn = []; drawActor(actor, 'ghost', '', '', { kind: 'poop' }, false, false, '', sprite)`);
  assert.equal(g.run('drawn.includes(sprite.l) || drawn.includes(sprite.r)'), false, 'under poop the body and its doodle are hidden');

  click({ id: 'doodle-clear', dataset: {} });
  click({ id: 'doodle-save', dataset: {} });
  assert.equal(g.run('S.players.me.doodle'), '.'.repeat(256));
});

test('without a costume the doodle pad does not paint or save', () => {
  const g = game(); g.players();
  g.run(`S.players.me.costume = null; openModal('wardrobe')`);
  const pad = g.elements.get('doodle');
  Object.assign(pad, { clientWidth: 160, clientHeight: 160, rect: { left: 0, top: 0, width: 160, height: 160 } });
  pad.listeners.pointerdown({ pointerId: 1, clientX: 45, clientY: 25 });
  g.run(`document.listeners.click({ target: { closest: () => ({ id: 'doodle-save', dataset: {} }) } })`);
  assert.equal(g.run('S.players.me.doodle'), undefined);
  assert.equal(g.elements.get('doodle-save').disabled, true);
  assert.equal(pad['aria-disabled'], 'true');
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

test('my private document is read once and kept from server answers, and read again only when a harvest finds it stale', async () => {
  const g = game(); g.players();
  g.run(`S.mode = 'firebase'; crypto = { randomUUID: () => 'harvest-request' };
    var reads = 0, stored = { pumpkins: 7, field: [{ id: 'other-tab', s: 0, at: 0 }] };
    S.account = { auth: { currentUser: { uid: 'me', getIdToken: async () => 'token' } }, firestore: {},
      firestoreSdk: { doc: (db, ...path) => path.join('/'), getDoc: async (path) => { reads++; return { exists: () => path === 'gamePrivate/me', data: () => stored }; } } };
    S.ownPlayer = { ...S.players.me, pumpkins: 0 }; S.firebasePlayers = {};
    var answers = []; accountRequest = (url, options) => new Promise((resolve, reject) => answers.push({ body: JSON.parse(options.body), resolve, reject }));`);
  await g.run('reloadPrivate()');
  assert.equal(g.run('reads'), 1);
  assert.equal(g.run('S.players.me.pumpkins'), 7);

  g.run(`S.players.me.field = [{ id: 'ripe', s: 0, at: 0 }]; growPumpkins(0); var picking = harvest(S.pumpkins[0]);`);
  await tick();
  g.run(`answers[0].resolve({ pumpkins: 8, basket: true, field: [{ id: 'next', s: 1, at: Date.now() + 9000 }] })`);
  await g.run('picking');
  g.run('applyFirebasePlayers()');
  assert.equal(g.run('S.players.me.pumpkins'), 8, 'a later village update keeps the count the server answered');
  assert.equal(g.run('S.players.me.field[0].id'), 'next');
  assert.equal(g.run('reads'), 1, 'no extra read after a harvest');

  g.run(`S.players.me.field = [{ id: 'gone', s: 0, at: 0 }]; growPumpkins(0); picking = harvest(S.pumpkins[0]);`);
  await tick();
  g.run(`const gone = new Error('이미 없어진 호박이에요. 다른 호박을 따 주세요.'); gone.status = 409; answers[1].reject(gone);`);
  await g.run('picking');
  await tick();
  assert.equal(g.run('reads'), 2, 'a pumpkin already taken in another tab reloads my private document');
  assert.equal(g.run('S.players.me.field[0].id'), 'other-tab');
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
  assert.equal(next.elements.get('quest').dataset.step, 'brew');
  next.run(`S.players.me.brews = [{ at: 1, n: 2 }]; renderQuest()`);
  assert.equal(next.elements.get('quest').dataset.step, 'compete');
  next.run(`S.event = { startedAt: 1, endsAt: 2 }; renderQuest()`);
  assert.equal(next.elements.get('quest').dataset.step, 'ended');
});

test('the first brew is a quest step, and the next goal then keeps showing the cauldron state', () => {
  const g = game(); g.players();
  g.run(`S.players.me.basket = true; S.players.me.knocks = [{ r: 'lose' }]; S.players.me.pumpkins = 6; renderQuest()`);
  const quest = g.elements.get('quest'), bar = g.elements.get('quest-progress'), detail = () => g.elements.get('quest-detail').textContent;
  assert.equal(quest.dataset.step, 'brew');
  assert.equal(quest.dataset.brew, 'filling');
  assert.equal(bar.hidden, false);
  assert.deepEqual([bar.max, bar.value], [10, 6]);
  assert.equal(g.elements.get('quest-title').textContent, '광장 솥에서 연금술 해 보기 · 6/10');
  assert.match(detail(), /호박 10개를 광장 솥에 넣으면 사탕이 최대\s20개 나와요/);
  g.run('S.players.me.pumpkins = 10; renderQuest()');
  assert.equal(quest.dataset.brew, 'ready');
  assert.equal(bar.hidden, true);
  assert.match(detail(), /호박이 다 모였어요! 광장 솥으로 가세요/);
  g.run(`S.players.me.brewAt = Date.now() - 11 * 60 * 1000; S.players.me.pumpkins = 6; renderQuest()`);
  assert.equal(quest.dataset.step, 'compete');
  assert.equal(quest.dataset.brew, 'filling');
  assert.equal(bar.hidden, false);
  assert.deepEqual([bar.max, bar.value], [10, 6]);
  assert.match(detail(), /친구 집 도전: 성공하면 사탕 \+1\n연금술: 호박 10개를 광장 솥에 넣으면 사탕 최대\s20개\n호박 6\/10/);
  g.run('S.players.me.pumpkins = 10; renderQuest()');
  assert.equal(quest.dataset.brew, 'ready');
  assert.equal(bar.hidden, true);
  assert.match(detail(), /솥이 준비됐어요! 광장 솥으로 가세요/);
  g.run('S.players.me.brewAt = Date.now(); renderQuest()');
  assert.equal(quest.dataset.brew, 'cooling');
  assert.match(detail(), /솥이 식는 중 · 5분 뒤/);
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

const minigames = require('../server/minigames.cjs');
test('the page plans and judges every mini game exactly like the server', () => {
  const g = game();
  for (const name of ['whack', 'spell', 'catch']) {
    for (const seed of [3, 4242, 0xfffffff0]) {
      const level = seed % 5 + 1, plan = minigames.miniPlan(name, level, seed);
      assert.deepEqual(JSON.parse(g.run(`JSON.stringify(miniPlan('${name}', ${level}, ${seed}))`)), JSON.parse(JSON.stringify(plan)));
      const taps = plan.items.slice(0, 6).map((item, i) => ({ t: 400 + i * 360, v: (item.k ?? i) % 3 }));
      assert.deepEqual(JSON.parse(g.run(`JSON.stringify(miniJudge('${name}', miniPlan('${name}', ${level}, ${seed}), ${JSON.stringify(taps)}, 30000))`)),
        JSON.parse(JSON.stringify(minigames.miniJudge(name, plan, taps, 30000))));
    }
  }
});

for (const name of ['whack', 'catch']) {
  test(`a ${name} challenge played on the page sends input the server accepts as a win`, async () => {
    const g = game();
    const challenge = { game: name, level: 1, seed: 77, createdAt: 0 }, plan = minigames.miniPlan(name, 1, 77);
    const result = g.run(`candyGame(${JSON.stringify(challenge)})`);
    assert.equal(g.elements.get('mini').hidden, false);
    assert.equal(g.elements.get('timing').hidden, true, 'the fishing box stays closed');
    let dir = 0, x = .5;
    for (let now = 20; now <= 60000 && g.run('S.miniControl !== null'); now += 20) {
      g.setNow(now);
      if (name === 'whack') {
        const ghost = plan.items.find((item) => !item.bad && item.from + 100 <= now && now < item.from + 120);
        if (ghost) g.run(`S.miniControl.key('${['KeyQ', 'KeyW', 'KeyE', 'KeyA', 'KeyS', 'KeyD', 'KeyZ', 'KeyX', 'KeyC'][ghost.k]}', true, false)`);
      } else {
        const goal = plan.items.find((item) => !item.bad && item.t >= now);
        const want = !goal || Math.abs(goal.x - x) < .02 ? 0 : goal.x < x ? 1 : 2;
        if (want !== dir) {
          if (dir) g.run(`S.miniControl.key('${dir === 1 ? 'ArrowLeft' : 'ArrowRight'}', false)`);
          if (want) g.run(`S.miniControl.key('${want === 1 ? 'ArrowLeft' : 'ArrowRight'}', true)`);
          dir = want;
        }
        x = Math.max(0, Math.min(1, x + (want === 1 ? -1 : want === 2 ? 1 : 0) * plan.speed * .02));
      }
      [...g.frames.values()].at(-1)?.();
    }
    g.fire(0);
    const attempt = await result;
    assert.equal(attempt.won, true);
    assert.equal(g.elements.get('mini').hidden, true);
    const judged = minigames.evaluateChallenge(challenge, attempt.inputs, attempt.elapsedMs, 100000);
    assert.deepEqual([judged.valid, judged.finished, judged.won], [true, true, true]);
  });
}

test('Escape leaves a mini game as a quit', async () => {
  const g = game();
  const result = g.run(`candyGame({ game: 'spell', level: 2, seed: 5 })`);
  g.run(`document.listeners.keydown({ key: 'Escape', code: 'Escape', preventDefault() {}, target: {} })`);
  assert.equal((await result).quit, true);
  assert.equal(g.run('S.miniControl'), null);
});

for (const won of [true, false]) {
  test(`full knock ${won ? 'success takes candy' : 'failure leaves candy but plays a trick'} and announces the result`, async () => {
    const g = game(); g.players();
    const events = [];
    g.window.gameAnalytics = { capture: (event, properties) => events.push({ event, properties }) };
    g.run(`S.players.me.pumpkins = 3; globalThis.messages = [];
      say = async (who, text) => messages.push(text); choose = async () => 'bye';
      candyGame = async () => ({ won: ${won}, inputs: [], elapsedMs: 4200 });`);
    await g.finish(g.run(`knock(MAP.slots.find((s) => s.owner === 'host'))`));
    assert.equal(g.run('candiesOf("me")'), won ? 11 : 10);
    assert.equal(g.run('candiesOf("host")'), won ? 9 : 10);
    assert.equal(g.run('S.busy'), false);
    assert.equal(g.run('S.players.me.knocks.length'), 1);
    assert.match(g.run('messages.join(" ")'), won ? /친구에게서 사탕 1개 가져옴/ : /사탕은 그대로 둬\. 대신 장난이다/);
    if (!won) {
      const kind = g.run('S.players.me.knocks[0].k');
      assert.ok(g.run(`Boolean(TRICKS['${kind}'])`), 'a known trick is recorded');
      assert.equal(g.run('activeFx("me")?.kind'), kind, 'and it is active right away');
      assert.match(g.run('messages.join(" ")'), new RegExp(g.run(`TRICKS['${kind}'].lines[1]`).replace(/[.!?()]/g, '\\$&')));
    }
    assert.equal(g.elements.get('quest').dataset.step, 'brew');
    const completed = events.filter((event) => event.event === 'knock_completed');
    assert.equal(completed.length, 1);
    assert.equal(completed[0].properties.outcome, won ? 'win' : 'lose');
    assert.equal(completed[0].properties.candy_moved, won);
    assert.equal(completed[0].properties.duration_seconds, 4.2);
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
    if (changeRound) g.run(`S.event = { id: 'another-round', startedAt: 1, endsAt: Date.now() + 60000 }`);
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
  const [clientX, clientY] = JSON.parse(g.run('draw(); JSON.stringify(w2s(S.pos.x, S.pos.y))'));
  g.elements.get('world').listeners.pointerdown({ clientX, clientY });
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

test('the village panel stays on screen with online counts and buttons to the other villages', () => {
  const g = game(); village(g);
  g.run(`ghosts.set('near:1', { by: 'near', x: 100, y: 100 });
    S.online = [{ by: 'me', presence: { v: 1 } }, { by: 'near', presence: { v: 1 } }, { by: 'gone', presence: { v: 1 } }, { by: 'far', presence: { v: 2 } }]; renderHud();`);
  assert.equal(g.elements.get('vmap').hidden, false, 'someone still in the online list but not on the map is not counted here');
  const list = g.elements.get('vmap-list').innerHTML;
  assert.match(list, /^<p class="vmap-end">▲ 1번에서 위로 가면 3번<\/p><div class="vmap-node here" aria-current="true"><span>1\. 태초마을 · 여기<\/span><b>2명<\/b><\/div><span class="vmap-link" aria-hidden="true">▼<\/span>/);
  assert.match(list, /data-go="2"><span>2\. 구리마을<\/span><b>1명<\/b><\/button><span class="vmap-link" aria-hidden="true">▼<\/span><button class="vmap-node" type="button" data-go="3">/);
  assert.match(list, /<span>3\. 안드로이드 제국<\/span><b>0명<\/b><\/button><p class="vmap-end">▼ 3번에서 아래로 가면 1번<\/p>$/);
  g.run(`toggleFold('vmap')`);
  assert.equal(g.elements.get('vmap-label').textContent, '마을 지도 · 지금 1. 태초마을');
  g.run(`toggleFold('vmap'); S.mode = 'practice'; renderHud();`);
  assert.equal(g.elements.get('vmap').hidden, true);
});

test('online peers stay hidden until their costume is known instead of showing the plain character', () => {
  const g = game(); village(g);
  g.run(`var list = [
      { by: 'near', peer: 'near:1', kind: 'viewer', presence: { x: 100, y: 100 } },
      { by: 'newcomer', peer: 'newcomer:1', kind: 'viewer', presence: { x: 120, y: 100 } },
    ];
    S.room = { peers: () => list }; lastPeers = null; syncPeers();`);
  assert.deepEqual(JSON.parse(g.run('JSON.stringify([...ghosts.values()].map((x) => [x.by, x.c]))')), [['near', 'witch']]);
  g.run(`S.players.newcomer = { ...blankPlayer(), costume: 'mummy', village: 1 }; list = [...list]; syncPeers();`);
  assert.deepEqual(JSON.parse(g.run('JSON.stringify([...ghosts.values()].map((x) => [x.by, x.c]))')), [['near', 'witch'], ['newcomer', 'mummy']]);
});

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
  assert.doesNotMatch(g.run('guestbookHtml(S.me)'), /사탕 잡기에 성공/);
  const press = (tab) => g.run(`document.listeners.click({ target: { classList: { contains: () => false }, closest: () => ({ id: '', dataset: { bookTab: '${tab}' } }) }, preventDefault() {} })`);
  press('knock');
  assert.equal(g.run('S.bookTab'), 'knock');
  assert.equal((g.elements.get('book').innerHTML.match(/<li>/g) || []).length, 2);
  assert.doesNotMatch(g.elements.get('book').innerHTML, /또 올게/);
  g.run('S.players.me.guests = []; delete S.players.near.knocks; renderHouse()');
  assert.match(g.elements.get('book').innerHTML, /아직 문을 두드린 사람이 없어요/);
  press('note');
  assert.match(g.elements.get('book').innerHTML, /아직 남긴 글이 없어요/);
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
  assert.match(g.run('eventLine()'), /내 순위 2명 중 2등/);
  assert.match(g.elements.get('rk-list').innerHTML, /먼집/);
  g.run(`closeModal('rank'); openModal('rank')`);
  await tick();
  assert.equal(g.run('calls.length'), 1, 'reopening right away reuses the list');
});

test('roulette rankings use a new cache address and discard an older in-flight response', async () => {
  const g = game(); village(g);
  g.run(`var calls = [], finishOld;
    S.event = { id: 'r1', startedAt: 1, endsAt: Date.now() + 60000 };
    S.rankAt = 0; S.rankList = null;
    accountRequest = (url) => {
      calls.push(url);
      if (calls.length === 1) return new Promise(resolve => { finishOld = resolve; });
      return Promise.resolve({ players: [{ id: 'me', nick: '나', costume: 'ghost', n: 30 }] });
    };
    loadRanking();
    S.event.roulette = { id: '11111111-1111-4111-8111-111111111111' };
    loadRanking({ quiet: true });
    finishOld({ players: [{ id: 'me', nick: '나', costume: 'ghost', n: 10 }] });`);
  await tick(); await tick();
  assert.equal(g.run('calls.length'), 2);
  assert.equal(g.run('calls[1]'), '/api/game/leaderboard?roulette=11111111-1111-4111-8111-111111111111');
  assert.equal(g.run('ranking()[0].n'), 30);
  assert.equal(g.run('S.rankLoading'), false);
});

test('chat reaches every village but shows a bubble only for people in the same village', () => {
  const g = game(); village(g);
  g.run(`onChat({ data: { text: '옆 마을 안녕', v: 2 }, by: 'far', peer: 'far:tab' });
    onChat({ data: { text: '여기 안녕', v: 1 }, by: 'near', peer: 'near:tab' });`);
  assert.equal(g.run(`chatBubbles.has('far:tab')`), false);
  assert.equal(g.run(`chatBubbles.has('near:tab')`), true);
  const log = g.elements.get('chatlog').innerHTML;
  assert.match(log, /<small class="where">\[구리마을\]<\/small><b>먼집<\/b>옆 마을 안녕/);
  assert.match(log, /<b>이웃<\/b>여기 안녕/);
});

test('the chat window keeps history in time order, pages older lines in, and filters to this village', () => {
  const g = game(); village(g);
  g.run(`onChat({ data: { id: 'c3', text: '셋', v: 1, at: 300 }, by: 'near', peer: 'near:tab' });
    chatHistory.more = true;
    addChat([{ id: 'c1', by: 'far', v: 2, text: '하나', at: 100 }, { id: 'c2', by: 'near', v: 1, text: '둘', at: 200 }, { id: 'c3', by: 'near', v: 1, text: '셋', at: 300 }], { older: true });`);
  const log = () => g.elements.get('chatlog').innerHTML;
  assert.equal(g.elements.get('chatbox').hidden, false);
  assert.match(log(), /^<p class="more">위로 올리면 이전 채팅을 불러와요<\/p><p><small class="where">\[구리마을\]<\/small><b>먼집<\/b>하나<\/p><p><b>이웃<\/b>둘<\/p><p><b>이웃<\/b>셋<\/p>$/);
  const press = (dataset) => g.run(`document.listeners.click({ target: { classList: { contains: () => false }, closest: () => (${JSON.stringify({ id: '', dataset })}) }, preventDefault() {} })`);
  press({ chatTab: 'here' });
  assert.doesNotMatch(log(), /하나/);
  assert.match(log(), /둘.*셋/);
  press({ chatTab: 'all' });
  assert.match(log(), /하나/);
  g.run(`toggleFold('chat')`);
  assert.equal(g.elements.get('chatbox').classList.contains('folded'), true);
});

test('my own lines stand out, and opening chat shows the input inside the chat window even when folded or empty', () => {
  const g = game(); village(g);
  g.run(`toggleFold('chat'); openChat();`);
  assert.equal(g.elements.get('chatbox').hidden, false, 'the window opens for the input even with no chat yet');
  assert.equal(g.elements.get('chatbox').classList.contains('folded'), false, 'a folded window unfolds');
  assert.equal(g.elements.get('chatbar').hidden, false);
  g.run(`closeChat()`);
  assert.equal(g.elements.get('chatbox').hidden, true, 'an empty window hides again');
  g.run(`onChat({ data: { id: 'm1', text: '내 말', v: 1, at: 1 }, by: 'me', sameTab: true, peer: 'me:tab' })`);
  assert.match(g.elements.get('chatlog').innerHTML, /<p class="mine"><b>나<\/b>내 말<\/p>/);
});

test('a new chat line is appended without redrawing the history, and trimming keeps the place to page from', () => {
  const g = game(); village(g);
  const box = g.elements.get('chatlog');
  g.run(`onChat({ data: { id: 'a1', text: '처음', v: 1, at: 100 }, by: 'near', peer: 'near:tab' })`);
  box.innerHTML += '<i>그대로</i>';
  g.run(`onChat({ data: { id: 'a2', text: '다음', v: 1, at: 200 }, by: 'near', peer: 'near:tab' })`);
  assert.match(box.innerHTML, /<i>그대로<\/i><p><b>이웃<\/b>다음<\/p>$/, 'only the new line is added');

  const lines = (from, count) => `Array.from({ length: ${count} }, (_, i) => ({ id: '-T' + String(${from} + i).padStart(18, '0'), by: 'near', v: 1, text: 'x', at: 1000 + ${from} + i }))`;
  box.scrollHeight = 5000; box.scrollTop = 0;
  g.run(`addChat(${lines(0, 1101)})`);
  assert.equal(g.run('chatLog.length'), 1103, 'nothing is dropped while reading older lines');
  box.scrollTop = 5000;
  g.run(`addChat(${lines(1101, 1)})`);
  assert.equal(g.run('chatLog.length'), 1000);
  assert.equal(g.run('chatHistory.oldest'), '-T' + String(102).padStart(18, '0'), 'the next page starts right before the first line kept');
  assert.equal(g.run('chatHistory.more'), true);
});

test('the village map lists villages top to bottom in sign order and travels to the chosen one', async () => {
  const g = game(); village(g);
  g.run(`ghosts.set('near:1', { by: 'near', x: 100, y: 100 }); S.online = [
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

test('the three o\'clock refill is announced once per device after reconnecting, and waits for other dialogs', async () => {
  const storage = memoryStorage();
  const g = game({ storage }); g.players();
  g.run(`globalThis.messages = []; say = async (who, text) => messages.push(text);`);
  await g.finish(g.run('refillNotice()'));
  assert.equal(g.run('messages.length'), 0, 'no refill, no popup');

  g.run(`S.players.me.refill = { id: 'refill-1031-1500', at: 1, n: 7 }; S.busy = true;`);
  const notice = g.run('refillNotice()');
  await tick();
  assert.equal(g.run('messages.length'), 0, 'it waits while another dialog is open');
  g.run('S.busy = false');
  await g.finish(notice);
  assert.match(g.run('messages[0]'), /3시 사탕 보충! 사탕을 10개까지 채워 드렸어요\. \(\+7\)/);
  assert.equal(g.run('S.busy'), false);
  await g.finish(g.run('refillNotice()'));
  assert.equal(g.run('messages.length'), 1, 'shown once on this device');

  const other = game({ storage: memoryStorage() }); other.players();
  other.run(`globalThis.messages = []; say = async (who, text) => messages.push(text); S.players.me.refill = { id: 'refill-1031-1500', at: 1, n: 10 };`);
  await other.finish(other.run('refillNotice()'));
  assert.equal(other.run('messages.length'), 1, 'another device shows it once too');
});

test('basket stays after harvesting more, alchemy tip explains the cauldron, and the bag caps at 100', async () => {
  const g = game(); g.players();
  g.run(`globalThis.messages = []; say = async (who, text) => messages.push(text);`);
  for (let i = 0; i < 3; i++) g.run('S.pumpkins = [{ x: 32, y: 32 }]; harvest(S.pumpkins[0])');
  await g.finish(g.run('alchemyTips()'));
  assert.equal(g.run('S.players.me.basket'), true);
  assert.match(g.run('messages.join(" ")'), /10개를 모아 광장 가운데 마녀 솥/);
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

test('a newcomer notice goes to everyone else and the chat window, once', () => {
  const g = game(); village(g);
  g.run(`announceNewcomer('j1', { kind: 'join', uid: 'new1', nick: '새친구', v: 2, at: 1 })`);
  assert.equal(g.elements.get('toast').textContent, '새 크루 새친구님이 구리마을에 이사 왔어요! 반갑게 맞아 주세요');
  g.run(`announceNewcomer('j1', { kind: 'join', uid: 'new1', nick: '새친구', v: 2, at: 1 }); announceNewcomer('j2', { kind: 'join', uid: 'me', nick: '나', v: 1, at: 2 })`);
  const chat = g.elements.get('chatlog').innerHTML;
  assert.equal((chat.match(/새 크루 새친구님이 구리마을에 이사 왔어요!/g) || []).length, 1);
  assert.match(chat, /<b>마을 소식<\/b>/);
  assert.doesNotMatch(chat, /새 크루 나님이/, 'the newcomer gets the welcome guide instead');
});

test('every brew shows in the top notice one at a time, and a jackpot stays longer and also goes to the chat window', async () => {
  const g = game(); village(g);
  const notice = g.elements.get('toast'), chat = () => g.elements.get('chatlog').innerHTML;
  g.run(`announceBrew('k1', { kind: 'brew', uid: 'me', nick: '나', n: 2, at: 1 })`);
  assert.equal(notice.hidden, false);
  assert.equal(notice.textContent, '내가 연금술로 사탕 2개를 받았어요 · 광장 솥에 호박 10개');
  assert.doesNotMatch(chat(), /마녀 솥/, 'small brews stay out of the chat');
  g.run(`announceBrew('k2', { kind: 'brew', uid: 'far', nick: '먼집', n: 20, at: 2 }); announceBrew('k2', { kind: 'brew', uid: 'far', nick: '먼집', n: 20, at: 2 })`);
  assert.equal(notice.textContent, '내가 연금술로 사탕 2개를 받았어요 · 광장 솥에 호박 10개', 'the next one waits its turn');
  g.fire(3000); await tick();
  assert.equal(notice.textContent, '대박! 먼집님이 연금술로 사탕 20개를 뽑았어요! 광장 솥에 호박 10개를 넣어 보세요');
  assert.equal((chat().match(/먼집님이 연금술로 사탕 20개 대박!/g) || []).length, 1, 'shown once even if delivered twice');
  g.fire(5000); await tick();
  assert.equal(notice.hidden, true, 'a jackpot stays for five seconds, then the notice clears');
});

test('brewing spends ten pumpkins, adds rolled candy, keeps the basket and cools down', async () => {
  const g = game(); g.players();
  g.run(`globalThis.messages = []; say = async (who, text) => messages.push(text); Math.random = () => 0.5;
    S.players.me.pumpkins = 5; S.players.me.basket = true; S.nearCauldron = true; renderAction();`);
  assert.equal(g.elements.get('act-btn').disabled, true);
  assert.equal(g.elements.get('act-sub').textContent, '호박 10개를 넣으면 사탕 +2 · 사탕 +5 · 사탕 +10 · 사탕 +20 중 하나');
  g.run('S.players.me.pumpkins = 60; renderAction()');
  assert.equal(g.elements.get('act-btn').disabled, false);
  assert.match(g.elements.get('act-title').textContent, /마녀 솥 · 호박 60\/10/);
  await g.finish(g.run('brew()'));
  assert.equal(g.run('candiesOf("me")'), 12);
  assert.equal(g.run('S.players.me.pumpkins'), 50);
  assert.equal(g.run('hasBasket("me")'), true);
  assert.match(g.run('messages.join(" ")'), /사탕 2개가 떠올랐어요/);
  g.run('S.players.me.pumpkins = 60; S.nearCauldron = true; renderAction()');
  assert.equal(g.elements.get('act-btn').disabled, true);
  assert.match(g.elements.get('act-sub').textContent, /식는 중 · 5분 뒤/);
  await g.finish(g.run('brew()'));
  assert.equal(g.run('candiesOf("me")'), 12);
  assert.match(g.elements.get('toast').textContent, /식는 중/);
});

test('an online harvest picks a server-planted pumpkin, shows at once, and rolls back if the server refuses', async () => {
  const g = game(); g.players();
  g.run(`S.mode = 'firebase'; crypto = { randomUUID: () => 'harvest-request' };
    S.account = { auth: { currentUser: { uid: 'me', getIdToken: async () => 'token' } } };
    var sent = [], answer; accountRequest = (url, options) => { sent.push(JSON.parse(options.body)); return new Promise((resolve, reject) => { answer = { resolve, reject }; }); };
    S.players.me.field = [{ id: 'ripe1', s: 0, at: 0 }, { id: 'ripe2', s: 0, at: 0 }, { id: 'later', s: 5, at: Date.now() + 60000 }];
    growPumpkins(0);`);
  assert.equal(g.run('JSON.stringify(S.pumpkins.map((p) => p.id))'), '["ripe1","ripe2"]', 'only grown pumpkins show, on separate tiles');
  assert.notEqual(g.run('`${S.pumpkins[0].tx},${S.pumpkins[0].ty}`'), g.run('`${S.pumpkins[1].tx},${S.pumpkins[1].ty}`'));
  g.run('var first = harvest(S.pumpkins[0]); growPumpkins(0);');
  await tick();
  assert.equal(g.run('sent[0].pumpkin'), 'ripe1');
  assert.equal(g.run('S.pumpkins.length'), 1, 'the pumpkin disappears before the server answers');
  assert.equal(g.run('S.players.me.pumpkins'), 1);
  assert.equal(g.run('S.floats.some((f) => f.text === "호박 +1")'), true);
  g.run(`answer.resolve({ pumpkins: 1, basket: false, field: [{ id: 'ripe2', s: 0, at: 0 }, { id: 'later', s: 5, at: Date.now() + 60000 }] })`);
  await g.run('first');
  g.run(`S.players.me.field = [{ id: 'ripe1', s: 0, at: 0 }, ...S.players.me.field]; growPumpkins(0);`);
  assert.equal(g.run('JSON.stringify(S.pumpkins.map((p) => p.id))'), '["ripe2"]', 'a late snapshot cannot bring the picked pumpkin back');

  g.run('var second = harvest(S.pumpkins[0]); growPumpkins(0);');
  await tick();
  assert.equal(g.run('S.players.me.pumpkins'), 2);
  assert.equal(g.run('S.pumpkins.length'), 0);
  g.run(`const refused = new Error('조금 뒤 다른 호박을 따 주세요.'); refused.status = 429; answer.reject(refused);`);
  await g.run('second');
  g.run('growPumpkins(0)');
  assert.equal(g.run('S.players.me.pumpkins'), 1, 'a refused harvest is taken back');
  assert.equal(g.run('JSON.stringify(S.pumpkins.map((p) => p.id))'), '["ripe2"]', 'and the pumpkin returns');
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

test('crew finder searches by nickname apart from the ranking and walks you to that house, crossing villages when needed', async () => {
  const g = game(); g.players();
  g.run(`S.players.c3 = { ...blankPlayer(), nick: '호박도둑', costume: 'cat', joinedAt: 3 }; render(); openModal('rank');`);
  assert.doesNotMatch(g.elements.get('rk-list').innerHTML, /data-visit/, 'the ranking stays a plain ranking');
  g.run(`closeModal('rank')`);
  g.elements.get('cr-search').value = '도둑';
  g.run(`openModal('crew')`);
  const found = g.elements.get('cr-list').innerHTML;
  assert.match(found, /호박도둑/);
  assert.doesNotMatch(found, /친구/);
  assert.match(g.elements.get('cr-sub').textContent, /크루 3명/);
  g.run(`document.listeners.click({ target: { classList: { contains: () => false }, closest: () => ({ dataset: { visit: 'c3' } }) }, preventDefault() {} })`);
  await tick();
  assert.equal(g.elements.get('crew').hidden, true);
  assert.deepEqual(JSON.parse(g.run('JSON.stringify([S.pos.x, S.pos.y])')), JSON.parse(g.run('JSON.stringify([doorOf("c3").x, doorOf("c3").y])')));
  g.elements.get('cr-search').value = '없는사람';
  g.run(`openModal('crew')`);
  assert.match(g.elements.get('cr-list').innerHTML, /그런 닉네임의 크루가 없어요/);

  const v = game(); village(v);
  v.run(`S.rankAt = Date.now(); S.rankList = [{ id: 'far', nick: '먼집', costume: 'cat', n: 12, village: 2 }, { id: 'me', nick: '나', costume: 'ghost', n: 9, village: 1 }];
    var entered = []; S.room = { peers: () => [], presence: async () => {}, enterVillage: async (n) => { entered.push(n); S.village = n; } };
    S.online = [{ by: 'far', presence: { v: 2 } }]; openModal('crew');`);
  assert.match(v.elements.get('cr-list').innerHTML, /aria-label="접속 중" title="접속 중"><\/span><b>먼집<\/b><small>구리마을<\/small>/);
  assert.match(v.elements.get('cr-list').innerHTML, /<div><b>나<\/b>/);
  assert.match(v.elements.get('cr-list').innerHTML, /data-visit="far">집 가기/);
  assert.match(v.elements.get('cr-list').innerHTML, /data-visit="me">우리 집/);
  v.run(`visitHouse('far')`);
  v.fire(300); await tick(); await tick();
  v.fire(200); await tick();
  assert.equal(v.run('JSON.stringify(entered)'), '[2]');
  assert.deepEqual(JSON.parse(v.run('JSON.stringify([S.pos.x, S.pos.y])')), JSON.parse(v.run('JSON.stringify([doorOf("far").x, doorOf("far").y])')));
});

test('the rank board shows the top three and my place, and the board and quest fold and unfold', () => {
  const g = game(); g.players();
  g.run(`S.players.c3 = { ...blankPlayer(), nick: '셋째', costume: 'cat', joinedAt: 3 };
    S.players.c4 = { ...blankPlayer(), nick: '넷째', costume: 'mummy', joinedAt: 4 }; render();`);
  assert.equal(g.elements.get('board').hidden, false);
  assert.equal((g.elements.get('board-list').innerHTML.match(/<li/g) || []).length, 3);
  assert.match(g.elements.get('board-me').textContent, /나 4명 중 \d등 · 사탕 10개/);
  const press = (button) => g.run(`document.listeners.click({ target: { classList: { contains: () => false }, closest: () => (${JSON.stringify(button)}) }, preventDefault() {} })`);
  press({ id: '', dataset: { fold: 'board' } });
  assert.equal(g.elements.get('board').classList.contains('folded'), true);
  assert.match(g.elements.get('board-label').textContent, /사탕 순위 · 4명 중 \d등/);
  press({ id: '', dataset: { fold: 'board' } });
  assert.equal(g.elements.get('board').classList.contains('folded'), false);
  assert.equal(g.elements.get('board-label').textContent, '사탕 순위 TOP 3');
  g.run(`const mode = S.mode; S.mode = 'firebase'; S.rankList = [{ id: 'me', n: 10, costume: 'pumpkin' }]; renderBoard(); S.mode = mode`);
  assert.equal(g.elements.get('board-label').textContent, '사탕 순위 TOP 3 (1분마다 갱신)');
  press({ id: '', dataset: { fold: 'quest' } });
  assert.equal(g.elements.get('quest').classList.contains('folded'), true);
  assert.match(g.elements.get('quest-label').textContent, /진행 중인 퀘스트 · 호박 바구니 만들기/);
  press({ id: 'board-open', dataset: {} });
  assert.equal(g.elements.get('rank').hidden, false);

  const v = game(); village(v);
  v.run(`S.rankList = null; renderHud();`);
  assert.equal(v.elements.get('board').hidden, true, 'online board waits for the server list');
  v.run(`S.rankList = [{ id: 'far', nick: '먼집', costume: 'cat', n: 12, village: 2 }, { id: 'me', nick: '나', costume: 'ghost', n: 9, village: 1 }]; renderHud();`);
  assert.match(v.elements.get('board-list').innerHTML, /1\. 먼집<\/span><b>12개/);
  assert.match(v.elements.get('board-me').textContent, /나 2명 중 2등 · 사탕 9개/);
});

test('the home button brings me back to my own door from another house or another village first', async () => {
  const g = game(); g.players();
  g.run(`S.pos.x = 30; S.pos.y = 30;`);
  await g.run('goHome()');
  assert.deepEqual(JSON.parse(g.run('JSON.stringify([S.pos.x, S.pos.y])')), JSON.parse(g.run('JSON.stringify([doorOf("me").x, doorOf("me").y])')));
  assert.equal(g.elements.get('house').hidden, false);

  const v = game(); village(v);
  v.run(`S.village = 2; render();
    var entered = []; S.room = { peers: () => [], presence: async () => {}, enterVillage: async (n) => { entered.push(n); S.village = n; } };`);
  const home = v.run('goHome()');
  v.fire(300); await tick(); await tick();
  v.fire(200); await tick();
  await home;
  assert.equal(v.run('JSON.stringify(entered)'), '[1]');
  assert.deepEqual(JSON.parse(v.run('JSON.stringify([S.pos.x, S.pos.y])')), JSON.parse(v.run('JSON.stringify([doorOf("me").x, doorOf("me").y])')));
  assert.equal(v.elements.get('house').hidden, false);
});

test('the rank window refreshes the event buttons without opening the crew finder', () => {
  const g = game(); g.players();
  g.run(`S.mode = 'firebase'; S.isOwner = true; S.event = { id: 'r1', startedAt: 1, endsAt: Date.now() - 1000 }; renderRanking();`);
  assert.equal(g.elements.get('rk-admin').hidden, false);
  assert.equal(g.elements.get('ev-stop').textContent, '결과 확정');
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

test('the speaker button shows a crossed-out speaker only when music and effects are both off', () => {
  const g = game();
  g.run(`var icons = []; const realSprite = spriteUrl; spriteUrl = (key, scale) => (icons.push(key), realSprite(key, scale));`);
  g.run(`setSound('sfx', false)`);
  g.run(`setSound('bgm', true)`);
  g.run(`setSound('bgm', false)`);
  assert.deepEqual(JSON.parse(g.run('JSON.stringify(icons)')), ['speakerOff', 'speaker', 'speakerOff']);
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

test('the admin special-accounts view lists the numbers and flags and opens the account on request', async () => {
  const g = game(); g.players();
  g.run(`S.mode = 'firebase'; S.isOwner = true; openModal('admin');
    S.account = { auth: { currentUser: { uid: 'me', getIdToken: async () => 'token' } } };
    var urls = []; accountRequest = async (url) => { urls.push(url); return url.includes('view=watch')
      ? { users: [{ id: 'b'.repeat(32), nick: '<봇>', banned: false, tries: 24, wins: 23, winRate: 23 / 24, avgWinMs: 4550, fastestWinMs: 4000,
          candy: { knocks: 23, brews: 5, decor: -2, lost: -1, net: 25 }, harvests: 30, activeHours: 24,
          topSource: { id: 'a'.repeat(32), nick: '부계정', wins: 12, share: .5 }, flags: ['성공률 높음', '오래 쉬지 않음'] }] }
      : { users: [] }; };
    var watched = loadAdminWatch();`);
  await g.run('watched');
  const html = g.elements.get('ad-results').innerHTML;
  assert.equal(g.run('urls[0]'), '/api/game/admin?view=watch');
  assert.match(html, /&lt;봇&gt;/);
  assert.match(html, /성공률 96%/);
  assert.match(html, /최단 4\.0초/);
  assert.match(html, /사탕 \+25 \(노크 \+23, 연금술 \+5, 장식 -2, 아이템 0, 털림 -1\)/);
  assert.match(html, /부계정에게서 12번/);
  assert.match(html, /<small class="flag">성공률 높음<\/small>/);
  g.run(`var opened = inspectAdminTarget('${'b'.repeat(32)}')`);
  await g.run('opened');
  assert.equal(g.run('urls[1]'), `/api/game/admin?q=${'b'.repeat(32)}`);
});

test('a ban during play disconnects and returns to the login screen with the reason', async () => {
  const g = game(); g.players();
  g.run(`S.mode = 'firebase'; var calls = []; crypto = { randomUUID: () => 'banned-request' };
    S.account = { auth: { currentUser: { uid: 'me', getIdToken: async () => 'token' } }, authSdk: { signOut: async () => { calls.push('signout'); } },
      dispose: async () => { calls.push('dispose'); } };
    fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: 'account-banned', message: '이 계정은 게임 이용이 제한됐어요. 운영자에게 문의해 주세요.' }) });
    var request = gameRequest({ type: 'harvest', pumpkin: 'p1' }).catch((error) => error.status);`);
  assert.equal(await g.run('request'), 403);
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
  assert.equal(g.run('JSON.stringify(calls)'), '["dispose","signout"]');
  assert.equal(g.run('S.me'), null);
  assert.equal(g.elements.get('auth').hidden, false);
  assert.match(g.elements.get('auth-error').textContent, /이용이 제한/);
});

test('the candy game counts down the remaining time and ends as a timeout at ninety seconds', async () => {
  const g = game();
  // 사탕이 막대 안팎을 오가며 게이지가 끝나지 않는 경로
  const result = g.run(`candyGame({ level: 1, path: [{ t: 0, y: 1 }, ...Array.from({ length: 63 }, (_, i) => ({ t: (i + 1) * 1440, y: i % 2 ? 1 : .47 }))] })`);
  const level = g.elements.get('t-level');
  assert.equal(level.textContent, '난이도 1단계 · 남은 시간 90초');
  for (let now = 1000; now <= 100000 && g.run('S.candyControl !== null'); now += 1000) {
    g.setNow(now);
    [...g.frames.values()].at(-1)?.();
    if (now === 30000) {
      assert.equal(level.textContent, '난이도 1단계 · 남은 시간 60초');
      assert.equal(level.classList.contains('hurry'), false);
    }
    if (now === 85000) assert.equal(level.classList.contains('hurry'), true, 'the last ten seconds stand out');
  }
  assert.equal(level.textContent, '난이도 1단계 · 남은 시간 0초');
  assert.equal(g.elements.get('t-result').textContent, '시간 초과!');
  g.fire(0);
  const attempt = await result;
  assert.equal(attempt.won, false);
  assert.equal(attempt.elapsedMs, 90000);
});

test('my pumpkins and field come from my private document, not the stale public one', () => {
  const { run } = game();
  run(`S.me = 'u1'; S.firebasePlayers = {};
    S.ownPlayer = { ...blankPlayer(), nick: '나', costume: 'cat', pumpkins: 2, basket: true };
    S.ownPrivate = { pumpkins: 41, field: [{ id: 'p1', s: 3, at: 0 }] };
    applyFirebasePlayers();`);
  assert.equal(run('S.players.u1.pumpkins'), 41);
  assert.equal(run('S.players.u1.field[0].id'), 'p1');
  run(`S.ownPrivate = null; applyFirebasePlayers();`);
  assert.equal(run('S.players.u1.pumpkins'), 2, 'before the private document arrives the public value is used');
});

test('a scheduled event shows its start time, stays practice until then, and turns into the event by itself', () => {
  const g = game(); g.players();
  g.run(`S.mode = 'firebase'; S.players.me.round = 'practice'; S.players.me.candies = 14;
    S.event = { id: 'halloween', startedAt: Date.now() + 2 * 3600000, endsAt: Date.now() + 16 * 3600000 }; noticeEventTurn();`);
  assert.equal(g.run('eventState()'), 'before');
  assert.equal(g.run('currentRound()'), 'practice');
  assert.equal(g.run('candiesOf("me")'), 14, 'practice candy still counts before the start');
  assert.match(g.run('eventLine()'), /시작 \(1:59:\d\d 남음\) · 연습 중|시작 \(2:00:00 남음\) · 연습 중/);
  g.run(`S.event = { ...S.event, startedAt: Date.now() - 1 }; noticeEventTurn();`);
  assert.equal(g.run('eventState()'), 'running');
  assert.equal(g.run('candiesOf("me")'), 10, 'everyone starts the event with ten');
  assert.match(g.elements.get('toast').textContent, /이벤트 시작/);
  g.run(`S.event = { ...S.event, endsAt: Date.now() - 1 }; noticeEventTurn();`);
  assert.equal(g.run('eventState()'), 'ended');
  assert.match(g.elements.get('toast').textContent, /이벤트가 끝났어요/);
});


test('Escape and the exit button cancel immediately and use actual elapsed time when frames stall', async () => {
  for (const exit of ['escape', 'button', 'button-key']) {
    const g = game();
    const result = g.run('candyGame({ level: 3, seed: 42 })');
    g.setNow(5000);
    if (exit === 'escape') g.run(`document.listeners.keydown({ key: 'Escape', code: 'Escape', target: null, preventDefault() {} })`);
    else if (exit === 'button') g.elements.get('t-exit').listeners.click();
    else g.run(`document.listeners.keydown({ key: 'Enter', code: 'Enter', target: { id: 't-exit' }, preventDefault() {} })`);
    const attempt = await result;
    assert.equal(attempt.quit, true);
    assert.equal(attempt.elapsedMs, 5000);
    assert.equal(g.elements.get('timing').hidden, true);
    assert.equal(g.run('S.candyControl'), null);
    assert.equal(g.frames.size, 0);
  }
});

for (const elapsed of [4999, 5000, 5001]) {
  test(`leaving after ${elapsed}ms preserves the house level and applies only the required penalty`, async () => {
    const g = game(); g.players();
    g.run(`S.players.me.basket = true;
      S.localKnockStreaks = { challenger: 'me', round: currentRound(), byHost: { host: 3 } };
      candyGame = async () => ({ quit: true, elapsedMs: ${elapsed} });
      say = async () => { throw new Error('Exiting must return directly to the village'); };`);
    await g.finish(g.run(`knock(MAP.slots.find((s) => s.owner === 'host'))`));
    assert.equal(g.run('S.localKnockStreaks.byHost.host'), 3);
    assert.equal(g.run('candiesOf("me")'), 10);
    assert.equal(g.run('candiesOf("host")'), 10);
    assert.equal(g.run('S.busy'), false);
    assert.equal(g.run('S.players.me.knocks.length'), elapsed >= 5000 ? 1 : 0);
    assert.equal(g.run('Boolean(activeFx("me"))'), elapsed >= 5000);
  });
}

test('online exits settle through the leave action and display the server penalty decision', async () => {
  for (const penalized of [false, true]) {
    const g = game(); g.players();
    g.run(`S.mode = 'firebase'; S.players.me.basket = true; globalThis.calls = [];
      gameRequest = async (input) => {
        calls.push(input.type);
        if (input.type === 'knock-start') return { challenge: { id: 'challenge', level: 3 } };
        if (input.type !== 'knock-leave') throw new Error('Wrong settlement');
        return { penalized: ${penalized}, elapsedMs: 6000, candies: 10,
          entry: { h: 'host', r: 'lose', at: Date.now(), round: currentRound(), k: 'slow', moved: false } };
      };
      candyGame = async () => ({ quit: true, elapsedMs: 0 });`);
    await g.finish(g.run(`knock(MAP.slots.find((s) => s.owner === 'host'))`));
    assert.deepEqual(Array.from(g.run('calls')), ['knock-start', 'knock-leave']);
    assert.equal(g.run('Boolean(activeFx("me"))'), penalized);
    assert.equal(g.run('S.busy'), false);
  }
});
