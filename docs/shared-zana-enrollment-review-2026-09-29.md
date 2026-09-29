# Shared Zana: enrollment review — 29 September 2026

The continued review found and fixed an enrollment failure boundary that could replace a machine's saved identity with a different identity returned by the server. The same client also lacked a request/body deadline, response-size bound, and redirect restriction outside the Connect wrapper.

## Changes

`apps/host-daemon/src/enroll.ts` now:

- Requires a returned machine ID to match the requested ID before the runtime writes credentials.
- Rejects redirects on every enrollment request, including loopback/direct enrollment.
- Applies a 15-second deadline through response-body reading and a 16 KiB streamed-response limit.
- Reports HTTP status without echoing remote error bodies. JSON and schema validation errors are replaced with a fixed message because both parsers can quote sensitive response contents.
- Releases its deadline timer on success and every failure path. Failed enrollment leaves the caller's existing identity/credentials intact and releases the installation lock.

The BB source at `apps/host-daemon/src/enroll.ts` was compared directly. BB validates its response schema and truncates HTTP error text, but the inspected implementation does not enforce these identity, streaming-limit, deadline or redirect checks. This is additional Zana hardening, not a claim that these safeguards were copied from BB.

The desktop browser-sign-in dependency's fetch type was narrowed to the string URLs it actually accepts, resolving an Electron/DOM fetch type mismatch without changing runtime behavior.

## Verification

Logs are under `.zcc/artifacts/shared-machines-implementation/`:

- `enrollment-review-before.log`: four initial regression checks fail before the enrollment fix.
- `enrollment-review-redaction-before.log`: two additional checks reproduce JSON-parser and schema-validator response disclosure before error sanitization.
- `enrollment-review-final-unit.log`: **49 tests in eight files pass**. The changed enrollment client has **100% statements, branches, functions and lines** in `enrollment-review-final-coverage/coverage-summary.json`.
- The integration suite launches the actual packed daemon in private HOME directories against real HTTP servers. Wrong identity, oversized response, redirect, stalled body and malformed JSON each fail without changing existing credentials or retaining the daemon lock. The stalled-body test exercises the real 15-second deadline.
- The same run covers successful Connect transport with two machines, repair, callback authorization and revocation; packaged secondary-CLI rejection with working remote terminals; updater rollback; and join lifecycle behavior.
- `enrollment-review-final-typecheck.log` exposed the Electron fetch type mismatch; `enrollment-review-final-typecheck-retry.log` passes after the declaration fix. The failing log is preserved.
- `enrollment-review-built.log`: **six of seven built-Electron scenarios pass** in run `1790679843466-43297-fb54854f`. All five Job Team scenarios and the two-daemon native/browser sharing scenario pass. The live suite has one OpenCode CLI Agent `build` launch timeout at the control request boundary; its other 53 launch checks, Memory and Browser pass. The timeout's root cause is not established. This combined run is not described as green.
- Final rebuilt qualification is in progress in `enrollment-review-final-built.log`.

`enrollment-review-shared-client-unit.log` separately records two shared-client failures and two unhandled rejections: those tests still expected the old embedded login window while the concurrently updated shared-client implementation used browser sign-in. After the corresponding test updates arrived in the checkout, `enrollment-review-shared-client-retry.log` passes **26 tests in three files**, including the new browser-sign-in suite. This enrollment follow-up changed only the fetch dependency's type declaration in that feature; it does not claim authorship of the concurrent sign-in implementation/test updates. The initial failed run is retained.

## Remaining boundary

The previous [necessary gap fixes](shared-zana-gap-fixes-2026-09-29.md) remain implemented. Secondary-machine CLI Agents and Squad/Team execution remain deferred, along with development-port sharing, instance import and server relocation. This change does not activate those features or change the host protocol.

An authenticated public trial on two physical machines remains outstanding, including account isolation, revocation, reconnect, primary restart and rollback. Local packed-daemon/built-Electron checks do not replace that trial. No production deployment or Cloudflare change was made during this enrollment follow-up, and the wider dirty checkout is not covered by this focused sign-off.
