# Security notes

Shackle lets one computer see and control another. That is powerful by design, so this page states
plainly what protects you, what was checked, and what is not solved.

To report a vulnerability, open a private security advisory on the GitHub repository.

## How a session is protected

1. **Password first, then approval.** The caller must prove they know the one-time password, directly
   to the computer being controlled, before that computer's user is even asked. Strangers guessing
   IDs cannot make a prompt appear.
2. **Explicit approval.** The person at the computer sees a window naming the caller's Shackle ID,
   with a scam warning. "Allow" unlocks after three seconds. No answer within 60 seconds is a decline.
3. **End-to-end check.** The password proof is bound to both computers' encryption certificates. A
   relay or the server cannot reuse it, and the controlled computer proves itself to the caller too.
4. **Single-use credentials.** ID and password change after every session and after five wrong tries.
   Three wrong passwords end the connection attempt.
5. **Always visible.** While anyone is connected, a banner naming them stays on top with an End
   button, and the app shows its tray icon whenever it runs. Sessions are logged locally (Activity).
6. **No foothold.** While someone is connected, the app refuses to add the computer to an account,
   set an unattended password, change the server, or start an outgoing connection. A remote person
   cannot use a one-time session to arrange permanent access through Shackle.
7. **Identity that cannot be spoofed by naming.** The approval window shows only the server-assigned
   ID, never a self-chosen name such as "Microsoft Support".

## Audit performed (November 2026, by the authors)

| Area | Result |
| --- | --- |
| Unsolicited approval prompts from strangers | Fixed: approval is asked only after a correct password |
| Remote person creating persistent access during a session | Fixed: sensitive settings locked during sessions |
| Caller impersonating a trusted name in the approval window | Fixed: only the ID is shown |
| Password guessing | 3 tries per attempt, rotation after 5 failures, per-caller and per-target rate limits on the server |
| Web dashboard (accounts) | scrypt password hashing, optional TOTP, HttpOnly SameSite=Strict cookies, same-origin checks on state-changing requests and WebSockets, strict Content-Security-Policy, login and enrollment rate limits |
| Desktop app | Context isolation and sandbox on every window, no Node access in pages, navigation and new windows blocked, the viewer page runs in a separate storage partition with a permission allowlist, secrets stored with the OS keychain where available |
| File transfer | File names sanitised, saved only to Downloads/Shackle, never overwritten or executed, size enforced |
| Dependencies | Server: one dependency (`ws`), no known advisories. App: `npm audit` reports a moderate advisory in an image-parsing library pulled in by the input library; Shackle never calls that code path |
| Automated tests | 21 end-to-end checks on Linux, including the hardening above |

## Known limitations

- **Social engineering.** Anyone the user approves gets full control of the computer. No software
  measure stops a user who has been persuaded to click Allow.
- **Unsigned installers.** No Windows code-signing certificate or Apple notarization yet. The OS
  cannot verify the publisher; compare downloads against `SHA256SUMS.txt` on the release page.
- **No independent audit.** Everything above was reviewed by the people who wrote it.
- **Malicious or compromised server.** The server never sees screen content, input or files. It does
  see IP addresses, IDs and timing. If it actively intercepted a connection attempt it could capture
  a password proof and try guesses offline against that one-time password (8 characters from a
  31-character alphabet, PBKDF2 with 200,000 iterations). Replacing this with a PAKE handshake is planned.
- **Full control includes Shackle's own files.** A connected person could alter files on disk like any
  user at the keyboard. The in-app lock stops the easy path, not a determined attacker with a session.
- **Clipboard.** Text copied on the controlled computer during a session is sent to the caller.
- **Received files are not scanned** and do not carry the operating system's "downloaded from the
  internet" marker.
- **Windows:** elevated (administrator) windows, the lock screen and UAC prompts cannot be seen or controlled.
- **Tested on Linux only by automation.** Windows and macOS builds are exercised by hand.
