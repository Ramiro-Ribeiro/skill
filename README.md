<div align="center">

# 🐹 Go Skills for Claude Code

**Production-grade Go expertise for [Claude Code](https://claude.com/claude-code) — auto-loaded when it matters, invisible when it doesn't.**

20 agent skills covering style, concurrency, performance, architecture, testing, security, and more. No slash commands, no setup — Claude pulls in the right guidance the moment your code touches the topic.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#-credits)
![Skills](https://img.shields.io/badge/skills-20-00ADD8?logo=go&logoColor=white)
![Go](https://img.shields.io/badge/Go-1.22%2B-00ADD8?logo=go&logoColor=white)
![For Claude Code](https://img.shields.io/badge/for-Claude%20Code-d97757)

</div>

---

## 🚀 Install

```bash
# Global — available in every project
npx github:Ramiro-Ribeiro/skills

# Project-local — scoped to one repo
npx github:Ramiro-Ribeiro/skills --project /path/to/your/project

# Global only, skip project detection
npx github:Ramiro-Ribeiro/skills --global
```

> Restart Claude Code after installing.

---

## 📚 Skills

### 🧱 Foundations

| Skill | What it covers |
|-------|---------------|
| 🎨 `golang-code-style` | Formatting, conventions, linter config |
| 🏷️ `golang-naming` | Packages, structs, interfaces, errors, receivers — MixedCaps, anti-patterns |
| 🧩 `golang-structs-interfaces` | Composition, embedding, type assertions, tags, pointer vs value receivers |
| 🛡️ `golang-safety` | Nil panics, append aliasing, map race, defer in loops, defensive copy |
| 📝 `golang-documentation` | godoc, README, CHANGELOG, example tests, llms.txt |

### ⚠️ Errors & Control Flow

| Skill | What it covers |
|-------|---------------|
| ⚠️ `golang-error-handling` | `%w` wrapping, `errors.Is/As/Join`, sentinel errors, panic/recover, slog |
| 🔗 `golang-context` | Propagation, cancellation, timeouts, deadlines, causes, tracing |
| 🔍 `golang-troubleshooting` | pprof, Delve, race detector, GODEBUG, production debugging |

### ⚡ Concurrency & Performance

| Skill | What it covers |
|-------|---------------|
| ⚡ `golang-concurrency` | Goroutines, channels, errgroup, singleflight, worker pools, fan-out/in |
| 🏎️ `golang-performance` | Alloc reduction, CPU, memory layout, GC tuning, pooling, hot-path |

### 🏗️ Architecture

| Skill | What it covers |
|-------|---------------|
| 📁 `golang-project-layout` | Directory layout, monorepo, go workspaces |
| 🏗️ `golang-design-patterns` | Functional options, constructors, graceful shutdown, resilience |
| 🔌 `golang-dependency-injection` | Manual DI + wire/dig/fx/do comparison |
| 🏛️ `golang-large-scale` | Cross-cutting reference: arch, gRPC, Kafka, Redis, OTel, monorepo |

### ✅ Quality

| Skill | What it covers |
|-------|---------------|
| 🧪 `golang-testing` | Table-driven, testify, mocks, fuzzing, goleak, snapshot, CI |
| 🧹 `golang-lint` | golangci-lint, `.golangci.yml`, nolint directives |

### 🧗 Discipline

| Skill | What it covers |
|-------|---------------|
| 🧗 `golang-object-calisthenics` | Object Calisthenics 9 rules adapted pragmatically to idiomatic Go — value objects, tell-don't-ask, small entities |

### 🚦 Production

| Skill | What it covers |
|-------|---------------|
| 📡 `golang-observability` | slog, Prometheus, OpenTelemetry, pprof/Pyroscope, Grafana |
| 🔒 `golang-security` | Injection, crypto, filesystem, secrets, cookies, memory safety |
| 🗄️ `golang-database` | database/sql, sqlx, pgx, transactions, isolation, pool, migrations |

---

## ⚙️ How it works

Each skill is a folder with a `SKILL.md` and lazy-loaded `references/*.md`. Claude Code reads the short description up front and pulls in the full skill **only when your context matches** — so guidance arrives automatically, without bloating the prompt or needing a `/command`.

Skills install to:

- 🌍 **Global** — `~/.claude/plugins/cache/golang-skills/` (all projects)
- 📦 **Project** — `.claude/skills/` or `.agents/skills/` (project-local)

Each skill ships with trap-based **evals** (`evals/evals.json`) that pin its guidance to concrete, testable behavior.

---

## 🙏 Credits

Based on [samber/cc-skills-golang](https://github.com/samber/cc-skills-golang), curated and extended for large-scale Go projects and modernized for Go 1.22+. Licensed under **MIT**.
