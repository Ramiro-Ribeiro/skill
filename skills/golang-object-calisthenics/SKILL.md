---
name: golang-object-calisthenics
description: "Object Calisthenics rules adapted pragmatically to idiomatic Go. Use when writing or reviewing Go domain/business logic — rich models, value objects, reducing primitive obsession and anemic structs. Not for stdlib-style plumbing, DTOs, or hot paths."
user-invocable: true
license: MIT
compatibility: Designed for Claude Code or similar AI coding agents, and for projects using Golang.
metadata:
  author: Ramiro-Ribeiro
  version: "1.0.0"
  openclaw:
    emoji: "🧗"
    homepage: https://github.com/Ramiro-Ribeiro/skills
    requires:
      bins:
        - go
    install: []
allowed-tools: Read Edit Write Glob Grep Bash(go:*) Bash(golangci-lint:*) Bash(git:*) Agent
---

> **Community default.** A company skill that explicitly supersedes `samber/cc-skills-golang@golang-object-calisthenics` skill takes precedence.

# Go Object Calisthenics

Object Calisthenics (Jeff Bay, *ThoughtWorks Anthology*) is a set of 9 exercises for
writing cohesive, intention-revealing object-oriented code. Go is not Java — several
rules fight Go idioms head-on. This skill adapts each rule to what is genuinely
**idiomatic and valuable in Go**, marks each as **Rigid** (always follow) or
**Flexible** (heuristic, use judgment), and calls out conflicts explicitly.

> "Clear is better than clever." — Go Proverbs

**These are exercises, not laws.** They sharpen domain models; they are not a style
guide for every line of Go.

## When to apply

- **Yes:** domain/business logic, rich entities, value objects, aggregates with invariants.
- **No:** stdlib-style plumbing, transport/adapter code, simple DTOs, serialization
  structs, and performance hot paths (see `samber/cc-skills-golang@golang-performance`).
  Forcing these rules there produces ceremony, not clarity.
