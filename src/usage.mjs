import fs from 'node:fs/promises';
import picomatch from 'picomatch';
import selectorParser from 'postcss-selector-parser';
import { walk, safePath, hash } from './storage.mjs';

const classCharacter = character => character !== undefined && /[A-Za-z0-9_-]/.test(character);

function hasClassReference(text, className) {
  let at = -1;
  while ((at = text.indexOf(className, at + 1)) !== -1) {
    if (!classCharacter(text[at - 1]) && !classCharacter(text[at + className.length])) return true;
  }
  return false;
}

function hasMissingRequiredClass(selectors, missing) {
  try {
    const parsed = selectorParser().astSync(selectors.join(','));
    return parsed.nodes.length > 0 && parsed.nodes.every(selector => {
      let requiredClassIsMissing = false;
      selector.walkClasses(node => {
        // Classes inside :not(), :is(), :where(), etc. are conditional.
        if (node.parent === selector && missing.has(node.value)) requiredClassIsMissing = true;
      });
      return requiredClassIsMissing;
    });
  } catch { return false; }
}

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
    const references = sources.filter(s => hasClassReference(s.text, className)).map(s => s.file);
    return { className, rules, references, status: safe(className) ? 'safelisted' : references.length ? 'referenced' : 'candidate' };
  });
  const absent = new Set(classes.filter(c => c.status === 'candidate').map(c => c.className));
  const safeContexts = new Set(['media', 'supports', 'container', 'layer']);
  // A selector list is dead only when every branch requires an absent class.
  // Keep conditional pseudo classes, nesting and Sass evaluation for review.
  const candidates = db.rules.filter(r => !r.dynamic && r.ancestry.length === 0 &&
    r.context.every(c => safeContexts.has(c.name)) &&
    hasMissingRequiredClass(r.resolved, absent) &&
    !/[{}]/.test(r.source.slice(r.source.indexOf('{') + 1, -1)) &&
    !/\$|#\{|@/.test(r.source));
  return { version: 1, indexCreatedAt: db.createdAt, contentFiles: sources.map(({ file, hash }) => ({ file, hash })), classes,
    candidates: candidates.map(r => ({ id: r.id, file: r.file, selector: r.selector, line: r.start.line })),
    warning: 'Absence in source is not proof of non-use: dynamic classes, CMS, external templates and CSS Modules need review. Only explicitly approved rule IDs can be removed.' };
}
