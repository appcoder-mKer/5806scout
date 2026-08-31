"use client";

import { useAuth } from "@/lib/auth/AuthProvider";
import { db } from "@/lib/firebase/client";
import { memberStatus } from "@/lib/membership";
import { declineClaim, foundTeam } from "@/lib/teamClaimOps";
import { EVIDENCE_LABELS, type TeamClaim } from "@/lib/teamClaims";
import type { Team, UserProfile } from "@/lib/types";
import { collection, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";

// The operator's desk. Deliberately absent from src/lib/nav.ts: this is the
// one page that isn't scoped to a team, and every other admin surface belongs
// to whoever runs a team rather than whoever runs the app.
//
// Authority comes from owners/{uid}, a document created by hand in the Firebase
// console and unwritable by every client (firestore.rules). That is the point —
// it's the one authority the app cannot mint for itself, so no bug in here can hand it
// out.

export default function OwnerPage() {
  const { user, isOwner, loading } = useAuth();
  const [claims, setClaims] = useState<(TeamClaim & { id: string })[]>([]);
  const [teams, setTeams] = useState<(Team & { id: string })[]>([]);
  const [members, setMembers] = useState<UserProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOwner) return;
    const unsubClaims = onSnapshot(collection(db, "teamClaims"), (snap) =>
      setClaims(
        snap.docs.map((d) => ({ ...(d.data() as TeamClaim), id: d.id })),
      ),
    );
    const unsubTeams = onSnapshot(collection(db, "teams"), (snap) =>
      setTeams(snap.docs.map((d) => ({ ...(d.data() as Team), id: d.id }))),
    );
    const unsubUsers = onSnapshot(collection(db, "users"), (snap) =>
      setMembers(
        snap.docs.map((d) => ({ uid: d.id, ...d.data() }) as UserProfile),
      ),
    );
    return () => {
      unsubClaims();
      unsubTeams();
      unsubUsers();
    };
  }, [isOwner]);

  if (loading) return null;
  if (!isOwner) {
    return (
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <p className="text-sm text-graphite-600">
          This page is for the people who run the app.
        </p>
      </main>
    );
  }

  const pendingClaims = claims.filter((c) => c.status === "pending");
  // Teams nobody can administer: either they predate the gate (the migration
  // case — no claim was ever filed for them) or their claim was declined.
  const orphanTeams = teams.filter(
    (t) =>
      !members.some(
        (m) =>
          m.teamId === t.id &&
          m.role === "admin" &&
          memberStatus(m) === "approved",
      ),
  );

  async function found(
    teamId: string,
    memberUid: string,
    claimId?: string,
  ) {
    if (!user) return;
    setBusyId(claimId ?? memberUid);
    setError(null);
    try {
      await foundTeam({ teamId, memberUid, decidedByUid: user.uid, claimId });
    } catch {
      setError("That didn't go through — try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function decline(claimId: string) {
    if (!user) return;
    setBusyId(claimId);
    setError(null);
    try {
      await declineClaim({ claimId, decidedByUid: user.uid });
    } catch {
      setError("That didn't go through — try again.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6 px-4 py-6">
      <div>
        <h1 className="page-title">
          <span aria-hidden className="page-rule" />
          Operator
        </h1>
        <p className="page-lede">
          Teams asking to be set up, and teams with nobody to run them.
        </p>
      </div>

      {error && (
        <p className="badge-error rounded-md px-3 py-2 text-sm normal-case tracking-normal">
          {error}
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-graphite-900">
          Requests ({pendingClaims.length})
        </h2>
        {pendingClaims.length === 0 && (
          <p className="text-sm text-graphite-500">Nothing waiting.</p>
        )}
        {pendingClaims.map((claim) => (
          <article key={claim.id} className="surface-card flex flex-col gap-3 p-4">
            <div>
              <p className="text-sm font-medium text-graphite-900">
                Team <span className="stat">{claim.teamNumber}</span>
              </p>
              <p className="text-xs text-graphite-500">
                {claim.requestedByName} · {claim.requestedByEmail}
              </p>
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
              <span className="text-graphite-600">
                Sent:{" "}
                <span className="font-medium text-graphite-900">
                  {EVIDENCE_LABELS[claim.evidenceKind] ?? claim.evidenceKind}
                </span>
              </span>
              <span className="text-graphite-600">
                Code should read:{" "}
                <span className="stat tracking-widest text-graphite-900">
                  {claim.freshnessCode}
                </span>
              </span>
            </div>

            {claim.evidenceNote && (
              <p className="rounded-md border border-graphite-200 bg-graphite-50 px-3 py-2 text-sm text-graphite-700">
                {claim.evidenceNote}
              </p>
            )}

            {claim.evidenceImage && (
              /* eslint-disable-next-line @next/next/no-img-element -- a data
                 URL held in the document; there is no asset to optimise. */
              <img
                src={claim.evidenceImage}
                alt={`Evidence sent for team ${claim.teamNumber}`}
                className="max-h-96 w-full rounded-md border border-graphite-200 object-contain"
              />
            )}

            <div className="flex gap-2">
              <button
                type="button"
                disabled={busyId === claim.id}
                onClick={() =>
                  void found(claim.teamId, claim.requestedByUid, claim.id)
                }
                className="btn-primary px-4 py-2"
              >
                Approve as first admin
              </button>
              <button
                type="button"
                disabled={busyId === claim.id}
                onClick={() => void decline(claim.id)}
                className="btn-secondary px-4 py-2"
              >
                Decline
              </button>
            </div>
          </article>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-graphite-900">
          Teams with no admin ({orphanTeams.length})
        </h2>
        <p className="text-xs text-graphite-500">
          Teams that existed before approval did. Pick who runs each one; they
          approve the rest of their roster themselves.
        </p>
        {orphanTeams.length === 0 && (
          <p className="text-sm text-graphite-500">Every team has an admin.</p>
        )}
        {orphanTeams.map((team) => {
          const roster = members.filter((m) => m.teamId === team.id);
          return (
            <article key={team.id} className="surface-card flex flex-col gap-3 p-4">
              <p className="text-sm font-medium text-graphite-900">
                Team <span className="stat">{team.teamNumber ?? team.id}</span>
                {team.teamName && team.teamName !== team.teamNumber
                  ? ` — ${team.teamName}`
                  : ""}
              </p>
              {roster.length === 0 && (
                <p className="text-xs text-graphite-500">
                  Nobody has signed up for this team.
                </p>
              )}
              <ul className="divide-y divide-graphite-100">
                {roster.map((member) => (
                  <li
                    key={member.uid}
                    className="flex flex-wrap items-center justify-between gap-3 py-2"
                  >
                    <div>
                      <p className="text-sm text-graphite-900">
                        {member.fullName}
                      </p>
                      <p className="text-xs text-graphite-500">{member.email}</p>
                    </div>
                    <button
                      type="button"
                      disabled={busyId === member.uid}
                      onClick={() => void found(team.id, member.uid)}
                      className="btn-secondary px-3 py-1.5 text-sm"
                    >
                      Make first admin
                    </button>
                  </li>
                ))}
              </ul>
            </article>
          );
        })}
      </section>
    </div>
  );
}
