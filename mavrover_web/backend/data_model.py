from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class GPSModel(BaseModel):
    lat: float | None = None
    lon: float | None = None
    alt_m: float | None = None
    sats: int | None = None
    hdop: float | None = None
    fix_type: int | None = None


class BatteryModel(BaseModel):
    voltage_v: float | None = None
    current_a: float | None = None
    remaining_pct: float | None = None


class TelemetryModel(BaseModel):
    connected: bool = False
    last_heartbeat_age_s: float | None = None

    armed: bool | None = None
    mode: str | None = None

    groundspeed_m_s: float | None = None
    heading_deg: float | None = None

    gps: GPSModel = Field(default_factory=GPSModel)
    battery: BatteryModel = Field(default_factory=BatteryModel)

    sensors_present: int | None = None
    sensors_enabled: int | None = None
    sensors_health: int | None = None

    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    statustext: list[str] = Field(default_factory=list)

    timestamp_ms: int | None = None


CommandType = Literal[
    "arm",
    "disarm",
    "set_mode",
    "reboot_autopilot",
    "rc_override",
    "command_long",
]


class CommandRequest(BaseModel):
    type: Literal["command"] = "command"
    command: CommandType
    params: dict[str, Any] = Field(default_factory=dict)


class CommandResponse(BaseModel):
    type: Literal["command_result"] = "command_result"
    ok: bool
    message: str | None = None


class TelemetryEvent(BaseModel):
    type: Literal["telemetry"] = "telemetry"
    data: TelemetryModel


class ServerEvent(BaseModel):
    type: Literal["server"] = "server"
    level: Literal["info", "warning", "error"] = "info"
    message: str


class MavOutEvent(BaseModel):
    type: Literal["mav_out"] = "mav_out"
    name: str
    params: dict[str, Any] = Field(default_factory=dict)
    ts_ms: int
