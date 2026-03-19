const express = require('express');
const path = require('path');
const { scanProjects, syncLaunchJSON } = require('./lib/scanner');
const { getVersionHistory, getCurrentCommit } = require('./lib/git');
const { startProject, stopProject, getStatus, getLogs, getAllStatuses, sseClients, broadcast, startPortPoll } = require('./lib/processes');
const { captureScreenshot, getScreenshots, getLatestScreenshot, getScreenshotPath, listCandidateImages, setScreenshotFromFile } = require('./lib/screenshots');
const { crawlAll, getCrawlStatus } = require('./lib/crawler');

const app = express();
const PORT = 4900;

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// --- Project cache ---
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

// Find a project by name (supports "parent/child" for sub-projects)
function findProject(name) {
  const projects = getProjects();
  // Direct match
  let p = projects.find(p => p.name === name);
  if (p) return p;
  // Sub-project match: "World Code/festival globe"
  for (const proj of projects) {
    if (proj.children) {
      const child = proj.children.find(c => c.fullName === name || c.name === name);
      if (child) return child;
    }
  }
  return null;
}

// Enrich a project with runtime status and screenshot info
function enrichProject(p) {
  const screenshotName = p.fullName || p.name;
  const status = getStatus(screenshotName);
  const screenshot = getLatestScreenshot(screenshotName);
  const commit = getCurrentCommit(p.dir);
  return { ...p, ...status, currentCommit: commit, latestScreenshot: screenshot };
}

// --- API ---

app.get('/api/projects', (req, res) => {
  const projects = getProjects();
  const enriched = projects.map(p => {
    const ep = enrichProject(p);
    // Enrich children too
    if (ep.children) {
      ep.children = ep.children.map(c => enrichProject(c));
    }
    return ep;
  });
  res.json(enriched);
});

app.post('/api/projects/refresh', (req, res) => {
  cachedProjects = null;
  cacheTime = 0;
  res.json({ ok: true });
});

app.post('/api/projects/:name(*)/start', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const project = findProject(name);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.launchable) return res.status(400).json({ error: 'Not launchable' });

  const result = await startProject(project);
  res.json(result);

  if (result.ok && result.port) {
    const screenshotName = project.fullName || project.name;
    const commit = getCurrentCommit(project.dir);
    const sha = commit?.sha || 'current';
    captureScreenshot(screenshotName, result.port, sha)
      .then(() => broadcast('screenshot', { name: screenshotName, sha }))
      .catch(err => console.log(`Auto-screenshot for ${screenshotName} failed: ${err.message}`));
  }
});

app.post('/api/projects/:name(*)/stop', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  res.json(await stopProject(name));
});

app.get('/api/projects/:name(*)/logs', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  res.json(getLogs(name, parseInt(req.query.count) || 100));
});

app.post('/api/projects/:name(*)/screenshot', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const project = findProject(name);
  const screenshotName = project?.fullName || name;
  const status = getStatus(screenshotName);
  if (status.status !== 'running' || !status.port) {
    return res.status(400).json({ error: 'Project must be running' });
  }
  const commit = project ? getCurrentCommit(project.dir) : null;
  try {
    const result = await captureScreenshot(screenshotName, status.port, commit?.sha || 'current');
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/screenshots/:name(*)', (req, res) => {
  const parts = decodeURIComponent(req.params.name).split('/');
  const file = parts.pop();
  const name = parts.join('/');
  if (file.includes('..')) return res.status(400).send('Invalid');
  const filePath = getScreenshotPath(name, file);
  if (!filePath) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// List candidate images from project directory (for image picker)
app.get('/api/projects/:name(*)/candidates', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const project = findProject(name);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const candidates = listCandidateImages(project.dir);
  res.json(candidates.map(c => ({ relPath: c.relPath, size: c.size, name: c.name })));
});

// Serve a candidate image for preview
app.get('/api/projects/:name(*)/candidates/:relPath(*)', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const relPath = decodeURIComponent(req.params.relPath);
  const project = findProject(name);
  if (!project) return res.status(404).send('Not found');
  if (relPath.includes('..')) return res.status(400).send('Invalid');
  const filePath = path.join(project.dir, relPath);
  const fs = require('fs');
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// Set a candidate image as the project screenshot
app.post('/api/projects/:name(*)/set-image', express.json(), (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const project = findProject(name);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const { relPath } = req.body;
  if (!relPath || relPath.includes('..')) return res.status(400).json({ error: 'Invalid path' });
  const absPath = path.join(project.dir, relPath);
  const fs = require('fs');
  if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'File not found' });
  const screenshotName = project.fullName || name;
  const commit = getCurrentCommit(project.dir);
  const sha = commit?.sha || 'current';
  try {
    setScreenshotFromFile(screenshotName, absPath, sha);
    broadcast('screenshot', { name: screenshotName, sha });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Catch-all project detail — MUST be after all specific /api/projects/:name/... routes
app.get('/api/projects/:name(*)', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const project = findProject(name);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const screenshotName = project.fullName || project.name;
  const status = getStatus(screenshotName);
  const history = getVersionHistory(project.dir);
  const screenshots = getScreenshots(screenshotName);
  res.json({ ...project, ...status, history, screenshots });
});

app.get('/api/crawl', (req, res) => res.json(getCrawlStatus()));
app.post('/api/crawl', (req, res) => {
  res.json({ ok: true });
  crawlAll(getProjects());
});

app.get('/api/status', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify(getAllStatuses())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.listen(PORT, () => {
  const projects = scanProjects();
  const totalChildren = projects.reduce((n, p) => n + (p.children?.length || 0), 0);
  console.log(`Project Launcher running at http://localhost:${PORT}`);
  console.log(`Found ${projects.length} projects + ${totalChildren} sub-projects`);

  // Auto-register all projects in launch.json with stable ports
  syncLaunchJSON(projects);

  // Detect already-running projects by checking their known ports
  const { detectRunning } = require('./lib/processes');
  const allProjects = projects.flatMap(p => p.children ? p.children : [p]);
  detectRunning(allProjects).then(found => {
    if (found > 0) console.log(`[startup] Detected ${found} already-running projects`);
  });

  // Background port poll — lightweight TCP check every 5s
  startPortPoll(projects);

  setTimeout(() => {
    console.log('[startup] Starting background screenshot crawl...');
    crawlAll(projects);
  }, 2000);

  setInterval(() => {
    console.log('[periodic] Checking for new screenshots needed...');
    cachedProjects = null;
    cacheTime = 0;
    crawlAll(scanProjects());
  }, 10 * 60 * 1000);
});
