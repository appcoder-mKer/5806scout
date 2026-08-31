"use client";

import { useAuth } from "@/lib/auth/AuthProvider";
import { db } from "@/lib/firebase/client";
import { exitGuestMode } from "@/lib/guestMode";
import { doc, updateDoc } from "firebase/firestore";

/**
 * The strip that keeps a guest oriented.
 *
 * Two jobs. It says plainly that nothing is being kept, because a scouting form
 * that confirms a submission is otherwise indistinguishable from one that saved
 * it — which is the whole trick of guest mode, and would be a nasty surprise if
 * left implicit. And it carries the role switch, since six of the app's tabs
 * are admin-only and a visitor who only ever saw the scout half would conclude
 * the app was half its actual size.
 *
 * Per DESIGN.md this is a field-tool status strip: flat, bordered, maroon on
 * graphite. Not a trial banner.
 */
export function GuestBanner() {
  const { isGuest, profile, user } = useAuth();
  if (!isGuest || !profile || !user) return null;

  const isAdmin = profile.role === "admin";

  // Writes to the in-memory profile; AuthProvider's snapshot picks it up and
  // AppNav re-filters. firestore.rules would refuse this outright — which is
  // fine, because with the network off no rule is ever asked.
  function switchRole() {
    void updateDoc(doc(db, "users", user!.uid), {
      role: isAdmin ? "scout" : "admin",
    }).catch(() => {});
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-maroon-200 bg-maroon-50 px-4 py-2">
      <p className="text-xs text-maroon-900 dark:text-maroon-200">
        <span className="stat mr-2 rounded bg-maroon-600 px-1.5 py-0.5 text-[0.65rem] uppercase tracking-widest text-white">
          Guest
        </span>
        Look around all you like — nothing here is saved.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={switchRole}
          className="btn-secondary px-3 py-1 text-xs"
        >
          {isAdmin ? "View as scout" : "View as admin"}
        </button>
        <button
          type="button"
          onClick={exitGuestMode}
          className="btn-ghost border border-maroon-300 px-3 py-1 text-xs"
        >
          Exit
        </button>
      </div>
    </div>
  );
}
