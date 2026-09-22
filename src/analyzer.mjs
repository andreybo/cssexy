import { parse } from './indexer.mjs';

const plain = rule => rule.type === 'rule' && rule.nodes?.length > 0 && rule.nodes.every(n => n.type === 'decl' && !/\$|#\{/.test(n.toString()));
const same = (a,b) => a.prop === b.prop && a.value === b.value && !!a.important === !!b.important;

export function optimize(source, file) {
  const ast = parse(source, file), changes = [];
  // Sass evaluation, mixins, extends and variables can have effects beyond a rule.
  if (file.endsWith('.scss') && /\$|#\{|@(include|extend|mixin|function|if|each|for|while|use|forward|import)\b/.test(source)) {
    return { output: source, changes, skipped: 'Sass evaluation requires manual review' };
  }
  const visit = container => {
    for (let i = 0; i < (container.nodes?.length ?? 0) - 1;) {
      const a = container.nodes[i], b = container.nodes[i + 1];
      if (plain(a) && plain(b) && a.selector === b.selector) {
        changes.push({ kind: 'merge-adjacent', selector: a.selector, lines: [a.source.start.line, b.source.start.line] });
        for (const decl of [...b.nodes]) a.append(decl);
        b.remove();
      } else i++;
    }
    for (const child of [...(container.nodes ?? [])]) if (child.nodes) visit(child);
    if (container.type === 'rule') {
      for (let i = 0; i < container.nodes.length - 1;) {
        const a = container.nodes[i], b = container.nodes[i + 1];
        if (a.type === 'decl' && b.type === 'decl' && same(a,b)) {
          changes.push({ kind: 'duplicate-declaration', property: a.prop, line: a.source.start.line });
          a.remove();
        } else i++;
      }
    }
  };
  visit(ast);
  return { output: ast.toString(), changes };
}

export function analyze(db) {
  const groups = new Map();
  for (const rule of db.rules) {
    const key = JSON.stringify([rule.file, rule.context, rule.resolved]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rule);
  }
  const duplicates = [];
  for (const rules of groups.values()) {
    if (rules.length < 2) continue;
    const properties = new Map();
    for (const rule of rules) for (const decl of rule.declarations) {
      const property = decl.property.startsWith('--') ? decl.property : decl.property.toLowerCase();
      if (!properties.has(property)) properties.set(property, []);
      properties.get(property).push({ ...decl, rule: rule.id });
    }
    duplicates.push({
      file: rules[0].file, selectors: rules[0].resolved, context: rules[0].context,
      rules: rules.map(r => r.id),
      properties: [...properties].map(([property, occurrences]) => {
        const winner = occurrences.reduce((a,b) => !a || b.important || !a.important ? b : a, null);
        return { property, status: occurrences.length === 1 ? 'unique' : new Set(occurrences.map(d => `${d.value}:${d.important}`)).size === 1 ? 'identical' : 'overridden',
          projectedWinner: winner, occurrences,
          note: 'Projection for this exact selector/context only; fallbacks, shorthands, other selectors and runtime conditions may affect computed styles.' };
      })
    });
  }
  return { version: 1, indexCreatedAt: db.createdAt, duplicates,
    hierarchy: Object.entries(db.classIndex).map(([className, ids]) => ({ className, rules: ids })),
    files: db.files.map(f => ({ path: f.path, ...optimize(f.source, f.path) })) };
}
