import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * WUD-PI003-4 ΓÇö Privacy-Minimized Error Observability unit coverage.
 *
 * The entire `@sentry/node` SDK is replaced with pure in-memory spies below.
 * No test in this file makes, or can make, a live network call to Sentry:
 * `init`/`captureException` are mocked functions that never construct a real
 * transport, HTTP client, or DSN-derived endpoint.
 */
const mockInit = vi.fn();
const mockCaptureException = vi.fn();

vi.mock("@sentry/node", () => ({
  init: (...args: unknown[]) => mockInit(...args),
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import {
  initSentry,
  isSentryEnabled,
  captureSentryException,
  scrubSentryEvent,
  __resetSentryStateForTests,
} from "../../src/observability/sentry";

const ORIGINAL_ENV = { ...process.env };

function resetAll(): void {
  __resetSentryStateForTests();
  mockInit.mockClear();
  mockCaptureException.mockClear();
}

describe("observability/sentry: disabled-by-default initialization", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("is a no-op when SENTRY_DSN is unset (missing configuration)", () => {
    delete process.env.SENTRY_DSN;
    initSentry();
    expect(mockInit).not.toHaveBeenCalled();
    expect(isSentryEnabled()).toBe(false);
  });

  it("is a no-op when SENTRY_DSN is an empty string (malformed/absent configuration)", () => {
    process.env.SENTRY_DSN = "";
    initSentry();
    expect(mockInit).not.toHaveBeenCalled();
    expect(isSentryEnabled()).toBe(false);
  });

  it("does not capture exceptions while disabled", () => {
    delete process.env.SENTRY_DSN;
    captureSentryException(new Error("should never be sent"));
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});

describe("observability/sentry: approved-configuration initialization", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("initializes exactly once when SENTRY_DSN is present", () => {
    process.env.SENTRY_DSN = "https://fake-key@fake.ingest.example.test/1";
    initSentry();
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(isSentryEnabled()).toBe(true);
  });

  it("is idempotent: a second initSentry() call does not re-initialize", () => {
    process.env.SENTRY_DSN = "https://fake-key@fake.ingest.example.test/1";
    initSentry();
    initSentry();
    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  it("disables tracing, profiling, and default/breadcrumb integrations", () => {
    process.env.SENTRY_DSN = "https://fake-key@fake.ingest.example.test/1";
    initSentry();
    const options = mockInit.mock.calls[0][0];
    expect(options.tracesSampleRate).toBeUndefined();
    expect(options.profilesSampleRate).toBeUndefined();
    expect(options.defaultIntegrations).toBe(false);
    expect(options.integrations).toEqual([]);
    expect(options.sendClientReports).toBe(false);
    expect(options.attachStacktrace).toBe(false);
  });

  it("sets sendDefaultPii false and denies every dataCollection category", () => {
    process.env.SENTRY_DSN = "https://fake-key@fake.ingest.example.test/1";
    initSentry();
    const options = mockInit.mock.calls[0][0];
    expect(options.sendDefaultPii).toBe(false);
    expect(options.dataCollection.userInfo).toBe(false);
    expect(options.dataCollection.cookies).toBe(false);
    expect(options.dataCollection.httpHeaders).toEqual({ request: false, response: false });
    expect(options.dataCollection.httpBodies).toEqual([]);
    expect(options.dataCollection.urlQueryParams).toBe(false);
    expect(options.dataCollection.databaseQueryData).toBe(false);
    expect(options.dataCollection.stackFrameVariables).toBe(false);
    expect(options.includeServerName).toBe(false);
  });

  it("registers the deny-by-default scrubber as beforeSend before any capture is possible", () => {
    process.env.SENTRY_DSN = "https://fake-key@fake.ingest.example.test/1";
    initSentry();
    const options = mockInit.mock.calls[0][0];
    expect(options.beforeSend).toBe(scrubSentryEvent);
  });

  it("reads the DSN only from the environment variable and never logs/persists it", () => {
    process.env.SENTRY_DSN = "https://fake-key@fake.ingest.example.test/1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    initSentry();
    const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join(" ");
    expect(allLoggedText).not.toContain("fake-key@fake.ingest.example.test");
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("observability/sentry: exception capture contract", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("captures an unexpected exception exactly once when enabled", () => {
    process.env.SENTRY_DSN = "https://fake-key@fake.ingest.example.test/1";
    initSentry();
    const err = new Error("unexpected terminal failure");
    captureSentryException(err);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(err);
  });

  it("never throws even when the underlying SDK call throws (capture failure isolation)", () => {
    process.env.SENTRY_DSN = "https://fake-key@fake.ingest.example.test/1";
    initSentry();
    mockCaptureException.mockImplementationOnce(() => {
      throw new Error("simulated SDK/transport failure");
    });
    expect(() => captureSentryException(new Error("boom"))).not.toThrow();
  });

  it("accepts non-Error thrown values without throwing", () => {
    process.env.SENTRY_DSN = "https://fake-key@fake.ingest.example.test/1";
    initSentry();
    expect(() => captureSentryException("a plain string error")).not.toThrow();
    expect(() => captureSentryException({ message: "object error" })).not.toThrow();
    expect(() => captureSentryException(undefined)).not.toThrow();
  });
});

describe("observability/sentry: deny-by-default event scrubbing", () => {
  const baseEvent = {
    event_id: "abc123",
    timestamp: 1700000000,
    platform: "node",
    level: "error" as const,
    environment: "test",
    release: "1.0.0",
    type: undefined,
  };

  it("strips user identity fields entirely", () => {
    const result = scrubSentryEvent(
      { ...baseEvent, user: { id: "user-1", email: "user@example.com", username: "gamerTag" } },
      {},
    );
    expect(result?.user).toBeUndefined();
  });

  it("strips request data: headers, cookies, query strings, and bodies", () => {
    const result = scrubSentryEvent(
      {
        ...baseEvent,
        request: {
          url: "https://mgpl.example/api/secret",
          method: "POST",
          headers: { authorization: "Bearer super-secret-token", cookie: "session=abc" },
          cookies: { session: "abc" },
          query_string: "token=xyz",
          data: { password: "hunter2" },
        },
      },
      {},
    );
    expect(result?.request).toBeUndefined();
  });

  it("strips IP-address-shaped and arbitrary context/extra data", () => {
    const result = scrubSentryEvent(
      {
        ...baseEvent,
        contexts: { app: { app_name: "mgpl" } },
        extra: { clientIp: "203.0.113.7", dbRow: { id: 1 } },
        tags: { region: "us-east" },
      },
      {},
    );
    expect(result?.contexts).toBeUndefined();
    expect(result?.extra).toBeUndefined();
    expect(result?.tags).toBeUndefined();
  });

  it("strips breadcrumbs, server_name, and module manifest data", () => {
    const result = scrubSentryEvent(
      {
        ...baseEvent,
        breadcrumbs: [{ message: "db query executed" }],
        server_name: "prod-host-07",
        modules: { express: "4.18.2" },
      },
      {},
    );
    expect(result?.breadcrumbs).toBeUndefined();
    expect(result?.server_name).toBeUndefined();
    expect(result?.modules).toBeUndefined();
  });

  it("redacts secret-shaped values embedded in the exception message", () => {
    const result = scrubSentryEvent(
      {
        ...baseEvent,
        exception: {
          values: [{ type: "Error", value: "token=abcdef123 password=hunter2 request failed" }],
        },
      },
      {},
    );
    const message = result?.exception?.values?.[0]?.value ?? "";
    expect(message).toContain("[redacted]");
    expect(message).not.toContain("abcdef123");
    expect(message).not.toContain("hunter2");
  });

  it("strips absolute local filesystem paths from exception messages", () => {
    const result = scrubSentryEvent(
      {
        ...baseEvent,
        exception: {
          values: [
            {
              type: "Error",
              value: "Failed at C:/Users/joelg/OneDrive/PC Build/MGPL/src/index.ts:42",
            },
          ],
        },
      },
      {},
    );
    const message = result?.exception?.values?.[0]?.value ?? "";
    expect(message).toContain("[path]");
    expect(message).not.toContain("C:/Users/joelg");
  });

  it("strips filename and abs_path from every stack frame (no absolute local paths)", () => {
    const result = scrubSentryEvent(
      {
        ...baseEvent,
        exception: {
          values: [
            {
              type: "Error",
              value: "boom",
              stacktrace: {
                frames: [
                  {
                    function: "handler",
                    filename: "/home/dev/mgpl/src/routes/games.ts",
                    abs_path: "/home/dev/mgpl/src/routes/games.ts",
                    lineno: 10,
                    colno: 3,
                    in_app: true,
                  },
                ],
              },
            },
          ],
        },
      },
      {},
    );
    const frame = result?.exception?.values?.[0]?.stacktrace?.frames?.[0];
    expect(frame?.filename).toBeUndefined();
    expect(frame?.abs_path).toBeUndefined();
    expect(frame?.function).toBe("handler");
    expect(frame?.lineno).toBe(10);
  });

  it("never forwards provider/database payloads that were not explicitly allow-listed", () => {
    const result = scrubSentryEvent(
      {
        ...baseEvent,
        // Simulate a caller/integration attempting to attach an arbitrary
        // provider payload or DB row via a non-standard field.
        sdkProcessingMetadata: { rawProviderPayload: { steamId: "765611", apiKey: "sk-live-123" } },
      } as never,
      {},
    );
    expect(result?.sdkProcessingMetadata).toBeUndefined();
  });

  it("preserves only the minimal fields required for triage/grouping", () => {
    const result = scrubSentryEvent({ ...baseEvent }, {});
    expect(result?.event_id).toBe("abc123");
    expect(result?.level).toBe("error");
    expect(result?.environment).toBe("test");
    expect(result?.release).toBe("1.0.0");
  });
});
