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
console.log(`Built dist/index.html (PostHog ${site.analytics ? 'enabled' : 'disabled'})`);
