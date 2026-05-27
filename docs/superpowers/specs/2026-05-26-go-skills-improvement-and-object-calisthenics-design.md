# Design: Melhoria das Skills Go + Skill de Object Calisthenics

Data: 2026-05-26
Repo: `github.com/Ramiro-Ribeiro/skills` (curado de `samber/cc-skills-golang`)

## Objetivo

Duas frentes de trabalho:

1. **Melhorar as 18 skills Go existentes** alinhando-as às referências consolidadas
   da comunidade Go e modernizando para Go 1.22+ — via pass cirúrgico orientado a
   evidência (sem rewrite cego).
2. **Adicionar uma 19ª skill** `golang-object-calisthenics` com as 9 regras de
   object calisthenics adaptadas pragmaticamente ao Go idiomático.

## Decisões tomadas (brainstorming)

- **Escopo da melhoria:** alinhar com style guides da comunidade **e** modernizar
  para Go atual (pass completo, mas cirúrgico).
- **Object calisthenics:** nova skill standalone + cross-references reversas nas
  skills relacionadas. Adaptação **pragmática idiomática** (não fiel ao original).
- **Execução da melhoria:** sub-agents em paralelo, em lotes de 3-4 skills cada;
  o autor principal define baseline/régua e **revisa cada diff** antes de aceitar.
- **Atribuição:** manter `metadata.author: samber` nas skills existentes, bump de
  versão (patch/minor), manter banner "Community default" e prefixo de cross-ref
  `samber/cc-skills-golang@`. Skill nova: `author: Ramiro-Ribeiro`, versão `1.0.0`.

## Régua de melhoria (critério de edição)

Para cada skill, diferenciar contra as fontes canônicas abaixo e editar **somente**
onde houver:

- (a) **lacuna real** — tópico de consenso ausente;
- (b) **divergência** do consenso atual da comunidade;
- (c) **conselho desatualizado** — contradito por Go 1.22+.

Não reescrever conteúdo que já está correto e bem formulado. Preservar o estilo,
o tom e a estrutura (frontmatter, banner, `references/`, `evals/`) existentes.

### Baseline de referências da comunidade

- **Effective Go** + **Go Code Review Comments** (golang/go wiki) — base oficial
- **Google Go Style Guide** (google.github.io/styleguide/go) — guide/decisions/best-practices
- **Uber Go Style Guide** — referência comunitária mais citada
- **Go Proverbs** (Rob Pike) + artigos do **Dave Cheney**
- **Modernização Go 1.22+:**
  - `range`-over-int (1.22), range-over-func iterators (1.23)
  - loopvar semantics (1.22 — fim do padrão `x := x` em loops)
  - generics maduros; pacotes `slices`, `maps`, `cmp`; builtins `min`/`max`/`clear`
  - `log/slog` para logging estruturado
  - `errors.Join`
  - `testing.B.Loop` (1.24) em benchmarks

## Frente 1 — Pass nas 18 skills

Skills (lotes sugeridos):

- Lote A (foundations): `golang-code-style`, `golang-naming`, `golang-structs-interfaces`, `golang-safety`
- Lote B (errors/control): `golang-error-handling`, `golang-context`, `golang-troubleshooting`, `golang-documentation`
- Lote C (concurrency/perf/arch): `golang-concurrency`, `golang-performance`, `golang-design-patterns`, `golang-dependency-injection`
- Lote D (layout/quality/prod): `golang-project-layout`, `golang-large-scale`, `golang-testing`, `golang-lint`
- Lote E (prod): `golang-observability`, `golang-security`, `golang-database`

Cada sub-agent recebe: a régua, o baseline de referências, e instruções de só
editar `SKILL.md` e `references/*.md` cirurgicamente, bump de versão no frontmatter,
e reportar um resumo das mudanças por skill (lacuna/divergência/desatualização).
O autor principal revisa cada diff antes de aceitar.

> **Nota sobre evals:** evals existentes só são alterados se uma mudança de conteúdo
> os tornar incorretos. Conteúdo genuinamente novo e ensinável pode ganhar evals
> adicionais, mas o foco da Frente 1 é o conteúdo das skills.

## Frente 2 — `golang-object-calisthenics`

**Enquadramento:** disciplina para *domain/business logic* em Go (modelos ricos).
Explicitamente **não** se aplica a: plumbing estilo stdlib, hot paths de performance,
DTOs simples, código de adaptador/transporte. Cada regra é marcada como **Rígida**
(seguir sempre) ou **Flexível** (heurística com julgamento), com nota explícita
onde conflita com Go idiomático.

### As 9 regras adaptadas

| # | Regra original | Adaptação Go | Tipo |
|---|---|---|---|
| 1 | One level of indentation per method | Minimizar aninhamento; extrair helper / early return ao passar de ~2 níveis | Flexível |
| 2 | Don't use the ELSE keyword | Guard clauses / early return — já idiomático em Go | **Rígida** |
| 3 | Wrap all primitives and strings | Defined types para valores de domínio (`type UserID string`, `type Celsius float64`); evitar primitive obsession — em fronteiras e onde há invariantes, não em tudo | Flexível |
| 4 | First-class collections | Struct envolvendo slice/map quando a coleção tem comportamento/invariante (`type Cart struct{ items []Item }`); não envolver todo slice | Flexível |
| 5 | One dot per line | Reinterpretada como **Lei de Demeter**: não atravessar objetos (`a.B().C().D()`); chaining de builder fluente é exceção legítima | Flexível |
| 6 | Don't abbreviate | **Reinterpretada (conflito forte com Go):** nomes curtos proporcionais ao escopo são idiomáticos (`i`, `ctx`, `r`, `w`, `err`); a regra vira "sem abreviação críptica/inconsistente; identificadores longos/exportados descritivos". Delega a `golang-naming` | Flexível |
| 7 | Keep all entities small | Funções, arquivos, pacotes e **interfaces** pequenos e coesos (`io.Reader`) | Flexível |
| 8 | No more than two instance variables | **Largar o literal "2"** (impraticável em Go): alta coesão; agrupar campos relacionados em sub-structs; quebrar god-structs | Flexível |
| 9 | No getters/setters/properties | Tell-don't-ask; expor **comportamento**, não estado. Nota Go: campos exportados são idiomáticos — o alvo é não escrever pares `GetX/SetX` estilo Java | Flexível |

### Estrutura de arquivos

Mesmo padrão das demais skills:

- `skills/golang-object-calisthenics/SKILL.md`
  - Frontmatter: `name`, `description` (auto-trigger ao escrever/revisar domínio Go),
    `user-invocable: true`, `license: MIT`, `metadata.author: Ramiro-Ribeiro`,
    `version: "1.0.0"`, emoji, `allowed-tools`.
  - Banner "Community default" no mesmo estilo.
  - Intro com enquadramento (quando aplica / quando NÃO aplica).
  - As 9 regras, cada uma com: adaptação, tag Rígida/Flexível, exemplo bom/ruim Go,
    e nota de conflito quando houver.
  - Seção "When NOT to apply".
  - Cross-references para `golang-code-style`, `golang-naming`,
    `golang-structs-interfaces`, `golang-design-patterns`.
- `skills/golang-object-calisthenics/references/details.md`
  - Tabela de mapeamento Java→Go das regras.
  - Walkthrough de refactor (de struct anêmico/primitive-obsessed → modelo rico).
  - Edge cases e exceções (builders, DTOs, performance).
- `skills/golang-object-calisthenics/evals/evals.json`
  - ~8-10 evals trap-based, cobrindo as regras com comportamento ensinável:
    no-else/early-return, value objects (wrap primitives), first-class collections,
    tell-don't-ask (no getters/setters), small interfaces, Lei de Demeter.
  - Mesmo formato dos evals existentes (`id`, `name`, `description`, `prompt`,
    `trap`, `assertions[]`).

### Cross-references reversas

Adicionar uma linha de cross-reference apontando para `golang-object-calisthenics`
em: `golang-code-style`, `golang-naming`, `golang-structs-interfaces`,
`golang-design-patterns`.

## Atualização do README

Adicionar `golang-object-calisthenics` à tabela de skills do README (provável seção
"Quality" ou nova linha em "Foundations") com descrição de uma linha.

## Validação

Não há eval runner automatizado no repo. Validação consiste em:

- Markdown bem-formado e internamente consistente (cross-refs resolvem, frontmatter válido).
- Exemplos de código Go nos blocos compilam conceitualmente / são idiomáticos.
- Evals novos seguem o schema dos existentes.
- Diffs da Frente 1 revisados individualmente pelo autor principal contra a régua.

## Fora de escopo

- Rewrite de skills que já estão corretas.
- Mudança no mecanismo de instalação (`install.sh`/`install.js`).
- Criação de eval runner automatizado.
- Refatoração não relacionada.
