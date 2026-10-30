const { apiHandler } = require('../server/api-handler.cjs');
const { DEMO_PROJECT_ID } = require('../server/config.cjs');

const isProduction = process.env.NODE_ENV === 'production';
const handler = apiHandler(['GET'], async () => {
  const authEmulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const firestoreEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  const emulator = !isProduction && Boolean(authEmulatorHost && firestoreEmulatorHost);
  if (isProduction && (authEmulatorHost || firestoreEmulatorHost)) {
    const error = new Error('Production cannot connect to Firebase emulators');
    error.status = 503;
    throw error;
  }

  if (emulator) {
    const projectId = process.env.FIREBASE_PROJECT_ID || DEMO_PROJECT_ID;
    if (!projectId.startsWith('demo-')) {
      const error = new Error('Emulators require a demo project');
      error.status = 503;
      throw error;
    }
    return { body: { firebaseConfig: {
      apiKey: 'demo-api-key',
      authDomain: `${projectId}.firebaseapp.com`,
      projectId,
      storageBucket: `${projectId}.firebasestorage.app`,
      messagingSenderId: '000000000000',
      appId: '1:000000000000:web:demo',
    }, emulator: { auth: `http://${authEmulatorHost}` } } };
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
  };
  if (!projectId || Object.values(firebaseConfig).some((value) => !value)) {
    const error = new Error('Firebase web configuration is incomplete');
    error.status = 503;
    throw error;
  }
  if (!isProduction) throw new Error('Local development must use the demo Firebase project and emulators');
  if (projectId.startsWith('demo-')) throw new Error('Production cannot use a demo project');
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    let serviceAccount;
    try { serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON); }
    catch { throw new Error('Firebase service account JSON is invalid'); }
    if (serviceAccount.project_id !== projectId) throw new Error('Firebase service account project does not match');
  } else {
    const error = new Error('Firebase service account is not configured');
    error.status = 503;
    throw error;
  }
  return { body: { firebaseConfig } };
});

module.exports = handler;
