const { getCurrentCommit } = require('./git');
const { captureScreenshot, getScreenshots, importFallbackImage, findFallbackImage } = require('./screenshots');
const { broadcast } = require('./processes');
const { generateMockHTML } = require('./mock-renderer');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const express = require('express');
const path = require('path');
const os = require('os');

let crawling = false;
let crawlStatus = { running: false, total: 0, done: 0, failed: 0, active: [] };

const failedProjects = new Set();

function getCrawlStatus() {
  return { ...crawlStatus };
}

function needsScreenshot(project) {
  if (!project.launchable) return false;
  if (!project.capturable && project.capturable !== undefined) return false;
  if (failedProjects.has(project.fullName || project.name)) return false;
  const commit = getCurrentCommit(project.dir);
  const sha = commit?.sha || 'current';
  const screenshotName = project.fullName || project.name;
  const existing = getScreenshots(screenshotName);
  return !existing.some(s => s.sha === sha);
}

// Flatten projects list: include collection children
function flattenProjects(projects) {
  const flat = [];
  for (const p of projects) {
    if (p.type === 'collection' && p.children) {
      for (const child of p.children) {
        flat.push(child);
      }
    } else {
      flat.push(p);
    }
  }
  return flat;
}

async function captureProject(project, tempPort) {
  const name = project.fullName || project.name;
  const commit = getCurrentCommit(project.dir);
  const sha = commit?.sha || 'current';

  let cleanup = null;

  try {
    if (project.type === 'html') {
      const { server, port } = await startTempStatic(project.dir, tempPort);
      cleanup = () => server.close();
      await captureScreenshot(name, port, sha);
    } else if (project.startCommand) {
      // Ensure deps installed
      const pkgPath = path.join(project.dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        console.log(`[crawler] Ensuring deps for ${name}...`);
        try {
          execSync('npm install 2>/dev/null', { cwd: project.dir, timeout: 90000, stdio: 'ignore' });
        } catch (e) {
          throw new Error(`npm install failed: ${e.message}`);
        }
      }

      const proc = spawn(project.startCommand, project.startArgs, {
        cwd: project.dir,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(tempPort), NODE_ENV: 'development' },
      });
      cleanup = () => {
        try { proc.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
      };

      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString().slice(-500); });

      // Check if process died immediately
      let died = false;
      proc.on('exit', () => { died = true; });
      await new Promise(r => setTimeout(r, 2000));
      if (died) {
        const hint = stderr ? `: ${stderr.trim().slice(-200)}` : '';
        throw new Error(`Process exited immediately${hint}`);
      }

      let capturePort = null;
      const ready = await waitForPort(tempPort, 20);
      if (ready) {
        capturePort = tempPort;
      } else if (project.port && project.port !== tempPort) {
        const readyOnOwn = await waitForPort(project.port, 5);
        if (readyOnOwn) capturePort = project.port;
      }

      if (!capturePort) {
        const hint = stderr ? ` (${stderr.trim().slice(-200)})` : '';
        throw new Error(`No response on port ${tempPort}${hint}`);
      }

      await captureScreenshot(name, capturePort, sha);
      cleanup();
      cleanup = null;
    } else {
      throw new Error('Not launchable');
    }

    broadcast('screenshot', { name, sha });
    console.log(`[crawler] ✓ ${name}`);
  } catch (err) {
    console.log(`[crawler] ✗ ${name}: ${err.message}`);
    throw err;
  } finally {
    if (cleanup) cleanup();
  }
}

// Serve a mock HTML string and screenshot it
async function captureMockHTML(projectName, html, commitSha) {
  const tmpDir = path.join(os.tmpdir(), 'project-launcher-mock');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, 'index.html');
  fs.writeFileSync(tmpFile, html);

  const port = 5950 + Math.floor(Math.random() * 40);
  const { server } = await startTempStatic(tmpDir, port);
  try {
    await captureScreenshot(projectName, port, commitSha);
  } finally {
    server.close();
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

function startTempStatic(dir, port) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.static(dir));
    const server = app.listen(port, () => resolve({ server, port }));
    server.on('error', reject);
  });
}

function waitForPort(port, maxSeconds) {
  return new Promise(resolve => {
    let elapsed = 0;
    const check = () => {
      const req = http.get(`http://localhost:${port}`, { timeout: 2000 }, () => resolve(true));
      req.on('error', () => {
        elapsed++;
        if (elapsed >= maxSeconds) resolve(false);
        else setTimeout(check, 1000);
      });
      req.on('timeout', () => {
        req.destroy();
        elapsed++;
        if (elapsed >= maxSeconds) resolve(false);
        else setTimeout(check, 1000);
      });
    };
    check();
  });
}

async function parallelLimit(tasks, limit) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]().catch(err => ({ error: err.message }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

async function crawlAll(projects) {
  if (crawling) {
    console.log('[crawler] Already running, skipping');
    return;
  }
  crawling = true;

  // Flatten to include sub-projects from collections
  const all = flattenProjects(projects);

  // First pass: handle non-launchable projects via mock render or fallback images
  for (const p of all) {
    if (p.launchable || p.type === 'collection') continue;
    const pName = p.fullName || p.name;
    if (failedProjects.has(pName)) continue;
    const commit = getCurrentCommit(p.dir);
    const sha = commit?.sha || 'current';
    const existing = getScreenshots(pName);
    if (existing.some(s => s.sha === sha)) continue;

    // Try mock HTML render for Python apps
    if (p.type === 'python') {
      const mockHTML = generateMockHTML(p.dir, p.name);
      if (mockHTML) {
        try {
          await captureMockHTML(pName, mockHTML, sha);
          broadcast('screenshot', { name: pName, sha });
          console.log(`[crawler] ✓ ${pName} (mock render)`);
          continue;
        } catch (err) {
          console.log(`[crawler] ✗ ${pName} mock: ${err.message}`);
        }
      }
    }

    // Fallback: use existing image from the repo
    const fallback = findFallbackImage(p.dir);
    if (fallback) {
      try {
        importFallbackImage(pName, fallback, sha);
        broadcast('screenshot', { name: pName, sha });
        console.log(`[crawler] ✓ ${pName} (fallback image)`);
      } catch (err) {
        console.log(`[crawler] ✗ ${pName} fallback: ${err.message}`);
      }
    }
  }

  const queue = all.filter(p => needsScreenshot(p));

  if (queue.length === 0) {
    console.log('[crawler] All projects have current screenshots');
    crawling = false;
    return;
  }

  const names = queue.map(p => p.fullName || p.name);
  console.log(`[crawler] ${queue.length} projects need screenshots: ${names.join(', ')}`);

  crawlStatus = { running: true, total: queue.length, done: 0, failed: 0, active: [] };
  broadcast('crawl', crawlStatus);

  let nextPort = 5900;
  const CONCURRENCY = 4;

  const tasks = queue.map(project => () => {
    const port = nextPort++;
    const pName = project.fullName || project.name;
    crawlStatus.active.push(pName);
    broadcast('crawl', crawlStatus);

    return captureProject(project, port)
      .then(() => {
        crawlStatus.done++;
        crawlStatus.active = crawlStatus.active.filter(n => n !== pName);
        broadcast('crawl', crawlStatus);
      })
      .catch(() => {
        crawlStatus.failed++;
        failedProjects.add(pName);
        crawlStatus.active = crawlStatus.active.filter(n => n !== pName);
        broadcast('crawl', crawlStatus);
      });
  });

  await parallelLimit(tasks, CONCURRENCY);

  // Post-crawl: try mock render for Python projects that just failed
  for (const p of all) {
    if (p.type !== 'python') continue;
    const pName = p.fullName || p.name;
    if (!failedProjects.has(pName)) continue;
    const commit = getCurrentCommit(p.dir);
    const sha = commit?.sha || 'current';
    const existing = getScreenshots(pName);
    if (existing.some(s => s.sha === sha)) continue;

    const mockHTML = generateMockHTML(p.dir, p.name);
    if (mockHTML) {
      try {
        await captureMockHTML(pName, mockHTML, sha);
        broadcast('screenshot', { name: pName, sha });
        crawlStatus.done++;
        crawlStatus.failed--;
        console.log(`[crawler] ✓ ${pName} (mock render)`);
      } catch (err) {
        console.log(`[crawler] ✗ ${pName} mock: ${err.message}`);
      }
    }
  }

  crawlStatus.running = false;
  crawlStatus.active = [];
  broadcast('crawl', crawlStatus);
  console.log(`[crawler] Done. ${crawlStatus.done} captured, ${crawlStatus.failed} failed`);
  crawling = false;
}

module.exports = { crawlAll, needsScreenshot, getCrawlStatus, flattenProjects };
