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

          mat2 rotate2d(float _angle){
              return mat2(cos(_angle),-sin(_angle), sin(_angle),cos(_angle));
          }

          void main() {
            vec2 cUv = vUv * 2.0 - 1.0;
            float dist = length(cUv);

            // Circular boundary mask
            if (dist > 0.98) {
              gl_FragColor = vec4(0.0);
              return;
            }

            vec2 worldUv = rotate2d(uYaw) * cUv;

            // Stable, lightweight ambient sonar glow (replaces heavy fbm noise)
            float stableGlow = sin(dist * 10.0 - uTime * 0.5) * 0.5 + 0.5;
            vec3 color = mix(uBgColor, uColor, stableGlow * 0.05);

            // Expanding acoustic pulse rings (Inverse-square decay)
            float pulseWave = fract(-uTime * 0.3 + dist * 3.0);
            float pulseIntensity = smoothstep(0.0, 0.1, pulseWave) * smoothstep(0.2, 0.1, pulseWave);
            float attenuation = 1.0 / (1.0 + 5.0 * dist * dist); // Inverse square
            color += uColor * pulseIntensity * attenuation * 0.3;

            // Concentric grid lines (Tactical Grid)
            float rings = fract(dist * 8.0);
            if (rings < 0.03) color += uColor * 0.2;
            if (rings < 0.01) color += uColor * 0.4; // Brighter core line

            // Crosshairs
            if (abs(cUv.x) < 0.005 || abs(cUv.y) < 0.005) {
              color += uColor * 0.15;
            }

            // Sweeping radar beam
            float angle = atan(cUv.x, cUv.y);
            if (angle < 0.0) angle += 2.0 * PI;
            float sweepAngle = mod(-uTime * 2.5, 2.0 * PI);
            float diff = sweepAngle - angle;
            if (diff < 0.0) diff += 2.0 * PI;

            // Sweeping gradient
            if (diff < 1.0) {
              float intensity = 1.0 - diff;
              color += uColor * (intensity * intensity) * 0.8;
            }

            // Render YOLO synchronized target blips with acoustic reflection
            for(int i=0; i<4; i++) {
              if (uPings[i].x == -99.0) continue;

              float dPing = length(cUv - uPings[i]);
              float timeSincePing = uTime - uPingTimes[i];
              
              if (dPing < 0.05) {
                float fade = max(0.0, 1.0 - (timeSincePing * 1.5));
                vec3 blipColor = mix(uColor, vec3(1.0, 0.1, 0.1), 0.9); // Threat red
                
                // Hot core
                float core = smoothstep(0.05, 0.01, dPing);
                color += blipColor * core * fade * 1.5;
              }
              
              // Acoustic reflection ring expanding from target
              float ringDist = abs(dPing - (timeSincePing * 0.15));
              if (ringDist < 0.01 && timeSincePing < 2.0) {
                 float ringFade = max(0.0, 1.0 - (timeSincePing * 0.5));
                 color += vec3(1.0, 0.2, 0.2) * ringFade * 0.6;
              }
            }

            // Outer vignette to simulate CRT falloff
            color *= smoothstep(0.98, 0.7, dist);

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
