import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { config } from './config.mjs';
import { walk, load, safePath } from './storage.mjs';
import { printStatistics } from './statistics.mjs';

const cli = fileURLToPath(new URL('../bin/cssexy.mjs', import.meta.url));
class Cancelled extends Error {}
class CommandFailed extends Error {}

export function parseSelection(answer, count, defaultAll = false) {
  const text = answer.trim().toLowerCase();
  if (text === 'all' || (!text && defaultAll)) return Array.from({ length: count }, (_,i) => i);
  if (!text || text === '0') return [];
  const chosen = new Set();
  for (const item of text.split(',')) {
    const match = item.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error('Use comma-separated numbers or a range: 1,3-5');
    const from = Number(match[1]), to = Number(match[2] ?? match[1]);
    if (from < 1 || to > count || from > to) throw new Error('Numbers must be between 1 and ' + count);
    for (let i = from; i <= to; i++) chosen.add(i - 1);
  }
  return [...chosen];
}

function runCLI(root, command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, command, '--root', root, ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new CommandFailed('Command ' + command + ' failed (' + (signal ?? code) + '). Fix the issue and try again.')));
  });
}

export async function terminalUI(initialRoot, { input = process.stdin, output = process.stdout, run = runCLI } = {}) {
  const rl = createInterface({ input, output, terminal: !!input.isTTY && !!output.isTTY });
  const answers = rl[Symbol.asyncIterator]();
  rl.on('SIGINT', () => rl.close());
  const say = message => output.write(message + '\n');
  async function ask(message, fallback = '') {
    output.write(message + (fallback ? ' [' + fallback + ']' : '') + ': ');
    const answer = await answers.next();
    if (answer.done) throw new Cancelled();
    return answer.value.trim() || fallback;
  }
  async function choose(message, choices, fallback) {
    say('\n' + message);
    choices.forEach(([key, label]) => say('  ' + key + '. ' + label));
    for (;;) {
      const result = await ask('Choice', fallback);
      if (choices.some(([key]) => key === result)) return result;
      say('Invalid choice. Enter one of the listed values.');
    }
  }
  async function yes(message, defaultYes = false) {
    return await choose(message, [['1', 'Yes'], ['0', 'No']], defaultYes ? '1' : '0') === '1';
  }
  async function select(message, items, defaultAll = false) {
    if (!items.length) { say('No items to select.'); return []; }
    say('\n' + message);
    items.forEach((item,i) => say('  ' + (i + 1) + '. ' + item));
    say('Numbers: 1,3-5 · all — select all · 0 — select none');
    for (;;) {
      try { return parseSelection(await ask('Select', defaultAll ? 'all' : '0'), items.length, defaultAll); }
      catch (e) { if (e instanceof Cancelled) throw e; say(e.message); }
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
    await run(root, 'scan', ['--all', '--types', extensions.join(','), ...selected.flatMap(i => ['--file', files[i]])]);
    return true;
  }
  async function planRemovals() {
    await run(root, 'usage');
    const report = await load(root, 'usage.json');
    say('\nMissing references are candidates, not proof of non-use. Add dynamic classes to the safelist.');
    const selected = await select('Rules to remove (none selected by default)', report.candidates.map(c => c.selector + ' — ' + c.file + ':' + c.line));
    const ids = selected.map(i => report.candidates[i].id);
    await run(root, 'plan', ids.flatMap(id => ['--approve-id', id]));
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
    say('\nCSSEXY — stylesheet toolkit\nChoose an option and press Enter. Ctrl+C to exit.');
    await selectRoot(initialRoot);
    for (;;) {
      say('\nProject: ' + root);
      const action = await choose('Main menu', [
        ['1','Full workflow: scan → analyze → select removals → plan'],
        ['2','Select and index files'], ['3','Analyze duplicates'],
        ['4','Find unused classes and select removals'], ['5','Plan optimization without unused-rule removal'],
        ['6','Review diff and apply plan'], ['7','Export readable / minified styles or a skeleton'],
        ['8','Find a class'], ['9','.cssexy settings'], ['10','Restore a backup'],
        ['11','Change project directory'], ['12','Initialize .cssexy and .gitignore'], ['0','Exit']
      ], '0');
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
  finally { rl.close(); }
}
