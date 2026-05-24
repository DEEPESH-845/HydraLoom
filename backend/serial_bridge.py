import serial
import threading
import json
import time

class SerialBridge:
    def __init__(self, port="/dev/ttyAMA0", baudrate=115200):
        self.port = port
        self.baudrate = baudrate
        self.serial_conn = None
        self.latest_telemetry = {}
        self.running = False
        self.lock = threading.Lock()

    def connect(self):
        try:
            self.serial_conn = serial.Serial(self.port, self.baudrate, timeout=1)
            self.running = True
            threading.Thread(target=self._read_loop, daemon=True).start()
            print(f"[SerialBridge] Connected to FRDM MCU on {self.port} at {self.baudrate} baud.")
        except Exception as e:
            print(f"[SerialBridge] Failed to connect: {e}")

    def _read_loop(self):
        while self.running and self.serial_conn:
            try:
                line = self.serial_conn.readline().decode('utf-8').strip()
                if line:
                    data = json.loads(line)
                    with self.lock:
                        self.latest_telemetry = data
            except json.JSONDecodeError:
                pass # Ignore malformed packets from UART noise
            except Exception as e:
                print(f"[SerialBridge] Read error: {e}")
                time.sleep(1)

    def send_command(self, cmd_dict):
        if self.serial_conn and self.serial_conn.is_open:
            cmd_str = json.dumps(cmd_dict) + "\n"
            self.serial_conn.write(cmd_str.encode('utf-8'))

    def get_latest(self):
        with self.lock:
            return self.latest_telemetry.copy()

    def disconnect(self):
        self.running = False
        if self.serial_conn:
            self.serial_conn.close()
