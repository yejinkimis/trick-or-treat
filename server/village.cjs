const VILLAGE_SIZE = 8;
const VILLAGE_NAMES = ['뽀롱뽀롱마을', '둠바족', '태초마을', '구리마을', '안드제국', '프론트마을'];

// 여섯 이름을 다 쓰면 '뽀롱뽀롱마을2'처럼 숫자를 붙여 다음 묶음에서 뽑는다.
function villageName(taken, random = Math.random) {
  for (let round = 1; ; round++) {
    const left = VILLAGE_NAMES.map((name) => round === 1 ? name : `${name}${round}`).filter((name) => !taken.has(name));
    if (left.length) return left[Math.floor(random() * left.length)];
  }
}

// 빈 집은 다시 채우지 않고, 새로 분장한 사람은 분장한 순서대로 항상 맨 뒤 마을에 들어간다.
function planVillages(counter, newcomers, random = Math.random) {
  const state = { last: counter?.last || 0, size: counter?.size || 0, names: [...(counter?.names || [])] };
  const taken = new Set(state.names);
  const assignments = [], created = [];
  const ordered = [...newcomers].sort((a, b) => (a.readyAt || 0) - (b.readyAt || 0) || a.id.localeCompare(b.id));
  for (const { id } of ordered) {
    if (!state.last || state.size >= VILLAGE_SIZE) {
      const name = villageName(taken, random);
      taken.add(name);
      state.names.push(name);
      state.last += 1;
      state.size = 0;
      created.push({ n: state.last, name });
    }
    state.size += 1;
    assignments.push({ id, village: state.last });
  }
  return { state, assignments, created };
}

const counterRef = (db) => db.doc('game/villages');

// 트랜잭션의 읽기 단계에서 부르고, 돌려받은 write를 쓰기 단계에서 부른다.
// 마을 기록이 아예 없으면 기존 분장 플레이어 전체를 분장 순서대로 한 번에 배정한다.
async function readVillagePlan(tx, db, newcomer, now = Date.now()) {
  const counter = await tx.get(counterRef(db));
  const pending = newcomer ? [newcomer] : [];
  if (!counter.exists && newcomer) {
    const players = await tx.get(db.collection('gamePlayers'));
    for (const doc of players.docs) {
      const p = doc.data();
      if (doc.id !== newcomer.id && p.costume && !p.village) pending.push({ id: doc.id, readyAt: p.readyAt || p.joinedAt || 0 });
    }
  }
  const plan = planVillages(counter.exists ? counter.data() : null, pending);
  const villageOf = new Map(plan.assignments.map((a) => [a.id, a.village]));
  return {
    villageOf,
    latest: plan.state.last || 1,
    write(skipId) {
      if (!plan.assignments.length) return;
      tx.set(counterRef(db), plan.state);
      for (const { n, name } of plan.created) tx.set(db.collection('villages').doc(String(n)), { n, name, createdAt: now });
      for (const { id, village } of plan.assignments) if (id !== skipId) tx.update(db.collection('gamePlayers').doc(id), { village });
    },
  };
}

module.exports = { VILLAGE_SIZE, VILLAGE_NAMES, villageName, planVillages, readVillagePlan };
