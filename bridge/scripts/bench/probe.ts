import { performance } from "node:perf_hooks";

// Loaded into each bridge the harness starts, before the bridge itself
// (`node --import probe.ts src/main.ts`, scratch.ts). It answers the harness, over the
// channel Node gives a child process, with the process's own CPU time and memory: `ps`
// gives CPU time in hundredths of a second, too coarse for an idle minute, and no heap
// at all. It does nothing until asked, so it is not in what is measured.
//
// It also stops the bridge when the harness is gone, however the harness ended, so a
// harness that was killed leaves no bridge running.

if (process.send) {
  process.on("message", (message: { ask?: unknown }) => {
    if (typeof message?.ask !== "number") return;
    process.send?.({ answer: message.ask, cpu: process.cpuUsage(), memory: process.memoryUsage(), at: performance.now() });
  });
  process.on("disconnect", () => process.kill(process.pid, "SIGTERM"));
}
