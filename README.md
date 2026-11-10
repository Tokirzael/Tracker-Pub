# Character Tracker - Standalone Build

A self-hosted character sheet tracker. This folder is fully self-contained:
it ships its own Node runtime, the server, and the web client. Nothing is
installed system-wide and no build tools are needed.

## What's new (v1.1.0)

- **Dice Roller card.** A dice tray (d2 through d100) plus saved rolls.
  Rolling is always free - even on a locked sheet, in view mode. Saved
  rolls are protected by the PIN, like everything else.
- **Pin your favorites.** Pinned rolls become one-click pills; the rest
  live in a menu. A saved roll remembers its dice, bonus, goal, cost and
  outcome.
- **Goals and crit rules.** Count successes in a dice pool (10d10, each
  die 6 or better), check a total against a difficulty (roll over or
  under), let natural maxes count double or EXPLODE (roll another die),
  and let natural 1s subtract successes.
- **Rolls that touch the sheet.** Link a stat for its live modifier, as a
  flat bonus, or as that many extra dice; make a roll spend pool or item
  quantity, and automatically drain, restore or set a pool - by the
  roll's total or its success count.
- **Effects can bend rolls.** Curses and buffs can shift every roll:
  bonus, extra dice, or easier goals.
- **The AI Sheet Assistant speaks dice.** "Create a saved roll called
  Dagger Strike: 1d20 plus Dexterity, crits on a natural 20" - or "cursed:
  all my rolls minus 2".
- **Dice rolls appear in the activity ledger** like any other change, and
  the new dice segment locks behind its own sub-PIN.
- New sheets ship with two example rolls so you can see it work.

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
- Built 2026-11-10 from release `972e1e4`.
