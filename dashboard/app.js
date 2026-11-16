// Token Radar page: renders the board from data.js, filters and sorts it,
// and opens a detail view for each protocol with the model worked out again
// in the page, so what the reader sees is what the board file holds.
//
// The page reads one global, window.TOKEN_RADAR, written beside it as
// data.js. It makes no network request of its own: search, filter, sort and
// paging all run here, on the data already loaded.

(function () {
  "use strict";
  var DATA = window.TOKEN_RADAR;
  var PAGE = 25;

  // -- small helpers -------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function money(n) {
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
    return "$" + Math.round(n);
  }
  function pct(n) {
    if (n === null || n === undefined) return "—";
    var s = (n > 0 ? "+" : "") + n.toFixed(1) + "%";
    return n > 0 ? s : s;
  }
  function ageText(days) {
    if (days >= 365) return (days / 365).toFixed(1) + "y";
    return days + "d";
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // -- the model, again, in the page ---------------------------------------
  // The same radar-2 arithmetic the board was built with, so the detail view
  // can show the value worked out from the row's own figures.
  function growthOf(change) {
    var move = change === null ? 0 : Math.max(-5, Math.min(40, change));
    return 1 + move / 100;
  }
  function ageOf(days) {
    return 0.7 + (Math.min(days, 730) / 730) * 0.3;
  }
  function chainOf(count) {
    var extra = Math.max(0, Math.min(count - 1, 4));
    return 1 + 0.04 * extra;
  }
  function recompute(row) {
    var g = growthOf(row.change_7d);
    var a = ageOf(row.age_days);
    var c = chainOf(row.chains.length);
    return {
      value: Math.round(row.tvl_usd * 0.25 * g * a * c),
      growth: g, age: a, chains: c,
    };
  }

  // Rough gas per farming session, by the chain the plan starts on. These
  // are broad bands, not quotes: gas moves, and the plan says so.
  var GAS = {
    Ethereum: "about $5–20 of gas per session",
    "BNB Chain": "about $0.10–0.50 of gas per session",
    Binance: "about $0.10–0.50 of gas per session",
    Solana: "a few cents of gas per session",
    Base: "a few cents of gas per session",
    Arbitrum: "a few cents of gas per session",
    Optimism: "a few cents of gas per session",
    Polygon: "a few cents of gas per session",
    Avalanche: "about $0.20–1 of gas per session",
    Tron: "about $1–3 of gas per session",
  };
  function gasNote(chain) {
    return GAS[chain] || "gas only, usually under a dollar a session";
  }

  // -- state ---------------------------------------------------------------
  var state = {
    tab: "board",
    q: "",
    cat: "",
    chain: "",
    wl: false,
    sortKey: "rank",
    sortDir: 1,
    page: 1,
  };

  function baseRows() {
    return state.tab === "board" ? DATA.rows : DATA.live;
  }

  function filteredRows() {
    var rows = baseRows().slice();
    var q = state.q.trim().toLowerCase();
    if (q) {
      rows = rows.filter(function (r) {
        return r.name.toLowerCase().indexOf(q) >= 0 || r.slug.indexOf(q) >= 0;
      });
    }
    if (state.tab === "board") {
      if (state.cat) rows = rows.filter(function (r) { return (r.category || "Uncategorised") === state.cat; });
      if (state.chain) rows = rows.filter(function (r) { return r.chains.indexOf(state.chain) >= 0; });
      if (state.wl) rows = rows.filter(function (r) { return r.watchlist; });
    }
    var key = state.sortKey;
    var dir = state.sortDir;
    rows.sort(function (a, b) {
      var av = sortValue(a, key);
      var bv = sortValue(b, key);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return a.slug < b.slug ? -1 : 1;
    });
    return rows;
  }

  function sortValue(row, key) {
    if (key === "name") return row.name.toLowerCase();
    if (key === "chains") return row.chains.length;
    if (key === "rank") return state.tab === "board" ? row.rank : -row.mcap_usd;
    if (key === "implied_value_usd") return state.tab === "board" ? row.implied_value_usd : row.mcap_usd;
    if (key === "change_7d") return row.change_7d === null ? -999 : row.change_7d;
    return row[key] === null || row[key] === undefined ? 0 : row[key];
  }

  // -- rendering -----------------------------------------------------------
  function renderFacts() {
    var totalImplied = DATA.rows.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
    var wl = DATA.rows.filter(function (r) { return r.watchlist; }).length;
    $("facts").innerHTML =
      "<div><dt>Rows</dt><dd>" + DATA.rows.length + "</dd></div>" +
      "<div><dt>Watchlist</dt><dd>" + wl + " covered</dd></div>" +
      "<div><dt>Implied total</dt><dd>" + money(totalImplied) + "</dd></div>" +
      "<div><dt>Snapshot</dt><dd>" + esc(DATA.as_of) + "</dd></div>";
    $("asof").textContent = DATA.as_of;
  }

  function renderSpots() {
    var top = DATA.rows.slice(0, 10);
    $("spots").innerHTML = top.map(function (r) {
      return "<li data-slug=\"" + esc(r.slug) + "\"><span class=\"srank\">#" + r.rank +
        "</span><span class=\"sname\">" + esc(r.name) + "</span><span class=\"sval\"><b>" +
        money(r.implied_value_usd) + "</b> · " + money(r.tvl_usd) + " TVL</span></li>";
    }).join("");
  }

  function renderBars() {
    var byCat = {};
    DATA.rows.forEach(function (r) {
      var c = r.category || "Uncategorised";
      byCat[c] = byCat[c] || { n: 0, v: 0 };
      byCat[c].n += 1;
      byCat[c].v += r.implied_value_usd;
    });
    var cats = Object.keys(byCat).sort(function (a, b) { return byCat[b].v - byCat[a].v; }).slice(0, 8);
    var max = cats.length ? byCat[cats[0]].v : 1;
    $("bars").innerHTML = cats.map(function (c) {
      var b = byCat[c];
      var w = Math.max(2, Math.round((b.v / max) * 100));
      return "<div class=\"bar\" data-cat=\"" + esc(c) + "\"><span>" + esc(c) +
        "</span><span class=\"track\"><span class=\"fill\" style=\"width:" + w + "%\"></span></span>" +
        "<span class=\"n\">" + b.n + " · " + money(b.v) + "</span></div>";
    }).join("");
  }

  function fillSelects() {
    var cat = $("cat");
    DATA.categories.forEach(function (c) {
      var o = document.createElement("option");
      o.value = c; o.textContent = c; cat.appendChild(o);
    });
    var ch = $("chain");
    DATA.chains.forEach(function (c) {
      var o = document.createElement("option");
      o.value = c; o.textContent = c; ch.appendChild(o);
    });
  }

  function rowHtml(r) {
    var change = r.change_7d === null ? "—" :
      "<span class=\"" + (r.change_7d >= 0 ? "up" : "down") + "\">" + pct(r.change_7d) + "</span>";
    var value = state.tab === "board" ? money(r.implied_value_usd) : money(r.mcap_usd);
    var tvl = money(r.tvl_usd);
    var age = state.tab === "board" ? ageText(r.age_days) : "—";
    var rank = state.tab === "board" ? "#" + r.rank : "#" + (DATA.live.indexOf(r) + 1);
    var pill = state.tab === "board" && r.watchlist ? "<span class=\"pill\">Watchlist</span>" : "";
    return "<tr data-slug=\"" + esc(r.slug) + "\"><td>" + rank + "</td><td><b>" + esc(r.name) +
      "</b>" + pill + "<br><span style=\"color:var(--faint)\">" + esc(r.slug) + " · " +
      esc(r.category || "Uncategorised") + "</span></td><td class=\"num\"><b>" + value +
      "</b></td><td class=\"num\">" + tvl + "</td><td class=\"num\">" + change +
      "</td><td class=\"num\">" + age + "</td><td class=\"num\">" + r.chains.length +
      " · " + esc(r.chains[0] || "—") + "</td></tr>";
  }

  function renderTable() {
    var rows = filteredRows();
    var pages = Math.max(1, Math.ceil(rows.length / PAGE));
    if (state.page > pages) state.page = pages;
    var slice = rows.slice((state.page - 1) * PAGE, state.page * PAGE);
    $("rows").innerHTML = slice.map(rowHtml).join("") ||
      "<tr><td colspan=\"7\">Nothing matches those filters.</td></tr>";
    $("pageinfo").textContent = "Page " + state.page + " of " + pages + " · " + rows.length + " rows";
    $("prev").disabled = state.page <= 1;
    $("next").disabled = state.page >= pages;
    $("count").textContent = rows.length + " shown";
    var head = document.querySelector("#board thead tr").children[2];
    head.textContent = state.tab === "board" ? "Implied value" : "Market cap";
    document.querySelectorAll("#board th").forEach(function (th) {
      th.classList.toggle("sorted", th.getAttribute("data-sort") === state.sortKey);
    });
    $("tabnote").textContent = state.tab === "board"
      ? "Pre-token protocols only, ranked by implied value. Click a row for the farm plan."
      : "Tokens that already trade, largest market cap first. They are here for contrast, not as board rows.";
  }

  // -- detail dialog ---------------------------------------------------------
  function openDetail(slug) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) {
      DATA.live.forEach(function (r) { if (r.slug === slug) row = r; });
    }
    if (!row) return;
    var body = $("detail-body");
    if (row.implied_value_usd !== undefined) {
      var re = recompute(row);
      var match = re.value === row.implied_value_usd ? "matches the board" : "differs from the board — check the figures";
      body.innerHTML =
        "<h3 class=\"dtitle\">" + esc(row.name) + "</h3>" +
        "<p class=\"dmeta\">" + esc(row.slug) + " · " + esc(row.category || "Uncategorised") +
        " · rank #" + row.rank + (row.watchlist ? " · Watchlist" : "") + "</p>" +
        "<div class=\"dgrid\">" +
        "<div class=\"dcell\"><div class=\"k\">Implied value</div><div class=\"v\">" + money(row.implied_value_usd) + "</div></div>" +
        "<div class=\"dcell\"><div class=\"k\">TVL</div><div class=\"v\">" + money(row.tvl_usd) + "</div></div>" +
        "<div class=\"dcell\"><div class=\"k\">7-day move</div><div class=\"v\">" + pct(row.change_7d) + "</div></div>" +
        "<div class=\"dcell\"><div class=\"k\">Age, no token</div><div class=\"v\">" + ageText(row.age_days) + "</div></div>" +
        "<div class=\"dcell\"><div class=\"k\">Chains</div><div class=\"v\">" + row.chains.length + "</div></div>" +
        "</div>" +
        "<p class=\"math\">" + money(row.tvl_usd) + " × 0.25 × " + re.growth.toFixed(3) +
        " × " + re.age.toFixed(3) + " × " + re.chains.toFixed(3) + " = " + money(re.value) +
        " — " + match + "</p>" +
        "<h4>How to farm it</h4><ol class=\"steps\">" +
        row.farm_steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") +
        "</ol>" +
        "<p class=\"dplan\">Plan: about four weeks, one session a week, on " + esc(row.chains[0] || "its main chain") +
        " — " + gasNote(row.chains[0] || "") + ". Gas only; no step promises a token.</p>";
    } else {
      body.innerHTML =
        "<h3 class=\"dtitle\">" + esc(row.name) + "</h3>" +
        "<p class=\"dmeta\">" + esc(row.slug) + " · " + esc(row.category || "Uncategorised") +
        " · token already live" + (row.symbol ? " · $" + esc(row.symbol) : "") + "</p>" +
        "<div class=\"dgrid\">" +
        "<div class=\"dcell\"><div class=\"k\">Market cap</div><div class=\"v\">" + money(row.mcap_usd) + "</div></div>" +
        "<div class=\"dcell\"><div class=\"k\">TVL</div><div class=\"v\">" + money(row.tvl_usd) + "</div></div>" +
        "<div class=\"dcell\"><div class=\"k\">7-day move</div><div class=\"v\">" + pct(row.change_7d) + "</div></div>" +
        "<div class=\"dcell\"><div class=\"k\">Chains</div><div class=\"v\">" + row.chains.length + "</div></div>" +
        "</div>" +
        "<p class=\"dplan\">This protocol already has a token, so it is not a board row. It is shown so the board's pre-token values can be weighed against what a live token is actually worth.</p>";
    }
    var dlg = $("detail");
    if (!dlg.open) dlg.showModal();
  }

  // -- events ------------------------------------------------------------------
  function bind() {
    $("q").addEventListener("input", function (e) { state.q = e.target.value; state.page = 1; renderTable(); });
    $("cat").addEventListener("change", function (e) { state.cat = e.target.value; state.page = 1; renderTable(); });
    $("chain").addEventListener("change", function (e) { state.chain = e.target.value; state.page = 1; renderTable(); });
    $("wl").addEventListener("change", function (e) { state.wl = e.target.checked; state.page = 1; renderTable(); });
    $("prev").addEventListener("click", function () { if (state.page > 1) { state.page -= 1; renderTable(); } });
    $("next").addEventListener("click", function () { state.page += 1; renderTable(); });
    $("tab-board").addEventListener("click", function () { setTab("board"); });
    $("tab-live").addEventListener("click", function () { setTab("live"); });
    document.querySelectorAll("#board th").forEach(function (th) {
      th.addEventListener("click", function () {
        var key = th.getAttribute("data-sort");
        if (state.sortKey === key) state.sortDir *= -1;
        else { state.sortKey = key; state.sortDir = key === "name" ? 1 : -1; }
        renderTable();
      });
    });
    $("rows").addEventListener("click", function (e) {
      var tr = e.target.closest("tr[data-slug]");
      if (tr) location.hash = "p=" + tr.getAttribute("data-slug");
    });
    $("spots").addEventListener("click", function (e) {
      var li = e.target.closest("li[data-slug]");
      if (li) location.hash = "p=" + li.getAttribute("data-slug");
    });
    $("bars").addEventListener("click", function (e) {
      var bar = e.target.closest(".bar[data-cat]");
      if (!bar) return;
      setTab("board");
      state.cat = bar.getAttribute("data-cat");
      $("cat").value = state.cat;
      state.page = 1;
      renderTable();
      location.hash = "category=" + encodeURIComponent(state.cat);
      document.getElementById("controls").scrollIntoView();
    });
    $("detail").addEventListener("close", function () {
      if (location.hash.indexOf("#p=") === 0) history.replaceState(null, "", location.pathname);
    });
    window.addEventListener("hashchange", routeHash);
  }

  function setTab(tab) {
    state.tab = tab;
    state.page = 1;
    if (tab === "board") { state.sortKey = "rank"; state.sortDir = 1; }
    else { state.sortKey = "implied_value_usd"; state.sortDir = -1; }
    $("tab-board").classList.toggle("on", tab === "board");
    $("tab-live").classList.toggle("on", tab === "live");
    $("controls").style.display = tab === "board" ? "" : "none";
    renderTable();
  }

  function routeHash() {
    var hash = location.hash.replace(/^#/, "");
    var params = new URLSearchParams(hash);
    var slug = params.get("p");
    var cat = params.get("category");
    if (cat) {
      setTab("board");
      state.cat = cat;
      $("cat").value = cat;
      state.page = 1;
      renderTable();
    }
    if (slug) openDetail(slug);
  }

  renderFacts();
  renderSpots();
  renderBars();
  fillSelects();
  bind();
  renderTable();
  routeHash();
})();
