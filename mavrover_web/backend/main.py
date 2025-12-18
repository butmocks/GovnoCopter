from __future__ import annotations

import json
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any

import anyio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .data_model import CommandRequest, CommandResponse, MavOutEvent, ServerEvent, TelemetryEvent
from .mavlink import MavlinkClient, MavlinkConfig, MavlinkError
from .telemetry import TelemetryState, handle_mavlink_message


ROOT_DIR = Path(__file__).resolve().parents[1]
FRONTEND_DIR = ROOT_DIR / "frontend"
CONFIG_PATH = ROOT_DIR / "config.json"


def load_config() -> dict[str, Any]:
    if not CONFIG_PATH.exists():
        return {}
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


class SharedState:
    def __init__(self) -> None:
        self.telemetry = TelemetryState()
        self.lock = threading.Lock()
        self.mav: MavlinkClient | None = None
        self.thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.cfg: dict[str, Any] = {}


shared = SharedState()


def mavlink_rx_loop() -> None:
    backoff_s = 1.0
    while not shared.stop_event.is_set():
        cfg = shared.cfg
        port = str(cfg.get("serial_port") or "").strip()
        baudrate = int(cfg.get("baudrate") or 115200)
        if not port:
            time.sleep(0.5)
            continue

        client = MavlinkClient(MavlinkConfig(serial_port=port, baudrate=baudrate))
        try:
            client.connect()
            with shared.lock:
                shared.mav = client
                shared.telemetry.data.connected = True
            backoff_s = 1.0

            while not shared.stop_event.is_set():
                msg = client.recv_match(timeout_s=1.0)
                if msg is None:
                    # no message; keep loop alive
                    continue
                with shared.lock:
                    handle_mavlink_message(shared.telemetry, msg)
                    if getattr(msg, "get_type", lambda: None)() == "HEARTBEAT":
                        mode_str = client.mode_string_from_heartbeat(msg)
                        if mode_str:
                            shared.telemetry.data.mode = mode_str
        except Exception as e:
            with shared.lock:
                shared.telemetry.data.connected = False
                shared.telemetry.data.armed = None
            # Best-effort close
            try:
                client.close()
            except Exception:
                pass
            with shared.lock:
                if shared.mav is client:
                    shared.mav = None

            # Backoff before reconnect
            time.sleep(min(10.0, backoff_s))
            backoff_s = min(10.0, backoff_s * 1.8)
            # Keep a small trace in warnings
            with shared.lock:
                shared.telemetry.data.warnings.append(f"MAVLink reconnect: {type(e).__name__}: {e}")
                if len(shared.telemetry.data.warnings) > 30:
                    shared.telemetry.data.warnings = shared.telemetry.data.warnings[-30:]


app = FastAPI(title="MavRover Web")

# Не падаем при импорте, если фронтенд- папка отсутствует (частая причина "Could not import module").
# В нормальном случае папка есть и статика будет отдаваться как обычно.
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR), check_dir=False), name="static")


@app.on_event("startup")
def _startup() -> None:
    shared.cfg = load_config()
    shared.stop_event.clear()
    t = threading.Thread(target=mavlink_rx_loop, name="mavlink-rx", daemon=True)
    shared.thread = t
    t.start()


@app.on_event("shutdown")
def _shutdown() -> None:
    shared.stop_event.set()
    with shared.lock:
        mav = shared.mav
        shared.mav = None
    if mav is not None:
        try:
            mav.close()
        except Exception:
            pass


@app.get("/")
def index() -> FileResponse:
    return FileResponse(str(FRONTEND_DIR / "index.html"))


@app.get("/api/config")
def api_config() -> JSONResponse:
    cfg = load_config()
    # only expose safe keys to browser
    return JSONResponse(
        {
            "video_url": cfg.get("video_url", ""),
        }
    )


def _check_video_url(video_url: str, timeout_s: float = 2.0) -> dict[str, Any]:
    video_url = (video_url or "").strip()
    if not video_url:
        return {"configured": False, "ok": False, "error": "video_url is empty"}
    try:
        req = urllib.request.Request(
            video_url,
            headers={
                "User-Agent": "mavrover_web/1.0",
                "Accept": "*/*",
            },
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            # MJPEG stream is infinite; just read a small chunk and close.
            _ = resp.read(256)
            ctype = resp.headers.get("Content-Type", "")
        return {"configured": True, "ok": True, "content_type": ctype}
    except Exception as e:
        return {"configured": True, "ok": False, "error": f"{type(e).__name__}: {e}"}


@app.get("/api/check")
async def api_check() -> JSONResponse:
    cfg = load_config()
    video_url = str(cfg.get("video_url", "") or "")

    with shared.lock:
        tel = shared.telemetry.to_model()
        mav = shared.mav

    mav_ping: dict[str, Any] = {"ok": False, "error": "not connected"}
    if mav is not None:
        try:
            await anyio.to_thread.run_sync(mav.ping)
            mav_ping = {"ok": True}
        except Exception as e:
            mav_ping = {"ok": False, "error": f"{type(e).__name__}: {e}"}

    video = await anyio.to_thread.run_sync(_check_video_url, video_url)

    return JSONResponse(
        {
            "ok": bool(tel.connected) and bool(mav_ping.get("ok")),
            "mavlink": {
                "connected": tel.connected,
                "last_heartbeat_age_s": tel.last_heartbeat_age_s,
                "armed": tel.armed,
                "mode": tel.mode,
                "ping": mav_ping,
            },
            "video": video,
        }
    )


async def _send_json(ws: WebSocket, payload: dict[str, Any]) -> None:
    await ws.send_text(json.dumps(payload, ensure_ascii=False))


async def _run_command(cmd: CommandRequest) -> CommandResponse:
    with shared.lock:
        mav = shared.mav
    if mav is None:
        return CommandResponse(ok=False, message="MAVLink: not connected")

    try:
        # Log outgoing MAVLink commands for the UI.
        # (This is best-effort; even if logging fails, we still try to execute the command.)
        # Note: we return command_result separately; this event is just "what we tried to send".
        # WebSocket handler will send MavOutEvent before calling this function if needed.
        if cmd.command == "arm":
            await anyio.to_thread.run_sync(mav.arm)
        elif cmd.command == "disarm":
            await anyio.to_thread.run_sync(mav.disarm)
        elif cmd.command == "set_mode":
            mode = str(cmd.params.get("mode", "")).strip().upper()
            if not mode:
                raise MavlinkError("Missing params.mode")
            await anyio.to_thread.run_sync(mav.set_mode, mode)
            with shared.lock:
                shared.telemetry.data.mode = mode
        elif cmd.command == "reboot_autopilot":
            await anyio.to_thread.run_sync(mav.reboot_autopilot)
        elif cmd.command == "rc_override":
            steering_pwm = cmd.params.get("steering_pwm", None)
            throttle_pwm = cmd.params.get("throttle_pwm", None)
            await anyio.to_thread.run_sync(
                mav.rc_override,
                steering_pwm=None if steering_pwm is None else int(steering_pwm),
                throttle_pwm=None if throttle_pwm is None else int(throttle_pwm),
            )
        elif cmd.command == "command_long":
            cmd_id = int(cmd.params.get("cmd_id", 0))
            if cmd_id <= 0:
                raise MavlinkError("Missing/invalid params.cmd_id")
            await anyio.to_thread.run_sync(
                mav.command_long,
                cmd_id=cmd_id,
                p1=float(cmd.params.get("p1", 0.0)),
                p2=float(cmd.params.get("p2", 0.0)),
                p3=float(cmd.params.get("p3", 0.0)),
                p4=float(cmd.params.get("p4", 0.0)),
                p5=float(cmd.params.get("p5", 0.0)),
                p6=float(cmd.params.get("p6", 0.0)),
                p7=float(cmd.params.get("p7", 0.0)),
                confirmation=int(cmd.params.get("confirmation", 0)),
            )
        else:
            return CommandResponse(ok=False, message=f"Unknown command: {cmd.command}")
        return CommandResponse(ok=True, message="OK")
    except Exception as e:
        return CommandResponse(ok=False, message=f"{type(e).__name__}: {e}")


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    await _send_json(ws, ServerEvent(message="WS connected").model_dump())

    async def telemetry_loop() -> None:
        while True:
            with shared.lock:
                m = shared.telemetry.to_model()
            evt = TelemetryEvent(data=m)
            await _send_json(ws, evt.model_dump())
            await anyio.sleep(0.25)

    async def receive_loop() -> None:
        while True:
            raw = await ws.receive_text()
            try:
                obj = json.loads(raw)
                cmd = CommandRequest.model_validate(obj)
            except Exception as e:
                await _send_json(
                    ws,
                    CommandResponse(ok=False, message=f"Bad command JSON: {e}").model_dump(),
                )
                continue

            # Outgoing MAVLink "what we are sending" log event
            try:
                await _send_json(
                    ws,
                    MavOutEvent(
                        name=cmd.command,
                        params=cmd.params,
                        ts_ms=int(time.time() * 1000),
                    ).model_dump(),
                )
            except Exception:
                pass

            res = await _run_command(cmd)
            await _send_json(ws, res.model_dump())

    try:
        async with anyio.create_task_group() as tg:
            tg.start_soon(telemetry_loop)
            tg.start_soon(receive_loop)
    except WebSocketDisconnect:
        return

