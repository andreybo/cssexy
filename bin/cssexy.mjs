#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { defaults, config } from '../src/config.mjs';
import { walk, save, load } from '../src/storage.mjs';
import { scan } from '../src/indexer.mjs';
import { analyze } from '../src/analyzer.mjs';
import { usage } from '../src/usage.mjs';
import { makePlan, applyPlan, restore, verifyIndex } from '../src/plans.mjs';
import { build } from '../src/formatter.mjs';
import { bytes, sizeStatistics, planStatistics, printStatistics } from '../src/statistics.mjs';
let task;

const help = `cssexy — CSS / SCSS optimization with reviewable changes

  cssexy ui                         Open the interactive terminal interface
  cssexy init                       Create .cssexy and add /cssexy/ to .gitignore
  cssexy scan                       Choose extensions and files interactively
  cssexy scan --all --types css,scss Index all matching files
  cssexy analyze                    Save duplicate/property/hierarchy report
  cssexy usage                      Search project for indexed class names
  cssexy plan                       Prepare safe edits and changes.diff
  cssexy plan --approve id1,id2      Also remove reviewed usage candidates
  cssexy diff                       Print proposed changes
  cssexy apply                      Apply plan with backups and hash checks
  cssexy restore <backup-id>         Restore if sources have not been edited
  cssexy build                      Generate formatted optimized copies
  cssexy build --skeleton            Generate SCSS structure without properties
  cssexy find <class-name>           Show source locations and declarations

Options: --version (-v), --help (-h), --root <directory>, --types css,scss, --all,
         --syntax css|scss|sass, --style pretty|mini,
         --nesting preserve|flat|nested, --properties multiline|inline,
         --file <relative-path> (repeatable), --approve-id <id> (repeatable),
         --indent 1..8, --blank-lines true|false
Artifacts: cssexy/index.json, analysis.json, usage.json, plan.json,
           changes.diff, output/, skeleton/, backups/.
Source files change only through apply or restore.
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    root: { type: 'string' }, types: { type: 'string' }, all: { type: 'boolean' },
    file: { type: 'string', multiple: true }, 'approve-id': { type: 'string', multiple: true },
    indent: { type: 'string' }, 'blank-lines': { type: 'string' },
    version: { type: 'boolean', short: 'v' }, help: { type: 'boolean', short: 'h' }, approve: { type: 'string' },
    syntax: { type: 'string' }, style: { type: 'string' }, nesting: { type: 'string' },
    properties: { type: 'string' }, skeleton: { type: 'boolean' }
  } });
  if (values.version) { console.log(JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version); return; }
  if (values.help) { console.log(help); return; }
  let command = positionals[0];
  if (command === 'ui' || (!command && stdin.isTTY)) {
    const { terminalUI } = await import('../src/terminal-ui.mjs');
    await terminalUI(values.root);
    return;
  }
  if (!command) { console.log(help); return; }
  task = { command, started: performance.now() };
  const root = await fs.realpath(path.resolve(values.root ?? '.'));
  if (command === 'init') {
    await fs.writeFile(path.join(root, '.cssexy'), JSON.stringify(defaults,null,2) + '\n', { flag: 'wx' });
    const ignorePath = path.join(root,'.gitignore');
    const ignore = await fs.readFile(ignorePath,'utf8').catch(e => { if(e.code === 'ENOENT') return ''; throw e; });
    if (!ignore.split(/\r?\n/).some(s => ['/cssexy/','cssexy/'].includes(s))) await fs.writeFile(ignorePath, ignore + (ignore.endsWith('\n') || !ignore ? '' : '\n') + '/cssexy/\n');
    console.log('Created .cssexy; cssexy/ excluded from Git'); return { 'Configuration files created': 1, 'Directories excluded from Git': 1 };
  }
  const cfg = await config(root);
  if (command === 'scan') {
    let types = (values.types ?? cfg.types.join(',')).split(',');
    let files;
    const rl = !values.all && stdin.isTTY ? createInterface({ input: stdin, output: stdout }) : null;
    try {
      if (rl && !values.types) types = (await rl.question(`Types [${types.join(',')}]: `) || types.join(',')).split(',').map(s => s.trim());
      if (!types.length || types.some(t => !['css','scss'].includes(t))) throw new Error('Supported index types: css,scss');
      files = (await walk(root,cfg.ignore)).filter(f => types.includes(path.extname(f).slice(1)));
      if (!files.length) throw new Error('No CSS/SCSS files found');
      if (values.file) {
        for (const file of values.file) if (!files.includes(file)) throw new Error(`File not found in scan: ${file}`);
        files = [...new Set(values.file)];
      }
      if (rl) {
        files.forEach((f,i) => console.log(`${i+1}. ${f}`));
        const answer = await rl.question('File numbers separated by commas, or all [all]: ');
        if (answer && answer !== 'all') {
          const indices = [...new Set(answer.split(',').map(s => Number(s.trim())-1))];
          if (indices.some(i => !Number.isInteger(i) || i < 0 || i >= files.length)) throw new Error('Invalid file selection');
          files = indices.map(i => files[i]);
        }
      } else if (!values.all) throw new Error('Non-interactive scan requires --all');
    } finally { rl?.close(); }
    const db = await scan(root,files);
    console.log(`Indexed ${db.files.length} files, ${db.rules.length} rules, ${Object.keys(db.classIndex).length} classes → cssexy/index.json`);
    return { 'Files indexed': db.files.length, 'Rules': db.rules.length, 'Unique classes': Object.keys(db.classIndex).length, 'Declarations': db.rules.reduce((n,r) => n + r.declarations.length, 0), 'Bytes read': db.files.reduce((n,f) => n + bytes(f.source), 0) };
  }
  if (command === 'diff') {
    const diff = await fs.readFile(path.join(root,'cssexy/changes.diff'),'utf8');
    console.log(diff);
    const lines = diff.split(/\r?\n/);
    return { 'Files in diff': lines.filter(l => l.startsWith('Index: ')).length,
      'Lines added': lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length,
      'Lines removed': lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length };
  }
  if (command === 'apply') { const p = await applyPlan(root); console.log(`Applied ${p.files.length} files. Backup: ${p.id}`); return { ...planStatistics(p), 'Files backed up': p.files.length }; }
  if (command === 'restore') { const count = await restore(root,positionals[1] ?? ''); console.log(`Restored ${count} files`); return { 'Files restored': count }; }
  const db = await load(root,'index.json');
  await verifyIndex(root,db);
  switch (command) {
    case 'analyze': {
      const report = analyze(db); await save(root,'analysis.json',report);
      console.log(`${report.duplicates.length} duplicate selector groups; ${report.files.reduce((n,f) => n+f.changes.length,0)} safe changes → cssexy/analysis.json`);
      const properties = report.duplicates.flatMap(g => g.properties);
      return { 'Files analyzed': report.files.length, 'Rules': db.rules.length,
        'Duplicate selector groups': report.duplicates.length,
        'Identical properties in groups': properties.filter(p => p.status === 'identical').length,
        'Overridden properties in groups': properties.filter(p => p.status === 'overridden').length,
        'Safe changes': report.files.reduce((n,f) => n + f.changes.length, 0),
        'Files skipped for optimization': report.files.filter(f => f.skipped).length };
    }
    case 'usage': {
      const report = await usage(root,db,cfg); await save(root,'usage.json',report);
      console.log(`${report.contentFiles.length} content files; ${report.candidates.length} removal candidates`);
      for (const c of report.candidates) console.log(`${c.id}  ${c.selector} (line ${c.line})`);
      console.log(report.warning);
      return { 'Content files checked': report.contentFiles.length, 'Classes checked': report.classes.length,
        'Referenced classes': report.classes.filter(c => c.status === 'referenced').length,
        'Safelisted classes': report.classes.filter(c => c.status === 'safelisted').length,
        'Unreferenced classes': report.classes.filter(c => c.status === 'candidate').length,
        'Rules eligible for removal review': report.candidates.length };
    }
    case 'plan': {
      const plan = await makePlan(root,db,[...(values.approve?.split(',') ?? []), ...(values['approve-id'] ?? [])]);
      console.log(`Planned ${plan.files.length} changed files. Review: cssexy diff; apply: cssexy apply`); return { 'Files checked': db.files.length, ...planStatistics(plan) };
    }
    case 'find': {
      const name = (positionals[1] ?? '').replace(/^\./,'');
      const ids = db.classIndex[name] ?? [];
      const rules = db.rules.filter(r => ids.includes(r.id));
      console.log(JSON.stringify(rules,null,2));
      return { 'Rules found': rules.length, 'Files with matches': new Set(rules.map(r => r.file)).size,
        'Declarations': rules.reduce((n,r) => n + r.declarations.length, 0) };
    }
    case 'build': {
      const options = { ...cfg.format };
      if (values.indent !== undefined) {
        options.indent = Number(values.indent);
        if (!Number.isInteger(options.indent) || options.indent < 1 || options.indent > 8) throw new Error('--indent must be 1..8');
      }
      if (values['blank-lines'] !== undefined) {
        if (!['true','false'].includes(values['blank-lines'])) throw new Error('--blank-lines must be true or false');
        options.blankLines = values['blank-lines'] === 'true';
      }
      for (const k of ['syntax','style','nesting','properties']) if (values[k]) options[k] = values[k];
      for (const [k, choices] of Object.entries({ syntax: ['css','scss','sass'], style: ['pretty','mini'], nesting: ['preserve','flat','nested'], properties: ['multiline','inline'] })) if (!choices.includes(options[k])) throw new Error(`Invalid --${k}`);
      const files = await build(root,db,options,values.skeleton);
      for (const f of files) console.log(f);
      const sizes = await Promise.all(files.map(f => fs.stat(path.join(root,f))));
      return { 'Source files processed': db.files.length, 'Files created': files.length,
        'Mode': values.skeleton ? 'Skeleton' : `${options.syntax} / ${options.style}`,
        ...sizeStatistics(db.files.reduce((n,f) => n + bytes(f.source), 0), sizes.reduce((n,s) => n + s.size, 0)) };
    }
    default: throw new Error(`Unknown command: ${command}\n${help}`);
  }
}
main().then(rows => { if (task) printStatistics(task.command, task.started, rows); }).catch(error => {
  console.error(`cssexy: ${error.message}`);
  printStatistics(task?.command ?? 'CLI', task?.started ?? performance.now(), { 'Errors': 1 }, true);
  process.exitCode = 1;
});
