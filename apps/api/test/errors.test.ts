import { describe, expect, it } from "vitest";
import { isDependencyDown } from "../src/lib/errors.js";

describe("isDependencyDown", () => {
  it("flags unreachable Postgres/S3/SQS (DNS, refused, reset, timeout)", () => {
    for (const code of ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]) {
      expect(isDependencyDown(Object.assign(new Error("boom"), { code }))).toBe(true);
    }
  });

  it("flags Postgres starting up / shutting down and pool connect timeouts", () => {
    expect(isDependencyDown(Object.assign(new Error("the database system is starting up"), { code: "57P03" }))).toBe(true);
    expect(isDependencyDown(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isDependencyDown(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  it("looks through `cause`", () => {
    const inner = Object.assign(new Error("getaddrinfo ENOTFOUND postgres"), { code: "ENOTFOUND" });
    expect(isDependencyDown(new Error("query failed", { cause: inner }))).toBe(true);
  });

  it("leaves real bugs and non-connection DB errors as 500s", () => {
    expect(isDependencyDown(new TypeError("x is undefined"))).toBe(false);
    expect(isDependencyDown(Object.assign(new Error("duplicate key"), { code: "23505" }))).toBe(false);
    expect(isDependencyDown(undefined)).toBe(false);
    expect(isDependencyDown("string")).toBe(false);
  });
});
