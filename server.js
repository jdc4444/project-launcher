const express = require('express');
const fs = require('fs');
const path = require('path');
const { scanProjects, syncLaunchJSON, readOverridesConfig, writeOverridesConfig, BASE_DIR } = require('./lib/scanner');
const { getVersionHistory, getCurrentCommit, clearCurrentCommitCache } = require('./lib/git');
const { startProject, stopProject, getStatus, getLogs, getAllStatuses, sseClients, broadcast, startPortPoll } = require('./lib/processes');
const { probeLocalServer } = require('./lib/local-server');
const { captureScreenshot, getScreenshots, getLatestScreenshot, getScreenshotPath, listCandidateImages, setPinnedScreenshotFromFile } = require('./lib/screenshots');
const { crawlAll, getCrawlStatus } = require('./lib/crawler');

const app = express();
const PORT = 4900;

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/launch/probe', async (req, res) => {
  const port = Number.parseInt(String(req.query.port || ''), 10);
  const protocol = String(req.query.protocol || 'http');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ ok: false, error: 'Invalid port' });
  }
  const ready = await probeLocalServer(port, protocol, 1500);
  res.json({ ok: true, ready });
});

app.get('/launch/:name(*)', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const project = findProject(name);
  if (!project) return res.status(404).send('Project not found');
  if (!project.launchable) return res.status(400).send('Project is not launchable');

  const escapedName = JSON.stringify(name);
  const defaultProtocol = JSON.stringify(project.protocol || 'http');
  const escapedLabel = String(project.name || name)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Launching ${escapedLabel}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0d0d0d;
      --surface: #1a1a1a;
      --border: #333;
      --text: #e8e8e8;
      --text2: #888;
      --accent: #4f9eff;
      --red: #ff453a;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f5f5f7;
        --surface: #fff;
        --border: #ddd;
        --text: #1d1d1f;
        --text2: #86868b;
      }
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .launch-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 20px;
    }
    .indicator {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #fff;
      animation: pulse 1.9s ease-in-out infinite;
      display: grid;
      place-items: center;
      font-size: 18px;
      font-weight: 500;
      line-height: 1;
      color: #111;
    }
    .status {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    body.failed {
      background: #fff;
    }
    body.failed .indicator {
      width: 16px;
      height: 16px;
      background: transparent;
      animation: none;
    }
    @keyframes pulse {
      0%, 100% {
        transform: scale(0.78);
        opacity: 0.38;
      }
      50% {
        transform: scale(1.06);
        opacity: 1;
      }
    }
  </style>
</head>
<body>
  <div class="launch-state" aria-live="polite">
    <div class="indicator" id="indicator" aria-hidden="true"></div>
    <p class="status" id="status">Starting ${escapedLabel}…</p>
  </div>
  <script>
    (async () => {
      const indicator = document.getElementById('indicator');
      const status = document.getElementById('status');
      const fail = () => {
        document.body.classList.add('failed');
        indicator.textContent = '×';
        status.textContent = 'Couldn\\'t connect.';
      };
      const waitForReady = async (port, protocol) => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          try {
            const probe = await fetch('/api/launch/probe?port=' + encodeURIComponent(port) + '&protocol=' + encodeURIComponent(protocol), {
              cache: 'no-store',
            });
            const data = await probe.json();
            if (data.ready) return true;
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 400));
        }
        return false;
      };
      try {
        const res = await fetch('/api/projects/' + encodeURIComponent(${escapedName}) + '/start', { method: 'POST' });
        const data = await res.json();
        if (data.ok && data.port) {
          const protocol = data.protocol || ${defaultProtocol};
          const ready = await waitForReady(data.port, protocol);
          if (!ready) {
            fail();
            return;
          }
          window.location.replace(protocol + '://localhost:' + data.port);
          return;
        }
        if (data.ok && data.nativeApp) {
          status.textContent = 'Opened.';
          setTimeout(() => window.close(), 400);
          return;
        }
        fail();
      } catch (err) {
        fail();
      }
    })();
  </script>
</body>
</html>`);
});

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

function invalidateProjectCache() {
  cachedProjects = null;
  cacheTime = 0;
  clearCurrentCommitCache();
}

function getProjectKey(project) {
  return project.fullName || project.name;
}

function flattenProjects(projects) {
  const flat = [];
  for (const project of projects) {
    flat.push(project);
    if (project.children) flat.push(...project.children);
  }
  return flat;
}

// Find a project by name (supports "parent/child" for sub-projects)
function findProject(name) {
  const projects = getProjects();
  // Prefer child matches so grouped projects in "All" still resolve to the
  // actual project even when a synthetic group shares the same display name.
  for (const proj of projects) {
    if (proj.children) {
      const child = proj.children.find(c => c.fullName === name || c.name === name);
      if (child) return child;
    }
  }
  return projects.find(p => p.name === name) || null;
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

app.get('/api/meta', (req, res) => {
  res.json({
    baseDir: BASE_DIR,
    rootName: path.basename(BASE_DIR) || BASE_DIR,
  });
});

app.post('/api/projects/refresh', (req, res) => {
  invalidateProjectCache();
  res.json({ ok: true });
});

app.post('/api/projects/drop-folder', (req, res) => {
  const folderName = typeof req.body?.folderName === 'string' ? req.body.folderName.trim() : '';
  const folderPath = typeof req.body?.folderPath === 'string' ? req.body.folderPath.trim() : '';
  const baseRoot = path.resolve(BASE_DIR);
  const basePrefix = `${baseRoot}${path.sep}`;

  let resolvedPath = '';
  if (folderPath) {
    resolvedPath = path.resolve(folderPath);
    if (resolvedPath !== baseRoot && !resolvedPath.startsWith(basePrefix)) {
      return res.status(400).json({ error: `Drop a folder from ${baseRoot}` });
    }
    try {
      if (!fs.statSync(resolvedPath).isDirectory()) {
        return res.status(400).json({ error: 'Dropped item is not a folder' });
      }
    } catch {
      return res.status(404).json({ error: 'Dropped folder not found' });
    }
  }

  invalidateProjectCache();
  const refreshed = getProjects();
  syncLaunchJSON(refreshed);

  const flatProjects = flattenProjects(refreshed);
  const normalizedName = folderName || path.basename(resolvedPath || '');
  const matched = flatProjects.find(project => {
    const projectDir = path.resolve(project.dir || '');
    if (resolvedPath && projectDir === resolvedPath) return true;
    if (!resolvedPath && normalizedName) {
      return path.basename(projectDir) === normalizedName || project.name === normalizedName;
    }
    return false;
  });

  if (!matched) {
    return res.status(404).json({
      error: `Couldn't find that folder in ${baseRoot}`,
    });
  }

  res.json({
    ok: true,
    item: {
      key: getProjectKey(matched),
      name: matched.name,
      type: matched.type,
      synthetic: !!matched.synthetic,
      parentName: matched.parentName || null,
    },
  });
});

function handleGroupProject(req, res) {
  const sourceName = typeof req.body?.sourceName === 'string' ? req.body.sourceName.trim() : '';
  const targetName = typeof req.body?.targetName === 'string' ? req.body.targetName.trim() : '';
  const targetType = (req.body?.targetType === 'group' || req.body?.targetType === 'folder') ? 'group' : 'project';

  if (!sourceName || !targetName) {
    return res.status(400).json({ error: 'Missing source or target project' });
  }
  if (sourceName === targetName) {
    return res.status(400).json({ error: 'Choose a different target project' });
  }

  const projects = getProjects();
  const topLevelProjects = projects.filter(project => project.type !== 'collection');
  const realCollections = projects.filter(project => project.type === 'collection' && !project.synthetic);
  const syntheticGroups = projects.filter(project => project.type === 'collection' && project.synthetic);
  const projectLookup = new Map();
  for (const project of topLevelProjects) {
    projectLookup.set(getProjectKey(project), project);
  }
  for (const project of realCollections.flatMap(collection => collection.children || [])) {
    projectLookup.set(getProjectKey(project), project);
  }

  const sourceProject = projectLookup.get(sourceName);
  if (!sourceProject) {
    return res.status(404).json({ error: 'Source project not found' });
  }

  if (targetType === 'project' && !projectLookup.has(targetName)) {
    return res.status(404).json({ error: 'Target project not found' });
  }
  if (targetType === 'group' && !syntheticGroups.some(project => (project.targetName || project.name) === targetName)) {
    return res.status(404).json({ error: 'Target group not found' });
  }

  const overridesConfig = readOverridesConfig();
  const syntheticCollections = Array.isArray(overridesConfig.syntheticCollections)
    ? overridesConfig.syntheticCollections.map(spec => ({
        name: typeof spec?.name === 'string' ? spec.name.trim() : '',
        targetName: typeof spec?.targetName === 'string' ? spec.targetName.trim() : '',
        members: Array.isArray(spec?.members)
          ? spec.members.filter(member => typeof member === 'string').map(member => member.trim()).filter(Boolean)
          : [],
      }))
    : [];

  let targetCollection = null;
  const cleaned = [];

  for (const spec of syntheticCollections) {
    const collectionTarget = spec.targetName || spec.name;
    const members = Array.from(new Set([collectionTarget, ...spec.members].filter(Boolean)));
    const filteredMembers = members.filter(member => {
      if (member === sourceName) return false;
      if (targetType === 'project' && member === targetName) return false;
      return true;
    });

    const normalized = {
      name: spec.name || collectionTarget,
      targetName: collectionTarget,
      members: filteredMembers,
    };

    if (
      (targetType === 'group' && normalized.targetName === targetName) ||
      (targetType === 'project' && normalized.targetName === targetName)
    ) {
      targetCollection = normalized;
    }

    if (filteredMembers.length < 2) continue;
    cleaned.push(normalized);
  }

  if (!targetCollection) {
    if (targetType !== 'project') {
      return res.status(404).json({ error: 'Target group not found' });
    }
    const targetProject = projectLookup.get(targetName);
    targetCollection = {
      name: targetProject?.name || targetName,
      targetName,
      members: [targetName],
    };
    cleaned.push(targetCollection);
  }

  targetCollection.name = targetCollection.name || projectLookup.get(targetCollection.targetName)?.name || targetName;
  targetCollection.targetName = targetCollection.targetName || targetName;
  targetCollection.members = Array.from(new Set([
    targetCollection.targetName,
    ...(targetCollection.members || []),
    sourceName,
  ].filter(Boolean)));

  if (!cleaned.some(spec => (spec.targetName || spec.name) === targetCollection.targetName)) {
    cleaned.push(targetCollection);
  }

  const nextSyntheticCollections = cleaned.filter(spec => {
    spec.members = Array.from(new Set([
      spec.targetName || spec.name,
      ...(spec.members || []),
    ].filter(Boolean)));
    return spec.members.length >= 2;
  });

  writeOverridesConfig({
    projects: overridesConfig.projects || {},
    syntheticCollections: nextSyntheticCollections,
  });

  invalidateProjectCache();
  const refreshed = getProjects();
  syncLaunchJSON(refreshed);
  res.json({ ok: true, syntheticCollections: nextSyntheticCollections });
}

app.post('/api/groups/group', handleGroupProject);
app.post('/api/folders/group', handleGroupProject);

app.post('/api/groups/:targetName(*)/rename', (req, res) => {
  const targetName = decodeURIComponent(req.params.targetName).trim();
  const nextName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';

  if (!targetName || !nextName) {
    return res.status(400).json({ error: 'Missing group id or name' });
  }

  const overridesConfig = readOverridesConfig();
  const syntheticCollections = Array.isArray(overridesConfig.syntheticCollections)
    ? overridesConfig.syntheticCollections.map(spec => ({
        name: typeof spec?.name === 'string' ? spec.name.trim() : '',
        targetName: typeof spec?.targetName === 'string' ? spec.targetName.trim() : '',
        members: Array.isArray(spec?.members)
          ? spec.members.filter(member => typeof member === 'string').map(member => member.trim()).filter(Boolean)
          : [],
      }))
    : [];

  const group = syntheticCollections.find(spec => (spec.targetName || spec.name) === targetName);
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }

  const projects = getProjects();
  const conflictingName = projects.find(project => project.name === nextName && !(project.synthetic && project.targetName === targetName));
  if (conflictingName) {
    return res.status(409).json({ error: 'That name is already in use' });
  }

  group.name = nextName;

  writeOverridesConfig({
    projects: overridesConfig.projects || {},
    syntheticCollections,
  });

  invalidateProjectCache();
  const refreshed = getProjects();
  syncLaunchJSON(refreshed);
  const renamed = refreshed.find(project => project.synthetic && project.targetName === targetName);
  res.json({ ok: true, group: renamed || { name: nextName, targetName } });
});

app.post('/api/groups/:targetName(*)/dissolve', (req, res) => {
  const targetName = decodeURIComponent(req.params.targetName).trim();
  if (!targetName) {
    return res.status(400).json({ error: 'Missing group id' });
  }

  const overridesConfig = readOverridesConfig();
  const syntheticCollections = Array.isArray(overridesConfig.syntheticCollections)
    ? overridesConfig.syntheticCollections.map(spec => ({
        name: typeof spec?.name === 'string' ? spec.name.trim() : '',
        targetName: typeof spec?.targetName === 'string' ? spec.targetName.trim() : '',
        members: Array.isArray(spec?.members)
          ? spec.members.filter(member => typeof member === 'string').map(member => member.trim()).filter(Boolean)
          : [],
      }))
    : [];

  const remainingCollections = syntheticCollections.filter(spec => (spec.targetName || spec.name) !== targetName);
  if (remainingCollections.length === syntheticCollections.length) {
    return res.status(404).json({ error: 'Group not found' });
  }

  writeOverridesConfig({
    projects: overridesConfig.projects || {},
    syntheticCollections: remainingCollections,
  });

  invalidateProjectCache();
  const refreshed = getProjects();
  syncLaunchJSON(refreshed);
  res.json({ ok: true, syntheticCollections: remainingCollections });
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
    captureScreenshot(screenshotName, result.port, sha, project)
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
    const result = await captureScreenshot(screenshotName, status.port, commit?.sha || 'current', project || status);
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
  try {
    const selected = setPinnedScreenshotFromFile(screenshotName, absPath);
    broadcast('screenshot', { name: screenshotName, sha: selected.sha });
    res.json({ ok: true, selected });
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
  cachedProjects = projects;
  cacheTime = Date.now();
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
    const refreshed = scanProjects();
    cachedProjects = refreshed;
    cacheTime = Date.now();
    crawlAll(refreshed);
  }, 10 * 60 * 1000);
});
