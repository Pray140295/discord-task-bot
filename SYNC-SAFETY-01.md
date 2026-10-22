# SYNC-SAFETY-01 — isolated audit

Audit base: production commit `bcbede2b41bd6bcc88c745abc04b7b904fcef589`.

Scope: static review and local mock tests only. No production API was called. No Discord message, Google Sheet/Form mutation, status reset, deployment, merge, or remote push was performed.

## Verdict

**FAIL — production deployment remains blocked.**

The bot is safe against overlapping polls inside one Node.js process and it behaves conservatively for several uncertain network outcomes. Its cross-instance duplicate prevention, however, depends entirely on an atomic and durable Apps Script `claimSync` implementation. The available Apps Script source snapshot contains no `claimSync`, no `LockService`, no `POSTING` state, and no reconciliation fields in `unsynced`. The required safety property therefore cannot be established from the available code.

The eight historical messages for `TASK-261020143627` prove that duplicates existed. They do not prove which version or race produced them. No causal claim about the current production commit is made here.

## Evidence-based findings

| Gate | Result | Evidence and consequence |
| --- | --- | --- |
| Same-process poll serialization | PASS | `bot.js:157-161` uses the in-memory `polling` flag. The overlapping-poll mock sent once. |
| Same-process per-task serialization | PASS, process-local only | `bot.js:156,169-170,200` uses `processing`. It does not coordinate Render instances or restarted processes. |
| Reconcile before send | PASS, bounded | `bot.js:168-186` scans Discord first and refuses to repost payloads that explicitly say `POSTING`, `RECONCILE_REQUIRED`, or contain `messageId`. |
| Atomic cross-instance claim | FAIL / no implementation evidence | `bot.js:191-192` relies on `claimSync`. `sources/DiscordAPI.gs.txt:79-100` has no `claimSync` action; the entire snapshot has no `LockService`, recheck-under-lock, or `POSTING`. The two-instance test sent once with an atomic claim mock and twice with a grant-both mock. |
| Durable `POSTING` visible to bot | FAIL in available snapshot | `sources/DiscordAPI.gs.txt:127-152` includes every non-`SYNCED` row but omits `syncStatus`, `messageId`, and `messageUrl`. The guard at `bot.js:183-188` cannot use state that is not returned. |
| `claimSync` timeout handling | PASS, conservative | `bot.js:191-194` awaits the claim before sending. An ambiguous claim timeout produced zero Discord sends. The row may remain `POSTING`, which requires reconciliation. |
| `channel.send` uncertain outcome | PASS only while message remains discoverable | A mock where Discord accepted the message and then timed out was reconciled on the next poll without a resend. This depends on scan visibility or a known message ID. |
| `discordInfo` uncertain outcome | PASS only while message remains discoverable | `bot.js:194-199` inserts the returned message into the local scan map before saving. A timeout was retried by scan on the next poll without a resend. |
| 300-message scan | FAIL as uniqueness mechanism | `bot.js:131-148,168` scans at most 300 messages. The test placed the prior task at position 301; with a failed claim layer, the bot reposted it. Scan is useful reconciliation evidence, not a correctness boundary. |
| Safe `discordInfo` conflict handling | FAIL | `sources/DiscordAPI.gs.txt:336-348` performs an unlocked read/overwrite and always writes `SYNCED`. A concurrent later message can overwrite the first Message ID, hiding duplicate evidence. |
| API authentication in available snapshot | FAIL | `bot.js:35-41` sends `apiToken`, but `sources/DiscordAPI.gs.txt:74-108` does not validate it and the snapshot never references `apiToken`. Deployment code may differ; this must be verified before release. |
| Exactly-once across Google and Discord | NOT ACHIEVABLE with these APIs | There is no shared transaction covering a Sheet write and Discord message creation. The safe policy is at-most-once-biased: persist `POSTING`, send once, and freeze uncertain outcomes for reconciliation. |

## Race and restart analysis

The `polling` and `processing` guards disappear on restart and are independent in every Render instance. Two instances can both scan an empty channel and both reach `claimSync`. Only a server-side lock plus a status recheck can choose one winner.

The critical sequence must be:

1. Apps Script acquires a script-wide lock.
2. It finds the task and rereads `SYNC_STATUS` and Discord identity columns while holding that lock.
3. It grants only an allowlisted `New` row whose status and Discord identity columns are empty.
4. It writes durable `POSTING`, a unique claim ID, and timestamp, then flushes before returning `claimed: true`.
5. The bot sends exactly once for that claim.
6. `discordInfo` records the Discord identity idempotently. A different existing Message ID is a conflict, never an overwrite.

Any timeout from step 4 onward is uncertain. The bot must not automatically obtain another claim or resend. `POSTING` must not expire or reset automatically. Recovery must first find and bind the existing Discord message; absence from the latest 300 messages is insufficient proof that no message exists.

For `TASK-261022080813-6DF75A00`, a restart of the current production bot is unsafe to approve because the row is `New`, Discord has no currently observed matching message, and the actual deployed `claimSync` safety contract is unverified. The historical eight-message duplicate raises the impact of a wrong assumption but does not identify the cause.

## Minimum production fix design (not implemented)

The production patch should be limited to these changes:

1. Apps Script validates `apiToken` before action dispatch.
2. Add `claimSync` using `LockService.getScriptLock()`, `waitLock`, and a recheck under lock. Write `POSTING`, `claimId`, and timestamp durably before returning.
3. Return `syncStatus`, `messageId`, `messageUrl`, and `claimId` from `unsynced`.
4. Make `discordInfo` idempotent under the same lock. Accept the same Message ID repeatedly; reject a different Message ID with a conflict response and preserve the original.
5. Keep `POSTING` and all uncertain outcomes frozen. Add no automatic timeout reset and no automatic repost recovery.
6. Add a deny-by-default environment allowlist. Initial production authorization contains only `TASK-261022080813-6DF75A00`; all other `New` tasks are report-only until separately approved.
7. Keep sending disabled by default with an explicit release gate. A read-only preflight must verify one active Render instance, the deployed commit, the row's blank Discord fields, no matching Discord message beyond the bounded bot scan where operationally possible, and the live Apps Script contract.

Because the Sheet schema currently ends at AC, the exact storage location for `claimId` needs an explicit schema choice before coding. Reusing W:AC would destroy existing Discord metadata; adding a dedicated column is safer.

## Approval gates before production coding or deployment

- Obtain the exact deployed Apps Script source/version and compare it with `sources/DiscordAPI.gs.txt`.
- Approve the Sheet schema location for `claimId` and claim timestamp.
- Approve the deny-by-default task allowlist behavior.
- Run the same mock cases against extracted production functions, plus Apps Script lock contention tests.
- Review the code diff and test results before any push, merge, Render deploy, restart, or status reset.
- After deployment, keep sends disabled for read-only health and contract checks; enabling the single-task allowlist is a separate approval gate.

## Isolated tests

`test/sync-safety.test.js` executes the production `bot.js` in a VM with mocked Discord and Apps Script boundaries. It covers overlapping polls, two-instance atomic and non-atomic claims, ambiguous claim timeout, accepted-send timeout, `discordInfo` timeout, explicit `POSTING`, the 300-message blind spot, and three static Apps Script contract checks.

Result: **11 passed, 0 failed**. These passing tests validate the described behaviors and reproduce the unsafe cases; they do not make the overall release gate pass.
