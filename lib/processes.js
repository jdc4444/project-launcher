const { spawn, execSync } = require('child_process');
const net = require('net');
const path = require('path');
const express = require('express');
const { getProjectProtocol, probeLocalServer } = require('./local-server');

// Active processes: Map<projectName, { proc, port, pid, startedAt, status, logs }>
const processes = new Map();

// Static servers for HTML projects: Map<projectName, { server, port }>
const staticServers = new Map();

// SSE clients for real-time updates
const sseClients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(msg);
  }
}

function checkPort(port) {
  try {
    const result = execSync(`lsof -i :${port} -t`, { encoding: 'utf8', timeout: 3000 }).trim();
    return result ? result.split('\n').map(Number) : [];
  } catch {
    return [];
  }
}

function healthCheck(port, projectOrProtocol = 'http') {
  return probeLocalServer(port, projectOrProtocol, 3000);
}

async function startProject(project) {
  const name = project.fullName || project.name;
  const protocol = getProjectProtocol(project);

  // Already running?
  if (processes.has(name)) {
    const existing = processes.get(name);
    if (existing.status === 'running') {
      return { ok: true, port: existing.port, status: 'running', adopted: true, protocol: existing.protocol };
    }
  }

  // For static HTML projects, use built-in express server
  if (project.type === 'html' && !project.startCommand) {
    return startStaticServer(project);
  }

  // Native apps — just open them, no port/process tracking
  if (project.nativeApp) {
    const { execSync } = require('child_process');
    try {
      execSync(`open "${path.join(project.dir, project.startArgs[0])}"`, { timeout: 5000 });
      return { ok: true, status: 'running', nativeApp: true };
    } catch (err) {
      return { ok: false, error: `Failed to open app: ${err.message}` };
    }
  }

  if (!project.startCommand) {
    return { ok: false, error: 'No start command detected' };
  }

  const port = project.port;

  // Check if port is occupied — if so, the app is likely already running externally
  if (port) {
    const pids = checkPort(port);
    if (pids.length > 0) {
      // Verify it's actually serving HTTP
      const alive = await healthCheck(port, protocol);
      if (alive) {
        // Track it as running so the UI shows the right state
        processes.set(name, {
          proc: null,
          port,
          pid: pids[0],
          startedAt: new Date().toISOString(),
          status: 'running',
          protocol,
          logs: [{ stream: 'system', line: `Adopted existing process on port ${port} (PID ${pids[0]})`, time: Date.now() }],
          external: true,
        });
        broadcast('status', { name, status: 'running', port, pid: pids[0], protocol });
        return { ok: true, port, pid: pids[0], status: 'running', adopted: true, protocol };
      }
      return { ok: false, error: `Port ${port} in use by PID ${pids.join(', ')} but not responding` };
    }
  }

  const cwd = project.dir;
  const logs = [];
  const maxLogs = 200;

  const proc = spawn(project.startCommand, project.startArgs, {
    cwd,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: port ? String(port) : undefined, NODE_ENV: 'development' },
  });

  const entry = {
    proc,
    port,
    pid: proc.pid,
    startedAt: new Date().toISOString(),
    status: 'starting',
    protocol,
    logs,
  };

  const pushLog = (stream, line) => {
    logs.push({ stream, line, time: Date.now() });
    if (logs.length > maxLogs) logs.shift();
  };

  proc.stdout.on('data', data => {
    const lines = data.toString().split('\n').filter(Boolean);
    lines.forEach(line => pushLog('stdout', line));
  });

  proc.stderr.on('data', data => {
    const lines = data.toString().split('\n').filter(Boolean);
    lines.forEach(line => pushLog('stderr', line));
  });

  proc.on('error', err => {
    entry.status = 'error';
    pushLog('stderr', `Process error: ${err.message}`);
    broadcast('status', { name, status: 'error', error: err.message });
  });

  proc.on('exit', (code, signal) => {
    entry.status = 'stopped';
    pushLog('system', `Process exited with code ${code}, signal ${signal}`);
    broadcast('status', { name, status: 'stopped', code, signal });
  });

  processes.set(name, entry);

  // Wait for server to be ready
  if (port) {
    let ready = false;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (entry.status === 'error' || entry.status === 'stopped') break;
      ready = await healthCheck(port, protocol);
      if (ready) break;
    }
    entry.status = ready ? 'running' : (entry.status === 'starting' ? 'starting' : entry.status);
  } else {
    entry.status = 'running';
  }

  broadcast('status', { name, status: entry.status, port, pid: proc.pid, protocol });
  return { ok: true, port, pid: proc.pid, status: entry.status, protocol };
}

function startStaticServer(project) {
  return new Promise(resolve => {
    const app = express();
    app.use(express.static(project.dir));
    const name = project.fullName || project.name;

    // Try ports starting from 4800
    let port = 4800;
    const tryListen = () => {
      const server = app.listen(port, () => {
        const entry = {
          proc: null,
          port,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          status: 'running',
          protocol: 'http',
          logs: [{ stream: 'system', line: `Static server on port ${port}`, time: Date.now() }],
        };
        staticServers.set(name, server);
        processes.set(name, entry);
        broadcast('status', { name, status: 'running', port, protocol: 'http' });
        resolve({ ok: true, port, status: 'running', protocol: 'http' });
      });
      server.on('error', err => {
        if (err.code === 'EADDRINUSE') {
          port++;
          tryListen();
        } else {
          resolve({ ok: false, error: err.message });
        }
      });
    };
    tryListen();
  });
}

async function stopProject(name) {
  const entry = processes.get(name);
  if (!entry) return { ok: false, error: 'Not running' };

  // Static server
  const staticServer = staticServers.get(name);
  if (staticServer) {
    staticServer.close();
    staticServers.delete(name);
    processes.delete(name);
    broadcast('status', { name, status: 'stopped' });
    return { ok: true };
  }

  // External/adopted process — just stop tracking, don't kill
  if (entry.external) {
    processes.delete(name);
    broadcast('status', { name, status: 'stopped' });
    return { ok: true, note: 'Stopped tracking (external process still running)' };
  }

  // Child process
  if (entry.proc) {
    entry.proc.kill('SIGTERM');
    // Force kill after 5s
    const timeout = setTimeout(() => {
      try { entry.proc.kill('SIGKILL'); } catch {}
    }, 5000);

    entry.proc.on('exit', () => clearTimeout(timeout));
  }

  entry.status = 'stopped';
  broadcast('status', { name, status: 'stopped' });
  return { ok: true };
}

function getStatus(name) {
  const entry = processes.get(name);
  if (!entry) return { status: 'stopped' };
  return {
    status: entry.status,
    port: entry.port,
    pid: entry.pid,
    startedAt: entry.startedAt,
    protocol: entry.protocol,
  };
}

function getLogs(name, count = 100) {
  const entry = processes.get(name);
  if (!entry) return [];
  return entry.logs.slice(-count);
}

function getAllStatuses() {
  const statuses = {};
  for (const [name, entry] of processes) {
    statuses[name] = {
      status: entry.status,
      port: entry.port,
      pid: entry.pid,
      startedAt: entry.startedAt,
      protocol: entry.protocol,
    };
  }
  return statuses;
}

// Cleanup on exit
function cleanupAll() {
  for (const [name, entry] of processes) {
    if (entry.proc) {
      try { entry.proc.kill('SIGTERM'); } catch {}
    }
  }
  for (const [name, server] of staticServers) {
    try { server.close(); } catch {}
  }
}

process.on('SIGINT', () => { cleanupAll(); process.exit(0); });
process.on('SIGTERM', () => { cleanupAll(); process.exit(0); });

// On startup, detect projects already running on their known ports
async function detectRunning(projects) {
  let found = 0;
  for (const p of projects) {
    if (!p.port || processes.has(p.fullName || p.name)) continue;
    const pids = checkPort(p.port);
    if (pids.length > 0) {
      const protocol = getProjectProtocol(p);
      const alive = await healthCheck(p.port, protocol);
      if (alive) {
        const name = p.fullName || p.name;
        processes.set(name, {
          proc: null,
          port: p.port,
          pid: pids[0],
          startedAt: new Date().toISOString(),
          status: 'running',
          protocol,
          logs: [{ stream: 'system', line: `Detected running on port ${p.port} (PID ${pids[0]})`, time: Date.now() }],
          external: true,
        });
        broadcast('status', { name, status: 'running', port: p.port, pid: pids[0], protocol });
        found++;
      }
    }
  }
  return found;
}

// --- Lightweight background port poll ---
// TCP-only check — no HTTP, no lsof. ~1ms per port.
function tcpAlive(port) {
  return new Promise(resolve => {
    const sock = net.connect({ port, host: '127.0.0.1', timeout: 500 });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

let pollProjects = []; // set by startPortPoll
let pollRunning = false;

async function pollPorts() {
  if (pollRunning) return;
  pollRunning = true;
  for (const p of pollProjects) {
    if (!p.port) continue;
    const name = p.fullName || p.name;
    const alive = await tcpAlive(p.port);
    const known = processes.get(name);

    if (alive && (!known || known.status !== 'running')) {
      // Port just came up — mark as running
      processes.set(name, {
        proc: null, port: p.port, pid: null,
        startedAt: new Date().toISOString(),
        status: 'running', protocol: getProjectProtocol(p), logs: [], external: true,
      });
      broadcast('status', { name, status: 'running', port: p.port, protocol: getProjectProtocol(p) });
    } else if (!alive && known?.status === 'running' && known.external) {
      // External process went away — mark stopped
      processes.delete(name);
      broadcast('status', { name, status: 'stopped' });
    }
  }
  pollRunning = false;
}

function startPortPoll(projects) {
  // Flatten collections
  pollProjects = projects.flatMap(p =>
    p.type === 'collection' && p.children ? p.children : [p]
  ).filter(p => p.port);
  // Poll every 5 seconds
  setInterval(pollPorts, 5000);
  // Initial poll after 1s (detectRunning handles immediate startup)
  setTimeout(pollPorts, 1000);
}

module.exports = {
  startProject, stopProject, getStatus, getLogs, getAllStatuses,
  sseClients, broadcast, processes, detectRunning, startPortPoll,
};
