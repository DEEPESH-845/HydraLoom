from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
import asyncio
import time
import json
from serial_bridge import SerialBridge
from vision_pipeline import VisionPipeline

from hal.broker import HALBroker
from simulation.fault_injector import FaultInjector

app = FastAPI()

hal_broker = HALBroker()
fault_injector = FaultInjector(hal_broker)
vision_pipeline = VisionPipeline(mode=hal_broker.mode, physics=hal_broker.physics)

@app.on_event("startup")
async def startup_event():
    print("[Main] Booting Digital Twin Edge Compute...")
    fault_injector.start()
    vision_pipeline.start() # Enabled for MJPEG Live Video Feed

@app.get("/video_feed")
async def video_feed():
    """MJPEG Live Video Stream for Frontend Texture"""
    return StreamingResponse(vision_pipeline.generate_mjpeg_stream(), media_type="multipart/x-mixed-replace; boundary=frame")

@app.on_event("shutdown")
async def shutdown_event():
    fault_injector.stop()
    vision_pipeline.stop()

def get_full_telemetry():
    hw = hal_broker.get_telemetry()
    vis = vision_pipeline.get_vision_telemetry()
    
    return {
        "timestamp": int(time.time() * 1000),
        "mode": hal_broker.mode,
        "state": hw.get("state"),
        "sensors": hw.get("sensors"),
        "imu": hw.get("imu"),
        "propulsion": hw.get("propulsion"),
        "power": hw.get("power"),
        "vision": vis
    }

@app.websocket("/ws/telemetry")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            payload = get_full_telemetry()
            await websocket.send_json(payload)
            await asyncio.sleep(0.02)
    except Exception as e:
        # Catch WebSocketDisconnect, ConnectionClosedOK, etc.
        pass

@app.websocket("/ws/command")
async def command_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_text()
            cmd = json.loads(data)
            
            if cmd.get("type") == "SET_MODE":
                new_mode = cmd.get("mode")
                result = hal_broker.set_mode(new_mode)
                vision_pipeline.set_mode(new_mode)
                
                # Send mode switch result back to frontend
                await websocket.send_json({
                    "type": "MODE_SWITCH_RESULT",
                    "success": result["success"],
                    "message": result["message"],
                    "mode": hal_broker.mode
                })
                print(f"[Main] Mode switch to {new_mode}: {result['message']}")
            elif cmd.get("type") == "INJECT_FAULT":
                fault_injector.trigger_anomaly(cmd.get("fault"))
            elif cmd.get("type") == "SET_PWM":
                hal_broker.send_command(cmd.get("payload"))
    except Exception as e:
        # Catch WebSocketDisconnect, ConnectionClosedOK, etc.
        pass

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
