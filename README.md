# bng-health/.github

Repositório público da org: página de perfil (`profile/`), arquivos padrão da comunidade e workflows reutilizáveis.

| Arquivo | O que é |
|---|---|
| `profile/README.md` | Página de perfil da org |
| `.github/pull_request_template.md` | Template de PR padrão (vale para repos **sem** template próprio) |
| `.github/workflows/initiative-trailer.yml` | Workflow reutilizável que confere o trailer `Initiative:` |

## Trailer `Initiative:`

Todo PR termina com uma linha que liga o PR a uma iniciativa do board #20:

```
Initiative: <slug>            # slug do ledger, kebab-case (ex.: processo-dev-v04)
Initiative: none (<motivo>)   # sem iniciativa; motivos usuais: drfc, infra, deps
Initiative-Ledger: <slug>     # PR que só mexe no ledger da iniciativa
Work-Type: <tipo> [<ref>]     # trabalho fora de iniciativa; tipo: fix|incidente|infra|dados|seguranca|deps|chore
```

`Work-Type:` é aceito onde `Initiative:` é aceito. O `<tipo>` não diferencia maiúsculas (`segurança` vale como `seguranca`) e pode vir seguido de uma referência opcional à issue: `#123`, `owner/repo#123` ou a URL da issue/PR (ex.: `Work-Type: fix #123`). Tipo fora da lista ou referência malformada é inválido. Só `Initiative:` dispara o anúncio de release; `Work-Type:` nunca.

> Quem chama o workflow com `@v1` continua com o comportamento antigo (sem `Work-Type:`) até a tag ser movida ou uma nova ser publicada.

Regras do check:

- A linha precisa estar **no fim** da descrição. Depois dela só podem vir linhas em branco, outros trailers (`Chave: valor`, ex.: `Co-Authored-By:`), URLs soltas ou o rodapé `🤖 Generated with Claude Code`.
- Linhas dentro de blocos de código (```` ``` ````/`~~~`) ou comentários HTML não contam.
- `none` sem motivo, valor vazio ou slug fora de kebab-case é inválido.
- Autores bot (login terminando em `[bot]`, ex.: `dependabot[bot]`, `renovate[bot]`) são isentos.
- O check lê a descrição atual pela API, então editar a descrição (ou dar "Re-run") corrige.

### Modos

| `mode` | Sem trailer / inválido |
|---|---|
| `warn` (padrão) | Job **verde**, com `::warning::` na aba Checks e resumo em pt-BR explicando a correção |
| `require` | Job **falha** (bloqueia o merge se o check for obrigatório na branch) |

O spec pede check "neutral" no `warn`. Um job de workflow não consegue terminar como neutral: o resultado é sempre success, failure, cancelled ou skipped. A alternativa seria criar um check run separado pela Checks API, o que exige `checks: write`. Por isso o `warn` usa success + warning + resumo, e o workflow pede só `pull-requests: read`.

### Como ativar num repo (caller)

Crie `.github/workflows/initiative.yml` no repo de produto (um PR por repo, com o OK do TL):

```yaml
name: initiative

on:
  pull_request:
    # edited: corrigir a descrição roda o check de novo
    types: [opened, edited, synchronize, reopened]

permissions:
  pull-requests: read

jobs:
  initiative:
    uses: bng-health/.github/.github/workflows/initiative-trailer.yml@main
    with:
      mode: warn   # trocar para require na data combinada
```

Repos com template de PR próprio (`.github/PULL_REQUEST_TEMPLATE.md`) não herdam o template da org: acrescente a linha `Initiative:` ao fim do template do repo no mesmo PR de ativação.

## Desenvolvimento

A lógica fica em `scripts/initiative-trailer/check.mjs` (Node, sem dependências) e é copiada para dentro do workflow, que assim não precisa de checkout.

```sh
node --test                                    # testes
node scripts/initiative-trailer/sync.mjs       # copia check.mjs para o workflow depois de editar
node scripts/initiative-trailer/sync.mjs --check
```
