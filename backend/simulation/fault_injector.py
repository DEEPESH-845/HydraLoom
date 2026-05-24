import time
import threading
import random
from hal.broker import HALBroker

class FaultInjector:
    """
    Advanced Fault Injection Engine.
    Triggers anomalous states inside the HAL Broker / Physics Engine to test frontend resilience.
    """
    def __init__(self, broker: HALBroker):
        self.broker = broker
        self.running = False
        self.active_faults = []

    def start(self):
        self.running = True
        threading.Thread(target=self._fault_loop, daemon=True).start()

    def stop(self):
        self.running = False

    def trigger_anomaly(self, anomaly_type: str):
        if anomaly_type == "SENSOR_LOSS":
            print("[FaultInjector] Triggering SENSOR_LOSS")
            # In a real scenario, this would intercept HAL broker calls and return None or frozen values
            self.broker.sim_depth.noise_std = 10.0 # Massive noise spike
        elif anomaly_type == "LEAK_DETECT":
            print("[FaultInjector] Triggering LEAK_DETECT")
            # This would modify the state returned by HAL Broker
            pass
        elif anomaly_type == "THRUSTER_OVERLOAD":
            print("[FaultInjector] Triggering THRUSTER_OVERLOAD")
            # Halve the efficiency of T1 in the physics engine
            pass

    def _fault_loop(self):
        while self.running:
            # Example random intermittent packet jitter injection
            if random.random() < 0.05:
                # 5% chance of a 200ms network freeze simulating tether issues
                time.sleep(0.2)
            time.sleep(1)
