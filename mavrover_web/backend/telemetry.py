from __future__ import annotations

import time
from dataclasses import dataclass, field

from .data_model import BatteryModel, GPSModel, TelemetryModel


@dataclass
class TelemetryState:
    data: TelemetryModel = field(default_factory=TelemetryModel)
    last_heartbeat_ts: float | None = None

    def to_model(self) -> TelemetryModel:
        m = self.data.model_copy(deep=True)
        if self.last_heartbeat_ts is None:
            m.last_heartbeat_age_s = None
        else:
            m.last_heartbeat_age_s = max(0.0, time.time() - self.last_heartbeat_ts)
        return m


def _append_limited(lst: list[str], msg: str, limit: int = 30) -> None:
    lst.append(msg)
    if len(lst) > limit:
        del lst[: len(lst) - limit]


def handle_mavlink_message(state: TelemetryState, msg: object) -> None:
    """
    Update telemetry state from a pymavlink message.
    This function must be tolerant of missing fields.
    """
    mtype = getattr(msg, "get_type", lambda: None)()
    state.data.timestamp_ms = int(time.time() * 1000)

    if mtype == "BAD_DATA":
        return

    if mtype == "HEARTBEAT":
        state.data.connected = True
        state.last_heartbeat_ts = time.time()
        base_mode = getattr(msg, "base_mode", 0)
        # MAV_MODE_FLAG_SAFETY_ARMED = 128
        state.data.armed = bool(base_mode & 128)
        custom_mode = getattr(msg, "custom_mode", None)
        # Mode string will be filled by mavlink layer when possible; keep placeholder here
        if custom_mode is not None and (state.data.mode is None):
            state.data.mode = str(custom_mode)
        return

    if mtype == "SYS_STATUS":
        batt_mv = getattr(msg, "voltage_battery", None)  # mV
        batt_ma = getattr(msg, "current_battery", None)  # 10mA units, -1 unknown
        remaining = getattr(msg, "battery_remaining", None)  # %
        b = state.data.battery if isinstance(state.data.battery, BatteryModel) else BatteryModel()
        if isinstance(batt_mv, (int, float)) and batt_mv != 0:
            b.voltage_v = float(batt_mv) / 1000.0
        if isinstance(batt_ma, (int, float)) and batt_ma not in (-1, 0):
            b.current_a = float(batt_ma) / 100.0
        if isinstance(remaining, (int, float)) and remaining >= 0:
            b.remaining_pct = float(remaining)
        state.data.battery = b
        return

    if mtype == "GPS_RAW_INT":
        lat = getattr(msg, "lat", None)  # 1e7
        lon = getattr(msg, "lon", None)  # 1e7
        alt = getattr(msg, "alt", None)  # mm
        eph = getattr(msg, "eph", None)  # cm
        sats = getattr(msg, "satellites_visible", None)
        fix_type = getattr(msg, "fix_type", None)
        g = state.data.gps if isinstance(state.data.gps, GPSModel) else GPSModel()
        if isinstance(lat, (int, float)) and lat not in (0, 2147483647, -2147483648):
            g.lat = float(lat) / 1e7
        if isinstance(lon, (int, float)) and lon not in (0, 2147483647, -2147483648):
            g.lon = float(lon) / 1e7
        if isinstance(alt, (int, float)) and alt != 0:
            g.alt_m = float(alt) / 1000.0
        if isinstance(eph, (int, float)) and eph > 0:
            g.hdop = float(eph) / 100.0
        if isinstance(sats, (int, float)):
            g.sats = int(sats)
        if isinstance(fix_type, (int, float)):
            g.fix_type = int(fix_type)
        state.data.gps = g
        return

    if mtype == "VFR_HUD":
        groundspeed = getattr(msg, "groundspeed", None)
        heading = getattr(msg, "heading", None)
        if isinstance(groundspeed, (int, float)):
            state.data.groundspeed_m_s = float(groundspeed)
        if isinstance(heading, (int, float)):
            state.data.heading_deg = float(heading)
        return

    if mtype == "STATUSTEXT":
        text = getattr(msg, "text", None)
        severity = getattr(msg, "severity", None)
        if text:
            line = str(text).strip()
            _append_limited(state.data.statustext, line)
            if isinstance(severity, int) and severity <= 3:
                _append_limited(state.data.errors, line)
            elif isinstance(severity, int) and severity <= 5:
                _append_limited(state.data.warnings, line)
        return

    if mtype == "EKF_STATUS_REPORT":
        flags = getattr(msg, "flags", None)
        if isinstance(flags, int):
            # If EKF flags indicate unhealthy, flag as warning (simple heuristic)
            if flags == 0:
                _append_limited(state.data.warnings, "EKF: no flags set (check EKF health)")
        return

