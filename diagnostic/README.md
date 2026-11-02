# P9.4C HTTP-only diagnostic

Offline implementation based on 105473c89d897bd30f42683dd5dcb2da48de8d54.
Gate B remains HOLD. This is not a production readiness or deployment approval.

## Boundary

Only Node built-in HTTP is imported. No bot.js, Discord client, dotenv,
credentials, environment reads, Google requests, polling or outbound client.
Importing the entrypoint does not start a listener. Only start is exported; the server factory is internal.
The exported start function defaults to 127.0.0.1:3000 and accepts only literal
127.0.0.1 or ::1. Invalid host/port and listen failures fail closed; there is no
fallback to a public interface. PORT/HOST environment variables are ignored.
Port 0 is available for an ephemeral offline test listener.

GET /health returns fixed JSON with HTTP 200 and disabled Discord/Google status.
Other paths return 404; non-GET methods return 405. Responses never echo input.
A successful health response establishes only this HTTP process is responsive;
it does not establish Discord/Google connectivity or production bot health.

## Authorized offline verification

From this separate worktree, run only:

    node --test test/diagnostic-http-only.test.js

Tests use an isolated VM with an import allowlist and a process access trap.
The integration VM receives only guarded server creation, not HTTP client APIs. The guard rejects public bindings before I/O. This is a regression check, not an OS network sandbox. They exercise import without startup, handler responses and headers, rejected bindings,
default IPv4 and stubbed IPv6 loopback settings, listen failure without retry, CLI success/failure with a stub listener and exit-code assertions, and one ephemeral loopback HTTP
request. The test closes its listener. No packages need installing.

For a separately authorized future manual local session the entrypoint is
node diagnostic/http-only.js (stop with Ctrl+C). This session did not run that
command. Do not use npm start: it points to the unchanged production bot.

## HOLD / gates

Offline test PASS does not lift Gate B. Push, merge, deployment, Render resume,
public binding, real tokens, Discord login and Google access require a separate
review and authorization. Existing production code and package scripts are
unchanged. No existing diagnostic branch is merged.
