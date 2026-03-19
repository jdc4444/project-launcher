const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const CURRENT_COMMIT_TTL_MS = 30000;
const currentCommitCache = new Map();

function run(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function isGitRepo(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

function getCurrentCommit(dir) {
  if (!isGitRepo(dir)) return null;
  const now = Date.now();
  const cached = currentCommitCache.get(dir);
  if (cached && cached.expiresAt > now) return cached.value;

  const summary = run('git log -1 --pretty=format:"%h|%H|%s|%ci|%ct"', dir);
  if (!summary) {
    currentCommitCache.delete(dir);
    return null;
  }

  const [sha, fullSha, message, date, timestampRaw] = summary.split('|');
  const label = run('git describe --tags --always', dir);
  const value = sha ? {
    sha,
    fullSha,
    message,
    date,
    timestamp: timestampRaw ? Number(timestampRaw) : null,
    label,
  } : null;

  currentCommitCache.set(dir, {
    value,
    expiresAt: now + CURRENT_COMMIT_TTL_MS,
  });
  return value;
}

function clearCurrentCommitCache(dir = null) {
  if (dir) {
    currentCommitCache.delete(dir);
    return;
  }
  currentCommitCache.clear();
}

function getTags(dir) {
  if (!isGitRepo(dir)) return [];
  const raw = run('git tag --sort=-creatordate --format="%(refname:short)|%(creatordate:iso)|%(objectname:short)"', dir);
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map(line => {
    const [name, date, sha] = line.split('|');
    return { name, date, sha };
  });
}

function getRecentCommits(dir, count = 20) {
  if (!isGitRepo(dir)) return [];
  const raw = run(`git log --oneline -${count} --pretty=format:"%h|%ci|%s"`, dir);
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map(line => {
    const [sha, ...rest] = line.split('|');
    const date = rest[0];
    const message = rest.slice(1).join('|');
    return { sha, date, message };
  });
}

function getVersionHistory(dir) {
  if (!isGitRepo(dir)) return { current: null, tags: [], commits: [] };
  return {
    current: getCurrentCommit(dir),
    tags: getTags(dir),
    commits: getRecentCommits(dir),
  };
}

module.exports = { getCurrentCommit, getTags, getRecentCommits, getVersionHistory, isGitRepo, clearCurrentCommitCache };
