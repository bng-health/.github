// Copies check.mjs into the heredoc of .github/workflows/initiative-trailer.yml.
// Usage: node scripts/initiative-trailer/sync.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MARK = 'INITIATIVE_TRAILER_MJS';
export const SCRIPT_PATH = fileURLToPath(new URL('./check.mjs', import.meta.url));
export const WORKFLOW_PATH = fileURLToPath(new URL('../../.github/workflows/initiative-trailer.yml', import.meta.url));

function locate(lines) {
  const start = lines.findIndex((l) => l.includes(`<<'${MARK}'`));
  const end = lines.findIndex((l, i) => i > start && l.trim() === MARK);
  if (start < 0 || end < 0) throw new Error(`heredoc ${MARK} não encontrado no workflow`);
  return { start, end, indent: lines[start].match(/^ */)[0] };
}

export function extract(workflow) {
  const lines = workflow.split('\n');
  const { start, end, indent } = locate(lines);
  return lines.slice(start + 1, end).map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trim())).join('\n') + '\n';
}

export function inline(workflow, script) {
  const lines = workflow.split('\n');
  const { start, end, indent } = locate(lines);
  const body = script.replace(/\n$/, '').split('\n').map((l) => (l ? indent + l : ''));
  return [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const wf = readFileSync(WORKFLOW_PATH, 'utf8');
  const next = inline(wf, readFileSync(SCRIPT_PATH, 'utf8'));
  if (process.argv.includes('--check')) {
    if (next !== wf) {
      console.error('workflow fora de sincronia com check.mjs: rode node scripts/initiative-trailer/sync.mjs');
      process.exit(1);
    }
  } else {
    writeFileSync(WORKFLOW_PATH, next);
    console.log('workflow sincronizado');
  }
}
