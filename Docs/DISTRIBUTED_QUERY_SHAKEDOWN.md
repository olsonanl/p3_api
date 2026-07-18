# Distributed Query Shakedown — Initial Findings

**Branch:** `feature/distributed-query`
**Date:** 2026-07-18
**Method:** Replay of real-user API traces (`scripts/replay-queries.js`) against a dev
API on this branch, deep-diffing replay responses against the recorded originals.

Trace logs: `/disks1/p3/query_log/<user>@...jsonl` (captured 2026-07-16).
Dev API on `localhost:23001`, pointed at production Solr (`p3.theseed.org:7001` via HAProxy),
with `distributedQuery.minLimitThreshold = 10000`.

## Summary

The shakedown found and fixed **five defects** in the distributed-query path, all
committed in `6a779f61`. After the fixes, three user workloads replay cleanly — every
remaining diff is attributable to data drift between the Jul 16 capture and the live
database (new genomes ingested, Solr re-index version stamps, unsorted-result ordering),
**not** to the branch. Notably, **no replayed failure ever engaged the distributed path**
after the fixes (`X-Distributed-Query` absent on all of them).

| User | Files | Queries | Result |
|------|------:|--------:|--------|
| ARWattam | 1 | 456 | 456/456 pass (`--ignore-order`) |
| nbowers  | 2 | 68  | 0 distributed failures; 1 re-index timestamp drift |
| acapria  | 3 | 60  | 0 distributed failures; 37 data-drift diffs on live-ingesting virus taxa |

Distributed unit suite: **155 passing** (includes new regression tests).

## Defects found and fixed

All fixes are in commit `6a779f61` ("Fix distributed-query streaming defects found in
trace-replay shakedown").

### Defect A — Solr alias not resolved
Distributed queries against `genome` failed with "Collection not found" because `genome`
is a Solr alias to `genome_v02`. `SolrClusterClient.getShardsForCollection` now resolves
aliases from CLUSTERSTATUS (`cluster.aliases`) before looking up shards.

### Defect B — caller `q=` constraint dropped
`ShardCursorStream` hardcoded `q=*:*`, discarding RQL-derived `q=` constraints. It now
injects `q=*:*` only when the caller query has no `q=`; `DistributedQuery.stripManagedParams`
also converts a caller `q=<value>` into `fq=<value>`.

### Defect #2a — large distributed downloads truncated to `[` (coordinator EOF)
`ParallelQueryCoordinator._checkCompletion` called `push(null)` immediately after
`_drainBuffer()`. When the last shard completed **while the consumer was applying
backpressure**, the drain stopped short with documents still buffered, but EOF was emitted
anyway. The next `resume` then called `push()` after EOF → `ERR_STREAM_PUSH_AFTER_EOF`
(unhandled) → the response truncated to a bare `[`.

This is why the symptom was size/duration-dependent: small results and fast in-isolation
consumers drain synchronously and never hit backpressure. Fix: EOF is deferred via
`allShardsComplete`/`ended` flags; `_maybeEnd()` emits `null` only once the buffer is
fully drained. Regression test: `tests/test-distributed/test.coordinator.spec.js`
(verified to fail with `ERR_STREAM_PUSH_AFTER_EOF` on the pre-fix code).

### Defect #2b — `ERR_HTTP_HEADERS_SENT` on JSON streams
After #2a, live JSON downloads still truncated to `[` with
`Unable to receive stream: ERR_HTTP_HEADERS_SENT`. `media/json.js` writes `[` before
calling `streamWithBackpressure`, which then tried `res.set('X-Accel-Buffering','no')`
after the headers had already been flushed. (`csv.js`/`tsv.js` avoid this by calling the
helper first.) Fix: guard the `res.set` in `util/streamWithBackpressure.js` with
`!res.headersSent`, and set the header in `json.js` before writing `[`.

> Note: an early standalone reproduction masked this because its mock `res` had a no-op
> `set()`. A faithful mock `res` must throw from `set()` after `headersSent` is true.

### Defect C — facet/grouped queries silently lost facets
`/genome/` queries with `limit >= 10000` **and** `facet(...)` engaged the distributed
streaming path, which concatenates raw docs from shards and cannot compute `facet_counts`
or grouped responses — so facets were dropped and the response shape changed.
`shouldUseDistributedQuery` now rejects queries containing `&facet=true` or `&group=true`
(what RQLQueryParser emits), checked **before** the header/param overrides so an explicit
`distributed=true` cannot silently drop facets. Tests added to `test.middleware.spec.js`.

### Hardening (same commit)
- `app.js`: after headers are sent, abort with `res.destroy()` (no error argument) — passing
  the error re-emitted it on `res`, producing a secondary "socket hang up" uncaughtException.
- `DistributedQueryManager._createLimitedStream`: forward source errors across the `pipe()`
  boundary so a shard failure surfaces on the consumed stream instead of going unhandled.

## Per-user replay detail

### ARWattam — 456 queries → 456/456 (`--ignore-order`)
Progression as fixes landed: **440 → 447 → 456**.
- 9 failures were `/genome/…limit(25000)&facet(...)` queries → fixed by Defect C. The
  original requests used `Accept: application/solr+json` (raw Solr object body), and after
  the fix the standard path returns the matching `{responseHeader, response, facet_counts}`
  shape with identical facet data.
- 9 failures were the same unsorted `in(taxon_id,(...))&limit(2000)` taxonomy query
  (below threshold; never distributed). The `$[65].lineage_ids 7 vs 8` diff was a
  result-ordering artifact — taxon 2022738 returns byte-identical `lineage_ids` live vs
  recorded. Resolved by `--ignore-order`.

### nbowers — 68 queries (30 + 38) → 0 distributed failures
- 2× the same unsorted `in(taxon_id,...)` taxonomy ordering artifact (resolved by `--ignore-order`).
- 1× a `/genome/` result where a single genome's `date_inserted` shifted 7ms
  (`...933Z` → `...940Z`) due to re-indexing after capture — data drift, standard path.

### acapria — 60 queries (20 + 10 + 30) → 0 distributed failures
The acapria workload targeted two actively-ingesting influenza/virus taxa
(`3052345`, `2955291`). 37 raw diffs, **all with `X-Distributed-Query` absent**, all
data-drift/volatile categories:

| Count | Category |
|------:|----------|
| 13× | `_version_` (Solr re-index version stamp; not ignored by the replay tool) |
| 11× | facet counts (grew as genomes were added — facets computed correctly on standard path) |
| 6×  | top-doc field set (`sort(-date_inserted)`: `[0]` is now a newer genome with a different subset of sparse flu fields) |
| 2×  | `numFound` (verified live: 29328 → 29344, 16 genomes added) |
| 2×  | taxonomy `lineage_ids` ordering |
| 2×  | `summary_by_taxon` CDS aggregate (grew with new genomes) |
| 1×  | `date_inserted` (re-index/order) |

`--ignore-order` barely changed the counts (F1 16→15, F3 19→18), confirming these are
count/version drift, not ordering. This run positively re-confirms Defect C's fix: the
`facet(...)` queries all took the standard path and returned computed `facet_counts`
(only the counts differ, not the shape).

## Methodology notes (for future replays)

- **Use `--ignore-order`** for unsorted queries (`in(...)` without `sort(...)`); Solr returns
  the same docs in a different order over time, producing benign positional diffs.
- **Volatile fields** the replay tool does *not* currently ignore and that cause benign
  diffs against a live DB: `_version_`, `date_inserted`, `numFound`, facet counts, and
  `summary_by_taxon` aggregates. Consider adding `_version_` to the ignore list.
- **Match the recorded `accept` header** when hand-testing — genome+facet requests used
  `application/solr+json` (raw Solr object), not `application/json` (bare docs array).
- The `X-Distributed-Query` response header (when `exposeMetadataHeaders` is on) is the
  fastest way to tell whether a query actually engaged the distributed path.

## Outstanding / not defects

- The taxonomy `lineage_ids` and all acapria diffs are data/time drift, not code — they
  would reproduce on `master`. No action needed for the branch.
- Optional replay-tool improvement: ignore `_version_` (and optionally `date_inserted`)
  to reduce false positives against a live database.
