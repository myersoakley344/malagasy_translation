// Conversation client for GitHub Pages. No build step.
const S = {
  german: {
    you: "Du", other: "Malagasy", speaking: "spricht…",
    translating: "übersetzt…", delayed: "Übersetzung verzögert…",
    failed: "Übersetzung fehlgeschlagen", connecting: "verbinde…",
    offline: "getrennt", replaced: "In einem anderen Tab geöffnet.",
    simulate: "Als Sprache simulieren", checking: "prüfe…",
  },
  malagasy: {
    you: "Ianao", other: "Alemana", speaking: "miteny…",
    translating: "mandika…", delayed: "mbola mandika…",
    failed: "tsy nahomby ny fandikana", connecting: "mifandray…",
    offline: "tapaka", replaced: "Nosokafana tany amin'ny toerana hafa.",
    simulate: "Alefa", checking: "…",
  },
};

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const debug = params.has("debug");
for (const key of ["server", "code"]) {
  if (params.get(key)) localStorage.setItem(key, params.get(key));
}
if (params.has("code")) {  // keep the code out of the address bar
  history.replaceState(null, "", location.pathname + (debug ? "?debug=1" : ""));
}

let server = localStorage.getItem("server");
let code = localStorage.getItem("code");
let ws = null, role = null, t = S.german;
let retry = 0, retryTimer = null, pingTimer = null, lastPong = 0;
let stopped = false, panelsReady = false;

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function showSetup(error = "") {
  $("app").hidden = true;
  $("setup").hidden = false;
  $("setup-server").value = server || "";
  $("setup-code").value = code || "";
  $("setup-error").textContent = error;
}

$("setup-go").onclick = () => {
  server = $("setup-server").value.trim();
  code = $("setup-code").value.trim();
  localStorage.setItem("server", server);
  localStorage.setItem("code", code);
  $("setup").hidden = true;
  stopped = false;
  connect();
};

function setStatus(state) {
  $("status-dot").className = state;
  $("status-text").textContent = state === "online" ? "" : t[state] || "";
}

function connect() {
  clearTimeout(retryTimer);
  if (stopped || (ws && ws.readyState <= WebSocket.OPEN)) return;
  setStatus("connecting");
  try {
    ws = new WebSocket(server);
  } catch (e) {
    return showSetup(String(e));
  }
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", code }));
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = (e) => {
    clearInterval(pingTimer);
    setStatus("offline");
    if (e.code === 4001) { stopped = true; return showSetup("Code?"); }
    if (e.code === 4000) { stopped = true; return banner(t.replaced); }
    retryTimer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
  };
}

function heartbeat() {
  if (Date.now() - lastPong > 50000) return ws.close();  // dead link
  send({ type: "ping" });
}

function banner(text) {
  $("banner").textContent = text;
  $("banner").hidden = !text;
}

function handle(ev) {
  switch (ev.type) {
    case "welcome":
      retry = 0;
      role = ev.role;
      t = S[role];
      document.body.className = role;
      document.documentElement.lang = role === "malagasy" ? "mg" : "de";
      $("setup").hidden = true;
      $("app").hidden = false;
      banner("");
      $("chat").replaceChildren();
      setupPanels(ev);
      applySettings(ev);
      ev.messages.forEach(render);
      setPresence(ev.online);
      setStatus("online");
      lastPong = Date.now();
      clearInterval(pingTimer);
      pingTimer = setInterval(heartbeat, 20000);
      scrollToBottom();
      break;
    case "message": render(ev.message); break;
    case "settings": applySettings(ev); break;
    case "provider_status": providerStatus(ev); break;
    case "presence": setPresence(ev.online); break;
    case "pong": lastPong = Date.now(); break;
    case "error": console.warn(ev.message); break;
  }
}

function scrollToBottom() {
  const chat = $("chat");
  chat.scrollTop = chat.scrollHeight;
}

function render(m) {
  const chat = $("chat");
  const atBottom =
    chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  let el = document.getElementById(m.id);
  if (!el) {
    el = document.createElement("div");
    el.id = m.id;
    el.dataset.seq = m.seq;
    el.className = "msg " + (m.speaker === role ? "mine" : "theirs");
    for (const cls of ["who", "text", "status", "meta"]) {
      const d = document.createElement("div");
      d.className = cls;
      el.append(d);
    }
    el.querySelector(".who").textContent =
      m.speaker === role ? t.you : t.other;
    const next = [...chat.children].find((c) => +c.dataset.seq > m.seq);
    chat.insertBefore(el, next || null);
  }
  el.hidden = m.state === "empty";
  const lang = role === "malagasy" ? "mg" : "de";
  const parts = m.segments.map((s) =>
    s.failed ? (m.speaker === role ? "⚠ " + s.raw : "⚠") : s[lang]);
  el.querySelector(".text").textContent = parts.filter(Boolean).join(" ");
  const failed = m.segments.some((s) => s.failed);
  const state = { speaking: t.speaking, translating: t.translating,
                  delayed: t.delayed }[m.state] || "";
  el.querySelector(".status").textContent =
    [state, failed ? t.failed : ""].filter(Boolean).join(" · ");
  el.classList.toggle("delayed", m.state === "delayed");
  if (role === "german" || debug) {
    el.querySelector(".meta").textContent = m.segments.length
      ? "lag " + m.segments.map((s) => s.lag.toFixed(1)).join(" / ") + " s"
      : "";
  }
  if (atBottom) scrollToBottom();
}

function setPresence(online) {
  const other = role === "german" ? "malagasy" : "german";
  const on = online.includes(other);
  $("partner").textContent = t.other + (on ? " ●" : " ○");
  $("partner").className = on ? "on" : "off";
}

function setupPanels(ev) {
  $("settings").hidden = role !== "german";
  $("debug").hidden = !(role === "german" || debug);
  $("sim-go").textContent = t.simulate;
  $("fixture").replaceChildren(...ev.fixtures.map((f) => new Option(f, f)));
  if (panelsReady) return;
  panelsReady = true;
  $("provider").onchange = (e) =>
    send({ type: "set_provider", provider: e.target.value });
  $("mode").onchange = (e) => send({ type: "set_mode", mode: e.target.value });
  $("play").onclick = () =>
    send({ type: "play_fixture", name: $("fixture").value });
  $("sim-go").onclick = () => {
    const text = $("sim-text").value.trim();
    if (!text) return;
    send({ type: "simulate", text });
    $("sim-text").value = "";
  };
}

function applySettings(ev) {
  if (role !== "german") return;
  $("provider").replaceChildren(...ev.providers.map((p) =>
    new Option(p.label + (p.available ? "" : " (kein Key)"), p.id)));
  $("provider").value = ev.provider;
  $("mode").value = ev.mode;
  $("provider-status").textContent = "";
}

function providerStatus(ev) {
  if (role !== "german") return;
  if (ev.status === "checking") {
    $("provider-status").textContent = t.checking;
  } else if (ev.status === "failed") {
    $("provider-status").textContent = `${ev.provider}: ${ev.error}`;
    $("provider").value = ev.current;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && server && code &&
      (!ws || ws.readyState === WebSocket.CLOSED)) {
    retry = 0;
    connect();
  }
});

if (server && code) connect(); else showSetup();
