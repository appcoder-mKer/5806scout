"use client";

import { auth } from "@/lib/firebase/client";
import { enterGuestMode, guestModeAvailable } from "@/lib/guestMode";
import { signInAnonymously } from "firebase/auth";
import { useState } from "react";

/**
 * The way in for anyone who hasn't got an account and shouldn't need one to
 * decide whether they want one.
 *
 * Anonymous auth rather than a synthesised user object: it yields a real
 * Firebase User, so AuthProvider, RequireAuth and everything reading user.uid
 * carry on unchanged. It also clears the email gate for free, since
 * needsEmailVerification() waves through any account with no password provider
 * (src/lib/emailVerification.ts) — which is exactly what an anonymous one is.
 */
export function GuestSignInButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A browser that won't hold sessionStorage can't be put into guest mode
  // safely — src/lib/firebase/client.ts reads that flag to decide whether the
  // writes are real. Better to not offer it than to offer a version that saves.
  if (typeof window !== "undefined" && !guestModeAvailable()) return null;

  async function handleClick() {
    setError(null);
    setBusy(true);
    try {
      await signInAnonymously(auth);
      enterGuestMode();
    } catch {
      setError("Couldn't start a guest session — try again.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={() => void handleClick()}
        className="btn-secondary w-full px-4 py-2"
      >
        {busy ? "Starting…" : "Look around as a guest"}
      </button>
      <p className="text-center text-xs text-graphite-500">
        The whole app with real event data. Nothing you do is saved.
      </p>
      {error && (
        <p className="badge-error rounded-md px-3 py-2 text-sm normal-case tracking-normal">
          {error}
        </p>
      )}
    </div>
  );
}
