# Statehouse Atlas

An interactive map of U.S. state legislative districts, Congress, and executive offices. The first release covers the 50 states.

## Local preview

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`. From an SSH client, forward the port with `ssh -L 3000:localhost:3000 user@host` and open the same URL locally.

The map has three views: State legislatures (`/`), U.S. Congress (`/congress`), and U.S. Executives (`/executives`). The executives view reuses the state boundary archive, shows each current governor, and places a president seal in the Atlantic east of the DC region. The sidebar president button remains accessible when the seal is outside the current viewport.

## Executive officeholder data

`public/data/executives.json` is a checked-in snapshot. Refresh it with:

```bash
python scripts/refresh-executives.py
```

The script uses Python's standard library. It reads the [National Governors Association's current roster](https://www.nga.org/governors/) and each governor's NGA profile for names and party affiliation, [USAGov's governor directory](https://www.usa.gov/state-governor) for official state site links, and the [White House administration page](https://www.whitehouse.gov/administration/) for the president. It validates exactly 50 states and writes the snapshot atomically. Refresh and review the data before deploying when officeholders may have changed. The site shows the snapshot timestamp; it does not claim a live roster.

## Checks

```bash
npm run lint
npx tsc --noEmit
npm run build -- --webpack
```

The Render Blueprint in the repository root builds and serves this Next.js app. `/api/health` checks that required snapshots and map archives exist.
