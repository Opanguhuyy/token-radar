// Token Radar Agent — public HTTP server.
//
// One agent, one job: answer "which pre-token protocol is worth farming
// next?" from a ranked board of protocols with no token yet, each scored by
// the radar-2 model (implied launch value = TVL x 0.25 x growth x patience
// x reach) and each carrying a seven-step farm plan.
//
// Node 24, standard library only. No dependencies, no keys, no wallet,
// no outbound calls at request time: every answer is computed from the
// board bundled in data/board.json (snapshot as of 2026-11-14).
//
//   node server.ts            # listen on $PORT (default 8787)
//   PORT=8080 node server.ts
//
// Endpoints:
//   GET  /                      landing page + API docs
//   GET  /health                liveness probe
//   GET  /dashboard/            interactive board (search, filter, sort)
//   GET  /api/board             ranked rows (?limit=&category=&chain=&watchlist=&q=)
//   GET  /api/protocol/:slug    one protocol + farm plan + model breakdown
//   GET  /api/live              the 24 largest tokens, for contrast
//   GET  /api/stats             board counts and model metadata
//   POST /ask                   {"question": "..."} -> ranked answer
//   POST /task                  Agent Games envelope: {"taskId": "...", "task": "..."}

import http from "node:http";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BoardRow, LiveRow } from "./lib/model.ts";

const PORT = Number(process.env.PORT ?? 8787);
const BODY_LIMIT = 64 * 1024;

const here = dirname(fileURLToPath(import.meta.url));

interface BoardDoc {
  as_of: string;
  source: string;
  model: string;
  floor_usd: number;
  rows: BoardRow[];
  live: LiveRow[];
  categories: string[];
  chains: string[];
}

const board: BoardDoc = JSON.parse(readFileSync(join(here, "data", "board.json"), "utf8"));
const bySlug = new Map(board.rows.map((r) => [r.slug, r]));
const byName = new Map(board.rows.map((r) => [r.name.toLowerCase(), r]));

const DISCLAIMER =
  "Research only, not financial advice. A farm plan never promises a token: " +
  "it tells you what to do and how often. Data frozen as of " + board.as_of + ".";

function money(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

function sendJson(res: http.ServerResponse, code: number, doc: unknown): void {
  const body = JSON.stringify(doc);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": String(Buffer.byteLength(body)),
  };
  // Agent Games: when the platform has issued an HMAC secret (dashboard >
  // Rotate Secret), every JSON response is signed over the raw body.
  const secret = process.env.AGENT_GAMES_HMAC_SECRET;
  if (secret) {
    headers["x-agent-games-signature"] = createHmac("sha256", secret).update(body).digest("hex");
  }
  res.writeHead(code, headers);
  res.end(body);
}

function sendText(res: http.ServerResponse, code: number, body: string, type: string): void {
  res.writeHead(code, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  return JSON.parse(text);
}

function publicRow(r: BoardRow): Record<string, unknown> {
  return {
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    category: r.category,
    chains: r.chains,
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    age_days: r.age_days,
    watchlist: r.watchlist,
    implied_value_usd: r.implied_value_usd,
    model: {
      growth_factor: r.growth_factor,
      age_factor: r.age_factor,
      chain_factor: r.chain_factor,
    },
  };
}

function filterBoard(params: URLSearchParams): BoardRow[] {
  let rows = board.rows;
  const category = params.get("category");
  if (category) {
    rows = rows.filter((r) => (r.category ?? "").toLowerCase() === category.toLowerCase());
  }
  const chain = params.get("chain");
  if (chain) {
    rows = rows.filter((r) => r.chains.some((c) => c.toLowerCase() === chain.toLowerCase()));
  }
  if (params.get("watchlist") === "true") rows = rows.filter((r) => r.watchlist);
  const minValue = params.get("min_value");
  if (minValue !== null) {
    const n = Number(minValue);
    if (Number.isFinite(n)) rows = rows.filter((r) => r.implied_value_usd >= n);
  }
  const q = params.get("q");
  if (q) {
    const needle = q.toLowerCase();
    rows = rows.filter(
      (r) =>
        r.slug.includes(needle) ||
        r.name.toLowerCase().includes(needle) ||
        (r.category ?? "").toLowerCase().includes(needle),
    );
  }
  const limit = Math.max(1, Math.min(226, Number(params.get("limit") ?? 25) || 25));
  return rows.slice(0, limit);
}

// ---- /ask: the agent's decision -------------------------------------------
// A deterministic, rule-based answer: the question is parsed for a protocol
// name, a category, a chain, and a "top N", the board is filtered and ranked
// by the same model that built it, and the answer explains the ranking.
// No LLM, no outbound call, no randomness: the same question always gets
// the same answer.

interface AskResult {
  question: string;
  intent: string;
  filters: Record<string, unknown>;
  answer: string;
  results: Record<string, unknown>[];
  model: string;
  as_of: string;
  disclaimer: string;
}

function answerQuestion(question: string): AskResult {
  const q = question.toLowerCase();
  const filters: Record<string, unknown> = {};

  // A named protocol wins: the answer is that protocol, its rank and its plan.
  let named: BoardRow | undefined;
  for (const row of board.rows) {
    if (q.includes(row.slug) || q.includes(row.name.toLowerCase())) {
      named = row;
      break;
    }
  }
  if (named) {
    const wantsPlan = /farm|plan|step|how (do|to)|what (do|should)/.test(q);
    const detail: Record<string, unknown> = publicRow(named);
    if (wantsPlan) detail.farm_steps = named.farm_steps;
    return {
      question,
      intent: "protocol",
      filters: { slug: named.slug },
      answer:
        `${named.name} ranks #${named.rank} of ${board.rows.length} on the board, ` +
        `with an implied launch value of ${money(named.implied_value_usd)} ` +
        `(TVL ${money(named.tvl_usd)}, 7-day change ${named.change_7d ?? "n/a"}%, ` +
        `${named.age_days} days listed with no token, on ${named.chains.join(", ")}). ` +
        (wantsPlan
          ? `Its farm plan is included in the result below.`
          : `Ask for its farm plan to see the seven steps.`),
      results: [detail],
      model: board.model,
      as_of: board.as_of,
      disclaimer: DISCLAIMER,
    };
  }

  // Category and chain filters, matched against the board's own vocabularies.
  let rows = board.rows;
  const category = board.categories.find((c) => q.includes(c.toLowerCase()));
  if (category) {
    rows = rows.filter((r) => r.category === category);
    filters.category = category;
  }
  const chain = board.chains.find((c) => q.includes(c.toLowerCase()));
  if (chain) {
    rows = rows.filter((r) => r.chains.includes(chain));
    filters.chain = chain;
  }
  if (/watchlist/.test(q)) {
    rows = rows.filter((r) => r.watchlist);
    filters.watchlist = true;
  }

  const topMatch = q.match(/top\s+(\d+)/);
  const limit = topMatch ? Math.max(1, Math.min(50, Number(topMatch[1]))) : 5;
  filters.limit = limit;
  const picked = rows.slice(0, limit);

  const scope =
    (category ? ` in ${category}` : "") +
    (chain ? ` on ${chain}` : "") +
    (filters.watchlist ? ` from the watchlist` : "");
  const lines = picked.map(
    (r, i) => `${i + 1}. ${r.name} — ${money(r.implied_value_usd)} implied value (rank #${r.rank}, TVL ${money(r.tvl_usd)})`,
  );
  const answer =
    picked.length === 0
      ? `Nothing on the board matches that${scope}. Try a category the board holds (${board.categories.slice(0, 8).join(", ")}) or a chain (${board.chains.slice(0, 8).join(", ")}).`
      : `Top ${picked.length} pre-token protocol${picked.length > 1 ? "s" : ""} to farm${scope}, ranked by implied launch value ` +
        `(TVL x 0.25 x 7-day growth x patience x chain reach):\n${lines.join("\n")}` +
        `\nEach result carries its full farm plan on request — ask "farm plan for <name>".`;

  return {
    question,
    intent: picked.length === 0 ? "no-match" : "ranking",
    filters,
    answer,
    results: picked.map((r) => {
      const d = publicRow(r);
      d.farm_steps = r.farm_steps;
      return d;
    }),
    model: board.model,
    as_of: board.as_of,
    disclaimer: DISCLAIMER,
  };
}

// ---- landing page ---------------------------------------------------------

function landingPage(): string {
  const top = board.rows.slice(0, 5);
  const topList = top
    .map((r) => `<li><b>#${r.rank} ${r.name}</b> — ${money(r.implied_value_usd)} implied value · TVL ${money(r.tvl_usd)} · ${r.chains.join(", ")}</li>`)
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Token Radar Agent — which pre-token protocol is worth farming next?</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:2em auto;padding:0 1em;line-height:1.55;color:#111}
code{background:#f2f2f2;padding:.1em .3em;border-radius:4px}pre{background:#f6f6f6;padding:1em;overflow:auto;border-radius:6px}
h1{font-size:1.6em}a{color:#0b5fff}</style></head><body>
<h1>Token Radar Agent</h1>
<p>An agent that answers one question: <b>which pre-token protocol is worth farming next?</b>
It ranks ${board.rows.length} protocols that have no token yet by the implied value of their launch
(TVL &times; 0.25 &times; 7-day growth &times; patience &times; chain reach) and writes a seven-step farm plan for each.</p>
<p>Board snapshot: <b>${board.as_of}</b> · source: ${board.source} · model: <code>${board.model}</code></p>
<h2>Top 5 right now</h2><ol>${topList}</ol>
<p><a href="/dashboard/">Open the interactive board</a> — search, filter and sort all ${board.rows.length} rows, with a detail view per protocol.</p>
<h2>Ask the agent</h2>
<pre>curl -s -X POST ${""}/ask -H 'Content-Type: application/json' \\
  -d '{"question":"top 5 lending protocols on Base"}'</pre>
<h2>API</h2>
<ul>
<li><code>GET /health</code> — liveness probe</li>
<li><code>GET /api/board?limit=10&amp;category=Lending&amp;chain=Base&amp;watchlist=true&amp;q=gauntlet</code></li>
<li><code>GET /api/protocol/:slug</code> — e.g. <a href="/api/protocol/steakhouse-financial">/api/protocol/steakhouse-financial</a></li>
<li><code>GET /api/live</code> — the 24 largest tokens, for contrast</li>
<li><code>GET /api/stats</code></li>
<li><code>POST /ask</code> — <code>{"question": "..."}</code></li>
<li><code>POST /task</code> — Agent Games envelope <code>{"taskId": "...", "task": "..."}</code></li>
</ul>
<p><small>${DISCLAIMER}</small></p>
<p><small>Built by the AI agent <b>plucky-lynx-55</b>. Node stdlib only, no keys, no wallet, no outbound calls at request time.</small></p>
</body></html>`;
}

// ---- server ---------------------------------------------------------------

const server = http.createServer((req, res) => {
  (async () => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";
      console.error(`${new Date().toISOString()} ${method} ${path}`);

      if (method === "GET" && path === "/") {
        sendText(res, 200, landingPage(), "text/html; charset=utf-8");
        return;
      }
      if (method === "GET" && path === "/health") {
        sendJson(res, 200, {
          status: "ok",
          agent: "token-radar",
          model: board.model,
          as_of: board.as_of,
          rows: board.rows.length,
          uptime_s: Math.round(process.uptime()),
        });
        return;
      }
      if (method === "GET" && path === "/api/stats") {
        sendJson(res, 200, {
          as_of: board.as_of,
          source: board.source,
          model: board.model,
          floor_usd: board.floor_usd,
          rows: board.rows.length,
          watchlist_rows: board.rows.filter((r) => r.watchlist).length,
          live_tokens: board.live.length,
          categories: board.categories,
          chains: board.chains,
          top_implied_value_usd: board.rows[0]?.implied_value_usd ?? 0,
        });
        return;
      }
      if (method === "GET" && path === "/api/board") {
        const rows = filterBoard(url.searchParams);
        sendJson(res, 200, {
          as_of: board.as_of,
          model: board.model,
          count: rows.length,
          total: board.rows.length,
          rows: rows.map(publicRow),
        });
        return;
      }
      if (method === "GET" && path === "/api/live") {
        sendJson(res, 200, { as_of: board.as_of, count: board.live.length, live: board.live });
        return;
      }
      if (method === "GET" && path.startsWith("/api/protocol/")) {
        const slug = decodeURIComponent(path.slice("/api/protocol/".length));
        const row = bySlug.get(slug) ?? byName.get(slug.toLowerCase());
        if (!row) {
          sendJson(res, 404, { error: `no protocol ${slug} on the board` });
          return;
        }
        sendJson(res, 200, {
          ...publicRow(row),
          farm_steps: row.farm_steps,
          as_of: board.as_of,
          model: board.model,
          disclaimer: DISCLAIMER,
        });
        return;
      }
      if (method === "GET" && (path === "/dashboard" || path === "/dashboard/")) {
        sendText(res, 200, readFileSync(join(here, "dashboard", "index.html"), "utf8"), "text/html; charset=utf-8");
        return;
      }
      if (method === "GET" && path === "/dashboard/data.js") {
        sendText(res, 200, `window.TOKEN_RADAR = ${JSON.stringify(board)};\n`, "application/javascript; charset=utf-8");
        return;
      }
      if (method === "GET" && (path === "/dashboard/app.js" || path === "/dashboard/app.css")) {
        const file = path.slice("/dashboard/".length);
        const type = file.endsWith(".js") ? "application/javascript; charset=utf-8" : "text/css; charset=utf-8";
        sendText(res, 200, readFileSync(join(here, "dashboard", file), "utf8"), type);
        return;
      }
      if (method === "POST" && path === "/ask") {
        const body = (await readJsonBody(req)) as { question?: unknown };
        if (typeof body.question !== "string" || body.question.trim() === "") {
          sendJson(res, 400, { error: 'POST {"question": "..."}' });
          return;
        }
        sendJson(res, 200, answerQuestion(body.question.trim()));
        return;
      }
      if (method === "POST" && path === "/task") {
        const body = (await readJsonBody(req)) as { type?: unknown; taskId?: unknown; task?: unknown; question?: unknown };
        // Agent Games preflight handshake: reply exactly this, signed when a
        // secret is configured (see sendJson). No task work is done here.
        if (body.type === "agent-games.preflight.v1") {
          sendJson(res, 200, { ok: true, protocolVersion: "v1" });
          return;
        }
        const task = typeof body.task === "string" ? body.task : typeof body.question === "string" ? body.question : "";
        if (task.trim() === "") {
          sendJson(res, 400, { error: 'POST {"taskId": "...", "task": "..."}' });
          return;
        }
        const result = answerQuestion(task.trim());
        sendJson(res, 200, {
          taskId: typeof body.taskId === "string" ? body.taskId : null,
          decision: result.intent,
          ...result,
        });
        return;
      }
      sendJson(res, 404, { error: "not found", hint: "GET / lists the API" });
    } catch (err) {
      console.error("handler error: " + String(err));
      if (!res.headersSent) sendJson(res, 500, { error: "handler failed" });
      else res.end();
    }
  })();
});

server.listen(PORT, "0.0.0.0", () => {
  console.error(`token-radar listening on ${PORT} — ${board.rows.length} rows, as_of ${board.as_of}`);
});
