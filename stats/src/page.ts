// The maintainer's page (GET /): one file, no library and nothing from anywhere else, that
// draws /api/summary with SVG. Agent and model names come from whoever sent them, so they
// only ever go into the page as text (textContent), never as markup.
//
// Colours are fixed per agent, never by rank, so a range where an agent is missing does not
// repaint the others; light and dark each have their own steps.

export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Portals stats</title>
<style>
:root {
  color-scheme: light;
  --plane: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --ring: rgba(11,11,11,0.10);
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300; --s7: #6250d6; --s8: #e34948;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --plane: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10);
    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--plane); color: var(--ink); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1120px; margin: 0 auto; padding: 24px 16px 48px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
h1 { font-size: 20px; margin: 0; }
h2 { font-size: 14px; font-weight: 600; margin: 0 0 8px; }
.range { display: inline-flex; border: 1px solid var(--ring); border-radius: 8px; overflow: hidden; background: var(--surface); }
.range button { font: inherit; color: var(--ink2); background: none; border: 0; padding: 6px 12px; cursor: pointer; }
.range button[aria-pressed="true"] { color: var(--ink); background: var(--grid); font-weight: 600; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(150px, 100%), 1fr)); gap: 12px; margin-bottom: 12px; }
.tile, .card { background: var(--surface); border: 1px solid var(--ring); border-radius: 12px; padding: 14px 16px; }
.tile .label { color: var(--ink2); font-size: 12px; }
.tile .value { font-size: 26px; font-weight: 600; margin-top: 2px; }
.tile .sub { color: var(--muted); font-size: 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(420px, 100%), 1fr)); gap: 12px; margin-bottom: 12px; }
.grid > * { min-width: 0; }
.chart { position: relative; }
.chart svg { display: block; width: 100%; height: 220px; overflow: visible; touch-action: pan-y; }
.mix svg { display: block; width: 100%; }
.axis text, .mix text { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.mix text.name { fill: var(--ink2); }
.mix text.value { fill: var(--ink); }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--ink2); font-size: 12px; margin: 0 0 6px; padding: 0; list-style: none; }
.legend li::before { content: ""; display: inline-block; width: 10px; height: 2px; border-radius: 1px; margin-right: 6px; vertical-align: middle; background: var(--c); }
.tip { position: absolute; pointer-events: none; background: var(--surface); color: var(--ink); border: 1px solid var(--ring); border-radius: 8px;
       padding: 6px 8px; font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.12); white-space: nowrap; display: none; z-index: 2; }
.tip b { display: block; margin-bottom: 2px; }
.tip span { color: var(--ink2); }
.note { color: var(--muted); font-size: 12px; }
details { margin-top: 12px; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; font-size: 12px; }
th, td { text-align: right; padding: 4px 8px; border-bottom: 1px solid var(--grid); }
th:first-child, td:first-child { text-align: left; }
.empty { color: var(--muted); padding: 24px 0; text-align: center; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Portals stats</h1>
    <div class="range" role="group" aria-label="Range">
      <button type="button" data-days="7">7 days</button>
      <button type="button" data-days="30">30 days</button>
      <button type="button" data-days="90">90 days</button>
    </div>
  </header>
  <section class="tiles" id="tiles"></section>
  <section class="grid">
    <div class="card"><h2>Daily active users</h2><div class="chart" id="dau"></div></div>
    <div class="card"><h2>Tokens a day, by agent</h2><div class="chart" id="tokens"></div></div>
    <div class="card"><h2>API-equivalent dollars a day</h2><div class="chart" id="usd"></div></div>
    <div class="card mix"><h2>Agents, by tokens</h2><div id="agents"></div></div>
    <div class="card mix"><h2>Models, by tokens</h2><div id="models"></div></div>
    <div class="card mix"><h2>Hosts by version</h2><div id="versions"></div><h2 style="margin-top:14px">Hosts by OS</h2><div id="os"></div></div>
  </section>
  <p class="note" id="note"></p>
  <details><summary>Table</summary><div id="table"></div></details>
</main>
<script>
"use strict";
var NS = "http://www.w3.org/2000/svg";
var AGENTS = ["claude", "codex", "pi", "droid", "cursor", "hermes", "opencode"];
var LIMIT_SERIES = 7;
var compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
var whole = new Intl.NumberFormat("en");
var dollars = new Intl.NumberFormat("en", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
var dollarsShort = new Intl.NumberFormat("en", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
var data = null;

function el(name, attrs, parent) {
  var node = document.createElementNS(NS, name);
  for (var key in attrs) node.setAttribute(key, attrs[key]);
  if (parent) parent.appendChild(node);
  return node;
}
function html(name, text, parent, cls) {
  var node = document.createElement(name);
  if (text !== undefined && text !== null) node.textContent = text;
  if (cls) node.className = cls;
  if (parent) parent.appendChild(node);
  return node;
}
function colour(agent) {
  var index = AGENTS.indexOf(agent);
  return "var(--s" + (index < 0 ? 8 : index + 1) + ")";
}
function shortDay(day) {
  var parts = day.split("-");
  return Number(parts[2]) + " " + ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(parts[1]) - 1];
}
// The top of the scale: four equal steps, each a round number times a power of ten.
function niceMax(value) {
  if (!(value > 0)) return 4;
  var step = value / 4;
  var power = Math.pow(10, Math.floor(Math.log10(step)));
  var steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  for (var i = 0; i < steps.length; i++) if (steps[i] * power >= step) return 4 * steps[i] * power;
  return 40 * power;
}

// A line chart: days along the bottom, one line a series, values on hover or tap. The
// server's today is still being sent (hosts send finished days), so its stretch is dashed.
function lineChart(box, days, series, format, extra) {
  var open = days.length > 1 && days[days.length - 1] === data.to;
  box.textContent = "";
  if (series.length > 1) {
    var legend = html("ul", null, box, "legend");
    series.forEach(function (s) { var item = html("li", s.name, legend); item.style.setProperty("--c", s.colour); });
  }
  var width = Math.max(box.clientWidth, 280), height = 220;
  var left = 48, right = 8, top = 8, bottom = 22;
  var svg = el("svg", { viewBox: "0 0 " + width + " " + height, role: "img" }, box);
  var max = 0;
  series.forEach(function (s) { s.values.forEach(function (v) { if (v > max) max = v; }); });
  max = niceMax(max);
  var plotW = width - left - right, plotH = height - top - bottom;
  var x = function (i) { return left + (days.length === 1 ? plotW / 2 : (i * plotW) / (days.length - 1)); };
  var y = function (v) { return top + plotH - (v / max) * plotH; };
  var axis = el("g", { class: "axis" }, svg);
  for (var t = 0; t <= 4; t++) {
    var value = (max * t) / 4;
    var line = el("line", { x1: left, x2: width - right, y1: y(value), y2: y(value) }, axis);
    line.style.stroke = t === 0 ? "var(--axis)" : "var(--grid)";
    var label = el("text", { x: left - 6, y: y(value) + 4, "text-anchor": "end" }, axis);
    label.textContent = format.short(value);
  }
  var ticks = Math.min(days.length, Math.max(2, Math.floor(plotW / 70)));
  for (var k = 0; k < ticks; k++) {
    var index = ticks === 1 ? 0 : Math.round((k * (days.length - 1)) / (ticks - 1));
    var dayLabel = el("text", { x: x(index), y: height - 6, "text-anchor": k === 0 ? "start" : k === ticks - 1 ? "end" : "middle" }, axis);
    dayLabel.textContent = shortDay(days[index]);
  }
  var point = function (v, i) { return x(i).toFixed(1) + " " + y(v).toFixed(1); };
  series.forEach(function (s) {
    var done = open ? s.values.slice(0, -1) : s.values;
    var d = done.map(function (v, i) { return (i ? "L" : "M") + point(v, i); }).join(" ");
    var path = el("path", { d: d, fill: "none", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    path.style.stroke = s.colour;
    if (!open) return;
    var n = s.values.length - 1;
    var rest = el("path", { d: "M" + point(s.values[n - 1], n - 1) + " L" + point(s.values[n], n), fill: "none", "stroke-width": 2, "stroke-dasharray": "3 4", opacity: 0.6 }, svg);
    rest.style.stroke = s.colour;
  });
  var cross = el("line", { y1: top, y2: top + plotH, visibility: "hidden" }, svg);
  cross.style.stroke = "var(--axis)";
  var dots = series.map(function (s) {
    var dot = el("circle", { r: 4, visibility: "hidden", "stroke-width": 2 }, svg);
    dot.style.fill = s.colour; dot.style.stroke = "var(--surface)";
    return dot;
  });
  var tip = html("div", null, box, "tip");
  var hit = el("rect", { x: left, y: top, width: plotW, height: plotH, fill: "transparent" }, svg);
  function show(event) {
    var rect = svg.getBoundingClientRect();
    var px = ((event.clientX - rect.left) / rect.width) * width;
    var i = days.length === 1 ? 0 : Math.round(((px - left) / plotW) * (days.length - 1));
    i = Math.max(0, Math.min(days.length - 1, i));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
    tip.textContent = "";
    html("b", days[i] + (open && i === days.length - 1 ? " (so far)" : ""), tip);
    series.forEach(function (s, n) {
      dots[n].setAttribute("cx", x(i)); dots[n].setAttribute("cy", y(s.values[i])); dots[n].setAttribute("visibility", "visible");
      var row = html("div", null, tip);
      html("span", s.name + ": ", row);
      row.appendChild(document.createTextNode(format.long(s.values[i])));
    });
    (extra ? extra(i) : []).forEach(function (pair) {
      var row = html("div", null, tip);
      html("span", pair[0] + ": ", row);
      row.appendChild(document.createTextNode(pair[1]));
    });
    tip.style.display = "block";
    var boxRect = box.getBoundingClientRect();
    var at = (x(i) / width) * rect.width + (rect.left - boxRect.left);
    var tipW = tip.offsetWidth;
    tip.style.left = Math.max(0, Math.min(box.clientWidth - tipW, at + 12 > box.clientWidth - tipW ? at - tipW - 12 : at + 12)) + "px";
    tip.style.top = (rect.top - boxRect.top + 8) + "px";
  }
  function hide() {
    tip.style.display = "none"; cross.setAttribute("visibility", "hidden");
    dots.forEach(function (dot) { dot.setAttribute("visibility", "hidden"); });
  }
  hit.addEventListener("pointermove", show);
  hit.addEventListener("pointerdown", show);
  hit.addEventListener("pointerleave", hide);
}

// Horizontal bars, one a row, with the value written at the end.
function bars(box, rows, value, label, detail) {
  box.textContent = "";
  if (!rows.length) { html("div", "Nothing in this range.", box, "empty"); return; }
  var width = Math.max(box.clientWidth, 280), rowH = 22, nameW = Math.min(170, width * 0.38), valueW = 64;
  var svg = el("svg", { viewBox: "0 0 " + width + " " + rows.length * rowH, height: rows.length * rowH }, box);
  var max = Math.max.apply(null, rows.map(value)) || 1;
  rows.forEach(function (row, i) {
    var g = el("g", {}, svg);
    var name = el("text", { x: 0, y: i * rowH + 15, class: "name" }, g);
    name.textContent = row.name.length > 26 ? row.name.slice(0, 25) + "\\u2026" : row.name;
    var w = Math.max(2, ((width - nameW - valueW) * value(row)) / max);
    var bar = el("rect", { x: nameW, y: i * rowH + 5, width: w, height: 12, rx: 2 }, g);
    bar.style.fill = row.colour || "var(--s1)";
    var text = el("text", { x: nameW + w + 6, y: i * rowH + 15, class: "value" }, g);
    text.textContent = label(row);
    var title = el("title", {}, g);
    title.textContent = row.name + ": " + detail(row);
  });
}

function tile(parent, label, value, sub) {
  var box = html("div", null, parent, "tile");
  html("div", label, box, "label");
  html("div", value, box, "value");
  if (sub) html("div", sub, box, "sub");
}

function draw() {
  if (!data) return;
  var days = data.days.map(function (d) { return d.day; });
  var last = data.days[data.days.length - 1];
  var before = data.days[data.days.length - 2] || { dau: 0, tokens: { total: 0 }, usd: 0 };
  var tiles = document.getElementById("tiles");
  tiles.textContent = "";
  tile(tiles, "Active users today", whole.format(last.dau), whole.format(last.hosts) + " hosts so far");
  tile(tiles, "Active users yesterday", whole.format(before.dau), whole.format(before.hosts || 0) + " hosts");
  tile(tiles, "Weekly active users", whole.format(last.wau), "7 days to " + shortDay(last.day));
  tile(tiles, "Monthly active users", whole.format(last.mau), "30 days to " + shortDay(last.day));
  tile(tiles, "Tokens yesterday", compact.format(before.tokens.total), compact.format(data.totals.tokens.total) + " in " + days.length + " days");
  tile(tiles, "Dollars yesterday", dollars.format(before.usd), dollars.format(data.totals.usd) + " in " + days.length + " days");

  var count = { short: function (v) { return compact.format(v); }, long: function (v) { return whole.format(v); } };
  lineChart(document.getElementById("dau"), days, [{ name: "Active users", colour: "var(--s1)", values: data.days.map(function (d) { return d.dau; }) }], count, function (i) {
    var d = data.days[i];
    return [["Hosts", whole.format(d.hosts)], ["Weekly", whole.format(d.wau)], ["Monthly", whole.format(d.mau)], ["Turns", whole.format(d.turns)],
            ["Devices", "iPhone " + d.devices.iphone + ", iPad " + d.devices.ipad + ", Mac " + d.devices.mac + ", other " + d.devices.other]];
  });

  // Past the first seven agents the rest are one line, "Other", in the last colour.
  var shown = data.agents.slice(0, LIMIT_SERIES);
  var rest = data.agents.slice(LIMIT_SERIES);
  var lines = shown.map(function (agent) {
    return { name: agent, colour: colour(agent), values: data.days.map(function (d) { return d.by_agent[agent] || 0; }) };
  });
  if (rest.length) lines.push({ name: "Other", colour: "var(--s8)", values: data.days.map(function (d) { return rest.reduce(function (sum, a) { return sum + (d.by_agent[a] || 0); }, 0); }) });
  var tokenBox = document.getElementById("tokens");
  if (lines.length) lineChart(tokenBox, days, lines, { short: function (v) { return compact.format(v); }, long: function (v) { return compact.format(v); } });
  else { tokenBox.textContent = ""; html("div", "No tokens in this range.", tokenBox, "empty"); }

  lineChart(document.getElementById("usd"), days, [{ name: "Dollars", colour: "var(--s2)", values: data.days.map(function (d) { return d.usd; }) }],
    { short: function (v) { return dollarsShort.format(v); }, long: function (v) { return dollars.format(v); } }, function (i) {
      var t = data.days[i].tokens;
      return [["Input", compact.format(t.input)], ["Output", compact.format(t.output)], ["Cache read", compact.format(t.cache_read)], ["Cache write", compact.format(t.cache_write)]];
    });

  var mixDetail = function (row) { return whole.format(row.tokens) + " tokens, " + dollars.format(row.usd) + ", " + whole.format(row.requests) + " requests, " + whole.format(row.owners) + " users"; };
  bars(document.getElementById("agents"), data.mix.agents.map(function (row) { return Object.assign({ colour: colour(row.name) }, row); }),
    function (row) { return row.tokens; }, function (row) { return compact.format(row.tokens); }, mixDetail);
  var models = data.mix.models.slice();
  if (data.mix.other_models.count) models.push({ name: data.mix.other_models.count + " more models", tokens: data.mix.other_models.tokens, usd: data.mix.other_models.usd, requests: 0, owners: 0 });
  bars(document.getElementById("models"), models, function (row) { return row.tokens; }, function (row) { return compact.format(row.tokens); }, mixDetail);
  var hostDetail = function (row) { return whole.format(row.hosts) + " hosts"; };
  bars(document.getElementById("versions"), data.mix.versions, function (row) { return row.hosts; }, function (row) { return whole.format(row.hosts); }, hostDetail);
  bars(document.getElementById("os"), data.mix.os, function (row) { return row.hosts; }, function (row) { return whole.format(row.hosts); }, hostDetail);

  document.getElementById("note").textContent = whole.format(data.totals.owners) + " users and " + whole.format(data.totals.hosts) +
    " hosts sent totals from " + data.from + " to " + data.to + " (UTC days). Dollars are API-equivalent estimates at each host's prices, not anyone's bill.";

  var table = html("table", null, null);
  var head = html("tr", null, html("thead", null, table));
  ["Day", "Users", "Weekly", "Monthly", "Hosts", "Turns", "Tokens", "Dollars"].forEach(function (name) { html("th", name, head); });
  var body = html("tbody", null, table);
  data.days.slice().reverse().forEach(function (d) {
    var row = html("tr", null, body);
    [d.day, whole.format(d.dau), whole.format(d.wau), whole.format(d.mau), whole.format(d.hosts), whole.format(d.turns), whole.format(d.tokens.total), dollars.format(d.usd)]
      .forEach(function (cell) { html("td", cell, row); });
  });
  var tableBox = document.getElementById("table");
  tableBox.textContent = "";
  tableBox.appendChild(table);
}

function load(days) {
  document.querySelectorAll(".range button").forEach(function (button) {
    button.setAttribute("aria-pressed", String(button.dataset.days === String(days)));
  });
  fetch("/api/summary?days=" + days, { credentials: "same-origin" })
    .then(function (response) { if (!response.ok) throw new Error(String(response.status)); return response.json(); })
    .then(function (summary) { data = summary; draw(); })
    .catch(function (error) { document.getElementById("note").textContent = "Could not load the totals (" + error.message + ")."; });
}

document.querySelectorAll(".range button").forEach(function (button) {
  button.addEventListener("click", function () { load(Number(button.dataset.days)); });
});
var resizing = 0;
window.addEventListener("resize", function () { clearTimeout(resizing); resizing = setTimeout(draw, 150); });
load(30);
</script>
</body>
</html>
`;
