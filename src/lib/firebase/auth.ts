import {
  createUserWithEmailAndPassword,
  getRedirectResult,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut as fbSignOut,
} from "firebase/auth";
import { auth, googleProvider } from "./client";

export const signInWithEmail = (email: string, password: string) =>
  signInWithEmailAndPassword(auth, email, password);

export const signUpWithEmail = (email: string, password: string) =>
  createUserWithEmailAndPassword(auth, email, password);

/** ¿Abierta como app instalada (pantalla de inicio / ventana propia)? */
const isStandalone = () =>
  typeof window !== "undefined" &&
  (window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true);

/**
 * En la app instalada el popup se abre en una ventana aparte que no le puede
 * devolver la sesión a la app (sobre todo en el iPhone): ahí vamos por
 * redirección, que vuelve a la misma app con la sesión iniciada.
 */
export const signInWithGoogle = () =>
  isStandalone() ? signInWithRedirect(auth, googleProvider) : signInWithPopup(auth, googleProvider);

/** Resultado de la redirección (si la hubo): sirve para mostrar errores. */
export const completeGoogleRedirect = () => getRedirectResult(auth);

export const signOut = () => fbSignOut(auth);
