const { getCurrentCommit } = require('./git');
const { captureScreenshot, getScreenshots } = require('./screenshots');
const { broadcast } = require('./processes');
const { spawn } = require('child_process');
const http = require('http');
const express = require('express');
const path = require('path');

let crawling = false;
let crawlStatus = { running: false, total: 0, done: 0, failed: 0, active: [] };

function getCrawlStatus() {
  return { ...crawlStatus };
}

function needsScreenshot(project) {
  if (!project.launchable) return false;
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
    // Start the project on the temp port
    if (project.type === 'html' && !project.startCommand) {
      // Static HTML — spin up a temp express server
      const { server, port } = await startTempStatic(project.dir, tempPort);
      cleanup = () => server.close();
      await captureScreenshot(name, port, sha);
    } else if (project.startCommand) {
      // Node/Python project — spawn with overridden PORT env
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

      // Wait for server to respond (up to 20s)
      const ready = await waitForPort(tempPort, 20);
      if (!ready) {
        // Some servers ignore PORT env — try the project's own port
        if (project.port && project.port !== tempPort) {
          const readyOnOwn = await waitForPort(project.port, 5);
          if (readyOnOwn) {
            await captureScreenshot(name, project.port, sha);
            cleanup();
            return;
          }
        }
        throw new Error(`Server didn't respond on port ${tempPort}`);
      }
      await captureScreenshot(name, tempPort, sha);
      cleanup();
      cleanup = null; // already cleaned
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
