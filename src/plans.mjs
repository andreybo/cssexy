import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createPatch, diffChars, diffLines } from 'diff';
import { hash, load, save, safePath } from './storage.mjs';
import { optimize } from './analyzer.mjs';
import { config } from './config.mjs';
import { usage as checkUsage } from './usage.mjs';
import { bytes } from './statistics.mjs';

export function editsBetween(before, after) {
  const edits = [];
  let offset = 0;
  // Character diffs are costly for large files with many small removals.
  const chunks = before.length + after.length < 20_000 ? diffChars(before, after) : diffLines(before, after);
  for (const chunk of chunks) {
    if (chunk.added) edits.push({ start: offset, end: offset, text: chunk.value });
    else if (chunk.removed) { edits.push({ start: offset, end: offset + chunk.value.length, text: '' }); offset += chunk.value.length; }
    else offset += chunk.value.length;
  }
  return edits;
}
export function applyEdits(source, edits) {
  let limit = source.length;
  for (const e of [...edits].reverse()) {
    if (!Number.isInteger(e.start) || !Number.isInteger(e.end) || e.start < 0 || e.end < e.start || e.end > limit || typeof e.text !== 'string') throw new Error('Invalid or overlapping edits');
    source = source.slice(0,e.start) + e.text + source.slice(e.end);
    limit = e.start;
  }
  return source;
}
export async function verifyIndex(root, db) {
  if (!db.files.length) throw new Error('No valid stylesheets in the index. Fix the scan errors and scan again.');
  if (db.root !== root) throw new Error('Index belongs to another project; scan again');
  for (const f of db.files) if (hash(await fs.readFile(await safePath(root, f.path), 'utf8')) !== f.hash) throw new Error(`Source changed: ${f.path}. Run scan again.`);
}
export async function makePlan(root, db, approved = []) {
  await verifyIndex(root, db);
  let usage;
  if (approved.length) {
    usage = await load(root, 'usage.json');
    if (usage.indexCreatedAt !== db.createdAt || !usage.contentFiles.length) throw new Error('Run usage with content files before approving removals');
    for (const id of approved) if (!usage.candidates.some(c => c.id === id)) throw new Error(`Not an eligible usage candidate: ${id}`);
    for (const f of usage.contentFiles) if (hash(await fs.readFile(await safePath(root, f.file), 'utf8')) !== f.hash) throw new Error(`Content changed: ${f.file}; run usage again`);
  }
  if (approved.length) {
    const current = await checkUsage(root, db, await config(root));
    for (const id of approved) if (!current.candidates.some(c => c.id === id)) throw new Error(`Usage changed for ${id}; run usage again`);
  }
  const plan = { version: 1, id: crypto.randomUUID(), createdAt: new Date().toISOString(), root, approvedRemovals: approved, files: [] };
  let patch = '';
  for (const f of db.files) {
    let source = f.source;
    const removals = db.rules.filter(r => r.file === f.path && approved.includes(r.id));
    source = applyEdits(source, removals.map(r => ({ start: r.start.offset, end: r.end.offset, text: '' })).sort((a,b) => a.start-b.start));
    const { output, changes } = optimize(source, f.path);
    if (output === f.source) continue;
    const edits = editsBetween(f.source, output);
    if (applyEdits(f.source, edits) !== output) throw new Error('Patch verification failed');
    plan.files.push({ path: f.path, beforeHash: f.hash, afterHash: hash(output), beforeBytes: bytes(f.source), afterBytes: bytes(output), edits, changes, removals: removals.map(r => r.id) });
    patch += createPatch(f.path, f.source, output, 'original', 'cssexy');
  }
  await save(root, 'plan.json', plan);
  await fs.writeFile(await safePath(root, 'cssexy/changes.diff'), patch || '# No safe changes\n');
  return plan;
}
export async function applyPlan(root) {
  const plan = await load(root, 'plan.json');
  if (plan.root !== root) throw new Error('Plan belongs to another project');
  if (plan.appliedAt) throw new Error('Plan already applied');
  if (plan.approvedRemovals.length) {
    const db = await load(root, 'index.json');
    await verifyIndex(root, db);
    const current = await checkUsage(root, db, await config(root));
    if (!current.contentFiles.length) throw new Error('Content files disappeared; run usage again');
    for (const id of plan.approvedRemovals) if (!current.candidates.some(c => c.id === id)) throw new Error(`Usage changed for ${id}; deletion refused`);
  }
  const prepared = [], seen = new Set();
  for (const f of plan.files) {
    if (seen.has(f.path)) throw new Error('Duplicate plan file');
    seen.add(f.path);
    const target = await safePath(root, f.path);
    const original = await fs.readFile(target, 'utf8');
    if (hash(original) !== f.beforeHash) throw new Error(`Source changed: ${f.path}. Nothing applied.`);
    const output = applyEdits(original, f.edits);
    if (hash(output) !== f.afterHash) throw new Error(`Corrupt plan: ${f.path}`);
    prepared.push({ ...f, target, original, output });
  }
  const backup = `backups/${plan.id}`;
  // All backups are durable before touching the first source file.
  for (const f of prepared) {
    const dest = await safePath(root, `cssexy/${backup}/${f.path}`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, f.original, { flag: 'wx' });
  }
  await save(root, `${backup}/manifest.json`, { ...plan, state: 'prepared' });
  const written = [];
  try {
    for (const f of prepared) {
      if (hash(await fs.readFile(f.target, 'utf8')) !== f.beforeHash) throw new Error(`Source changed during apply: ${f.path}`);
      const staged = await safePath(root, `cssexy/${backup}/staged/${f.path}`);
      await fs.mkdir(path.dirname(staged), { recursive: true });
      await fs.writeFile(staged, f.output);
      await fs.rename(staged, f.target);
      written.push(f);
    }
  } catch (e) {
    for (const f of written.reverse()) await fs.writeFile(f.target, f.original);
    throw e;
  }
  plan.appliedAt = new Date().toISOString();
  await save(root, `${backup}/manifest.json`, { ...plan, state: 'applied' });
  await save(root, 'plan.json', plan);
  return plan;
}
export async function restore(root, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid backup ID');
  const manifest = await load(root, `backups/${id}/manifest.json`);
  if (manifest.root !== root) throw new Error('Backup belongs to another project');
  const prepared = [];
  for (const f of manifest.files) {
    const target = await safePath(root, f.path);
    const current = await fs.readFile(target, 'utf8');
    if (![f.afterHash, f.beforeHash].includes(hash(current))) throw new Error(`Modified after optimization: ${f.path}; restore refused`);
    const original = await fs.readFile(await safePath(root, `cssexy/backups/${id}/${f.path}`), 'utf8');
    if (hash(original) !== f.beforeHash) throw new Error(`Corrupt backup: ${f.path}`);
    prepared.push({ target, original });
  }
  for (const f of prepared) await fs.writeFile(f.target, f.original);
  return prepared.length;
}
