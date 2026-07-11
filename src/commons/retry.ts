import { z } from "zod";

type AnyFunction<
  TThis = unknown,
  TArgs extends unknown[] = unknown[],
  TReturn = unknown,
> = (this: TThis, ...args: TArgs) => TReturn;

type MaybePromise<T> = T | Promise<T>;

export type RetryFailContext = {
  error: unknown;
  attempts: number;
  args: unknown[];
  targetName?: string;
};

export type RetryOptions = {
  attempts?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  /** When false, suppresses the error after all attempts fail. Default true. */
  throwOnFail?: boolean;
  /** Function or string method name resolved from `this` at call time. */
  onFail?: ((context: RetryFailContext) => MaybePromise<void>) | string;
};

const retryOptionsSchema = z.object({
  attempts: z
    .number()
    .int("attempts must be an integer >= 1")
    .min(1, "attempts must be an integer >= 1")
    .default(3),
  initialDelayMs: z
    .number()
    .min(0, "initialDelayMs must be a number >= 0")
    .default(100),
  backoffFactor: z
    .number()
    .min(1, "backoffFactor must be a number >= 1")
    .default(2),
  throwOnFail: z.boolean().default(true),
  onFail: z
    .custom<RetryOptions["onFail"]>(
      (value) => typeof value === "function" || typeof value === "string",
      "onFail must be a function or string method name",
    )
    .optional(),
});

type ResolvedRetryOptions = z.infer<typeof retryOptionsSchema>;

const DEFAULT_RETRY_OPTIONS: ResolvedRetryOptions = {
  attempts: 3,
  initialDelayMs: 500,
  backoffFactor: 2,
  throwOnFail: true,
};

function resolveOptions(options: RetryOptions = {}): ResolvedRetryOptions {
  const parsed = retryOptionsSchema.safeParse({
    ...DEFAULT_RETRY_OPTIONS,
    ...options,
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RangeError(`Retry options error: ${issue.message}`);
  }

  return parsed.data;
}

function computeBackoffDelayMs(
  failedAttempt: number,
  options: ResolvedRetryOptions,
): number {
  return options.initialDelayMs * options.backoffFactor ** (failedAttempt - 1);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runOnFail(
  options: ResolvedRetryOptions,
  context: RetryFailContext,
  thisArg?: unknown,
): Promise<void> {
  if (!options.onFail) return;

  const handler =
    typeof options.onFail === "string"
      ? (thisArg as Record<string, unknown> | undefined)?.[options.onFail]
      : options.onFail;

  if (typeof handler !== "function") return;

  try {
    await Promise.resolve(
      (handler as (ctx: RetryFailContext) => MaybePromise<void>).call(
        thisArg,
        context,
      ),
    );
  } catch {
    // keep original retry error as final thrown error
  }
}

async function executeWithRetry<TThis, TArgs extends unknown[], TReturn>(
  fn: AnyFunction<TThis, TArgs, TReturn>,
  thisArg: TThis,
  args: TArgs,
  options: ResolvedRetryOptions,
  targetName?: string,
): Promise<Awaited<TReturn>> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      const result = fn.apply(thisArg, args);
      return await Promise.resolve(result);
    } catch (error) {
      lastError = error;

      if (attempt >= options.attempts) {
        break;
      }

      await sleep(computeBackoffDelayMs(attempt, options));
    }
  }

  await runOnFail(
    options,
    {
      error: lastError,
      attempts: options.attempts,
      args,
      targetName,
    },
    thisArg,
  );

  if (options.throwOnFail) {
    throw lastError;
  }

  return undefined as Awaited<TReturn>;
}

export function withRetry<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => TReturn,
  options: RetryOptions & { args?: TArgs } = {},
): Promise<Awaited<TReturn>> {
  const resolvedOptions = resolveOptions(options);
  return executeWithRetry(
    fn,
    null as never,
    options.args ?? ([] as unknown as TArgs),
    resolvedOptions,
    fn.name || undefined,
  );
}
