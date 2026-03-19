const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getLocalUrl, getProjectProtocol, probeLocalServer } = require('./local-server');

const SCREENSHOTS_DIR = path.join(require('os').homedir(), '.project-launcher', 'screenshots');
const PINNED_SCREENSHOT_NAME = 'selected';
const CAPTURE_VIEWPORT_SIZE = 1200;
const THUMB_SIZE = 400;

// Ensure screenshots dir exists
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function waitForServer(port, projectOrProtocol = 'http', retries = 5, delay = 1000) {
  return new Promise(resolve => {
    let attempt = 0;
    const check = async () => {
      const alive = await probeLocalServer(port, projectOrProtocol, 3000);
      if (alive) {
        resolve(true);
        return;
      }
      attempt++;
      if (attempt >= retries) resolve(false);
      else setTimeout(check, delay);
    };
    check();
  });
}

function getImageSize(imagePath) {
  try {
    const output = execSync(`sips -g pixelWidth -g pixelHeight "${imagePath}"`, { encoding: 'utf8', timeout: 10000 });
    const width = Number(output.match(/pixelWidth:\s+(\d+)/)?.[1] || 0);
    const height = Number(output.match(/pixelHeight:\s+(\d+)/)?.[1] || 0);
    return { width, height };
  } catch {
    return { width: 0, height: 0 };
  }
}

function getPngSize(imagePath) {
  try {
    const data = fs.readFileSync(imagePath);
    if (data.length < 24) return { width: 0, height: 0 };
    // PNG header + IHDR width/height fields
    const pngHeader = '89504e470d0a1a0a';
    if (data.subarray(0, 8).toString('hex') !== pngHeader) return { width: 0, height: 0 };
    return {
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
    };
  } catch {
    return { width: 0, height: 0 };
  }
}

function isSquarePng(imagePath) {
  const { width, height } = getPngSize(imagePath);
  return !!width && width === height;
}

function writeSquareThumb(sourcePath, thumbPath, size = THUMB_SIZE) {
  const { width, height } = getImageSize(sourcePath);
  if (!width || !height) {
    fs.copyFileSync(sourcePath, thumbPath);
    return;
  }

  const cropSize = Math.min(width, height);
  try {
    execSync(`sips -c ${cropSize} ${cropSize} "${sourcePath}" --out "${thumbPath}" 2>/dev/null`, { timeout: 10000 });
    execSync(`sips -Z ${size} "${thumbPath}" --out "${thumbPath}" 2>/dev/null`, { timeout: 10000 });
  } catch {
    try {
      execSync(`sips -Z ${size} "${sourcePath}" --out "${thumbPath}" 2>/dev/null`, { timeout: 10000 });
    } catch {
      fs.copyFileSync(sourcePath, thumbPath);
    }
  }
}

function ensureSquareThumb(fullPath, thumbPath) {
  if (!fs.existsSync(fullPath)) return false;
  if (fs.existsSync(thumbPath) && isSquarePng(thumbPath)) return true;
  try {
    writeSquareThumb(fullPath, thumbPath);
    return true;
  } catch {
    return false;
  }
}

async function captureScreenshot(projectName, port, commitSha, projectOrOptions = {}) {
  const projectDir = path.join(SCREENSHOTS_DIR, projectName);
  ensureDir(projectDir);
  const protocol = getProjectProtocol(projectOrOptions);

  const filename = commitSha || 'current';
  const fullPath = path.join(projectDir, `${filename}.png`);
  const thumbPath = path.join(projectDir, `${filename}-thumb.png`);

  // Check server is responding
  const ready = await waitForServer(port, protocol);
  if (!ready) {
    throw new Error(`Server not responding on ${protocol}://localhost:${port}`);
  }

  // Use Playwright for headless screenshot
  let browser;
  let context;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: true,
      channel: 'chrome',  // Use system Chrome instead of headless shell — supports WebGL
      args: [
        '--enable-webgl',
        '--enable-webgl2',
        '--use-gl=angle',               // Use ANGLE for GPU rendering
        '--use-angle=metal',            // Metal backend on macOS
        '--enable-gpu-rasterization',
        '--ignore-gpu-blocklist',
        '--enable-features=VaapiVideoDecoder',
        '--no-sandbox',
      ],
    });
    context = await browser.newContext({
      viewport: { width: CAPTURE_VIEWPORT_SIZE, height: CAPTURE_VIEWPORT_SIZE },
      ignoreHTTPSErrors: protocol === 'https',
    });
    const page = await context.newPage();
    await page.goto(getLocalUrl(port, protocol), { waitUntil: 'load', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    // Wait for WebGL/Three.js/canvas to render + JS frameworks + data loading
    await page.waitForTimeout(12000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: fullPath,
      type: 'png',
      clip: {
        x: 0,
        y: 0,
        width: CAPTURE_VIEWPORT_SIZE,
        height: CAPTURE_VIEWPORT_SIZE,
      },
    });
    await context.close();
    context = null;
    await browser.close();
    browser = null;
  } catch (err) {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    throw new Error(`Screenshot failed: ${err.message}`);
  }

  // Generate thumbnail via sips (macOS built-in)
  try {
    writeSquareThumb(fullPath, thumbPath);
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

function getPinnedScreenshot(projectName) {
  const projectDir = path.join(SCREENSHOTS_DIR, projectName);
  const full = `${PINNED_SCREENSHOT_NAME}.png`;
  const thumb = `${PINNED_SCREENSHOT_NAME}-thumb.png`;
  const fullPath = path.join(projectDir, full);
  const thumbPath = path.join(projectDir, thumb);
  if (!fs.existsSync(fullPath)) return null;
  ensureSquareThumb(fullPath, thumbPath);
  const stat = fs.statSync(fullPath);
  return {
    sha: PINNED_SCREENSHOT_NAME,
    full,
    thumb,
    hasThumb: fs.existsSync(thumbPath),
    capturedAt: stat.mtime.toISOString(),
    size: stat.size,
    pinned: true,
  };
}

function getScreenshots(projectName) {
  const projectDir = path.join(SCREENSHOTS_DIR, projectName);
  if (!fs.existsSync(projectDir)) return [];

  const pinned = getPinnedScreenshot(projectName);
  const screenshots = fs.readdirSync(projectDir)
    .filter(f => f.endsWith('.png') && !f.endsWith('-thumb.png'))
    .filter(f => f !== `${PINNED_SCREENSHOT_NAME}.png`)
    .map(f => {
      const sha = f.replace('.png', '');
      const fullPath = path.join(projectDir, f);
      const thumbPath = path.join(projectDir, `${sha}-thumb.png`);
      ensureSquareThumb(fullPath, thumbPath);
      const stat = fs.statSync(path.join(projectDir, f));
      return {
        sha,
        full: f,
        thumb: `${sha}-thumb.png`,
        hasThumb: fs.existsSync(thumbPath),
        capturedAt: stat.mtime.toISOString(),
        size: stat.size,
      };
    })
    .sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));

  return pinned ? [pinned, ...screenshots] : screenshots;
}

function getLatestScreenshot(projectName) {
  const screenshots = getScreenshots(projectName);
  return screenshots[0] || null;
}

function isSquareScreenshot(projectName, filename) {
  const filePath = path.join(SCREENSHOTS_DIR, projectName, filename);
  return isSquarePng(filePath);
}

function getScreenshotPath(projectName, filename) {
  const filePath = path.join(SCREENSHOTS_DIR, projectName, filename);
  return fs.existsSync(filePath) ? filePath : null;
}

// Copy an existing image from a project as its thumbnail (for non-web apps like Swift)
function importFallbackImage(projectName, imagePath, commitSha) {
  const projectDir = path.join(SCREENSHOTS_DIR, projectName);
  ensureDir(projectDir);
  const filename = commitSha || 'current';
  const fullPath = path.join(projectDir, `${filename}.png`);
  const thumbPath = path.join(projectDir, `${filename}-thumb.png`);

  // Convert/copy the image to PNG and resize
  try {
    execSync(`sips -s format png "${imagePath}" --out "${fullPath}" 2>/dev/null`, { timeout: 10000 });
    writeSquareThumb(fullPath, thumbPath);
  } catch {
    fs.copyFileSync(imagePath, fullPath);
    writeSquareThumb(fullPath, thumbPath);
  }

  return { full: `${filename}.png`, thumb: `${filename}-thumb.png` };
}

// Find a suitable preview image in a project directory
function findFallbackImage(projectDir) {
  // Look in common locations for preview/screenshot images
  const candidates = [];
  const searchDirs = ['dist', 'screenshots', 'Resources', '.'];

  for (const dir of searchDirs) {
    const fullDir = path.join(projectDir, dir);
    if (!fs.existsSync(fullDir)) continue;
    try {
      const files = fs.readdirSync(fullDir);
      for (const f of files) {
        if (/\.(png|jpg|jpeg)$/i.test(f) && !f.includes('icon_16') && !f.includes('icon_32')) {
          const filePath = path.join(fullDir, f);
          const stat = fs.statSync(filePath);
          // Skip tiny icons (< 10KB) and huge files (> 20MB)
          if (stat.size > 10000 && stat.size < 20000000) {
            candidates.push({ path: filePath, size: stat.size, name: f });
          }
        }
      }
    } catch {}
  }

  if (candidates.length === 0) return null;

  // Prefer files with "preview", "screenshot", "app" in name, or largest icon
  const preferred = candidates.find(c => /preview|screenshot|app|active/i.test(c.name));
  if (preferred) return preferred.path;

  // Otherwise pick the smallest reasonable one (likely an app screenshot, not a huge render)
  candidates.sort((a, b) => a.size - b.size);
  return candidates[0].path;
}

// List ALL candidate images in a project directory (for image picker UI)
function listCandidateImages(projectDir, maxDepth = 3) {
  const candidates = [];
  const SKIP = new Set(['node_modules', '.git', '__pycache__', 'venv', '.venv', 'vendor']);

  function walk(dir, depth, relDir) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
        walk(path.join(dir, e.name), depth + 1, rel);
      } else if (/\.(png|jpg|jpeg|webp|gif)$/i.test(e.name)) {
        try {
          const stat = fs.statSync(path.join(dir, e.name));
          if (stat.size > 5000 && stat.size < 20000000) {
            candidates.push({ relPath: rel, absPath: path.join(dir, e.name), size: stat.size, name: e.name });
          }
        } catch {}
      }
    }
  }

  walk(projectDir, 0, '');
  // Sort: larger images first (more likely to be screenshots)
  candidates.sort((a, b) => b.size - a.size);
  return candidates;
}

// Set a specific image as the project's screenshot
function writeImagePair(sourceImagePath, fullPath, thumbPath) {
  try {
    execSync(`sips -s format png "${sourceImagePath}" --out "${fullPath}" 2>/dev/null`, { timeout: 10000 });
  } catch {
    fs.copyFileSync(sourceImagePath, fullPath);
  }

  try {
    writeSquareThumb(fullPath, thumbPath);
  } catch {
    fs.copyFileSync(fullPath, thumbPath);
  }
}

function setScreenshotFromFile(screenshotName, sourceImagePath, sha) {
  const dir = path.join(SCREENSHOTS_DIR, screenshotName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const fullPath = path.join(dir, `${sha}.png`);
  const thumbPath = path.join(dir, `${sha}-thumb.png`);

  writeImagePair(sourceImagePath, fullPath, thumbPath);

  return { full: `${sha}.png`, thumb: `${sha}-thumb.png` };
}

function setPinnedScreenshotFromFile(screenshotName, sourceImagePath) {
  const dir = path.join(SCREENSHOTS_DIR, screenshotName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const fullPath = path.join(dir, `${PINNED_SCREENSHOT_NAME}.png`);
  const thumbPath = path.join(dir, `${PINNED_SCREENSHOT_NAME}-thumb.png`);
  writeImagePair(sourceImagePath, fullPath, thumbPath);

  return {
    sha: PINNED_SCREENSHOT_NAME,
    full: `${PINNED_SCREENSHOT_NAME}.png`,
    thumb: `${PINNED_SCREENSHOT_NAME}-thumb.png`,
    pinned: true,
  };
}

module.exports = {
  captureScreenshot,
  getScreenshots,
  getLatestScreenshot,
  getScreenshotPath,
  isSquareScreenshot,
  importFallbackImage,
  findFallbackImage,
  listCandidateImages,
  setScreenshotFromFile,
  setPinnedScreenshotFromFile,
  getPinnedScreenshot,
  SCREENSHOTS_DIR,
};
