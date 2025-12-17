from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

import anyio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .data_model import CommandRequest, CommandResponse, ServerEvent, TelemetryEvent
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

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


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


async def _send_json(ws: WebSocket, payload: dict[str, Any]) -> None:
    await ws.send_text(json.dumps(payload, ensure_ascii=False))


async def _run_command(cmd: CommandRequest) -> CommandResponse:
    with shared.lock:
        mav = shared.mav
    if mav is None:
        return CommandResponse(ok=False, message="MAVLink: not connected")

    try:
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

            res = await _run_command(cmd)
            await _send_json(ws, res.model_dump())

    try:
        async with anyio.create_task_group() as tg:
            tg.start_soon(telemetry_loop)
            tg.start_soon(receive_loop)
    except WebSocketDisconnect:
        return

