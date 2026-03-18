const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function run(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function isGitRepo(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

function getCurrentCommit(dir) {
  if (!isGitRepo(dir)) return null;
  const sha = run('git rev-parse --short HEAD', dir);
  const fullSha = run('git rev-parse HEAD', dir);
  const message = run('git log -1 --pretty=%s', dir);
  const date = run('git log -1 --pretty=%ci', dir);
  const label = run('git describe --tags --always', dir);
  return sha ? { sha, fullSha, message, date, label } : null;
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

module.exports = { getCurrentCommit, getTags, getRecentCommits, getVersionHistory, isGitRepo };
