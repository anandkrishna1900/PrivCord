import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  connectAuthEmulator,
  getAuth,
  type Auth,
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  getFirestore,
  type Firestore,
} from 'firebase/firestore';
import { config } from '../config';

let authInstance: Auth | null = null;
let dbInstance: Firestore | null = null;
let emulatorsConnected = false;

function app() {
  if (!config.isFirebaseConfigured) {
    throw new Error(
      'Firebase is not configured. Copy .env.example to .env and fill in the web app values.',
    );
  }
  return getApps().length > 0 ? getApp() : initializeApp(config.firebase);
}

export function firebaseAuth(): Auth {
  if (!authInstance) {
    authInstance = getAuth(app());
    if (config.emulatorHost && !emulatorsConnected) {
      connectAuthEmulator(authInstance, `http://${config.emulatorHost}:9099`, {
        disableWarnings: true,
      });
    }
  }
  return authInstance;
}

export function firebaseDb(): Firestore {
  if (!dbInstance) {
    dbInstance = getFirestore(app());
    if (config.emulatorHost && !emulatorsConnected) {
      connectFirestoreEmulator(dbInstance, config.emulatorHost, 8080);
      emulatorsConnected = true;
    }
  }
  return dbInstance;
}
