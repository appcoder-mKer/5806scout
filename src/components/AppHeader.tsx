"use client";

import Link from "next/link";
import Image from "next/image";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useAppearance } from "@/components/AppearanceProvider";
import { MobileMenu } from "@/components/AppNav";
import { OperatorLink } from "@/components/OperatorLink";
import { auth } from "@/lib/firebase/client";
import { signOut } from "firebase/auth";
import { ThemeToggle } from "@/components/ThemeToggle";

export function AppHeader() {
  const { profile } = useAuth();
  const { logoUrl } = useAppearance();

  return (
    // border-maroon-900, not graphite: graphite inverts in dark mode, and the
    // line under the maroon header must stay near-black in both themes.
    // Maroon bg + top safe-area padding so the notch/status-bar strip reads as
    // part of the header when installed to the home screen on iPhone/iPad.
    <header className="border-b border-maroon-900 bg-maroon-700 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]">
      <div className="hazard-stripe h-1" />
      <div className="flex items-center justify-between bg-maroon-700 px-4 py-3 text-white md:px-6">
        {/* min-w-0 so the wordmark truncates on a narrow phone rather than
            pushing the theme toggle and Log out off the header. */}
        <div className="flex min-w-0 items-center gap-2 md:gap-3">
          <MobileMenu />
          <Link href="/home" className="flex min-w-0 items-center gap-2.5">
            {logoUrl ? (
              // Custom team logo — a data URL or arbitrary host chosen at
              // runtime, so a plain <img> (next/image would need domain
              // whitelisting).
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt="Team logo"
                className="h-7 w-7 shrink-0 rounded-md bg-white object-contain"
              />
            ) : (
              <Image
                src="/lion-logo.png"
                alt="Team 5806 lion crest"
                width={28}
                height={28}
                className="h-7 w-7 shrink-0 rounded-md bg-white object-contain"
              />
            )}
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-base font-semibold tracking-tight">
                FRC Scouting
              </span>
              {/* The team number is data, so it gets the mono treatment and a
                  plate of its own — at the old bare maroon-100 it read as a
                  faded piece of the wordmark rather than as whose console
                  this is. */}
              {profile && (
                <span className="stat shrink-0 rounded border border-maroon-300/40 px-1.5 py-0.5 text-xs text-maroon-100">
                  {profile.teamId}
                </span>
              )}
            </span>
          </Link>
        </div>

        <div className="flex items-center gap-3 text-sm">
          {profile && (
            <span className="hidden text-maroon-100 sm:inline">
              {profile.fullName}
              {profile.role === "admin" && (
                <span className="badge badge-admin ml-1.5">Admin</span>
              )}
            </span>
          )}
          <OperatorLink />
          <ThemeToggle />
          {profile && (
            <button
              onClick={() => signOut(auth)}
              className="rounded-md border border-maroon-300/40 px-2.5 py-1.5 text-xs font-medium text-white transition hover:border-maroon-300/70 hover:bg-maroon-800 active:bg-maroon-900"
            >
              Log out
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
