import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluate, findTrailer, main, loadPr } from './check.mjs';
import { extract, inline, SCRIPT_PATH, WORKFLOW_PATH } from './sync.mjs';

const ev = (body, extra = {}) => evaluate({ body, author: 'kiquecarlos', mode: 'warn', ...extra });
const CLAUDE_FOOTER = '🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nhttps://claude.ai/code/session_x';

test('slug válido passa', () => {
  const r = ev('## Resumo\nAjusta o digest.\n\nInitiative: processo-dev-v04');
  assert.equal(r.status, 'ok');
  assert.equal(r.trailer.slug, 'processo-dev-v04');
  assert.equal(r.exitCode, 0);
});

test('slug fora de kebab-case é inválido', () => {
  for (const v of ['Processo-Dev', 'processo dev', 'processo_dev', '-x', 'x-', 'a--b', '<slug>']) {
    assert.equal(ev(`texto\n\nInitiative: ${v}`).status, 'invalid', v);
  }
});

test('none (motivo) passa', () => {
  const r = ev('Bump.\n\nInitiative: none (deps)');
  assert.equal(r.status, 'ok');
  assert.equal(r.trailer.kind, 'none');
  assert.equal(r.trailer.motivo, 'deps');
  assert.equal(ev('x\n\nInitiative: None ( hotfix de infra )').trailer.motivo, 'hotfix de infra');
});

test('none sem motivo é inválido', () => {
  for (const v of ['none', 'none ()', 'none (  )', 'none deps', 'none(deps', 'none (a) extra']) {
    const r = ev(`x\n\nInitiative: ${v}`);
    assert.equal(r.status, 'invalid', v);
  }
});

test('Initiative vazio é inválido (linha do template sem preencher)', () => {
  assert.equal(ev('x\n\nInitiative:').status, 'invalid');
  assert.equal(ev('x\n\nInitiative:   ').status, 'invalid');
});

test('Initiative-Ledger: <slug> passa; none não vale para ledger', () => {
  const r = ev('Atualiza o ledger.\n\nInitiative-Ledger: processo-dev-v04');
  assert.equal(r.status, 'ok');
  assert.equal(r.trailer.kind, 'ledger');
  assert.equal(ev('x\n\nInitiative-Ledger: none (x)').status, 'invalid');
});

test('chave case-insensitive', () => {
  assert.equal(ev('x\n\ninitiative: abc').status, 'ok');
});

test('trailer fora do fim não conta', () => {
  const r = ev('Initiative: processo-dev-v04\n\n## Resumo\nMuda o digest.');
  assert.equal(r.status, 'missing');
});

test('trailer dentro de bloco de código não conta', () => {
  assert.equal(ev('Exemplo:\n\n```\nInitiative: processo-dev-v04\n```').status, 'missing');
  assert.equal(ev('Exemplo:\n\n~~~md\nInitiative: processo-dev-v04\n~~~\n').status, 'missing');
  assert.equal(ev('Exemplo:\n\n```\nInitiative: processo-dev-v04').status, 'missing', 'fence sem fechar');
  assert.equal(ev('Initiative: abc\n\n```\ncodigo\n```').status, 'missing', 'código depois do trailer');
});

test('trailer dentro de comentário HTML não conta; comentário depois é ignorado', () => {
  assert.equal(ev('x\n<!--\nInitiative: abc\n-->').status, 'missing');
  assert.equal(ev('x\n\nInitiative: abc\n<!-- nota -->\n').status, 'ok');
});

test('rodapé do Claude Code e outros trailers depois do Initiative são aceitos', () => {
  const r = ev(`Resumo\n\nInitiative: processo-dev-v04\n\n${CLAUDE_FOOTER}`);
  assert.equal(r.status, 'ok');
  assert.equal(ev('x\n\nInitiative: abc\nCo-Authored-By: Fulano <f@x.com>\n').status, 'ok');
});

test('último trailer vence', () => {
  assert.equal(findTrailer('x\n\nInitiative: aaa\nInitiative: bbb').value, 'bbb');
});

test('CRLF', () => {
  assert.equal(ev('Resumo\r\n\r\nInitiative: processo-dev-v04\r\n').status, 'ok');
  assert.equal(ev('Resumo\r\n\r\nInitiative: none (infra)\r\n\r\n').trailer.motivo, 'infra');
  assert.equal(ev('```\r\nInitiative: abc\r\n```\r\n').status, 'missing');
});

test('corpo vazio ou nulo', () => {
  for (const b of ['', null, undefined, '\n\n  \n']) assert.equal(ev(b).status, 'missing');
});

test('bots isentos', () => {
  for (const author of ['dependabot[bot]', 'renovate[bot]', 'bng-flow-bot[bot]', 'github-actions[bot]']) {
    const r = ev('', { author, mode: 'require' });
    assert.equal(r.status, 'bot', author);
    assert.equal(r.exitCode, 0);
  }
  assert.equal(ev('', { author: 'qualquer', authorType: 'Bot', mode: 'require' }).status, 'bot');
  assert.equal(ev('', { author: 'robotnik', mode: 'require' }).exitCode, 1, 'humano com "bot" no nome não é isento');
});

test('warn: sem trailer sai 0 com warning; require: sai 1 com error', () => {
  const w = ev('sem trailer', { mode: 'warn' });
  assert.deepEqual([w.exitCode, w.level], [0, 'warning']);
  const r = ev('sem trailer', { mode: 'require' });
  assert.deepEqual([r.exitCode, r.level], [1, 'error']);
  const ri = ev('x\n\nInitiative: none', { mode: 'require' });
  assert.deepEqual([ri.exitCode, ri.status], [1, 'invalid']);
  assert.equal(ev('x\n\nInitiative: abc', { mode: 'require' }).exitCode, 0);
});

test('mode inválido falha', () => {
  assert.equal(ev('x\n\nInitiative: abc', { mode: 'block' }).exitCode, 1);
});

test('main: annotation, resumo pt-BR e exit codes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'itr-'));
  const summaryFile = join(dir, 'summary.md');
  const lines = [];
  const env = { MODE: 'warn', PR_NUMBER: '7', PR_BODY: 'sem trailer', PR_AUTHOR: 'dev' };
  assert.equal(await main(env, { out: (s) => lines.push(s), summaryFile }), 0);
  assert.match(lines.at(-1), /^::warning title=Initiative%3A aviso/);
  const md = readFileSync(summaryFile, 'utf8');
  assert.match(md, /Como corrigir/);
  assert.match(md, /Initiative: none \(<motivo>\)/);
  assert.equal(await main({ ...env, MODE: 'require' }, { out: () => {}, summaryFile }), 1);
  assert.equal(await main({ MODE: 'require' }, { out: () => {} }), 0, 'sem PR: nada a checar');
});

test('loadPr: usa o corpo atual da API e cai para o evento se a API falhar', async () => {
  const env = { GITHUB_TOKEN: 't', REPO: 'o/r', PR_NUMBER: '1', PR_BODY: 'velho', PR_AUTHOR: 'dev' };
  const okFetch = async (url) => {
    assert.equal(url, 'https://api.github.com/repos/o/r/pulls/1');
    return { ok: true, json: async () => ({ body: 'x\n\nInitiative: abc', user: { login: 'dev', type: 'User' } }) };
  };
  assert.equal((await loadPr(env, okFetch)).body, 'x\n\nInitiative: abc');
  const bad = await loadPr(env, async () => ({ ok: false, status: 403 }));
  assert.deepEqual([bad.body, bad.fetchError], ['velho', 'HTTP 403']);
  const nullBody = await loadPr(env, async () => ({ ok: true, json: async () => ({ body: null, user: { login: 'dev' } }) }));
  assert.equal(nullBody.body, '');
});

test('CLI real: exit codes do processo', () => {
  const run = (env) => spawnSync(process.execPath, [SCRIPT_PATH], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  const base = { PR_NUMBER: '3', PR_AUTHOR: 'dev', PR_BODY: 'nada' };
  assert.equal(run({ ...base, MODE: 'warn' }).status, 0);
  const req = run({ ...base, MODE: 'require' });
  assert.equal(req.status, 1);
  assert.match(req.stdout, /^::error /m);
  assert.equal(run({ ...base, MODE: 'require', PR_BODY: 'x\n\nInitiative: none (drfc)' }).status, 0);
});

test('Work-Type: cada valor passa, sem ref', () => {
  for (const t of ['fix', 'incidente', 'infra', 'dados', 'seguranca', 'deps', 'chore']) {
    const r = ev(`Resumo\n\nWork-Type: ${t}`);
    assert.equal(r.status, 'ok', t);
    assert.deepEqual([r.trailer.kind, r.trailer.tipo, r.trailer.ref], ['work-type', t, null]);
    assert.equal(r.message, `trailer ok: work-type ${t}`);
  }
});

test('Work-Type: case-insensitive e segurança vira seguranca', () => {
  assert.equal(ev('x\n\nwork-type: FIX').trailer.tipo, 'fix');
  assert.equal(ev('x\n\nWORK-TYPE: Chore').status, 'ok');
  const r = ev('x\n\nWork-Type: Segurança');
  assert.equal(r.status, 'ok');
  assert.equal(r.trailer.tipo, 'seguranca');
});

test('Work-Type: formas de ref (#n, owner/repo#n, URL de issue/PR)', () => {
  const refs = ['#123', 'bng-health/linkcare#2072', 'https://github.com/bng-health/linkcare/issues/9', 'https://github.com/bng-health/linkcare/pull/10'];
  for (const ref of refs) {
    const r = ev(`x\n\nWork-Type: fix ${ref}`);
    assert.equal(r.status, 'ok', ref);
    assert.equal(r.trailer.ref, ref);
  }
  assert.equal(ev('x\n\nWork-Type: fix #123').message, 'trailer ok: work-type fix (#123)');
});

test('Work-Type: ref malformada é inválida', () => {
  for (const ref of ['123', '#', '#abc', 'owner/repo', 'https://example.com/a/b/issues/1', '#1 #2', 'foo bar']) {
    assert.equal(ev(`x\n\nWork-Type: fix ${ref}`).status, 'invalid', ref);
  }
});

test('Work-Type: valor inválido lista os valores aceitos; vazio é inválido', () => {
  const r = ev('x\n\nWork-Type: feature');
  assert.equal(r.status, 'invalid');
  assert.match(r.message, /fix\|incidente\|infra\|dados\|seguranca\|deps\|chore|fix, incidente, infra, dados, seguranca, deps, chore/);
  assert.equal(ev('x\n\nWork-Type:').status, 'invalid');
  assert.equal(ev('x\n\nWork-Type:   ').status, 'invalid');
  assert.match(ev('x\n\nWork-Type:').message, /Work-Type/);
});

test('Work-Type seguido de rodapé do Claude Code e outros trailers passa', () => {
  assert.equal(ev(`Resumo\n\nWork-Type: fix #5\n\n${CLAUDE_FOOTER}`).status, 'ok');
  assert.equal(ev('x\n\nWork-Type: deps\nCo-Authored-By: Fulano <f@x.com>\n').status, 'ok');
});

test('Work-Type dentro de bloco de código é ignorado; fora do fim não conta', () => {
  assert.equal(ev('Exemplo:\n\n```\nWork-Type: fix\n```').status, 'missing');
  assert.equal(ev('Work-Type: fix\n\n## Resumo\nMuda o digest.').status, 'missing');
});

test('Work-Type: require sai 0 quando válido, 1 quando inválido', () => {
  assert.equal(ev('x\n\nWork-Type: infra', { mode: 'require' }).exitCode, 0);
  assert.equal(ev('x\n\nWork-Type: nada', { mode: 'require' }).exitCode, 1);
});

test('mensagens de correção citam Work-Type', () => {
  assert.match(ev('sem trailer').howToFix, /Work-Type: <tipo>/);
});

test('workflow contém a cópia atual do check.mjs', () => {
  const wf = readFileSync(WORKFLOW_PATH, 'utf8');
  const script = readFileSync(SCRIPT_PATH, 'utf8');
  assert.equal(extract(wf), script, 'rode: node scripts/initiative-trailer/sync.mjs');
  assert.equal(inline(wf, script), wf);
  assert.match(wf, /on:\n  workflow_call:/);
  assert.match(wf, /default: warn/);
});

test('template de PR: sem preencher avisa; preenchido passa', () => {
  const tpl = readFileSync(new URL('../../.github/pull_request_template.md', import.meta.url), 'utf8');
  assert.equal(ev(tpl).status, 'invalid');
  assert.equal(ev(tpl.replace(/Initiative: *\n?$/, 'Initiative: processo-dev-v04\n')).status, 'ok');
  assert.equal(ev(tpl.replace(/Initiative: *\n?$/, 'Initiative: none (infra)')).status, 'ok');
});
