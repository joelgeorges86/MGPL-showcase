import * as Sentry from "@sentry/node";
import type { ErrorEvent, EventHint } from "@sentry/node";
import { safeErrorMessage } from "../utils/errorSanitizer";

/**
 * WUD-PI003-4 ΓÇö Privacy-Minimized Error Observability (Sentry adapter).
 *
 * Single isolated server-side integration boundary for optional exception
 * capture. This module is the ONLY place `@sentry/node` is imported anywhere
 * in the codebase ΓÇö no other file should import the SDK directly.
 *
 * Hard contract (do not weaken without a new approved WUD):
 *   1. No-op by default. `initSentry()` does nothing unless the `SENTRY_DSN`
 *      environment variable is present. No network call, no background
 *      timer, and no process-level hook is installed when disabled.
 *   2. Exception capture only. Tracing, profiling, session tracking, replay,
 *      logs, metrics, and all default/breadcrumb-producing integrations are
 *      explicitly disabled. `tracesSampleRate` and `profilesSampleRate` are
 *      never set, `defaultIntegrations: false`, and no `integrations` array
 *      is registered.
 *   3. `sendDefaultPii` is explicitly `false` and `dataCollection` disables
 *      every request/user data category the SDK could otherwise attach
 *      automatically (cookies, headers, query params, request/response
 *      bodies, user info).
 *   4. Deny-by-default event scrubbing runs in `beforeSend`, registered at
 *      `init()` time, before any event can be captured. The scrubber strips
 *      `request`, `user`, `contexts`, `extra`, `breadcrumbs`, `server_name`,
 *      and rewrites `exception[].value` / stack-frame `filename`/`abs_path`
 *      through the existing `safeErrorMessage` sanitizer so no absolute
 *      local path, secret-shaped value, or provider payload can survive into
 *      the outgoing event.
 *   5. `captureSentryException` never throws and never blocks the caller: it
 *      is fire-and-forget from the perspective of the terminal API error
 *      handler, so a Sentry-side failure can never delay or alter an HTTP
 *      response (see src/middleware/errorSanitizer.ts).
 *
 * Terminology: this module and its documentation use "privacy-minimized
 * telemetry" ΓÇö never "Zero-PII" ΓÇö per the approved WUD language.
 *
 * Out of scope for this WUD (explicitly not implemented here): tracing,
 * profiling, session replay, browser/client telemetry, source-map upload,
 * a public debug route, alerting/dashboard configuration, and production
 * activation. Doppler `SENTRY_DSN` values for staging/production are set
 * exclusively by the Principal Operator; this file never reads, prints, or
 * persists the DSN value itself ΓÇö it only checks for its presence.
 */

let initialized = false;

/** True once `initSentry()` has run and found a usable `SENTRY_DSN`. */
export function isSentryEnabled(): boolean {
  return initialized;
}

/** Test-only: reset the module's initialization flag between test cases. */
export function __resetSentryStateForTests(): void {
  initialized = false;
}

/**
 * Deny-by-default event scrubber. Registered as `beforeSend` so it runs
 * before every outgoing event, whether the event originated from this
 * adapter's `captureSentryException` or anywhere else the SDK might be
 * triggered in the future. Returns a minimal, sanitized event ΓÇö never the
 * original object ΓÇö so no caller-supplied field can leak through untouched.
 */
export function scrubSentryEvent(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
  const scrubbed: ErrorEvent = {
    // Preserve only fields required for grouping/triage.
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    environment: event.environment,
    release: event.release,
    type: event.type,
  };

  const values = event.exception?.values;
  if (Array.isArray(values)) {
    scrubbed.exception = {
      values: values.map((exception) => ({
        type: exception.type,
        // Route the message through the shared sanitizer so secrets,
        // absolute filesystem paths, and stack-frame text embedded in the
        // error message itself are redacted identically to the client
        // response contract in src/utils/errorSanitizer.ts.
        value: safeErrorMessage(exception.value, "Unexpected server error."),
        mechanism: exception.mechanism
          ? { type: exception.mechanism.type, handled: exception.mechanism.handled }
          : undefined,
        stacktrace: exception.stacktrace?.frames
          ? {
              frames: exception.stacktrace.frames.map((frame) => ({
                function: frame.function,
                lineno: frame.lineno,
                colno: frame.colno,
                in_app: frame.in_app,
                // Never forward absolute local filesystem paths. Only the
                // basename-shaped, already-sanitized module name survives.
                filename: undefined,
                abs_path: undefined,
              })),
            }
          : undefined,
      })),
    };
  }

  // Explicitly denied on every event: no request/user/context/extra/
  // breadcrumb/server-name data ever leaves this process attached to an
  // event, regardless of what the SDK or a future caller tries to attach.
  scrubbed.request = undefined;
  scrubbed.user = undefined;
  scrubbed.contexts = undefined;
  scrubbed.extra = undefined;
  scrubbed.tags = undefined;
  scrubbed.breadcrumbs = undefined;
  scrubbed.server_name = undefined;
  scrubbed.modules = undefined;
  scrubbed.sdkProcessingMetadata = undefined;

  return scrubbed;
}

/**
 * Initialize Sentry under the approved configuration. Safe to call
 * unconditionally at startup ΓÇö remains a complete no-op (no network call,
 * no SDK state) when `SENTRY_DSN` is absent or empty. Idempotent: calling
 * this more than once has no additional effect.
 */
export function initSentry(): void {
  if (initialized) return;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",

    // Exception capture only ΓÇö every performance/session/replay surface is
    // explicitly off. Never set tracesSampleRate/profilesSampleRate here.
    defaultIntegrations: false,
    integrations: [],

    // Privacy-minimized telemetry: no automatic PII of any kind.
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    includeServerName: false,
    attachStacktrace: false,
    sendClientReports: false,

    // Deny-by-default scrubber, registered before any event can be captured.
    beforeSend: scrubSentryEvent,
  });

  initialized = true;
}

/**
 * Capture an unexpected terminal exception exactly once. No-op (and never
 * throws) when Sentry is not initialized. Callers must invoke this only for
 * unexpected 5xx failures ΓÇö never for expected/validated 4xx responses ΓÇö and
 * must not await or otherwise block a client response on its result.
 */
export function captureSentryException(err: unknown): void {
  if (!initialized) return;
  try {
    Sentry.captureException(err);
  } catch {
    // Sentry capture must never affect application availability or the
    // client response. Swallow any adapter-level failure silently; full
    // diagnostic detail is already logged server-side by the caller.
  }
}
