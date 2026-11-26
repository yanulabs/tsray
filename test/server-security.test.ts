import { describe, expect, it } from "vitest";
import { validateReportRequest } from "../src/mcp/server.js";

function request(
  method: string | undefined,
  host?: string,
  origin?: string,
  url = "/api/report"
): Parameters<typeof validateReportRequest>[0] {
  return {
    method,
    url,
    headers: {
      ...(host === undefined ? {} : { host }),
      ...(origin === undefined ? {} : { origin }),
    },
  };
}

describe("report HTTP request validation", () => {
  it("accepts loopback Host headers and parses the request target", () => {
    const result = validateReportRequest(request("GET", "127.0.0.1:4321"), "127.0.0.1", 4321);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.pathname).toBe("/api/report");
    expect(validateReportRequest(request("HEAD", "localhost:4321"), "127.0.0.1", 4321).ok).toBe(true);
    expect(validateReportRequest(request("GET", "[::1]:4321"), "::1", 4321).ok).toBe(true);
  });

  it("rejects DNS-rebinding Host headers, missing hosts, userinfo, and port mismatches", () => {
    for (const host of [
      "attacker.example:4321",
      "127.0.0.1.attacker.example:4321",
      "attacker.example@127.0.0.1:4321",
      "127.0.0.1:9999",
      "127.0.0.1:4321/path",
      undefined,
    ]) {
      expect(validateReportRequest(request("GET", host), "127.0.0.1", 4321)).toEqual({
        ok: false,
        status: 403,
        error: "forbidden",
      });
    }
  });

  it("requires browser origins to match the validated Host", () => {
    expect(
      validateReportRequest(request("GET", "localhost:4321", "http://localhost:4321"), "127.0.0.1", 4321).ok
    ).toBe(true);
    for (const origin of [
      "http://attacker.example",
      "http://localhost:9999",
      "https://localhost:4321",
      "null",
      "not a url",
    ]) {
      expect(validateReportRequest(request("GET", "localhost:4321", origin), "127.0.0.1", 4321)).toEqual({
        ok: false,
        status: 403,
        error: "forbidden",
      });
    }
  });

  it("rejects unsupported methods and absolute-form request targets", () => {
    expect(validateReportRequest(request("POST", "localhost:4321"), "127.0.0.1", 4321)).toEqual({
      ok: false,
      status: 405,
      error: "method_not_allowed",
    });
    expect(
      validateReportRequest(request("GET", "localhost:4321", undefined, "http://attacker.example/api/report"), "127.0.0.1", 4321)
    ).toEqual({ ok: false, status: 400, error: "bad_request" });
    expect(
      validateReportRequest(request("GET", "localhost:4321", undefined, "//attacker.example/api/report"), "127.0.0.1", 4321)
    ).toEqual({ ok: false, status: 400, error: "bad_request" });
  });

  it("keeps non-loopback bindings restricted to the configured host", () => {
    expect(validateReportRequest(request("GET", "0.0.0.0:4321"), "0.0.0.0", 4321).ok).toBe(true);
    expect(validateReportRequest(request("GET", "localhost:4321"), "0.0.0.0", 4321).ok).toBe(true);
    expect(validateReportRequest(request("GET", "192.0.2.10:4321"), "0.0.0.0", 4321)).toEqual({
      ok: false,
      status: 403,
      error: "forbidden",
    });
  });
});
