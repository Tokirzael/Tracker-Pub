# Character Tracker - Standalone Build

A self-hosted character sheet tracker. This folder is fully self-contained:
it ships its own Node runtime, the server, and the web client. Nothing is
installed system-wide and no build tools are needed.

## Launch

- **Windows:** double-click `Launch Tracker.bat`
  - Answer `Y` at "Open a sharing tunnel?" to get a temporary
    `https://…trycloudflare.com` link you can send to friends
    (needs cloudflared — the launcher offers to fetch it automatically).
  - Answer `N` for local-only: http://localhost:5173
- **Linux / macOS:** `./start.sh` (uses a system `node` on PATH)
- **Manual, any OS:** `node server.mjs --port 5173`

Your sheets live in the `data\` folder next to the server. Back that folder
up to move your data anywhere — it is portable between machines.

## The owner PIN (blank slate)

This build ships with NO key of any kind.

- The first time you open Settings (or click New Character), the app asks
  you to SET an owner PIN — the first PIN you enter CLAIMS this copy.
  There is no factory or default key to look up. Nothing works until you
  claim it.
- After the claim, that PIN is the only owner credential that exists.
  Losing it means losing owner access to this copy — there is no back door.
- Sheet PINs and the owner PIN are checked by the server only; the browser
  never sees the real value.
- Lockout: 3 wrong owner-PIN tries freezes owner checks for 5 minutes
  (`data\master-lock.json` — delete that file to reset).
- Sharing the folder over a URL and worried about a race for the claim?
  Set `CT_OWNER_BOOTSTRAP_PIN=yourpin` in the environment before the first
  launch — the claim must satisfy it.

## Notes

- Not high security by design: sheet PINs stop an inattentive co-editor,
  not a developer with browser tools.
- The server binds to all interfaces when started manually; the launcher
  keeps it on your machine unless you open a tunnel.
- Rebuilt 2026-10-25 from release `12cbde56` ("blank slate").
