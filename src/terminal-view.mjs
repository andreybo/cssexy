import { createInterface } from 'node:readline';
import * as prompts from '@clack/prompts';

export class Cancelled extends Error {}

export function createTerminal(input, output) {
  const interactive = !!input.isTTY && !!output.isTTY;
  const context = { input, output };
  const rl = interactive ? null : createInterface({ input, output });
  const answers = rl?.[Symbol.asyncIterator]();
  rl?.on('SIGINT', () => rl.close());
  let project = process.cwd(), summary = '', notice = '';
  const color = (n, text) => interactive ? '\x1b[' + n + 'm' + text + '\x1b[0m' : text;
  const clean = text => String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'');
  const line = text => output.write(text + '\n');
  const width = () => Math.max(24, (output.columns || 90) - 8);
  const clip = text => text.length > width() ? '…' + text.slice(-width() + 1) : text;
  const maxItems = () => Math.max(3, Math.min(10, (output.rows || 32) - 18));
  if (interactive) output.write('\x1b[?1049h');
  function screen() {
    if (!interactive) return;
    output.write('\x1b[2J\x1b[H');
    line('');
    line('  ' + color('1;36', 'cssexy') + color('2', '  /  stylesheet workspace'));
    line('  ' + color('2', clip(clean(project))));
    line('  ' + color('2', '─'.repeat(Math.min(72, width()))));
    if (summary) {
      const lines = summary.split('\n').filter(Boolean);
      line('  ' + color('32', clip(lines[0])));
      for (const text of lines.slice(-3)) line('  ' + color('2', clip(text.trim())));
    }
    if (notice) line('  ' + color('33', clip(clean(notice))));
    line('');
  }
  function result(value) { if (prompts.isCancel(value)) throw new Cancelled(); return value; }
  async function ask(message, fallback = '') {
    if (interactive) {
      screen();
      return result(await prompts.text({ ...context, message, placeholder: fallback, defaultValue: fallback })) || fallback;
    }
    output.write(message + (fallback ? ' [' + fallback + ']' : '') + ': ');
    const next = await answers.next();
    if (next.done) throw new Cancelled();
    return next.value.trim() || fallback;
  }
  async function choose(message, choices, fallback) {
    if (interactive) {
      screen();
      return result(await prompts.select({ ...context, message, options: choices.map(([value,label]) => ({value,label})), initialValue: fallback, maxItems: maxItems() }));
    }
    line(message);
    choices.forEach(([key,label]) => line('  ' + key + '. ' + label));
    for (;;) {
      const value = await ask('Choice', fallback);
      if (choices.some(([key]) => key === value)) return value;
      line('Choose a listed value.');
    }
  }
  async function select(message, items, defaultAll = false) {
    if (!items.length) return [];
    if (interactive) {
      screen();
      return result(await prompts.multiselect({ ...context, message,
        options: items.map((label,value) => ({value,label})), initialValues: defaultAll ? items.map((_,i) => i) : [],
        required: false, maxItems: maxItems() }));
    }
    line(message);
    items.forEach((label,i) => line('  ' + (i+1) + '. ' + label));
    for (;;) {
      const value = await ask('Numbers / all / 0',defaultAll ? 'all' : '0');
      if (value === 'all') return items.map((_,i) => i);
      if (!value || value === '0') return [];
      const selected = new Set();
      let valid = true;
      for (const part of value.split(',')) {
        const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
        const start = Number(match?.[1]), end = Number(match?.[2] ?? match?.[1]);
        if (!match || start < 1 || end > items.length || start > end) { valid = false; break; }
        for (let i=start; i<=end; i++) selected.add(i-1);
      }
      if (valid) return [...selected];
      line('Choose valid numbers, for example 1,3-5.');
    }
  }
  async function showDocument(text, title) {
    if (!interactive) { line(text); return; }
    const lines = clean(text).split(/\r?\n/);
    let page = 0;
    for (;;) {
      screen();
      const pageSize = Math.max(3, (output.rows || 32) - 17);
      const pages = Math.max(1, Math.ceil(lines.length / pageSize));
      page = Math.min(page,pages-1);
      line('  ' + color('1',title) + color('2',' · ' + (page+1) + '/' + pages));
      for (const text of lines.slice(page*pageSize, (page+1)*pageSize)) {
        const style = text.startsWith('+') ? '32' : text.startsWith('-') ? '31' : '2';
        line('  ' + color(style,clip(text)));
      }
      const options = [{value:'done',label:'Continue'}];
      if (page < pages-1) options.unshift({value:'next',label:'Next page'});
      if (page > 0) options.push({value:'prev',label:'Previous page'});
      const selected = result(await prompts.select({...context,message:title,options}));
      if (selected === 'done') return;
      page += selected === 'next' ? 1 : -1;
    }
  }
  return {
    interactive, ask, choose, select, showDocument, screen,
    setProject(value) { project = value; },
    say(message) { notice = clean(message).trim(); if (interactive) prompts.log.info(notice,context); else line(notice); },
    report(text) { summary = clean(text).trim(); if (interactive) { screen(); prompts.note(summary,'Task statistics',context); } else line(summary); },
    spinner(message, onCancel) {
      if (!interactive) return {stop() {}, error() {}};
      screen();
      const spinner = prompts.spinner({...context,onCancel});
      spinner.start(message);
      return spinner;
    },
    close() {
      rl?.close();
      if (interactive) {
        output.write('\x1b[?25h\x1b[?1049l');
        line(color('36','cssexy') + ' · session closed');
        if (summary) line(summary);
      }
    }
  };
}
