"use client";

import { auth, db } from "@/lib/firebase/client";
import { isGuestSession, seedGuestSession } from "@/lib/guestMode";
import { canonicalDataTeamId } from "@/lib/sisterTeam";
import type { Team, UserProfile } from "@/lib/types";
import { type User, onAuthStateChanged } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { createContext, useContext, useEffect, useState } from "react";

interface AuthState {
  user: User | null;
  profile: UserProfile | null;
  /** Own team doc, including sister-link fields. Null until loaded. */
  team: Team | null;
  /**
   * Where shared scouting data lives: the canonical store for a linked
   * sister pair (see src/lib/sisterTeam.ts), or the team's own id when
   * unlinked. Null until the profile and team doc resolve. The picklist is
   * the one thing that must keep using profile.teamId instead.
   */
  dataTeamId: string | null;
  /**
   * Whether this account holds owners/{uid} — the app operator, who reviews
   * team claims on /owner. The doc is created by hand in the Firebase console
   * and firestore.rules forbids every client from writing one, so this is the
   * one authority the app itself can't mint.
   */
  isOwner: boolean;
  /** A throwaway session against an in-memory store; see src/lib/guestMode.ts. */
  isGuest: boolean;
  loading: boolean;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  // Tagged with the teamId it came from so a stale snapshot (after switching
  // accounts) is ignored at render time instead of reset via effect.
  const [teamState, setTeamState] = useState<{
    teamId: string;
    team: Team | null;
  } | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(true);
  // Tagged with its uid for the same reason teamState is: a snapshot that
  // arrives after an account switch must not be read as the new user's.
  const [ownerState, setOwnerState] = useState<{
    uid: string;
    isOwner: boolean;
  } | null>(null);
  // Read once at mount rather than from user.isAnonymous, because the mode is
  // fixed at page load (it decided which Firestore cache exists) and pages
  // need the answer before auth resolves.
  const [isGuest] = useState(isGuestSession);

  useEffect(() => {
    return onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthLoading(false);
      if (nextUser) {
        setProfileLoading(true);
      } else {
        setProfile(null);
        setProfileLoading(false);
      }
    });
  }, []);

  useEffect(() => {
    if (!user) return;

    return onSnapshot(doc(db, "users", user.uid), (snapshot) => {
      const data = snapshot.data();
      setProfile(data ? ({ uid: user.uid, ...data } as UserProfile) : null);
      setProfileLoading(false);
    });
  }, [user]);

  // Owner rights ride along with the profile so /owner can decide without a
  // round trip. A non-owner reads their own missing doc and gets "doesn't
  // exist" rather than a permission error, which is why the rule is scoped to
  // request.auth.uid.
  useEffect(() => {
    // No reset when signed out: ownerState carries the uid it came from and is
    // ignored at render unless it matches, exactly as teamState is. Clearing it
    // here would be a synchronous setState inside an effect for no gain.
    if (!user) return;
    return onSnapshot(
      doc(db, "owners", user.uid),
      (snapshot) => setOwnerState({ uid: user.uid, isOwner: snapshot.exists() }),
      () => setOwnerState({ uid: user.uid, isOwner: false }),
    );
  }, [user]);

  // A guest has no server-side profile and never will, so write one into the
  // local cache the first time we notice it missing. Everything downstream
  // then reads a perfectly ordinary profile.
  useEffect(() => {
    if (!isGuest || !user || profileLoading || profile) return;
    void seedGuestSession(db, user.uid).catch(() => {});
  }, [isGuest, user, profile, profileLoading]);

  // The team doc rides along with the profile so every page knows the
  // sister-link state (and therefore where shared data lives) without its
  // own subscription.
  useEffect(() => {
    const teamId = profile?.teamId;
    if (!teamId) return;
    return onSnapshot(doc(db, "teams", teamId), (snapshot) => {
      setTeamState({
        teamId,
        team: snapshot.exists() ? (snapshot.data() as Team) : null,
      });
    });
  }, [profile?.teamId]);

  const teamLoaded = !profile || teamState?.teamId === profile.teamId;
  const team = profile && teamLoaded ? (teamState?.team ?? null) : null;
  const ownerLoaded = !user || ownerState?.uid === user.uid;
  const isOwner = (user && ownerLoaded && ownerState?.isOwner) ?? false;
  const loading = authLoading || profileLoading || !teamLoaded || !ownerLoaded;
  const dataTeamId = profile
    ? canonicalDataTeamId(profile.teamId, team?.sisterTeamId)
    : null;

  return (
    <AuthContext.Provider
      value={{ user, profile, team, dataTeamId, isOwner, isGuest, loading }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
