const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');

function analyticsConfig(env = process.env) {
  const enabled = env.POSTHOG_ENABLED === 'true'
    || (env.POSTHOG_ENABLED !== 'false' && env.VERCEL_ENV === 'production');
  const key = env.POSTHOG_PROJECT_KEY?.trim();
  if (!enabled || !key) return null;
  if (!/^phc_[a-zA-Z0-9_]+$/.test(key)) throw new Error('POSTHOG_PROJECT_KEY must be a public phc_ project key, not a personal API key.');
  const host = env.POSTHOG_HOST?.trim();
  if (!['https://us.i.posthog.com', 'https://eu.i.posthog.com'].includes(host)) {
    throw new Error('POSTHOG_HOST must be the US or EU PostHog ingestion host.');
  }
  return { key, host, environment: env.VERCEL_ENV || 'development' };
}

function prepareSite(env = process.env) {
  const config = analyticsConfig(env);
  const html = fs.readFileSync(path.join(root, 'prototype/trick-or-treat.html'), 'utf8')
    .replace('<!-- POSTHOG_ANALYTICS -->', config ? '<script src="/analytics.js"></script>' : '');
  const analytics = config ? buildSync({
    entryPoints: [path.join(root, 'client/analytics.mjs')], bundle: true, write: false,
    minify: true, format: 'iife', target: 'es2020', legalComments: 'none',
    define: { __ANALYTICS_CONFIG__: JSON.stringify(config) },
  }).outputFiles[0].text : null;
  return { html, analytics };
}

module.exports = { analyticsConfig, prepareSite };
