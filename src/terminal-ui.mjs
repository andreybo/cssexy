import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTerminal, Cancelled } from './terminal-view.mjs';
import { spawn } from 'node:child_process';
import { config } from './config.mjs';
import { walk, load, save, safePath } from './storage.mjs';
import { printStatistics } from './statistics.mjs';

const cli = fileURLToPath(new URL('../bin/cssexy.mjs', import.meta.url));
class CommandFailed extends Error {}

function runCLI(root, command, args = [], signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, command, '--root', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => reject(error.name === 'AbortError' ? new Cancelled() : error));
    child.once('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const error = new CommandFailed('Command ' + command + ' failed (' + (signal ?? code) + ').');
        error.output = stderr || stdout;
        reject(error);
      }
    });
  });
}

export async function terminalUI(initialRoot, { input = process.stdin, output = process.stdout, run: execute = runCLI } = {}) {
  const view = createTerminal(input, output);
  const { ask, choose, select } = view;
  const say = message => view.say(message);
  async function yes(message, defaultYes = false) {
    return await choose(message, [['1', 'Yes'], ['0', 'No']], defaultYes ? '1' : '0') === '1';
  }
  async function run(root, command, args = []) {
    const controller = new AbortController();
    const spinner = view.spinner('Running ' + command + '…', () => controller.abort());
    try {
      const result = await execute(root, command, args, controller.signal);
      spinner.stop(command + ' complete');
      const stdout = result?.stdout ?? '', stderr = result?.stderr ?? '';
      const stats = stderr.indexOf('cssexy statistics');
      const summary = stats >= 0 ? stderr.slice(stats) : stderr || command + ' complete';
      view.report(summary);
      if (view.interactive) await view.showDocument(summary, 'Statistics · ' + command);
      if (stats > 0 && stderr.slice(0,stats).trim()) await view.showDocument(stderr.slice(0,stats).trim(), 'Warnings · ' + command);
      if (['diff','find'].includes(command)) await view.showDocument(stdout, command === 'diff' ? 'Review changes' : 'Class details');
      else if (!view.interactive && stdout) output.write(stdout);
    } catch (error) {
      spinner.error(command + ' stopped');
      if (error.output) view.report(error.output);
      throw error;
    }
  }
  let root;
  async function selectRoot(value) {
    for (;;) {
      const entered = value ?? await ask('Project directory', root ?? process.cwd());
      value = undefined;
      try {
        const target = await fs.realpath(path.resolve(entered.replace(/^"|"$/g, '')));
        if (!(await fs.stat(target)).isDirectory()) throw new Error('Not a directory');
        root = target;
        view.setProject(root);
        return;
      } catch (e) { say('Unable to open directory: ' + e.message); }
    }
  }
  async function scanFiles() {
    const cfg = await config(root);
    const types = await select('Stylesheet types', ['CSS', 'SCSS'], true);
    if (!types.length) { say('Scan cancelled.'); return false; }
    const extensions = types.map(i => ['css','scss'][i]);
    const files = (await walk(root, cfg.ignore)).filter(f => extensions.includes(path.extname(f).slice(1)));
    if (!files.length) { say('No stylesheets found for the selected types.'); return false; }
    const selected = await select('Files to index', files, true);
    if (!selected.length) { say('Scan cancelled.'); return false; }
    await run(root, 'scan', ['--all', '--types', extensions.join(','), ...(selected.length === files.length ? [] : selected.flatMap(i => ['--file', files[i]]))]);
    return true;
  }
  async function planRemovals() {
    await run(root, 'usage');
    const report = await load(root, 'usage.json');
    const candidates = report.candidates;
    const files = [...new Set(candidates.map(c => c.file))];
    say(`${candidates.length} rules without references across ${files.length} stylesheet files. Dynamic classes may need a safelist.`);
    let selected = [];
    if (candidates.length) {
      const mode = await choose('How should removal candidates be selected?', [
        ['0', 'Keep all candidates; optimize safe duplicates only'],
        ['all', `All ${candidates.length} candidates`],
        ['files', 'Select whole stylesheet files'],
        ['search', 'Search by selector or path'],
        ['manual', 'Choose individual rules']
      ], '0');
      if (mode === 'all') selected = candidates;
      if (mode === 'files') {
        const counts = new Map();
        for (const candidate of candidates) counts.set(candidate.file, (counts.get(candidate.file) ?? 0) + 1);
        const chosen = await select('Choose stylesheet files', files.map(file => `${file} · ${counts.get(file)} candidates`));
        const paths = new Set(chosen.map(i => files[i]));
        selected = candidates.filter(c => paths.has(c.file));
      }
      if (mode === 'search') {
        const query = (await ask('Selector or path contains')).toLowerCase();
        if (query) {
          const matches = candidates.filter(c => c.selector.toLowerCase().includes(query) || c.file.toLowerCase().includes(query));
          say(`${matches.length} matching candidates`);
          const action = matches.length ? await choose('Choose matching rules', [
            ['all', `All ${matches.length} matches`], ['manual', 'Pick matches individually'], ['0', 'Keep these rules']
          ], '0') : '0';
          if (action === 'all') selected = matches;
          if (action === 'manual') selected = (await select('Matching rules', matches.map(c => `${c.selector} — ${c.file}:${c.line}`))).map(i => matches[i]);
        }
      }
      if (mode === 'manual') selected = (await select('Rules to remove', candidates.map(c => `${c.selector} — ${c.file}:${c.line}`))).map(i => candidates[i]);
    }
    const affected = new Set(selected.map(c => c.file)).size;
    if (selected.length && !await yes(`Include deletion of ${selected.length} rules in ${affected} files in the plan?`)) selected = [];
    const args = [];
    if (selected.length) {
      await save(root, 'approval-selection.json', { indexCreatedAt: report.indexCreatedAt, ruleIds: selected.map(c => c.id) });
      args.push('--approve-selection');
    }
    await run(root, 'plan', args);
  }
  async function reviewApply() {
    const plan = await load(root, 'plan.json');
    if (plan.appliedAt) { say('This plan has already been applied. Scan again and create a new plan.'); return; }
    await run(root, 'diff');
    if (!plan.files.length) { say('No changes.'); return; }
    if (await yes('Apply the displayed plan to ' + plan.files.length + ' files? Backups will be created.')) {
      await run(root, 'apply');
      say('Sources updated. Scan again before running further operations.');
    } else say('Plan saved. Source files were not changed.');
  }
  async function formatOptions(current, skeleton = false) {
    const syntax = skeleton ? 'scss' : await choose('Output syntax', [['css','CSS'], ['scss','SCSS'], ['sass','Indented Sass']], current.syntax);
    const style = skeleton || syntax === 'sass' ? 'pretty' : await choose('Output style', [['pretty','Readable'], ['mini','Minified']], current.style);
    const choices = syntax === 'css' || style === 'mini' ? [['flat','Flat selectors']] : skeleton ? [['preserve','Preserve structure'], ['nested','Group parents and children']] : [['preserve','Preserve structure'], ['flat','Flat selectors'], ['nested','Group parents and children']];
    const nesting = await choose('Nesting', choices, choices.some(([k]) => k === current.nesting) ? current.nesting : choices[0][0]);
    const properties = style === 'mini' ? 'inline' : syntax === 'sass' ? 'multiline' : await choose('Declaration layout', [['multiline','One per line'], ['inline','Inline']], current.properties);
    const blankLines = style === 'mini' ? false : await yes('Add blank lines between blocks?', current.blankLines);
    const indent = Number(await choose('Indentation', Array.from({length: 8}, (_,i) => [String(i+1), (i+1) + ' spaces']), String(current.indent)));
    return { syntax, style, nesting, properties, blankLines, indent };
  }
  async function settings() {
    const cfg = await config(root);
    cfg.format = await formatOptions(cfg.format);
    for (const [key,label] of [['safelist','Safelisted classes (is-*, modal-open)'], ['content','Content file patterns'], ['ignore','Ignored paths']]) {
      say('\n' + label + ': ' + (cfg[key].join('; ') || '(empty)'));
      say('Enter — keep; - — clear; separate new values with ;');
      const answer = await ask(label);
      if (answer) cfg[key] = answer === '-' ? [] : answer.split(';').map(s => s.trim()).filter(Boolean);
    }
    const started = performance.now();
    await fs.writeFile(await safePath(root, '.cssexy'), JSON.stringify(cfg, null, 2) + '\n');
    printStatistics('settings', started, { 'Configuration files saved': 1 });
  }
  async function exportFiles() {
    const cfg = await config(root);
    const mode = await choose('What would you like to create?', [['1','Optimized stylesheets'], ['2','SCSS skeleton without declarations']], '1');
    const format = await formatOptions(cfg.format, mode === '2');
    await run(root, 'build', ['--syntax', format.syntax, '--style', format.style, '--nesting', format.nesting, '--properties', format.properties,
      '--indent', String(format.indent), '--blank-lines', String(format.blankLines), ...(mode === '2' ? ['--skeleton'] : [])]);
  }
  async function restoreBackup() {
    const dir = await safePath(root, 'cssexy/backups');
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    const backups = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      const manifest = await load(root, 'backups/' + entry.name + '/manifest.json');
      backups.push({ id: entry.name, manifest });
    }
    backups.sort((a,b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
    if (!backups.length) { say('No backups yet.'); return; }
    const choice = await choose('Backups', [...backups.map((b,i) => [String(i+1), b.manifest.createdAt + ' · ' + b.manifest.files.length + ' files · ' + b.id]), ['0','Back']], '0');
    if (choice === '0') return;
    const backup = backups[Number(choice)-1];
    backup.manifest.files.forEach(f => say('  ' + f.path));
    if (await yes('Restore the listed files?')) await run(root, 'restore', [backup.id]);
  }
  try {
    await selectRoot(initialRoot ?? process.cwd());
    for (;;) {
      view.screen();
      const action = await choose('Main menu', [
        ['1','Full workflow: scan → analyze → select removals → plan'],
        ['2','Select and index files'], ['3','Analyze duplicates'],
        ['4','Find unused classes and select removals'], ['5','Plan optimization without unused-rule removal'],
        ['6','Review diff and apply plan'], ['7','Export readable / minified styles or a skeleton'],
        ['8','Find a class'], ['9','.cssexy settings'], ['10','Restore a backup'],
        ['11','Change project directory'], ['12','Initialize .cssexy and .gitignore'], ['0','Exit']
      ], '1');
      if (action === '0') break;
      const started = performance.now();
      try {
        switch (action) {
          case '1': if (await scanFiles()) { await run(root,'analyze'); await planRemovals(); await reviewApply(); } break;
          case '2': await scanFiles(); break;
          case '3': await run(root,'analyze'); break;
          case '4': await planRemovals(); break;
          case '5': await run(root,'plan'); break;
          case '6': await reviewApply(); break;
          case '7': await exportFiles(); break;
          case '8': { const name = await ask('Class name (without the dot)'); if (name) await run(root,'find',[name]); break; }
          case '9': await settings(); break;
          case '10': await restoreBackup(); break;
          case '11': await selectRoot(); break;
          case '12': await run(root,'init'); break;
        }
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        say('\n' + e.message);
        if (!(e instanceof CommandFailed)) printStatistics('interactive operation', started, { 'Errors': 1 }, true);
      }
    }
    say('Goodbye!');
  } catch (e) { if (!(e instanceof Cancelled)) throw e; say('\nExit.'); }
  finally { view.close(); }
}
