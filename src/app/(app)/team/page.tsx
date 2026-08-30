"use client";

import { DataExport } from "@/components/DataExport";
import { DataReset } from "@/components/DataReset";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  assignMatchScouts,
  assignPitScouts,
  type MatchAssignmentsDoc,
  type PitAssignmentsDoc,
} from "@/lib/assignments";
import {
  clampMatchesPerScout,
  DUTY_LABELS,
  dutyFor,
  eligibleUids,
  emptyScoutDutiesDoc,
  MAX_MATCHES_PER_SCOUT,
  MIN_MATCHES_PER_SCOUT,
  sanitizeScoutDutiesDoc,
  SCOUT_DUTIES,
  SCOUT_DUTIES_DOC_ID,
  type ScoutDutiesDoc,
  type ScoutDuty,
} from "@/lib/scoutDuty";
import { showsInRoster } from "@/lib/emailVerification";
import type { EventData } from "@/lib/eventData";
import { auth, db } from "@/lib/firebase/client";
import {
  createSisterInvite,
  redeemSisterInvite,
  unlinkSisterTeam,
} from "@/lib/sisterTeamOps";
import type { UserProfile } from "@/lib/types";
import {
  collection,
  doc,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { signOut } from "firebase/auth";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

// Said in two places — the disabled Delete button's tooltip and the error a
// click produces — so it reads the same either way. The route says the same
// thing in its own words when the browser is out of date.
const LAST_ADMIN_MESSAGE =
  "Make someone else an admin first, then you can delete your account.";

// Config writes live at module scope: each stamps its own "when", which keeps
// the clock read out of the component body entirely (where the React Compiler
// has to assume anything it can't trace might run during render).

async function writePitAssignments(
  teamId: string,
  byScout: PitAssignmentsDoc["byScout"],
  scoutNames: PitAssignmentsDoc["scoutNames"],
): Promise<void> {
  await setDoc(doc(db, "teams", teamId, "config", "pitAssignments"), {
    byScout,
    scoutNames,
    generatedAt: Date.now(),
  } satisfies PitAssignmentsDoc);
}

async function writeMatchAssignments(
  teamId: string,
  slots: MatchAssignmentsDoc["slots"],
  scoutNames: MatchAssignmentsDoc["scoutNames"],
): Promise<void> {
  await setDoc(doc(db, "teams", teamId, "config", "matchAssignments"), {
    slots,
    scoutNames,
    generatedAt: Date.now(),
  } satisfies MatchAssignmentsDoc);
}

async function writeScoutDuties(
  teamId: string,
  next: Omit<ScoutDutiesDoc, "updatedAt">,
): Promise<void> {
  await setDoc(doc(db, "teams", teamId, "config", SCOUT_DUTIES_DOC_ID), {
    ...next,
    updatedAt: Date.now(),
  } satisfies ScoutDutiesDoc);
}

export default function TeamPage() {
  const router = useRouter();
  const { profile, user, team, dataTeamId } = useAuth();
  const [roster, setRoster] = useState<UserProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [event, setEvent] = useState<EventData | null>(null);
  const [hasPitAssignments, setHasPitAssignments] = useState(false);
  const [hasMatchAssignments, setHasMatchAssignments] = useState(false);
  const [assignSuccess, setAssignSuccess] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteSending, setInviteSending] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkMessage, setLinkMessage] = useState<string | null>(null);
  const [dutiesDoc, setDutiesDoc] =
    useState<ScoutDutiesDoc>(emptyScoutDutiesDoc);
  const [deletingUid, setDeletingUid] = useState<string | null>(null);

  // Roster pools both teams when a sister team is linked, so assignments
  // split the work across every active scout in the pair.
  useEffect(() => {
    if (!profile) return;
    const teamIds = [profile.teamId, team?.sisterTeamId].filter(
      (id): id is string => !!id,
    );
    const byTeam = new Map<string, UserProfile[]>();
    const unsubs = teamIds.map((teamId) =>
      onSnapshot(
        query(collection(db, "users"), where("teamId", "==", teamId)),
        (snapshot) => {
          byTeam.set(
            teamId,
            snapshot.docs
              .map((d) => {
                const data = d.data();
                return {
                  uid: d.id,
                  email: (data.email as string) ?? "",
                  fullName: (data.fullName as string) ?? "",
                  teamId: (data.teamId as string) ?? "",
                  role: (data.role as UserProfile["role"]) ?? "scout",
                  active: (data.active as boolean) ?? true,
                  emailVerified: data.emailVerified as boolean | undefined,
                };
              })
              .filter(showsInRoster),
          );
          setRoster(
            teamIds
              .flatMap((id) => byTeam.get(id) ?? [])
              .sort((a, b) => a.fullName.localeCompare(b.fullName)),
          );
        },
      ),
    );
    return () => unsubs.forEach((unsub) => unsub());
  }, [profile, team?.sisterTeamId]);

  // Event + assignment docs live in the shared store.
  useEffect(() => {
    if (!dataTeamId) return;
    const unsubEvent = onSnapshot(
      doc(db, "teams", dataTeamId, "config", "event"),
      (s) => {
        setEvent(s.exists() ? (s.data() as EventData) : null);
      },
    );
    const unsubPit = onSnapshot(
      doc(db, "teams", dataTeamId, "config", "pitAssignments"),
      (s) => setHasPitAssignments(s.exists()),
    );
    const unsubMatch = onSnapshot(
      doc(db, "teams", dataTeamId, "config", "matchAssignments"),
      (s) => setHasMatchAssignments(s.exists()),
    );
    const unsubDuties = onSnapshot(
      doc(db, "teams", dataTeamId, "config", SCOUT_DUTIES_DOC_ID),
      (s) => setDutiesDoc(sanitizeScoutDutiesDoc(s.data())),
    );
    return () => {
      unsubDuties();
      unsubEvent();
      unsubPit();
      unsubMatch();
    };
  }, [dataTeamId]);

  const isAdmin = profile?.role === "admin";
  // Own team only: a sister team's admins are no help here, since neither
  // team may touch the other's roster.
  const ownTeamAdmins = roster.filter(
    (m) => m.teamId === profile?.teamId && m.role === "admin",
  );
  const isLastAdmin = isAdmin && ownTeamAdmins.length <= 1;
  const activeScouts = roster.filter((m) => m.role === "scout" && m.active);
  const activeScoutUids = activeScouts.map((m) => m.uid);

  // Only the three scouting duties reach an assignment run — a Viewer, the
  // drive team, and the pit crew all have somewhere else to be.
  const matchScoutUids = eligibleUids("match", dutiesDoc.duties, activeScoutUids);
  const pitScoutUids = eligibleUids("pit", dutiesDoc.duties, activeScoutUids);
  const matchesPerScout = clampMatchesPerScout(dutiesDoc.matchesPerScout);
  // Six stations need six scouts at all times, so a crew of six or fewer works
  // every match no matter how short the shift is set.
  const crewTooSmallToRotate =
    matchScoutUids.length > 0 && matchScoutUids.length <= 6;

  function scoutNames(): Record<string, string> {
    return Object.fromEntries(activeScouts.map((m) => [m.uid, m.fullName]));
  }

  async function saveDuties(next: Omit<ScoutDutiesDoc, "updatedAt">) {
    if (!dataTeamId) return;
    setError(null);
    try {
      await writeScoutDuties(dataTeamId, next);
    } catch {
      setError("Could not save scouting duties — check your connection.");
    }
  }

  function setDuty(uid: string, duty: ScoutDuty) {
    void saveDuties({
      ...dutiesDoc,
      duties: { ...dutiesDoc.duties, [uid]: duty },
    });
  }

  async function handleAssignPit() {
    if (!profile || !event || !dataTeamId) return;
    if (
      hasPitAssignments &&
      !window.confirm(
        "Pit scouting assignments already exist. Replace them with a fresh random assignment?",
      )
    ) {
      return;
    }
    setError(null);
    setAssignSuccess(null);
    try {
      const byScout = assignPitScouts(
        event.teams.map((t) => t.teamNumber),
        pitScoutUids,
      );
      await writePitAssignments(dataTeamId, byScout, scoutNames());
      setAssignSuccess(
        `Pit scouting: ${event.teams.length} teams split across ${pitScoutUids.length} scout${pitScoutUids.length === 1 ? "" : "s"} — see the Assignments tab.`,
      );
    } catch {
      setError("Could not save pit assignments — check your connection.");
    }
  }

  async function handleAssignMatch() {
    if (!profile || !event || !dataTeamId) return;
    if (
      hasMatchAssignments &&
      !window.confirm(
        "Match scouting assignments already exist. Replace them with a fresh random assignment?",
      )
    ) {
      return;
    }
    setError(null);
    setAssignSuccess(null);
    try {
      const slots = assignMatchScouts(
        event.matches,
        matchScoutUids,
        matchesPerScout,
      );
      await writeMatchAssignments(dataTeamId, slots, scoutNames());
      setAssignSuccess(
        `Match scouting: ${event.matches.length} matches covered by ${matchScoutUids.length} scout${matchScoutUids.length === 1 ? "" : "s"}, ${matchesPerScout} match${matchesPerScout === 1 ? "" : "es"} each before rotating off — see the Assignments tab.`,
      );
    } catch {
      setError("Could not save match assignments — check your connection.");
    }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setError(null);
    setInviteSuccess(null);
    setInviteSending(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/invite-scout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ fullName: inviteName, email: inviteEmail }),
      });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; invited?: string }
        | null;
      if (!res.ok) {
        setError(body?.error ?? "Could not send the invite.");
        return;
      }
      setInviteSuccess(
        `Invite sent to ${body?.invited ?? inviteEmail} — they'll get an email to set their password, and join the roster below once they've opened it.`,
      );
      setInviteName("");
      setInviteEmail("");
      setShowInvite(false);
    } catch {
      setError("Could not send the invite — check your connection.");
    } finally {
      setInviteSending(false);
    }
  }

  async function handleGenerateCode() {
    if (!profile || !user || !team) return;
    setError(null);
    setLinkMessage(null);
    setLinkBusy(true);
    try {
      setLinkCode(
        await createSisterInvite({ teamId: profile.teamId, team, uid: user.uid }),
      );
    } catch {
      setError("Could not create a link code — check your connection.");
    } finally {
      setLinkBusy(false);
    }
  }

  async function handleRedeem(e: React.FormEvent) {
    e.preventDefault();
    if (!profile || !team) return;
    setError(null);
    setLinkMessage(null);
    setLinkBusy(true);
    try {
      await redeemSisterInvite({
        code: codeInput,
        myTeamId: profile.teamId,
        myTeam: team,
      });
      setCodeInput("");
      setLinkCode(null);
      setLinkMessage(
        "Linked! Both teams now share scouting data, assignments, and the event.",
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not link — try again.",
      );
    } finally {
      setLinkBusy(false);
    }
  }

  async function handleUnlink() {
    if (!profile || !team?.sisterTeamId) return;
    if (
      !window.confirm(
        `Unlink from Team ${team.sisterTeamNumber}? Both teams keep a full copy of the shared scouting data; picklists were never shared.`,
      )
    ) {
      return;
    }
    setError(null);
    setLinkMessage(null);
    setLinkBusy(true);
    try {
      await unlinkSisterTeam({ myTeamId: profile.teamId, myTeam: team });
      setLinkMessage("Unlinked — each team keeps its own copy of the data.");
    } catch {
      setError("Could not unlink — check your connection.");
    } finally {
      setLinkBusy(false);
    }
  }

  async function toggleActive(member: UserProfile) {
    if (!profile) return;
    setError(null);
    try {
      await updateDoc(doc(db, "users", member.uid), { active: !member.active });
    } catch {
      setError("Could not update that scout — check your connection.");
    }
  }

  /**
   * Promote a teammate to admin, or hand them back to scout. A team can have
   * as many admins as it likes; the signup form's single-admin gate only
   * covers who claims the team first, and every admin after that is made here.
   *
   * Admins can't change their own role — that's what keeps a team from
   * demoting its way out of having any admin at all.
   */
  async function toggleRole(member: UserProfile) {
    if (!profile || member.uid === user?.uid) return;
    const promoting = member.role !== "admin";
    if (
      !window.confirm(
        promoting
          ? `Make ${member.fullName} an admin? They'll be able to edit forms, assign scouting, manage the roster, and promote other admins.`
          : `Return ${member.fullName} to scout? They'll lose access to the admin tabs.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      await updateDoc(doc(db, "users", member.uid), {
        role: promoting ? "admin" : "scout",
      });
    } catch {
      setError("Could not change that member's role — check your connection.");
    }
  }

  /**
   * Permanently delete a teammate — or yourself: both the login and the roster
   * entry go, which frees that email so the person can sign up again or be
   * invited back. Unlike Deactivate this cannot be undone, hence the confirm.
   *
   * Runs through /api/delete-member because deleting an auth account needs the
   * service account — firestore.rules still forbids every client from deleting
   * a users/{uid} doc.
   *
   * Deleting yourself is the one case that can leave a team stranded, so the
   * last admin is turned away here and again in the route (which is the check
   * that actually counts — this one just saves a round trip).
   */
  async function deleteMember(member: UserProfile) {
    if (!profile || !user) return;
    const isSelf = member.uid === user.uid;

    if (isSelf && isLastAdmin) {
      setError(LAST_ADMIN_MESSAGE);
      return;
    }
    if (
      !window.confirm(
        isSelf
          ? `Permanently delete your own account? You'll be signed out and removed from Team ${profile.teamId}. It cannot be undone — you would have to sign up again or be invited back.`
          : `Permanently delete ${member.fullName}? This deletes their account and removes them from the roster. It cannot be undone — they would have to sign up again or be invited back.`,
      )
    ) {
      return;
    }
    setError(null);
    setDeletingUid(member.uid);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/delete-member", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ uid: member.uid }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) {
        setError(body?.error ?? "Could not delete that member — try again.");
        return;
      }
      // Deleting yourself leaves this tab holding a token for an account that
      // no longer exists, and the roster listener has nothing to remove it
      // from — so end the session explicitly rather than waiting for the next
      // token refresh to fail.
      if (isSelf) {
        await signOut(auth).catch(() => {});
        router.replace("/login");
      }
      // Otherwise the roster listener drops the row on its own.
    } catch {
      setError("Could not delete that member — check your connection.");
    } finally {
      setDeletingUid(null);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 md:px-6">
      <div>
        <h1 className="page-title">
          <span aria-hidden className="page-rule" />
          Team {team?.teamNumber ?? profile?.teamId}
          {team?.teamName && team.teamName !== team.teamNumber
            ? ` — ${team.teamName}`
            : ""}
        </h1>
        <p className="page-lede">
          {roster.length} member{roster.length === 1 ? "" : "s"}.
          {isAdmin &&
            " Deactivated scouts keep their account but should hand off duties."}
        </p>
      </div>

      {isAdmin && (
        <div className="surface-card flex flex-col gap-2 p-4">
          <p className="text-sm font-medium text-graphite-900">
            Scouting assignments
          </p>
          <p className="text-xs text-graphite-500">
            {!event
              ? "Sync an event on the Event tab first."
              : `Pit: ${event.teams.length} event teams split across ${pitScoutUids.length} pit scout${pitScoutUids.length === 1 ? "" : "s"}. Match: ${event.matches.length} matches across ${matchScoutUids.length} match scout${matchScoutUids.length === 1 ? "" : "s"}, each holding one station for ${matchesPerScout} match${matchesPerScout === 1 ? "" : "es"} before rotating off. Only the Match and Pit / Pit / Match duties are included. Results appear in the Assignments tab.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!event || pitScoutUids.length === 0 || event.teams.length === 0}
              onClick={() => void handleAssignPit()}
              className="btn-primary px-4 py-2"
            >
              Assign Pit Scout
            </button>
            <button
              type="button"
              disabled={
                !event || matchScoutUids.length === 0 || event.matches.length === 0
              }
              onClick={() => void handleAssignMatch()}
              className="btn-primary px-4 py-2"
            >
              Assign Match Scout
            </button>
          </div>
          {event && activeScouts.length === 0 && (
            <p className="text-xs text-amber-700">
              No active members with the scout role — add or reactivate scouts
              below.
            </p>
          )}
          {event && activeScouts.length > 0 && (
            <>
              {pitScoutUids.length === 0 && (
                <p className="text-xs text-amber-700">
                  Nobody is set to pit scouting — give someone the Pit or Match
                  and Pit duty below.
                </p>
              )}
              {matchScoutUids.length === 0 && (
                <p className="text-xs text-amber-700">
                  Nobody is set to match scouting — give someone the Match or
                  Match and Pit duty below.
                </p>
              )}
              {crewTooSmallToRotate && (
                <p className="text-xs text-amber-700">
                  Every match needs 6 scouts at once, so with{" "}
                  {matchScoutUids.length} match scout
                  {matchScoutUids.length === 1 ? "" : "s"} nobody rotates off —
                  they&apos;ll cover the whole schedule
                  {matchScoutUids.length < 6
                    ? ", doubling up on stations"
                    : ""}
                  . Add a 7th to start giving people breaks.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {isAdmin && (
        <div className="surface-card flex flex-col gap-3 p-4">
          <div>
            <p className="text-sm font-medium text-graphite-900">
              Match shift length
            </p>
            <p className="mt-1 text-xs text-graphite-500">
              A match scout holds one station — Red 1, Blue 3, and so on — for
              this many matches in a row, then hands it to the next scout and
              comes off duty. Shorter shifts rotate more people through; longer
              ones mean fewer handoffs to miss.
            </p>
          </div>
          <label className="flex flex-wrap items-center gap-2 text-sm text-graphite-700">
            <span>Matches per scout</span>
            <input
              type="number"
              min={MIN_MATCHES_PER_SCOUT}
              max={MAX_MATCHES_PER_SCOUT}
              value={dutiesDoc.matchesPerScout}
              onChange={(e) =>
                void saveDuties({
                  ...dutiesDoc,
                  matchesPerScout: clampMatchesPerScout(Number(e.target.value)),
                })
              }
              className="field-input stat w-20 py-1.5"
            />
            <span className="text-xs text-graphite-500">
              before they rotate off
            </span>
          </label>
        </div>
      )}

      {assignSuccess && (
        <p className="badge-success rounded-md px-3 py-2 text-sm normal-case tracking-normal">
          {assignSuccess}
        </p>
      )}


      {isAdmin && (
        <div className="surface-card flex flex-col gap-2 p-4">
          <p className="text-sm font-medium text-graphite-900">Sister team</p>
          {team?.sisterTeamId ? (
            <>
              <p className="text-xs text-graphite-500">
                Linked with Team {team.sisterTeamNumber}
                {team.sisterTeamName &&
                team.sisterTeamName !== team.sisterTeamNumber
                  ? ` — ${team.sisterTeamName}`
                  : ""}
                . Both teams share scouting data, assignments, talkie, and the
                synced event; each team keeps its own picklist and Do Not Pick
                list.
              </p>
              <button
                type="button"
                disabled={linkBusy}
                onClick={() => void handleUnlink()}
                className="btn-secondary self-start border-maroon-200 dark:border-maroon-700 px-4 py-2 text-maroon-700 dark:text-maroon-300 hover:border-maroon-400"
              >
                {linkBusy ? "Unlinking…" : "Unlink sister team"}
              </button>
            </>
          ) : (
            <>
              <p className="text-xs text-graphite-500">
                Pair up with your sister team to share all scouting data and
                split the collection work — picklists stay separate. One
                team&apos;s admin generates a code; the other enters it here.
              </p>
              {linkCode ? (
                <p className="surface-panel rounded-md px-3 py-2 text-sm text-graphite-700">
                  Share this code with their admin (valid for 24 hours):{" "}
                  <span className="stat text-lg font-bold tracking-widest text-graphite-900">
                    {linkCode}
                  </span>
                </p>
              ) : (
                <button
                  type="button"
                  disabled={linkBusy}
                  onClick={() => void handleGenerateCode()}
                  className="btn-primary self-start px-4 py-2"
                >
                  Generate link code
                </button>
              )}
              <form onSubmit={handleRedeem} className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Code from your sister team"
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value)}
                  className="field-input stat w-56 uppercase tracking-widest"
                />
                <button
                  type="submit"
                  disabled={linkBusy || !codeInput.trim()}
                  className="btn-primary px-4 py-2"
                >
                  {linkBusy ? "Linking…" : "Link"}
                </button>
              </form>
            </>
          )}
          {linkMessage && (
            <p className="badge-success rounded-md px-3 py-2 text-sm normal-case tracking-normal">
              {linkMessage}
            </p>
          )}
        </div>
      )}

      {isAdmin && (
        <div className="flex flex-col gap-3">
          {!showInvite && (
            <button
              type="button"
              onClick={() => {
                setShowInvite(true);
                setInviteSuccess(null);
              }}
              className="btn-primary self-start px-4 py-2"
            >
              Add scout
            </button>
          )}
          {showInvite && (
            <form
              onSubmit={handleInvite}
              className="surface-card flex flex-col gap-3 p-4"
            >
              <p className="text-sm font-medium text-graphite-900">
                Add a scout
              </p>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-graphite-700">
                  Full name
                </span>
                <input
                  required
                  type="text"
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                  className="field-input"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-graphite-700">
                  Email
                </span>
                <input
                  required
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  className="field-input"
                />
              </label>
              <p className="text-xs text-graphite-500">
                They&apos;ll get an email inviting them to set a password and
                log in.
              </p>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={inviteSending}
                  className="btn-primary px-4 py-2"
                >
                  {inviteSending ? "Sending invite…" : "Send invite"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowInvite(false)}
                  className="btn-secondary px-4 py-2"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {inviteSuccess && (
        <p className="badge-success rounded-md px-3 py-2 text-sm normal-case tracking-normal">
          {inviteSuccess}
        </p>
      )}

      {error && (
        <p className="badge-error rounded-md px-3 py-2 text-sm normal-case tracking-normal">
          {error}
        </p>
      )}

      <ul className="surface-card divide-y divide-graphite-100">
        {roster.map((member) => (
          <li
            key={member.uid}
            className="flex items-center justify-between gap-3 px-4 py-3 transition hover:bg-graphite-50"
          >
            <div className={member.active ? "" : "opacity-50"}>
              <p className="text-sm font-medium text-graphite-900">
                {member.fullName}
                {member.uid === user?.uid && (
                  <span className="ml-1.5 text-xs text-graphite-400">(you)</span>
                )}
              </p>
              {/* A teammate's email is roster admin, not roster info: only
                  an admin sees the column, and a scout sees nothing but
                  their own address. */}
              {(isAdmin || member.uid === user?.uid) && (
                <p className="text-xs text-graphite-500">{member.email}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {member.teamId !== profile?.teamId && (
                <span className="rounded bg-sky-50 px-1.5 py-0.5 text-xs font-semibold text-sky-700 dark:text-sky-300">
                  {team?.sisterTeamNumber ?? member.teamId}
                </span>
              )}
              <span
                className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                  member.role === "admin"
                    ? "bg-maroon-50 text-maroon-700 dark:text-maroon-300"
                    : "bg-graphite-100 text-graphite-600"
                }`}
              >
                {member.role}
              </span>
              {!member.active && (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-900 dark:text-amber-200">
                  inactive
                </span>
              )}
              {/* Only the first three duties go into a rotation; the rest
                  mark someone as busy elsewhere. Shown for scouts on either
                  team of a sister pair, since both share the schedule. */}
              {isAdmin && member.role === "scout" && member.active && (
                <select
                  value={dutyFor(dutiesDoc.duties, member.uid)}
                  aria-label={`Scouting duty for ${member.fullName}`}
                  onChange={(e) =>
                    setDuty(member.uid, e.target.value as ScoutDuty)
                  }
                  className="field-input w-auto py-1 text-xs"
                >
                  {SCOUT_DUTIES.map((duty) => (
                    <option key={duty} value={duty}>
                      {DUTY_LABELS[duty]}
                    </option>
                  ))}
                </select>
              )}
              {!isAdmin && member.role === "scout" && member.active && (
                <span className="rounded bg-graphite-100 px-1.5 py-0.5 text-xs font-semibold text-graphite-600">
                  {DUTY_LABELS[dutyFor(dutiesDoc.duties, member.uid)]}
                </span>
              )}
              {/* Your own row gets one action: leave the team for good. The
                  role and active toggles are withheld on purpose — an admin
                  demoting or deactivating themselves is how a team ends up
                  with nobody who can put it right. */}
              {isAdmin && member.uid === user?.uid && (
                <button
                  type="button"
                  onClick={() => void deleteMember(member)}
                  disabled={deletingUid === member.uid || isLastAdmin}
                  title={
                    isLastAdmin
                      ? LAST_ADMIN_MESSAGE
                      : "Permanently delete your own account"
                  }
                  className="btn-ghost border border-maroon-200 px-2.5 py-1 text-maroon-700 dark:border-maroon-700 dark:text-maroon-300 disabled:opacity-40"
                >
                  {deletingUid === member.uid ? "Deleting…" : "Delete my account"}
                </button>
              )}
              {isAdmin && member.uid !== user?.uid && member.teamId === profile?.teamId && (
                <>
                  <button
                    type="button"
                    onClick={() => void toggleRole(member)}
                    className="btn-ghost border border-graphite-200 px-2.5 py-1"
                  >
                    {member.role === "admin" ? "Make scout" : "Make admin"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void toggleActive(member)}
                    className="btn-ghost border border-graphite-200 px-2.5 py-1"
                  >
                    {member.active ? "Deactivate" : "Reactivate"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteMember(member)}
                    disabled={deletingUid === member.uid}
                    title={`Permanently delete ${member.fullName}`}
                    className="btn-ghost border border-maroon-200 px-2.5 py-1 text-maroon-700 dark:border-maroon-700 dark:text-maroon-300 disabled:opacity-40"
                  >
                    {deletingUid === member.uid ? "Deleting…" : "Delete"}
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      {isAdmin && isLastAdmin && (
        <p className="text-xs text-graphite-500">
          You&apos;re the only admin on this team, so your own account is
          locked. {LAST_ADMIN_MESSAGE}
        </p>
      )}

      {/* Last on the page, in workflow order: download the season, then wipe
          it. The reset is destructive and deliberately sits below everything
          an admin uses day to day. */}
      {isAdmin && <DataExport />}
      {isAdmin && <DataReset />}
    </main>
  );
}
