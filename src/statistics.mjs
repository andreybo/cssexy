export const bytes = text => Buffer.byteLength(text, 'utf8');

export function sizeStatistics(before, after) {
  const saved = before - after;
  return { 'Size before, bytes': before, 'Size after, bytes': after,
    'Size change': `${saved >= 0 ? '−' : '+'}${Math.abs(saved)} bytes (${before ? (Math.abs(saved) / before * 100).toFixed(1) : '0.0'}%)` };
}
export function planStatistics(plan) {
  const changes = plan.files.flatMap(f => f.changes);
  return {
    'Files to change': plan.files.length,
    'Rule merges': changes.filter(c => c.kind === 'merge-adjacent').length,
    'Duplicate declarations removed': changes.filter(c => c.kind === 'duplicate-declaration').length,
    'Unused rules removed': plan.files.reduce((n,f) => n + f.removals.length, 0),
    'Offset edits': plan.files.reduce((n,f) => n + f.edits.length, 0),
    ...(plan.files.every(f => Number.isFinite(f.beforeBytes) && Number.isFinite(f.afterBytes))
      ? sizeStatistics(plan.files.reduce((n,f) => n + f.beforeBytes, 0), plan.files.reduce((n,f) => n + f.afterBytes, 0)) : {})
  };
}
export function printStatistics(command, started, rows = {}, failed = false) {
  const entries = Object.entries({ 'Status': failed ? 'Failed' : 'Completed', ...rows,
    'Elapsed time': `${((performance.now() - started) / 1000).toFixed(3)} s` });
  const width = Math.max(...entries.map(([label]) => label.length));
  // Keep JSON (find) and patches (diff) on stdout usable in pipes.
  console.error(`\ncssexy statistics · ${command}`);
  for (const [label, value] of entries) console.error(`  ${label.padEnd(width)} : ${value}`);
}
