const fs = require('fs');
const path = require('path');

const BASE_DIR = path.join(require('os').homedir(), 'Documents', 'Code');
const LAUNCH_JSON = path.join(BASE_DIR, '.claude', 'launch.json');
const OVERRIDES_FILE = path.join(require('os').homedir(), '.project-launcher', 'projects.json');

const SKIP = new Set(['.claude', '.git', 'node_modules', '.DS_Store', 'blenderkit_data', 'project-launcher', 'build', 'dist', '2025', '2026']);

// --- Port registry ---
// Auto-assign ports starting from this range. Existing launch.json ports are preserved.
const AUTO_PORT_START = 3500;
const AUTO_PORT_END = 3599;
// Static HTML projects get ports in this range (served by express)
const STATIC_PORT_START = 4800;
const STATIC_PORT_END = 4899;

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function detectPort(projectDir, pkg) {
  const serverFile = path.join(projectDir, 'server.js');
  if (fs.existsSync(serverFile)) {
    const src = fs.readFileSync(serverFile, 'utf8');
    const match = src.match(/(?:PORT|port)\s*(?:=|:)\s*(\d{4,5})/)
      || src.match(/\|\|\s*(\d{4,5})/)
      || src.match(/\.listen\(\s*(\d{4,5})/);
    if (match) return parseInt(match[1]);
  }
  // Check app.py, serve.py etc for Python
  for (const pyName of ['app.py', 'serve.py', 'serve_local.py']) {
    const pyFile = path.join(projectDir, pyName);
    if (fs.existsSync(pyFile)) {
      const src = fs.readFileSync(pyFile, 'utf8');
      const match = src.match(/(?:port|PORT)\s*(?:=|:)\s*(\d{4,5})/)
        || src.match(/\|\|\s*(\d{4,5})/)
        || src.match(/\.listen\(\s*(\d{4,5})/);
      if (match) return parseInt(match[1]);
    }
  }
  if (pkg?.scripts) {
    for (const script of Object.values(pkg.scripts)) {
      const match = script.match(/--port\s+(\d{4,5})/);
      if (match) return parseInt(match[1]);
    }
  }
  return null;
}

function detectType(projectDir) {
  let entries;
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return { type: 'unknown', startCommand: null, startArgs: [], port: null, framework: 'unknown' };
  }
  const fileNames = new Set(entries.map(e => e.name));

  const pkg = fileNames.has('package.json') ? readJSON(path.join(projectDir, 'package.json')) : null;
  const hasElectron = !!(pkg?.dependencies?.electron || pkg?.devDependencies?.electron);

  // Node project with dev script (takes priority over electron check)
  if (pkg?.scripts?.dev) {
    return {
      type: 'node',
      startCommand: 'npm',
      startArgs: ['run', 'dev'],
      port: detectPort(projectDir, pkg),
      framework: pkg.dependencies?.next ? 'next' : pkg.dependencies?.vite ? 'vite' : 'node',
    };
  }

  // Node project with start script (but NOT if it launches electron)
  if (pkg?.scripts?.start && !/^electron\b/.test(pkg.scripts.start)) {
    return {
      type: 'node',
      startCommand: 'npm',
      startArgs: ['start'],
      port: detectPort(projectDir, pkg),
      framework: 'node',
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

  // Pure Electron app (no server scripts) — serve index.html statically if it exists
  if (hasElectron) {
    if (fileNames.has('index.html')) {
      return { type: 'html', startCommand: null, startArgs: [], port: null, framework: 'electron-html' };
    }
    return { type: 'electron', startCommand: null, startArgs: [], port: null, framework: 'electron', capturable: false };
  }

  // Static HTML project
  if (fileNames.has('index.html')) {
    return { type: 'html', startCommand: null, startArgs: [], port: null, framework: 'html' };
  }

  // Python project
  const pyFiles = entries.filter(e => e.name.endsWith('.py'));
  if (pyFiles.length > 0) {
    // Check if any Python file uses desktop GUI frameworks — don't launch these
    const usesDesktopGUI = pyFiles.some(f => {
      try {
        const src = fs.readFileSync(path.join(projectDir, f.name), 'utf8');
        return /import\s+tkinter|from\s+tkinter|import\s+PyQt|from\s+PyQt|\.mainloop\(\)/.test(src);
      } catch { return false; }
    });
    if (usesDesktopGUI) {
      return { type: 'python', startCommand: null, startArgs: [], port: null, framework: 'python-gui' };
    }

    const serveFile = pyFiles.find(f => /serve|server|app|main/.test(f.name));
    if (serveFile) {
      return {
        type: 'python',
        startCommand: 'python3',
        startArgs: [serveFile.name],
        port: detectPort(projectDir, null),
        framework: 'python',
      };
    }
    return { type: 'python', startCommand: null, startArgs: [], port: null, framework: 'python' };
  }

  // Swift project — check for built .app bundles
  if (fileNames.has('Package.swift') || entries.some(e => e.name.endsWith('.xcodeproj'))) {
    // Look for .app in dist/ or build/
    for (const dir of ['dist', 'build', '.']) {
      const searchDir = path.join(projectDir, dir);
      try {
        const files = fs.readdirSync(searchDir);
        const app = files.find(f => f.endsWith('.app'));
        if (app) {
          return {
            type: 'swift',
            startCommand: 'open',
            startArgs: [path.join(dir, app)],
            port: null,
            framework: 'swift',
            capturable: false,
            nativeApp: true,
          };
        }
      } catch {}
    }
    return { type: 'swift', startCommand: null, startArgs: [], port: null, framework: 'swift', capturable: false };
  }

  return { type: 'unknown', startCommand: null, startArgs: [], port: null, framework: 'unknown' };
}

// Scan a single directory for a project, return project object or null
function scanDir(projectDir, name, launchMap, overrides) {
  const detected = detectType(projectDir);

  // Check launch.json config — match by cwd first, then by name
  let launchInfo = null;
  for (const [key, config] of launchMap) {
    const configCwd = config.cwd;
    if (configCwd && configCwd === projectDir) {
      launchInfo = config;
      break;
    }
  }
  if (!launchInfo) {
    // Fallback: match by name or basename of cwd
    for (const [key, config] of launchMap) {
      const configCwd = config.cwd || '';
      if (key === name || path.basename(configCwd) === name) {
        launchInfo = config;
        break;
      }
    }
  }

  if (launchInfo) {
    detected.startCommand = launchInfo.runtimeExecutable;
    detected.startArgs = launchInfo.runtimeArgs || [];
    detected.port = launchInfo.port || detected.port;
    detected.launchName = launchInfo.name;
  }

  const isGit = fs.existsSync(path.join(projectDir, '.git'));
  const launchable = detected.startCommand !== null || detected.type === 'html';

  return {
    name,
    dir: projectDir,
    ...detected,
    isGit,
    launchable,
    capturable: detected.capturable !== false && launchable,
    ...overrides[name],
  };
}

// Hardcoded collection folders — these are known to contain independent sub-projects.
// Everything else is treated as a single project even if it has subdirectories.
const KNOWN_COLLECTIONS = new Set(['World Code', 'cursor', 'Transfer Flows']);

function isCollection(projectDir) {
  return KNOWN_COLLECTIONS.has(path.basename(projectDir));
}

function scanProjects() {
  const launchConfig = readJSON(LAUNCH_JSON);
  const launchMap = new Map();
  if (launchConfig?.configurations) {
    for (const config of launchConfig.configurations) {
      launchMap.set(config.name, config);
    }
  }
  const overrides = readJSON(OVERRIDES_FILE) || {};

  let entries;
  try {
    entries = fs.readdirSync(BASE_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const projects = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP.has(entry.name) || entry.name.startsWith('.')) continue;

    const projectDir = path.join(BASE_DIR, entry.name);
    const name = entry.name;

    // Check if this is a collection folder
    if (isCollection(projectDir)) {
      // Scan children
      const children = [];
      let childEntries;
      try {
        childEntries = fs.readdirSync(projectDir, { withFileTypes: true });
      } catch { continue; }

      for (const child of childEntries) {
        if (!child.isDirectory() || SKIP.has(child.name) || child.name.startsWith('.')) continue;
        const childDir = path.join(projectDir, child.name);
        const childName = child.name;
        const childProject = scanDir(childDir, childName, launchMap, overrides);
        if (childProject) {
          childProject.parentName = name;
          childProject.fullName = `${name}/${childName}`;
          // Inherit git from parent if child doesn't have own .git
          if (!childProject.isGit && fs.existsSync(path.join(projectDir, '.git'))) {
            childProject.isGit = true;
          }
          children.push(childProject);
        }
      }

      // Sort children: launchable first, then alphabetical
      children.sort((a, b) => {
        if (a.launchable !== b.launchable) return b.launchable - a.launchable;
        return a.name.localeCompare(b.name);
      });

      const isGit = fs.existsSync(path.join(projectDir, '.git'));
      projects.push({
        name,
        dir: projectDir,
        type: 'collection',
        startCommand: null,
        startArgs: [],
        port: null,
        framework: 'collection',
        isGit,
        launchable: false,
        capturable: false,
        children,
        childCount: children.length,
        launchableChildren: children.filter(c => c.launchable).length,
      });
    } else {
      // Regular project
      const project = scanDir(projectDir, name, launchMap, overrides);
      if (project) projects.push(project);
    }
  }

  // Sort: launchable first, then collections, then alphabetical
  projects.sort((a, b) => {
    if (a.launchable !== b.launchable) return b.launchable - a.launchable;
    if (a.type === 'collection' && b.type !== 'collection') return 1;
    if (b.type === 'collection' && a.type !== 'collection') return -1;
    return a.name.localeCompare(b.name);
  });

  return projects;
}

// --- Auto-register projects in launch.json ---
// Ensures every launchable project has a stable port and launch config.
function syncLaunchJSON(projects) {
  const launchConfig = readJSON(LAUNCH_JSON) || { version: '0.0.1', configurations: [] };
  const configs = launchConfig.configurations || [];

  // Build lookup of existing configs by cwd (most reliable key)
  const byCwd = new Map();
  const byName = new Map();
  for (const c of configs) {
    if (c.cwd) byCwd.set(c.cwd, c);
    byName.set(c.name, c);
  }

  // Collect all used ports
  const usedPorts = new Set(configs.map(c => c.port).filter(Boolean));

  // Flatten all projects
  const allProjects = projects.flatMap(p => {
    if (p.type === 'collection' && p.children) return p.children;
    return [p];
  });

  let nextAutoPort = AUTO_PORT_START;
  let nextStaticPort = STATIC_PORT_START;
  let changed = false;

  function allocPort(isStatic) {
    if (isStatic) {
      while (usedPorts.has(nextStaticPort) && nextStaticPort <= STATIC_PORT_END) nextStaticPort++;
      const port = nextStaticPort++;
      usedPorts.add(port);
      return port;
    }
    while (usedPorts.has(nextAutoPort) && nextAutoPort <= AUTO_PORT_END) nextAutoPort++;
    const port = nextAutoPort++;
    usedPorts.add(port);
    return port;
  }

  for (const p of allProjects) {
    if (!p.launchable || p.nativeApp) continue;

    // Check if already registered
    const existing = byCwd.get(p.dir) || byName.get(p.launchName || p.name);
    if (existing) {
      // Update the project's port to match launch.json
      p.port = existing.port;
      continue;
    }

    // Build a launch config for this project
    const isStatic = p.type === 'html' && !p.startCommand;
    // If the detected port conflicts with an existing registration, reassign
    const port = (p.port && !usedPorts.has(p.port)) ? p.port : allocPort(isStatic);
    usedPorts.add(port);

    const config = {
      name: p.fullName || p.name,
      port,
      cwd: p.dir,
      auto: true, // marker so we know it was auto-generated
    };

    if (isStatic) {
      // Static HTML — served by project-launcher's express, no external command
      config.runtimeExecutable = 'npx';
      config.runtimeArgs = ['serve', '-s', '.', '-l', String(port)];
    } else if (p.startCommand === 'npm') {
      config.runtimeExecutable = 'npm';
      config.runtimeArgs = [...p.startArgs];
      // Ensure port is passed for vite/dev scripts
      if (p.framework === 'vite' || p.startArgs.includes('dev')) {
        if (!config.runtimeArgs.some(a => a.includes('--port'))) {
          config.runtimeArgs.push('--', '--port', String(port));
        }
      }
    } else if (p.startCommand === 'node') {
      config.runtimeExecutable = 'node';
      config.runtimeArgs = [...p.startArgs];
    } else if (p.startCommand === 'python3') {
      config.runtimeExecutable = 'python3';
      config.runtimeArgs = [...p.startArgs];
    } else {
      continue; // Unknown command, skip
    }

    configs.push(config);
    p.port = port;
    changed = true;
    console.log(`[registry] Registered ${config.name} on port ${port}`);
  }

  if (changed) {
    launchConfig.configurations = configs;
    try {
      fs.writeFileSync(LAUNCH_JSON, JSON.stringify(launchConfig, null, 2) + '\n');
      console.log(`[registry] Updated launch.json (${configs.length} entries)`);
    } catch (err) {
      console.log(`[registry] Failed to write launch.json: ${err.message}`);
    }
  }
}

module.exports = { scanProjects, syncLaunchJSON, BASE_DIR };
