"use client";

import { useRef, useMemo } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";

import * as THREE from "three";
import { AIDetectionOverlay } from "./AIDetectionOverlay";
import { useTelemetryStore } from "@/lib/store/telemetryStore";
import { motion } from "framer-motion";
import { Vector2 } from "three";
import { useShallow } from "zustand/react/shallow";
// Dynamic PostProcessing removed for GPU optimization
const UnderwaterBackground = () => {
  const meshRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const { viewport } = useThree();

  const mjpegTexture = useMemo(() => {
    const tex = new THREE.Texture();
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    if (typeof window !== 'undefined') {
      const img = new window.Image();
      img.crossOrigin = 'anonymous';
      img.src = 'http://127.0.0.1:8000/video_feed';
      tex.image = img;
    }
    return tex;
  }, []);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uDepth: { value: 50 },
      uYawVel: { value: 0 },
      uVideoTex: { value: mjpegTexture },
    }),
    [mjpegTexture]
  );

  const prevYawRef = useRef(0);

  useFrame((state, delta) => {
    if (materialRef.current) {
      const store = useTelemetryStore.getState();
      
      let diff = store.yaw - prevYawRef.current;
      if (diff > 180) diff -= 360;
      if (diff < -180) diff += 360;
      const mockYawVel = delta > 0 ? diff / delta : 0;
      prevYawRef.current = store.yaw;

      materialRef.current.uniforms.uTime.value = state.clock.elapsedTime;
      materialRef.current.uniforms.uDepth.value = store.depth;
      materialRef.current.uniforms.uYawVel.value = mockYawVel;
      
      // Force GPU to pull latest MJPEG frame
      const img = mjpegTexture.image as HTMLImageElement;
      if (img && img.complete) {
        mjpegTexture.needsUpdate = true;
      }
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
          uniform float uYawVel;
          uniform sampler2D uVideoTex;
          varying vec2 vUv;

          float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

          void main() {
            vec2 uv = vUv;
            
            // Sample Real MJPEG Video
            vec4 videoColor = texture2D(uVideoTex, uv);
            
            // If video hasn't loaded or is black, use a base tactical color
            vec3 baseColor = videoColor.rgb;
            if (length(baseColor) < 0.01) {
                baseColor = vec3(0.0, 0.05, 0.1);
            }
            
            float depthN = clamp(uDepth / 100.0, 0.0, 1.0);
            
            float redAtten = smoothstep(0.1, 0.0, depthN);
            float greenAtten = smoothstep(0.4, 0.0, depthN);
            float blueAtten = smoothstep(1.0, 0.1, depthN);
            
            // Apply Physical Absorption to Video Feed!
            vec3 waterColor = baseColor * vec3(0.2 + redAtten*0.8, 0.3 + greenAtten*0.7, 0.5 + blueAtten*0.5);
            waterColor *= mix(1.0, 0.2, uv.y + depthN);

            if (depthN < 0.3) {
              float causticFade = 1.0 - (depthN / 0.3);
              float caustics = sin(uv.x * 30.0 + uTime) * sin(uv.y * 20.0 - uTime * 0.8) * 0.5 + 0.5;
              waterColor += vec3(0.0, 0.2, 0.3) * caustics * causticFade * (1.0 - uv.y);
            }

            vec2 drift = vec2(uYawVel * 0.01 * uTime, uTime * 0.05);
            float particles = 0.0;
            for(float i=0.0; i<3.0; i++) {
               vec2 puv = fract(uv * (10.0 + i*5.0) + drift * (1.0+i));
               float p = smoothstep(0.05, 0.0, length(puv - 0.5));
               p *= sin(uTime * 3.0 + i*10.0 + hash(uv)) * 0.5 + 0.5;
               particles += p;
            }
            
            waterColor += vec3(0.8, 0.9, 1.0) * particles * 0.15 * max(blueAtten, 0.1);

            float dist = length(uv - 0.5);
            waterColor *= smoothstep(0.8, 0.3, dist + depthN*0.5);

            gl_FragColor = vec4(waterColor, 1.0);
          }
        `}
      />
    </mesh>
  );
};

export function VideoFeed() {
  const { isOnline, fps, latency, detectionsCount } = useTelemetryStore(
    useShallow((state) => ({
      isOnline: state.isOnline,
      fps: state.fps,
      latency: state.latency,
      detectionsCount: state.detections.length
    }))
  );

  return (
    <div className="relative w-full h-full bg-tactical-abyss overflow-hidden">
      
      {/* R3F Canvas for Volumetric Rendering */}
      <div className="absolute inset-0 z-0">
        <Canvas>
          <color attach="background" args={["#010508"]} />
          <UnderwaterBackground />
        </Canvas>
      </div>

      {/* HUD Elements (DOM Overlay) */}
      <div className="absolute inset-0 pointer-events-none p-4 flex flex-col justify-between z-10">
        
        {/* TOP */}
        <div className="flex justify-between items-start w-full text-[10px] font-mono text-tactical-cyan/80">
          {/* TOP LEFT */}
          <div className="flex flex-col space-y-1">
            <div className="flex items-center space-x-2">
              <div className="w-2 h-2 rounded-full bg-tactical-red holographic-glow animate-pulse" />
              <span className="tracking-widest font-bold">REC_LIVE</span>
            </div>
            <div>CAM_ID: OPTIC-01-FWD</div>
            <div>MSN_ID: OMEGA-7-DEEP</div>
          </div>

          {/* TOP RIGHT */}
          <div className="flex flex-col items-end space-y-1 text-right">
             <div className="flex items-center space-x-2 text-tactical-cyan">
                <span>FPS: {Math.round(fps)}</span>
             </div>
             <div>LATENCY: {latency}MS</div>
             <div className="text-tactical-green">AI_SYS: ONLINE</div>
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

        {/* BOTTOM */}
        <div className="flex justify-between items-end w-full text-[10px] font-mono text-tactical-cyan/80">
          {/* BOTTOM LEFT */}
          <div className="flex flex-col space-y-1">
            <div>DETECTIONS: {detectionsCount}</div>
            <div className={detectionsCount > 0 ? "text-tactical-red animate-pulse" : "text-tactical-cyan"}>
              TRG_LOCK: {detectionsCount > 0 ? "ACQUIRED" : "SEARCHING"}
            </div>
          </div>

          {/* BOTTOM RIGHT */}
          <div className="flex flex-col items-end space-y-1 text-right">
            <div suppressHydrationWarning>TS: {new Date().toISOString().split("T")[1].replace("Z", "")}</div>
            <div className="flex items-center space-x-1">
              <div className="w-1.5 h-1.5 rounded-full bg-tactical-green animate-pulse" />
              <span>TLM_SYNC_OK</span>
            </div>
          </div>
        </div>
      </div>

      {/* Advanced AI Detections */}
      {isOnline && <AIDetectionOverlay />}

      {/* CRT Scanline Overlay */}
      <div className="absolute inset-0 crt-overlay pointer-events-none z-20 opacity-50" />
      <div className="absolute inset-0 vignette-overlay pointer-events-none z-20" />
    </div>
  );
}
