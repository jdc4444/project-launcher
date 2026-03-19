const fs = require('fs');
const path = require('path');

const BASE_DIR = path.join(require('os').homedir(), 'Documents', 'Code');
const LAUNCH_JSON = path.join(BASE_DIR, '.claude', 'launch.json');
const OVERRIDES_FILE = path.join(require('os').homedir(), '.project-launcher', 'projects.json');

const SKIP = new Set(['.claude', '.git', 'node_modules', '.DS_Store', 'blenderkit_data', 'build', 'dist', '2025', '2026']);

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

// --- Deep entrypoint discovery ---
// Checks if a Python file contains a web server (HTTP, Flask, Streamlit, Dash, etc.)
const WEB_SERVER_PATTERNS = /from\s+http\.server|BaseHTTPRequestHandler|ThreadingHTTPServer|import\s+flask|from\s+flask|import\s+streamlit|import\s+dash|from\s+dash|import\s+gradio|import\s+uvicorn|from\s+fastapi|app\.run\s*\(|\.listen\s*\(/;
const DESKTOP_GUI_PATTERNS = /import\s+tkinter|from\s+tkinter|import\s+PyQt|from\s+PyQt|\.mainloop\(\)/;

function detectPythonEntry(projectDir, rootPyFiles) {
  // Check root-level .py files first
  const usesDesktopGUI = rootPyFiles.some(f => {
    try {
      const src = fs.readFileSync(path.join(projectDir, f.name), 'utf8');
      return DESKTOP_GUI_PATTERNS.test(src);
    } catch { return false; }
  });
  if (usesDesktopGUI) {
    return { type: 'python', startCommand: null, startArgs: [], port: null, framework: 'python-gui' };
  }

  // Look for a named server file at root
  const serveFile = rootPyFiles.find(f => /serve|server|app|main|dashboard|run/.test(f.name));
  if (serveFile) {
    // Verify it's actually a web server
    try {
      const src = fs.readFileSync(path.join(projectDir, serveFile.name), 'utf8');
      if (WEB_SERVER_PATTERNS.test(src)) {
        return {
          type: 'python', startCommand: 'python3', startArgs: [serveFile.name],
          port: detectPort(projectDir, null), framework: 'python',
        };
      }
    } catch {}
    // Still use it if it's named serve/server/app
    if (/^(serve|server|app)\b/.test(serveFile.name)) {
      return {
        type: 'python', startCommand: 'python3', startArgs: [serveFile.name],
        port: detectPort(projectDir, null), framework: 'python',
      };
    }
  }

  // --- Deep search: look in subdirectories (max 3 levels) for web servers ---
  // Prefer: run_*.sh scripts, then .py files with web server imports
  // Skip archive/, node_modules/, .git/, venv/, __pycache__/
  const DEEP_SKIP = new Set(['archive', 'node_modules', '.git', 'venv', '__pycache__', '.venv', 'dist', 'build', 'docs', 'tests']);

  function deepSearch(dir, depth, relDir) {
    if (depth > 3) return [];
    const results = [];
    let children;
    try { children = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }

    for (const child of children) {
      const childRel = relDir ? `${relDir}/${child.name}` : child.name;
      if (child.isDirectory()) {
        if (DEEP_SKIP.has(child.name) || child.name.startsWith('.') || child.name.startsWith('_')) continue;
        results.push(...deepSearch(path.join(dir, child.name), depth + 1, childRel));
      } else if (child.name.endsWith('.py') || child.name.match(/^run_.*\.sh$/)) {
        results.push({ absPath: path.join(dir, child.name), relPath: childRel, name: child.name, dir });
      }
    }
    return results;
  }

  const deepFiles = deepSearch(projectDir, 0, '');

  // First check for run_*.sh scripts (they often set up venvs and correct args)
  const runScripts = deepFiles.filter(f => f.name.match(/^run_.*\.sh$/));
  if (runScripts.length > 0) {
    // Pick the most recently modified run script
    const sorted = runScripts.sort((a, b) => {
      try {
        return fs.statSync(b.absPath).mtimeMs - fs.statSync(a.absPath).mtimeMs;
      } catch { return 0; }
    });
    const best = sorted[0];
    // Parse the run script for a port
    try {
      const src = fs.readFileSync(best.absPath, 'utf8');
      const portMatch = src.match(/--port\s+(\d{4,5})/);
      return {
        type: 'python', startCommand: 'bash', startArgs: [best.relPath],
        port: portMatch ? parseInt(portMatch[1]) : null, framework: 'python',
        entrypoint: best.relPath,
      };
    } catch {}
  }

  // Then check for .py files with web server patterns
  const webServers = deepFiles.filter(f => {
    if (!f.name.endsWith('.py')) return false;
    try {
      const src = fs.readFileSync(f.absPath, 'utf8');
      return WEB_SERVER_PATTERNS.test(src) && !DESKTOP_GUI_PATTERNS.test(src);
    } catch { return false; }
  });

  if (webServers.length > 0) {
    // Prefer files named dashboard/app/serve/server, then most recently modified
    const scored = webServers.map(f => ({
      ...f,
      score: /dashboard|app|serve|server|main/.test(f.name) ? 10 : 0,
      mtime: (() => { try { return fs.statSync(f.absPath).mtimeMs; } catch { return 0; } })(),
    }));
    scored.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
    const best = scored[0];

    // Detect port from the file
    let port = null;
    try {
      const src = fs.readFileSync(best.absPath, 'utf8');
      const portMatch = src.match(/(?:port|PORT)\s*(?:=|:)\s*(\d{4,5})/)
        || src.match(/--port\s+(\d{4,5})/)
        || src.match(/\.listen\(\s*(\d{4,5})/);
      if (portMatch) port = parseInt(portMatch[1]);
    } catch {}

    return {
      type: 'python', startCommand: 'python3', startArgs: [best.relPath],
      port, framework: 'python', entrypoint: best.relPath,
      cwd: best.dir, // The directory containing the entrypoint
    };
  }

  // No web server found — return generic python (not launchable)
  return rootPyFiles.length > 0
    ? { type: 'python', startCommand: null, startArgs: [], port: null, framework: 'python' }
    : null;
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
    const pyResult = detectPythonEntry(projectDir, pyFiles);
    if (pyResult) return pyResult;
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

  // Last resort: deep search for Python web servers even if no root .py files
  const deepPyResult = detectPythonEntry(projectDir, []);
  if (deepPyResult && deepPyResult.startCommand) return deepPyResult;

  return { type: 'unknown', startCommand: null, startArgs: [], port: null, framework: 'unknown' };
}

// --- .plrc support ---
// .plrc is a JSON file in a project directory that acts as the permanent source of truth.
// It overrides auto-detection, launch.json, and everything else.
// Fields: port, category, entrypoint, thumbnail, startCommand, startArgs, framework
function readPlrc(projectDir) {
  const plrcPath = path.join(projectDir, '.plrc');
  try {
    const data = JSON.parse(fs.readFileSync(plrcPath, 'utf8'));
    return data;
  } catch {
    return null;
  }
}

function writePlrc(projectDir, data) {
  const plrcPath = path.join(projectDir, '.plrc');
  try {
    // Merge with existing .plrc if present
    const existing = readPlrc(projectDir) || {};
    const merged = { ...existing, ...data };
    fs.writeFileSync(plrcPath, JSON.stringify(merged, null, 2) + '\n');
    return true;
  } catch (err) {
    console.log(`[plrc] Failed to write ${plrcPath}: ${err.message}`);
    return false;
  }
}

// Scan a single directory for a project, return project object or null
function scanDir(projectDir, name, launchMap, overrides) {
  const detected = detectType(projectDir);

  // .plrc is highest priority — overrides everything
  const plrc = readPlrc(projectDir);
  if (plrc) {
    if (plrc.port != null) detected.port = plrc.port;
    if (plrc.category) detected._plrcCategory = plrc.category;
    if (plrc.entrypoint) {
      detected.startArgs = [plrc.entrypoint];
      detected.entrypoint = plrc.entrypoint;
    }
    if (plrc.startCommand) detected.startCommand = plrc.startCommand;
    if (plrc.startArgs) detected.startArgs = plrc.startArgs;
    if (plrc.framework) detected.framework = plrc.framework;
    if (plrc.thumbnail) detected.thumbnail = plrc.thumbnail;
    if (plrc.capturable != null) detected.capturable = plrc.capturable;
    if (plrc.launchable != null) detected._plrcLaunchable = plrc.launchable;
  }

  // Check launch.json config — match by cwd first, then by name
  // .plrc port takes precedence over launch.json port
  let launchInfo = null;
  for (const [key, config] of launchMap) {
    const configCwd = config.cwd;
    if (configCwd && configCwd === projectDir) {
      launchInfo = config;
      break;
    }
  }
  if (!launchInfo) {
    for (const [key, config] of launchMap) {
      const configCwd = config.cwd || '';
      if (key === name || path.basename(configCwd) === name) {
        launchInfo = config;
        break;
      }
    }
  }

  if (launchInfo) {
    detected.startCommand = detected.startCommand || launchInfo.runtimeExecutable;
    detected.startArgs = (plrc?.startArgs || plrc?.entrypoint) ? detected.startArgs : (launchInfo.runtimeArgs || []);
    // .plrc port wins over launch.json
    if (!plrc?.port) detected.port = launchInfo.port || detected.port;
    detected.launchName = launchInfo.name;
  }

  const isGit = fs.existsSync(path.join(projectDir, '.git'));
  const launchable = detected._plrcLaunchable != null
    ? detected._plrcLaunchable
    : (detected.startCommand !== null || detected.type === 'html');

  // Categorize: .plrc category wins, then auto-detect
  let category = 'app';
  if (detected._plrcCategory) {
    category = detected._plrcCategory;
  } else {
    const isMCP = /mcp/i.test(name) || fs.existsSync(path.join(projectDir, 'SKILL.md'));
    if (!detected.nativeApp && (!launchable || (!detected.port && detected.type !== 'html') || isMCP)) {
      category = 'utility';
    }
  }

  return {
    name,
    dir: projectDir,
    ...detected,
    isGit,
    launchable,
    category,
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

module.exports = { scanProjects, syncLaunchJSON, readPlrc, writePlrc, BASE_DIR };
