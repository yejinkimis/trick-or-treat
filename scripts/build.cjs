const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(
  path.join(root, 'prototype', 'trick-or-treat.html'),
  path.join(output, 'index.html'),
);
console.log('Built dist/index.html from prototype/trick-or-treat.html');
