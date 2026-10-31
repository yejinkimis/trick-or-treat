// 사탕 비: 정해진 시각부터 4초마다 사탕이 하나씩 떨어지고, 20초 안에 주우면 1개씩 받는다.
// 각자 자기 화면에만 떨어져 마을이 작아도 서로 빼앗지 않는다.
// 시각은 GAME_CANDY_RAIN_AT에 '시작 시각/분'을 쉼표로 이어 바꾼다. 분을 빼면 10분이다.
const RAIN_MIN = 10, DROP_EVERY_MS = 4 * 1000, DROP_LIFE_MS = 20 * 1000, PICK_SLACK_MS = 2000;
const DEFAULT_RAIN_AT = '2026-10-31T22:30:00+09:00/90';

function scheduleOf(text, defaultMin) {
  return text.split(',').map((item) => {
    const [start, min = defaultMin] = item.trim().split('/');
    return { at: Date.parse(start), ms: Number(min) * 60 * 1000 };
  }).filter((span) => Number.isFinite(span.at) && span.ms > 0).sort((a, b) => a.at - b.at);
}

function rainSchedule() {
  return scheduleOf(process.env.GAME_CANDY_RAIN_AT ?? DEFAULT_RAIN_AT, RAIN_MIN).map((span) => ({ ...span, every: DROP_EVERY_MS, life: DROP_LIFE_MS }));
}

// 사탕 번호는 '비 시작 시각-순번'이다. 떨어진 뒤 녹기 전까지만 주울 수 있다.
function checkDrop(id, now, schedule = rainSchedule()) {
  const match = /^(\d{13})-(\d{1,4})$/.exec(typeof id === 'string' ? id : '');
  const rain = match && schedule.find((item) => item.at === Number(match[1]));
  const i = match ? Number(match[2]) : -1;
  if (!rain || i * rain.every >= rain.ms) return { error: '사탕을 확인해 주세요.' };
  const at = rain.at + i * rain.every;
  if (now + PICK_SLACK_MS < at) return { error: '아직 떨어지지 않은 사탕이에요.', status: 409 };
  if (now > at + rain.life + PICK_SLACK_MS) return { error: '사탕이 녹아 없어졌어요.', status: 409 };
  return { rain: rain.at, i };
}

module.exports = { scheduleOf, rainSchedule, checkDrop };
