import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.PW_BLOB ? [['blob']] : process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4173',
    trace: 'on-first-retry',
  },
projects: [
  // The visual suite has its own project (pinned Linux image in CI); keep it out of the generic run.
  { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /(^|[\\/])visual\.spec\.ts$/ },
  { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testMatch: /cross-browser\.spec\.ts/ },
  { name: 'webkit', use: { ...devices['Desktop Safari'] }, testMatch: /cross-browser\.spec\.ts/ },
  { name: 'mobile-chrome', use: { ...devices['Pixel 7'] }, testMatch: /cross-browser\.spec\.ts/ },
  { name: 'mobile-safari', use: { ...devices['iPhone 14'] }, testMatch: /cross-browser\.spec\.ts/ },
  { name: 'm-iphone-se', use: { ...devices['iPhone SE'] }, testMatch: /mobile-web\.spec\.ts/ },
  { name: 'm-iphone-15-pro', use: { ...devices['iPhone 15 Pro'] }, testMatch: /mobile-web\.spec\.ts/ },
  { name: 'm-pixel-7', use: { ...devices['Pixel 7'] }, testMatch: /mobile-web\.spec\.ts/ },
  { name: 'm-tablet', use: { ...devices['iPad Mini'] }, testMatch: /mobile-web\.spec\.ts/ },
],
  {
    name: 'visual',
    testMatch: /(^|[\\/])visual\.spec\.ts$/,
    retries: process.env.CI ? 1 : 0,
    snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}-{projectName}-{platform}{ext}',
    expect: {
      toHaveScreenshot: {
        maxDiffPixelRatio: Number(process.env.VISUAL_MAX_DIFF_RATIO ?? 0.002),
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
        stylePath: './e2e/visual/visual.css',
      },
    },
    use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, timezoneId: 'UTC', locale: 'en-US', serviceWorkers: 'block' },
  },
  webServer: {
    command: process.env.E2E_PREBUILT ? 'npm run preview -- --port 4173 --strictPort' : 'npm run build && npm run preview -- --port 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
