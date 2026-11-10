# Tether

Self-hosted remote desktop. Control your Windows and Mac computers from any browser, through a server you run yourself. No accounts with a third party, no session limits, no licence checks.

"Tether" is a working name. To rebrand, change `productName` and `appId` in `host/package.json` and the titles in `server/public/index.html`.

## What is in this repository

| Folder | What it is |
| --- | --- |
| `server/` | Node.js server: accounts, device list, connection setup (signaling), and the web client it serves. One dependency (`ws`), SQLite storage built into Node. |
| `server/public/` | The browser client: dashboard and remote viewer. Plain HTML/CSS/JS, no build step. |
| `host/` | The installable app (Electron) for the computer being controlled. Captures the screen, applies mouse and keyboard input. |
| `test/e2e.mjs` | End-to-end test: real server, real host app, real Chrome. |
| `docker-compose.yml` | Server + automatic HTTPS (Caddy) + TURN relay (coturn). |
| `.github/workflows/build.yml` | Runs the tests and builds the Windows installer and macOS disk image. |

## How it works

```
 Browser (you) ──────── HTTPS / WebSocket ───────┐
                                                 ▼
                                          Tether server      introduces the two sides,
                                                 ▲           never sees screen or input
 Host app (remote PC) ──── WebSocket ────────────┘

 Browser ◄═════════ WebRTC, encrypted, peer to peer ═════════► Host app
                    (through your TURN relay only if a direct path is impossible)
```

Two ways to connect:

- **Unattended access.** Install the host on your own computer, sign it in to your account once, set an access password. It then appears under "Your computers" in the web client whenever it is on.
- **Support session.** The other person opens the host app and reads you the 9-digit ID and one-time password. They get an Allow/Decline prompt before you connect. The ID and password change after every session.

During a session: live screen, mouse, keyboard, monitor switching, quality presets, clipboard in both directions, file transfer in both directions (up to 2 GB), full-screen mode with system-key capture.

## Security model

- The access password (unattended) and the one-time password (support) are checked **by the host itself**, over the encrypted peer-to-peer channel. The proof is tied to both ends' encryption certificates, so the server cannot connect to a computer on its own, and a relayed or intercepted connection fails the check.
- The host proves it knows the password too, so you cannot be silently connected to an impostor.
- Wrong passwords: 3 tries per connection. Unattended access locks for 10 minutes after 8 failures. Support passwords rotate after 5 failures.
- Account passwords are stored with scrypt. Optional authenticator-app two-step verification. Sign-in, enrollment and code lookups are rate limited. Session cookies are HttpOnly and SameSite=Strict, and state-changing requests must come from the server's own origin.
- The host always shows who is connected, in a banner that stays on top, with an End button.
- Secrets on the host (device token, access-password key) are encrypted with the operating system keychain where available.

Known limits of this design:

- Someone who controls your server and intercepts a connection attempt could try to guess the password offline. Use a long access password (the app requires 10+ characters). A proper fix is a PAKE handshake, which is on the roadmap below.
- Anyone with an account on your server can attempt support sessions. Only create accounts for people you trust.

## Run the server

### With Docker (recommended for the internet)

Needs a Linux server with a public IP and a DNS name pointing at it. Open ports 80, 443, 3478 (TCP+UDP) and 49160-49200 (UDP).

```sh
cp .env.example .env      # fill in DOMAIN, PUBLIC_IP, TURN_SECRET
docker compose up -d
docker compose logs tether   # shows the one-time setup code
```

Open `https://your-domain`, enter the setup code, and create the owner account. Then turn on two-step verification under your email address in the top bar.

### Without Docker (local network or testing)

```sh
cd server && npm ci && npm start     # Node 22.13 or newer; listens on :8080
```

The web client needs HTTPS or `localhost`; browsers block the crypto it uses on plain `http://` addresses.

Server settings (environment variables):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Listen address |
| `DATA_DIR` | `server/data` | Database location |
| `PUBLIC_URL` | none | Public address, e.g. `https://remote.example.com` |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy |
| `STUN_URLS` | Google public STUN | Comma-separated; empty string disables |
| `TURN_URLS`, `TURN_SECRET` | none | Your coturn relay and its shared secret |

Without a TURN relay, connections work when a direct path exists (same network, or ordinary home routers) and fail across strict corporate or mobile networks.

## Build the host app

Installers are built by GitHub Actions on every push: open the latest run under **Actions** and download `tether-windows` or `tether-macos`. Pushing a tag like `v1.0.0` also attaches them to a release.

To bake in your server address so users never type it, set `defaultServerUrl` in `host/tether.config.json` before building.

To run from source: `cd host && npm ci && npm start`.

### First launch

- **Windows:** SmartScreen warns about an unknown publisher because the installer is not code signed. Choose "More info" then "Run anyway".
- **macOS:** right-click the app and choose Open the first time (it is ad-hoc signed, not notarized). Then grant **Screen Recording** and **Accessibility** when the app asks, and reopen it. macOS asks again after each new build until the app is signed with a Developer ID.

## Tests

```sh
npm ci && (cd server && npm ci) && (cd host && npm ci)
npm --prefix server test
xvfb-run -a -s "-screen 0 1280x800x24" node test/e2e.mjs    # Linux
```

The end-to-end test drives the real host app and a real Chrome viewer through setup, sign-in, both session types, wrong passwords, mouse, keyboard, clipboard, file transfer both ways, quality switching, ending a session from each side, and device removal.

### What has and has not been verified

| Area | Status |
| --- | --- |
| Server, web client, session protocol, host app logic | Tested end to end on Linux |
| Windows installer and input/capture on Windows | **Not yet run on a real machine** |
| macOS disk image, permissions flow, input/capture on macOS | **Not yet run on a real machine** |
| Docker Compose deployment (Caddy, coturn) | **Written but not yet run** |
| Multi-monitor and high-DPI coordinate mapping | Implemented, not yet verified on real hardware |

## Current limitations

- **Login screen, lock screen and Windows admin (UAC) prompts cannot be seen or controlled.** The host runs as the signed-in user. Reaching those screens needs a Windows service running as SYSTEM and a macOS launch daemon. For unattended use today, the computer must stay signed in (the "start when I sign in" and "keep awake" options help).
- On Windows the host cannot click inside windows that run as administrator unless the host itself is started as administrator.
- Ctrl+Alt+Del and Win+L cannot be sent (Windows blocks synthetic versions of both).
- Keys are sent by physical position, so the remote computer's keyboard layout decides which character appears.
- No audio, no session recording, no automatic reconnect after a network drop, no auto-update.
- One viewer per computer at a time. One owner account is created at setup; there is no user-management screen yet.

## Roadmap to a product

1. Verify and fix on real Windows and macOS hardware.
2. Code signing: Windows certificate, Apple Developer ID and notarization.
3. System service for login screen, lock screen and UAC.
4. PAKE-based password handshake; optional per-device approval of new browsers.
5. Auto-update, user management, audio, automatic reconnect.
