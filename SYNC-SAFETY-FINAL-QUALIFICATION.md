# DISCORD SYNC-SAFETY — final qualification

Date: 2026-10-22 (Asia/Saigon)

Production baseline: Render commit `bcbede2`; diagnostic `27318d3` remains undeployed. Isolated branch: `sync-safety-03a`, based on prior qualified commit `06b6a1e`.

## Decision

- **ISOLATED QUALIFIED**
- **PRODUCTION BLOCKED**

The complete bot and Apps Script candidate pass all local qualification tests. Production remains blocked because a complete Discord history audit for the canary is not established. No production mutation, Discord send/delete, Sheet/Form change, Render restart, deployment, push, or merge was performed.

## Completed changes

1. Reviewed `06b6a1e` and retained its default-OFF kill switch, empty deny-by-default allowlist, exact contract handshake, claim fencing, conflict-safe finalization, and Discord REST `retries: 0`.
2. Replaced the partial Apps Script integration module with a complete candidate derived from the verified Version 22 source.
3. Added `syncContract` routing and `claimId` to `task`/`unsynced` payloads.
4. Stored claim records in Script Properties under a SHA-256-derived key. No Sheet column or schema migration is required.
5. Made ordering explicit:
   - claim property is written before `POSTING`;
   - any property value, including malformed data, is a stop marker;
   - Discord identity is written and flushed before claim property deletion;
   - the same Message ID is idempotent and a different ID is rejected.
6. Added fault-injection and restart tests for inconsistent Script Properties/Sheet writes.
7. Added safe rollout defaults and a read-only smoke script that emits booleans only.

## Candidate provenance and production evidence

The Version 22 `DiscordAPI.gs` base SHA-256 is:

`F81FC4254D33EA0F02AFB22CC1465073C0E866447D5BE7EF3373336D64D65446`

Prior read-only evidence established:

- Apps Script active deployment is Version 22.
- Version 22 source matches the local candidate base after newline normalization.
- Render is Live on `bcbede2` with one Free instance.
- Canary row B410 is `TASK-261022080813-6DF75A00`, status `New`, W:AC blank.
- Sheet ends at AE; AF does not exist; J4 has an unrelated `#REF!`.

This qualification additionally checked the Render environment in its authorized UI and verified that `GOOGLE_SCRIPT_URL` ends with the active Version 22 deployment ID. The full URL and all secret values were neither reported nor committed.

## Discord audit evidence

The native Discord session allowed read-only access to server `THISO` and channel `1511385282346487883` (`thông-báo`).

- Broad search for the hyphenated request ID was tokenized and produced 16,572 results over 400 pages; it is not usable as exact evidence.
- A quoted full-ID search and a unique numeric-segment search returned zero results.
- These zero-result searches are **not** treated as proof of absence because Discord search/indexing of embed fields and historical coverage were not independently proven.
- A page-by-page full-history inspection was not completed.

Therefore the canary message state remains ambiguous and production sending stays blocked.

## Actual qualification results

`node --test`: **31 passed, 0 failed**.

Syntax checks passed for:

- `bot.js`;
- `scripts/smoke-readonly.js`;
- complete Apps Script candidate parsed as JavaScript.

The tests cover:

- overlapping polls and two concurrent bot instances;
- atomic and deliberately broken claims;
- claim timeout and process restart;
- Discord accepted-then-timeout, HTTP 500, and `ECONNRESET`;
- REST retry disabled;
- default-OFF kill switch and empty allowlist;
- contract mismatch and missing claim ID;
- `POSTING` no-retry;
- stale fencing tokens;
- idempotent same-message finalize and different-message conflict;
- property write failure before Sheet write;
- Sheet write/flush failure after durable claim property;
- finalize Sheet write/flush uncertainty;
- claim-property deletion failure after `SYNCED`;
- no credential literals in candidate/config/smoke sources;
- read-only smoke action allowlist.

## Controlled failure modes

| Failure | Result |
| --- | --- |
| Kill switch absent/false | No claim, send, or reconciliation mutation |
| Request ID not allowlisted | No claim or send |
| Contract unavailable/mismatched | Fail-closed before claim |
| Claim response lacks valid `claimId` | No Discord send |
| Script Properties set fails | Claim does not return; Sheet stays unchanged |
| Property succeeds, Sheet write fails | Durable property blocks all later claims, including after restart |
| Claim flush is uncertain | `POSTING`/property keep task frozen |
| Discord 5xx/timeout/reset after acceptance | No library retry; later discovery reconciles without repost |
| Finalize Sheet write fails | `POSTING` and claim remain for reconciliation |
| Finalize flush result uncertain | Stored same ID is idempotent; different ID conflicts |
| Claim property delete fails after finalize | `SYNCED` identity wins; orphan property is a conservative stop marker |
| 300-message scan misses history | Claim/fencing remains correctness boundary; scan alone never authorizes resend |

## Exact migration

No Google Sheet schema migration is needed. Do not add AF:AH and do not change historical rows.

Required deployment changes, when separately authorized:

1. Create a new Apps Script version from `apps-script/DiscordAPI.v22.sync-safety-03a.gs`.
2. Preserve the existing Script Property `DISCORD_API_TOKEN` and add no claim properties manually.
3. Add Render environment keys with safe initial values:
   - `DISCORD_SYNC_SEND_ENABLED=false`
   - `DISCORD_SYNC_ALLOWLIST=`
4. Deploy the candidate bot commit while keeping the two keys above unchanged.

Script Properties with prefix `DISCORD_SYNC_CLAIM_` are created only by successful claims. Never delete them or reset `POSTING` as routine recovery.

## Read-only smoke and rollback

Run `npm run smoke:readonly` only after Apps Script and bot deployment, with sending still OFF. It checks deployment suffix, exact contract capabilities, and optional bot health; it prints booleans only.

Rollback order:

1. Set `DISCORD_SYNC_SEND_ENABLED=false` and confirm health.
2. Preserve every Sheet status/Discord identity field and every `DISCORD_SYNC_CLAIM_` property.
3. Roll back the bot to the prior known commit if needed.
4. Restore the prior Apps Script deployment version if needed.
5. Reconcile uncertain `POSTING` rows manually; never reset or resend based only on a 300-message scan.

## Remaining blockers and minimum owner actions

1. Establish canary history with a method that covers embed fields and the accessible full channel history, or explicitly choose a new unused canary after read-only verification. A Discord search result of zero is insufficient.
2. Review and approve the isolated diff and Script Properties lifecycle.
3. Authorize deployment as a separate production change. Initial deployment must keep the kill switch OFF and allowlist empty.
4. After the read-only smoke passes, explicitly authorize a single-task canary rollout. No test send is authorized by this package.

If any endpoint/contract check fails, task state is ambiguous, or rollback preservation cannot be guaranteed, stop before enabling the allowlist.

