"use client";

import { useRef, useMemo, useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useTelemetryStore } from "@/lib/store/telemetryStore";

// Sonar Shader Material
const SonarShader = () => {
  const meshRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const { viewport } = useThree();

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uColor: { value: new THREE.Color("#00F0FF") },
      uBgColor: { value: new THREE.Color("#010508") },
      uPings: { value: [new THREE.Vector2(-0.2, 0.3), new THREE.Vector2(0.5, -0.4)] },
    }),
    []
  );

  useFrame((state) => {
    if (materialRef.current) {
      materialRef.current.uniforms.uTime.value = state.clock.elapsedTime;
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
          uniform vec3 uColor;
          uniform vec3 uBgColor;
          uniform vec2 uPings[2];
          varying vec2 vUv;

          #define PI 3.14159265359

          void main() {
            // Center coordinates
            vec2 cUv = vUv * 2.0 - 1.0;
            float dist = length(cUv);

            // Circular mask
            if (dist > 0.95) {
              gl_FragColor = vec4(0.0);
              return;
            }

            vec3 color = uBgColor;

            // Concentric grid lines
            float ringFreq = 10.0;
            float rings = fract(dist * ringFreq);
            if (rings < 0.05 || rings > 0.95) {
              color = mix(color, uColor, 0.1);
            }

            // Crosshairs
            if (abs(cUv.x) < 0.01 || abs(cUv.y) < 0.01) {
              color = mix(color, uColor, 0.15);
            }

            // Sweeping radar beam
            float angle = atan(cUv.y, cUv.x);
            // Normalize angle to 0..2PI
            if (angle < 0.0) angle += 2.0 * PI;
            
            // Sweep rotation over time
            float sweepAngle = mod(-uTime * 2.0, 2.0 * PI);
            
            // Calculate angular difference
            float diff = sweepAngle - angle;
            if (diff < 0.0) diff += 2.0 * PI;

            // Beam glow
            if (diff < 1.0) {
              float intensity = 1.0 - diff;
              color = mix(color, uColor, intensity * 0.5);
            }

            // Blips (Echoes)
            for(int i=0; i<2; i++) {
              float dPing = length(cUv - uPings[i]);
              // Blip glows brightest when sweep hits it
              float pingAngle = atan(uPings[i].y, uPings[i].x);
              if (pingAngle < 0.0) pingAngle += 2.0 * PI;
              
              float pingDiff = sweepAngle - pingAngle;
              if (pingDiff < 0.0) pingDiff += 2.0 * PI;

              if (dPing < 0.05) {
                float blipIntensity = exp(-pingDiff * 2.0); // Fade out after sweep passes
                color = mix(color, vec3(1.0, 0.1, 0.1), blipIntensity * (1.0 - dPing/0.05));
              }
            }

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
      
      {/* Overlay Frame */}
      <div className="absolute inset-0 pointer-events-none rounded-xl border-[1px] border-tactical-cyan/40 shadow-[inset_0_0_20px_rgba(0,240,255,0.1)]">
        <div className="absolute top-2 left-2 text-[8px] font-mono text-tactical-cyan/60">
          SONAR_LINK: ACTIVE
        </div>
        <div className="absolute top-2 right-2 text-[8px] font-mono text-tactical-cyan/60">
          RANGE: 50M
        </div>
      </div>
    </div>
  );
}
