"use client";

import { useRef, useMemo } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useTelemetryStore } from "@/lib/store/telemetryStore";

// Advanced Volumetric Sonar Shader Material
const SonarShader = () => {
  const meshRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const { viewport } = useThree();

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uColor: { value: new THREE.Color("#00F0FF") },
      uBgColor: { value: new THREE.Color("#010508") },
      uYaw: { value: 0 }, // Hardware Yaw sync
      uPings: { value: [new THREE.Vector2(-99, -99), new THREE.Vector2(-99, -99), new THREE.Vector2(-99, -99), new THREE.Vector2(-99, -99)] }, // Max 4 targets
      uPingTimes: { value: [0, 0, 0, 0] }, // Time when YOLO target was last seen
    }),
    []
  );

  useFrame((state) => {
    if (materialRef.current) {
      materialRef.current.uniforms.uTime.value = state.clock.elapsedTime;
      
      const store = useTelemetryStore.getState();
      materialRef.current.uniforms.uYaw.value = store.yaw * (Math.PI / 180.0); // Convert to radians

      // Sync YOLO Detections to Sonar Blips
      const pings = [new THREE.Vector2(-99, -99), new THREE.Vector2(-99, -99), new THREE.Vector2(-99, -99), new THREE.Vector2(-99, -99)];
      const pingTimes = [0, 0, 0, 0];
      
      store.detections.forEach((d, i) => {
        if (i < 4) {
          // Map 2D bounding box X center [0-1] to an angle relative to ROV forward
          // Assume camera FOV is ~90 degrees
          const fov_rad = Math.PI / 2;
          const target_angle = (d.bbox[0] - 0.5) * fov_rad;
          
          // Infer fake distance based on YOLO bounding box size (bigger = closer)
          const size = d.bbox[2] * d.bbox[3];
          const distance = Math.max(0.2, 1.0 - (size * 5)); // Normalize to 0-1 radar radius

          // Convert polar to cartesian
          pings[i] = new THREE.Vector2(
            Math.sin(target_angle) * distance,
            Math.cos(target_angle) * distance
          );
          pingTimes[i] = state.clock.elapsedTime; // Register recent hit
        }
      });
      
      materialRef.current.uniforms.uPings.value = pings;
      materialRef.current.uniforms.uPingTimes.value = pingTimes;
    }
  });

  return (
    <mesh ref={meshRef}>
      <planeGeometry args={[viewport.width, viewport.height]} />
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        transparent={true}
        vertexShader={`
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `}
        fragmentShader={`
          uniform float uTime;
          uniform float uYaw;
          uniform vec3 uColor;
          uniform vec3 uBgColor;
          uniform vec2 uPings[4];
          uniform float uPingTimes[4];
          varying vec2 vUv;

          #define PI 3.14159265359

          // 2D Rotation Matrix
          mat2 rotate2d(float _angle){
              return mat2(cos(_angle),-sin(_angle),
                          sin(_angle),cos(_angle));
          }

          // Random noise for sonar fog
          float hash(vec2 p) {
            return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
          }

          void main() {
            vec2 cUv = vUv * 2.0 - 1.0;
            float dist = length(cUv);

            // Circular boundary
            if (dist > 0.95) {
              gl_FragColor = vec4(0.0);
              return;
            }

            // Rotate entire radar map opposite to ROV yaw to create "True North" stabilization effect
            // Wait, standard ROV sonar sweeps relative to ROV. Let's keep it relative to ROV, but rotate the background fog based on yaw.
            vec2 worldUv = rotate2d(uYaw) * cUv;

            // Volumetric Sonar Fog (Simulating acoustic interference in water)
            float fogNoise = hash(floor(worldUv * 20.0 + uTime * 2.0));
            vec3 color = mix(uBgColor, uColor, fogNoise * 0.05);

            // Expanding acoustic pulse rings (pinging outwards)
            float pulse = fract(-uTime * 0.5 + dist * 5.0);
            if (pulse < 0.1) {
              color = mix(color, uColor, 0.1 * (1.0 - dist));
            }

            // Concentric grid lines
            float rings = fract(dist * 8.0);
            if (rings < 0.05) color = mix(color, uColor, 0.15);

            // Crosshairs
            if (abs(cUv.x) < 0.005 || abs(cUv.y) < 0.005) {
              color = mix(color, uColor, 0.2);
            }

            // Sweeping radar beam
            float angle = atan(cUv.x, cUv.y); // Note x/y swapped so 0 is up (forward)
            if (angle < 0.0) angle += 2.0 * PI;
            
            float sweepAngle = mod(-uTime * 3.0, 2.0 * PI);
            float diff = sweepAngle - angle;
            if (diff < 0.0) diff += 2.0 * PI;

            // Sweeping gradient
            if (diff < 1.0) {
              float intensity = 1.0 - diff;
              color = mix(color, uColor, intensity * 0.6);
            }

            // Render YOLO synchronized target blips
            for(int i=0; i<4; i++) {
              if (uPings[i].x == -99.0) continue;

              float dPing = length(cUv - uPings[i]);
              float timeSincePing = uTime - uPingTimes[i];
              
              if (dPing < 0.04) {
                // Flash intensely then fade
                float fade = max(0.0, 1.0 - (timeSincePing * 2.0));
                
                // Add a warning red to the blip if it's close
                vec3 blipColor = mix(uColor, vec3(1.0, 0.0, 0.0), 0.8);
                
                color = mix(color, blipColor, fade * (1.0 - (dPing / 0.04)));
              }
              
              // Draw an acoustic reflection ring around the target
              float ringDist = abs(dPing - (timeSincePing * 0.2));
              if (ringDist < 0.01 && timeSincePing < 1.0) {
                 color = mix(color, vec3(1.0,0.0,0.0), 0.5 * (1.0 - timeSincePing));
              }
            }

            // Add outer vignette
            color *= smoothstep(0.95, 0.6, dist);

            gl_FragColor = vec4(color, 1.0);
          }
        `}
      />
    </mesh>
  );
};

export function RadarPanel() {
  return (
    <div className="relative w-full h-full bg-tactical-abyss overflow-hidden rounded-xl border border-tactical-cyan/20">
      <Canvas orthographic camera={{ zoom: 100 }}>
        <color attach="background" args={["#010508"]} />
        <SonarShader />
      </Canvas>
      
      {/* Overlay Framework */}
      <div className="absolute inset-0 pointer-events-none rounded-xl border-[1px] border-tactical-cyan/40 shadow-[inset_0_0_40px_rgba(0,240,255,0.15)]">
        {/* Corner Brackets */}
        <div className="absolute top-0 left-0 w-8 h-8 border-t-2 border-l-2 border-tactical-cyan m-2 opacity-50" />
        <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 border-tactical-cyan m-2 opacity-50" />
        <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-tactical-cyan m-2 opacity-50" />
        <div className="absolute bottom-0 right-0 w-8 h-8 border-b-2 border-r-2 border-tactical-cyan m-2 opacity-50" />
        
        <div className="absolute top-3 left-4 text-[10px] font-mono font-bold tracking-widest text-tactical-cyan drop-shadow-md">
          ACOUSTIC_SWEEP_ACTV
        </div>
        
        <div className="absolute bottom-3 right-4 text-[10px] font-mono text-tactical-cyan/60 flex items-center">
          <div className="w-2 h-2 bg-tactical-cyan rounded-full mr-2 animate-pulse" />
          YOLO_SYNC_LOCK
        </div>
      </div>
    </div>
  );
}
