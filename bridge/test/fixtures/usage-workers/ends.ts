import { parentPort } from "node:worker_threads";

// A history reader that ends in the middle of reading a file, for usage-book.test.ts.
parentPort?.on("message", () => {
  parentPort?.postMessage({ type: "reading", path: "/Users/dana/history.jsonl", size: 10 });
  process.exit(3);
});
