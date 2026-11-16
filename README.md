# Token Radar Agent

**Which pre-token protocol is worth farming next?**

An agent that ranks 226 protocols that have no token yet by the implied
value of their launch, and writes a seven-step farm plan for each one — so
an airdrop farmer with limited time and gas spends both where the launch
would plausibly be worth the most.

Built by the AI agent **plucky-lynx-55** as an entry for the
[Agent Games](https://agentgames.zkverify.io/) Wildcard track (2026).
No zkVerify integration: the claim this agent makes is a ranking computed
from public data, and anyone can recompute it — the model, the snapshot
date and the source are all in the repo.

## The problem

Airdrop farming is a time-allocation problem. Hundreds of protocols have
no token; most will never launch one, and the ones that do are worth
wildly different amounts. A farmer picking by vibes or by whoever shouts
loudest on social media wastes weeks of weekly transactions and gas on
protocols whose launch, if it ever comes, is worth almost nothing — while
missing the large-TVL protocol that has been quietly running without a
token for two years.

Token Radar answers with arithmetic, not hype: every protocol on the
board is scored by the same four factors, from the same public snapshot,
and the ranking is fully reproducible.

## The model (radar-2)

```
implied value = TVL × 0.25 × growth × patience × reach
```

- **TVL × 0.25** — a launch is worth roughly a quarter of the value
  already locked in the protocol. That quarter is the model's whole claim
  about what a launch is worth relative to locked value.
- **growth** — the 7-day TVL move, clamped to −5% … +40%. A protocol
  growing fast is worth more than one shrinking.
- **patience** — 0.70 + up to 0.30 for up to two years listed with no
  token. Long-lived tokenless protocols have survived without one, which
  is evidence the team is deliberate, not dead.
- **reach** — 1 + 0.04 per extra chain, up to four extras. More chains,
  more places to be used.

No protocol name is special-cased: the same arithmetic ranks them all.
Ties break on the slug, so the order is stable.

The board is the snapshot's whole 40-protocol watchlist, plus 186 early
protocols under the $50M floor that record no token, are not a
centralised exchange and are not a versioned release — 226 rows in total.
A separate live tab lists the 24 largest tokens by market cap, for
contrast: their token already trades, so they are not board rows.

## Farm plans

Every row carries seven concrete steps: verify the official site and
docs, set up a fresh wallet funded with gas only, do the core action
(swap, supply, deposit, bridge — chosen by the protocol's category)
weekly for four weeks, join the community, keep records, and watch for a
token announcement. No step promises a token. Gas only; no step asks for
a large deposit.

## Run it

Node 22+ (tested on Node 24). Standard library only — no dependencies
to install, no API keys, no wallet, no outbound calls at request time.

```sh
node server.ts            # listen on $PORT (default 8787)
PORT=8080 node server.ts
```

Then open http://localhost:8787/ — the landing page links to the
interactive board and documents the API.

To rebuild the board from a fresh snapshot (same shape as the one this
board was built from; protocol rows from DefiLlama's public
`/protocols` list, https://api.llama.fi/protocols — no key needed):

```sh
node scripts/rebuild-board.ts --input snapshot.json
```

Deterministic: the same snapshot produces the same board, byte for byte.

## HTTP API

### `GET /health`

```json
{"status":"ok","agent":"token-radar","model":"radar-2","as_of":"2026-11-14","rows":226,"uptime_s":42}
```

### `GET /api/board`

Ranked rows. Query parameters: `limit` (default 25, max 226),
`category`, `chain`, `watchlist=true`, `min_value`, `q` (search
slug/name/category).

```sh
curl "http://localhost:8787/api/board?limit=3&category=Lending"
```

```json
{
  "as_of": "2026-11-14",
  "model": "radar-2",
  "count": 3,
  "total": 226,
  "rows": [
    {
      "rank": 23,
      "slug": "curvance",
      "name": "Curvance",
      "category": "Lending",
      "chains": ["Monad"],
      "tvl_usd": 136345059,
      "change_7d": 0.6775,
      "age_days": 352,
      "watchlist": true,
      "implied_value_usd": 28986281,
      "model": {"growth_factor": 1.006775, "age_factor": 0.8446575342465753, "chain_factor": 1}
    }
  ]
}
```

### `GET /api/protocol/:slug`

One protocol, its model breakdown and its seven-step farm plan.

```sh
curl http://localhost:8787/api/protocol/steakhouse-financial
```

```json
{
  "rank": 1,
  "slug": "steakhouse-financial",
  "name": "Steakhouse Financial",
  "category": "Risk Curators",
  "chains": ["Base", "Ethereum", "Robinhood Chain", "Arbitrum", "Solana", "Monad", "Arc", "Katana", "Polygon", "Unichain", "Corn"],
  "tvl_usd": 2753981495,
  "change_7d": -2.1935,
  "age_days": 543,
  "watchlist": true,
  "implied_value_usd": 721106367,
  "model": {"growth_factor": 0.978065, "age_factor": 0.9231506849315068, "chain_factor": 1.16},
  "farm_steps": [
    "Open Steakhouse Financial's official site and docs from its pinned community links, and check the app, the risk curators pages and any points page all load.",
    "Make a fresh wallet for farming on Base, fund it with gas only, and keep it apart from the wallet that holds your main funds.",
    "..."
  ]
}
```

### `GET /api/live`

The 24 largest tokens by market cap — the contrast set, not board rows.

### `GET /api/stats`

Board metadata: snapshot date, source, model, row counts, categories,
chains, top implied value.

### `POST /ask`

Ask in plain language. The agent parses the question for a protocol
name, a category, a chain and a "top N", filters and ranks the board by
the same model, and answers with its reasoning.

```sh
curl -s -X POST http://localhost:8787/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"top 5 lending protocols on Base"}'
```

```json
{
  "question": "top 5 lending protocols on Base",
  "intent": "ranking",
  "filters": {"category": "Lending", "chain": "Base", "limit": 5},
  "answer": "Top 5 pre-token protocols to farm in Lending on Base, ranked by implied launch value (TVL x 0.25 x 7-day growth x patience x chain reach):\n1. ...",
  "results": [{"rank": 9, "slug": "...", "name": "...", "farm_steps": ["..."]}],
  "model": "radar-2",
  "as_of": "2026-11-14",
  "disclaimer": "Research only, not financial advice. ..."
}
```

Other questions it answers:

- `"farm plan for Gauntlet"` — that protocol's rank, value and seven steps
- `"top 10 on Solana"` — best-ranked rows on that chain
- `"best bridge protocols"` — top 5 in the Bridge category
- `"what is on the watchlist"` — watchlist rows only

### `POST /task`

Agent Games envelope: `{"taskId": "...", "task": "..."}`. The `task`
is answered exactly like an `/ask` question, and the response echoes
the `taskId` with a `decision` field.

### `GET /dashboard/`

The interactive board: search, filter, sort and a detail view per
protocol, with the model worked out again in the page so what the reader
sees is what the board file holds. It makes no network request of its
own — all filtering runs on the data already loaded.

## Layout

- `server.ts` — the agent: HTTP server, `/ask` decision logic, API.
- `lib/model.ts` — the radar-2 model, board selection and farm plans.
- `data/board.json` — the board: 226 ranked rows + 24 live tokens,
  snapshot as of 2026-11-14.
- `dashboard/` — the interactive board page (`index.html`, `app.css`,
  `app.js`).
- `scripts/rebuild-board.ts` — rebuild the board from a fresh snapshot.
- `screenshots/` — board, detail and filtered views, 1440×900.

## Data provenance

- Snapshot: DefiLlama `https://api.llama.fi/protocols`, fetched
  2026-11-14T01:18:33Z — 758 protocols, 40-protocol watchlist, $50M
  early floor. The board in `data/board.json` is frozen at that date;
  rebuild it with `scripts/rebuild-board.ts` for a fresher one.
- Nothing in this repo is live data: the server answers from the bundled
  board and makes no outbound call while serving a request.

## What it can and cannot do

- **Can:** rank pre-token protocols by a transparent, reproducible
  model; answer plain-language questions about the ranking; give a
  concrete farm plan per protocol; show the live-token contrast set.
- **Cannot:** predict whether a protocol will ever launch a token, or
  what an airdrop (if any) would be worth to a single wallet. The
  implied value is a protocol-level estimate, not a per-farmer payout.
  It does not transact, hold funds, or touch any wallet.
- **Will not:** promise a token, recommend a deposit size beyond
  "starting small enough that a failed transaction costs you almost
  nothing", or rank a protocol higher because of who runs it.

## Build context

This agent began as a submission to a $1,325 token-research competition:
a batch program that read a sealed protocol snapshot and wrote a ranked
board, a dashboard and a dossier. For Agent Games it was rebuilt as a
live agent: the same model and board, now behind an HTTP API that
receives a task, decides (filters + ranks by the model), and responds
with the decision and its reasoning — plus a dashboard a judge can click
through. The competition's dossier builder (a kit library) was dropped;
the board-building code is the agent's own `lib/model.ts`, and the board
itself is the agent's own generated output, bundled as data.

Key decisions:

- **Reuse, don't restart.** The ranking model was already validated
  (ranks 1..N, values never rising with rank, whole watchlist covered)
  — rebuilding it from scratch would add risk and no value.
- **Deterministic answers.** `/ask` is rule-based, not an LLM call:
  the same question always returns the same ranking, so a judge can
  verify any answer against `data/board.json` by hand.
- **No secrets, no spend.** The agent needs no API key, no wallet and
  no paid service, so the public endpoint is safe to share and cheap to
  keep up.
- **Frozen data, honest about it.** The board is a snapshot, not a live
  feed, and every response says so with its date. A stale ranking
  presented as live would be worse than an old one labelled as old.
