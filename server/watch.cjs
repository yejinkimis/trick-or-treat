// 운영자가 눈여겨볼 계정을 고르는 참고 지표. 자동으로 제재하지 않고 표시만 한다.
const HOUR_MS = 60 * 60 * 1000, WINDOW_MS = 24 * HOUR_MS;
const WATCH = Object.freeze({ highWinRate: 0.9, minTries: 20, longHours: 12, oneSourceShare: 0.5, minWinsForSource: 10 });

const hourOf = (at) => Math.floor(at / HOUR_MS);

function summarize(player, { now, prices, nickOf }) {
  const since = now - WINDOW_MS, sinceHour = hourOf(since);
  const tries = (player.challenges || []).filter((c) => c.at >= since);
  const wins = tries.filter((c) => c.w);
  const winTimes = wins.map((c) => c.ms).filter(Number.isFinite);
  const taken = tries.filter((c) => c.m);
  const brewed = (player.brews || []).filter((b) => b.at >= since);
  const decor = Object.entries(player.decor || {}).filter(([, item]) => item?.at >= since);
  const lost = (player.guests || []).filter((g) => g.r === 'win' && g.moved && g.at >= since);
  const harvestHours = Object.entries(player.harvestHours || {}).filter(([hour, n]) => Number(hour) >= sinceHour && n > 0);
  const hours = new Set([...tries.map((c) => hourOf(c.at)), ...brewed.map((b) => hourOf(b.at)), ...harvestHours.map(([hour]) => Number(hour))]);
  const bySource = new Map();
  for (const c of taken) bySource.set(c.h, (bySource.get(c.h) || 0) + 1);
  const [sourceId, sourceCount] = [...bySource].sort((a, b) => b[1] - a[1])[0] || [null, 0];

  const stats = {
    tries: tries.length,
    wins: wins.length,
    winRate: tries.length ? wins.length / tries.length : 0,
    avgWinMs: winTimes.length ? Math.round(winTimes.reduce((a, b) => a + b, 0) / winTimes.length) : null,
    fastestWinMs: winTimes.length ? Math.min(...winTimes) : null,
    candy: {
      knocks: taken.length,
      brews: brewed.reduce((sum, b) => sum + (Number(b.n) || 0), 0),
      decor: -decor.reduce((sum, [key]) => sum + (prices[key] || 0), 0),
      lost: -lost.length,
    },
    harvests: harvestHours.reduce((sum, [, n]) => sum + n, 0),
    activeHours: hours.size,
    topSource: sourceId ? { id: sourceId, nick: nickOf(sourceId), wins: sourceCount, share: sourceCount / taken.length } : null,
  };
  stats.candy.net = stats.candy.knocks + stats.candy.brews + stats.candy.decor + stats.candy.lost;
  const flags = [];
  if (stats.tries >= WATCH.minTries && stats.winRate >= WATCH.highWinRate) flags.push('성공률 높음');
  if (stats.activeHours >= WATCH.longHours) flags.push('오래 쉬지 않음');
  if (stats.topSource && taken.length >= WATCH.minWinsForSource && stats.topSource.share >= WATCH.oneSourceShare) flags.push('한 집에서 몰아 받음');
  return { ...stats, flags };
}

function watchList(players, { now, prices }) {
  const nicks = new Map(players.map((p) => [p.id, p.nick || '이름 없음']));
  const nickOf = (id) => nicks.get(id) || id.slice(0, 8);
  return players.filter((p) => p.costume)
    .map((p) => ({ id: p.id, nick: nickOf(p.id), banned: p.banned === true, ...summarize(p, { now, prices, nickOf }) }))
    .filter((p) => p.tries || p.harvests || p.candy.brews)
    .sort((a, b) => b.flags.length - a.flags.length || b.candy.net - a.candy.net || b.tries - a.tries)
    .slice(0, 50);
}

module.exports = { WATCH, hourOf, summarize, watchList };
