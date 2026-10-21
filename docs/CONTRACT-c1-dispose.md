# CONTRACT C1, exact dispose invalidation

Status: agreed by the owner on 2026-10-21 (choice C1 of PRD 12.4).
Authors: lead. This file is the single source of truth for the whole team.
Nobody changes it; a disagreement goes to the lead.

## Problem

The memo is a whole-list memo of the host's `SessionPersistence.list()`.
`session/disposed` marks the memo stale, but the row for the disposed session
stays in it until the next refresh (up to `listTtlMs + listMaxStaleMs`).

The host's `list()` is disk-based: it returns every session that has a
materialized artifact (a log file on disk) plus the live sessions that are
created but not yet written. So a detached session:

- still has an artifact -> the host's `list()` STILL names it. The row is
  correct and must stay.
- has no artifact (never written) -> the host's `list()` does NOT name it.
  The row is wrong and must go.

## How to tell

`target.stat(id, options)` on the same `SessionPersistence` service the plugin
already wraps. It resolves to a snapshot when the artifact exists, and to
`undefined` when it does not. It is part of the `SessionPersistence` interface
(`packages/session/session-persistence/src/index.ts`, `abstract stat(id, options?)`),
so this is the host's own API, not a new dependency.

## Rules (the implementation MUST follow these exactly)

1. The listener calls `target.stat(id)` ONLY when the memo holds a row for that
   id AND that row is one the host's list() could stop naming.
   The host's list() tells the two kinds apart in the snapshot itself: a
   MATERIALIZED row carries `sizeBytes` (`snapshots.push({header, revision,
   sizeBytes})` for artifacts) and a LIVE-BUT-UNWRITTEN row does not
   (`snapshots.push({header, revision})` for pending entries). A dispose
   detaches the session, it does not delete the log, so the artifact of a
   materialized session outlives the session, the host still lists it, and its
   row is CORRECT. Asking about such a row is also the expensive question:
   a stat() on a pre-v4 log hashes the whole corpus
   (`historicalCorpusRevision`) at a measured 1,96 detik median, and the answer
   is always "an artifact exists". So a materialized row is KEPT without
   asking, and only a live-but-unwritten row is asked about, which is the
   cheap question (a findLog walk, no corpus hash) and the only one whose
   answer can be undefined.
   `sizeBytes` is optional in the host's snapshot contract, so its absence
   only ever makes the plugin ask the host, which is the safe direction.
2. `stat` resolves a snapshot -> KEEP the row. The host still lists it.
3. `stat` resolves `undefined` -> REMOVE that row from the memo.
4. `stat` rejects -> KEEP the row (absence is not proven) and record a note.
   The listener must never throw and must never reject.
5. `target.stat` is not a function -> KEEP the row (absence is not proven).
6. The removal replaces the memo's array with a filtered copy. The other rows,
   the `at` timestamp and the `seeded` flag are untouched. The memo stays
   dirty, so the next caller still triggers a background refresh.
7. The stat call is asynchronous, so the removal lands after the answer
   arrives, not in the event's tick. The answer takes tens of milliseconds on
   this host, and the host does NOT await the `session/disposed` listener, so
   the work is off the caller's path. A caller that arrives before the answer
   can still see the row, and the memo is NOT dropped while the answer is
   pending. That window is the documented bound, not a defect.
8. Nothing else changes: the TTL, the stale window, the snapshot, the abort
   contract, the copy-out contract and the metrics keys stay as they are.

## Cost, measured 2026-10-21 on this host (5.343 logs, 65 project dirs)

Numbers here use the same rendering as README.md and PRD.md: seconds with a comma
decimal ("1,96 detik"), milliseconds under 1.000 with a comma ("40,4 ms").

| question | cost |
| --- | --- |
| stat() on a known session, current physical generation (25% of sessions) | 40,4 ms median |
| stat() on a known session, older generation-0 layout (75%) | 1,96 detik median, 3,30 detik terburuk |
| stat() on an unknown id | 40,3 ms median (it exits before the corpus hash) |
| one full list() scan, for comparison | 12,9 detik median |

The narrowing in rule 1 is what keeps the plugin off the expensive class: a
materialized row is never asked about, so the 1,96-second class disappears from
the dispose path entirely.

## Why not "just drop the memo"

That was the old behaviour and it cost a full directory scan (measured 2.6 s
warm, 77.7 s with a cold page cache) for the next caller, for a change that
touches at most one row.

## Ownership (no two agents write the same file)

| File | Owner |
| --- | --- |
| `lib/index.js` | memo-invalidator |
| `tests/logic.mjs` | contract-tester |
| `README.md`, `PRD.md` | contract-docs |
| `artifacts/perf/**` (gitignored) | stat-cost |

Nobody commits. The lead integrates, runs the gates and commits.
