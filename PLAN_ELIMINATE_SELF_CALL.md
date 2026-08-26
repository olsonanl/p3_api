# feature/eliminate-self-call — remove HTTP self-calls from the hot path

## STATUS (2026-08-26) — steps 1–4 done, step 5 next

Branch `feature/eliminate-self-call`, based on `6397c6cf` (master).

**There is no remote named `upstream`** — earlier notes in this file said "pushed to
upstream" and that is wrong. The two remotes are `origin`
(`https://github.com/BV-BRC/BV-BRC-API`, canonical) and `bob`
(`git@github.com:olsonanl/p3_api`, personal fork). They are at *different* points:

| ref | tip |
|---|---|
| `origin/feature/eliminate-self-call` | `797adf86` |
| `bob/feature/eliminate-self-call` | `ee4c56b8` (4 behind origin) |
| local `HEAD` | `c42d88a0` (3 ahead of origin) |

| step | state | commit |
|---|---|---|
| 1. `multiQuery` error propagation | **done** | `febb9cf8` |
| 2. `lib/internalQuery.js` + tests | **done** (inert — no call sites converted) | `fcee5a0a` |
| 3. `/data` characterization tests | **done** | `c868a061` |
| 4. Convert `multiQuery` | **done** — first live caller | `73e5d2a3` |
| 5. Convert `dataRouter` | **NEXT** — not started, findings below | — |
| 6. Convert `ExpandingQuery` | not started | — |
| 7. `util/http.js` wall-clock deadline | not started | — |
| 8. `CLAUDE.md` pass | not started | — |

**Three commits are local only** — `c868a061`, `73e5d2a3`, `c42d88a0`. Nothing has been
pushed to either remote since `797adf86`.
Working tree is clean of plan work; the untracked files in `git status` (`token.*`,
`p3api.conf`, `*.log`, `dq*`, `solrq*`, `tst*`) are pre-existing secrets and scratch —
**always `git add` by name, never `-A`.**

Dev server: port `23001`, log `/tmp/devserver.log`. Production is a *separate* pm2 process
(`p3-api`, user `svcbvbrc`) on port `3001` — do not touch it, and see the `API_URL` warning
below.

### Verification results for step 4 (all green as of 2026-08-26)

| suite | result |
|---|---|
| offline set (command below) | **366 passing / 1 failing** (known `fastaHeaderFormatter`) |
| `tests/test-permissions/test.internalquery.spec.js` | 19/19 |
| `tests/test-security/security-internalquery-ssrf.spec.js` | 10/10 (new) |
| `tests/test-api/test.multiquery-errors.spec.js` | 10/10 (was 4) |
| `tests/test-api/test.data-router.spec.js` | 15/15 *against `:23001`* |
| all four live specs together | 36 passing / 0 failing |
| `npx eslint` on the 5 changed files | 1 error, pre-existing (`RQLQueryParser.js:9`) |

Behavioral evidence beyond the suites, in case it needs re-checking rather than re-deriving:
a 16-probe before/after capture against the same live Solr diffs to **8 lines, all error
*detail* strings with unchanged status codes** (5 SSRF probes gained the sanitizer's reason,
2 unknown-collection gained the collection name, 1 `descendants()` surfaced Solr's real
message). Every success line is byte-identical. An authenticated A/B (dev `:23001` new code
vs prod `:3001` old code, same Solr) matched on `private_genomes`, `public_ctl` and
`private_features` — 5 private rows authenticated, 0 anonymous, both directions.
`own_genomes` differs only because production still carries the silent-200 bug fixed in
`febb9cf8`.

### Run the test suites against the DEV server, not :3001

`tests/test-api/test.data-router.spec.js` defaults to `API_URL=http://localhost:3001`, which
on this host is the **production** pm2 process (`svcbvbrc`), not the dev server on `:23001`.
Running it bare silently characterizes a *different build*. It cost an hour here: two
`/data/taxon_category/` tests failed with a Solr `ParseException` on `q=()` — production
predates the empty-group guard in `lib/solrjs/rql.js`, so the empty group reaches Solr there
and 400s, while the same request against `:23001` returns 200. Nothing to do with the
conversion. Always:

```bash
API_URL=http://localhost:23001 npx mocha tests/test-api/test.data-router.spec.js
```

A characterization suite that can silently point at the wrong build is worse than no suite —
it produces confident green on code you did not change.

Also on the branch: `ee4c56b8`, the hang-investigation handoff
(`Docs/HANG-INVESTIGATION-2026-08-24.md`) — unrelated incident, carried here so it is not
stranded on a merged branch.

**Offline test baseline on this branch: 366 passing / 1 failing.** The failure is the known
pre-existing `fastaHeaderFormatter` case. Baseline was 327 before this work (+10 multiQuery
error tests, +19 internalQuery tests, +10 internalQuery SSRF tests). Run with:

```bash
npx mocha -R dot tests/test-util/test.*.spec.js tests/test-join/test.*.spec.js \
  tests/test-distributed/test.*.spec.js tests/test-api/test.multiquery-errors.spec.js \
  tests/test-permissions/test.internalquery.spec.js \
  tests/test-security/security-internalquery-ssrf.spec.js
```

`tests/test-api/test.data-router.spec.js` (15 tests) and `tests/test-api/test.multi.spec.js`
need a live API and are not in that command — see the `API_URL` warning above.

### Why step 3 needed a live environment (done — `c868a061`)

`/data/*` had **zero test coverage**, and step 5 rewrites it. The characterization
tests must capture the *current* HTTP behavior — real facet counts, real `json.facet`
output — so the conversion can be held to byte-identical results. That requires a live API
and a populated Solr; a mock would encode assumptions rather than reality, which is
exactly the failure mode `Docs/`-recorded experience warns about ("this codebase's bugs are
HTTP 200 with wrong data; mocks miss them, assert on exact counts").

Endpoints needing capture (all in `routes/dataRouter.js`):

- `/data/summary_by_taxon/:taxon_id` — 4 concurrent self-calls; `json.facet` unique counts
  on `genome`, a cross-collection join facet on `genome_feature`, plus `strain` and
  `subsystem`
- `/data/distinct/:collection/:field` — 1 self-call, allowlisted collection/field pairs
- `/data/subsystem_summary/:genome_id` — 1 self-call
- `/data/taxon_category/` — already partly in-process; **no permission filter at all**
  (see "Documented-but-not-fixed")

Capture a few known-good taxon ids (e.g. `2` bacteria, `10239` viruses, `1386`) and store
the responses as fixtures. Note `apicache` caches these for 1 day under a **non-user-scoped**
key, so flush Redis or use fresh ids between runs or you will characterize the cache.

### Picking the work up elsewhere

```bash
git fetch upstream
git checkout -b feature/eliminate-self-call upstream/feature/eliminate-self-call
npm ci      # REQUIRED — master needs dojo-declare for the inlined lib/solrjs
node -e "require('dojo-declare/declare'); require('./lib/solrjs'); console.log('deps OK')"
```

Read `Docs/HANG-INVESTIGATION-2026-08-24.md` first if the production hangs are still open —
it lists what has already been ruled out, including two theories that tested false.

## Context

The API makes HTTP requests back to its **own listening port** instead of invoking
handlers in-process. Production access-log analysis measured the cost. The analysis read
`p3-api-web.out-{8,10,11}.log`, which covers **all six pm2 workers** — `pm2 scale` cloned
the resolved log paths, so workers 47/48/49 write into `out-8.log` alongside worker 8
(verified via `pm2 describe`). The figures are therefore whole-cluster aggregates.

**36-hour window (2026-08-24T05:00 → 2026-08-25T18:19), 101,455 requests:**

- `::ffff:127.0.0.1` is the **top client by a factor of three**: **33,101 requests
  (33% of all traffic), 615,681s cumulative**, 18.6s average. The next client is 6,714
  requests / 177,133s.
- `/query/` (`routes/multiQuery.js`): 544 requests, **240,751s** — and `solr=n/a` on every
  slow one, i.e. the outer request never runs a query of its own.
- `/pathway` (a self-call target): 550 requests, **177,274s**.
- `/data/summary_by_taxon/*` (`routes/dataRouter.js`): 63 requests, **18,159s** (288s avg).
- Outer/inner pairs are visible in the log at the same millisecond, distinguishable by
  request-id prefix (`plum-web-*` from nginx vs. `p3api-*` generated in `app.js:31`
  because the self-call carries no `X-Request-ID`).

An earlier 14-hour window measured localhost at 4,035 requests / 374,670s. The longer
window shows this is a sustained rate, not a burst, and that the share of total traffic is
larger than first estimated.

Three consequences:

1. **Measured concurrency is inflated.** Peak in-flight of 412 counts each outer request
   *and* its children.
2. **It is a resource-loop / deadlock hazard.** An outer request occupies a slot and needs
   N more on the *same* worker pool for its children. With 6 pm2 workers at
   `solr.agent.maxSockets: 8` (48 concurrent Solr requests cluster-wide), outer requests
   can hold every slot while their children queue behind them. This explains uniform ~500s
   and ~800s plateaus better than any single slow query.

   An earlier reading of this incident blamed nginx keepalive for pinning traffic to three
   workers. **That was wrong** — all six serve traffic (worker 47 has the *highest* CPU
   time of any worker), and `nginx -s reload` correctly changed nothing. The apparent
   idleness was the log-path collision above. Worker distribution is not a contributing
   factor; noted here so it is not re-investigated.
3. **Errors are silently swallowed — this may be the most urgent part.** `util/http.js`
   exposes **no HTTP status**; a 500 comes back as a body string. `multiQuery.js:41` stores
   whatever parses as a *result*, so the website renders partial data as HTTP 200. In the
   36-hour window there were **3,274 500s**, and in the slow list *every* `/query/` 200 is
   paired with an inner 500 at the same millisecond. Users are being shown silently
   incomplete data, which is worse than being shown a slow page. Same silent-200 class as
   `Docs/BUG-stream-failure-returns-empty-200.md`.
4. **`util/http.js` has no timeout mechanism at all** — not merely unset, absent. Verified
   this session. It carries all 17 self-call sites plus the Workspace API calls, so any of
   them can hang unboundedly. Related and verified: #203's Solr timeout does **not** bound
   time spent queued for a socket (`req.setTimeout` is a socket timeout and does not start
   until the agent assigns one; tested with `maxSockets:1` — a 2000ms timeout was still
   pending after 6000ms). Both are recorded in `Docs/HANG-INVESTIGATION-2026-08-24.md`.

**None of the 17 sites are fixed on any branch** — verified byte-identical across
`upstream/master`, `upstream/alpha`, `feature/distributed-query`, and `HEAD`. The one
precedent is GenBank (`06dd7618`), which converted `media/genbank.js` to direct Solrjs and
deleted ~400 lines.

**Intended outcome:** eliminate loopback traffic on the measured hot path, so that
`analyze-access-log.js` no longer reports `127.0.0.1` as the top client; remove the
deadlock hazard; and make sub-query failures visible instead of rendering as success.

### Scope (decided)

**Hot path only.** Three sites: `multiQuery`, `dataRouter`, `ExpandingQuery`. The 9 RPC
sites, the `media`/`featureSequence` sites, and `bundler/genome.js` are deferred to a
follow-up branch — the RPC ones carry a distinct hazard (identity comes from
client-supplied `params[1].token`, not `req`) that deserves its own review.

Out of scope entirely: the `distributeURL`/axios callers
(`util/featureSequence.js:63`, `media/dna+fasta.js:70`, `media/protein+fasta.js`). Those
default to localhost but the deployed config may point them elsewhere (a dev-host config
seen during this work used `https://alpha.bv-brc.org/api/`) — converting them changes
network topology, not just transport. **Read the production config before assuming.**

**Added to scope after the 36-hour analysis:** a wall-clock deadline in `util/http.js`.
It is the same defect class, it lands in the file this branch is already rewriting, and
without it the converted call sites would still have no bound. Covers both gaps in item 4
above — queue-wait and the missing mechanism — via one helper, mirroring `armTimeout()` in
`lib/solrjs/index.js` and using the same env-var pattern as `SOLR_REQUEST_TIMEOUT_MS`.

---

## Relationship to the distributed-query subsystem

`lib/distributed/` already contains Solr-invocation code, so the overlap question is fair.
The answer, verified: **it overlaps in shape but not in capability, and it cannot serve the
hot-path sites.**

`DirectSolrClient` is the closest fit. It already does much of what the helper needs —
`query()`, `queryWithCursor()`, `fetchByIds()`, and a `permissionFq`/`user` option threaded
through every fetch (`lib/distributed/DirectSolrClient.js:263,286,323`). `lib/BatchJoiner.js`
consumes it and derives permission context from the same `lib/permissionFilter.js` this plan
uses. That is the pattern to imitate.

Three verified reasons it cannot be the vehicle:

1. **No facet support.** `grep -c facet lib/distributed/DirectSolrClient.js` → **0**. Its
   `query()` builds a fixed param set (`q`, `wt`, `rows`, `start`, `fq`, `fl`, `sort`) and
   silently drops anything else. `routes/dataRouter.js` is *built* on facets — 9 occurrences
   of `json.facet`/`facet=true`/`facet.field`, including the `json.facet` unique-count query
   at `:47`. Stage 2 would return structurally empty results.
2. **This limit is architectural, not an omission.** `middleware/DistributedQuery.js:171`
   explicitly routes `facet=true`/`group=true` to the standard path because the distributed
   reader concatenates raw docs from independent shards and *has no way to compute
   `facet_counts`*. Same finding as the facet-overlay note in `CLAUDE.md`.
3. **It requires direct replica network access.** `_selectReplica()`
   (`DirectSolrClient.js:127`) goes through `SolrClusterClient` for replica discovery and
   connects to individual replicas. That is exactly why GenBank was deliberately built on
   `Solrjs` instead — so it works through the HAProxy Solr URL without per-replica access
   (`CLAUDE.md` design note, commit `06dd7618`).

So `lib/internalQuery.js` stays on `Solrjs`, and should **reuse the permission-context
plumbing** from `BatchJoiner`/`permissionFilter` rather than inventing its own. Worth adding
a short comment in the new module explaining why it does not use `DirectSolrClient`,
mirroring the existing GenBank note — otherwise this exact question resurfaces.

### On sequencing behind the master merge

The self-call sites are **byte-identical on `upstream/master`, `upstream/alpha`,
`feature/distributed-query`, and `HEAD`** (verified), and the three files this branch
touches — `routes/multiQuery.js`, `routes/dataRouter.js`, `ExpandingQuery.js` — are
unchanged by the distributed work. So there is **no code conflict either way**, and this
branch is not blocked by the merge.

The argument for doing the alpha→master merge first is about deployment, not code: the
measured problem is on the **production** instance, which runs master, and master is ~175
commits behind alpha. Landing this on alpha alone fixes nothing in production. Branching
from master and cherry-picking to alpha is equally viable given the identical baseline.
Either order works; the merge-first order is what gets the fix to the instance that is
actually hurting.

## Design

### The abstraction: `lib/internalQuery.js`

A single new module exposing one function, following the **GenBank precedent** (direct
Solrjs, bypassing the Express chain) rather than synthesizing fake `req`/`res` objects.

```js
async function internalQuery ({ collection, query, queryType, user, publicFree,
                                accept, isDownload, timeout })
  // -> { docs, numFound, facet_counts, grouped, raw }
```

**Why direct-Solr and not a synthetic-request dispatcher.** The `/:dataType/` chain is ~27
middleware deep and its hard dependencies are exactly the parts a fake object gets wrong:
body parsers reading the raw request stream, the raw-stream auth extractor at
`routes/dataType.js:34`, `res.format(media)` (real Express content negotiation),
`res.on('close'|'finish'|'drain')` in `DistributedQuery`/`CrossCollectionStream`, and
`req.connection.remoteAddress` in `SolrQuerySanitizer`. A fake-req dispatcher would have to
emulate all of it and would drift from the real chain over time. The three hot-path sites
need only: RQL→Solr conversion, a permission filter, a row limit, and parsed docs.

**Composition** — reuse existing modules, do not reimplement:

| need | reuse |
|---|---|
| RQL → Solr | `Rql()` + `.toSolr({collection, defaultLimit, maxRequestLimit})` from `lib/solrjs/rql.js` — the same call `middleware/RQLQueryParser.js` makes |
| permission `fq` | `permissionContext({collection, user, publicFree})` from `lib/permissionFilter.js` — **the single source of truth**; `BatchJoiner` and `DecorateQuery` both use it |
| Solr execution | `new Solrjs(Config.get('solr').url + '/' + collection)` + `Web.getSolrAgent()`, per `media/genbank.js` (**not** `DirectSolrClient` — see above) |
| user agent | already inside `lib/solrjs` |

**Must-haves in the helper, each mapping to a verified failure mode:**

- **`publicFree` is a required argument, not optional.** `lib/permissionFilter.js:37`
  requires `Array.isArray(publicFree)` and **fails closed** when absent — it would filter
  even exempt collections. Today the HTTP round-trip supplies this via `PublicDataTypes`,
  which runs only inside `/:dataType/`. Import the list directly from
  `middleware/PublicDataTypes.js` (it is a module-level shared constant).
- **Set `X-Authenticated-User`** on the Solrjs client when `user` is present, matching
  `middleware/APIMethodHandler.js:24`.
- **Surface errors as thrown Errors carrying the Solr status**, closing gap (F) —
  `util/http.js` never exposed status, which is the root of the swallowing.
- **Set a `timeout`** (`Solrjs` supports `this.timeout`, `lib/solrjs/index.js:247`). The main
  path currently arms no timeout at all.
- **Enforce a row limit** equivalent to `Limiter`'s cap for these callers.

### Stage 1 — `routes/multiQuery.js` (biggest measured win: 544 req / 240,751s)

Replace `subQuery` (`multiQuery.js:11`) with `internalQuery`.

- **Identity: forward the caller's.** The route already mounts `authMiddleware`
  (`multiQuery.js:25`), so `req.user` is populated; pass it through. This *preserves*
  today's behavior — the inner HTTP call forwards `req.headers.authorization` and
  re-validates the same token. Net effect: one token validation instead of N+1.
- **Keep the collection allowlist.** The path is built from client-supplied
  `qobj.dataType` (`multiQuery.js:19`) and is currently gated only by
  `app.param('dataType')` (`app.js:187`). Bypassing HTTP bypasses that gate — the helper
  must validate `collection` against `Config.get('collections')` and reject otherwise.
  **This is a security-relevant step, not a detail.**
- **Fix error swallowing (in scope).** Per-sub-query failures must be reported as an
  `error` field on that sub-result rather than parsed into `result`. In-process dispatch
  exposes real status for the first time, which is what makes this fixable.

### Stage 2 — `routes/dataRouter.js` (18,159s on `summary_by_taxon/10239` alone)

Replace `subQuery` (`dataRouter.js:21`); `summary_by_taxon` fans out to 4 concurrent
self-calls, `distinct` and `subsystem_summary` to 1 each.

**Identity: explicitly anonymous — `user: undefined`.** This preserves exact current
behavior (`Authorization: ''` hardcoded at `dataRouter.js:26`) and is required for safety:

- `/data` mounts **neither** `authMiddleware` **nor** `PublicDataTypes` (verified: zero
  matches in the file), so there is no caller identity to inherit anyway.
- Targets `genome`, `genome_feature`, `strain`, `subsystem` — **none are publicFree**, so
  today every one gets `fq=public:true`.
- Results are cached in Redis for 1 day via `apicache` under a key of `req.originalUrl`
  **only** (`appendKey: []`, verified in `node_modules/apicache/src/apicache.js:620`) —
  **the cache is not user-scoped.** Inheriting a caller identity would leak private counts
  into a shared cache served to every user.

`publicFree` must still be passed (fail-closed rule above); only `user` is omitted.

#### What a read of `dataRouter.js` turned up (2026-08-26, not yet reproduced live)

From reading the file only — worth confirming against the dev server before relying on it,
but it changes what step 5 has to do:

- **`dataRouter.js:21` uses `httpRequest`, not `httpRequestWithStatus`.** So it has the same
  swallowed-status defect `febb9cf8` fixed in multiQuery: a non-2xx body is `JSON.parse`d and
  handed to the caller as if it were a result. The three call sites then diverge, and they
  are **not equally bad**:
  - `/distinct` (`:160-168`) has an explicit `else next({status, message})`. Handled.
  - `summary_by_taxon` (`:65`) reads `results.facet_counts.facet_fields.feature_type` off the
    error body, throws a `TypeError`, `Promise.all` rejects, `next(err)` → 500. Ugly message,
    but it does surface.
  - **`subsystem_summary` (`:221`) has an `if` with no `else`.** On an error body the
    condition is false, so `next()` is never called and nothing is ever written — **the
    request hangs** until the client gives up. Nothing downstream responds; `cacheWithRedis`
    and `bodyParser` impose no deadline. This is the worst of the three and step 5 should
    close it. (Its condition also tests `body.facet_counts.facet_pivot` twice — a typo, not a
    second check.)
- **`/taxon_category/` (`:176`) has no self-call to convert.** It already runs in-process via
  `RQLQueryParser → APIMethodHandler → media`. Step 5 leaves its transport alone; it is only
  interesting because it is the endpoint with no permission filter (item 2 under
  "Documented-but-not-fixed") and the only one of the four **not** wrapped in
  `cacheWithRedis`.
- **`/distinct` interpolates `req.query.q` raw into the Solr query** (`:155`, `:157`), with no
  escaping. It is not currently an injection hole *because* the self-call routes it through
  `SolrQuerySanitizer`. `internalQuery` carries that same gate (added in `73e5d2a3`), so the
  conversion preserves the protection — but that is load-bearing, so pin it with a test
  rather than leaving it implicit.

So step 5 is three conversions, not four, and it inherits an error-handling fix.

**Documented limitation (requested).** Add a comment block at the `/data` subQuery site and
a short subsection in `CLAUDE.md` recording that **all `/data/*` summary endpoints report
public-data-only counts**, that this is deliberate and predates the refactor, and that the
blocker on changing it is the non-user-scoped `apicache` key — not the transport. Anyone
tempted to "improve" this by threading the caller's identity must user-key the cache in the
same change or they create a cross-user leak.

### Stage 3 — `ExpandingQuery.js` (the deadlock case)

`runJoinQuery` (`:56`) and `runSDISubQuery` (`:82`) fire **during `RQLQueryParser`** — a
self-call nested inside the outer request's own middleware chain, and recursive for nested
`join()` terms. This is the site most likely to be responsible for the observed plateaus,
even though its per-request cost is not separately visible in the log.

- **`runJoinQuery`: forward identity** via `opts.req.user` — preserves today's behavior
  (`:60` forwards `opts.req.headers['authorization']`).
- **`runSDISubQuery`: keep anonymous.** The code at `:87` looks like it forwards, but the
  only call site (`:184`) is `runSDISubQuery('ppi', query)` with **no `opts`**, so it is
  always anonymous today. `ppi` is publicFree, so this is currently moot — but preserve it
  deliberately and comment why, rather than silently changing it.
- **Fix the unguarded `opts.req.headers` (in scope).** `opts && opts.req &&
  opts.req.headers['authorization']` does not guard `opts.req.headers` itself.
  `middleware/CrossCollectionSource.js:126` calls `ResolveQuery(cleaned, { req: {}, res: {} })`,
  so any `join()`/`GenomeGroup()`/`FeatureGroup()` term throws a TypeError there today.
  Verified. Fix while in this code.

### Documented-but-not-fixed

Per decision, record these in `CLAUDE.md` (or `Docs/`) without changing them:

1. **`routes/rpcHandler.js:25`** — guard reads `methodDef.requireAuth`; every method
   declares `requireAuthentication` (verified). The 401 gate has never fired. Harmless
   today (all declare `false`) but it is a dead auth gate.
2. **`routes/dataRouter.js:176`** (`/taxon_category/`) — hand-assembles
   `RQLQueryParser → APIMethodHandler → media` with **no `DecorateQuery` and no
   `PublicDataTypes`**, so it queries `genome` with **no permission filter at all**.
3. **RPC identity model** — `app.post('/', rpcHandler)` mounts no auth middleware, so
   `req.user` is always `undefined` there; the real identity is client-supplied
   `params[1].token`, validated only by the inner self-call. **This is why the RPC sites are
   deferred**: converting them naively would break private workspace transcriptomics.
4. **`util/featureSequence.js:28`** `_getSequenceDictByHash` is dead code (not exported).
5. **Non-user-scoped Redis caches** in `rpc/proteinFamily.js:33,96`.

---

## Operational follow-ups (outside this branch's code scope)

Surfaced while diagnosing the production instance. Independent of the refactor, but they
are what made the diagnosis slow, and the first one directly affects how the verification
step below is read.

1. **pm2 log paths collide.** Workers 47/48/49 all write to `p3-api-web.out-8.log`
   (verified). `pm2 scale` clones the resolved log paths from an existing instance instead
   of re-deriving them from `pm_id`. Neither `reload` nor `scale` fixes it — it needs
   `pm2 delete p3-api-web` plus a clean start from the ecosystem file. Dump the running
   config first (`pm2 prettylist > /tmp/pm2-before.json`), since it may not match anything
   on disk.

2. **Add the worker id to the access log.** pm2 sets `NODE_APP_INSTANCE` in cluster mode and
   nothing in this codebase reads it. One token in `app.js` alongside the existing ones
   (`app.js:70-84`) makes per-worker distribution readable directly from the logs, instead
   of being inferred from file mtimes and socket counts:

   ```js
   logger.token('worker', () => process.env.NODE_APP_INSTANCE || '-')
   ```

   Then add `w=:worker` to the format string. This also feeds `analyze-access-log.js`,
   which could then break its tables down per worker. Small enough to fold into this
   branch if wanted; listed separately because it touches `app.js`, which the
   self-call work does not.

## Files

| file | change |
|---|---|
| `lib/internalQuery.js` | **new** — the shared helper described above |
| `routes/multiQuery.js` | replace `subQuery`; forward identity; validate collection; propagate sub-query errors |
| `routes/dataRouter.js` | replace `subQuery`; pin anonymous; add limitation comment |
| `ExpandingQuery.js` | convert `runJoinQuery` + `runSDISubQuery`; fix `opts.req.headers` guard |
| `CLAUDE.md` | document the `/data` public-only limitation and the deferred findings |
| `tests/test-api/test.internal-query.spec.js` | **new** — unit tests for the helper |
| `tests/test-api/test.data-router.spec.js` | **new** — `/data/*` currently has zero coverage |
| `tests/test-permissions/test.internal-query-permissions.spec.js` | **new** — permission-scoping proof |

---

## Verification

This codebase's failure mode is **HTTP 200 with wrong data** — assert on exact counts, not
on "we got bytes" (`CLAUDE.md`, and the cross-collection-download record).

**Existing gates that must stay green:**

- `tests/test-api/test.multi.spec.js` — the only `/query/` test; real HTTP, exact counts
  (`result1.length === 1`, `genome_name === 'Mycobacterium tuberculosis H37Rv'`,
  `result2.length === 4`). **The primary Stage 1 gate.**
- `tests/test-api/test.expanding.spec.js` — covers `join()`, `GenomeGroup()` (with a
  token, asserts `numFound === 4`), `secondDegreeInteraction()`. **The Stage 3 gate.**
- `tests/test-permissions/test.permissionfilter.spec.js` — `buildPermissionFq` semantics
  including the fail-closed case. Runs offline.
- `tests/test-download/test.cross-collection.spec.js` — exercises `CrossCollectionSource`,
  the caller that passes `{req:{}}` into `ExpandingQuery`.
- Offline baseline: `test-util`, `test-join`, `test-distributed` → **327 passing / 1
  failing** (the known `fastaHeaderFormatter` case). Any other failure is a regression.

**New tests:**

1. **Permission scoping** — follow the `PermissionAwareMockSolr` pattern in
   `tests/test-permissions/test.enrichment-permissions.spec.js` (a mock that honors *only*
   the `fq` it is handed). Assert: anonymous → `public:true`; authed → the
   `owner`/`user_read` triple; publicFree collection → no filter; **`publicFree` omitted →
   fails closed**.
2. **`/data/*` characterization tests** — write these **before** converting, against the
   current HTTP implementation, and require byte-identical output after. This is the only
   safety net for a route with zero coverage.
3. **Proof the self-call is gone** — the load-bearing test. Assert on **counts**, not
   absence of errors: install a counting wrapper on the loopback listener (or a spy on
   `util/http`'s `httpRequest`/`httpGet`) and assert **zero** loopback requests are issued
   while servicing a `/query/` and a `/data/summary_by_taxon/*` request. Without this,
   every other test passes whether or not the refactor actually did anything.

**Production confirmation** — `scripts/analyze-access-log.js` already reports top clients by
time consumed. Baseline to beat: `::ffff:127.0.0.1` at **33,101 req / 615,681s over 36
hours** (33% of all requests). After deploy, re-run over a **comparable-length** window —
the 14-hour and 36-hour baselines are not interchangeable:

```bash
node scripts/analyze-access-log.js /disks/p3/logs/p3-api-web.out-{8,10,11}.log \
  --since <ISO> --slow 2000 --concurrency --top 30
```

Keep reading the same three files unless the pm2 log paths are fixed first — those three
currently contain all six workers, so the before/after comparison is apples to apples. If
the paths *are* fixed in between, the file set changes to six and the baseline must be
re-derived, or the "after" numbers will look artificially lower simply because output moved
elsewhere.

Success = `127.0.0.1` drops off the top-clients table, and peak reconstructed concurrency
falls (412 in the baseline, inflated by counting parent and child separately). Watch the
500 count (**3,274** in the 36-hour baseline) — some inner-request 500s that were being
swallowed into 200s will now surface honestly as errors. **That is the fix working, not a
regression**, and it is worth saying so in the deploy note so nobody reverts on the strength
of an error-rate graph going up.

**Rollback:** each stage is an independent commit touching one call site; revert
individually. `lib/internalQuery.js` is additive and inert until a caller uses it.

---

## Sequencing

1. ~~**`multiQuery` error propagation, on its own commit.**~~ **DONE (`febb9cf8`).**
   Reordered to the front: it is the only change here that fixes *wrong data* rather than
   slow data, and 3,274 500s in the 36-hour window were being rendered as successful
   partial results. Added `httpRequestWithStatus()` to `util/http.js` rather than changing
   `httpRequest`'s resolve shape (four other call sites expect a bare string). Kept
   per-sub-query error reporting instead of letting `Promise.all` reject — otherwise one
   failing panel would take down every other panel, a worse regression than the bug.
   Verified as a real gate: 3 of 4 new tests fail against the pre-fix code.
2. ~~`lib/internalQuery.js` + its unit and permission tests.~~ **DONE (`fcee5a0a`).** Inert;
   no call sites converted. Reuses `buildPermissionFq` so it cannot drift from
   `DecorateQuery` (verified identical `fq` across anonymous/authenticated/publicFree).
   Reinstates the `app.param('dataType')` collection allowlist, which bypassing HTTP would
   otherwise skip. Detects Solr errors returned in the body with HTTP 200.
   `middleware/PublicDataTypes.js` now also exports its list so the `publicFree` default
   cannot drift; the middleware export is unchanged. Mutation-checked: deleting the
   permission `fq` fails 3 tests.
3. `/data` characterization tests against current behavior. **← NEXT. Needs a live API +
   Solr; see STATUS at the top for what to capture and why a mock will not do.**
4. Stage 1 (`multiQuery`) conversion — biggest measured win, has a real test gate.
5. Stage 2 (`dataRouter`) — now protected by step 3.
6. Stage 3 (`ExpandingQuery`) — highest deadlock value, trickiest recursion.
7. Wall-clock deadline in `util/http.js` (see Scope). Can land any time after step 1;
   independent of the conversions.
8. `CLAUDE.md` documentation pass.

**Deploy note:** let master soak in production before stacking this on top. #202 was
deployed once and rolled back, so the current master has not had a clean production run.
Stacking both makes attribution impossible if something breaks.

**Branch base — SETTLED.** The alpha→master merge landed (#202, `bf9c9207`), followed by the
Solr timeout (#203, `6397c6cf`). `feature/eliminate-self-call` is branched from
**`6397c6cf` (master)**, which is what production runs.

**Alpha is now strictly behind master** — 14 commits behind, 0 ahead. The direction has
flipped from the pre-#202 state. So this branch merges to master normally, and alpha can be
fast-forwarded to match; no cherry-pick or second merge is needed. The three touched files
remain byte-identical on both lines, so nothing in #202 or #203 conflicts with this work.
