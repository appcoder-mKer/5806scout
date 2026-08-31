"use client";

import { useAuth } from "@/lib/auth/AuthProvider";
import { db } from "@/lib/firebase/client";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * The way in to /owner.
 *
 * That page is deliberately absent from src/lib/nav.ts — every tab there
 * belongs to whoever runs a TEAM, and this one belongs to whoever runs the
 * app. But leaving it with no entry point at all just made it a URL you had to
 * remember, so it gets a door here instead: rendered only for the handful of
 * accounts holding owners/{uid}, and invisible to everyone else.
 *
 * The count is the actual point. Without it this is a link to a page that is
 * usually empty, which is a link nobody clicks; with it, a team waiting to be
 * let in is visible from any screen in the app.
 */
export function OperatorLink() {
  const { isOwner } = useAuth();
  const [pending, setPending] = useState(0);

  useEffect(() => {
    // Only owners may list teamClaims (firestore.rules), so subscribing as
    // anyone else would be a guaranteed permission error every session.
    if (!isOwner) return;
    return onSnapshot(
      query(collection(db, "teamClaims"), where("status", "==", "pending")),
      (snapshot) => setPending(snapshot.size),
      // A failed read shouldn't put a wrong number in the header; the page
      // itself is one click away and reports properly.
      () => setPending(0),
    );
  }, [isOwner]);

  if (!isOwner) return null;

  return (
    <Link
      href="/owner"
      aria-label={
        pending > 0
          ? `Operator — ${pending} team${pending === 1 ? "" : "s"} waiting`
          : "Operator"
      }
      className="flex items-center gap-1.5 rounded-md border border-maroon-300/40 px-2.5 py-1.5 text-xs font-medium text-white transition hover:border-maroon-300/70 hover:bg-maroon-800 active:bg-maroon-900"
    >
      Operator
      {pending > 0 && (
        <span className="stat rounded bg-white px-1.5 py-0.5 text-[0.65rem] leading-none text-maroon-800">
          {pending}
        </span>
      )}
    </Link>
  );
}
