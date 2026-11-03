// The fake agent's visuals (`visual`, or `widget` as they were called at first, in the
// prompt): replies with a ```portals-visual block in them (`portals guide visuals`), for
// trying how the app draws one without a real agent. Words after it pick one:
//   (none)    a savings calculator, sliders and bars drawn with CSS
//   cdn       a line chart drawn with Chart.js from jsDelivr
//   tall      a list taller than the card, which scrolls inside it
//   escape    a page that tries what the app blocks (the network, WebRTC, pop-ups,
//             frames, navigation) and lists what went through
//   many      five visuals in one reply
//   unclosed  a reply that ends inside its visual

/** The reply `prompt` asks for, or null when it asks for no visual. */
export function visualReply(prompt: string): string | null {
  const wants = (word: string) => new RegExp(`\\b${word}`, "i").test(prompt);
  if (!wants("visual") && !wants("widget")) return null;
  if (wants("unclosed")) return `Here is a visual that never ends:\n\n\`\`\`portals-visual title="Cut short"\n<div style="padding: 8px">Half a wid`;
  if (wants("many")) {
    return [
      "Five visuals in one reply.",
      fence("Savings", savings),
      fence("Latency this week", chart),
      "Between the second and the third, some text.",
      fence("Tall list", tall),
      fence("Savings again", savings.replace('value="500"', 'value="900"')),
      fence("Latency again", chart),
      "That is all five.",
    ].join("\n\n");
  }
  if (wants("cdn")) return `Here is last week's latency, drawn with Chart.js:\n\n${fence("Latency this week", chart)}\n\nThe weekend is slower than the weekdays.`;
  if (wants("tall")) return `A long list:\n\n${fence("Tall list", tall)}\n\nIt scrolls inside its card.`;
  if (wants("escape")) return `This page tries everything a visual may not do:\n\n${fence("Sandbox check", escape)}\n\nEvery line should say blocked.`;
  return `Move the sliders to see how savings grow:\n\n${fence("Savings over ten years", savings)}\n\nA higher rate matters more in the later years.`;
}

function fence(title: string, html: string): string {
  return `\`\`\`portals-visual title="${title}"\n${html.trim()}\n\`\`\``;
}

const savings = `
<div class="calc">
  <label>Monthly <input id="monthly" type="range" min="50" max="2000" step="50" value="500"><output id="monthlyOut"></output></label>
  <label>Rate <input id="rate" type="range" min="0" max="12" step="0.5" value="5"><output id="rateOut"></output></label>
  <div class="bars" id="bars"></div>
  <p class="total">After ten years: <strong id="total"></strong></p>
</div>
<style>
  .calc label { display: grid; grid-template-columns: 5em 1fr 4.5em; align-items: center; gap: 8px; margin: 4px 0; color: var(--portals-text-2); }
  .calc input { width: 100%; accent-color: var(--portals-accent); }
  .calc output { text-align: right; color: var(--portals-text); font-variant-numeric: tabular-nums; }
  .bars { display: flex; align-items: flex-end; gap: 4px; height: 140px; margin: 12px 0 4px; padding-bottom: 4px; border-bottom: 1px solid var(--portals-line); }
  .bars div { flex: 1; border-radius: 4px 4px 0 0; background: var(--portals-series-1); }
  .bars div:nth-child(even) { background: var(--portals-series-2); }
  .total { margin: 8px 0 0; }
</style>
<script>
  const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
  function draw() {
    const monthly = +document.getElementById("monthly").value;
    const rate = +document.getElementById("rate").value / 100;
    document.getElementById("monthlyOut").textContent = money(monthly);
    document.getElementById("rateOut").textContent = (rate * 100).toFixed(1) + "%";
    let total = 0;
    const years = [];
    for (let year = 1; year <= 10; year++) {
      for (let month = 0; month < 12; month++) total = total * (1 + rate / 12) + monthly;
      years.push(total);
    }
    document.getElementById("bars").innerHTML = years.map((t) => \`<div style="height: \${(t / total) * 100}%"></div>\`).join("");
    document.getElementById("total").textContent = money(total);
  }
  for (const input of document.querySelectorAll(".calc input")) input.addEventListener("input", draw);
  draw();
</script>`;

const chart = `
<canvas></canvas>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<script>
  (() => {
    const css = getComputedStyle(document.documentElement);
    const color = (name) => css.getPropertyValue(name).trim();
    Chart.defaults.color = color("--portals-text-2");
    Chart.defaults.borderColor = color("--portals-line");
    Chart.defaults.font.family = color("--portals-font");
    const line = (label, data, series) => ({ label, data, borderColor: color(series), backgroundColor: color(series), tension: 0.3 });
    new Chart(document.querySelector("canvas"), {
      type: "line",
      data: {
        labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
        datasets: [line("p50 (ms)", [120, 132, 101, 134, 90, 230, 210], "--portals-series-1"), line("p95 (ms)", [220, 182, 191, 234, 290, 330, 310], "--portals-series-2")],
      },
      options: { aspectRatio: 2, interaction: { mode: "index", intersect: false } },
    });
  })();
</script>`;

const tall = `
<ol class="tall"></ol>
<style>.tall li { padding: 6px 0; border-bottom: 1px solid var(--portals-line); }</style>
<script>
  document.querySelector(".tall").innerHTML = Array.from({ length: 40 }, (_, i) => \`<li>Row \${i + 1}</li>\`).join("");
</script>`;

const escape = `
<ul id="tries"></ul>
<style>#tries { margin: 0; padding-left: 1.2em; } #tries li { margin: 4px 0; }</style>
<script>
  const tries = document.getElementById("tries");
  const say = (what, result) => { const li = document.createElement("li"); li.textContent = what + ": " + result; tries.appendChild(li); };
  const within = (ms, what, attempt) => {
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; say(what, result); } };
    try { attempt(done); } catch (error) { done("blocked"); }
    setTimeout(() => done("blocked (no answer)"), ms);
  };
  within(4000, "fetch from example.com", (done) => fetch("https://example.com/").then(() => done("WENT THROUGH"), () => done("blocked")));
  within(4000, "fetch from jsDelivr", (done) => fetch("https://cdn.jsdelivr.net/npm/chart.js@4/package.json").then(() => done("WENT THROUGH"), () => done("blocked")));
  within(4000, "XMLHttpRequest", (done) => { const x = new XMLHttpRequest(); x.onload = () => done("WENT THROUGH"); x.onerror = () => done("blocked"); x.open("GET", "https://example.com/"); x.send(); });
  within(4000, "WebSocket", (done) => { const s = new WebSocket("wss://echo.websocket.org/"); s.onopen = () => done("WENT THROUGH"); s.onerror = () => done("blocked"); });
  within(4000, "image from apple.com", (done) => { const i = new Image(); i.onload = () => done("WENT THROUGH"); i.onerror = () => done("blocked"); i.src = "https://www.apple.com/favicon.ico"; });
  within(4000, "script from another host", (done) => { const s = document.createElement("script"); s.onload = () => done("WENT THROUGH"); s.onerror = () => done("blocked"); s.src = "https://code.jquery.com/jquery-3.7.1.min.js"; document.head.appendChild(s); });
  within(4000, "frame", (done) => { const f = document.createElement("iframe"); f.style.display = "none"; f.src = "https://example.com/"; f.onload = () => { try { done(f.contentDocument && f.contentDocument.body && f.contentDocument.body.innerHTML ? "WENT THROUGH" : "blocked"); } catch (error) { done("blocked"); } }; document.body.appendChild(f); });
  within(1000, "WebRTC (STUN, TURN)", (done) => done(typeof RTCPeerConnection === "function" || typeof webkitRTCPeerConnection === "function" ? "WENT THROUGH" : "blocked"));
  within(1000, "WebRTC in a frame", (done) => { const f = document.createElement("iframe"); f.style.display = "none"; document.body.appendChild(f); done(typeof f.contentWindow.RTCPeerConnection === "function" ? "WENT THROUGH" : "blocked"); });
  within(1000, "pop-up", (done) => done(window.open("https://example.com/") ? "WENT THROUGH" : "blocked"));
  within(1000, "alert", (done) => { const before = Date.now(); alert("If you see this, alert went through."); done(Date.now() - before > 500 ? "WENT THROUGH" : "blocked"); });
  setTimeout(() => { location.href = "https://example.com/"; }, 1500);
  setTimeout(() => say("navigation", "blocked (this page is still here)"), 3000);
</script>`;
