const { getApps, initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');
const { DEMO_PROJECT_ID } = require('./config.cjs');

let cached;

function services() {
  if (cached) return cached;

  const projectId = process.env.FIREBASE_PROJECT_ID || (process.env.NODE_ENV === 'production' ? '' : DEMO_PROJECT_ID);
  if (!projectId) throw new Error('Firebase project is not configured');

  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
  const databaseHost = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  const emulator = Boolean(authHost && firestoreHost && databaseHost);
  if ((authHost || firestoreHost || databaseHost) && (!emulator || !projectId.startsWith('demo-'))) {
    throw new Error('Firebase emulators require a demo project and all emulator hosts');
  }
  if (process.env.NODE_ENV === 'production' && emulator) throw new Error('Production cannot use Firebase emulators');

  let credential;
  if (!emulator) {
    const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!rawServiceAccount) throw new Error('Firebase service account is not configured');
    let serviceAccount;
    try { serviceAccount = JSON.parse(rawServiceAccount); }
    catch { throw new Error('Firebase service account JSON is invalid'); }
    if (serviceAccount.project_id !== projectId) throw new Error('Firebase service account project does not match');
    credential = cert(serviceAccount);
  }

  const databaseURL = process.env.FIREBASE_DATABASE_URL || (emulator ? `https://${projectId}-default-rtdb.firebaseio.com` : '');
  if (!databaseURL) throw new Error('Firebase Realtime Database URL is not configured');
  const app = getApps().find((item) => item.options.projectId === projectId)
    || initializeApp({ projectId, databaseURL, ...(credential ? { credential } : {}) });
  cached = { app, auth: getAuth(app), db: getFirestore(app), database: getDatabase(app), projectId, emulator };
  return cached;
}

module.exports = { DEMO_PROJECT_ID, services };
