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

function logMavOut(line) {
  const el = $("mavOut");
  if (!el) return;
  const ts = new Date().toLocaleTimeString();
  // append (so quick LEFT->STOP is visible in order)
  el.textContent = el.textContent + `[${ts}] ${line}\n`;
  el.scrollTop = el.scrollHeight;
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

function setActiveTab(tabId) {
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === tabId));

  const panel = $("tab-panel");
  const map = $("tab-map");
  const builder = $("tab-builder");
  const help = $("tab-help");
  panel.classList.toggle("hidden", tabId !== "panel");
  map.classList.toggle("hidden", tabId !== "map");
  builder.classList.toggle("hidden", tabId !== "builder");
  help.classList.toggle("hidden", tabId !== "help");

  localStorage.setItem("activeTab", tabId);

  if (tabId === "map") {
    initMapOnce();
    // Leaflet needs a resize after showing
    setTimeout(() => {
      if (window.__mavMap) window.__mavMap.invalidateSize();
    }, 150);
  }
}

function getActiveTab() {
  return localStorage.getItem("activeTab") || "panel";
}

function toRad(d) {
  return (d * Math.PI) / 180;
}

function approxDistanceM(a, b) {
  // Equirectangular approximation is fine for small distances
  const R = 6371000;
  const x = toRad(b.lon - a.lon) * Math.cos(toRad((a.lat + b.lat) / 2));
  const y = toRad(b.lat - a.lat);
  return Math.sqrt(x * x + y * y) * R;
}

function initMapOnce() {
  if (window.__mavMapInit) return;
  window.__mavMapInit = true;
  if (!window.L) {
    logLine("Leaflet не загрузился (нет карты).");
    return;
  }
  const el = $("map");
  if (!el) return;
  const map = L.map(el, { zoomControl: true });
  window.__mavMap = map;
  window.__mavMapFollow = true;
  window.__mavTrack = [];
  window.__mavPolyline = L.polyline([], { color: "#6ea8fe", weight: 4, opacity: 0.85 }).addTo(map);
  window.__mavMarker = L.circleMarker([0, 0], { radius: 7, color: "#46d39a", weight: 2, fillOpacity: 0.85 }).addTo(map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  map.setView([0, 0], 2);

  $("btnMapFollow").addEventListener("click", () => {
    window.__mavMapFollow = !window.__mavMapFollow;
    $("btnMapFollow").textContent = window.__mavMapFollow ? "Follow: ON" : "Follow: OFF";
  });
}

function pushGpsPoint(lat, lon) {
  if (!window.__mavMap || !window.__mavTrack) return;
  const p = { lat, lon, ts: Date.now() };
  const track = window.__mavTrack;
  const last = track.length ? track[track.length - 1] : null;
  if (last) {
    const d = approxDistanceM({ lat: last.lat, lon: last.lon }, p);
    if (d < 0.8) return; // ignore tiny jitter
  }
  track.push(p);
  if (track.length > 2000) track.splice(0, track.length - 2000);

  const ll = [lat, lon];
  window.__mavMarker.setLatLng(ll);
  window.__mavPolyline.setLatLngs(track.map((x) => [x.lat, x.lon]));

  if (window.__mavMapFollow) {
    const z = window.__mavMap.getZoom();
    window.__mavMap.setView(ll, Math.max(16, z), { animate: false });
  }

  $("mapHint").textContent = `Точек: ${track.length}`;
}

async function main() {
  $("wsStatus").textContent = "WS: connecting...";
  setVideoVisible(getVideoVisible());
  $("btnToggleVideo").addEventListener("click", () => setVideoVisible(!getVideoVisible()));

  // Tabs
  document.querySelectorAll(".tab").forEach((b) => {
    b.addEventListener("click", () => setActiveTab(b.dataset.tab));
  });
  setActiveTab(getActiveTab());

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

  // --- COMMAND_LONG builder ---
  function loadExampleArm() {
    $("cmdId").value = "400";
    $("cmdConf").value = "0";
    $("p1").value = "1";
    $("p2").value = "0";
    $("p3").value = "0";
    $("p4").value = "0";
    $("p5").value = "0";
    $("p6").value = "0";
    $("p7").value = "0";
  }
  function loadExampleReboot() {
    $("cmdId").value = "246";
    $("cmdConf").value = "0";
    $("p1").value = "1";
    $("p2").value = "0";
    $("p3").value = "0";
    $("p4").value = "0";
    $("p5").value = "0";
    $("p6").value = "0";
    $("p7").value = "0";
  }
  $("btnLoadExampleArm").addEventListener("click", loadExampleArm);
  $("btnLoadExampleReboot").addEventListener("click", loadExampleReboot);
  $("btnSendCmdLong").addEventListener("click", () => {
    const cmd_id = Number($("cmdId").value);
    const confirmation = Number($("cmdConf").value || 0);
    const params = {
      cmd_id,
      confirmation,
      p1: Number($("p1").value || 0),
      p2: Number($("p2").value || 0),
      p3: Number($("p3").value || 0),
      p4: Number($("p4").value || 0),
      p5: Number($("p5").value || 0),
      p6: Number($("p6").value || 0),
      p7: Number($("p7").value || 0),
    };
    if (!Number.isFinite(cmd_id) || cmd_id <= 0) {
      logLine("COMMAND_LONG: неверный MAV_CMD id");
      return;
    }
    if (!confirm(`Отправить COMMAND_LONG cmd_id=${cmd_id}?`)) return;
    send("command_long", params);
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

  // Axis-based state so LEFT/RIGHT really "change" while moving forward/back.
  const drive = {
    steering_pwm: PWM.steerCenter,
    throttle_pwm: PWM.thrStop,
    steerActive: false,
    throttleActive: false,
    timer: null,
  };

  function sendDriveOnce() {
    send("rc_override", { steering_pwm: drive.steering_pwm, throttle_pwm: drive.throttle_pwm });
  }

  function ensureDriveLoop() {
    if (drive.timer) return;
    sendDriveOnce();
    drive.timer = setInterval(sendDriveOnce, 200);
  }

  function maybeStopLoop() {
    if (drive.steerActive || drive.throttleActive) return;
    if (drive.timer) clearInterval(drive.timer);
    drive.timer = null;
    drive.steering_pwm = PWM.steerCenter;
    drive.throttle_pwm = PWM.thrStop;
    sendDriveOnce();
  }

  function setSteer(pwm, active) {
    drive.steering_pwm = pwm;
    drive.steerActive = active;
    if (active) ensureDriveLoop();
    else {
      drive.steering_pwm = PWM.steerCenter;
      drive.steerActive = false;
      maybeStopLoop();
    }
  }

  function setThrottle(pwm, active) {
    drive.throttle_pwm = pwm;
    drive.throttleActive = active;
    if (active) ensureDriveLoop();
    else {
      drive.throttle_pwm = PWM.thrStop;
      drive.throttleActive = false;
      maybeStopLoop();
    }
  }

  function stopAll() {
    drive.steerActive = false;
    drive.throttleActive = false;
    if (drive.timer) clearInterval(drive.timer);
    drive.timer = null;
    drive.steering_pwm = PWM.steerCenter;
    drive.throttle_pwm = PWM.thrStop;
    sendDriveOnce();
  }

  function bindAxisHold(btn, onDown, onUp) {
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      btn.setPointerCapture?.(e.pointerId);
      onDown();
    });
    btn.addEventListener("pointerup", (e) => {
      e.preventDefault();
      onUp();
    });
    btn.addEventListener("pointercancel", onUp);
  }

  bindAxisHold($("btnMoveUp"), () => setThrottle(PWM.thrFwd, true), () => setThrottle(PWM.thrStop, false));
  bindAxisHold($("btnMoveDown"), () => setThrottle(PWM.thrBack, true), () => setThrottle(PWM.thrStop, false));
  bindAxisHold($("btnMoveLeft"), () => setSteer(PWM.steerLeft, true), () => setSteer(PWM.steerCenter, false));
  bindAxisHold($("btnMoveRight"), () => setSteer(PWM.steerRight, true), () => setSteer(PWM.steerCenter, false));
  $("btnMoveStop").addEventListener("click", stopAll);

  // Keyboard (WASD + Space stop)
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.key === "w" || e.key === "W") setThrottle(PWM.thrFwd, true);
    else if (e.key === "s" || e.key === "S") setThrottle(PWM.thrBack, true);
    else if (e.key === "a" || e.key === "A") setSteer(PWM.steerLeft, true);
    else if (e.key === "d" || e.key === "D") setSteer(PWM.steerRight, true);
    else if (e.key === " ") stopAll();
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "w" || e.key === "W") setThrottle(PWM.thrStop, false);
    else if (e.key === "s" || e.key === "S") setThrottle(PWM.thrStop, false);
    else if (e.key === "a" || e.key === "A") setSteer(PWM.steerCenter, false);
    else if (e.key === "d" || e.key === "D") setSteer(PWM.steerCenter, false);
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

    if (msg.type === "mav_out") {
      const name = msg.name || "unknown";
      const params = msg.params || {};
      logMavOut(`${name} ${JSON.stringify(params)}`);
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

    // Map update if available
    if (g.lat != null && g.lon != null) {
      // only push when map is initialized; we still keep data ready
      if (window.__mavMapInit) pushGpsPoint(Number(g.lat), Number(g.lon));
    }

    const errs = (t.errors || []).slice(0, 3);
    const warns = (t.warnings || []).slice(0, 3);
    if (errs.length) logLine(`ERROR: ${errs[0]}`);
    else if (warns.length) logLine(`WARN: ${warns[0]}`);
  });
}

main().catch((e) => logLine(`Fatal: ${e}`));

