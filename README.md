# HYDRALOOM

**Underwater ROV Digital Twin - Mission Control Dashboard**

A full-stack real-time telemetry dashboard for controlling and monitoring an underwater Remotely Operated Vehicle (ROV). HydraLoom fuses a Python edge-compute backend running YOLOv8 computer vision with a cinematic React/Three.js frontend to deliver a military-grade tactical interface for subsea operations.

---

## Table of Contents

- [What It Solves](#what-it-solves)
- [Architecture Overview](#architecture-overview)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Backend Setup](#backend-setup)
  - [Frontend Setup](#frontend-setup)
  - [Running Both Together](#running-both-together)
  - [Docker Deployment (Edge Compute)](#docker-deployment-edge-compute)
- [How It Works](#how-it-works)
  - [Data Flow](#data-flow)
  - [Hardware Abstraction Layer (HAL)](#hardware-abstraction-layer-hal)
  - [Vision Pipeline](#vision-pipeline)
  - [Simulation Mode vs Hardware Mode](#simulation-mode-vs-hardware-mode)
- [Dashboard Components](#dashboard-components)
- [API Reference](#api-reference)
- [Fault Injection System](#fault-injection-system)
- [Contributing](#contributing)

---

## What It Solves

Underwater ROV operations require real-time monitoring of depth, orientation, propulsion, and environmental conditions, often alongside live camera feeds analyzed by AI. Traditional ROV interfaces are either bare-bones terminal readouts or proprietary black boxes.

HydraLoom solves this by providing:

- **Real-time telemetry** at 50Hz over WebSocket, visualized through aerospace-grade HUD components
- **AI-powered computer vision** running YOLOv8 inference on live video, classifying underwater objects into tactical categories (shipwrecks, debris, biological contacts, structural damage)
- **Interactive propulsion control** with drag-to-adjust thruster PWM values
- **A physics-accurate simulation mode** for development and testing without physical hardware
- **Fault injection** to stress-test the dashboard under sensor loss, hull breach, and thruster failure scenarios
- **A drop-in Docker deployment** for Raspberry Pi 5 edge compute in the field

---

## Architecture Overview

```
+------------------+       WebSocket (50Hz)       +-------------------+
|                  | <===========================> |                   |
|    FRONTEND      |       MJPEG Stream           |     BACKEND       |
|    (Next.js)     | <===========================  |   (FastAPI)       |
|                  |       WebSocket (Commands)    |                   |
|  - React 19      | ============================> |  - YOLOv8         |
|  - Three.js/R3F  |                               |  - OpenCV         |
|  - Zustand       |                               |  - HAL Broker     |
|  - Framer Motion |                               |  - Physics Engine |
|  - Tailwind CSS  |                               |  - Fault Injector |
+------------------+                               +-------------------+
                                                          |
                                                    UART Serial
                                                          |
                                                    +-----------+
                                                    | FRDM MCU  |
                                                    | (Hardware)|
                                                    +-----------+
```

The backend runs as a FastAPI server that serves two WebSocket channels and one HTTP endpoint:

1. **`/ws/telemetry`** - Server pushes full telemetry state at 50Hz (20ms intervals)
2. **`/ws/command`** - Client sends commands (mode switch, fault injection, PWM control)
3. **`/video_feed`** - MJPEG stream of the processed camera feed for the frontend texture

---

## Tech Stack

### Frontend

| Technology | Purpose |
|---|---|
| **Next.js 16** | React framework with App Router |
| **React 19** | UI library |
| **Three.js / React Three Fiber** | GPU-accelerated underwater shader rendering, sonar visualization |
| **Zustand** | Lightweight state management for telemetry |
| **Framer Motion** | Animations for HUD elements |
| **Tailwind CSS 4** | Utility-first styling with custom tactical theme |
| **Lucide React** | Icon library |

### Backend

| Technology | Purpose |
|---|---|
| **FastAPI** | Async Python web framework |
| **Uvicorn** | ASGI server |
| **OpenCV** | Video capture, frame processing, MJPEG encoding |
| **Ultralytics YOLOv8** | Real-time object detection and tracking |
| **PySerial** | UART communication to FRDM MCU (hardware mode) |
| **NumPy** | Numerical computation for sensor simulation |
| **PyTorch** | YOLOv8 inference backend |

### Infrastructure

| Technology | Purpose |
|---|---|
| **Docker** | Containerized edge compute deployment |
| **GStreamer** | Low-latency UDP video streaming (hardware mode) |

---

## Project Structure

```
HydraLoom/
├── app/                          # Next.js App Router
│   ├── layout.tsx                # Root layout (Inter + Orbitron fonts, CRT overlay)
│   ├── page.tsx                  # Main dashboard page
│   └── globals.css               # Tactical color theme, glass panel utilities
│
├── components/                   # React components
│   ├── core/
│   │   ├── BootSequence.tsx      # Cinematic boot animation with audio
│   │   └── GlassPanel.tsx        # Reusable glass-morphism panel
│   ├── dashboard/
│   │   ├── Topbar.tsx            # Status bar (connection, FPS, battery)
│   │   └── ControlCenter.tsx     # Mode switcher + fault injection panel
│   ├── propulsion/
│   │   └── ThrusterPanel.tsx     # Interactive 4-thruster drag controls
│   ├── systems/
│   │   ├── RadarPanel.tsx        # Volumetric sonar shader (R3F)
│   │   └── SystemLogs.tsx        # Scrolling system log with YOLO events
│   ├── telemetry/
│   │   ├── ArtificialHorizon.tsx # Aerospace pitch ladder + roll display
│   │   └── DepthGauge.tsx        # Depth tape with crush-depth warning
│   └── video/
│       ├── VideoFeed.tsx         # MJPEG + underwater shader (R3F)
│       └── AIDetectionOverlay.tsx # Canvas-based YOLO bounding boxes
│
├── lib/                          # Shared utilities
│   ├── audio/
│   │   └── SynthEngine.ts        # Web Audio API boot sound effects
│   ├── hooks/
│   │   ├── useTelemetryBridge.ts # WebSocket bridge to backend
│   │   └── useTelemetrySimulator.ts # Client-side telemetry simulator
│   ├── store/
│   │   └── telemetryStore.ts     # Zustand store for all telemetry state
│   ├── utils/
│   │   └── motion.ts             # Framer Motion utilities
│   └── utils.ts                  # cn() Tailwind class merger
│
├── backend/                      # Python edge compute
│   ├── main.py                   # FastAPI server (WebSocket + MJPEG)
│   ├── vision_pipeline.py        # YOLOv8 inference + tactical classification
│   ├── serial_bridge.py          # UART bridge to FRDM MCU
│   ├── hal/
│   │   ├── broker.py             # Hardware Abstraction Layer broker
│   │   └── interfaces.py         # Abstract sensor interfaces
│   ├── simulation/
│   │   ├── physics_engine.py     # 4-thruster ROV physics simulation
│   │   ├── sensor_sim.py         # Simulated IMU, depth, propulsion
│   │   └── fault_injector.py     # Anomaly injection engine
│   ├── generate_video.py         # Procedural underwater video generator
│   ├── generate_shipwreck.py     # Shipwreck footage generator
│   ├── underwater.mp4            # Pre-generated simulation video
│   ├── yolov8n.pt               # YOLOv8 nano model weights
│   ├── requirements.txt          # Python dependencies
│   └── Dockerfile                # Edge compute container
│
├── docker-compose.yml            # Docker deployment config
├── package.json                  # Node.js dependencies
├── next.config.ts                # Next.js configuration
├── tsconfig.json                 # TypeScript configuration
├── tailwind.config.ts            # Tailwind CSS configuration
└── postcss.config.mjs            # PostCSS configuration
```

---

## Getting Started

### Prerequisites

- **Node.js** 18+ and npm
- **Python** 3.10+
- **Git**

### Backend Setup

```bash
# Navigate to backend directory
cd backend

# Create a virtual environment
python3 -m venv venv

# Activate the virtual environment
source venv/bin/activate    # macOS/Linux
# venv\Scripts\activate     # Windows

# Install dependencies
pip install -r requirements.txt

# Start the server
python main.py
```

The backend will start on `http://127.0.0.1:8000`. You can verify it is running by opening `http://127.0.0.1:8000/docs` in your browser to see the Swagger UI.

### Frontend Setup

```bash
# From the project root (HydraLoom/)
npm install

# Start the development server
npm run dev
```

The frontend will start on `http://localhost:3000`.

### Running Both Together

Open two terminal windows:

**Terminal 1 - Backend:**
```bash
cd backend
source venv/bin/activate
python main.py
```

**Terminal 2 - Frontend:**
```bash
npm run dev
```

Then open `http://localhost:3000` in your browser. The dashboard will connect to the backend via WebSocket automatically.

### Docker Deployment (Edge Compute)

For deploying on a Raspberry Pi 5 or other edge hardware:

```bash
# Build and start with Docker Compose
docker-compose up --build
```

The Docker configuration uses `network_mode: "host"` for low-latency UDP GStreamer streaming and mounts hardware device paths (`/dev/video0` for USB camera, `/dev/ttyAMA0` for UART serial).

---

## How It Works

### Data Flow

1. **Backend boots** and starts the physics engine (100Hz loop), vision pipeline, and fault injector
2. **Vision pipeline** captures frames from either a USB camera (hardware mode) or `underwater.mp4` (simulation mode), runs YOLOv8 tracking, and classifies detections into tactical labels
3. **Frontend connects** via two WebSocket channels:
   - Telemetry channel receives full state at 50Hz (depth, orientation, thrusters, power, vision detections)
   - Command channel sends user actions (mode switch, fault injection, PWM commands)
4. **Zustand store** hydrates on every telemetry packet, triggering React re-renders across all dashboard components
5. **Three.js shaders** read store state directly (bypassing React) for GPU-accelerated underwater effects and sonar rendering

### Hardware Abstraction Layer (HAL)

The HAL Broker (`backend/hal/broker.py`) is the central routing layer that determines whether telemetry comes from real hardware or the simulation:

- **SIMULATION mode** (default): Routes through `SimulatedIMU`, `SimulatedDepth`, and `SimulatedPropulsion`, all driven by the `ThrusterPhysicsEngine`
- **HARDWARE mode**: Routes through `SerialBridge` to the FRDM MCU over UART at 115200 baud

The physics engine runs a deterministic 100Hz loop calculating:
- Surge (forward/backward) from T1 + T2 differential
- Yaw (rotation) from T1 - T2 differential
- Heave (up/down) from T3 + T4
- Water drag, buoyancy, and pendulum stabilization

### Vision Pipeline

The vision pipeline (`backend/vision_pipeline.py`) processes video frames and runs YOLOv8 object detection with custom tactical classification:

| COCO Class | Tactical Label |
|---|---|
| 0 (person) | BIOLOGICAL_CONTACT |
| 4 (airplane) | DEBRIS |
| 8 (boat) | SHIPWRECK |
| 24 (backpack) | ANOMALY |
| 28 (suitcase) | UNDERWATER_PIPE |
| 32 (sports ball) | UNIDENTIFIED_OBJECT |
| 39 (bottle) | STRUCTURAL_DEBRIS |
| 41 (cup) | CORROSION |
| 58 (potted plant) | CRACK |

Detections are streamed to the frontend via the telemetry WebSocket and rendered as:
- Bounding boxes on the video feed (`AIDetectionOverlay`)
- Blips on the sonar display (`RadarPanel`)
- Log entries in the system log (`SystemLogs`)

### Simulation Mode vs Hardware Mode

| Feature | SIMULATION | HARDWARE |
|---|---|---|
| Video source | `underwater.mp4` loop | USB camera (`/dev/video0`) |
| Sensor data | Physics engine + noise | FRDM MCU via UART |
| Thruster control | Physics engine input | Serial command to MCU |
| Network | localhost | Tethered Ethernet |
| Use case | Development, testing, demo | Field deployment |

Switch between modes using the Control Center panel in the dashboard, or via the WebSocket command:
```json
{"type": "SET_MODE", "mode": "SIMULATION"}
```

---

## Dashboard Components

### Boot Sequence
A cinematic power-on animation that initializes the system with staged status messages and a synthesized generator spin-up sound effect.

### Topbar
Real-time status bar showing:
- Connection status (online/offline)
- Network latency (ms)
- Vision pipeline FPS
- Battery voltage
- Mission timer (UTC)

### Artificial Horizon
Aerospace-grade HUD with:
- Animated pitch ladder (4px per degree)
- Roll rotation with spring physics
- Fixed center reticle
- Heading, pitch, and roll digital readouts

### Depth Gauge
Vertical depth tape with:
- Smooth spring-animated sliding scale
- Digital depth readout in meters
- Crush-depth warning at 80m+
- Color shifts from cyan to red at critical depths

### Video Feed
GPU-accelerated underwater camera view using Three.js shaders:
- Real MJPEG texture from backend
- Physical light absorption (red attenuates first with depth)
- Caustic light patterns in shallow water
- Floating particle system
- CRT scanline and vignette overlays
- Tactical HUD elements (camera ID, detection count, target lock status)

### AI Detection Overlay
Canvas-based rendering of YOLOv8 detections with:
- Smoothed bounding box interpolation (lerp)
- Corner bracket styling with glow effects
- Scanning line animation
- Target lock confirmation after 600ms
- Color coding (cyan for normal, red for anomalies/cracks)

### Thruster Panel
Interactive propulsion diagnostics:
- 4 thruster indicators (T1-T4) arranged around ROV chassis outline
- Drag-to-adjust PWM (-100% to +100%)
- Visual thrust vectors (cyan for forward, red for reverse)
- Real-time PWM percentage readouts

### Sonar Panel
Volumetric sonar visualization using GLSL shaders:
- Expanding acoustic pulse rings with inverse-square decay
- Sweeping radar beam
- Concentric tactical grid
- YOLO-synced target blips with acoustic reflection rings
- Hardware yaw rotation sync

### System Logs
Scrolling terminal-style log with:
- Timestamped entries
- Color-coded severity (INFO/cyan, WARN/yellow, ERR/red)
- Auto-scrolling with animation
- YOLO detection events integrated in real-time

### Control Center
Floating control panel with:
- SIMULATION/HARDWARE mode toggle
- Fault injection buttons (SENSOR_LOSS, LEAK_DETECT, THRUSTER_OVERLOAD)

---

## API Reference

### REST Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/video_feed` | MJPEG live video stream |
| GET | `/docs` | Swagger UI documentation |
| GET | `/openapi.json` | OpenAPI schema |

### WebSocket Endpoints

#### `/ws/telemetry` (Server -> Client)

Pushes full telemetry state at 50Hz:

```json
{
  "timestamp": 1700000000000,
  "mode": "SIMULATION",
  "state": {
    "isArmed": true,
    "mode": "SIMULATION"
  },
  "sensors": {
    "depth": 42.5,
    "pressure": 5250,
    "temperature": 10.3,
    "leakDetected": false
  },
  "imu": {
    "yaw": 142.4,
    "pitch": 0.5,
    "roll": -0.2,
    "accel": [0.0, 0.0, 9.8]
  },
  "propulsion": {
    "t1_pwm": 45.0,
    "t2_pwm": 42.0,
    "t3_pwm": 20.0,
    "t4_pwm": 18.0
  },
  "power": {
    "voltage": 16.4,
    "current": 2.1
  },
  "vision": {
    "fps": 28.5,
    "detections": [
      {
        "id": 1,
        "class": "SHIPWRECK",
        "confidence": 0.87,
        "bbox": [0.5, 0.4, 0.2, 0.3]
      }
    ]
  }
}
```

#### `/ws/command` (Client -> Server)

Send commands as JSON text messages:

**Switch mode:**
```json
{"type": "SET_MODE", "mode": "SIMULATION"}
```

**Inject fault:**
```json
{"type": "INJECT_FAULT", "fault": "SENSOR_LOSS"}
```

Valid faults: `SENSOR_LOSS`, `LEAK_DETECT`, `THRUSTER_OVERLOAD`

**Set thruster PWM:**
```json
{"type": "SET_PWM", "payload": {"t1": 50, "t2": 50, "t3": -10, "t4": -10}}
```

---

## Fault Injection System

The fault injector (`backend/simulation/fault_injector.py`) allows testing dashboard resilience under failure conditions:

| Fault | Effect | Duration | Revert |
|---|---|---|---|
| `SENSOR_LOSS` | Massive noise spike on IMU and depth sensors | 8 seconds | Automatic |
| `LEAK_DETECT` | Triggers hull breach alarm overlay | 10 seconds | Automatic |
| `THRUSTER_OVERLOAD` | Drops T1 and T3 efficiency to 10% | 8 seconds | Automatic |

Additionally, the fault injector introduces random 5% chance of 200ms network freezes to simulate tether issues.

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## License

This project is private and proprietary.
