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

function setVideoVisible(visible) {
  const card = $("videoCard");
  const btn = $("btnToggleVideo");
  if (visible) card.classList.remove("hidden");
  else card.classList.add("hidden");
  btn.textContent = visible ? "Видео: ON" : "Видео: OFF";
  localStorage.setItem("videoVisible", visible ? "1" : "0");
}

function getVideoVisible() {
  return localStorage.getItem("videoVisible") !== "0";
}

async function main() {
  $("wsStatus").textContent = "WS: connecting...";
  setVideoVisible(getVideoVisible());
  $("btnToggleVideo").addEventListener("click", () => setVideoVisible(!getVideoVisible()));

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

  // --- Movement (RC override) ---
  const PWM = {
    steerCenter: 1500,
    steerLeft: 1400,
    steerRight: 1600,
    thrStop: 1500,
    thrFwd: 1600,
    thrBack: 1400,
  };

  let holdTimer = null;
  let holdCmd = { steering_pwm: PWM.steerCenter, throttle_pwm: PWM.thrStop };

  function startHold(cmd) {
    holdCmd = cmd;
    if (holdTimer) clearInterval(holdTimer);
    // send immediately + keep sending while holding (helps if failsafe resets overrides)
    send("rc_override", holdCmd);
    holdTimer = setInterval(() => send("rc_override", holdCmd), 200);
  }

  function stopHold() {
    if (holdTimer) clearInterval(holdTimer);
    holdTimer = null;
    send("rc_override", { steering_pwm: PWM.steerCenter, throttle_pwm: PWM.thrStop });
  }

  function bindHold(btn, cmd) {
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      btn.setPointerCapture?.(e.pointerId);
      startHold(cmd);
    });
    btn.addEventListener("pointerup", (e) => {
      e.preventDefault();
      stopHold();
    });
    btn.addEventListener("pointercancel", stopHold);
    btn.addEventListener("pointerleave", () => {
      // if user drags pointer away while holding
      // don't auto-stop unless still holding timer; safest is to stop
      if (holdTimer) stopHold();
    });
  }

  bindHold($("btnMoveUp"), { steering_pwm: PWM.steerCenter, throttle_pwm: PWM.thrFwd });
  bindHold($("btnMoveDown"), { steering_pwm: PWM.steerCenter, throttle_pwm: PWM.thrBack });
  bindHold($("btnMoveLeft"), { steering_pwm: PWM.steerLeft, throttle_pwm: PWM.thrStop });
  bindHold($("btnMoveRight"), { steering_pwm: PWM.steerRight, throttle_pwm: PWM.thrStop });
  $("btnMoveStop").addEventListener("click", stopHold);

  // Keyboard (WASD + Space stop)
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.key === "w" || e.key === "W") startHold({ steering_pwm: PWM.steerCenter, throttle_pwm: PWM.thrFwd });
    else if (e.key === "s" || e.key === "S") startHold({ steering_pwm: PWM.steerCenter, throttle_pwm: PWM.thrBack });
    else if (e.key === "a" || e.key === "A") startHold({ steering_pwm: PWM.steerLeft, throttle_pwm: PWM.thrStop });
    else if (e.key === "d" || e.key === "D") startHold({ steering_pwm: PWM.steerRight, throttle_pwm: PWM.thrStop });
    else if (e.key === " ") stopHold();
  });
  window.addEventListener("keyup", (e) => {
    if (["w", "W", "a", "A", "s", "S", "d", "D"].includes(e.key)) stopHold();
  });

  // --- Peripheral check (server-side) ---
  async function runCheck() {
    $("checkHint").textContent = "Проверяю...";
    try {
      const res = await fetch("/api/check", { cache: "no-store" });
      const j = await res.json();
      const v = j.video || {};
      $("perVideo").textContent = v.ok ? `OK (${v.content_type || "?"})` : `FAIL: ${v.error || "unknown"}`;
      const m = j.mavlink || {};
      logLine(`CHECK: mavlink.connected=${m.connected} ping=${m.ping?.ok ? "ok" : "fail"}`);
      $("checkHint").textContent = "Готово.";
    } catch (e) {
      $("checkHint").textContent = "Ошибка проверки (см. лог).";
      logLine(`CHECK error: ${e}`);
    }
  }
  $("btnCheck").addEventListener("click", runCheck);

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

    // Peripheral quick status (from telemetry)
    const gpsOk = (g.fix_type != null && g.fix_type >= 3) && (g.sats != null && g.sats >= 4);
    $("perGps").textContent = g.fix_type == null ? "—" : (gpsOk ? `OK (FIX ${g.fix_type}, ${g.sats || "?"} sats)` : `WARN (FIX ${g.fix_type}, ${g.sats || "?"} sats)`);
    $("perBatt").textContent = b.voltage_v == null ? "—" : `OK (${b.voltage_v.toFixed(2)} V)`;

    const sp = t.sensors_present;
    const se = t.sensors_enabled;
    const sh = t.sensors_health;
    if (sh == null && sp == null && se == null) $("perSensors").textContent = "—";
    else {
      const hx = (v) => (v == null ? "—" : "0x" + Number(v >>> 0).toString(16));
      $("perSensors").textContent = `present=${hx(sp)} enabled=${hx(se)} health=${hx(sh)}`;
    }

    const errs = (t.errors || []).slice(0, 3);
    const warns = (t.warnings || []).slice(0, 3);
    if (errs.length) logLine(`ERROR: ${errs[0]}`);
    else if (warns.length) logLine(`WARN: ${warns[0]}`);
  });
}

main().catch((e) => logLine(`Fatal: ${e}`));

