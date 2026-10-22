# SYNC-SAFETY-03A — isolated implementation and qualification

Base: production commit `bcbede2b41bd6bcc88c745abc04b7b904fcef589`.

Branch/worktree: `sync-safety-03a` in the existing isolated `sync-safety-01` worktree. This package was built and tested locally only. It did not call production APIs, send Discord messages, submit a Form, change a Sheet, restart Render, deploy Apps Script, push, merge, or reset any `POSTING`/`SYNCED` state.

## Result

**ISOLATED IMPLEMENTATION: PASS. PRODUCTION RELEASE GATE: FAIL/CLOSED.**

The implementation is reviewable and its local mocks pass. Production remains closed because the deployed Apps Script contract and Render `GOOGLE_SCRIPT_URL` deployment ID have not been matched to this candidate, Discord full history is still unverified, and no rollout authorization has been granted.

## Implemented controls

- Sync mutation defaults OFF. New sends and `discordInfo` reconciliation require `DISCORD_SYNC_SEND_ENABLED=true`.
- The request ID must also appear exactly in comma-separated `DISCORD_SYNC_ALLOWLIST`; an empty list denies every task.
- The bot calls authenticated `syncContract` and requires exact version `SYNC-SAFETY-03A/1` plus all four safety capabilities before claiming.
- `discord.js` REST retries are set to zero. This prevents the library from automatically repeating a create-message request after an ambiguous 5xx or connection reset. The setting is client-wide, so transient failures on other Discord operations also surface immediately for conservative handling.
- A successful claim must return a 16–128 character `claimId`. The bot carries it into `discordInfo` as a fencing token.
- Explicit `POSTING`, `RECONCILE_REQUIRED`, and known message IDs remain no-retry states.
- The Apps Script candidate stores claim records in Script Properties under a SHA-256-derived key. It does not assume AF:AH and does not change the 31-column Sheet schema.
- Candidate `discordInfo` accepts a current fenced claim, treats the same Message ID as idempotent, and preserves the first Message ID on conflict.

The Apps Script file is an isolated integration module, not a deployed complete project. Before use, add the `syncContract` dispatch case, replace the two named sync functions in the verified candidate, and attach `getDiscordClaimId(task.requestId)` to each unsynced task payload. Do not paste it into production until the integration diff and deployed version are independently checked.

## Qualification evidence

Command: bundled Node runtime with `node --test`.

Result: **22 passed, 0 failed**.

Covered behavior:

- overlapping polls in one process;
- two bot instances with atomic and deliberately broken claims;
- ambiguous claim timeout;
- HTTP 500, `ECONNRESET`, and timeout after Discord accepted a send;
- `discordInfo` timeout reconciliation without repost;
- `POSTING` no-retry;
- kill switch OFF (including reconciliation writes) and empty allowlist;
- handshake mismatch and missing claim ID fail-closed;
- candidate concurrent claim winner;
- stale fencing token rejection;
- idempotent same-message finalize and conflict-preserving different-message finalize;
- 300-message visibility limit remains demonstrated as unsafe without the claim layer;
- source scan for credential literals.

Additional checks: `node --check bot.js` and Apps Script parse passed. The diff was reviewed with the repository's existing CRLF endings preserved. No dependencies were downloaded or changed.

## Known limits and unproven production facts

- Discord and Google Sheets cannot share one transaction. An accepted Discord message followed by a lost response remains an uncertain outcome. Safety depends on leaving the row `POSTING` and reconciling before any manual reset.
- A 300-message scan and bot-author filter are evidence helpers, not uniqueness guarantees. Full Discord history for the target is still unverified.
- Script Properties are outside the Sheet schema and avoid AF:AH, but operators need a documented backup/inspection procedure before rollout. Deleting a claim property or resetting `POSTING` can defeat fencing and is forbidden during recovery.
- The live Apps Script deployment version and the deployment ID configured in Render have not been read back and compared with the candidate.
- The production service has not run the contract handshake. A mismatch must keep sends disabled.
- No test in this package proves Render is still a single live instance at rollout time; that check must be repeated immediately before qualification.

## Rollback package

The primary rollback is configuration-only: keep or set `DISCORD_SYNC_SEND_ENABLED` to anything other than `true`. This stops new claims/sends even if the code is present. Do not clear the allowlist as a substitute for the kill switch during incident response; set the explicit switch OFF.

Code rollback is reverting the eventual 03A bot commit and restoring the prior Apps Script deployment version. Preserve Script Properties and all Sheet `POSTING`, `RECONCILE_REQUIRED`, `SYNCED`, Message ID, channel ID, and URL fields for audit. Never reset uncertain rows as part of rollback.

## Production gates, in order

1. Review this diff and confirm the Script Properties claim store is acceptable.
2. Build a complete Apps Script candidate from the exact deployed source and verify the integration diff.
3. Deploy Apps Script only as a new version, while bot sending remains OFF.
4. Read back the deployed version/URL and match its deployment ID to Render `GOOGLE_SCRIPT_URL`.
5. Run authenticated read-only `syncContract`; require the exact contract and capabilities.
6. Recheck one active Render instance, expected bot commit, target row state/blank Discord fields, and Discord history. Any uncertainty keeps the gate closed.
7. Deploy the bot with sending OFF and empty allowlist; verify health and contract logs.
8. In a separate authorized change, allowlist only the approved request ID and enable sending. Observe one claim and one finalize. Do not broaden the allowlist automatically.

