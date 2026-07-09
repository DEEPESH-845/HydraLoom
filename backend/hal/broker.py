from simulation.physics_engine import ThrusterPhysicsEngine
from simulation.sensor_sim import SimulatedIMU, SimulatedDepth, SimulatedPropulsion
from serial_bridge import SerialBridge

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
        
        # Attempt hardware connection on startup
        try:
            self.serial_bridge.connect()
            self.hardware_connected = True
        except Exception as e:
            print(f"[HAL] Hardware connection failed: {e}. Falling back to SIMULATION.")
            self.hardware_connected = False
        
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
        # E.g. {"t1": 50, "t2": 50, "t3": -10, "t4": -10}
        if self.mode == "SIMULATION":
            self.sim_propulsion.set_pwm(
                cmd_dict.get("t1", 0),
                cmd_dict.get("t2", 0),
                cmd_dict.get("t3", 0),
                cmd_dict.get("t4", 0)
            )
        else:
            # Hardware mode - route to SerialBridge
            if self.hardware_connected:
                self.serial_bridge.send_command(cmd_dict)
    
    def set_mode(self, new_mode: str) -> dict:
        """
        Switch between SIMULATION and HARDWARE modes.
        Returns status dict with success/error information.
        """
        if self.mode == new_mode:
            return {"success": True, "message": "Already in target mode"}
        
        self.transitioning = True
        
        if new_mode == "HARDWARE":
            # Connect to hardware
            try:
                self.serial_bridge.connect()
                self.hardware_connected = True
                self.mode = new_mode
                self.transitioning = False
                print(f"[HALBroker] Switched to HARDWARE mode. Connected to {self.serial_bridge.port}")
                return {"success": True, "message": "Connected to hardware"}
            except Exception as e:
                self.transitioning = False
                self.hardware_connected = False
                print(f"[HALBroker] Failed to connect to hardware: {e}")
                return {"success": False, "message": f"Hardware connection failed: {str(e)}"}
        else:
            # Switch to simulation - disconnect hardware
            if self.hardware_connected:
                self.serial_bridge.disconnect()
                self.hardware_connected = False
            self.mode = new_mode
            self.transitioning = False
            print(f"[HALBroker] Switched to SIMULATION mode")
            return {"success": True, "message": "Switched to simulation"}
