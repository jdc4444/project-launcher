const { getCurrentCommit } = require('./git');
const { captureScreenshot, getScreenshots } = require('./screenshots');
const { broadcast } = require('./processes');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const express = require('express');
const path = require('path');

let crawling = false;
let crawlStatus = { running: false, total: 0, done: 0, failed: 0, active: [] };

// Track projects that failed so we don't retry every cycle
const failedProjects = new Set();

function getCrawlStatus() {
  return { ...crawlStatus };
}

function needsScreenshot(project) {
  if (!project.launchable) return false;
  // Skip non-web projects
  if (project.framework === 'electron') return false;
  // Skip known non-web projects (MCP servers, etc)
  if (project.name === 'cinema4d-mcp') return false;
  // Skip previously failed projects (they won't magically fix themselves)
  if (failedProjects.has(project.name)) return false;
  const commit = getCurrentCommit(project.dir);
  const sha = commit?.sha || 'current';
  const existing = getScreenshots(project.name);
  return !existing.some(s => s.sha === sha);
}

// Start a project on a specific temp port, capture, stop — fully self-contained
async function captureProject(project, tempPort) {
  const name = project.name;
  const commit = getCurrentCommit(project.dir);
  const sha = commit?.sha || 'current';

  let cleanup = null;

  try {
    // Static HTML — just serve the directory
    if (project.type === 'html') {
      const { server, port } = await startTempStatic(project.dir, tempPort);
      cleanup = () => server.close();
      await captureScreenshot(name, port, sha);
    } else if (project.startCommand) {
      // Ensure node deps are installed (missing or stale)
      const pkgPath = path.join(project.dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        console.log(`[crawler] Ensuring deps for ${name}...`);
        try {
          execSync('npm install --production 2>/dev/null', { cwd: project.dir, timeout: 90000, stdio: 'ignore' });
        } catch (e) {
          throw new Error(`npm install failed: ${e.message}`);
        }
      }

      // Spawn with overridden PORT env
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

      // Collect stderr for debugging
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString().slice(-500); });

      // Wait for server to respond on temp port (up to 25s)
      let capturePort = null;
      const ready = await waitForPort(tempPort, 25);
      if (ready) {
        capturePort = tempPort;
      } else if (project.port && project.port !== tempPort) {
        // Some servers ignore PORT env — try the project's own port
        const readyOnOwn = await waitForPort(project.port, 5);
        if (readyOnOwn) capturePort = project.port;
      }

      if (!capturePort) {
        const hint = stderr ? ` (stderr: ${stderr.trim().slice(-200)})` : '';
        throw new Error(`Server didn't respond on port ${tempPort}${hint}`);
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

// Concurrency limiter — run N at a time
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

  const queue = projects.filter(p => needsScreenshot(p));
  if (queue.length === 0) {
    console.log('[crawler] All projects have current screenshots');
    crawling = false;
    return;
  }

  console.log(`[crawler] ${queue.length} projects need screenshots: ${queue.map(p => p.name).join(', ')}`);

  crawlStatus = { running: true, total: queue.length, done: 0, failed: 0, active: [] };
  broadcast('crawl', crawlStatus);

  // Assign temp ports: 5900, 5901, 5902, ...
  let nextPort = 5900;

  const CONCURRENCY = 4; // Run 4 at a time

  const tasks = queue.map((project, idx) => () => {
    const port = nextPort++;
    crawlStatus.active.push(project.name);
    broadcast('crawl', crawlStatus);

    return captureProject(project, port)
      .then(() => {
        crawlStatus.done++;
        crawlStatus.active = crawlStatus.active.filter(n => n !== project.name);
        broadcast('crawl', crawlStatus);
      })
      .catch(() => {
        crawlStatus.failed++;
        failedProjects.add(project.name);
        crawlStatus.active = crawlStatus.active.filter(n => n !== project.name);
        broadcast('crawl', crawlStatus);
      });
  });

  await parallelLimit(tasks, CONCURRENCY);

  crawlStatus.running = false;
  crawlStatus.active = [];
  broadcast('crawl', crawlStatus);
  console.log(`[crawler] Done. ${crawlStatus.done} captured, ${crawlStatus.failed} failed`);
  crawling = false;
}

module.exports = { crawlAll, needsScreenshot, getCrawlStatus };
