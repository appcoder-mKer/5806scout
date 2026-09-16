"use client";

import { MatchVideoReview } from "@/components/MatchVideoReview";
import { aggregateByTeam, type MatchSubmission } from "@/lib/aggregate";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  buildTeamProfiles,
  reviewMatch,
  SCORING_WEIGHTS,
  type MatchReview,
} from "@/lib/drive";
import type { EventData, EventMatch } from "@/lib/eventData";
import { liveEventKey } from "@/lib/manualEvent";
import { db } from "@/lib/firebase/client";
import {
  resolveOffset,
  reviewableMatches,
  type MatchReviewDoc,
  type MatchReviewNote,
} from "@/lib/matchReview";
import { matchLabel } from "@/lib/pitDashboard";
import { useScoutForms } from "@/lib/useScoutForms";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  setDoc,
} from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";

// Film study. Pick a match, watch it, and pin notes to the moments worth
// remembering — with the predictor's call on the same row, so "we got that one
// wrong" and "here's the play that did it" are one click apart.
//
// Video keys aren't in Firestore: TBA only serves them on the full match model
// and the event sync fetches /matches/simple. They come from a live route
// instead, which is also the honest shape — official uploads land hours after
// a match, so a synced value would report "no video" long after one existed.

const NOTES_COLLECTION = "matchReviewNotes";
const REVIEW_COLLECTION = "matchReview";

/**
 * A finished fetch of the event's video keys, stamped with the request it
 * answers. Stamping is what lets "still loading" be derived rather than
 * written from the effect — a result for a stale event or a superseded retry
 * simply stops matching, instead of briefly showing the wrong event's videos.
 */
interface VideoResult {
  token: string;
  keys: Record<string, string>;
  error: string | null;
}

export default function MatchReviewPage() {
  const { profile, team, dataTeamId } = useAuth();
  const { matchSections } = useScoutForms();
  const isAdmin = profile?.role === "admin";

  const [event, setEvent] = useState<EventData | null>(null);
  const [eventLoaded, setEventLoaded] = useState(false);
  const [submissions, setSubmissions] = useState<MatchSubmission[]>([]);
  const [reviewDocs, setReviewDocs] = useState<MatchReviewDoc[]>([]);
  const [notes, setNotes] = useState<MatchReviewNote[]>([]);
  const [videoResult, setVideoResult] = useState<VideoResult | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  useEffect(() => {
    if (!dataTeamId || !isAdmin) return;
    return onSnapshot(doc(db, "teams", dataTeamId, "config", "event"), (s) => {
      setEvent(s.exists() ? (s.data() as EventData) : null);
      setEventLoaded(true);
    });
  }, [dataTeamId, isAdmin]);

  useEffect(() => {
    if (!dataTeamId || !isAdmin) return;
    return onSnapshot(
      collection(db, "teams", dataTeamId, "matchScouting"),
      (snapshot) =>
        setSubmissions(
          snapshot.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              matchNumber: data.matchNumber as number,
              scoutedTeam: data.scoutedTeam as string,
              alliance: data.alliance as "red" | "blue",
              values: data.values ?? {},
              scoutName: (data.scoutName as string) ?? "",
            };
          }),
        ),
    );
  }, [dataTeamId, isAdmin]);

  useEffect(() => {
    if (!dataTeamId || !isAdmin) return;
    return onSnapshot(
      collection(db, "teams", dataTeamId, REVIEW_COLLECTION),
      (snapshot) =>
        setReviewDocs(
          snapshot.docs.map((d) => ({
            matchKey: d.id,
            videoOffsetSeconds: (d.data().videoOffsetSeconds as number) ?? 0,
            confirmed: (d.data().confirmed as boolean) ?? false,
            markedByName: (d.data().markedByName as string) ?? "",
            markedAtMs: (d.data().markedAtMs as number) ?? 0,
          })),
        ),
    );
  }, [dataTeamId, isAdmin]);

  useEffect(() => {
    if (!dataTeamId || !isAdmin) return;
    return onSnapshot(
      collection(db, "teams", dataTeamId, NOTES_COLLECTION),
      (snapshot) =>
        setNotes(
          snapshot.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              matchKey: (data.matchKey as string) ?? "",
              videoSeconds: (data.videoSeconds as number) ?? 0,
              teamNumber: (data.teamNumber as number | null) ?? null,
              text: (data.text as string) ?? "",
              authorUid: (data.authorUid as string) ?? "",
              authorName: (data.authorName as string) ?? "",
              createdAtMs: (data.createdAtMs as number) ?? 0,
            };
          }),
        ),
    );
  }, [dataTeamId, isAdmin]);

  // Video keys come from TBA on open, never from Firestore.
  const eventKey = liveEventKey(event);
  const [videoNonce, setVideoNonce] = useState(0);
  const videoToken = `${eventKey ?? ""}#${videoNonce}`;
  useEffect(() => {
    if (!eventKey || !isAdmin) return;
    let cancelled = false;
    const token = `${eventKey}#${videoNonce}`;
    fetch(`/api/event/${eventKey}/videos`)
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        setVideoResult({
          token,
          keys: res.ok ? (body.videos ?? {}) : {},
          error: res.ok ? null : (body.error ?? "Couldn't load match videos."),
        });
      })
      .catch(() => {
        if (cancelled) return;
        setVideoResult({
          token,
          keys: {},
          error: "Could not reach The Blue Alliance — try again.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [eventKey, isAdmin, videoNonce]);

  const videos = videoResult?.token === videoToken ? videoResult : null;
  const videosLoading = eventKey !== null && videos === null;

  const myTeamNumber = Number(team?.teamNumber);
  const [focusTeam, setFocusTeam] = useState<number | null>(null);
  // Null is "every match at the event", which is the useful default the first
  // time you open the tab — you review whatever just happened.
  const viewedTeam = focusTeam;

  const teamChoices = useMemo(() => {
    const numbers = new Set((event?.teams ?? []).map((t) => t.teamNumber));
    if (Number.isInteger(myTeamNumber)) numbers.add(myTeamNumber);
    return [...numbers].sort((a, b) => a - b);
  }, [event, myTeamNumber]);

  const aggregates = useMemo(
    () => aggregateByTeam(matchSections, submissions),
    [matchSections, submissions],
  );

  const profiles = useMemo(
    () =>
      buildTeamProfiles(
        matchSections,
        aggregates,
        SCORING_WEIGHTS,
        event?.teams ?? [],
      ),
    [matchSections, aggregates, event],
  );

  const noteCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const note of notes) {
      counts.set(note.matchKey, (counts.get(note.matchKey) ?? 0) + 1);
    }
    return counts;
  }, [notes]);

  const rows = useMemo(() => {
    if (!event) return [];
    return reviewableMatches(event.matches, viewedTeam).map((match) => ({
        match,
        review: reviewMatch(match, profiles),
        videoKey: videos?.keys[match.key] ?? null,
        noteCount: noteCounts.get(match.key) ?? 0,
      }));
  }, [event, viewedTeam, profiles, videos, noteCounts]);

  // A match that scrolls off the filter shouldn't stay open underneath it.
  const selected = rows.find((r) => r.match.key === selectedKey) ?? null;

  const called = rows.filter((r) => r.review.called !== null);
  const hits = called.filter((r) => r.review.called).length;

  const offset = selected
    ? resolveOffset(selected.match.key, reviewDocs)
    : null;
  const selectedNotes = useMemo(
    () => notes.filter((n) => n.matchKey === selectedKey),
    [notes, selectedKey],
  );

  async function markStart(matchKey: string, videoSeconds: number) {
    if (!dataTeamId || !profile) return;
    setWriteError(null);
    try {
      await setDoc(doc(db, "teams", dataTeamId, REVIEW_COLLECTION, matchKey), {
        videoOffsetSeconds: videoSeconds,
        confirmed: true,
        markedByName: profile.fullName,
        markedAtMs: Date.now(),
      });
    } catch {
      setWriteError("Couldn't save the match start — check your connection.");
    }
  }

  async function addNote(
    matchKey: string,
    input: { videoSeconds: number; teamNumber: number | null; text: string },
  ) {
    if (!dataTeamId || !profile) return;
    setWriteError(null);
    try {
      await addDoc(collection(db, "teams", dataTeamId, NOTES_COLLECTION), {
        matchKey,
        videoSeconds: input.videoSeconds,
        teamNumber: input.teamNumber,
        text: input.text,
        authorUid: profile.uid,
        authorName: profile.fullName,
        createdAtMs: Date.now(),
      });
    } catch {
      setWriteError("Couldn't save that note — check your connection.");
    }
  }

  async function removeNote(noteId: string) {
    if (!dataTeamId) return;
    setWriteError(null);
    try {
      await deleteDoc(doc(db, "teams", dataTeamId, NOTES_COLLECTION, noteId));
    } catch {
      setWriteError("Couldn't delete that note — check your connection.");
    }
  }

  if (profile && !isAdmin) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 md:px-6">
        <div className="rounded-lg border border-dashed border-graphite-300 bg-graphite-50 px-6 py-12 text-center text-sm text-graphite-500">
          Match Review is only available to admins.
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 md:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">
            <span aria-hidden className="page-rule" />
            Match Review
          </h1>
          <p className="page-lede">
            Watch a match back and pin notes to what mattered.
            {called.length > 0 && (
              <>
                {" "}
                Predictor called{" "}
                <span className="stat">
                  {hits}/{called.length}
                </span>{" "}
                of these.
              </>
            )}
          </p>
        </div>

        <label className="flex flex-col gap-1 text-xs text-graphite-500">
          Team
          <select
            className="field-input w-44"
            value={viewedTeam ?? ""}
            onChange={(e) =>
              setFocusTeam(e.target.value === "" ? null : Number(e.target.value))
            }
          >
            <option value="">Every match</option>
            {teamChoices.map((number) => (
              <option key={number} value={number}>
                {number}
                {number === myTeamNumber ? " (us)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>

      {writeError && (
        <p className="surface-card border-maroon-200 p-3 text-sm text-maroon-700 dark:text-maroon-300">
          {writeError}
        </p>
      )}

      {eventLoaded && !event && (
        <div className="rounded-lg border border-dashed border-graphite-300 bg-graphite-50 px-6 py-12 text-center text-sm text-graphite-500">
          No event synced yet — sync one on the Event tab and matches will show
          up here.
        </div>
      )}

      {event && videos?.error && (
        <div className="surface-panel flex flex-wrap items-center gap-3 p-3 text-sm text-graphite-600">
          <span>{videos.error}</span>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setVideoNonce((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      )}

      {selected?.videoKey && (
        <MatchVideoReview
          key={selected.match.key}
          match={selected.match}
          videoKey={selected.videoKey}
          // Nothing marked anywhere yet: measure from frame one, which shows
          // AUTO 0:20 over a field-reset shot — visibly unmarked rather than
          // quietly plausible.
          offsetSeconds={offset?.seconds ?? 0}
          offsetConfirmed={offset?.confirmed ?? false}
          inheritedFrom={offset?.inheritedFrom ?? null}
          notes={selectedNotes}
          onMarkStart={(seconds) => markStart(selected.match.key, seconds)}
          onAddNote={(note) => addNote(selected.match.key, note)}
          onDeleteNote={removeNote}
          viewerUid={profile?.uid ?? ""}
        />
      )}

      {event && (
        <div className="surface-card overflow-hidden">
          <ul className="divide-y divide-graphite-100">
            {rows.length === 0 && (
              <li className="px-4 py-8 text-center text-sm text-graphite-500">
                {videosLoading
                  ? "Loading matches…"
                  : "No played matches to review yet."}
              </li>
            )}
            {rows.map(({ match, review, videoKey, noteCount }) => (
              <MatchRow
                key={match.key}
                match={match}
                review={review}
                videoKey={videoKey}
                noteCount={noteCount}
                selected={match.key === selectedKey}
                onSelect={() =>
                  setSelectedKey(match.key === selectedKey ? null : match.key)
                }
              />
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}

function MatchRow({
  match,
  review,
  videoKey,
  noteCount,
  selected,
  onSelect,
}: {
  match: EventMatch;
  review: MatchReview;
  videoKey: string | null;
  noteCount: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const redWon = match.winner === "red";
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        disabled={!videoKey}
        aria-pressed={selected}
        className={`flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left transition ${
          selected ? "bg-maroon-50" : "hover:bg-graphite-50"
        } disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <span className="stat w-16 text-sm font-semibold text-graphite-900">
          {matchLabel(match)}
        </span>

        <span className="stat text-sm text-graphite-700">
          <span className={redWon ? "font-semibold text-maroon-700 dark:text-maroon-300" : ""}>
            {match.redScore}
          </span>
          <span className="text-graphite-400"> — </span>
          <span className={match.winner === "blue" ? "font-semibold text-sky-700" : ""}>
            {match.blueScore}
          </span>
        </span>

        {review.called !== null && (
          <span className={`badge ${review.called ? "badge-success" : "badge-error"}`}>
            {review.called ? "called" : "missed"}
          </span>
        )}

        <span className="ml-auto flex items-center gap-3">
          {noteCount > 0 && (
            <span className="stat text-xs text-graphite-500">
              {noteCount} note{noteCount === 1 ? "" : "s"}
            </span>
          )}
          <span className="text-xs font-semibold text-graphite-500">
            {videoKey ? (selected ? "Close" : "Watch") : "No video"}
          </span>
        </span>
      </button>
    </li>
  );
}
