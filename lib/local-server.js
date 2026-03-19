const http = require('http');
const https = require('https');

function normalizeProtocol(value) {
  return String(value || 'http').toLowerCase() === 'https' ? 'https' : 'http';
}

function getProjectProtocol(projectOrProtocol) {
  if (typeof projectOrProtocol === 'string') return normalizeProtocol(projectOrProtocol);
  return normalizeProtocol(projectOrProtocol?.protocol);
}

function getLocalUrl(port, projectOrProtocol = 'http') {
  const protocol = getProjectProtocol(projectOrProtocol);
  return `${protocol}://localhost:${port}`;
}

function probeLocalServer(port, projectOrProtocol = 'http', timeout = 3000) {
  const protocol = getProjectProtocol(projectOrProtocol);
  const client = protocol === 'https' ? https : http;

  return new Promise(resolve => {
    const req = client.get(getLocalUrl(port, protocol), { timeout, rejectUnauthorized: false }, res => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

module.exports = { getLocalUrl, getProjectProtocol, probeLocalServer };
