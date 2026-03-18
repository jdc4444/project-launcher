const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const http = require('http');

const SCREENSHOTS_DIR = path.join(require('os').homedir(), '.project-launcher', 'screenshots');

// Ensure screenshots dir exists
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function waitForServer(port, retries = 5, delay = 1000) {
  return new Promise(resolve => {
    let attempt = 0;
    const check = () => {
      const req = http.get(`http://localhost:${port}`, { timeout: 3000 }, () => resolve(true));
      req.on('error', () => {
        attempt++;
        if (attempt >= retries) resolve(false);
        else setTimeout(check, delay);
      });
      req.on('timeout', () => {
        req.destroy();
        attempt++;
        if (attempt >= retries) resolve(false);
        else setTimeout(check, delay);
      });
    };
    check();
  });
}

async function captureScreenshot(projectName, port, commitSha) {
  const projectDir = path.join(SCREENSHOTS_DIR, projectName);
  ensureDir(projectDir);

  const filename = commitSha || 'current';
  const fullPath = path.join(projectDir, `${filename}.png`);
  const thumbPath = path.join(projectDir, `${filename}-thumb.png`);

  // Check server is responding
  const ready = await waitForServer(port);
  if (!ready) {
    throw new Error(`Server not responding on port ${port}`);
  }

  // Use Playwright for headless screenshot
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://localhost:${port}`, { waitUntil: 'load', timeout: 30000 });
    // Wait for network to settle (no inflight requests for 500ms)
    await page.waitForLoadState('networkidle').catch(() => {});
    // Generous wait for JS frameworks, WebGL init, canvas renders, animations
    await page.waitForTimeout(6000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: fullPath, type: 'png' });
    await browser.close();
    browser = null;
  } catch (err) {
    if (browser) await browser.close();
    throw new Error(`Screenshot failed: ${err.message}`);
  }

  // Generate thumbnail via sips (macOS built-in)
  try {
    execSync(`sips -Z 400 "${fullPath}" --out "${thumbPath}" 2>/dev/null`, { timeout: 10000 });
  } catch {
    // If sips fails, just copy the full image as thumb
    fs.copyFileSync(fullPath, thumbPath);
  }

  return {
    full: `${filename}.png`,
    thumb: `${filename}-thumb.png`,
    path: fullPath,
  };
}

function getScreenshots(projectName) {
  const projectDir = path.join(SCREENSHOTS_DIR, projectName);
  if (!fs.existsSync(projectDir)) return [];

  return fs.readdirSync(projectDir)
    .filter(f => f.endsWith('.png') && !f.endsWith('-thumb.png'))
    .map(f => {
      const sha = f.replace('.png', '');
      const stat = fs.statSync(path.join(projectDir, f));
      return {
        sha,
        full: f,
        thumb: `${sha}-thumb.png`,
        hasThumb: fs.existsSync(path.join(projectDir, `${sha}-thumb.png`)),
        capturedAt: stat.mtime.toISOString(),
        size: stat.size,
      };
    })
    .sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));
}

function getLatestScreenshot(projectName) {
  const screenshots = getScreenshots(projectName);
  return screenshots[0] || null;
}

function getScreenshotPath(projectName, filename) {
  const filePath = path.join(SCREENSHOTS_DIR, projectName, filename);
  return fs.existsSync(filePath) ? filePath : null;
}

module.exports = { captureScreenshot, getScreenshots, getLatestScreenshot, getScreenshotPath, SCREENSHOTS_DIR };
