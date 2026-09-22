import fs from 'node:fs/promises';
import path from 'node:path';

export const defaults = {
  types: ['css', 'scss'],
  ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/vendor/**', '**/coverage/**'],
  content: ['**/*.{html,htm,js,jsx,ts,tsx,vue,svelte,php,twig,astro,mdx}'],
  safelist: [],
  format: { syntax: 'scss', style: 'pretty', nesting: 'preserve', properties: 'multiline', blankLines: true, indent: 2 }
};
export async function config(root) {
  let custom = {};
  try { custom = JSON.parse(await fs.readFile(path.join(root, '.cssexy'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error(`Invalid .cssexy: ${e.message}`); }
  const c = { ...defaults, ...custom, format: { ...defaults.format, ...custom.format } };
  for (const k of ['types', 'ignore', 'content', 'safelist']) if (!Array.isArray(c[k]) || c[k].some(x => typeof x !== 'string')) throw new Error(`${k} must be a string array`);
  if (c.types.some(x => !['css', 'scss'].includes(x))) throw new Error('Index types: css, scss');
  for (const [k, values] of Object.entries({ syntax: ['css','scss','sass'], style: ['pretty','mini'], nesting: ['preserve','flat','nested'], properties: ['multiline','inline'] })) {
    if (!values.includes(c.format[k])) throw new Error(`format.${k}: ${values.join(', ')}`);
  }
  if (!Number.isInteger(c.format.indent) || c.format.indent < 1 || c.format.indent > 8) throw new Error('indent must be 1..8');
  if (typeof c.format.blankLines !== 'boolean') throw new Error('blankLines must be boolean');
  return c;
}
