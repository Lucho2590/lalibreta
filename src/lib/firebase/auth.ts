import {
  createUserWithEmailAndPassword,
  getRedirectResult,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut as fbSignOut,
} from "firebase/auth";
import { clearIndexedDbPersistence, terminate } from "firebase/firestore";
import { auth, db, googleProvider } from "./client";

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

/**
 * Cierra sesión y borra los datos guardados en el navegador (en una compu
 * compartida no tienen que quedar). Después de terminate() la base no se
 * puede volver a usar: se recarga en el login.
 */
export const signOut = async () => {
  await fbSignOut(auth);
  try {
    await terminate(db);
    await clearIndexedDbPersistence(db);
  } catch (err) {
    // Otra pestaña abierta la sigue usando: se borra la próxima vez.
    console.warn("[auth] no se pudo borrar la caché local", err);
  }
  window.location.assign("/login");
};
