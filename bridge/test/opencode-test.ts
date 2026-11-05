import { AsyncLocalStorage } from "node:async_hooks";
import { test as nodeTest, type TestContext, type TestFn, type TestOptions } from "node:test";
import { setTimeout as scheduleTimeout, clearTimeout as cancelTimeout } from "node:timers";

// Capture before tests enable mocked timers: emergency cleanup uses real time.
const realSetTimeout = scheduleTimeout;
const realClearTimeout = cancelTimeout;
const testTimeoutMs = 60_000;
const cleanupTimeoutMs = 5_000;
type Cleanup = () => void | Promise<void>;
interface TestScope {
  callbacks: Cleanup[];
  cleaning?: Promise<void>;
}
const currentTest = new AsyncLocalStorage<TestScope>();

/** Emergency fixture cleanup, including when a test's body never settles. Hooks
 * that create suite-wide fixtures have no current test and keep their own cleanup. */
export function onTestCleanup(cleanup: Cleanup): void {
  const scope = currentTest.getStore();
  if (!scope) return;
  if (scope.cleaning) throw new Error("Cannot register OpenCode fixture cleanup after its test ended");
  scope.callbacks.push(cleanup);
}

function cleanup(scope: TestScope): Promise<void> {
  return scope.cleaning ??= (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Start every callback even if another fixture's graceful close is stuck.
      const results = await Promise.race([
        Promise.allSettled(scope.callbacks.map((callback) => Promise.resolve().then(callback))),
        new Promise<never>((_resolve, reject) => {
          timer = realSetTimeout(() => reject(new Error("OpenCode test cleanup timed out")), cleanupTimeoutMs);
        }),
      ]);
      const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (failures.length) throw new AggregateError(failures, "OpenCode test cleanup failed");
    } finally {
      realClearTimeout(timer);
    }
  })();
}

function run(t: TestContext, body: () => void | Promise<void>): void | Promise<void> {
  const scope: TestScope = { callbacks: [] };
  const cancelled = () => { void cleanup(scope).catch(() => {}); };
  t.after(async () => {
    try { await cleanup(scope); }
    finally { t.signal.removeEventListener("abort", cancelled); }
  }, { timeout: cleanupTimeoutMs + 1_000 });
  t.signal.addEventListener("abort", cancelled, { once: true });
  return currentTest.run(scope, body);
}

// Keep node:test's callback context and options, including callback-style tests.
export function test(name?: string, fn?: TestFn): Promise<void>;
export function test(name?: string, options?: TestOptions, fn?: TestFn): Promise<void>;
export function test(options?: TestOptions, fn?: TestFn): Promise<void>;
export function test(fn?: TestFn): Promise<void>;
export function test(
  nameOrOptionsOrFn?: string | TestOptions | TestFn,
  optionsOrFn?: TestOptions | TestFn,
  fn?: TestFn,
): Promise<void> {
  const name = typeof nameOrOptionsOrFn === "string" ? nameOrOptionsOrFn : undefined;
  let options: TestOptions = {};
  if (typeof nameOrOptionsOrFn === "object") options = nameOrOptionsOrFn;
  else if (typeof optionsOrFn === "object") options = optionsOrFn;

  let body = fn;
  if (typeof nameOrOptionsOrFn === "function") body = nameOrOptionsOrFn;
  else if (typeof optionsOrFn === "function") body = optionsOrFn;

  let wrapped: TestFn | undefined;
  if (body) {
    const callback = body;
    // node:test uses function arity to distinguish callback and promise tests.
    if (callback.length > 1) wrapped = (t, done) => run(t, () => callback(t, done));
    else wrapped = (t) => run(t, () => callback(t, () => {}));
  }
  return nodeTest(name, { ...options, timeout: options.timeout ?? testTimeoutMs }, wrapped);
}
