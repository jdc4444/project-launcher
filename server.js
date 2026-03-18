const express = require('express');
const path = require('path');
const { scanProjects } = require('./lib/scanner');
const { getVersionHistory, getCurrentCommit } = require('./lib/git');
const { startProject, stopProject, getStatus, getLogs, getAllStatuses, sseClients, broadcast } = require('./lib/processes');
const { captureScreenshot, getScreenshots, getLatestScreenshot, getScreenshotPath } = require('./lib/screenshots');
const { crawlAll, getCrawlStatus } = require('./lib/crawler');

const app = express();
const PORT = 4900;

app.use(express.json());

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- API Routes ---

// List all projects
let cachedProjects = null;
let cacheTime = 0;
const CACHE_TTL = 10000;

function getProjects() {
  const now = Date.now();
  if (!cachedProjects || now - cacheTime > CACHE_TTL) {
    cachedProjects = scanProjects();
    cacheTime = now;
  }
  return cachedProjects;
}

app.get('/api/projects', (req, res) => {
  const projects = getProjects();
  const enriched = projects.map(p => {
    const status = getStatus(p.name);
    const screenshot = getLatestScreenshot(p.name);
    const commit = getCurrentCommit(p.dir);
    return { ...p, ...status, currentCommit: commit, latestScreenshot: screenshot };
  });
  res.json(enriched);
});

app.post('/api/projects/refresh', (req, res) => {
  cachedProjects = null;
  cacheTime = 0;
  res.json({ ok: true });
});

// Single project detail
app.get('/api/projects/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const project = getProjects().find(p => p.name === name);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const status = getStatus(name);
  const history = getVersionHistory(project.dir);
  const screenshots = getScreenshots(name);
  res.json({ ...project, ...status, history, screenshots });
});

// Start project
app.post('/api/projects/:name/start', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const project = getProjects().find(p => p.name === name);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.launchable) return res.status(400).json({ error: 'Not launchable' });

  const result = await startProject(project);
  res.json(result);

  // Auto-capture after manual start
  if (result.ok && result.port) {
    const commit = getCurrentCommit(project.dir);
    const sha = commit?.sha || 'current';
    captureScreenshot(name, result.port, sha)
      .then(() => broadcast('screenshot', { name, sha }))
      .catch(err => console.log(`Auto-screenshot for ${name} failed: ${err.message}`));
  }
});

// Stop project
app.post('/api/projects/:name/stop', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  res.json(await stopProject(name));
});

// Get logs
app.get('/api/projects/:name/logs', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  res.json(getLogs(name, parseInt(req.query.count) || 100));
});

// Manual screenshot
app.post('/api/projects/:name/screenshot', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const status = getStatus(name);
  if (status.status !== 'running' || !status.port) {
    return res.status(400).json({ error: 'Project must be running' });
  }
  const project = getProjects().find(p => p.name === name);
  const commit = project ? getCurrentCommit(project.dir) : null;
  try {
    const result = await captureScreenshot(name, status.port, commit?.sha || 'current');
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve screenshots
app.get('/screenshots/:name/:file', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const file = req.params.file;
  if (file.includes('..') || file.includes('/')) return res.status(400).send('Invalid');
  const filePath = getScreenshotPath(name, file);
  if (!filePath) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// Crawl status
app.get('/api/crawl', (req, res) => {
  res.json(getCrawlStatus());
});

// Trigger crawl manually
app.post('/api/crawl', (req, res) => {
  res.json({ ok: true, message: 'Crawl started' });
  crawlAll(getProjects());
});

// SSE for real-time updates
app.get('/api/status', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify(getAllStatuses())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.listen(PORT, () => {
  const projects = scanProjects();
  console.log(`Project Launcher running at http://localhost:${PORT}`);
  console.log(`Found ${projects.length} projects`);

  // Start background crawl after a short delay (let server fully boot)
  setTimeout(() => {
    console.log('[startup] Starting background screenshot crawl...');
    crawlAll(projects);
  }, 2000);

  // Re-crawl every 10 minutes to catch new commits
  setInterval(() => {
    console.log('[periodic] Checking for new screenshots needed...');
    cachedProjects = null;
    cacheTime = 0;
    crawlAll(scanProjects());
  }, 10 * 60 * 1000);
});
