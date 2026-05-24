from simulation.physics_engine import ThrusterPhysicsEngine
from simulation.sensor_sim import SimulatedIMU, SimulatedDepth, SimulatedPropulsion

class HALBroker:
    """
    Hardware Abstraction Layer Broker.
    Routes telemetry requests to either physical hardware drivers or the digital twin simulation.
    """
    def __init__(self):
        self.mode = "SIMULATION" # Default to simulation
        
        # Initialize Digital Twin
        self.physics = ThrusterPhysicsEngine()
        self.sim_imu = SimulatedIMU(self.physics)
        self.sim_depth = SimulatedDepth(self.physics)
        self.sim_propulsion = SimulatedPropulsion(self.physics)
        
        # Start physics deterministic loop
        self.physics.start()
        
    def get_telemetry(self) -> dict:
        if self.mode == "SIMULATION":
            yaw, pitch, roll = self.sim_imu.get_orientation()
            t1, t2, t3, t4 = self.sim_propulsion.get_pwm()
            
            return {
                "state": {"isArmed": True, "mode": "SIMULATION"},
                "sensors": {
                    "depth": self.sim_depth.get_depth(),
                    "pressure": 1000 + (self.sim_depth.get_depth() * 100),
                    "temperature": self.sim_depth.get_temperature(),
                    "leakDetected": False
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
            # Here we would query the real Hardware Drivers (e.g. SerialBridge)
            # Fallback to simulation if hardware drops
            pass

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
            # Route to SerialBridge
            pass
