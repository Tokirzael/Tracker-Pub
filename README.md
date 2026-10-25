# Character Tracker — Standalone Build

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
- The server binds to `127.0.0.1` only by default — nothing is reachable
  from other machines unless you set `CT_HOST=0.0.0.0` (LAN) or open a
  sharing tunnel from the launcher.
- This repo is the release-build mirror: prebuilt output only, no source.
  Releases are rebuilt from the private development repo as they ship.
- Release `6ee0310` (2026-10-25, "shipping neutrality" + "blank slate").
