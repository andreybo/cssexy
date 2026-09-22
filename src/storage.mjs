import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import picomatch from 'picomatch';

export const hash = text => crypto.createHash('sha256').update(text).digest('hex');
export const workspace = root => path.join(root, 'cssexy');
export async function safePath(root, relative) {
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Unsafe path: ${relative}`);
  let current = root;
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Symlink refused: ${current}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return target;
}
export async function save(root, name, data) {
  const file = await safePath(root, `cssexy/${name}`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await fs.rename(tmp, file);
}
export async function load(root, name) {
  return JSON.parse(await fs.readFile(await safePath(root, `cssexy/${name}`), 'utf8'));
}
export async function walk(root, ignores = []) {
  const ignored = picomatch([...ignores, 'cssexy', 'cssexy/**', '**/node_modules/**', '**/.git/**', '**/.kilo/**', '**/.worktrees/**', '**/.claude/worktrees/**'], { dot: true });
  const result = [];
  async function visit(dir, prefix = '') {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const rel = prefix + entry.name;
      if (entry.isSymbolicLink() || ignored(rel) || ignored(rel + '/')) continue;
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), rel + '/');
      else if (entry.isFile()) result.push(rel);
    }
  }
  await visit(root);
  return result;
}
