"use client";

import type * as THREE from "three";

/*
 * Mutable singletons shared by the field render loop, the dataset capture and the workspace UI. Kept in one small
 * module so none of them has to import the others.
 */

/** Set while the dataset capture renders: the live feed pass stands aside (the capture restores the GL state). */
export const passControl = { captureActive: false };

/** Syncs target transforms from the engine; the capture calls it before rendering outside the R3F loop. */
export const targetSync = { fn: null as null | (() => void) };

/** The live renderer and scene, for the capture panel. */
export const captureTarget = { gl: null as THREE.WebGLRenderer | null, scene: null as THREE.Scene | null };
