import { config } from "@/lib/config";
import { isGuestSession } from "@/lib/guestMode";
import { type FirebaseApp, getApps, initializeApp } from "firebase/app";
import { type Auth, getAuth } from "firebase/auth";
import {
  type Firestore,
  disableNetwork,
  getFirestore,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";

// Next.js hot-reloads client modules in dev; reuse the existing app instance
// instead of calling initializeApp() again (Firebase throws if you don't).
const app: FirebaseApp = getApps()[0] ?? initializeApp(config.firebase);

export const auth: Auth = getAuth(app);

// Two caches, picked once per page load.
//
// Normally: an IndexedDB-backed offline cache. Reads serve cached data and
// writes queue locally when the venue has no signal (the normal state at an
// FRC event), then sync on reconnect. The multi-tab manager keeps several open
// tabs consistent.
//
// In guest mode (src/lib/guestMode.ts): a memory-only cache with the network
// switched off, so the visitor gets the whole app — writes apply instantly,
// listeners fire, forms confirm — while nothing leaves the tab. It has to be
// the MEMORY cache and not merely disableNetwork() on the persistent one: with
// IndexedDB, a refresh would re-enable the network before any of our code ran
// and flush the queued writes to the server. Nothing survives a reload here,
// so there is nothing to replay.
//
// initializeFirestore throws if Firestore already exists for the app (dev hot
// reload) — fall back to the existing instance.
function createDb(): Firestore {
  if (isGuestSession()) {
    try {
      const guestDb = initializeFirestore(app, {
        localCache: memoryLocalCache(),
      });
      // Fire-and-forget: the promise only reports when the shutdown finished,
      // and there is no useful recovery. Queued work stays in memory either
      // way, which is the guarantee that matters.
      void disableNetwork(guestDb).catch(() => {});
      return guestDb;
    } catch {
      return getFirestore(app);
    }
  }

  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
  } catch {
    return getFirestore(app);
  }
}

export const db: Firestore = createDb();
