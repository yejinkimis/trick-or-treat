const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Run the real service against isolated transaction storage; never connect to Firebase.
function fixture() {
  const filename = path.join(__dirname, '../server/game-service.cjs');
  const localRequire = createRequire(filename), state = new Map();
  const event = { id: 'round', startedAt: Date.now() - 1000, endsAt: Date.now() + 600000 };
  state.set('game/event', event);
  const player = (id, candies) => state.set(`gamePlayers/${id}`, { nick: id, costume: 'ghost', round: event.id, candies });
  player('admin', 10); player('duelist', 0); player('peer', 0); player('empty', 0);
  state.set('gamePrivate/admin', { pumpkins: 0, receipts: [], activity: [] });
  state.set('gameDuels/duel', { status: 'active', round: event.id, players: ['duelist', 'peer'], stake: 10 });
  let playerReads = 0;
  const snapshot = (key) => ({ id: key.split('/').at(-1), exists: state.has(key), data: () => structuredClone(state.get(key)) });
  const collection = (name, filter = () => true) => ({
    doc: (id) => ref(`${name}/${id}`),
    where: (field, op, value) => collection(name, data => data[field] === value),
    async get() {
      if (name === 'gamePlayers') playerReads++;
      return { docs: [...state.keys()].filter(key => key.startsWith(name + '/') && filter(state.get(key))).map(snapshot) };
    },
  });
  const ref = (key) => ({ key, get: async () => snapshot(key) });
  const db = {
    doc: ref, collection,
    async runTransaction(callback) {
      const writes = [];
      const result = await callback({
        get: target => target.get(),
        update: (target, patch) => writes.push(() => state.set(target.key, { ...state.get(target.key), ...structuredClone(patch) })),
        set: (target, value) => writes.push(() => state.set(target.key, structuredClone(value))),
      });
      writes.forEach(write => write());
      return result;
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process: { env: { GAME_ADMIN_UIDS: 'admin' } },
    require(name) {
      if (name === './firebase-admin.cjs') return { services: () => ({ db }) };
      if (name === './auth-service.cjs') return { authenticatedUid: async uid => uid };
      return localRequire(name);
    },
  }, { filename });
  return { service: module.exports, state, player, event, reads: () => playerReads };
}

test('roulette includes escrow in rank and zero eligibility, but pays only the rolled award', async () => {
  const f = fixture();
  const input = { type: 'rank-roulette', requestId: 'roulette-request-1' };
  await f.service.action('admin', input);
  const duelist = f.state.get('gamePlayers/duelist'), empty = f.state.get('gamePlayers/empty');
  assert.equal(duelist.roulette.tier, 'top', 'ten escrowed candies tie the admin, rather than qualifying for zero relief');
  assert.equal(duelist.roulette.rank, 2);
  assert.equal(duelist.roulette.before, 0);
  assert.equal(duelist.candies, duelist.roulette.award, 'escrow must not be paid back by roulette');
  assert.equal(empty.roulette.tier, 'zero');
  assert.ok(empty.roulette.award >= 10);
  await f.service.action('admin', input);
  assert.equal(f.state.get('gamePlayers/duelist').candies, duelist.candies);
  await assert.rejects(f.service.action('admin', { ...input, requestId: 'roulette-request-2' }), /이미 끝났/);
});

test('roulette ignores stakes from other rounds and preserves admin/event guards', async () => {
  const f = fixture(), input = { type: 'rank-roulette', requestId: 'roulette-request-1' };
  f.state.get('gameDuels/duel').round = 'old';
  await assert.rejects(f.service.action('duelist', input), e => e.status === 403);
  f.state.get('game/event').startedAt = Date.now() + 60000;
  await assert.rejects(f.service.action('admin', input), /진행 중인/);
  f.state.get('game/event').startedAt = Date.now() - 1000;
  await f.service.action('admin', input);
  assert.equal(f.state.get('gamePlayers/duelist').roulette.tier, 'zero');
});

test('roulette versions bypass old server ranking caches and reject arbitrary versions before reading players', async () => {
  const f = fixture(), now = Date.now();
  const old = await f.service.leaderboard(now);
  assert.equal(old.players.find(p => p.id === 'admin').n, 10);
  const id = '11111111-1111-4111-8111-111111111111';
  f.state.get('game/event').roulette = { id };
  f.player('admin', 30);
  const fresh = await f.service.leaderboard(now + 1, id);
  assert.equal(fresh.players.find(p => p.id === 'admin').n, 30);
  assert.equal(fresh.rouletteId, id);
  assert.equal(await f.service.leaderboard(now + 2, id), fresh);
  const reads = f.reads();
  await assert.rejects(f.service.leaderboard(now + 3, 'invalid-version'), /룰렛 순위/);
  assert.equal(f.reads(), reads);
});

test('all roulette tiers retain the exact jackpot chance and zero never misses', () => {
  const { service } = fixture();
  for (const tier of Object.keys(service.ROULETTE_ODDS)) {
    let jackpots = 0;
    for (let roll = 0; roll < 100000; roll++) {
      const award = service.rouletteGain(tier, roll);
      if (award === 100) jackpots++;
      if (tier === 'zero') assert.ok(award >= 10);
    }
    assert.equal(jackpots, 50);
  }
});

test('ranking API accepts only the current roulette cache version', async () => {
  const f = fixture(), filename = path.join(__dirname, '../api/game/leaderboard.js');
  const module = { exports: {} }, localRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, URL,
    require: name => name === '../../server/game-service.cjs' ? f.service : localRequire(name),
  }, { filename });
  async function request(url) {
    const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = JSON.parse(body); } };
    await module.exports({ method: 'GET', url }, res);
    return res;
  }
  const id = '11111111-1111-4111-8111-111111111111';
  f.state.get('game/event').roulette = { id };
  for (const query of ['?random=1', '?roulette=bad', `?roulette=${id}&extra=1`, `?roulette=${id}&roulette=${id}`]) {
    assert.equal((await request('/api/game/leaderboard' + query)).statusCode, 400);
  }
  assert.equal((await request('/api/game/leaderboard?roulette=22222222-2222-4222-8222-222222222222')).statusCode, 400);
  assert.equal(f.reads(), 0, 'unrecognized versions do not read every player');
  const result = await request('/api/game/leaderboard?roulette=' + id);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.rouletteId, id);
  assert.match(result.headers['cache-control'], /s-maxage=60/);
});
