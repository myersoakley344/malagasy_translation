// Conversation client for GitHub Pages. No build step.
import { Mic, Player, keepAwake } from "./audio.js";

const S = {
  german: {
    you: "Du", other: "Malagasy", speaking: "spricht…",
    translating: "übersetzt…", delayed: "Übersetzung verzögert…",
    failed: "Übersetzung fehlgeschlagen", connecting: "verbinde…",
    offline: "getrennt", replaced: "In einem anderen Tab geöffnet.",
    simulate: "Als Sprache simulieren", checking: "prüfe…",
    talk: "🎤 Sprechen", stop: "■ Fertig",
    asrLoading: "Spracherkennung lädt…",
    micError: "Mikrofon nicht verfügbar:",
    soundOn: "🔊 Ton an", soundOff: "🔇 Ton aus",
  },
  malagasy: {
    you: "Ianao", other: "Alemana", speaking: "miteny…",
    translating: "mandika…", delayed: "mbola mandika…",
    failed: "tsy nahomby ny fandikana", connecting: "mifandray…",
    offline: "tapaka", replaced: "Nosokafana tany amin'ny toerana hafa.",
    simulate: "Alefa", checking: "…",
    talk: "🎤 Miteny", stop: "■ Vita", asrLoading: "Miandrasa kely…",
    micError: "Tsy mandeha ny mikrô:", soundOn: "", soundOff: "",
  },
};

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const debug = params.has("debug");
if (params.has("reset")) {
  localStorage.clear();
  sessionStorage.clear();
}
for (const key of ["server", "code"]) {
  const v = params.get(key);
  if (v) {
    localStorage.setItem(key, v);    // default for new tabs
    sessionStorage.setItem(key, v);  // this tab only
  }
}
if (params.has("code")) {  // keep the code out of the address bar
  history.replaceState(null, "",
                       location.pathname + (debug ? "?debug=1" : ""));
}

const stored = (k) => sessionStorage.getItem(k) || localStorage.getItem(k);
let server = stored("server");
let code = stored("code");
let ws = null, role = null, t = S.german;
let retry = 0, retryTimer = null, pingTimer = null, lastPong = 0;
let stopped = false, panelsReady = false, joined = false, inRoom = false;
let asrStatus = "off", errorTimer = null;
const costs = new Map();  // message id -> LLM cost in USD (German view)

const mic = new Mic(onFrame);
const player = new Player();
let talking = false, opening = false, tailTimer = null, preroll = [];
let soundWanted = localStorage.getItem("sound") !== "off";

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function sendBinary(buf) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf);
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
  for (const store of [localStorage, sessionStorage]) {
    store.setItem("server", server);
    store.setItem("code", code);
  }
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
  $("setup").hidden = true;
  $("app").hidden = false;
  setStatus("connecting");
  try {
    ws = new WebSocket(server);
  } catch (e) {
    return showSetup("Ungültige Server-Adresse: " + e.message);
  }
  ws.binaryType = "arraybuffer";
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", code }));
  ws.onmessage = (e) => {
    if (typeof e.data === "string") handle(JSON.parse(e.data));
    else player.play(e.data);  // relayed Malagasy audio
  };
  ws.onclose = (e) => {
    clearInterval(pingTimer);
    inRoom = false;
    abortTurn();
    setStatus("offline");
    if (e.code === 4001) { stopped = true; return showSetup("Code?"); }
    if (e.code === 4000) { stopped = true; return banner(t.replaced); }
    if (!joined && retry >= 1) {
      banner("Keine Verbindung zu " + server + " (Code " + e.code +
             "). Neuer Versuch läuft… Adresse falsch? Seite mit ?reset öffnen.");
    }
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

function showError(text) {
  console.warn(text);
  banner(text);
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => banner(""), 8000);
}

function handle(ev) {
  switch (ev.type) {
    case "welcome":
      retry = 0;
      joined = true;
      inRoom = true;
      role = ev.role;
      t = S[role];
      document.body.className = role;
      document.documentElement.lang = role === "malagasy" ? "mg" : "de";
      $("setup").hidden = true;
      $("app").hidden = false;
      banner("");
      $("chat").replaceChildren();
      costs.clear();
      setupPanels(ev);
      applySettings(ev);
      ev.messages.forEach(render);
      updateTotal();
      setPresence(ev.online);
      setStatus("online");
      lastPong = Date.now();
      clearInterval(pingTimer);
      pingTimer = setInterval(heartbeat, 20000);
      scrollToBottom();
      keepAwake();
      break;
    case "message": render(ev.message); break;
    case "settings": applySettings(ev); break;
    case "provider_status": providerStatus(ev); break;
    case "presence": setPresence(ev.online); break;
    case "pong": lastPong = Date.now(); break;
    case "audio_start": player.reset(); break;
    case "turn_rejected": abortTurn(); showError(ev.reason); break;
    case "error": showError(ev.message); break;
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
    const bits = [];
    if (m.segments.length) {
      bits.push("lag " +
                m.segments.map((s) => s.lag.toFixed(1)).join(" / ") + " s");
    }
    if (role === "german" && m.cost) bits.push(m.cost.toFixed(4) + " USD");
    el.querySelector(".meta").textContent = bits.join(" · ");
  }
  if (role === "german") {
    costs.set(m.id, m.cost || 0);
    updateTotal();
  }
  if (atBottom) scrollToBottom();
}

function updateTotal() {
  if (role !== "german") return;
  let el = $("cost-total");
  if (!el) {
    el = document.createElement("span");
    el.id = "cost-total";
    $("settings").append(el);
  }
  let sum = 0;
  for (const c of costs.values()) sum += c;
  el.textContent = "LLM gesamt " + sum.toFixed(3) + " USD";
}

function setPresence(online) {
  const other = role === "german" ? "malagasy" : "german";
  const on = online.includes(other);
  $("partner").textContent = t.other + (on ? " ●" : " ○");
  $("partner").className = on ? "on" : "off";
}

function setupPanels(ev) {
  const german = role === "german";
  $("settings").hidden = !german;
  $("debug").hidden = !(german || debug);
  $("sim-go").textContent = t.simulate;
  $("fixture").replaceChildren(...ev.fixtures.map((f) => new Option(f, f)));
  updateSound();
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
  $("talk").onclick = toggleTalk;
  $("sound").onclick = toggleSound;
}

function applySettings(ev) {
  asrStatus = ev.asr || "off";
  updateTalk();
  if (role !== "german") return;
  $("provider").replaceChildren(...ev.providers.map((p) =>
    new Option(p.label + (p.available ? "" : " (kein Key)"), p.id)));
  $("provider").value = ev.provider;
  $("mode").value = ev.mode;
  $("provider-status").textContent = "";
  $("asr-status").textContent = "ASR: " + asrStatus;
}

function providerStatus(ev) {
  if (role !== "german") return;
  $("provider-status").className = ev.status;
  if (ev.status === "checking") {
    $("provider-status").textContent = t.checking;
  } else if (ev.status === "failed") {
    $("provider-status").textContent = `${ev.provider}: ${ev.error}`;
    $("provider").value = ev.current;
  }
}

// ---- talking ----------------------------------------------------------
function canTalk() {
  return inRoom && ws && ws.readyState === WebSocket.OPEN &&
         asrStatus === "ready";
}

function onFrame(buf) {
  if (talking) {
    sendBinary(buf);
  } else {  // keep the last 400 ms so the first word is not cut off
    preroll.push(buf);
    if (preroll.length > 2) preroll.shift();
  }
}

function updateTalk() {
  const b = $("talk");
  const live = talking && !tailTimer;
  const ready = canTalk();
  b.disabled = !live && (!ready || opening);
  b.textContent = live ? t.stop
    : !ready && asrStatus === "loading" ? t.asrLoading : t.talk;
  b.classList.toggle("live", live);
}

async function startTalking() {
  if (tailTimer) finishTurn();
  if (talking || opening || !canTalk()) return;
  opening = true;
  updateTalk();
  try {
    await mic.open();
  } catch (e) {
    showError(t.micError + " " + (e.message || e.name));
    return;
  } finally {
    opening = false;
    updateTalk();
  }
  if (!canTalk()) return;  // connection dropped during the prompt
  if (role === "german" && soundWanted && !player.enabled) {
    player.enable().then(updateSound, () => {});
  }
  keepAwake();
  const pre = preroll.splice(0);
  send({ type: "turn_start", preroll_ms: pre.length * 200 });
  pre.forEach(sendBinary);
  talking = true;
  updateTalk();
}

function stopTalking() {
  if (!talking || tailTimer) return;
  tailTimer = setTimeout(finishTurn, 400);  // flush the last words
  updateTalk();
}

function finishTurn() {
  clearTimeout(tailTimer);
  tailTimer = null;
  if (talking) {
    talking = false;
    send({ type: "turn_end" });
  }
  updateTalk();
}

function abortTurn() {
  clearTimeout(tailTimer);
  tailTimer = null;
  talking = false;
  updateTalk();
}

function toggleTalk() {
  if (talking && !tailTimer) stopTalking();
  else startTalking();
}

document.addEventListener("keydown", (e) => {  // laptop: space bar
  if (e.code !== "Space" || e.repeat || role !== "german") return;
  if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target.tagName)) return;
  e.preventDefault();
  toggleTalk();
});

// ---- sound (German side) ----------------------------------------------
function updateSound() {
  $("sound").textContent = player.enabled ? t.soundOn : t.soundOff;
}

async function toggleSound() {
  soundWanted = !player.enabled;
  localStorage.setItem("sound", soundWanted ? "on" : "off");
  if (soundWanted) {
    try { await player.enable(); } catch (e) { /* ignore */ }
  } else {
    player.disable();
  }
  updateSound();
}

document.addEventListener("pointerdown", (e) => {  // unlock audio
  if (role !== "german" || !soundWanted || player.enabled ||
      e.target.id === "sound") return;
  player.enable().then(updateSound, () => {});
}, true);

// ---- page lifecycle ------------------------------------------------------
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (role === "malagasy") {  // phones: end turn, free the mic
      if (talking) finishTurn();
      mic.close();
    }
    return;
  }
  keepAwake();
  if (server && code && (!ws || ws.readyState === WebSocket.CLOSED)) {
    retry = 0;
    connect();
  }
});

if (server && code) connect(); else showSetup();
