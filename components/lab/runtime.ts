"use client";

import { useEffect, useRef } from "react";
import type * as THREE from "three";

/*
 * Mutable singletons shared by the lab render loop and the dataset capture (components/lab/capture.ts). Kept in one
 * small module so neither has to import the other's components.
 */

/**
 * Scene sync callbacks: each re-applies the engine-driven state of one component (carriage transforms, lamp poses,
 * light levels, particle density) at once, outside useFrame. The capture calls them after it overrides the engine's
 * render pose and scenario for an offscreen frame, and again after restoring both.
 */
export const labSync = new Map<string, () => void>();

/** Registers the latest `fn` as the `key` scene sync while the component is mounted (the component still runs it in useFrame). */
export function useLabSync(key: string, fn: () => void): void {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    const wrapper = () => ref.current();
    labSync.set(key, wrapper);
    return () => {
      if (labSync.get(key) === wrapper) labSync.delete(key);
    };
  }, [key]);
}

export function runLabSync(): void {
  for (const fn of labSync.values()) fn();
}

/** The live renderer, scene and main camera, for the capture panel. */
export const labCaptureTarget = { gl: null as THREE.WebGLRenderer | null, scene: null as THREE.Scene | null, camera: null as THREE.Camera | null };
