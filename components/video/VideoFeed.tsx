"use client";

import { useRef, useMemo } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom, Noise, Vignette, ChromaticAberration } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import * as THREE from "three";
import { AIDetectionOverlay } from "./AIDetectionOverlay";
import { useTelemetryStore } from "@/lib/store/telemetryStore";
import { motion } from "framer-motion";
import { Vector2 } from "three";

// A custom shader material that generates an animated underwater gradient if no video is available
const UnderwaterBackground = () => {
  const meshRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const { viewport } = useThree();

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uDepth: { value: 50 },
    }),
    []
  );

  useFrame((state) => {
    if (materialRef.current) {
      materialRef.current.uniforms.uTime.value = state.clock.elapsedTime;
      materialRef.current.uniforms.uDepth.value = useTelemetryStore.getState().depth;
    }
  });

  return (
    <mesh ref={meshRef}>
      <planeGeometry args={[viewport.width, viewport.height]} />
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        vertexShader={`
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `}
        fragmentShader={`
          uniform float uTime;
          uniform float uDepth;
          varying vec2 vUv;

          // Simple noise function
          float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

          void main() {
            vec2 uv = vUv;
            
            // Base water color shifts based on depth
            float depthFactor = clamp(uDepth / 100.0, 0.0, 1.0);
            vec3 shallowColor = vec3(0.0, 0.3, 0.4);
            vec3 deepColor = vec3(0.0, 0.05, 0.1);
            vec3 bgColor = mix(shallowColor, deepColor, uv.y + depthFactor * 0.5);

            // Caustics/Light rays simulation
            float caustics = sin(uv.x * 20.0 + uTime) * sin(uv.y * 15.0 - uTime * 0.5) * 0.5 + 0.5;
            bgColor += vec3(0.0, 0.1, 0.15) * caustics * (1.0 - depthFactor);

            gl_FragColor = vec4(bgColor, 1.0);
          }
        `}
      />
    </mesh>
  );
};

export function VideoFeed() {
  const isOnline = useTelemetryStore((state) => state.isOnline);

  return (
    <div className="relative w-full h-full bg-tactical-abyss overflow-hidden">
      
      {/* R3F Canvas for Volumetric Rendering */}
      <div className="absolute inset-0 z-0">
        <Canvas>
          <color attach="background" args={["#010508"]} />
          <UnderwaterBackground />
          
          <EffectComposer>
            <Noise opacity={0.15} blendFunction={BlendFunction.OVERLAY} />
            <Vignette eskil={false} offset={0.3} darkness={0.8} />
            <ChromaticAberration offset={new Vector2(0.002, 0.002)} blendFunction={BlendFunction.NORMAL} radialModulation={false} modulationOffset={0} />
            <Bloom luminanceThreshold={0.2} luminanceSmoothing={0.9} intensity={1.5} />
          </EffectComposer>
        </Canvas>
      </div>

      {/* HUD Elements (DOM Overlay) */}
      <div className="absolute inset-0 pointer-events-none p-4 flex flex-col justify-between z-10">
        
        {/* Top HUD */}
        <div className="flex justify-between items-start w-full text-[10px] font-mono text-tactical-cyan/80">
          <div className="flex items-center space-x-2">
            <motion.div 
              className="w-2 h-2 rounded-full bg-tactical-red holographic-glow"
              animate={{ opacity: [1, 0.2, 1] }}
              transition={{ repeat: Infinity, duration: 1.5 }}
            />
            <span className="tracking-widest font-bold">REC_LIVE</span>
          </div>
          <div className="text-right">
            <div>CAM-01 [FORWARD_OPTIC]</div>
            <div>VOLUMETRIC: ACTIVE</div>
          </div>
        </div>

        {/* Tactical Crosshair */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-16 pointer-events-none opacity-40">
          <div className="absolute top-1/2 left-0 w-6 h-[1px] bg-tactical-cyan" />
          <div className="absolute top-1/2 right-0 w-6 h-[1px] bg-tactical-cyan" />
          <div className="absolute top-0 left-1/2 w-[1px] h-6 bg-tactical-cyan" />
          <div className="absolute bottom-0 left-1/2 w-[1px] h-6 bg-tactical-cyan" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[2px] h-[2px] rounded-full bg-tactical-red holographic-glow" />
        </div>

        {/* Bottom HUD */}
        <div className="flex justify-between items-end w-full text-[10px] font-mono text-tactical-cyan/60">
          <div>
            <div>AZIMUTH 142.4</div>
            <div>EXP: AUTO [H264]</div>
          </div>
          <div className="text-right">
            <div>MISSION: OMEGA-7</div>
            <div>THREAT_LVL: UNKNOWN</div>
          </div>
        </div>
      </div>

      {/* Advanced AI Detections */}
      {isOnline && <AIDetectionOverlay />}

      {/* CRT Scanline Overlay */}
      <div className="absolute inset-0 crt-overlay pointer-events-none z-20 mix-blend-overlay opacity-50" />
      <div className="absolute inset-0 vignette-overlay pointer-events-none z-20" />
    </div>
  );
}
