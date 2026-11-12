import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4173',
    trace: 'on-first-retry',
  },
projects: [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testMatch: /cross-browser\.spec\.ts/ },
  { name: 'webkit', use: { ...devices['Desktop Safari'] }, testMatch: /cross-browser\.spec\.ts/ },
  { name: 'mobile-chrome', use: { ...devices['Pixel 7'] }, testMatch: /cross-browser\.spec\.ts/ },
  { name: 'mobile-safari', use: { ...devices['iPhone 14'] }, testMatch: /cross-browser\.spec\.ts/ },
],
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
