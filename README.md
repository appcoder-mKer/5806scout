# 5806 Scout

A field-ops scouting console for FRC Team 5806 — pit and match data captured
on a phone in a loud pit, and the rankings, picklist, and alliance calls that
come out of it.

Built to work at the pace of a live event: forms submit straight into the
device's cache so a scout in a dead zone never loses a match, assignments tell
each scout exactly which robot to watch, and the data tabs roll it all up while
the event is still running.

## What's in it

| Tab | What it does |
| --- | --- |
| **Dashboard** | Role-split: a scout's own talkies and assignments; an admin's unassigned work and crew status |
| **Pit / Match Scout** | The capture forms, with per-scout assignments inline and offline-safe submission |
| **Pit Dash / Drive Dash** | Live queueing, pit map, match predictions and team profiles |
| **Event** | The Blue Alliance sync — schedule, rankings, teams |
| **Picklist** | Ranked alliance picks with per-team notes, open to the whole team |
| **Data / Teams** | Per-match raw rows and per-team means, medians and spreads |
| **Talkie** | Lightweight request board between scouts and admins |
| **Manual Q&A** | Retrieval over the game manual |

Forms are schema-driven — an admin can add, hide, or reorder questions from
Settings without a deploy.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 · Firebase Auth +
Firestore · Vitest. Deployed on Vercel.

Data lives under `teams/{teamId}`, and two teams can link as a "sister pair" to
pool one set of scouting data while keeping their own rosters.

## Running it

```bash
npm install
cp .env.example .env.local   # then fill it in — see below
npm run dev
```

You'll need a Firebase project (Auth with Google sign-in, plus Firestore) and a
free [Blue Alliance](https://www.thebluealliance.com/account) read key. Every
other key is optional and degrades gracefully: without them the feature that
uses it shows a setup message and the rest of the app is unaffected.

`.env.example` documents each variable and what it turns on. Never commit
`.env.local` — it's gitignored.

Firestore rules live in `firestore.rules` and are the real access control; the
client is not trusted to enforce them.

## Checks

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run lint      # eslint
npm run build     # production build
```

## Layout

```
src/app/(app)/      the signed-in tabs
src/app/(auth)/     login and signup
src/app/api/        server routes — TBA, Nexus, manual Q&A, member deletion
src/components/     shared UI
src/lib/            logic, kept pure and unit-tested where it matters
```

Logic that decides something — scoring weights, assignment generation, sync
messaging, aggregation — lives in `src/lib` with tests beside it, so it can be
checked without standing up Firebase.

## License

[MIT](LICENSE) — do what you like with it. If it saves another team a
weekend of spreadsheet wrangling, that's the point.

## First-run setup

Two one-time steps in the Firebase console. Without the first, nobody can
administer the app at all.

**1. Make yourself the operator.** In Firestore, create a document at
`owners/<your-auth-uid>` (any contents — its existence is the whole signal).
Your uid is in Authentication → Users.

This document is the app's root of trust. `firestore.rules` forbids every
client from writing one, which is what stops a bug in the app from handing out
operator rights — and it is why the document has to be made by hand. As the
operator you review new teams at `/owner`: a team's first member files a claim
with evidence that they're really on it, and you approve them as that team's
first admin. From there each team runs its own roster.

**2. Enable Anonymous sign-in** (Authentication → Sign-in method). This backs
guest mode, where a visitor sees the whole app against real event data with
nothing saved anywhere. Anonymous accounts accumulate under Authentication
unless you turn on Firebase's 30-day auto-cleanup.

### Deploying the approval gate over an existing roster

Approval fails closed: a profile with no `status` counts as pending, so
deploying this locks out **every existing account, admins included**. That is
deliberate — an app that was open to anyone can't tell which of its accounts
were ever vouched for. Do step 1 *before* deploying, or the door shuts with
nobody holding a key. Then deploy the rules and the app together
(`firebase deploy --only firestore:rules`), open `/owner` → "Teams with no
admin", pick each team's first admin, and let them re-approve their roster
from the Team tab.
