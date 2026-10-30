const { test } = require('node:test');
const assert = require('node:assert/strict');
const { VILLAGE_SIZE, VILLAGE_NAMES, villageName, planVillages, readVillagePlan } = require('../server/village.cjs');

const people = (count, from = 0) => Array.from({ length: count }, (_, i) => ({ id: `p${from + i}`, readyAt: from + i }));

test('eight houses per village and the ninth costume opens a new village', () => {
  const { state, assignments, created } = planVillages(null, people(9));
  assert.equal(VILLAGE_SIZE, 8);
  assert.deepEqual(assignments.map((a) => a.village), [1, 1, 1, 1, 1, 1, 1, 1, 2]);
  assert.deepEqual(created.map((v) => v.n), [1, 2]);
  assert.notEqual(created[0].name, created[1].name);
  assert.deepEqual(state, { last: 2, size: 1, names: created.map((v) => v.name) });
  for (const { name } of created) assert.ok(VILLAGE_NAMES.includes(name), name);
});

test('newcomers always join the last village in costume order, never an earlier gap', () => {
  const counter = { last: 3, size: 7, names: ['태초마을', '구리마을', '둠바족'] };
  const late = [{ id: 'b', readyAt: 20 }, { id: 'a', readyAt: 10 }];
  const { state, assignments } = planVillages(counter, late);
  assert.deepEqual(assignments, [{ id: 'a', village: 3 }, { id: 'b', village: 4 }]);
  assert.equal(state.last, 4);
  assert.equal(state.names.length, 4);
});

test('village names come from the six names, then repeat with a number', () => {
  const taken = new Set();
  for (let i = 0; i < 6; i++) taken.add(villageName(taken));
  assert.deepEqual([...taken].sort(), [...VILLAGE_NAMES].sort());
  assert.equal(villageName(taken, () => 0), '뽀롱뽀롱마을2');
  for (const name of VILLAGE_NAMES) taken.add(`${name}2`);
  assert.equal(villageName(taken, () => 0.99), '프론트마을3');
});

test('the first assignment after release places existing players in costume order', async () => {
  const docs = new Map([
    ['gamePlayers/old2', { costume: 'cat', readyAt: 200 }],
    ['gamePlayers/old1', { costume: 'ghost', readyAt: 100 }],
    ['gamePlayers/bare', { costume: null, readyAt: 0 }],
  ]);
  const writes = [];
  const ref = (path) => ({ path });
  const db = {
    doc: ref,
    collection: (name) => ({ name, doc: (id) => ref(`${name}/${id}`) }),
  };
  const tx = {
    async get(target) {
      if (target.name) {
        return { docs: [...docs].filter(([k]) => k.startsWith(`${target.name}/`)).map(([k, v]) => ({ id: k.split('/')[1], data: () => v })) };
      }
      return { exists: docs.has(target.path), data: () => docs.get(target.path) };
    },
    set: (target, value) => writes.push(['set', target.path, value]),
    update: (target, value) => writes.push(['update', target.path, value]),
  };
  const plan = await readVillagePlan(tx, db, { id: 'me', readyAt: 300 }, 5);
  assert.equal(plan.villageOf.get('me'), 1);
  plan.write('me');
  assert.deepEqual(writes.filter(([kind]) => kind === 'update'), [
    ['update', 'gamePlayers/old1', { village: 1 }], ['update', 'gamePlayers/old2', { village: 1 }],
  ]);
  assert.deepEqual(writes.find(([, path]) => path === 'game/villages')[2], { last: 1, size: 3, names: [writes.find(([, path]) => path === 'villages/1')[2].name] });
});
