from abc import ABC, abstractmethod
from typing import Tuple

class SensorHAL(ABC):
    @abstractmethod
    def connect(self) -> bool:
        pass
        
    @abstractmethod
    def is_connected(self) -> bool:
        pass

class IMUInterface(SensorHAL):
    @abstractmethod
    def get_orientation(self) -> Tuple[float, float, float]:
        """Returns Yaw, Pitch, Roll in degrees"""
        pass
        
    @abstractmethod
    def get_acceleration(self) -> Tuple[float, float, float]:
        """Returns X, Y, Z acceleration in m/s^2"""
        pass

class EnvironmentInterface(SensorHAL):
    @abstractmethod
    def get_depth(self) -> float:
        """Returns depth in meters"""
        pass
        
    @abstractmethod
    def get_temperature(self) -> float:
        """Returns temperature in celsius"""
        pass

class PowerInterface(SensorHAL):
    @abstractmethod
    def get_voltage(self) -> float:
        pass

class PropulsionInterface(ABC):
    @abstractmethod
    def set_pwm(self, t1: float, t2: float, t3: float, t4: float) -> None:
        """Sets PWM values from -100 to 100"""
        pass
        
    @abstractmethod
    def get_pwm(self) -> Tuple[float, float, float, float]:
        pass
