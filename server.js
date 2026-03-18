const express = require('express');
const path = require('path');
const { scanProjects } = require('./lib/scanner');
const { getVersionHistory, getCurrentCommit } = require('./lib/git');
const { startProject, stopProject, getStatus, getLogs, getAllStatuses, sseClients } = require('./lib/processes');
const { captureScreenshot, getScreenshots, getLatestScreenshot, getScreenshotPath } = require('./lib/screenshots');

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
const CACHE_TTL = 10000; // 10s

app.get('/api/projects', (req, res) => {
  const now = Date.now();
  if (!cachedProjects || now - cacheTime > CACHE_TTL) {
    cachedProjects = scanProjects();
    cacheTime = now;
  }

  // Enrich with status and latest screenshot
  const enriched = cachedProjects.map(p => {
    const status = getStatus(p.name);
    const screenshot = getLatestScreenshot(p.name);
    const commit = getCurrentCommit(p.dir);
    return {
      ...p,
      ...status,
      currentCommit: commit,
      latestScreenshot: screenshot,
    };
  });

  res.json(enriched);
});

// Force re-scan
app.post('/api/projects/refresh', (req, res) => {
  cachedProjects = null;
  cacheTime = 0;
  res.json({ ok: true });
});

// Single project detail
app.get('/api/projects/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  if (!cachedProjects || Date.now() - cacheTime > CACHE_TTL) {
    cachedProjects = scanProjects();
    cacheTime = Date.now();
  }
  const project = cachedProjects.find(p => p.name === name);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const status = getStatus(name);
  const history = getVersionHistory(project.dir);
  const screenshots = getScreenshots(name);

  res.json({
    ...project,
    ...status,
    history,
    screenshots,
  });
});

// Start project
app.post('/api/projects/:name/start', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  if (!cachedProjects) cachedProjects = scanProjects();
  const project = cachedProjects.find(p => p.name === name);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.launchable) return res.status(400).json({ error: 'Project is not launchable' });

  const result = await startProject(project);
  res.json(result);

  // Auto-capture screenshot in background after start
  if (result.ok && result.port) {
    const commit = getCurrentCommit(project.dir);
    const sha = commit?.sha || 'current';
    captureScreenshot(name, result.port, sha)
      .then(() => {
        // Notify clients that a new screenshot is available
        const { broadcast } = require('./lib/processes');
        broadcast('screenshot', { name, sha });
      })
      .catch(err => console.log(`Auto-screenshot for ${name} failed: ${err.message}`));
  }
});

// Stop project
app.post('/api/projects/:name/stop', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const result = await stopProject(name);
  res.json(result);
});

// Get logs
app.get('/api/projects/:name/logs', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const count = parseInt(req.query.count) || 100;
  res.json(getLogs(name, count));
});

// Take screenshot
app.post('/api/projects/:name/screenshot', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const status = getStatus(name);
  if (status.status !== 'running' || !status.port) {
    return res.status(400).json({ error: 'Project must be running to take screenshot' });
  }

  // Get current commit for filename
  if (!cachedProjects) cachedProjects = scanProjects();
  const project = cachedProjects.find(p => p.name === name);
  const commit = project ? getCurrentCommit(project.dir) : null;
  const sha = commit?.sha || 'current';

  try {
    const result = await captureScreenshot(name, status.port, sha);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve screenshot files
app.get('/screenshots/:name/:file', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const file = req.params.file;
  // Sanitize to prevent path traversal
  if (file.includes('..') || file.includes('/')) return res.status(400).send('Invalid');
  const filePath = getScreenshotPath(name, file);
  if (!filePath) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// SSE for real-time status updates
app.get('/api/status', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send current statuses immediately
  res.write(`data: ${JSON.stringify(getAllStatuses())}\n\n`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.listen(PORT, () => {
  console.log(`Project Launcher running at http://localhost:${PORT}`);
  console.log(`Scanning projects in ~/Documents/Code/`);
  const projects = scanProjects();
  console.log(`Found ${projects.length} projects`);
});
