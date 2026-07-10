import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { createResolveEnablement } from "./agent-enablement";

const logger = pino({ level: "silent" });

function stubFetch(impl: () => unknown) {
  const mock = vi.fn(async () => impl() as Response);
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe("createResolveEnablement", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves enabled agents from the backend (strict boolean coercion)", async () => {
    stubFetch(() => ({
      ok: true,
      json: async () => ({
        agents: { scheduling: true, invoicing: false, expense: true },
      }),
    }));
    // Trailing slash on the base must be stripped.
    const resolve = createResolveEnablement("http://backend:8080/", logger);
    const e = await resolve({ chatId: "c1" });
    expect(e).toEqual({ expense: true, invoicing: false, scheduling: true });
  });

  it("fails closed (all disabled) on a non-ok response", async () => {
    stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
    const resolve = createResolveEnablement("http://backend:8080", logger);
    const e = await resolve({ tenantId: "t1" });
    expect(e).toEqual({ expense: false, invoicing: false, scheduling: false });
  });

  it("fails closed when fetch throws", async () => {
    stubFetch(() => {
      throw new Error("network down");
    });
    const resolve = createResolveEnablement("http://backend:8080", logger);
    const e = await resolve({ chatId: "c1" });
    expect(e.scheduling).toBe(false);
  });

  it("serves the cached value without a second fetch within the TTL", async () => {
    const mock = stubFetch(() => ({
      ok: true,
      json: async () => ({ agents: { scheduling: true } }),
    }));
    const resolve = createResolveEnablement("http://backend:8080", logger);
    await resolve({ chatId: "c1" });
    await resolve({ chatId: "c1" });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("returns all-disabled without fetching when neither key is present", async () => {
    const mock = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    const resolve = createResolveEnablement("http://backend:8080", logger);
    const e = await resolve({});
    expect(e).toEqual({ expense: false, invoicing: false, scheduling: false });
    expect(mock).not.toHaveBeenCalled();
  });
});
