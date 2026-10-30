const { getApps, initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { DEMO_PROJECT_ID } = require('./config.cjs');

let cached;

function services() {
  if (cached) return cached;

  const projectId = process.env.FIREBASE_PROJECT_ID || (process.env.NODE_ENV === 'production' ? '' : DEMO_PROJECT_ID);
  if (!projectId) throw new Error('Firebase project is not configured');

  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
  const emulator = Boolean(authHost && firestoreHost);
  if ((authHost || firestoreHost) && (!emulator || !projectId.startsWith('demo-'))) {
    throw new Error('Firebase emulators require a demo project and both emulator hosts');
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

  const app = getApps().find((item) => item.options.projectId === projectId)
    || initializeApp({ projectId, ...(credential ? { credential } : {}) });
  cached = { app, auth: getAuth(app), db: getFirestore(app), projectId, emulator };
  return cached;
}

module.exports = { DEMO_PROJECT_ID, services };
