import "server-only";

import {
  type App,
  cert,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID;
const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY;

let appSingleton: App | null = null;

const getApp = (): App => {
  if (appSingleton) return appSingleton;
  const existing = getApps()[0];
  if (existing) {
    appSingleton = existing;
    return existing;
  }
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Firebase Admin no está configurado. Cargá FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL y FIREBASE_ADMIN_PRIVATE_KEY en .env.local",
    );
  }
  appSingleton = initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      // En Vercel la private key viene con \n escapados — los desescapamos acá.
      privateKey: privateKey.replace(/\\n/g, "\n"),
    }),
  });
  return appSingleton;
};

export const adminAuth = (): Auth => getAuth(getApp());
export const adminDb = (): Firestore => getFirestore(getApp());
