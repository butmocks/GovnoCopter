from __future__ import annotations

import time
from dataclasses import dataclass


class MavlinkError(RuntimeError):
    pass


@dataclass
class MavlinkConfig:
    serial_port: str
    baudrate: int = 115200


class MavlinkClient:
    """
    Thin wrapper around pymavlink.
    Designed to be used from a background thread (recv loop) plus async server commands.
    """

    def __init__(self, cfg: MavlinkConfig):
        self.cfg = cfg
        self.master = None
        self._last_mode_str: str | None = None

    def connect(self, heartbeat_timeout_s: float = 8.0) -> None:
        try:
            from pymavlink import mavutil
        except Exception as e:  # pragma: no cover
            raise MavlinkError(f"pymavlink import failed: {e}") from e

        port = self.cfg.serial_port
        if port.startswith(("udp:", "tcp:", "udpin:", "udpout:")):
            self.master = mavutil.mavlink_connection(port)
        else:
            self.master = mavutil.mavlink_connection(port, baud=self.cfg.baudrate)

        # Best-effort: wait for heartbeat to confirm link
        try:
            self.master.wait_heartbeat(timeout=heartbeat_timeout_s)
        except Exception:
            # Link may still become alive later; don't hard-fail here.
            pass

    def close(self) -> None:
        if self.master is not None:
            try:
                self.master.close()
            finally:
                self.master = None

    def recv_match(self, timeout_s: float = 1.0):
        if self.master is None:
            raise MavlinkError("Not connected")
        return self.master.recv_match(blocking=True, timeout=timeout_s)

    def mode_string_from_heartbeat(self, hb_msg) -> str | None:
        """
        Uses pymavlink helper to translate custom_mode into a readable string.
        """
        if self.master is None:
            return None
        try:
            from pymavlink import mavutil

            s = mavutil.mode_string_v10(hb_msg)
            if s:
                self._last_mode_str = str(s)
                return self._last_mode_str
        except Exception:
            return None
        return None

    def arm(self) -> None:
        if self.master is None:
            raise MavlinkError("Not connected")
        from pymavlink.dialects.v20 import common as mavlink2

        self.master.mav.command_long_send(
            self.master.target_system,
            self.master.target_component,
            mavlink2.MAV_CMD_COMPONENT_ARM_DISARM,
            0,
            1,  # arm
            0,
            0,
            0,
            0,
            0,
            0,
        )

    def disarm(self) -> None:
        if self.master is None:
            raise MavlinkError("Not connected")
        from pymavlink.dialects.v20 import common as mavlink2

        self.master.mav.command_long_send(
            self.master.target_system,
            self.master.target_component,
            mavlink2.MAV_CMD_COMPONENT_ARM_DISARM,
            0,
            0,  # disarm
            0,
            0,
            0,
            0,
            0,
            0,
        )

    def set_mode(self, mode: str) -> None:
        """
        mode: e.g. MANUAL / HOLD / AUTO
        """
        if self.master is None:
            raise MavlinkError("Not connected")

        mode = mode.strip().upper()
        mapping = {}
        try:
            mapping = self.master.mode_mapping()
        except Exception:
            mapping = {}

        if mapping and mode not in mapping:
            raise MavlinkError(f"Mode '{mode}' not supported by autopilot. Supported: {sorted(mapping.keys())}")

        # APM stacks typically support set_mode with string
        try:
            self.master.set_mode(mode)
        except Exception as e:
            raise MavlinkError(f"Failed to set mode {mode}: {e}") from e

        self._last_mode_str = mode

    def reboot_autopilot(self) -> None:
        if self.master is None:
            raise MavlinkError("Not connected")
        from pymavlink.dialects.v20 import common as mavlink2

        self.master.mav.command_long_send(
            self.master.target_system,
            self.master.target_component,
            mavlink2.MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN,
            0,
            1,  # reboot autopilot
            0,
            0,
            0,
            0,
            0,
            0,
        )

    def ping(self) -> None:
        if self.master is None:
            raise MavlinkError("Not connected")
        from pymavlink.dialects.v20 import common as mavlink2

        now_us = int(time.time() * 1_000_000)
        self.master.mav.ping_send(now_us, 0, 0, 0)

    def rc_override(self, *, steering_pwm: int | None = None, throttle_pwm: int | None = None) -> None:
        """
        Send RC_CHANNELS_OVERRIDE for rover-style manual driving.

        Typical ArduRover mapping:
        - CH1: steering
        - CH3: throttle
        Values are PWM in [1000..2000]. Use None to not override that channel.
        """
        if self.master is None:
            raise MavlinkError("Not connected")

        def _pwm(v: int | None) -> int:
            if v is None:
                return 0  # 0/65535 => ignore, ArduPilot treats 0 as "no override"
            v = int(v)
            return max(1000, min(2000, v))

        ch1 = _pwm(steering_pwm)
        ch3 = _pwm(throttle_pwm)
        # channels: 1..8
        self.master.mav.rc_channels_override_send(
            self.master.target_system,
            self.master.target_component,
            ch1,  # chan1_raw (steering)
            0,  # chan2_raw
            ch3,  # chan3_raw (throttle)
            0,  # chan4_raw
            0,  # chan5_raw
            0,  # chan6_raw
            0,  # chan7_raw
            0,  # chan8_raw
        )

    def command_long(
        self,
        *,
        cmd_id: int,
        p1: float = 0.0,
        p2: float = 0.0,
        p3: float = 0.0,
        p4: float = 0.0,
        p5: float = 0.0,
        p6: float = 0.0,
        p7: float = 0.0,
        confirmation: int = 0,
    ) -> None:
        """
        Generic COMMAND_LONG sender (MAV_CMD).

        cmd_id: integer MAV_CMD id (e.g. 400 for MAV_CMD_COMPONENT_ARM_DISARM)
        p1..p7: float params
        confirmation: usually 0
        """
        if self.master is None:
            raise MavlinkError("Not connected")
        self.master.mav.command_long_send(
            self.master.target_system,
            self.master.target_component,
            int(cmd_id),
            int(confirmation),
            float(p1),
            float(p2),
            float(p3),
            float(p4),
            float(p5),
            float(p6),
            float(p7),
        )

