import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  fetchSignInMethodsForEmail,
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
  signOut as fbSignOut,
  onIdTokenChanged,
  deleteUser,
  type Auth,
  type User,
} from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

/**
 * Browser-side Firebase app (NeonDeck platform).
 *
 * The configuration below is the LIVE production Firebase web config. Firebase
 * web keys (apiKey, appId, …) are PUBLIC by design — they identify the project
 * and are meant to ship in the client bundle; Firestore Security Rules and
 * Firebase Auth (not key secrecy) protect the data. They are hardcoded here so
 * NeonDeck connects to the real project instantly with zero .env setup.
 *
 * The optional VITE_FIREBASE_* env vars override any single field (handy for
 * pointing a build at a staging project) but are not required.
 */
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "AIzaSyBG_bfyTc0mAEfF0GxsRTFjrF4v4xrqf_k",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "neondeck-8cbe0.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "neondeck-8cbe0",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? "neondeck-8cbe0.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "372340190765",
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? "1:372340190765:web:5f459cedff8141373652a4",
};

/** The active Firebase project id — also used to scope Firestore documents. */
export const FIREBASE_PROJECT_ID = firebaseConfig.projectId;

// Reuse the existing app if one is already initialized (idempotent): a second
// initializeApp() with the same name throws "app already exists", which would
// break the module on any re-execution.
export const firebaseApp: FirebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth: Auth = getAuth(firebaseApp);
export const db: Firestore = getFirestore(firebaseApp);

/**
 * The session shape the rest of NeonDeck consumes. `token` is a Firebase ID
 * token (JWT) the daemon verifies server-side; `userId` is the Firebase uid.
 */
export interface AuthSession {
  token: string | null;
  userId: string;
  email: string | null;
}

/** Map a Firebase User to a NeonDeck session, attaching a fresh ID token. */
async function toSession(user: User): Promise<AuthSession> {
  let token: string | null = null;
  try {
    token = await user.getIdToken();
  } catch {
    /* keep token null — the daemon may still allow a loopback dev connection */
  }
  return { token, userId: user.uid, email: user.email };
}

export async function signUp(email: string, password: string): Promise<void> {
  await createUserWithEmailAndPassword(auth, email, password);
}

export async function signIn(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(auth, email, password);
}

/** Email a password-reset link (Firebase hosts the reset page). */
export async function resetPassword(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email);
}

/**
 * Which sign-in methods exist for an email (e.g. ["password"], ["google.com"]).
 * Best-effort: returns [] if Firebase's email-enumeration protection is on (it
 * suppresses this for privacy). Used to warn that a Google-only account can't get
 * a password-reset email. */
export async function getSignInMethods(email: string): Promise<string[]> {
  try {
    return await fetchSignInMethodsForEmail(auth, email);
  } catch {
    return [];
  }
}

/** Shared Google provider — always prompt account selection so users can switch. */
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

/**
 * Google OAuth via a full-page REDIRECT (not a popup).
 *
 * Popup auth (`signInWithPopup`) hangs in Safari: the OAuth handler runs on the
 * `*.firebaseapp.com` authDomain — a different site from the app origin — and
 * Safari's cross-site storage blocking (ITP) breaks the popup↔opener handshake,
 * so the promise never resolves. Redirect avoids that opener channel entirely
 * and is reliable for Chrome end-users. The page navigates to Google and back;
 * on return the onIdTokenChanged listeners (currentSession / onAuthChange) pick
 * up the signed-in user, so no explicit success handling is needed here.
 */
export async function signInWithGoogle(): Promise<void> {
  await signInWithRedirect(auth, googleProvider);
}

/**
 * After returning from a redirect sign-in, surface any error (or null when the
 * redirect succeeded / there was none). Called once on the gateway's mount so a
 * blocked/failed redirect shows a message instead of silently dropping the user
 * back on the login screen.
 */
export async function getRedirectError(): Promise<unknown | null> {
  try {
    // Bound the SDK call so a slow/blocked redirect (e.g. Safari) can't wedge the
    // gateway's mount effect. Success OR timeout both mean "no error to surface";
    // a genuine auth failure rejects and is returned from the catch.
    await Promise.race([
      getRedirectResult(auth),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);
    return null;
  } catch (err) {
    return err;
  }
}

export async function signOut(): Promise<void> {
  await fbSignOut(auth);
}

/**
 * Permanently delete the signed-in user's account (irreversible). Firebase requires
 * a RECENT login for this; if the session is stale it throws
 * `auth/requires-recent-login`, which the caller surfaces as "sign in again and
 * retry". Leftover server-side data (Firestore docs, synced projects) is harmless;
 * the login — and the email — is freed immediately.
 */
export async function deleteAccount(): Promise<void> {
  const user = auth.currentUser;
  if (!user) throw new Error("You're not signed in.");
  await deleteUser(user);
}

/** Resolve the current session once (waits for Firebase to restore persistence). */
export function currentSession(): Promise<AuthSession | null> {
  return new Promise((resolve) => {
    const off = onIdTokenChanged(auth, async (user) => {
      off();
      resolve(user ? await toSession(user) : null);
    });
  });
}

/**
 * Subscribe to auth + token changes. Fires on sign-in, sign-out, AND silent ID
 * token refreshes (every ~hour) so the daemon handshake always has a live JWT.
 */
export function onAuthChange(cb: (s: AuthSession | null) => void): () => void {
  return onIdTokenChanged(auth, async (user) => {
    cb(user ? await toSession(user) : null);
  });
}
