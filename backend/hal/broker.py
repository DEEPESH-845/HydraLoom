import math

from simulation.physics_engine import ThrusterPhysicsEngine
from simulation.sensor_sim import SimulatedIMU, SimulatedDepth, SimulatedPropulsion
from serial_bridge import SerialBridge

MODES = ("SIMULATION", "HARDWARE")


def _pwm(value) -> float:
    """A thruster command: a finite number, clamped to -100..100 percent. Anything else is rejected."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"PWM must be a finite number, got {value!r}")
    return max(-100.0, min(100.0, float(value)))


class HALBroker:
    """
    Hardware Abstraction Layer Broker.
    Routes telemetry requests to either physical hardware drivers or the digital twin simulation.
    """
    def __init__(self):
        self.mode = "SIMULATION" # Default to simulation
        self.leak_detected = False
        self.transitioning = False
        self.hardware_connected = False
        
        # Initialize Digital Twin
        self.physics = ThrusterPhysicsEngine()
        self.sim_imu = SimulatedIMU(self.physics)
        self.sim_depth = SimulatedDepth(self.physics)
        self.sim_propulsion = SimulatedPropulsion(self.physics)
        
        # Initialize SerialBridge for hardware mode
        self.serial_bridge = SerialBridge()
        
        # Attempt hardware connection on startup; connect() reports whether the port actually opened
        self.hardware_connected = self.serial_bridge.connect()
        if not self.hardware_connected:
            print("[HAL] Hardware connection failed. Falling back to SIMULATION.")
        
        # Start physics deterministic loop
        self.physics.start()
        
    def get_telemetry(self) -> dict:
        if self.mode == "SIMULATION":
            yaw, pitch, roll = self.sim_imu.get_orientation()
            t1, t2, t3, t4 = self.sim_propulsion.get_pwm()
            
            return {
                "state": {"isArmed": True, "mode": "SIMULATION", "transitioning": self.transitioning},
                "sensors": {
                    "depth": self.sim_depth.get_depth(),
                    "pressure": 1000 + (self.sim_depth.get_depth() * 100),
                    "temperature": self.sim_depth.get_temperature(),
                    "leakDetected": self.leak_detected
                },
                "imu": {
                    "yaw": yaw,
                    "pitch": pitch,
                    "roll": roll,
                    "accel": self.sim_imu.get_acceleration()
                },
                "propulsion": {
                    "t1_pwm": t1,
                    "t2_pwm": t2,
                    "t3_pwm": t3,
                    "t4_pwm": t4
                },
                "power": {"voltage": 16.4, "current": 2.1}
            }
        else:
            # Hardware mode - read from SerialBridge
            if not self.hardware_connected:
                return self._get_offline_telemetry("HARDWARE")

            # {} when the link is down or silent: served as offline, never as stale live data
            hw_data = self.serial_bridge.get_latest()
            if not hw_data:
                return self._get_offline_telemetry("HARDWARE")
            
            return {
                "state": {"isArmed": True, "mode": "HARDWARE", "transitioning": self.transitioning},
                "sensors": {
                    "depth": hw_data.get("depth", 0),
                    "pressure": hw_data.get("pressure", 1000),
                    "temperature": hw_data.get("temperature", 20),
                    "leakDetected": hw_data.get("leakDetected", False)
                },
                "imu": {
                    "yaw": hw_data.get("yaw", 0),
                    "pitch": hw_data.get("pitch", 0),
                    "roll": hw_data.get("roll", 0),
                    "accel": hw_data.get("accel", [0, 0, 0])
                },
                "propulsion": {
                    "t1_pwm": hw_data.get("t1_pwm", 0),
                    "t2_pwm": hw_data.get("t2_pwm", 0),
                    "t3_pwm": hw_data.get("t3_pwm", 0),
                    "t4_pwm": hw_data.get("t4_pwm", 0)
                },
                "power": {
                    "voltage": hw_data.get("voltage", 0),
                    "current": hw_data.get("current", 0)
                }
            }
    
    def _get_offline_telemetry(self, mode: str) -> dict:
        """Return safe offline telemetry when hardware is not connected."""
        return {
            "state": {"isArmed": False, "mode": mode, "transitioning": self.transitioning},
            "sensors": {
                "depth": 0,
                "pressure": 1000,
                "temperature": 20,
                "leakDetected": False
            },
            "imu": {
                "yaw": 0,
                "pitch": 0,
                "roll": 0,
                "accel": [0, 0, 0]
            },
            "propulsion": {
                "t1_pwm": 0,
                "t2_pwm": 0,
                "t3_pwm": 0,
                "t4_pwm": 0
            },
            "power": {"voltage": 0, "current": 0}
        }

    def send_command(self, cmd_dict: dict):
        """
        E.g. {"t1": 50, "t2": 50, "t3": -10, "t4": -10}. Raises ValueError for anything that is not an object of
        finite numbers; values are clamped to -100..100 before they reach the physics or the MCU.
        """
        if not isinstance(cmd_dict, dict):
            raise ValueError("SET_PWM payload must be an object of t1..t4")
        pwm = {k: _pwm(cmd_dict.get(k, 0)) for k in ("t1", "t2", "t3", "t4")}
        if self.mode == "SIMULATION":
            self.sim_propulsion.set_pwm(pwm["t1"], pwm["t2"], pwm["t3"], pwm["t4"])
        else:
            # Hardware mode - route to SerialBridge
            if self.hardware_connected:
                self.serial_bridge.send_command(pwm)
    
    def set_mode(self, new_mode: str) -> dict:
        """
        Switch between SIMULATION and HARDWARE modes.
        Returns status dict with success/error information.
        """
        if new_mode not in MODES:
            return {"success": False, "message": f"Unknown mode {new_mode!r}; expected one of {', '.join(MODES)}"}
        if self.mode == new_mode:
            return {"success": True, "message": "Already in target mode"}

        self.transitioning = True

        if new_mode == "HARDWARE":
            # Reuse a live link; otherwise open the port, and fail honestly when it does not open
            if not (self.hardware_connected and self.serial_bridge.is_connected()):
                self.hardware_connected = self.serial_bridge.connect()
            self.transitioning = False
            if not self.hardware_connected:
                print(f"[HALBroker] Failed to connect to hardware on {self.serial_bridge.port}")
                return {"success": False, "message": f"Hardware connection failed: cannot open {self.serial_bridge.port}"}
            self.mode = new_mode
            print(f"[HALBroker] Switched to HARDWARE mode. Connected to {self.serial_bridge.port}")
            return {"success": True, "message": "Connected to hardware"}
        else:
            # Switch to simulation - disconnect hardware
            if self.hardware_connected:
                self.serial_bridge.disconnect()
                self.hardware_connected = False
            self.mode = new_mode
            self.transitioning = False
            print(f"[HALBroker] Switched to SIMULATION mode")
            return {"success": True, "message": "Switched to simulation"}
