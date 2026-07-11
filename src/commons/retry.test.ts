import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withRetry } from "./retry";

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns success without extra attempts", async () => {
    const fn = vi.fn().mockReturnValue("ok");

    await expect(withRetry(fn, { attempts: 3 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries and succeeds for async function", async () => {
    const error = new Error("boom");
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce("done");

    const pending = withRetry(fn, {
      attempts: 3,
      initialDelayMs: 100,
      backoffFactor: 2,
    });

    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).resolves.toBe("done");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("applies exponential backoff delays", async () => {
    const fn = vi.fn<() => string>().mockImplementation(() => {
      throw new Error("nope");
    });

    const pending = withRetry(fn, {
      attempts: 3,
      initialDelayMs: 10,
      backoffFactor: 3,
    });

    const rejection = expect(pending).rejects.toThrow("nope");

    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10);
    expect(fn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30);
    expect(fn).toHaveBeenCalledTimes(3);

    await rejection;
  });

  it("calls onFail once after all attempts fail", async () => {
    const error = new Error("hard fail");
    const fn = vi.fn<() => never>().mockImplementation(() => {
      throw error;
    });

    const onFail = vi.fn().mockResolvedValue(undefined);

    const pending = withRetry(fn, {
      attempts: 2,
      initialDelayMs: 10,
      onFail,
    });

    const rejection = expect(pending).rejects.toBe(error);

    await vi.advanceTimersByTimeAsync(10);
    await rejection;

    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail).toHaveBeenCalledWith(
      expect.objectContaining({
        error,
        attempts: 2,
        args: [],
      }),
    );
  });

  it("does not call onFail when retry eventually succeeds", async () => {
    const fn = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        throw new Error("fail once");
      })
      .mockImplementationOnce(() => "ok");

    const onFail = vi.fn();

    const pending = withRetry(fn, {
      attempts: 2,
      initialDelayMs: 10,
      onFail,
    });

    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toBe("ok");
    expect(onFail).not.toHaveBeenCalled();
  });

  it("rethrows original error when onFail throws", async () => {
    const originalError = new Error("original");
    const onFailError = new Error("onFail");

    const fn = vi.fn<() => never>().mockImplementation(() => {
      throw originalError;
    });

    const onFail = vi.fn().mockRejectedValue(onFailError);

    await expect(
      withRetry(fn, {
        attempts: 1,
        onFail,
      }),
    ).rejects.toBe(originalError);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it("resolves undefined when throwOnFail is false", async () => {
    const fn = vi.fn<() => never>().mockImplementation(() => {
      throw new Error("boom");
    });

    await expect(
      withRetry(fn, { attempts: 2, initialDelayMs: 0, throwOnFail: false }),
    ).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("still calls onFail when throwOnFail is false", async () => {
    const error = new Error("soft fail");
    const fn = vi.fn<() => never>().mockImplementation(() => {
      throw error;
    });
    const onFail = vi.fn().mockResolvedValue(undefined);

    await expect(
      withRetry(fn, { attempts: 1, throwOnFail: false, onFail }),
    ).resolves.toBeUndefined();

    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail).toHaveBeenCalledWith(
      expect.objectContaining({ error, attempts: 1 }),
    );
  });

  it("validates options", () => {
    expect(() => withRetry(() => "ok", { attempts: 0 })).toThrow(
      /attempts must be an integer >= 1/,
    );

    expect(() => withRetry(() => "ok", { initialDelayMs: -1 })).toThrow(
      /initialDelayMs must be a number >= 0/,
    );

    expect(() => withRetry(() => "ok", { backoffFactor: 0.5 })).toThrow(
      /backoffFactor must be a number >= 1/,
    );
  });
});
