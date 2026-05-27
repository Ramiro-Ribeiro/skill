# Go Skills for Claude Code

Agent skills with Go expertise for large-scale production projects. Auto-triggers on relevant code — no manual invocation needed.

## Install

```bash
# Global (all projects)
npx github:Ramiro-Ribeiro/skills

# Project-local
npx github:Ramiro-Ribeiro/skills --project /path/to/your/project

# Global only, skip project detection
npx github:Ramiro-Ribeiro/skills --global
```

Restart Claude Code after installing.

## Skills

### Foundations

| Skill | What it covers |
|-------|---------------|
| `golang-code-style` | Formatting, conventions, linter config |
| `golang-naming` | Packages, structs, interfaces, errors, receivers — MixedCaps, anti-patterns |
| `golang-structs-interfaces` | Composition, embedding, type assertions, tags, pointer vs value receivers |
| `golang-safety` | Nil panics, append aliasing, map race, defer in loops, defensive copy |
| `golang-documentation` | godoc, README, CHANGELOG, example tests, llms.txt |

### Errors & Control Flow

| Skill | What it covers |
|-------|---------------|
| `golang-error-handling` | `%w` wrapping, `errors.Is/As/Join`, sentinel errors, panic/recover, slog |
| `golang-context` | Propagation, cancellation, timeouts, deadlines, values, tracing |
| `golang-troubleshooting` | pprof, Delve, race detector, GODEBUG, production debugging |

### Concurrency & Performance

| Skill | What it covers |
|-------|---------------|
| `golang-concurrency` | Goroutines, channels, errgroup, singleflight, worker pools, fan-out/in |
| `golang-performance` | Alloc reduction, CPU, memory layout, GC tuning, pooling, hot-path |

### Architecture

| Skill | What it covers |
|-------|---------------|
| `golang-project-layout` | Directory layout, monorepo, go workspaces |
| `golang-design-patterns` | Functional options, constructors, graceful shutdown, resilience |
| `golang-dependency-injection` | Manual DI + wire/dig/fx/do comparison |
| `golang-large-scale` | Cross-cutting reference: arch, gRPC, Kafka, Redis, OTel, monorepo |

### Quality

| Skill | What it covers |
|-------|---------------|
| `golang-testing` | Table-driven, testify, mocks, fuzzing, goleak, snapshot, CI |
| `golang-lint` | golangci-lint, `.golangci.yml`, nolint directives |

### Discipline

| Skill | What it covers |
|-------|---------------|
| `golang-object-calisthenics` | Object Calisthenics 9 rules adapted pragmatically to idiomatic Go — value objects, tell-don't-ask, small entities |

### Production

| Skill | What it covers |
|-------|---------------|
| `golang-observability` | slog, Prometheus, OpenTelemetry, pprof/Pyroscope, Grafana |
| `golang-security` | Injection, crypto, filesystem, secrets, cookies, memory safety |
| `golang-database` | database/sql, sqlx, pgx, transactions, isolation, pool, migrations |

## How it works

Each skill is a folder with a `SKILL.md` and lazy-loaded `references/*.md`. Claude Code loads them automatically when the context matches the skill description — no `/command` needed.

Skills install to:
- **Global**: `~/.claude/plugins/cache/golang-skills/` (all projects)
- **Project**: `.claude/skills/` or `.agents/skills/` (project-local)

## Credits

Based on [samber/cc-skills-golang](https://github.com/samber/cc-skills-golang). Curated for large-scale Go projects.
