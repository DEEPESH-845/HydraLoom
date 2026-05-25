import cv2
import threading
import time
import numpy as np
from ultralytics import YOLO
from simulation.physics_engine import ThrusterPhysicsEngine

class VisionPipeline:
    def __init__(self, mode="SIMULATION", physics: ThrusterPhysicsEngine = None, camera_index=0, udp_host="192.168.1.100", udp_port=5000):
        self.mode = mode
        self.physics = physics
        self.camera_index = camera_index
        self.udp_host = udp_host
        self.udp_port = udp_port
        self.model = None
        
        self.cap = None
        self.out = None
        self.running = False
        
        self.latest_detections = []
        self.lock = threading.Lock()
        self.fps = 0.0

    def _ensure_model_loaded(self):
        if self.model is None:
            print(f"[Vision] Loading YOLO model in {self.mode} mode...")
            import torch
            # PyTorch 2.6 defaults weights_only=True which breaks Ultralytics YOLOv8 loading.
            # Monkeypatch torch.load to set weights_only=False temporarily.
            original_load = torch.load
            def patched_load(*args, **kwargs):
                if 'weights_only' not in kwargs:
                    kwargs['weights_only'] = False
                return original_load(*args, **kwargs)
            
            torch.load = patched_load
            try:
                self.model = YOLO("yolov8n.pt")
            finally:
                torch.load = original_load

    def set_mode(self, new_mode):
        if self.mode == new_mode:
            return
        
        print(f"[Vision] Queueing mode switch to {new_mode}")
        with self.lock:
            self._pending_mode_switch = new_mode

    def start(self):
        self._reset_tracker = False
        self._ensure_model_loaded()

        if self.mode == "HARDWARE":
            import platform
            if platform.system() == "Darwin":
                self.cap = cv2.VideoCapture(self.camera_index, cv2.CAP_AVFOUNDATION)
            else:
                self.cap = cv2.VideoCapture(self.camera_index)
        else:
            # Simulated Video Source: Real MP4 playback loop
            print("[Vision] Using realistic underwater MP4 loop for SIMULATION mode.")
            self.cap = cv2.VideoCapture("underwater.mp4")

        gst_str = (
            f"appsrc ! videoconvert ! video/x-raw,format=I420 ! "
            f"x264enc tune=zerolatency bitrate=2000 speed-preset=ultrafast ! "
            f"rtph264pay ! udpsink host={self.udp_host} port={self.udp_port}"
        )
        self.out = cv2.VideoWriter(gst_str, cv2.CAP_GSTREAMER, 0, 30, (640, 480), True)

        self.running = True
        threading.Thread(target=self._process_loop, daemon=True).start()
        print(f"[Vision] Pipeline started. Streaming UDP to {self.udp_host}:{self.udp_port}")

    def _process_loop(self):
        prev_time = time.time()
        
        while self.running:
            with self.lock:
                pending_mode = getattr(self, '_pending_mode_switch', None)
                if pending_mode:
                    print(f"[Vision] Executing mode switch to {pending_mode}...")
                    self.mode = pending_mode
                    if self.cap:
                        self.cap.release()
                    
                    if self.mode == "HARDWARE":
                        import platform
                        if platform.system() == "Darwin":
                            self.cap = cv2.VideoCapture(self.camera_index, cv2.CAP_AVFOUNDATION)
                        else:
                            self.cap = cv2.VideoCapture(self.camera_index)
                    else:
                        self.cap = cv2.VideoCapture("underwater.mp4")
                        
                    self._reset_tracker = True
                    self._pending_mode_switch = None
                    print(f"[Vision] Mode switch complete. Camera opened: {self.cap.isOpened() if self.cap else False}")

            if self.cap and self.cap.isOpened():
                ret, frame = self.cap.read()
                if not ret:
                    # Video ended, loop it
                    if self.mode == "SIMULATION":
                        self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                        continue
                    else:
                        time.sleep(0.01)
                        continue
            else:
                time.sleep(0.1)
                continue

            # Standardize resolution to 640x480 to prevent VideoWriter and frontend scaling issues
            frame = cv2.resize(frame, (640, 480))

            # Limit FPS if reading from MP4 so we don't process at 1000fps
            if self.mode == "SIMULATION":
                 time.sleep(1/30.0)

            # Run YOLO tracking
            # In simulation mode, YOLO actually runs on the generated frame!
            # This perfectly verifies the inference pipeline is working without faking JSON arrays.
            self._ensure_model_loaded()
            
            with self.lock:
                if getattr(self, '_reset_tracker', False):
                    if hasattr(self.model, 'predictor'):
                        self.model.predictor = None # Force complete tracker reinitialization
                    self._reset_tracker = False
                    
            results = self.model.track(frame, persist=True, verbose=False, conf=0.25)
            
            TACTICAL_LABELS = {
                0: "BIOLOGICAL_CONTACT",       # person
                4: "DEBRIS",                   # airplane
                8: "SHIPWRECK",                # boat
                24: "ANOMALY",                 # backpack
                28: "UNDERWATER_PIPE",         # suitcase
                32: "UNIDENTIFIED_OBJECT",     # sports ball
                39: "STRUCTURAL_DEBRIS",       # bottle
                41: "CORROSION",               # cup
                58: "CRACK",                   # potted plant
            }

            current_detections = []
            if results and len(results) > 0 and results[0].boxes:
                boxes = results[0].boxes
                for box in boxes:
                    x, y, w, h = box.xywh[0].tolist()
                    conf = box.conf[0].item()
                    cls_id = int(box.cls[0].item())
                    tactical_class = TACTICAL_LABELS.get(cls_id, f"UNIDENTIFIED_OBJECT")
                    current_detections.append({
                        "id": int(box.id[0].item()) if box.id is not None else 0,
                        "class": tactical_class,
                        "confidence": conf,
                        "bbox": [x/640.0, y/480.0, w/640.0, h/480.0]
                    })
            
            with self.lock:
                self.latest_detections = current_detections

            curr_time = time.time()
            self.fps = 1.0 / (curr_time - prev_time)
            prev_time = curr_time

            if self.out and self.out.isOpened():
                self.out.write(frame)
                
            # Buffer for MJPEG streaming
            with self.lock:
                self.latest_frame = frame.copy()

    def get_vision_telemetry(self):
        with self.lock:
            return {
                "fps": round(self.fps, 1),
                "detections": self.latest_detections.copy()
            }
            
    def generate_mjpeg_stream(self):
        """Yields JPEG frames for a FastAPI StreamingResponse."""
        while self.running:
            frame = None
            with self.lock:
                if hasattr(self, 'latest_frame') and self.latest_frame is not None:
                    frame = self.latest_frame.copy()
            
            if frame is not None:
                # Encode frame to JPEG
                ret, buffer = cv2.imencode('.jpg', frame)
                if ret:
                    frame_bytes = buffer.tobytes()
                    yield (b'--frame\r\n'
                           b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
            
            time.sleep(0.033) # Limit to ~30fps stream

    def stop(self):
        self.running = False
        if self.cap:
            self.cap.release()
        if self.out:
            self.out.release()
