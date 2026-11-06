// A history reader that ends in the middle of reading a file, for usage-book.test.ts.
process.on("message", () => {
  process.send?.({ type: "reading", path: "/Users/dana/history.jsonl", size: 10 }, () => process.exit(3));
});
