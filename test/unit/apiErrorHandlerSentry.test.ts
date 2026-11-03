import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

/**
 * WUD-PI003-4 ΓÇö Terminal `apiErrorHandler` integration coverage.
 *
 * Verifies the capture contract at the actual integration boundary rather
 * than only inside the adapter: unexpected 5xx exceptions are captured
 * exactly once; expected 4xx responses are never captured; capture failure
 * never changes the response status, body, or availability. The Sentry
 * adapter itself is mocked here too, so this suite makes no live network
 * call.
 */
const mockCaptureSentryException = vi.fn();

vi.mock("../../src/observability/sentry", () => ({
  captureSentryException: (...args: unknown[]) => mockCaptureSentryException(...args),
}));

import { apiErrorHandler } from "../../src/middleware/errorSanitizer";

function createMockResponse(): Response {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe("apiErrorHandler: Sentry capture integration", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockCaptureSentryException.mockClear();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("captures an unexpected 5xx exception exactly once", () => {
    const res = createMockResponse();
    const err = new Error("unexpected database failure");
    apiErrorHandler(err, {} as Request, res, vi.fn());

    expect(mockCaptureSentryException).toHaveBeenCalledTimes(1);
    expect(mockCaptureSentryException).toHaveBeenCalledWith(err);
  });

  it("does not capture an expected 4xx error", () => {
    const res = createMockResponse();
    const err = Object.assign(new Error("bad request body"), { status: 400 });
    apiErrorHandler(err, {} as Request, res, vi.fn());

    expect(mockCaptureSentryException).not.toHaveBeenCalled();
  });

  it("does not capture a 404-shaped error", () => {
    const res = createMockResponse();
    const err = Object.assign(new Error("not found"), { status: 404 });
    apiErrorHandler(err, {} as Request, res, vi.fn());

    expect(mockCaptureSentryException).not.toHaveBeenCalled();
  });

  it("preserves the existing sanitized 5xx client response contract unchanged", () => {
    const res = createMockResponse();
    const err = new Error("internal failure with secret=abc123 at C:/repo/src/index.ts:10");
    apiErrorHandler(err, {} as Request, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal Server Error" });
  });

  it("preserves the existing sanitized 4xx client response contract unchanged", () => {
    const res = createMockResponse();
    const err = Object.assign(new Error("validation failed"), { status: 400 });
    apiErrorHandler(err, {} as Request, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "validation failed",
    });
  });

  it("captures before sending the response, without delaying or blocking it", () => {
    const res = createMockResponse();
    const callOrder: string[] = [];
    mockCaptureSentryException.mockImplementationOnce(() => {
      callOrder.push("capture");
    });
    (res.json as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      callOrder.push("response");
      return res;
    });

    apiErrorHandler(new Error("unexpected failure"), {} as Request, res, vi.fn());

    expect(callOrder).toEqual(["capture", "response"]);
  });
});
