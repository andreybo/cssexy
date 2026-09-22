import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as sass from 'sass';
import prettier from 'prettier';
import postcss from 'postcss';
import { parse } from './indexer.mjs';
import { safePath } from './storage.mjs';
import { verifyIndex } from './plans.mjs';
import { optimize } from './analyzer.mjs';

function nest(ast) {
  ast.walkRules(rule => {
    if (rule.parent.type === 'rule' || !/^\.[\w-]+(?:\s+\.[\w-]+)+$/.test(rule.selector)) return;
    const parts = rule.selector.trim().split(/\s+/);
    const outer = postcss.rule({ selector: parts.shift() });
    let parent = outer;
    while (parts.length > 1) { const child = postcss.rule({ selector: parts.shift() }); parent.append(child); parent = child; }
    rule.replaceWith(outer);
    rule.selector = parts[0];
    parent.append(rule);
  });
  function group(container) {
    for (let i = 0; i < (container.nodes?.length ?? 0) - 1;) {
      const a = container.nodes[i], b = container.nodes[i+1];
      if (a.type === 'rule' && b.type === 'rule' && a.selector === b.selector && a.nodes.every(n => n.type === 'rule') && b.nodes.every(n => n.type === 'rule')) {
        a.append([...b.nodes]); b.remove();
      } else i++;
    }
    for (const child of container.nodes ?? []) if (child.nodes) group(child);
  }
  group(ast);
  return ast;
}
function indented(ast, indent) {
  const lines = [];
  function visit(node, level) {
    const pad = ' '.repeat(level * indent);
    if (node.type === 'root') { for (const child of node.nodes) visit(child, level); return; }
    if (node.type === 'comment') { for (const line of node.text.split('\n')) lines.push(pad + '// ' + line); return; }
    if (node.type === 'decl') { lines.push(`${pad}${node.prop}: ${node.value}${node.important ? ' !important' : ''}`); return; }
    lines.push(pad + (node.type === 'rule' ? node.selector : `@${node.name}${node.params ? ' ' + node.params : ''}`));
    for (const child of node.nodes ?? []) visit(child, level + 1);
  }
  visit(ast, 0);
  return lines.join('\n') + '\n';
}
export async function formatSource(source, file, options, root) {
  const { syntax, style, nesting, properties, blankLines, indent } = options;
  if (syntax === 'sass' && (style === 'mini' || properties === 'inline')) throw new Error('Indented Sass requires pretty style and multiline properties');
  if (syntax === 'css' && nesting === 'nested') throw new Error('nested output is supported for scss/sass; use flat for CSS');
  const compile = syntax === 'css' || syntax === 'sass' || nesting !== 'preserve' || style === 'mini';
  let code = source;
  if (compile) {
    code = sass.compileString(source, { syntax: file.endsWith('.css') ? 'css' : 'scss', url: pathToFileURL(path.join(root,file)), style: 'expanded' }).css;
  }
  if (style === 'mini') return sass.compileString(code, { syntax: 'css', style: 'compressed' }).css;
  let ast = parse(code, compile ? 'output.css' : file);
  if (nesting === 'nested') ast = nest(ast);
  if (syntax === 'sass') {
    const output = indented(ast, indent);
    // Validate conversion and preserve CSS meaning, including tricky custom values.
    const roundtrip = sass.compileString(output, { syntax: 'indented', style: 'compressed' }).css;
    const original = sass.compileString(ast.toString(), { style: 'compressed' }).css;
    if (roundtrip !== original) throw new Error('Sass conversion changed CSS; use scss output');
    return output;
  }
  let formatted = await prettier.format(ast.toString(), { parser: syntax, tabWidth: indent, printWidth: 100 });
  if (properties === 'inline') {
    ast = parse(formatted, 'output.scss');
    ast.walkRules(rule => {
      if (rule.nodes.length && rule.nodes.every(n => n.type === 'decl')) {
        for (const decl of rule.nodes) decl.raws.before = ' ';
        rule.raws.after = ' ';
        rule.raws.semicolon = true;
      }
    });
    formatted = ast.toString();
  }
  if (blankLines) {
    ast = parse(formatted, 'output.scss');
    ast.walk(node => {
      if ((node.type === 'rule' || node.type === 'atrule') && node.prev()) node.raws.before = (node.raws.before ?? '\n').replace(/^\s*\n/, '\n\n');
    });
    formatted = ast.toString();
  }
  return formatted;
}
export async function build(root, db, options, skeleton = false) {
  await verifyIndex(root, db);
  const prepared = [];
  for (const file of db.files) {
    let source = optimize(file.source, file.path).output;
    if (skeleton) {
      const ast = parse(source, file.path);
      ast.walkDecls(n => n.remove());
      ast.walkAtRules(n => { if (!n.nodes) n.remove(); });
      source = ast.toString();
      if (options.syntax !== 'scss' || options.style === 'mini' || options.nesting === 'flat') throw new Error('Skeleton requires scss, pretty and preserve/nested');
      if (options.nesting === 'nested') source = nest(ast).toString();
    }
    const output = await formatSource(source, file.path, skeleton ? { ...options, nesting: 'preserve' } : options, root);
    // Include original extension to avoid collisions between main.css/main.scss.
    const name = `cssexy/${skeleton ? 'skeleton' : 'output'}/${file.path}.${options.syntax}`;
    prepared.push({ name, output });
  }
  for (const { name, output } of prepared) {
    const target = await safePath(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, output);
  }
  return prepared.map(f => f.name);
}
