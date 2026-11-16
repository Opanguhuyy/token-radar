// Radar model for the token launch board.
//
// The board answers one question: of the protocols in the snapshot that do
// not have a token yet, which launch would be worth the most, and what do you
// do to farm it? The model below turns each protocol's own snapshot figures
// into an implied value in dollars, picks the board, and writes a farm plan
// for every row. Nothing here names a protocol: the same rules rank a
// billion-dollar vault and a five-million-dollar bridge alike.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface SnapshotFile {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ImpliedBreakdown {
  value: number;
  growth: number;
  age: number;
  chains: number;
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number;
  watchlist: boolean;
  growth_factor: number;
  age_factor: number;
  chain_factor: number;
}

export interface LiveRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
}

const DAY_MS = 86_400_000;

// A name that ends in a version marker (V2, v3, 2.0 and the like) is a new
// release of something that already exists, not a fresh launch candidate.
const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

// The snapshot's own day, parsed without a timezone: "2026-11-14" means the
// UTC day, never the reader's local midnight.
export function dayNumber(isoDay: string): number {
  const parts = isoDay.split("-").map((piece) => Number(piece));
  return Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!) / DAY_MS;
}

// Whole days from the day DefiLlama began tracking a protocol to the
// snapshot's day. A protocol with no listing date counts as brand new.
export function ageDays(listedAt: string | null, asOf: string): number {
  if (listedAt === null) return 0;
  const span = dayNumber(asOf) - dayNumber(listedAt);
  return span < 0 ? 0 : span;
}

// A week's TVL move, held inside [-5, 40] percent. A null move counts as
// flat: the snapshot says nothing, so the model assumes nothing.
export function growthFactor(change7d: number | null): number {
  const move = change7d === null ? 0 : Math.max(-5, Math.min(40, change7d));
  return 1 + move / 100;
}

// Time with no token is worth something, but it tops out: two years of
// waiting earns the full patience factor and no more.
export function ageFactor(days: number): number {
  return 0.7 + (Math.min(days, 730) / 730) * 0.3;
}

// A protocol live on several chains has more places to be used, so it earns
// a little more per extra chain, up to four extras.
export function chainFactor(chainCount: number): number {
  const extra = Math.max(0, Math.min(chainCount - 1, 4));
  return 1 + 0.04 * extra;
}

// The implied value: a quarter of TVL, moved by the week's growth, by how
// long the protocol has run with no token, and by how many chains it runs
// on. The quarter is the model's whole claim about what a launch is worth
// relative to the value already locked in the protocol.
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
): ImpliedBreakdown {
  const days = ageDays(protocol.listed_at, asOf);
  const growth = growthFactor(protocol.change_7d);
  const age = ageFactor(days);
  const chains = chainFactor(protocol.chains.length);
  const value = Math.round(protocol.tvl_usd * 0.25 * growth * age * chains);
  return { value, growth, age, chains };
}

// A protocol with no token at all: neither a CoinGecko id nor a ticker.
export function hasNoToken(protocol: SnapshotProtocol): boolean {
  return protocol.gecko_id === null && protocol.symbol === null;
}

// The early rows are the watchlist's complement below the floor: pre-token,
// not a centralised exchange, not a versioned release, and under the floor.
export function isEarlyCandidate(
  protocol: SnapshotProtocol,
  floorUsd: number,
): boolean {
  if (!hasNoToken(protocol)) return false;
  if (protocol.category === "CEX") return false;
  if (VERSION_TAIL.test(protocol.name)) return false;
  if (protocol.tvl_usd >= floorUsd) return false;
  return true;
}

// The board: every watchlist protocol, plus the early candidates, ranked by
// implied value, highest first. A tie breaks on the slug so the order is
// stable no matter how the snapshot file happens to list its rows.
export function selectBoard(snapshot: SnapshotFile): BoardRow[] {
  const watch = new Set(snapshot.watchlist);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const picked: SnapshotProtocol[] = [];
  for (const slug of snapshot.watchlist) {
    const found = bySlug.get(slug);
    if (found !== undefined) picked.push(found);
  }
  for (const protocol of snapshot.protocols) {
    if (watch.has(protocol.slug)) continue;
    if (isEarlyCandidate(protocol, snapshot.floor_usd)) picked.push(protocol);
  }
  const scored = picked.map((protocol) => {
    const implied = impliedValue(protocol, snapshot.as_of);
    return { protocol, implied };
  });
  scored.sort((a, b) => {
    if (b.implied.value !== a.implied.value) {
      return b.implied.value - a.implied.value;
    }
    return a.protocol.slug < b.protocol.slug
      ? -1
      : a.protocol.slug > b.protocol.slug
        ? 1
        : 0;
  });
  return scored.map(({ protocol, implied }, index) => {
    const days = ageDays(protocol.listed_at, snapshot.as_of);
    return {
      slug: protocol.slug,
      name: protocol.name,
      rank: index + 1,
      implied_value_usd: implied.value,
      farm_steps: farmSteps(protocol),
      category: protocol.category,
      chains: [...protocol.chains],
      tvl_usd: protocol.tvl_usd,
      change_7d: protocol.change_7d,
      age_days: days,
      watchlist: watch.has(protocol.slug),
      growth_factor: implied.growth,
      age_factor: implied.age,
      chain_factor: implied.chains,
    };
  });
}

// The protocols whose token already trades, for the dashboard's live tab:
// the largest market caps first, twenty-four of them.
export function liveSet(protocols: SnapshotProtocol[], count: number): LiveRow[] {
  return protocols
    .filter((p) => p.mcap_usd !== null)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0))
    .slice(0, count)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      chains: [...p.chains],
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd ?? 0,
      change_7d: p.change_7d,
    }));
}

// What to actually do on a protocol, by what kind of protocol it is. The
// first chain listed is the one the plan starts on; the category picks the
// core action. An unknown category falls back to using the app itself.
const CORE_ACTION: Record<string, string> = {
  Dexs: "swap a small amount and add liquidity to its largest pool",
  Lending: "supply collateral and borrow a small amount against it",
  Yield: "deposit into its highest-TVL vault and leave it earning",
  Bridge: "bridge a small amount across and back on its main route",
  "Liquid Staking": "stake a small amount and hold the receipt token",
  "Liquid Restaking": "restake a small amount and hold the receipt token",
  Derivatives: "open a small position and close it after the funding round",
  "CDP": "open a small vault and mint its stablecoin against collateral",
  "Yield Aggregator": "deposit into its main vault and let it compound",
  "Algo-Stables": "provide liquidity to its stable pool on the main chain",
  "Cross Chain": "move a small amount between two of its supported chains",
  Farm: "stake in its main farm and claim the rewards weekly",
  "DEX Aggregator": "route one swap a week through its aggregator",
  Insurance: "buy the smallest cover policy it offers and hold it",
  "Prediction Market": "place one small prediction on its most active market",
  "RWA": "use its tokenised asset app once and hold the receipt",
  "NFT Marketplace": "list or buy one low-priced item through its market",
  Gaming: "play one session and complete its daily quest",
  "Social": "create a profile and post once through its app",
  Payments: "send one small payment through its rails and keep the receipt",
};

function coreActionFor(protocol: SnapshotProtocol): string {
  const category = protocol.category ?? "";
  return CORE_ACTION[category] ?? "use its main app once end to end";
}

// Seven steps, each one naming the protocol, its main chain and its kind, so
// the plan is about this protocol and no other. A step never promises a
// token: it tells the reader what to do and how often.
export function farmSteps(protocol: SnapshotProtocol): string[] {
  const name = protocol.name;
  const chain = protocol.chains[0] ?? "its main chain";
  const kind = (protocol.category ?? "protocol").toLowerCase();
  const action = coreActionFor(protocol);
  return [
    `Open ${name}'s official site and docs from its pinned community links, and check the app, the ${kind} pages and any points page all load.`,
    `Make a fresh wallet for farming on ${chain}, fund it with gas only, and keep it apart from the wallet that holds your main funds.`,
    `On ${chain}, ${action} with ${name}, starting small enough that a failed transaction costs you almost nothing.`,
    `Come back once a week for four weeks and repeat the core action, so your address shows steady use instead of a single visit.`,
    `Join ${name}'s community channel and watch for quests, points, testnet tasks or seasons tied to the ${kind} app.`,
    `Write down every deposit, swap and vote you make with ${name}, with the date and the amount, so a future snapshot can be checked.`,
    `Check ${name}'s announcements once a month for a token, a points conversion or a snapshot date, and keep farming until one is named.`,
  ];
}
