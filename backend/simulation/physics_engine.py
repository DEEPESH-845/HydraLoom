import time
import math
import threading
from typing import Tuple

class ThrusterPhysicsEngine:
    """
    Simulates the physics of a 4-thruster ROV.
    Calculates surge, yaw, and heave based on PWM inputs, mass, and water resistance.
    """
    def __init__(self):
        # State vectors
        self.yaw = 142.4
        self.depth = 42.5
        self.pitch = 0.0
        self.roll = 0.0
        
        # Velocity vectors
        self.yaw_vel = 0.0
        self.depth_vel = 0.0
        
        # Physical constants
        self.mass = 12.0 # kg
        self.rotational_inertia = 0.8
        self.water_drag_coeff = 2.5
        self.angular_drag_coeff = 1.2
        self.buoyancy_offset = 0.02 # Slightly positively buoyant
        
        # Current PWM
        self.t1 = 0.0
        self.t2 = 0.0
        self.t3 = 0.0
        self.t4 = 0.0
        
        self.running = False
        self.lock = threading.Lock()
        
    def start(self):
        self.running = True
        threading.Thread(target=self._physics_loop, daemon=True).start()
        
    def stop(self):
        self.running = False
        
    def set_pwm(self, t1: float, t2: float, t3: float, t4: float):
        with self.lock:
            self.t1 = t1
            self.t2 = t2
            self.t3 = t3
            self.t4 = t4
            
    def get_state(self) -> dict:
        with self.lock:
            return {
                "yaw": self.yaw,
                "pitch": self.pitch,
                "roll": self.roll,
                "depth": self.depth
            }

    def _physics_loop(self):
        dt = 0.01 # 100Hz loop
        while self.running:
            with self.lock:
                # 1. Map PWM to physical force (simplified curve)
                # Let t1/t2 be forward/reverse (surge & yaw)
                # Let t3/t4 be vertical (heave)
                
                f_fwd = (self.t1 + self.t2) * 0.1
                f_yaw = (self.t1 - self.t2) * 0.05
                f_heave = (self.t3 + self.t4) * 0.1
                
                # 2. Calculate Accelerations
                accel_yaw = f_yaw / self.rotational_inertia
                # Gravity + Buoyancy + Thruster force
                accel_depth = (f_heave / self.mass) - self.buoyancy_offset
                
                # 3. Apply Drag (proportional to square of velocity, but linear for low speeds)
                drag_yaw = -self.angular_drag_coeff * self.yaw_vel
                drag_depth = -self.water_drag_coeff * self.depth_vel
                
                accel_yaw += drag_yaw
                accel_depth += drag_depth
                
                # 4. Euler Integration
                self.yaw_vel += accel_yaw * dt
                self.depth_vel += accel_depth * dt
                
                self.yaw = (self.yaw + self.yaw_vel * dt) % 360.0
                self.depth += self.depth_vel * dt
                
                # Surface floor limit
                if self.depth < 0:
                    self.depth = 0
                    self.depth_vel = 0
                    
                # Passive roll/pitch stabilization (pendulum effect)
                self.roll *= 0.98
                self.pitch *= 0.98
                
            time.sleep(dt)
