"use client";

import { db } from "@/lib/firebase/client";
import { fileToResizedDataUrl, isImageFile } from "@/lib/imageFile";
import {
  EVIDENCE_HINTS,
  EVIDENCE_KINDS,
  EVIDENCE_LABELS,
  type EvidenceKind,
  newFreshnessCode,
  requiresFreshnessCode,
} from "@/lib/teamClaims";
import type { UserProfile } from "@/lib/types";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { useState } from "react";

/**
 * Where a team's first member proves the team is theirs.
 *
 * Shown by RequireAuth's approval gate when nobody has claimed this team yet.
 * The image rides inside the claim document as a data URL — the project has no
 * Storage bucket, and src/lib/imageFile.ts already compresses to fit (the pit
 * map and the team logo take the same route).
 */
export function TeamClaimForm({
  profile,
  uid,
}: {
  profile: UserProfile;
  uid: string;
}) {
  const [kind, setKind] = useState<EvidenceKind>("dashboard");
  const [note, setNote] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Generated once per mount, not per keystroke: the code has to still match
  // the photo the founder already took when they finally hit Send.
  const [code] = useState(() => newFreshnessCode(profile.teamId));

  const needsCode = requiresFreshnessCode(kind);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (!isImageFile(file)) {
      setError("That file isn't an image.");
      return;
    }
    try {
      setImage(await fileToResizedDataUrl(file));
      setFileName(file.name);
    } catch (err) {
      // fileToResizedDataUrl's messages are already written for a person
      // ("too large even after compression"), so pass them straight through.
      setError(err instanceof Error ? err.message : "Couldn't read that image.");
      setImage(null);
      setFileName(null);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!image) {
      setError("Attach a photo or screenshot first.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      // setDoc on a doc that already exists would be an update, which the
      // rules refuse for anyone but its own requester — so a second person
      // claiming the same team lands in the catch below, deliberately.
      await setDoc(doc(db, "teamClaims", profile.teamId), {
        teamId: profile.teamId,
        teamNumber: profile.teamId,
        teamName: profile.teamId,
        requestedByUid: uid,
        requestedByEmail: profile.email,
        requestedByName: profile.fullName,
        evidenceKind: kind,
        evidenceNote: note.trim(),
        evidenceImage: image,
        freshnessCode: code,
        status: "pending",
        createdAt: serverTimestamp(),
      });
      // No success state to set: the gate around this form is listening to the
      // same document and swaps itself out as soon as the write lands.
    } catch {
      setError(
        "Couldn't send that — someone from your team may have already asked, or your connection dropped.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-graphite-700">
          What are you sending?
        </span>
        <div className="flex flex-col gap-1.5">
          {EVIDENCE_KINDS.map((option) => (
            <label
              key={option}
              className="flex cursor-pointer items-start gap-2.5 rounded-md border border-graphite-200 px-3 py-2.5 transition hover:bg-graphite-50 has-checked:border-maroon-500 has-checked:bg-maroon-50"
            >
              <input
                type="radio"
                name="evidenceKind"
                value={option}
                checked={kind === option}
                onChange={() => setKind(option)}
                className="mt-0.5 h-4 w-4 accent-maroon-600"
              />
              <span>
                <span className="block text-sm font-medium text-graphite-900">
                  {EVIDENCE_LABELS[option]}
                </span>
                <span className="block text-xs text-graphite-500">
                  {EVIDENCE_HINTS[option]}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      {needsCode && (
        <div className="rounded-md border border-maroon-200 bg-maroon-50 px-3 py-3">
          <p className="text-sm font-medium text-maroon-900 dark:text-maroon-200">
            Write this code on paper and get it in the shot
          </p>
          <p className="stat mt-1.5 text-lg tracking-widest text-maroon-800 dark:text-maroon-200">
            {code}
          </p>
          <p className="mt-1.5 text-xs text-maroon-800 dark:text-maroon-300">
            It only exists for this request, which is how we know the photo is
            yours and not one off the internet.
          </p>
        </div>
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-graphite-700">
          Photo or screenshot
        </span>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => void handleFile(e.target.files?.[0])}
          className="field-input file:mr-3 file:rounded file:border-0 file:bg-graphite-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-graphite-700"
        />
      </label>

      {image && (
        <div className="flex flex-col gap-1.5">
          {/* eslint-disable-next-line @next/next/no-img-element -- a data URL,
              not a routable asset; next/image can't optimise it. */}
          <img
            src={image}
            alt="The evidence you're about to send"
            className="max-h-56 w-full rounded-md border border-graphite-200 object-contain"
          />
          <p className="text-xs text-graphite-500">{fileName}</p>
        </div>
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-graphite-700">
          Anything we should know{kind === "other" ? "" : " (optional)"}
        </span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          required={kind === "other"}
          placeholder="Who you are on the team, and what we're looking at."
          className="field-input"
        />
      </label>

      {error && (
        <p className="badge-error rounded-md px-3 py-2 text-sm normal-case tracking-normal">
          {error}
        </p>
      )}

      <button type="submit" disabled={busy} className="btn-primary px-4 py-2">
        {busy ? "Sending…" : "Send for review"}
      </button>
    </form>
  );
}
