const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// The local server always points at an isolated demo project. It never reads a real Firebase project.
process.env.NODE_ENV = 'development';
process.env.FIREBASE_PROJECT_ID = 'demo-trick-or-treat';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_DATABASE_EMULATOR_HOST = '127.0.0.1:9000';

const root = path.resolve(__dirname, '..');
const htmlPath = path.join(root, 'prototype', 'trick-or-treat.html');
const api = new Map([
  ['/api/firebase-config', require('../api/firebase-config.js')],
  ['/api/auth/signup', require('../api/auth/signup.js')],
  ['/api/auth/login', require('../api/auth/login.js')],
  ['/api/auth/profile', require('../api/auth/profile.js')],
  ['/api/game/session', require('../api/game/session.js')],
  ['/api/game/action', require('../api/game/action.js')],
  ['/api/game/leaderboard', require('../api/game/leaderboard.js')],
  ['/api/game/admin', require('../api/game/admin.js')],
]);

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  const handler = api.get(pathname);
  if (handler) { void handler(req, res); return; }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/prototype/trick-or-treat.html')) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
    });
    fs.createReadStream(htmlPath).pipe(res);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const port = Number(process.env.PORT) || 4173;
server.listen(port, '127.0.0.1', () => {
  console.log(`Practice server: http://127.0.0.1:${port}`);
  console.log('Firebase emulators: http://127.0.0.1:9099 (Auth), http://127.0.0.1:8080 (Firestore)');
  console.log('Realtime Database emulator: http://127.0.0.1:9000');
});
