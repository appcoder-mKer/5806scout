import { doc, setDoc, type Firestore } from "firebase/firestore";

// Guest mode: the whole app, none of the consequences.
//
// Closing signup (src/lib/membership.ts) makes this app opaque to anyone
// deciding whether it's worth joining. Guest mode is the answer — every tab,
// both roles, real event data — with nothing written anywhere.
//
// HOW IT AVOIDS TOUCHING TWENTY FILES
//
// Roughly twenty modules write to Firestore, so intercepting each write site
// was never realistic. Instead the whole decision is made once, at Firestore
// init (src/lib/firebase/client.ts): a guest session gets a memory-only cache
// with the network disabled. Every page then works exactly as written —
// writes land in the cache, listeners fire, forms confirm — and nothing ever
// reaches a server. The app already relies on this behaviour for scouting in
// an arena with no signal (see src/lib/offlineSync.ts); guest mode is that,
// minus the reconnect.
//
// Because the mode is chosen at module init, switching it is a full page
// load, not a state change. Hence the sessionStorage flag and the assignments
// below: the flag survives the navigation, the Firestore instance is rebuilt
// on the other side.
//
// WHY MEMORY CACHE AND NOT JUST disableNetwork()
//
// With the normal IndexedDB cache, a refresh would re-enable the network
// before any of our code ran and flush the queued writes to the server. A
// memory cache cannot do that: nothing survives the reload to replay. The
// guarantee is structural rather than a promise we have to keep.

const GUEST_FLAG = "frc-scout:guest";

/** The team a guest is dropped into. Never written to a server. */
export const GUEST_TEAM_ID = "__guest__";

/** Is this tab a guest session? Safe to call during SSR, where it's false. */
export function isGuestSession(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(GUEST_FLAG) === "1";
  } catch {
    // Private-mode browsers can throw on sessionStorage. A guest session we
    // can't record is one we must not start, because client.ts would then
    // build a networked Firestore and the writes would be real.
    return false;
  }
}

/** Can this browser hold the flag at all? Gates the entry buttons. */
export function guestModeAvailable(): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.sessionStorage.setItem(GUEST_FLAG, window.sessionStorage.getItem(GUEST_FLAG) ?? "0");
    if (window.sessionStorage.getItem(GUEST_FLAG) === "0") {
      window.sessionStorage.removeItem(GUEST_FLAG);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Enter guest mode. Sets the flag and hard-navigates, because the Firestore
 * instance is only chosen once per page load — a client-side route change
 * would leave the real, networked one in place.
 */
export function enterGuestMode(): void {
  window.sessionStorage.setItem(GUEST_FLAG, "1");
  window.location.assign("/home");
}

/** Leave guest mode, taking the in-memory session with it. */
export function exitGuestMode(): void {
  try {
    window.sessionStorage.removeItem(GUEST_FLAG);
  } catch {
    // Nothing to clear if it couldn't be set; the reload still gets us out.
  }
  window.location.assign("/login");
}

/**
 * Write the guest's profile and team into the local cache.
 *
 * Takes `db` as an argument rather than importing it: src/lib/firebase/client.ts
 * asks this module which cache to build, so importing back the other way would
 * be a cycle.
 *
 * Two things are worth noticing about the values. The profile says
 * `status: "approved"`, which means the approval gate lets a guest through
 * with no special case anywhere in RequireAuth — the gate reads a profile, and
 * this is a profile. And it says `role: "admin"`, which firestore.rules would
 * refuse outright. Both are fine for exactly one reason: the network is off,
 * so no rule is ever consulted and this document exists only in this tab's
 * memory. Nothing here is a claim about what a server would accept.
 */
export async function seedGuestSession(
  db: Firestore,
  uid: string,
): Promise<void> {
  await Promise.all([
    setDoc(doc(db, "users", uid), {
      email: "guest@example.com",
      fullName: "Guest",
      teamId: GUEST_TEAM_ID,
      role: "admin",
      active: true,
      emailVerified: true,
      status: "approved",
      createdAt: new Date(),
    }),
    setDoc(doc(db, "teams", GUEST_TEAM_ID), {
      teamNumber: "5806",
      teamName: "Demo Team",
      createdAt: new Date(),
    }),
  ]);
}
