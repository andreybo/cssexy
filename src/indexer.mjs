import fs from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';
import scss from 'postcss-scss';
import selectorParser from 'postcss-selector-parser';
import resolveNested from 'postcss-resolve-nested-selector';
import { hash, safePath, save } from './storage.mjs';

export function parse(text, file) { return file.endsWith('.scss') ? scss.parse(text, { from: file }) : postcss.parse(text, { from: file }); }
export function classes(selector) {
  const names = new Set();
  try { selectorParser(s => s.walkClasses(n => names.add(n.value))).processSync(selector); }
  catch { return null; }
  return [...names];
}
export function indexSource(text, file) {
  const ast = parse(text, file), rules = [];
  ast.walkRules(node => {
    const context = [], ancestry = [];
    for (let p = node.parent; p && p.type !== 'root'; p = p.parent) {
      if (p.type === 'atrule') context.unshift({ name: p.name, params: p.params, offset: p.source.start.offset });
      if (p.type === 'rule') ancestry.unshift(p.selector);
    }
    let resolved;
    try { resolved = node.selectors.flatMap(selector => resolveNested(selector, node)); } catch { resolved = [node.selector]; }
    rules.push({
      id: `${file}:${node.source.start.offset}`, file, selector: node.selector, resolved,
      classes: [...new Set(resolved.flatMap(s => classes(s) ?? []))],
      dynamic: /[$#]|:export|:import/.test(node.selector) || resolved.some(s => classes(s) === null),
      ancestry, context, start: node.source.start, end: node.source.end,
      declarations: (node.nodes ?? []).filter(n => n.type === 'decl').map(n => ({ property: n.prop, value: n.value, important: !!n.important, start: n.source.start, end: n.source.end })),
      source: text.slice(node.source.start.offset, node.source.end.offset)
    });
  });
  return rules;
}
export async function scan(root, files) {
  const db = { version: 1, root, createdAt: new Date().toISOString(), files: [], rules: [], classIndex: {}, errors: [] };
  for (const file of files) {
    const target = await safePath(root, file);
    let source, rules;
    try {
      source = await fs.readFile(target, 'utf8');
      rules = indexSource(source, file);
    } catch (error) {
      if (error.name !== 'CssSyntaxError' && !['ENOENT','EACCES','EPERM'].includes(error.code)) throw error;
      db.errors.push({ file, reason: error.reason ?? error.message, line: error.line ?? null, column: error.column ?? null });
      continue;
    }
    db.files.push({ path: file, hash: hash(source), source });
    db.rules.push(...rules);
    for (const rule of rules) for (const name of rule.classes) (db.classIndex[name] ??= []).push(rule.id);
  }
  await save(root, 'index.json', db);
  await save(root, 'scan-report.json', { createdAt: db.createdAt, selected: files.length, indexed: db.files.length, skipped: db.errors.length, errors: db.errors });
  return db;
}
