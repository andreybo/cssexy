import fs from 'node:fs/promises';
import picomatch from 'picomatch';
import { walk, safePath, hash } from './storage.mjs';

export async function usage(root, db, config) {
  const matches = picomatch(config.content, { dot: true });
  const sources = [];
  for (const file of await walk(root, config.ignore)) {
    if (!matches(file) || /\.(css|scss|sass)$/.test(file)) continue;
    const text = await fs.readFile(await safePath(root, file), 'utf8');
    sources.push({ file, text, hash: hash(text) });
  }
  const safe = config.safelist.length ? picomatch(config.safelist) : () => false;
  const classes = Object.entries(db.classIndex).map(([className, rules]) => {
    const references = sources.filter(s => s.text.includes(className)).map(s => s.file);
    return { className, rules, references, status: safe(className) ? 'safelisted' : references.length ? 'referenced' : 'candidate' };
  });
  const absent = new Set(classes.filter(c => c.status === 'candidate').map(c => c.className));
  // Only simple class selector lists are eligible. Pseudos, :not(), nesting and
  // complex combinators need DOM/framework knowledge and remain review-only.
  const candidates = db.rules.filter(r => !r.dynamic && r.ancestry.length === 0 && r.context.length === 0 &&
    r.resolved.every(s => /^\.[a-zA-Z_][\w-]*(\s*,\s*\.[a-zA-Z_][\w-]*)*$/.test(s)) &&
    r.classes.length > 0 && r.classes.every(c => absent.has(c)) &&
    !/[{}]/.test(r.source.slice(r.source.indexOf('{') + 1, -1)) &&
    !/\$|#\{|@/.test(r.source));
  return { version: 1, indexCreatedAt: db.createdAt, contentFiles: sources.map(({ file, hash }) => ({ file, hash })), classes,
    candidates: candidates.map(r => ({ id: r.id, file: r.file, selector: r.selector, line: r.start.line })),
    warning: 'Absence in source is not proof of non-use: dynamic classes, CMS, external templates and CSS Modules need review. Only explicitly approved rule IDs can be removed.' };
}
