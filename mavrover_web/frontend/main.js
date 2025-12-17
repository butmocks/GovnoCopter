function $(id) {
  return document.getElementById(id);
}

function fmt(v, suffix = "") {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${v}${suffix}`;
}

function logLine(line) {
  const el = $("log");
  const ts = new Date().toLocaleTimeString();
  el.textContent = `[${ts}] ${line}\n` + el.textContent;
}

async function loadConfig() {
  const res = await fetch("/api/config", { cache: "no-store" });
  const cfg = await res.json();
  return cfg;
}

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

async function main() {
  $("wsStatus").textContent = "WS: connecting...";

  try {
    const cfg = await loadConfig();
    const videoUrl = (cfg.video_url || "").trim();
    if (videoUrl) {
      $("video").src = videoUrl;
      $("videoHint").textContent = `Видео: ${videoUrl}`;
    } else {
      $("videoHint").textContent = "В config.json не задан video_url";
      logLine("config.json: video_url пустой");
    }
  } catch (e) {
    $("videoHint").textContent = "Не смог загрузить /api/config";
    logLine(`Ошибка загрузки config: ${e}`);
  }

  const ws = new WebSocket(wsUrl());

  ws.addEventListener("open", () => {
    $("wsStatus").textContent = "WS: connected";
    logLine("WebSocket connected");
  });

  ws.addEventListener("close", () => {
    $("wsStatus").textContent = "WS: closed";
    logLine("WebSocket closed (обнови страницу)");
  });

  ws.addEventListener("error", () => {
    $("wsStatus").textContent = "WS: error";
    logLine("WebSocket error");
  });

  function send(cmd, params = {}) {
    ws.send(JSON.stringify({ type: "command", command: cmd, params }));
  }

  $("btnArm").addEventListener("click", () => send("arm"));
  $("btnDisarm").addEventListener("click", () => send("disarm"));
  $("btnManual").addEventListener("click", () => send("set_mode", { mode: "MANUAL" }));
  $("btnHold").addEventListener("click", () => send("set_mode", { mode: "HOLD" }));
  $("btnAuto").addEventListener("click", () => send("set_mode", { mode: "AUTO" }));
  $("btnReboot").addEventListener("click", () => {
    if (confirm("Точно перезагрузить автопилот?")) send("reboot_autopilot");
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.type === "server") {
      logLine(msg.message);
      return;
    }

    if (msg.type === "command_result") {
      if (msg.ok) logLine(`Команда OK`);
      else logLine(`Команда ERROR: ${msg.message || "unknown"}`);
      return;
    }

    if (msg.type !== "telemetry") return;

    const t = msg.data || {};
    $("linkStatus").textContent = `MAVLink: ${t.connected ? "connected" : "disconnected"}`;
    $("armedStatus").textContent = `ARM: ${t.armed === null || t.armed === undefined ? "—" : t.armed ? "ARMED" : "DISARMED"}`;
    $("modeStatus").textContent = `MODE: ${t.mode || "—"}`;

    $("speed").textContent = fmt(t.groundspeed_m_s, " m/s");
    $("heading").textContent = fmt(t.heading_deg, "°");

    const b = t.battery || {};
    const battParts = [];
    if (b.voltage_v != null) battParts.push(`${b.voltage_v.toFixed(2)} V`);
    if (b.current_a != null) battParts.push(`${b.current_a.toFixed(1)} A`);
    if (b.remaining_pct != null) battParts.push(`${Math.round(b.remaining_pct)} %`);
    $("battery").textContent = battParts.length ? battParts.join(" / ") : "—";

    const g = t.gps || {};
    const gpsParts = [];
    if (g.lat != null && g.lon != null) gpsParts.push(`${g.lat.toFixed(6)}, ${g.lon.toFixed(6)}`);
    if (g.alt_m != null) gpsParts.push(`${g.alt_m.toFixed(1)} m`);
    if (g.sats != null) gpsParts.push(`${g.sats} sats`);
    if (g.hdop != null) gpsParts.push(`HDOP ${g.hdop.toFixed(2)}`);
    if (g.fix_type != null) gpsParts.push(`FIX ${g.fix_type}`);
    $("gps").textContent = gpsParts.length ? gpsParts.join(" / ") : "—";

    $("hbAge").textContent = t.last_heartbeat_age_s == null ? "—" : `${t.last_heartbeat_age_s.toFixed(1)} s`;

    const errs = (t.errors || []).slice(0, 3);
    const warns = (t.warnings || []).slice(0, 3);
    if (errs.length) logLine(`ERROR: ${errs[0]}`);
    else if (warns.length) logLine(`WARN: ${warns[0]}`);
  });
}

main().catch((e) => logLine(`Fatal: ${e}`));

