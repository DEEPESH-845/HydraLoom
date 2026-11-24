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
        # healthy sensor noise, restored when a SENSOR_LOSS fault ends
        self._noise_baseline = (broker.sim_depth.noise_std, broker.sim_imu.noise_std)

    def start(self):
        self.running = True
        threading.Thread(target=self._fault_loop, daemon=True).start()

    def stop(self):
        self.running = False

    def trigger_anomaly(self, anomaly_type: str):
        if anomaly_type == "SENSOR_LOSS":
            print("[FaultInjector] Triggering SENSOR_LOSS")
            self.broker.sim_depth.noise_std = 15.0 # Massive noise spike
            self.broker.sim_imu.noise_std = 10.0
            threading.Timer(8.0, self._revert_sensor_loss).start()
            
        elif anomaly_type == "LEAK_DETECT":
            print("[FaultInjector] Triggering LEAK_DETECT")
            self.broker.leak_detected = True
            threading.Timer(10.0, self._revert_leak).start()
            
        elif anomaly_type == "THRUSTER_OVERLOAD":
            print("[FaultInjector] Triggering THRUSTER_OVERLOAD")
            # Drop efficiency of T1 and T3 to 10%
            self.broker.physics.efficiency = [0.1, 1.0, 0.1, 1.0]
            threading.Timer(8.0, self._revert_thruster).start()

    def _revert_sensor_loss(self):
        print("[FaultInjector] Reverting SENSOR_LOSS")
        self.broker.sim_depth.noise_std, self.broker.sim_imu.noise_std = self._noise_baseline
        
    def _revert_leak(self):
        print("[FaultInjector] Reverting LEAK_DETECT")
        self.broker.leak_detected = False
        
    def _revert_thruster(self):
        print("[FaultInjector] Reverting THRUSTER_OVERLOAD")
        self.broker.physics.efficiency = [1.0, 1.0, 1.0, 1.0]

    def _fault_loop(self):
        while self.running:
            # Example random intermittent packet jitter injection
            if random.random() < 0.05:
                # 5% chance of a 200ms network freeze simulating tether issues
                time.sleep(0.2)
            time.sleep(1)
