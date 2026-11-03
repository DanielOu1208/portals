# Isolated Droid parity checks

These opt-in checks never use the installed bridge's home, build, service, push
registration, or normal app. Do not run `npm run build` or restart the installed
bridge to use them. Node 24+, the bridge's existing dependencies, Xcode, and a
separately built `com.danielou.portals.parity` app are required.

## UI bridge and XCTest

From this repository, start the deterministic provider:

```sh
node scripts/phone-bench/uitest/droid-parity-bridge.mts
```

For an authorized live run, explicitly choose the approved CLI:

```sh
DROID_RECORD_PATH=/absolute/path/to/approved/droid \
  node scripts/phone-bench/uitest/droid-parity-bridge.mts --live
```

The launcher creates a new private scratch home and empty git repository. It
prints the private `uiConfig` path, not the password. Default ports are 9487
(scripted) and 9486 (live); `PORTALS_PARITY_PORT` overrides only this isolated
bridge. Never kill an unknown occupant of either port. Ctrl-C closes this bridge.

Build/install a separate app whose **app and extension** bundle IDs have the
`.parity` suffix, using a copied Xcode project, not by modifying the real project.
Use a separate app group and derived-data directory. Do not install it over the
normal app.

Build `WidgetUI.xcodeproj`, scheme `UITests`, for iOS Simulator with
`build-for-testing`. Copy its generated `.xctestrun` file beside the original and
set `UITests.EnvironmentVariables.PORTALS_PARITY_UI_CONFIG` to the launcher's
private `uiConfig` path. Run that copy with `xcodebuild test-without-building`,
an explicit Simulator UDID, and `-only-testing:UITests/DroidParityUITests`.

The harness skips unless configured, rejects the normal bundle ID, and pins live
turns to `claude-haiku-5-5`. It does not select a fallback model automatically.
Scripted cases cover mode labels/inheritance, center hit targets, required answers
and Back, Stop/error recovery, separate work/task summaries, cumulative output before completion, offered-only
approval outcomes, explicit persistent-grant confirmation, edited Spec Markdown,
and separate Spec model/effort. `droid-parity approval`, `droid-parity approval
limited`, and `droid-parity plan` create those synthetic requests. They only echo
the answer, even when a test confirms a broad grant or replacement session.

Live cases cover required questions, custom answers, multiple selections, explicit
cancellation, estimated context, `/context`, Compact, memory continuity after app
reopen, and inspecting/declining a Spec plan. Never confirm a real
persistent grant for a UI test. XCTest attachments retain screenshots. A scripted
pass is not a live pass, and a build or fixture pass is not a device pass.

The additional opt-in classes are `DroidParityInteractionUITests`,
`DroidParityCommandUITests`, and `DroidParityBackgroundUITests`. Compile these
before running their targeted methods. For command/background fixtures:

```sh
DROID_RECORD_PATH=/absolute/path/to/approved/droid \
  node scripts/phone-bench/uitest/droid-parity-bridge.mts --live --fixtures --audit
```

`--fixtures` creates two private projects with different custom command catalogs,
literal `$ARGUMENTS` commands, `hello.txt`, and a Read-only custom Task droid
pinned to `claude-haiku-5-5`. Project B is a sibling scratch directory registered
through `folders.add`, not a project inside the excluded bridge home.
`--audit` writes mode-0600 prompt receipts (length
and probe marker only), slash dispatch names, tool identities, child status,
compaction signals and turn-end times, not prompt bodies or
credentials. Its private hierarchy/PNG files survive incomplete xcresult bundles.
Send probes keep the draft if delivery is disproved, and never replay a cleared
draft without a receipt. The SF Symbol may not be separately exposed to AX;
inspect the saved image before identifying a local-center tap as its center.

`--scratch-home` adds an isolated personal command and gives only the CLI that
new HOME. It does not copy credentials or touch the normal `~/.factory`. Check
that the existing login works in that HOME first. If it does not, record the
personal-command check as blocked. A temporary normal-HOME fixture requires
explicit approval for its exact scope. Set the private `ui.json`'s
`personalCommand` to that approved command's name; its body should say
`Reply exactly portals-personal-$ARGUMENTS. Do not use tools.`
The fixture is named `portals-parity-test`; project A has a same-name override,
so the two projects must answer `portals-project-a-citrus` and
`portals-personal-citrus` respectively.
Delete only that test file in a guaranteed cleanup even if tests fail, remove a
new commands directory only if empty, and verify the original state is restored.
Never copy credentials or touch other Factory files. No model fallback or
permission grant happens automatically.

To retain the four scripted Simulator plan styling screenshots, set
`UITests.EnvironmentVariables.PORTALS_PARITY_SCREENSHOTS` to an explicit absolute
workspace directory and run `testTodoChecklistInRunStatusAndNoIdleBar`.
`droid-parity subagents` adds a synthetic non-stoppable child below the checklist.
It does not run an actual Task. Work/tools and task summaries are separate;
collapsed live output remains visible. Both headers control the shared fold.

The background tests use one real Read-only Task per scenario, awaited or
background, and inspect its actual child identity, running/completed status and
report with no individual Stop. They never call TaskOutput or TaskStop.
The Execute scenario uses only `sleep 20; printf 'parity-background-complete\n'`;
if approval is requested, it approves only that exact command once. It checks
that later output replaces the launch receipt under the original tool identity.

### Temporary Send diagnostics

`DroidParitySendProbeUITests` accepts only the explicitly supplied isolated
`com.danielou.portals.parity.sendprobe` app. Its Swift instrumentation is not part
of this repository. Set that bundle ID in a private copy of the scratch config;
the harness supplies `PORTALS_SEND_PROBE=1`. Run the preflight method, then inspect
the app's `Library/Caches/send-probe.jsonl` for a boot record and an initial
`window-touch-before` record. Only then set the test runner environment
`PORTALS_PARITY_PROBE_PREFLIGHT_VERIFIED=1` and run the five timed pairs.

Each pair tests a semantic Send just after Stop becomes Send and just after a
last typed line grows the field. The harness records receipt count, draft
retention, frame growth and observed typing/tap/previous-turn times in its
private audit directory. It takes no screenshot before the timed tap. A known
undelivered draft is discarded before the next distinct marker; an ambiguous
delivery stops the test rather than replaying it. Retain native JSONL by PID
alongside each pair's records and screenshots. Check eligibility independently
of delivery: a seed that ends while the draft is being typed does not qualify
for the Stop-to-Send condition. Instrumentation changes timing,
so five successes do not establish that the original intermittent miss is fixed.
The typing timestamp is XCTest's `typeText` return time, not an OS key-event
timestamp. Use native frame/lifecycle and touch records for the physical tap and
layout timing.

## Stream/scroll comparison

`droid-parity-perf.mts` follows `docs/perf-mac-scroll.md` without its shell
launch/discovery or preference cleanup. Obtain exclusive GUI-controller ownership
first. All app launch/discovery and background wheel events use Cua, with exact
PIDs/windows and fresh screenshot coordinates. No foreground escalation is used.

Prepare clean source snapshots and Release Catalyst builds with
`SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG`, separate derived-data directories,
app groups, and bundle IDs:

- baseline: `com.danielou.portals.parity.perf.baseline`
- current: `com.danielou.portals.parity.perf.current`

Both apps must use the **same** bridge source/dependencies and workload. For example:

```sh
PORTALS_PARITY_SOURCE=/private/tmp/portals-droid-perf-example/current-source \
node scripts/phone-bench/uitest/droid-parity-perf.mts \
  --app /absolute/path/to/Release-maccatalyst/Portals.app \
  --label baseline --out /private/tmp/portals-droid-perf-example \
  --turns 45 --round 1
```

Run baseline/current interleaved for both 45 and 1 turns, at least two rounds.
Do not build, run UI tests, or drive another GUI while measuring. Each run creates
an authenticated loopback bridge, seeds the existing deterministic `fakeBench`
history/reply, and adds the same scripted 5 Hz cumulative stdout, 1 Hz turn usage,
and initial/final todo updates. No commands actually execute.

The harness copies only test apps to `~/Applications/PortalsParityPerf-*.app`,
uses a private launch environment and scratch app home, signs those copies, and
launches them in the background. It terminates only its returned app PID and its
own bridge. It leaves evidence and test copies intact; it never deletes normal
preferences or changes Factory settings.

Each run saves FrameMeter rows, screenshots, exact measured intervals, 12-second
streaming CPU, and streaming/scrolling/rest results. Compare medians and spread,
not just one pair. The historical under-15%-CPU exclusion remains a review flag:
inspect the screenshot before calling such a run valid. FrameMeter measures the
main thread, not render-server hitch time. Short synthetic runs are not proof
that every real transcript or device is regression-free.

A degraded or unresolved exact window stops the run before input. Keep that
incomplete run as evidence, exclude it from medians, and do not escalate to
foreground input or silently substitute a different target.

For a separately authorized launch-crash reproduction, `--launch-probe` uses the
same seeding, app launch and workload, verifies a wide window with a visible
sidebar, logs `prompt.submit.begin` and its acknowledgement in `trace.jsonl`,
waits five seconds, captures the window, and quits. It saves `launch-probe.json`,
not performance results. Run sequentially in a fresh output directory and count
crashes by matching recorded app PIDs to new DiagnosticReports, not by treating
every input-route failure as a crash.

## PR #2 review verification

`droid-pr2-check.mts` is an opt-in source runner. It refuses to start without
`--fixes-ready`, a contract version, the `droid-parity` branch, and a fresh
`/private/tmp/portals-droid-pr2-*` output directory. Live cases also require the
explicitly approved CLI 0.245.0 path and pin every SDK stream to
`claude-haiku-5-5`. Do not use the execution flag before the orchestrator's GO.

```sh
DROID_RECORD_PATH=/absolute/path/to/approved/droid \
  node scripts/phone-bench/uitest/droid-pr2-check.mts \
  --fixes-ready --contract-version 17 --case lifecycle \
  --out /private/tmp/portals-droid-pr2-lifecycle-unique
```

Cases are `isolated` (owner test files), `lifecycle`, `interrupt`, `offerings`,
`progress`, `tokens`, `resume`, `handoff`, and `handoff-followup`. The offerings
case additionally requires `--quiet-offerings-confirmed` and a coordinated quiet
CLI-creation window. It creates/cools three scratch sessions before the baseline,
waits for asynchronous native closes, and records SDK counts, owned descendant
PIDs, and pseudonymized history names/counts/sizes/mtimes. It never reads history
file bodies or creates a personal command file.

The observer writes only lifecycle IDs, model IDs and numeric usage/progress
metrics. The progress case produces about 40KB of finite stdout, checks the
250ms rate and latest-only replay, and leaves final tool results uncapped by the
live-tail limit. CLI 0.245 may already bound incoming progress at 8192 bytes;
owner tests, not that native observation, prove bridge-side clipping.

Both handoff cases approve only the offered `proceed_new_session_low` for the
exact bounded background timer. The first sends no further message and requires
an honest info notice, a retained source process, and one original stored row
without a fabricated completion. CLI 0.245.0 does not forward the target session's
later completion notification over the original connection. With explicit
authorization, this case looks only for the matching `execute-completion:<toolID>`
record in that scratch project's proven target-session JSONL. The output remains
unobservable in Portals even when that native record proves the job finished.
The second follows up before completion, resumes the real target session, and
requires a stopped-tracking info notice plus a tracking-ended row saying the work
may already have finished, never terminal success. These checks verify honest
handling of a native limitation, not full background completion parity. No persistent
permission, process polling, TaskOutput or TaskStop is used.

`DroidParityReviewUITests` adds the settings-only Spec model-switch case, the
next-turn completed-checklist case, and separate legacy Codex/Cursor menus.
The live UI bridge now also guards SDK inference and exposes advertised model
display names to the Max case. Haiku 5.5 currently advertises Max too: verify
that supported Max survives that switch, then use settings-only Haiku 4.5 to
verify unsupported Max is cleared. Save/reopen Medium, return to Haiku 5.5,
and only then send another prompt. Never infer on a settings-only model.
The effort Picker exposes its selection in the accessibility label, not value;
an absent value must never be treated as proof that effort reset.
Launch `droid-parity-bridge.mts --legacy-modes codex --audit` or
`--legacy-modes cursor --audit` for each legacy menu case. Those providers are
scripted fixtures with the corresponding kind, not real Codex/Cursor agents.
`--legacy-modes` and `--live` cannot be combined. Use an ordinary scripted bridge
for the checklist case and `--live --fixtures --audit` for the model case.

For this review run, the previous normal-HOME command exception is exhausted.
Do not recreate that fixture. Existing project-command cases and owner unit tests
cover command discovery; the personal-command live case must remain skipped.
