# Contributing to Portals

Thanks for helping improve Portals.

## Issues are welcome

Use a GitHub issue for reproducible bugs or focused feature requests. Search existing
issues first and keep each issue to one problem.

For bugs, include the app version, the `portals-host` version (`npx portals-host status`
shows it), your device and OS, the host's OS, which agent was running, what you expected
and concise steps to reproduce it. Never include passwords, pairing links or QR codes, API
keys, or the contents of your threads.

Security problems must follow [SECURITY.md](SECURITY.md), not the public issue tracker.

## Pull requests

Pull requests are welcome. To get one merged:

1. **Agree on it first.** Open an issue for anything bigger than a small fix and wait for a
   yes before building it, so you don't spend time on something that won't be taken.
2. **Make one change.** Keep it small and leave unrelated cleanups out.
3. **Keep CI green.** Add a test for a bug fix or new behavior wherever one can be written.
4. **Show it.** For anything visible, add screenshots or a short video from each device it
   changes: iPhone, iPad, Mac.
5. **Say how you tested it,** including the agent and host you tried it with.
6. **Understand your code.** AI tools are fine, but you need to have read and run what you
   submit, and be able to answer questions about it.
7. **Leave out anything private.** No keys, passwords, personal paths or real conversations
   in code, test data, screenshots or logs.
8. **Talk first about new dependencies.** They need a good reason.

Pull requests that don't meet these may be closed. By opening one, you agree that your
contribution is released under the [MIT License](LICENSE).

## Local verification

Run the tests before reporting a source-level regression:

```sh
(cd Packages/PortalsKit && swift test)
(cd bridge && npm ci && npm test)
(cd relay && npm ci && npm test)
```

The app is built with Xcode 27, and the host and relay need Node 22.18 or newer.
