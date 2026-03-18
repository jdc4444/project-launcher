const fs = require('fs');
const path = require('path');

const BASE_DIR = path.join(require('os').homedir(), 'Documents', 'Code');
const LAUNCH_JSON = path.join(BASE_DIR, '.claude', 'launch.json');
const OVERRIDES_FILE = path.join(require('os').homedir(), '.project-launcher', 'projects.json');

// Directories to skip
const SKIP = new Set(['.claude', '.git', 'node_modules', '.DS_Store', 'blenderkit_data', 'project-launcher']);

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function detectPort(projectDir, pkg) {
  // Try to find port in server.js
  const serverFile = path.join(projectDir, 'server.js');
  if (fs.existsSync(serverFile)) {
    const src = fs.readFileSync(serverFile, 'utf8');
    // Match: PORT = 3460, port: 3460, || 3460, listen(3460)
    const match = src.match(/(?:PORT|port)\s*(?:=|:)\s*(\d{4,5})/)
      || src.match(/\|\|\s*(\d{4,5})/)
      || src.match(/\.listen\(\s*(\d{4,5})/);
    if (match) return parseInt(match[1]);
  }
  // Try package.json scripts for --port flags
  if (pkg?.scripts) {
    for (const script of Object.values(pkg.scripts)) {
      const match = script.match(/--port\s+(\d{4,5})/);
      if (match) return parseInt(match[1]);
    }
  }
  return null;
}

function detectType(projectDir) {
  const name = path.basename(projectDir);
  const entries = fs.readdirSync(projectDir, { withFileTypes: true });
  const fileNames = new Set(entries.map(e => e.name));

  // Check for package.json
  const pkg = fileNames.has('package.json') ? readJSON(path.join(projectDir, 'package.json')) : null;

  // Node project with dev script
  if (pkg?.scripts?.dev) {
    return {
      type: 'node',
      startCommand: 'npm',
      startArgs: ['run', 'dev'],
      port: detectPort(projectDir, pkg),
      framework: pkg.dependencies?.next ? 'next' : pkg.dependencies?.vite ? 'vite' : 'node',
    };
  }

  // Node project with start script
  if (pkg?.scripts?.start) {
    return {
      type: 'node',
      startCommand: 'npm',
      startArgs: ['start'],
      port: detectPort(projectDir, pkg),
      framework: pkg.dependencies?.electron ? 'electron' : 'node',
    };
  }

  // Has server.js but no scripts
  if (fileNames.has('server.js')) {
    return {
      type: 'node',
      startCommand: 'node',
      startArgs: ['server.js'],
      port: detectPort(projectDir, null),
      framework: 'node',
    };
  }

  // Static HTML project
  if (fileNames.has('index.html') && !pkg) {
    return {
      type: 'html',
      startCommand: null, // Will be served by launcher's built-in static server
      startArgs: [],
      port: null,
      framework: 'html',
    };
  }

  // Python project
  const pyFiles = entries.filter(e => e.name.endsWith('.py'));
  if (pyFiles.length > 0) {
    const serveFile = pyFiles.find(f => /serve|server|app|main/.test(f.name));
    if (serveFile) {
      return {
        type: 'python',
        startCommand: 'python3',
        startArgs: [serveFile.name],
        port: null,
        framework: 'python',
      };
    }
    return { type: 'python', startCommand: null, startArgs: [], port: null, framework: 'python' };
  }

  // Swift project
  if (fileNames.has('Package.swift') || entries.some(e => e.name.endsWith('.xcodeproj'))) {
    return { type: 'swift', startCommand: null, startArgs: [], port: null, framework: 'swift' };
  }

  // Unknown — check if it has interesting subdirectories (meta-project)
  const subdirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
  if (subdirs.length > 5) {
    return { type: 'collection', startCommand: null, startArgs: [], port: null, framework: 'collection' };
  }

  return { type: 'unknown', startCommand: null, startArgs: [], port: null, framework: 'unknown' };
}

function scanProjects() {
  const projects = [];

  // Read launch.json for override configs
  const launchConfig = readJSON(LAUNCH_JSON);
  const launchMap = new Map();
  if (launchConfig?.configurations) {
    for (const config of launchConfig.configurations) {
      const cwd = config.cwd || BASE_DIR;
      const key = config.name;
      launchMap.set(key, config);
    }
  }

  // Read manual overrides
  const overrides = readJSON(OVERRIDES_FILE) || {};

  // Scan directories
  let entries;
  try {
    entries = fs.readdirSync(BASE_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP.has(entry.name) || entry.name.startsWith('.')) continue;

    const projectDir = path.join(BASE_DIR, entry.name);
    const name = entry.name;

    // Detect project type
    const detected = detectType(projectDir);

    // Check if there's a launch.json config for this project
    let launchInfo = null;
    for (const [key, config] of launchMap) {
      const configCwd = config.cwd || BASE_DIR;
      if (configCwd === projectDir || path.basename(configCwd) === name) {
        launchInfo = config;
        break;
      }
    }

    // Merge launch.json overrides
    if (launchInfo) {
      detected.startCommand = launchInfo.runtimeExecutable;
      detected.startArgs = launchInfo.runtimeArgs || [];
      detected.port = launchInfo.port || detected.port;
      detected.launchName = launchInfo.name;
    }

    // Check for git
    const isGit = fs.existsSync(path.join(projectDir, '.git'));

    // Get file size / complexity hint
    const fileCount = fs.readdirSync(projectDir).filter(f => !f.startsWith('.')).length;

    const project = {
      name,
      dir: projectDir,
      ...detected,
      isGit,
      fileCount,
      launchable: detected.startCommand !== null || detected.type === 'html',
      ...overrides[name],
    };

    projects.push(project);
  }

  // Also check launch.json for sub-projects (like Transfer Flows/prototype)
  if (launchConfig?.configurations) {
    for (const config of launchConfig.configurations) {
      if (!config.cwd) continue;
      const parentDir = path.dirname(config.cwd);
      if (parentDir !== BASE_DIR) {
        // This is a sub-project
        const parentName = path.basename(parentDir);
        const subName = path.basename(config.cwd);
        const fullName = `${parentName}/${subName}`;

        // Check if parent already exists and skip adding duplicate
        if (!projects.find(p => p.name === fullName)) {
          projects.push({
            name: fullName,
            dir: config.cwd,
            type: 'node',
            startCommand: config.runtimeExecutable,
            startArgs: config.runtimeArgs || [],
            port: config.port,
            framework: 'node',
            launchName: config.name,
            isGit: fs.existsSync(path.join(config.cwd, '.git')) || fs.existsSync(path.join(parentDir, '.git')),
            fileCount: 0,
            launchable: true,
            isSubProject: true,
          });
        }
      }
    }
  }

  // Sort: launchable first, then alphabetical
  projects.sort((a, b) => {
    if (a.launchable !== b.launchable) return b.launchable - a.launchable;
    return a.name.localeCompare(b.name);
  });

  return projects;
}

// Static port pool for HTML projects
let nextStaticPort = 4800;
function getStaticPort() {
  return nextStaticPort++;
}

module.exports = { scanProjects, getStaticPort, BASE_DIR };
