# P9.4Q — Public HTTP Diagnostic

Status: OFFLINE IMPLEMENTATION ONLY. Gate B: HOLD.

## Scope and entrypoint

`diagnostic/public-http-only.js` is a standalone diagnostic for possible future
public HTTP qualification. It is not the production bot. This document applies
only to this public entrypoint; `diagnostic/README.md` describes P9.4C loopback.

Do not execute the public entrypoint, `npm start`, or `bot.js` under this approval.
No commit, push, merge, deploy, Render access, credentials, Discord login or Google access.

## Boundary and PORT

Only `node:http` is imported. Import is inert: no server creation, environment
read, signal registration or timer. No bot, dotenv, Discord/Google client, token
access, outbound client, polling, retry or host fallback.

CLI reads only `PORT`: a string of canonical decimal digits representing 1–65535.
Whitespace, leading zeros, signs, zero, nonstrings and nondecimal forms are rejected
before server creation. Host is fixed to `0.0.0.0` for a separately authorized future run.

## Exact handler contract

| Request | Status | Body passed to end |
| --- | --- | --- |
| GET `/health` | 200 | `{"ok":true,"mode":"public-http-only","discord":"disabled","google":"disabled"}` |
| GET any other raw URL, including query/trailing slash | 404 | `{"error":"not_found"}` |
| HEAD any URL | 405 | none |
| Any other method, any URL | 405 | `{"error":"method_not_allowed"}` |

Every response sets `Content-Type: application/json; charset=utf-8`,
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
405 also sets `Allow: GET`. Method rejection precedes URL matching. No input is echoed.
Health establishes only diagnostic responsiveness, not production bot health.

## Limits and lifecycle

Factory option `maxHeaderSize` is 8192 bytes. Server settings: `headersTimeout` 5000ms,
`requestTimeout` 10000ms, `keepAliveTimeout` 5000ms, `maxRequestsPerSocket` 100.
The last setting limits requests per socket, not concurrent connections.
No concurrent connection cap is claimed: P9.4F requirement and threshold remain UNKNOWN.

One error listener spans startup and running. Startup failures reject with
`SERVER_CREATE_FAILED` or `LISTEN_FAILED`; partial server cleanup attempts close and
closeAllConnections through the same 5000ms shutdown deadline, without retry.
Close throws/errors exit 1; pending close exits 1 at the deadline. Create failure
without a server rejects and CLI sets exitCode 1. A late startup error is absorbed; late listen
success cannot turn failed or stopping startup into success.

Explicit start registers SIGTERM/SIGINT before server creation and owns process termination even when
`start()` is called as an export. Runtime errors log `DIAGNOSTIC_RUNTIME_FAILED`
and begin shutdown with exit 1. This export is not a reusable application server API.
CLI startup failure logs `DIAGNOSTIC_START_FAILED` and sets exitCode 1.
Signals during startup mark it stopping, reject with START_ABORTED, and begin
bounded cleanup (successful close exits 0, cleanup failure/deadline exits 1).
CLI suppresses startup-failure logging for START_ABORTED. Signal handlers remain
active during cleanup, so repeated signals cannot bypass shutdown. They are
removed on create failure without a server. Successful CLI logs DIAGNOSTIC_HTTP_READY.
No ready log is emitted if a handoff error has already begun shutdown.

Shutdown is idempotent: one close, one force-close attempt where available, one
5000ms deadline. Runtime error during graceful shutdown upgrades exit to 1.
Close errors or exceptions fail with 1. Successful signal shutdown exits 0;
deadline exits 1. Completion clears the timer and prevents duplicate exits.
5000ms is a scheduled deadline, not proof of wall-clock behavior under event-loop stalls.

## Authorized offline verification after code delta

```text
node --check diagnostic/public-http-only.js
node --check test/diagnostic-public-http-only.test.js
node --test test/diagnostic-public-http-only.test.js
```

Tests read source into a VM with an import allowlist, guarded process and entirely
stubbed HTTP factory/server, process exits, signals and timers. They never import
real node:http or open a listener. Coverage includes inert import, PORT, exact
handler outputs/headers/HEAD, factory settings, startup failure/cleanup, continuous
runtime error handling, CLI, signal shutdown, duplicate shutdown, close failures,
failure upgrade and deterministic deadline execution. P9.4J regressions cover
startup signals, startup cleanup throws/pending/error callbacks, force-close
failure with pending close, and late listen/close callbacks after failure/shutdown.

## P9.4K offline coverage

Product source is unchanged from P9.4J. Eight additional VM regression cases cross
SIGTERM/SIGINT, close-callback/deadline completion, and force-close success/throw.
Signals are emitted after LISTEN_FAILED rejection while close remains pending.
Repeated and mixed signals preserve failure exit 1, one close, one force-close
attempt and the original 5000ms timer without reset. Late listen success cannot
resolve the rejected start or produce READY; late close/timer callbacks cannot
produce a second exit. Completion clears the original timer.

These are deterministic stub assertions, not actual OS signal delivery, socket
cleanup, HTTP runtime or wall-clock timing evidence. P9.4F design, exported start
ownership conformity, and concurrent connection requirements remain UNKNOWN.

## Historical P9.4L loopback runtime evidence — HOLD

Run on Node v24.20.0, Windows win32 x64. Product source and offline test file are
unchanged. New test: test/diagnostic-public-http-only.loopback.test.js.
Syntax check PASS. Runtime suite: 9 tests, 7 PASS, 1 FAIL, 1 SKIP; exit code 1.
The offline suite was not rerun (no product/offline-test delta).

The VM uses real node:http through a wrapper which asserts source's requested
10000/0.0.0.0 then substitutes 127.0.0.1:0. All HTTP/TCP clients use loopback.
This qualifies the substituted loopback runtime, not the actual public binding.

- PASS: exact HTTP wire status/body/headers for health, query-path 404, POST 405,
  HEAD health/unknown 405 with no body; oversized 9000-character header rejected
  with 431 before request event; 100th request on same socket announces close,
  next request uses a new socket.
- Timeout case FAIL: partial headers received 408 at 30003ms. Partial body received
  200, then closed at 6018ms without the asserted 408; idle keepalive also closed
  at 6018ms. Header assertions passed before body assertion failed; idle assertions
  were not reached. No claim of demonstrated 10000ms body-timeout enforcement.
  This may reflect response completion/keepalive preceding request timeout; cause
  was UNKNOWN at P9.4L review. P9.4M below separates characterization from the
  instrumented parser test; the original P9.4L failure remains historical evidence.
- Child real process/socket cases PASS: synthetic JS SIGTERM and SIGINT events
  exited 0 in 8ms/7ms; injected server runtime error exited 1 in 7ms. These are not
  actual OS signal tests. Child process exit releases its sockets; parent cleanup
  has a 10s watchdog and kills/awaits a still-running child.
- Deadline fallback case PASS only against the declared 4900–5500ms measurement
  window: close/force-close were deliberately stubbed pending; actual source timer
  exited child with 1 at 5021ms. This does NOT meet a literal <=5000ms wall-clock
  claim, and is not evidence of successful real close APIs on the deadline path.
- SKIP / EVIDENCE MISSING: actual Windows OS SIGTERM/SIGINT graceful semantics.

Thresholds in the test are observation windows, not changes to source settings:
header/body <40000ms (allows Node connection-check scheduling), idle 4500–9000ms;
normal child shutdown <=5000ms; injected deadline 4900–5500ms. A watchdog kill
is never counted as source shutdown PASS. Runtime qualification remains HOLD.

## P9.4M independent timeout tests and cleanup before exit

Node v24.20.0, Windows win32 x64. Syntax PASS. Loopback suite: 15 tests,
14 PASS, 0 FAIL, 1 SKIP, exit code 0, duration about 77.7s.
Product source and offline tests are unchanged; offline suite not rerun.
Only the loopback test and this document changed from P9.4L.

Timeout tests now have separate server/socket instances and assertions. Measurement
windows were encoded before running: header 4500–40000ms, original-handler body
characterization 4500–9000ms, isolated parser body 9500–40000ms, idle 4500–9000ms.
Upper limits are exclusive. Each raw socket has a 40000ms watchdog; tests have
45000ms timeout (idle 12000ms). Watchdog errors fail, not pass, the test.

- Header: PASS, 408 and close at 30003ms.
- Original handler with partial body: PASS characterization only, 200 then close
  at 6013ms without 408. This does not demonstrate original-source 10000ms body
  timeout enforcement or establish the exact cause of that close.
- Isolated parser: PASS, 408 and close at 30001ms. Wrapper delays calling the product
  handler until request end while draining incoming body; source timeout settings
  remain unchanged. This is instrumented Node parser evidence, not original-handler
  behavior and not exact 10-second enforcement.
- Idle keepalive: PASS independently, 200 then close at 6009ms.

Three new held-exit child tests use real HTTP server/socket/close APIs. A process
proxy captures source process.exit as an IPC exit intent, keeping child alive.
Parent opens an incomplete request and child verifies an active connection before
synthetic SIGTERM/SIGINT or injected runtime error. Before permitting actual exit,
parent observes peer close, verifies exit intent/listening=false, and receives
ECONNREFUSED on a new connection to the old port while child remains alive.
Then parent sends release and checks actual exit code. Results:

- synthetic SIGTERM: pre-exit cleanup PASS, intent/actual code 0, about 3ms;
- synthetic SIGINT: pre-exit cleanup PASS, intent/actual code 0, about 3ms;
- injected runtime error: pre-exit cleanup PASS, intent/actual code 1, about 2ms.

Pre-exit observation must finish <=5000ms; probe has 2000ms watchdog; whole child
check has a 10000ms watchdog. Early exit or watchdog failure cannot satisfy PASS.
Finally destroys parent peer and kills/awaits a surviving child. Held exit is test
instrumentation, not proof of unmodified process-exit timing or real OS signals.
The separate original deadline test still stubs close APIs pending: 5012ms in this
run, PASS only its 4900–5500ms window, not strict wall-clock <=5000ms.

No product-source defect was established by P9.4M. Runtime qualification and Gate B
remain HOLD pending independent review and remaining external/design evidence.

## P9.4N body timeline and shutdown contract

Owner approved the contract: register a fallback with delay 5000ms on shutdown;
when its callback is scheduled by the event loop, request exit 1. Report wall-clock
separately. This does not establish P9.4F conformity or a strict <=5000ms exit SLA.

Node v24.20.0, Windows win32 x64. Syntax PASS. Full loopback suite: 18 tests,
17 PASS, 0 FAIL, 1 SKIP; exit code 0, about 88.8s. Product source/offline suite
unchanged; no offline suite rerun. Loopback-only binding remains enforced.

Original-handler body timeline observes emit calls by forwarding the original emit
with its original this/arguments/result. No timeout listener is added. Header and
one body byte are sent separately; incoming request.complete remains false, no
request end is observed, and 200 response arrives before socket timeout.
Observed timeline relative to partial-body send:

- request seen about +0.105ms; response data about +0.320ms;
- socket timeout about +6007.744ms; server timeout about +6007.768ms;
- client socket close about +6008.078ms; no 408 in wire data.

This demonstrates a socket/server timeout event path after early response with an
incomplete request, rather than an observed requestTimeout 408. No server timeout
listener was present. Inference: results are consistent with post-response socket
inactivity/keepalive handling preceding parser body timeout. Exact internal timer
attribution remains UNKNOWN; no claim that original-handler 10000ms body timeout
was exercised. Request aborted/close/error and server-socket close emit calls are
also observed when emitted before diagnostic snapshot; none appeared before client
close in this run. The test does not assert those absent events occurred.

Independent controls still PASS: partial headers 408 at 30011ms, deferred-handler
parser body 408 at 30009ms, original-handler body close at 6011ms and idle close at
6006ms. Deferred handler remains explicit instrumentation, not original behavior.

New timing workers forward source timer delay/callback unchanged and record child
trigger, timer registration, fire and exit-call timestamps. Normal worker leaves
real close APIs intact; fault-injection worker alone makes close/force-close pending.
Exit proxy synchronously writes a small trace then immediately calls real exit;
trace output adds measurement overhead. Parent wall time runs from IPC send to
child close (includes IPC/process/stdio overhead), not a pure source timer duration.

- Real close: one 5000ms fallback registration, registration lag 0.092ms,
  trigger-to-exit-call 0.634ms, exit 0, no timer fire; parent wall about 7.042ms.
- Pending-close fallback: one 5000ms registration, lag 0.086ms; timer fired about
  5004.561ms after registration; exit-call about 5004.746ms after child trigger,
  exit 1; parent wall about 5011.939ms.

The new timer assertions check one registration with delay exactly 5000, ordering,
exit code and deadline callback execution. Early-fire detection uses 4990ms as a
measurement tolerance, not a reduced requested delay; it is not strict no-early
wall-clock proof. No upper 5500ms PASS criterion is used in the new contract tests;
the independent 10s watchdog fails the test on nontermination. Historical deadline
window tests remain distinct and do not define the newly approved contract.
Existing held-exit cleanup tests also PASS with real close APIs before release.

P9.4N target contract evidence is PASS. Actual OS signals remain SKIP/EVIDENCE MISSING.
Strict <=5000ms wall-clock termination is not claimed. Gate B remains HOLD.

## P9.4O response-before-timeout regression

Product source and offline tests unchanged. Only loopback assertions and this
coverage document changed. No handler, timeout setting, watchdog or measurement
window changed. Syntax PASS. Targeted command:

```powershell
node --test --test-name-pattern '^P9\.4N original body timeline without timeout listeners$' test/diagnostic-public-http-only.loopback.test.js
```

Targeted result: 1 test PASS, 0 FAIL, exit code 0. Full runtime/offline suites were
not rerun; the P9.4N full-suite result above remains historical, not a new run.
New assertions locate first response-data and first socket:timeout, require both,
require response event index to precede timeout index, and response timestamp <=
timeout timestamp. All previous body assertions remain.

Observed first response-data index 3 at 52.6668ms; first socket:timeout index 4 at
6055.5870ms. Difference about 6002.9202ms. Client-close at 6057.3669ms; duration
from partial-body send 6007.6082ms; request.complete=false, no request end or 408.
This establishes the event-order regression in this instrumented loopback run,
not exact internal timer attribution or 10000ms body-timeout enforcement.

P9.4F, exported start ownership conformity, and concurrent connections stay UNKNOWN.
Actual OS signals and absolute wall-clock deadline proof remain EVIDENCE MISSING.
Gate B: HOLD; stop at independent review handoff.

## P9.4Q consolidated evidence register

P9.4Q is documentation-only consolidation and static verification. It creates no
new test/runtime evidence. Gate B: HOLD. Stop at independent review handoff.

### Baseline and provenance

Workspace: D:\Huynh\discord-task-bot-p9-4g. Branch: diag/p9-4g-public-http-only.
HEAD: 0177d04c0a40340cdc228e30286b0033902aa407. P9.4Q entry verification found
exactly four untracked files: this document, diagnostic/public-http-only.js,
test/diagnostic-public-http-only.test.js and test/diagnostic-public-http-only.loopback.test.js;
no tracked changes were reported. Untracked means these contents are not captured
by HEAD; hashes below identify the reviewed source/test artifacts.

| Artifact | SHA256 at P9.4Q entry and unchanged through consolidation |
| --- | --- |
| diagnostic/public-http-only.js | 1E9716C3895A212D15C1560633B6148B3BBECB15C94083CF0DF562C8DEF457EF |
| test/diagnostic-public-http-only.test.js | 2DB596758C8569F193A05091A255B2FD361B7C562D61CCE90AFB1B7132708E4D |
| test/diagnostic-public-http-only.loopback.test.js | 91B30EDA4A2FEDFB697F0D96F3392FF974D069FCF9264522A486DAADAE6C3F20 |

Input document SHA256 (P9.4P):
74EF3F69CA657CA94F82DCF3DB7E7D692EB71B25B286A969D040235CEC91A91E.
This is NOT the final P9.4Q document hash. The final hash is supplied separately
in the handoff to avoid self-reference.

Abbreviations in the evidence table: S = diagnostic/public-http-only.js;
U = test/diagnostic-public-http-only.test.js;
L = test/diagnostic-public-http-only.loopback.test.js. Numeric line pointers refer
to the unchanged artifacts identified above. Historical results and reviewer
verdicts below come from the preceding P9.4J–P9.4P chat handoffs/reviews and the
historical sections of this document. Console transcripts are not separate saved
artifacts in this package; P9.4Q does not rerun, independently reproduce or invent
those results. No execution dates or deployment identity are inferred.

### Claim-to-evidence mapping

| ID / claim | Artifact pointers | Method and historical result | Review disposition / limit |
| --- | --- | --- | --- |
| E01 import isolation, canonical PORT and fixed requested host | S:3–11,69–70,94–114; U:11–95 | Static + guarded VM/stubs; covered by P9.4K offline 36/36 PASS | P9.4K review PASS within offline scope; no public binding or OS sandbox proof |
| E02 exact handler status/body/headers and HEAD | S:14–29; U:120–137; L:173–189 | Stub assertions plus real loopback HTTP wire cases; P9.4L/M/N corresponding cases PASS | Partial runtime evidence accepted; tested method/path cases only, wrapper replaces binding |
| E03 HTTP resource configuration and requests/socket | S:97–108; U:90–97; L:190–212 | Stub checks settings; loopback oversize header 431 before request and 100th request connection close PASS | Header rejection and requests/socket evidenced; concurrent connection cap not established |
| E04 startup/runtime lifecycle, signals and bounded cleanup logic | S:33–120; U:100–118,139–329 | VM HTTP/process/timer stubs; P9.4J 28/28 and P9.4K 36/36 PASS historically | P9.4J/K targeted reviews PASS static/offline; actual OS signal delivery not proven |
| E05 distinct timeout behaviors | L:18–22,213–245 | P9.4M separate tests PASS; P9.4N header/parser about 30s, original-body/idle about 6s | P9.4M review accepts separate tests; deferred handler is instrumentation; original body-timeout enforcement remains open |
| E06 real socket/listener cleanup before actual exit | L:123–151,269–326 | P9.4M/N held-exit child tests PASS: peer closed, port refused, child alive before release; signal exit 0, injected error exit 1 | P9.4M review accepts instrumented pre-exit cleanup evidence; no real OS signals or unmodified exit timing claim |
| E07 Owner-approved fallback registration contract | S:33–66; L:35–41,91–122,376–410 | P9.4N exact 5000ms registration, callback then exit 1; parent wall about 5011.939ms; normal exit 0 | P9.4N review PASS for approved contract; no absolute <=5000ms wall-clock SLA, early-fire test has 4990ms tolerance |
| E08 original-body response precedes socket timeout | L:328–375, especially 362–368 | P9.4O targeted 1/1 PASS; response index 3, timeout index 4, timestamps ordered | P9.4O assertion review PASS static; no internal timer attribution or body-timeout proof |
| E09 repaired targeted command and document structure | This document: P9.4O response-before-timeout regression section | P9.4P static verification only; command restored and duplicate qualification removed; no test run | P9.4P independent review PASS; remaining qualification HOLD |

### Historical execution and review ledger

| Stage | Execution evidence at that stage | Independent-review result / scope |
| --- | --- | --- |
| P9.4J | Offline 28 PASS, 0 FAIL | Targeted lifecycle PASS static/offline; signal-during-failed-start-cleanup evidence still missing then |
| P9.4K | Offline 36 PASS, 0 FAIL | Targeted offline review PASS; closes that regression gap, not runtime qualification |
| P9.4L | Loopback 7 PASS, 1 FAIL, 1 SKIP; exit 1 | HOLD: grouped timeout assertion failed; body-timeout test design and pre-exit cleanup evidence incomplete |
| P9.4M | Loopback 14 PASS, 0 FAIL, 1 SKIP; exit 0 | Targeted remediation PASS; separate tests and held-exit cleanup accepted with limits |
| P9.4N | Full loopback 17 PASS, 0 FAIL, 1 SKIP; exit 0 | Fallback contract PASS; original-body explanation partial; response-before-timeout regression assertion missing then |
| P9.4O | Targeted body timeline 1 PASS, 0 FAIL; exit 0; no full-suite rerun | Assertion PASS static; handoff HOLD due malformed document command/duplicate content |
| P9.4P | Static document checks only; no test run | Documentation remediation PASS; Gate B HOLD |
| P9.4Q | Consolidation/static checks only; no test or listener run | Awaiting independent review; no new qualification PASS claimed |

P9.4L failure is preserved as historical evidence, not erased or reclassified as
PASS. P9.4M changed the test design by splitting characterization from instrumented
parser behavior. The latest full runtime run is P9.4N on its prior test hash;
the current test hash includes the P9.4O assertions checked by one targeted run.
The latest full offline run is P9.4K on the still-current offline-test/source hashes.
Do not describe current four-file package as newly full-suite tested in P9.4Q.

### Evidence limits

- All real listeners were substituted to 127.0.0.1:0 after validating the source's
  requested 10000/0.0.0.0. Public binding and hosting were not exercised.
- VM/process guards and HTTP stubs prove specified interactions, not OS containment.
- process.emit signals are synthetic JS events; the actual OS signal case is skipped.
- Deferred handler isolates parser behavior and cannot stand in for original handler.
- Held-exit proxy allows pre-exit socket/listener observation but changes exit timing.
- Pending-close fault injection and timer/exit tracing have distinct scopes; trace
  write, IPC, scheduling and process close add measurement overhead.
- A requested fallback delay of 5000ms is the approved contract; observed wall-clock
  overruns are reported separately and do not become <=5000ms proof.

### Open qualification register and closure conditions

No unresolved product SOURCE OPEN defect was confirmed by the latest scoped reviews.
This is not a guarantee that source has no defects. Prior lifecycle SOURCE OPEN
items were addressed in P9.4J; regression evidence was extended in K/O; document
SOURCE OPEN from O was closed by P. New findings require their own evidence and
Owner-approved remediation scope. The rows below remain open and do not authorize work.

| ID | Status | Open question / existing evidence | Evidence or decision required to close |
| --- | --- | --- | --- |
| Q01 | UNKNOWN | Original P9.4F design not available; mapping uses Owner-listed criteria | Obtain authoritative design and record requirement-by-requirement mapping/review; retain UNKNOWN until then |
| Q02 | UNKNOWN | Exported start owns process signals/termination (S:32,74–95); documented and tested | Authoritative design/Owner decision on this API ownership, then verify implementation against that decision |
| Q03 | UNKNOWN | Concurrent connection requirement/threshold absent; S:108 is requests/socket only | Approved requirement and threshold or explicit not-required decision; if required, separately authorized implementation and evidence |
| Q04 | EVIDENCE MISSING / UNKNOWN | Original-handler 10000ms body-timeout enforcement not demonstrated; response precedes socket timeout; exact internal timer cause unknown | Focused evidence for deployed Node behavior and requirement interpretation; identify timer path or document approved acceptance of observed behavior without claiming unobserved enforcement |
| Q05 | EVIDENCE MISSING | Actual OS SIGTERM/SIGINT graceful semantics; L:412 skipped | Separately authorized tests on the intended OS/process environment with genuine signal delivery and cleanup/exit evidence |
| Q06 | EVIDENCE MISSING | Absolute wall-clock <=5000ms exit and strict no-early firing not proven; approved registration contract E07 has evidence | Confirm whether stricter timing is required; if so define environment/measurement criteria and obtain evidence; otherwise explicit decision that stronger SLA is not a requirement (not a claim it was proven) |
| Q07 | EVIDENCE MISSING | Exact deployed Node version/build/start command and artifact provenance unverified; local observations used v24.20.0 win32 x64 | Read-only deployment/build provenance and isolated-runtime evidence under separate approval; no secrets needed in this record |
| Q08 | EVIDENCE MISSING | Render identity, environment isolation, containment authority and operational permissions unverified | Separately approved identity/isolation/containment records and explicit Owner operational authorization; offline PASS cannot supply these |
| Q09 | EVIDENCE MISSING | Actual public binding/hosting path not tested; only guarded loopback substitution | Separately authorized public qualification or explicit requirement disposition; do not open public listener under current scope |

P9.4Q PASS means completeness/traceability of this documentation only. Each open
qualification keeps its status until the required evidence/decision is reviewed.
Gate B: HOLD. No commit, push, merge, deployment, Render/Discord/Google access or
credentials are authorized by this register. Stop at independent review handoff.

## Remaining qualification / reviewer handoff

- UNKNOWN: original P9.4F design is unavailable; mapping uses Owner-listed criteria.
- UNKNOWN: concurrent socket requirement/threshold; no new value is invented.
- PARTIAL EVIDENCE: loopback wire/HEAD/header-limit and requests-per-socket are tested
  above. P9.4M adds instrumented parser and pre-exit cleanup evidence. Original-handler
  body-timeout enforcement, exact timeout timing, actual OS signals and strict
  wall-clock shutdown remain EVIDENCE MISSING. VM/stubs are not an OS sandbox.
- EVIDENCE MISSING: exact deployed Node version/build pipeline, Render identity and
  environment isolation, containment authority and deployment authorization.

Offline PASS does not resolve these items or authorize a public run. Gate B: HOLD.
