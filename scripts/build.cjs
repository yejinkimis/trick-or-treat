const fs = require('node:fs');
const path = require('node:path');
const { prepareSite } = require('./analytics-build.cjs');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
fs.mkdirSync(output, { recursive: true });
const site = prepareSite();
fs.writeFileSync(path.join(output, 'index.html'), site.html);
const analyticsPath = path.join(output, 'analytics.js');
if (site.analytics) fs.writeFileSync(analyticsPath, site.analytics);
else fs.rmSync(analyticsPath, { force: true });
// 마을 리포트는 모두에게 같은 이미지라 정적 파일로 낸다. 사람별 결산(wrap/)은 API로만 내려준다.
fs.cpSync(path.join(root, 'report'), path.join(output, 'report'), { recursive: true });
console.log(`Built dist/index.html (PostHog ${site.analytics ? 'enabled' : 'disabled'})`);
