import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-level verification of GANTRYLAB. Runs against `next dev` (the dev-only
 * window.__labStore hook is used to read canonical state; every action goes through the UI).
 * Software GL flags let the WebGL scene render on CI machines without a GPU.
 */
/** E2E_GPU=metal (macOS) or E2E_GPU=gl uses the real GPU: 100 fps instead of 4, so timing-sensitive tests are not starved. */
const GPU = process.env.E2E_GPU;
const GL_ARGS = GPU ? ["--use-gl=angle", `--use-angle=${GPU}`] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  outputDir: "e2e/.results",
  snapshotPathTemplate: "e2e/__screenshots__/{testFilePath}/{arg}{ext}",
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    launchOptions: { args: GL_ARGS },
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
