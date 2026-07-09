import { useEffect, useRef } from "react";
import { useTelemetryStore } from "../store/telemetryStore";

/**
 * Replaces the mock simulator with a real WebSocket bridge to the Raspberry Pi 5.
 */
export function useTelemetryBridge(wsUrl = "ws://127.0.0.1:8000/ws/telemetry") {
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let reconnectTimer: NodeJS.Timeout;

    const connect = () => {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[TelemetryBridge] Connected to Edge Compute.");
        useTelemetryStore.setState({ isOnline: true });
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          
          // Calculate one-way latency approximation
          const latency = Date.now() - payload.timestamp;

          // Hydrate the Zustand store with real hardware data
          useTelemetryStore.setState({
            mode: payload.mode || "SIMULATION",
            transitioning: payload.state?.transitioning || false,
            yaw: payload.imu.yaw,
            pitch: payload.imu.pitch,
            roll: payload.imu.roll,
            depth: payload.sensors.depth,
            temperature: payload.sensors.temperature,
            leakDetected: payload.sensors.leakDetected || false,
            battery: payload.power.voltage,
            thrusters: {
              t1: payload.propulsion.t1_pwm,
              t2: payload.propulsion.t2_pwm,
              t3: payload.propulsion.t3_pwm,
              t4: payload.propulsion.t4_pwm,
            },
            latency: latency > 0 ? latency : 5, // fallback if clock sync is off
            fps: payload.vision.fps,
            // Detections are managed directly via WebSocket but we could put them in store here
            detections: payload.vision.detections,
          });
        } catch (err) {
          console.error("[TelemetryBridge] Packet parsing error", err);
        }
      };

      ws.onclose = () => {
        console.warn("[TelemetryBridge] Disconnected. Retrying in 2s...");
        useTelemetryStore.setState({ isOnline: false });
        reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onerror = (err) => {
        ws.close();
      };
    };

    const connectCmd = () => {
      const cmdWs = new WebSocket("ws://127.0.0.1:8000/ws/command");
      cmdWs.onopen = () => {
        console.log("[TelemetryBridge] Command Socket Connected.");
        useTelemetryStore.setState({
          sendCommand: (cmd: object) => {
            if (cmdWs.readyState === WebSocket.OPEN) {
              // Set transitioning state when sending mode switch command
              if ((cmd as any).type === "SET_MODE") {
                useTelemetryStore.setState({ transitioning: true, transitionError: null });
              }
              cmdWs.send(JSON.stringify(cmd));
            } else {
              console.warn("Command socket not open.");
            }
          }
        });
      };
      
      // Handle mode switch results from server
      cmdWs.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "MODE_SWITCH_RESULT") {
            useTelemetryStore.setState({ 
              transitioning: false,
              transitionError: data.success ? null : data.message,
              mode: data.mode
            });
            if (!data.success) {
              console.error("[TelemetryBridge] Mode switch failed:", data.message);
            }
          }
        } catch (err) {
          // Ignore non-JSON messages
        }
      };
      
      cmdWs.onclose = () => {
        useTelemetryStore.setState({ sendCommand: (cmd) => console.warn("Command socket offline", cmd) });
        setTimeout(connectCmd, 2000);
      };
      cmdWs.onerror = () => cmdWs.close();
      return cmdWs;
    };

    connect();
    const cmdWsInstance = connectCmd();

    return () => {
      clearTimeout(reconnectTimer);
      if (wsRef.current) wsRef.current.close();
      cmdWsInstance.close();
    };
  }, [wsUrl]);

  return wsRef.current;
}
