const { randomInt } = require('node:crypto');
const { scheduleOf } = require('./candy-rain.cjs');

// 부자 털기: 정해진 시간 동안 순위 상위 5명의 집에 노크해 성공하면 1개 대신 그 집 사탕의 5~10%를 가져간다.
// 한 사람이 한 집을 붙잡고 있지 않게 같은 부자 집에는 3분에 한 번만 노크한다. 상위 5명은 1분마다 다시 계산하는 순위표로 정한다. 시각은 GAME_RICH_RAID_AT('시작 시각/분')으로 바꾸고 빈 문자열이면 끈다.
const RICH_TOP = 5, RAID_MIN = 60, RAID_COOLDOWN_MS = 3 * 60 * 1000;
const DEFAULT_RAID_AT = '2026-10-31T23:00:00+09:00/30';

const raidSchedule = () => scheduleOf(process.env.GAME_RICH_RAID_AT ?? DEFAULT_RAID_AT, RAID_MIN);
const raidActive = (now, schedule = raidSchedule()) => schedule.some((span) => now >= span.at && now < span.at + span.ms);
const raidTake = (hostCandies, percent = randomInt(5, 11)) => Math.max(1, Math.floor(hostCandies * percent / 100));

module.exports = { RICH_TOP, RAID_COOLDOWN_MS, raidSchedule, raidActive, raidTake };
