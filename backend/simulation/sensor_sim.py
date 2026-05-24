import numpy as np
from typing import Tuple
from hal.interfaces import IMUInterface, EnvironmentInterface, PowerInterface, PropulsionInterface
from simulation.physics_engine import ThrusterPhysicsEngine

class SimulatedIMU(IMUInterface):
    def __init__(self, physics: ThrusterPhysicsEngine):
        self.physics = physics
        self.noise_std = 0.05
        
    def connect(self) -> bool: return True
    def is_connected(self) -> bool: return True
        
    def get_orientation(self) -> Tuple[float, float, float]:
        state = self.physics.get_state()
        # Inject Gaussian noise to simulate cheap MPU6050 jitter
        yaw = state["yaw"] + np.random.normal(0, self.noise_std)
        pitch = state["pitch"] + np.random.normal(0, self.noise_std)
        roll = state["roll"] + np.random.normal(0, self.noise_std)
        return (yaw, pitch, roll)

    def get_acceleration(self) -> Tuple[float, float, float]:
        return (0.0, 0.0, 9.8 + np.random.normal(0, 0.1))

class SimulatedDepth(EnvironmentInterface):
    def __init__(self, physics: ThrusterPhysicsEngine):
        self.physics = physics
        self.base_temp = 14.5
        
    def connect(self) -> bool: return True
    def is_connected(self) -> bool: return True

    def get_depth(self) -> float:
        state = self.physics.get_state()
        # Add slight barometric noise
        return state["depth"] + np.random.normal(0, 0.02)
        
    def get_temperature(self) -> float:
        # Deeper = Colder
        depth = self.get_depth()
        temp = self.base_temp - (depth * 0.1)
        return temp + np.random.normal(0, 0.05)

class SimulatedPropulsion(PropulsionInterface):
    def __init__(self, physics: ThrusterPhysicsEngine):
        self.physics = physics
        
    def set_pwm(self, t1: float, t2: float, t3: float, t4: float) -> None:
        self.physics.set_pwm(t1, t2, t3, t4)
        
    def get_pwm(self) -> Tuple[float, float, float, float]:
        return (self.physics.t1, self.physics.t2, self.physics.t3, self.physics.t4)
