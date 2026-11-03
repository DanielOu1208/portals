# Security Policy

## Supported version

Security fixes are provided for the newest TestFlight build of the app and the newest
`portals-host` on npm only.

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting form](https://github.com/DanielOu1208/portals/security/advisories/new).
Do not open a public issue for a suspected vulnerability.

Include the affected versions, your device and OS, reproduction steps and the expected
impact. Remove passwords, pairing links and QR codes, API keys, the contents of your
threads and other personal information from screenshots and logs.

If private vulnerability reporting is temporarily unavailable, open a public issue
containing no vulnerability details and ask the maintainer to establish a private channel.

## Security boundaries

- **The agents run as you.** They can read and change your files and run commands as they
  do in your terminal, within the permission mode each thread runs in. Anyone who can sign
  in to your host can use them, so its password is what protects your computer.
- **The host** listens only on `127.0.0.1`. `tailscale serve` makes it reachable from your
  tailnet. Its password and API keys are kept in its folder, readable only by you.
- **Pairing links and QR codes hold the host's password.** Treat them like the password.
- **The app** keeps passwords in the Keychain.
- **The relay** is a Cloudflare Worker. What it carries is encrypted between your device
  and your computer, so it can't read notifications or relayed connections. It holds the
  APNs key for the official app.
- **Visuals** that agents draw run in a sandboxed web view.
