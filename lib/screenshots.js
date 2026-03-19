const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getLocalUrl, getProjectProtocol, probeLocalServer } = require('./local-server');

const SCREENSHOTS_DIR = path.join(require('os').homedir(), '.project-launcher', 'screenshots');
const PINNED_SCREENSHOT_NAME = 'selected';
const CAPTURE_VIEWPORT_SIZE = 1200;
const SQUARE_THUMB_SIZE = 400;
const WIDE_THUMB_WIDTH = 400;
const WIDE_THUMB_HEIGHT = 225;
const SQUARE_THUMB_SUFFIX = '-thumb.png';
const WIDE_THUMB_SUFFIX = '-thumb-wide.png';

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

function hasAspectPng(imagePath, aspectWidth, aspectHeight, tolerance = 0.03) {
  const { width, height } = getPngSize(imagePath);
  if (!width || !height) return false;
  const target = aspectWidth / aspectHeight;
  return Math.abs((width / height) - target) <= tolerance;
}

function getThumbName(sha) {
  return `${sha}${SQUARE_THUMB_SUFFIX}`;
}

function getWideThumbName(sha) {
  return `${sha}${WIDE_THUMB_SUFFIX}`;
}

function writeAspectThumb(sourcePath, thumbPath, aspectWidth, aspectHeight, outputWidth, outputHeight) {
  const { width, height } = getImageSize(sourcePath);
  if (!width || !height) {
    fs.copyFileSync(sourcePath, thumbPath);
    return;
  }

  const targetAspect = aspectWidth / aspectHeight;
  const sourceAspect = width / height;
  let cropWidth = width;
  let cropHeight = height;

  if (sourceAspect > targetAspect) {
    cropWidth = Math.round(height * targetAspect);
  } else if (sourceAspect < targetAspect) {
    cropHeight = Math.round(width / targetAspect);
  }

  try {
    execSync(`sips -c ${cropHeight} ${cropWidth} "${sourcePath}" --out "${thumbPath}" 2>/dev/null`, { timeout: 10000 });
    execSync(`sips --resampleHeightWidth ${outputHeight} ${outputWidth} "${thumbPath}" --out "${thumbPath}" 2>/dev/null`, { timeout: 10000 });
  } catch {
    try {
      execSync(`sips -Z ${Math.max(outputWidth, outputHeight)} "${sourcePath}" --out "${thumbPath}" 2>/dev/null`, { timeout: 10000 });
    } catch {
      fs.copyFileSync(sourcePath, thumbPath);
    }
  }
}

function writeSquareThumb(sourcePath, thumbPath, size = SQUARE_THUMB_SIZE) {
  writeAspectThumb(sourcePath, thumbPath, 1, 1, size, size);
}

function writeWideThumb(sourcePath, thumbPath, width = WIDE_THUMB_WIDTH, height = WIDE_THUMB_HEIGHT) {
  writeAspectThumb(sourcePath, thumbPath, 16, 9, width, height);
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

function ensureWideThumb(fullPath, thumbPath) {
  if (!fs.existsSync(fullPath)) return false;
  if (fs.existsSync(thumbPath) && hasAspectPng(thumbPath, 16, 9)) return true;
  try {
    writeWideThumb(fullPath, thumbPath);
    return true;
  } catch {
    return false;
  }
}

function ensureThumbVariants(fullPath, thumbPath, wideThumbPath) {
  const squareReady = ensureSquareThumb(fullPath, thumbPath);
  const wideReady = ensureWideThumb(fullPath, wideThumbPath);
  return squareReady || wideReady;
}

function getFullFilenameFromThumb(filename) {
  if (filename.endsWith(WIDE_THUMB_SUFFIX)) {
    return `${filename.slice(0, -WIDE_THUMB_SUFFIX.length)}.png`;
  }
  if (filename.endsWith(SQUARE_THUMB_SUFFIX)) {
    return `${filename.slice(0, -SQUARE_THUMB_SUFFIX.length)}.png`;
  }
  return null;
}

async function captureScreenshot(projectName, port, commitSha, projectOrOptions = {}) {
  const projectDir = path.join(SCREENSHOTS_DIR, projectName);
  ensureDir(projectDir);
  const protocol = getProjectProtocol(projectOrOptions);

  const filename = commitSha || 'current';
  const fullPath = path.join(projectDir, `${filename}.png`);
  const thumbPath = path.join(projectDir, getThumbName(filename));
  const wideThumbPath = path.join(projectDir, getWideThumbName(filename));

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
    ensureThumbVariants(fullPath, thumbPath, wideThumbPath);
  } catch {
    // If sips fails, just copy the full image as thumb
    fs.copyFileSync(fullPath, thumbPath);
    fs.copyFileSync(fullPath, wideThumbPath);
  }

  return {
    full: `${filename}.png`,
    thumb: getThumbName(filename),
    wideThumb: getWideThumbName(filename),
    path: fullPath,
  };
}

function getPinnedScreenshot(projectName) {
  const projectDir = path.join(SCREENSHOTS_DIR, projectName);
  const full = `${PINNED_SCREENSHOT_NAME}.png`;
  const thumb = getThumbName(PINNED_SCREENSHOT_NAME);
  const wideThumb = getWideThumbName(PINNED_SCREENSHOT_NAME);
  const fullPath = path.join(projectDir, full);
  const thumbPath = path.join(projectDir, thumb);
  const wideThumbPath = path.join(projectDir, wideThumb);
  if (!fs.existsSync(fullPath)) return null;
  ensureSquareThumb(fullPath, thumbPath);
  const stat = fs.statSync(fullPath);
  return {
    sha: PINNED_SCREENSHOT_NAME,
    full,
    thumb,
    wideThumb,
    hasThumb: fs.existsSync(thumbPath),
    hasWideThumb: fs.existsSync(wideThumbPath),
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
    .filter(f => f.endsWith('.png') && !f.endsWith(SQUARE_THUMB_SUFFIX) && !f.endsWith(WIDE_THUMB_SUFFIX))
    .filter(f => f !== `${PINNED_SCREENSHOT_NAME}.png`)
    .map(f => {
      const sha = f.replace('.png', '');
      const fullPath = path.join(projectDir, f);
      const thumbPath = path.join(projectDir, getThumbName(sha));
      const wideThumbPath = path.join(projectDir, getWideThumbName(sha));
      ensureSquareThumb(fullPath, thumbPath);
      const stat = fs.statSync(path.join(projectDir, f));
      return {
        sha,
        full: f,
        thumb: getThumbName(sha),
        wideThumb: getWideThumbName(sha),
        hasThumb: fs.existsSync(thumbPath),
        hasWideThumb: fs.existsSync(wideThumbPath),
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
  if (fs.existsSync(filePath)) return filePath;

  const fullFilename = getFullFilenameFromThumb(filename);
  if (!fullFilename) return null;

  const fullPath = path.join(SCREENSHOTS_DIR, projectName, fullFilename);
  if (!fs.existsSync(fullPath)) return null;

  if (filename.endsWith(SQUARE_THUMB_SUFFIX)) {
    return ensureSquareThumb(fullPath, filePath) ? filePath : null;
  }
  if (filename.endsWith(WIDE_THUMB_SUFFIX)) {
    return ensureWideThumb(fullPath, filePath) ? filePath : null;
  }
  return null;
}

// Copy an existing image from a project as its thumbnail (for non-web apps like Swift)
function importFallbackImage(projectName, imagePath, commitSha) {
  const projectDir = path.join(SCREENSHOTS_DIR, projectName);
  ensureDir(projectDir);
  const filename = commitSha || 'current';
  const fullPath = path.join(projectDir, `${filename}.png`);
  const thumbPath = path.join(projectDir, getThumbName(filename));
  const wideThumbPath = path.join(projectDir, getWideThumbName(filename));

  // Convert/copy the image to PNG and resize
  try {
    execSync(`sips -s format png "${imagePath}" --out "${fullPath}" 2>/dev/null`, { timeout: 10000 });
    ensureThumbVariants(fullPath, thumbPath, wideThumbPath);
  } catch {
    fs.copyFileSync(imagePath, fullPath);
    ensureThumbVariants(fullPath, thumbPath, wideThumbPath);
  }

  return { full: `${filename}.png`, thumb: getThumbName(filename), wideThumb: getWideThumbName(filename) };
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
function writeImagePair(sourceImagePath, fullPath, thumbPath, wideThumbPath) {
  try {
    execSync(`sips -s format png "${sourceImagePath}" --out "${fullPath}" 2>/dev/null`, { timeout: 10000 });
  } catch {
    fs.copyFileSync(sourceImagePath, fullPath);
  }

  try {
    ensureThumbVariants(fullPath, thumbPath, wideThumbPath);
  } catch {
    fs.copyFileSync(fullPath, thumbPath);
    fs.copyFileSync(fullPath, wideThumbPath);
  }
}

function setScreenshotFromFile(screenshotName, sourceImagePath, sha) {
  const dir = path.join(SCREENSHOTS_DIR, screenshotName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const fullPath = path.join(dir, `${sha}.png`);
  const thumbPath = path.join(dir, getThumbName(sha));
  const wideThumbPath = path.join(dir, getWideThumbName(sha));

  writeImagePair(sourceImagePath, fullPath, thumbPath, wideThumbPath);

  return { full: `${sha}.png`, thumb: getThumbName(sha), wideThumb: getWideThumbName(sha) };
}

function setPinnedScreenshotFromFile(screenshotName, sourceImagePath) {
  const dir = path.join(SCREENSHOTS_DIR, screenshotName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const fullPath = path.join(dir, `${PINNED_SCREENSHOT_NAME}.png`);
  const thumbPath = path.join(dir, getThumbName(PINNED_SCREENSHOT_NAME));
  const wideThumbPath = path.join(dir, getWideThumbName(PINNED_SCREENSHOT_NAME));
  writeImagePair(sourceImagePath, fullPath, thumbPath, wideThumbPath);

  return {
    sha: PINNED_SCREENSHOT_NAME,
    full: `${PINNED_SCREENSHOT_NAME}.png`,
    thumb: getThumbName(PINNED_SCREENSHOT_NAME),
    wideThumb: getWideThumbName(PINNED_SCREENSHOT_NAME),
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
