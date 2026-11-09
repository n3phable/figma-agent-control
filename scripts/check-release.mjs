/**
 * [INPUT]: Git's tracked/unignored file list, package.json, and npm's pack manifest.
 * [OUTPUT]: issuesIn(text, file) and a release check with file-level diagnostics.
 * [POS]: Local and CI publication gate. It never publishes or contacts Figma.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const rules = [
  ['non-English text', /\p{Script=Han}/u],
  ['private key', /[-]{5}BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY[-]{5}/],
  ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['personal home path', /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//],
  ['private network address', /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/]
];

export const issuesIn = (text, file = '') => rules.filter(([name, pattern]) => {
  const translated = file === 'README_ZH.md' || /^docs\/zh_cn\/[^/]+\.md$/.test(file);
  return !(translated && name === 'non-English text') && pattern.test(text);
}).map(([name]) => name);
const binary = file => /\.(png|webm)$/i.test(file);
const forbidden = file => /(^|\/)(?:\.git|node_modules|\.figma-agent-control|test-results|coverage)(\/|$)|(^|\/)\.env(?:\.|$)|\.pem$|\.key$/i.test(file);

function check() {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))];
  const failures = [];
  for (const file of files) {
    if (forbidden(file)) failures.push(`${file}: private or generated file`);
    const absolute = path.join(root, file);
    if (fs.lstatSync(absolute).isSymbolicLink()) {
      failures.push(`${file}: distribution files must not be symbolic links`);
      continue;
    }
    if (binary(file)) continue;
    for (const issue of issuesIn(fs.readFileSync(absolute, 'utf8'), file)) failures.push(`${file}: ${issue}`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.private === true || pkg.license !== 'MIT') failures.push('package.json: expected a public MIT package');
  if (!pkg.repository?.url || !pkg.bugs?.url || !pkg.author?.name) failures.push('package.json: repository, issue tracker and author are required');
  if (Object.keys(pkg.dependencies ?? {}).length) failures.push('package.json: the runtime must remain dependency-free');
  const tagIndex = process.argv.indexOf('--tag');
  if (tagIndex !== -1 && process.argv[tagIndex + 1] !== `v${pkg.version}`) failures.push('release tag must exactly match the package version');

  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
  const packed = new Set(pack.files.map(entry => entry.path));
  for (const required of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'README.md', 'README_ZH.md', 'AGENTS.md', 'SECURITY.md', 'bin/figma-agent-control.mjs', 'plugin/main.js', 'plugin/extract.js', 'plugin/ui.html', 'lib/motion.js', 'lib/prototype.js', 'skills/figma-agent-control/SKILL.md', 'docs/zh_cn/README.md']) {
    if (!packed.has(required)) failures.push(`package: missing ${required}`);
  }
  for (const file of packed) {
    if (forbidden(file) || /^(?:tests|scripts|\.github)\//.test(file)) failures.push(`package: unexpected ${file}`);
    if (!file.endsWith('.md')) continue;
    const markdown = fs.readFileSync(path.join(root, file), 'utf8');
    for (const [, target] of markdown.matchAll(/!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (/^(?:[a-z]+:|#)/i.test(target)) continue;
      const relative = decodeURIComponent(target.split('#')[0]);
      const linked = path.posix.normalize(path.posix.join(path.posix.dirname(file), relative));
      if (!packed.has(linked)) failures.push(`package: ${file} links to missing ${linked}`);
    }
  }
  if (failures.length) throw Error(failures.join('\n'));
  process.stdout.write(`Release checks passed: ${files.length} repository files, ${packed.size} package files, version ${pkg.version}.\n`);
}

function selfTest() {
  assert.deepEqual(issuesIn('English documentation with Unicode escapes: \\u4e2d'), []);
  assert.deepEqual(issuesIn('\u4e2d'), ['non-English text']);
  assert.deepEqual(issuesIn('\u4e2d', 'docs/zh_cn/protocol.md'), []);
  assert.deepEqual(issuesIn('\u4e2d', 'README_ZH.md'), []);
  assert.deepEqual(issuesIn('\u4e2d', 'src/example.mjs'), ['non-English text']);
  assert.deepEqual(issuesIn('ghp_' + 'a'.repeat(36)), ['GitHub credential']);
  assert.deepEqual(issuesIn('ghp_' + 'a'.repeat(36), 'docs/zh_cn/protocol.md'), ['GitHub credential']);
  assert.deepEqual(issuesIn('/' + 'Users/' + 'sample/secret.txt'), ['personal home path']);
  assert.deepEqual(issuesIn('http://127.0.0.1:32523'), []);
  assert.equal(forbidden('src/.env.production'), true);
  assert.equal(forbidden('docs/agent-guide.md'), false);
  process.stdout.write('Release scanner self-checks passed.\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.argv.includes('--self-test') ? selfTest() : check(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
