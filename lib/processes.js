const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const express = require('express');

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

function healthCheck(port) {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${port}`, { timeout: 3000 }, res => {
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function startProject(project) {
  const name = project.name;

  // Already running?
  if (processes.has(name)) {
    const existing = processes.get(name);
    if (existing.status === 'running') {
      return { ok: false, error: 'Already running', port: existing.port };
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

  // Check if port is occupied
  if (port) {
    const pids = checkPort(port);
    if (pids.length > 0) {
      return { ok: false, error: `Port ${port} already in use by PID ${pids.join(', ')}` };
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
      ready = await healthCheck(port);
      if (ready) break;
    }
    entry.status = ready ? 'running' : (entry.status === 'starting' ? 'starting' : entry.status);
  } else {
    entry.status = 'running';
  }

  broadcast('status', { name, status: entry.status, port, pid: proc.pid });
  return { ok: true, port, pid: proc.pid, status: entry.status };
}

function startStaticServer(project) {
  return new Promise(resolve => {
    const app = express();
    app.use(express.static(project.dir));

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
          logs: [{ stream: 'system', line: `Static server on port ${port}`, time: Date.now() }],
        };
        staticServers.set(project.name, server);
        processes.set(project.name, entry);
        broadcast('status', { name: project.name, status: 'running', port });
        resolve({ ok: true, port, status: 'running' });
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

module.exports = {
  startProject, stopProject, getStatus, getLogs, getAllStatuses,
  sseClients, broadcast, processes,
};
