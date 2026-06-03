// Lightweight "lint": syntax-check every source module with `node --check`.
// (No third-party linter — keeps the project zero-dependency.)
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const targets = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'data') continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (/\.(mjs|js)$/.test(name)) targets.push(p);
  }
})(ROOT);

let fail = 0;
for (const f of targets.sort()) {
  try {
    // ES modules in src/ + server; node infers from package.json "type":"module".
    execFileSync('node', ['--check', f], { stdio: 'pipe' });
    console.log('  ok   ' + f.slice(ROOT.length + 1));
  } catch (e) {
    fail++;
    console.error('  FAIL ' + f.slice(ROOT.length + 1) + '\n' + (e.stderr || e.message).toString());
  }
}
console.log(`\nlint: ${targets.length - fail}/${targets.length} files OK`);
process.exit(fail ? 1 : 0);
