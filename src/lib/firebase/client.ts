import { getApp, getApps, initializeApp } from "firebase/app";
import { GoogleAuthProvider, getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

/**
 * En nuestros dominios, el login de Google pasa por el MISMO dominio de la app
 * (next.config.ts reenvía /__/auth/* a Firebase). Si va por firebaseapp.com,
 * Safari y la app instalada en el iPhone no comparten la sesión con esa
 * ventana: el usuario se loguea y la app nunca se entera.
 * Requiere `https://<host>/__/auth/handler` en los "URI de redireccionamiento"
 * del cliente OAuth de Google Cloud.
 */
const SAME_ORIGIN_AUTH_HOSTS = ["www.lalibreta.com.ar", "lalibreta.com.ar"];

const authDomain =
  typeof window !== "undefined" && SAME_ORIGIN_AUTH_HOSTS.includes(window.location.host)
    ? window.location.host
    : (process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "missing.firebaseapp.com");

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "missing-api-key",
  authDomain,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "missing",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "missing.appspot.com",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "0",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "0:0:web:0",
};

export const isFirebaseConfigured = () =>
  Boolean(process.env.NEXT_PUBLIC_FIREBASE_API_KEY && process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID);

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
export const googleProvider = new GoogleAuthProvider();
