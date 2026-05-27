# Go Skills Improvement + Object Calisthenics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `golang-object-calisthenics` skill (9 rules adapted pragmatically to idiomatic Go) and run a surgical, evidence-based improvement pass over the 18 existing Go skills.

**Architecture:** Frente 2 (new skill) first — self-contained, low risk, produces a working deliverable. Then Frente 1 (improvement pass) in 5 batches of 3-4 skills each, dispatched to parallel sub-agents and reviewed diff-by-diff by the lead. Reverse cross-references to the new skill are folded into the batches that touch the related skills.

**Tech Stack:** Markdown skill files (`SKILL.md` + `references/*.md` + `evals/evals.json`), same format as existing skills. Validation: valid YAML frontmatter, resolvable cross-refs, valid JSON evals (`python3 -m json.tool`).

**Spec:** `docs/superpowers/specs/2026-05-26-go-skills-improvement-and-object-calisthenics-design.md`

---

## Conventions (apply to every task)

- **Cross-ref prefix:** existing skills reference each other as `samber/cc-skills-golang@golang-X`. Use the same prefix for the new skill: `samber/cc-skills-golang@golang-object-calisthenics`.
- **Frontmatter pattern** (copy from an existing skill, e.g. `golang-code-style/SKILL.md`): `name`, `description`, `user-invocable: true`, `license: MIT`, `compatibility`, `metadata` (`author`, `version`, `openclaw.emoji`, `openclaw.homepage`, `openclaw.requires.bins: [go]`, `openclaw.install: []`), `allowed-tools`.
- **Banner:** keep the `> **Community default.** ...` line right after the frontmatter.
- **JSON validation command:** `python3 -m json.tool skills/<skill>/evals/evals.json > /dev/null && echo OK`
- **Commit cadence:** one commit per task (or per batch in Frente 1). Co-author trailer: `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.

---

## FRENTE 2 — `golang-object-calisthenics` (new skill)

### Task 1: Scaffold skill + frontmatter + intro

**Files:**
- Create: `skills/golang-object-calisthenics/SKILL.md`

- [ ] **Step 1: Create directory**

```bash
mkdir -p skills/golang-object-calisthenics/references skills/golang-object-calisthenics/evals
```

- [ ] **Step 2: Write `SKILL.md` frontmatter + banner + intro**

Write exactly this header into `skills/golang-object-calisthenics/SKILL.md`:

```markdown
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
```

- [ ] **Step 3: Verify frontmatter parses**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('skills/golang-object-calisthenics/SKILL.md').read().split('---')[1])" && echo OK`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add skills/golang-object-calisthenics/SKILL.md
git commit -m "$(cat <<'EOF'
feat(object-calisthenics): scaffold skill with frontmatter and framing

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Write the 9 rules

**Files:**
- Modify: `skills/golang-object-calisthenics/SKILL.md` (append rules + closing sections)

- [ ] **Step 1: Append the 9 rule sections**

Append to `SKILL.md`. Each rule MUST follow this shape: `## N. <title>` heading, a
**tag line** (`**Rigid**` or `**Flexible**`), the Go adaptation in prose, a Go
good/bad code example, and a `> **Go conflict:**` note where relevant. Required content
per rule (locked in spec):

1. **One level of indentation per method** — *Flexible.* Minimize nesting; extract a
   helper or use early return once you pass ~2 levels. Example: a nested loop+if
   refactored by extracting the inner loop into a named method. Cross-ref
   `samber/cc-skills-golang@golang-code-style` (Reduce Nesting).

2. **Don't use the ELSE keyword** — *Rigid.* Guard clauses / early return; the happy
   path stays at minimal indentation. Bad: `if ok { ... } else { return err }`. Good:
   `if !ok { return err }` then continue. Note this is already idiomatic Go.

3. **Wrap primitives and strings** — *Flexible.* Defined types for domain values:
   `type UserID string`, `type Celsius float64`, `type Email string` with a
   constructor `NewEmail(s string) (Email, error)` that enforces the invariant. Apply
   at boundaries and where invariants/units matter — NOT for every int. Good example:
   a `Money` type preventing accidental float math; bad: `type Count int` with no
   behavior added. Cross-ref `samber/cc-skills-golang@golang-structs-interfaces`.

4. **First-class collections** — *Flexible.* When a slice/map has behavior or
   invariants, wrap it: `type Cart struct { items []LineItem }` with `Add`, `Total`,
   `IsEmpty` methods instead of passing `[]LineItem` around and duplicating logic.
   Don't wrap collections that are just data in transit.

5. **One dot per line → Law of Demeter** — *Flexible.* Reinterpreted: don't reach
   through objects (`order.Customer().Address().Country().Code()`). Ask the immediate
   collaborator (`order.ShippingCountry()`). Builder/fluent chains (`strings.Builder`,
   query builders) are a legitimate exception.

6. **Don't abbreviate** — *Flexible.* **Go conflict:** short names proportional to
   scope are idiomatic (`i`, `ctx`, `r`, `w`, `err`, single-letter receivers).
   Reinterpreted as: no cryptic or inconsistent abbreviations; long-lived and exported
   identifiers must be descriptive and spelled out. Defers fully to
   `samber/cc-skills-golang@golang-naming`. Good: `ctx`, `userRepo`; bad: `usrRpstry`,
   `flg2`.

7. **Keep all entities small** — *Flexible.* Small functions, files, packages, and
   especially **interfaces** (`io.Reader` is one method). Heuristics, not hard limits.
   Cross-ref `samber/cc-skills-golang@golang-structs-interfaces` (small interfaces).

8. **High cohesion over field count** — *Flexible.* The original "max 2 instance
   variables" is impractical in Go (configs/aggregates legitimately have many fields).
   Adapted: a struct's fields should belong together; group related fields into
   sub-structs; split god-structs by responsibility. Example: an `Order` god-struct
   split so address fields become an embedded/nested `Address`.

9. **No getters/setters — tell, don't ask** — *Flexible.* Expose behavior, not state.
   **Go note:** exported struct fields ARE idiomatic in Go (unlike Java) — the target
   is not "make every field private," it is "don't write Java-style `GetX()`/`SetX()`
   pairs around private fields when you could expose the field or, better, a behavior."
   Good: `account.Withdraw(amount)`; bad: `account.SetBalance(account.GetBalance() - amount)`.

- [ ] **Step 2: Append closing sections**

Append: a `## When NOT to apply` recap, and a `## Cross-References` list linking
`samber/cc-skills-golang@golang-code-style`, `@golang-naming`,
`@golang-structs-interfaces`, `@golang-design-patterns`.

- [ ] **Step 3: Verify cross-refs resolve to real skills**

Run: `grep -o 'golang-[a-z-]*' skills/golang-object-calisthenics/SKILL.md | sort -u | while read s; do [ -d "skills/$s" ] || echo "MISSING: $s"; done; echo "check done"`
Expected: `check done` with no `MISSING:` lines.

- [ ] **Step 4: Commit**

```bash
git add skills/golang-object-calisthenics/SKILL.md
git commit -m "$(cat <<'EOF'
feat(object-calisthenics): add 9 rules adapted to idiomatic Go

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Write `references/details.md`

**Files:**
- Create: `skills/golang-object-calisthenics/references/details.md`

- [ ] **Step 1: Write details**

Content (3 sections):
1. **Java→Go mapping table** — for each of the 9 rules: original intent | Java
   mechanism | Go-idiomatic equivalent | Rigid/Flexible.
2. **Refactor walkthrough** — take an anemic, primitive-obsessed struct (e.g. a
   `User struct` with `email string`, `GetEmail`/`SetEmail`, validation scattered in
   callers) and refactor step-by-step into a rich model: `Email` value object with
   `NewEmail` validation, behavior methods instead of getters/setters, early returns,
   a first-class collection where applicable. Show before/after Go code.
3. **Exceptions & edge cases** — builders/fluent APIs vs Law of Demeter; DTOs and
   wire structs exempt from rules 3/8/9; performance hot paths exempt from wrapping;
   when short names beat "don't abbreviate".

- [ ] **Step 2: Verify links resolve**

Run: `grep -o 'golang-[a-z-]*' skills/golang-object-calisthenics/references/details.md | sort -u | while read s; do [ -d "skills/$s" ] || echo "MISSING: $s"; done; echo "check done"`
Expected: `check done`, no `MISSING:`.

- [ ] **Step 3: Commit**

```bash
git add skills/golang-object-calisthenics/references/details.md
git commit -m "$(cat <<'EOF'
docs(object-calisthenics): add details reference (Java→Go map, refactor walkthrough, exceptions)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Write `evals/evals.json`

**Files:**
- Create: `skills/golang-object-calisthenics/evals/evals.json`

- [ ] **Step 1: Write 8 trap-based evals**

Match the existing schema exactly: array of objects with `id` (int), `name`,
`description`, `prompt`, `trap`, `assertions` (array of `{id, text}`). Cover these
8 cases:

1. **no-else-early-return** — prompt asks for validation logic; trap: model uses
   `else` branches; assert: guard clauses with early `return`, no `else`.
2. **value-object-wrap-primitive** — prompt: model an `Email` / `Money` domain value;
   trap: passes raw `string`/`float64` with validation in callers; assert: defined type
   + constructor enforcing invariant.
3. **first-class-collection** — prompt: a shopping cart with totals/rules; trap:
   exposes `[]Item` and duplicates total logic in callers; assert: collection wrapped
   in a struct with behavior methods.
4. **law-of-demeter** — prompt: get a shipping country from an order; trap: chains
   `order.Customer().Address().Country()`; assert: order exposes a method, no train-wreck.
5. **tell-dont-ask-no-getset** — prompt: withdraw from an account; trap: emits
   `GetBalance`/`SetBalance` and mutates from caller; assert: a `Withdraw` behavior
   method encapsulates the rule.
6. **small-interface** — prompt: define an abstraction for a notifier; trap: a fat
   multi-method interface; assert: minimal single-purpose interface.
7. **high-cohesion-split** — prompt: an order with customer+address+payment fields;
   trap: flat god-struct; assert: related fields grouped into nested/embedded structs.
8. **idiomatic-short-names** — prompt: a short loop/handler; trap: model over-applies
   "don't abbreviate" producing `index`, `requestWriter`, `httpRequest` for tiny
   scopes; assert: idiomatic short names (`i`, `w`, `r`, `ctx`) are accepted/used —
   this eval guards the rule-6 reinterpretation.

- [ ] **Step 2: Validate JSON**

Run: `python3 -m json.tool skills/golang-object-calisthenics/evals/evals.json > /dev/null && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add skills/golang-object-calisthenics/evals/evals.json
git commit -m "$(cat <<'EOF'
test(object-calisthenics): add trap-based evals for the 9 rules

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Add skill to README

**Files:**
- Modify: `README.md` (skills tables)

- [ ] **Step 1: Add a row**

Add `golang-object-calisthenics` to the README skill tables. Place it under a new
**Discipline** subsection (or append to **Quality**), one-line description:
`Object Calisthenics 9 rules adapted pragmatically to idiomatic Go — value objects, tell-don't-ask, small entities`.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: add golang-object-calisthenics to README skill table

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## FRENTE 1 — Improvement pass over the 18 existing skills

Each batch below is dispatched to ONE sub-agent (Agent tool). The lead reviews the
returned diff against the régua before accepting. Sub-agents edit only `SKILL.md` and
`references/*.md` (and, per the régua note, may ADD evals for genuinely new teachable
content but must not break existing evals).

### Sub-agent prompt template (use for every batch)

> You are improving existing Claude Code skills for Go in the repo at
> `/home/ramiro/GolandProjects/skill`. Edit ONLY these skills: **<LIST>**. For each,
> read `skills/<skill>/SKILL.md` and `skills/<skill>/references/*.md`.
>
> **Régua — edit ONLY where you find:** (a) a real gap (consensus topic missing),
> (b) divergence from current community consensus, or (c) outdated advice contradicted
> by Go 1.22+. Do NOT rewrite content that is already correct and well-formulated.
> Preserve tone, structure, frontmatter shape, the "Community default" banner, and the
> `samber/cc-skills-golang@` cross-ref prefix.
>
> **Reference baseline:** Effective Go, Go Code Review Comments, Google Go Style Guide,
> Uber Go Style Guide, Go Proverbs, Dave Cheney. **Modernization Go 1.22+:** range-over-int
> & range-over-func (1.23), loopvar semantics (1.22 — no more `x := x`), mature generics,
> `slices`/`maps`/`cmp` packages, `min`/`max`/`clear` builtins, `log/slog`, `errors.Join`,
> `testing.B.Loop` (1.24).
>
> **Versioning:** bump the `metadata.version` patch/minor for each skill you actually
> change (keep `author: samber`). Leave unchanged skills untouched.
>
> **Reverse cross-ref (only if your batch is told to):** add ONE cross-reference line
> pointing to `samber/cc-skills-golang@golang-object-calisthenics` in the named skills.
>
> **Report back:** per skill, a short bullet list of each change tagged (a)/(b)/(c),
> or "no change needed". Do not commit — leave edits in the working tree.

### Task 6: Batch A — foundations

**Files:** `skills/golang-code-style/`, `skills/golang-naming/`, `skills/golang-structs-interfaces/`, `skills/golang-safety/`

- [ ] **Step 1:** Dispatch sub-agent with the template above; `<LIST>` = the four skills. **Reverse cross-ref:** add the OC cross-ref line to `golang-code-style`, `golang-naming`, and `golang-structs-interfaces`.
- [ ] **Step 2:** Lead reviews each diff (`git diff skills/golang-code-style ...`) against the régua. Revert any change that rewrites correct content or isn't justified by (a)/(b)/(c).
- [ ] **Step 3:** Verify each touched skill: frontmatter parses, cross-refs resolve (`grep -o 'golang-[a-z-]*' skills/<skill>/SKILL.md | sort -u | while read s; do [ -d "skills/$s" ] || echo MISSING: $s; done`), and any new/edited evals validate (`python3 -m json.tool`).
- [ ] **Step 4: Commit**

```bash
git add skills/golang-code-style skills/golang-naming skills/golang-structs-interfaces skills/golang-safety
git commit -m "$(cat <<'EOF'
feat(skills): improve foundations batch (code-style, naming, structs-interfaces, safety)

Align with community style guides, modernize for Go 1.22+, add object-calisthenics cross-refs.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 7: Batch B — errors / control flow / docs

**Files:** `skills/golang-error-handling/`, `skills/golang-context/`, `skills/golang-troubleshooting/`, `skills/golang-documentation/`

- [ ] **Step 1:** Dispatch sub-agent; `<LIST>` = the four skills. No reverse cross-ref this batch.
- [ ] **Step 2:** Lead reviews each diff against the régua; revert unjustified rewrites.
- [ ] **Step 3:** Verify frontmatter, cross-refs, and evals JSON for each touched skill (same commands as Task 6 Step 3).
- [ ] **Step 4: Commit**

```bash
git add skills/golang-error-handling skills/golang-context skills/golang-troubleshooting skills/golang-documentation
git commit -m "$(cat <<'EOF'
feat(skills): improve errors/control-flow batch (error-handling, context, troubleshooting, documentation)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 8: Batch C — concurrency / performance / architecture

**Files:** `skills/golang-concurrency/`, `skills/golang-performance/`, `skills/golang-design-patterns/`, `skills/golang-dependency-injection/`

- [ ] **Step 1:** Dispatch sub-agent; `<LIST>` = the four skills. **Reverse cross-ref:** add the OC cross-ref line to `golang-design-patterns`.
- [ ] **Step 2:** Lead reviews each diff against the régua; revert unjustified rewrites. (Watch `golang-performance` — large file; ensure edits stay surgical.)
- [ ] **Step 3:** Verify frontmatter, cross-refs, evals JSON for each touched skill.
- [ ] **Step 4: Commit**

```bash
git add skills/golang-concurrency skills/golang-performance skills/golang-design-patterns skills/golang-dependency-injection
git commit -m "$(cat <<'EOF'
feat(skills): improve concurrency/perf/arch batch (concurrency, performance, design-patterns, dependency-injection)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 9: Batch D — layout / quality

**Files:** `skills/golang-project-layout/`, `skills/golang-large-scale/`, `skills/golang-testing/`, `skills/golang-lint/`

- [ ] **Step 1:** Dispatch sub-agent; `<LIST>` = the four skills. No reverse cross-ref. (Note: `golang-large-scale` has no `evals/`; that's expected.)
- [ ] **Step 2:** Lead reviews each diff against the régua; revert unjustified rewrites.
- [ ] **Step 3:** Verify frontmatter, cross-refs, evals JSON (skip evals check for `golang-large-scale`).
- [ ] **Step 4: Commit**

```bash
git add skills/golang-project-layout skills/golang-large-scale skills/golang-testing skills/golang-lint
git commit -m "$(cat <<'EOF'
feat(skills): improve layout/quality batch (project-layout, large-scale, testing, lint)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 10: Batch E — production

**Files:** `skills/golang-observability/`, `skills/golang-security/`, `skills/golang-database/`

- [ ] **Step 1:** Dispatch sub-agent; `<LIST>` = the three skills. No reverse cross-ref.
- [ ] **Step 2:** Lead reviews each diff against the régua; revert unjustified rewrites.
- [ ] **Step 3:** Verify frontmatter, cross-refs, evals JSON for each touched skill.
- [ ] **Step 4: Commit**

```bash
git add skills/golang-observability skills/golang-security skills/golang-database
git commit -m "$(cat <<'EOF'
feat(skills): improve production batch (observability, security, database)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Final consistency sweep

**Files:** all of `skills/`, `README.md`

- [ ] **Step 1: Resolve all cross-refs repo-wide**

Run:
```bash
grep -rho 'golang-[a-z-]*' skills/*/SKILL.md skills/*/references/*.md | sort -u | while read s; do [ -d "skills/$s" ] || echo "MISSING: $s"; done; echo "done"
```
Expected: `done`, no `MISSING:` lines.

- [ ] **Step 2: Validate every evals.json**

Run:
```bash
for f in skills/*/evals/evals.json; do python3 -m json.tool "$f" > /dev/null && echo "OK $f" || echo "BAD $f"; done
```
Expected: every line `OK ...`.

- [ ] **Step 3: Confirm new skill is installed by the installer**

Read `install.sh` / `bin/install.js` — confirm they iterate `skills/*/` (no hardcoded list). The new skill must be picked up automatically. If a hardcoded list exists, add `golang-object-calisthenics`.

- [ ] **Step 4: Confirm README lists 19 skills and OC row is present**

Run: `ls -d skills/*/ | wc -l` (expect 19) and `grep -c object-calisthenics README.md` (expect ≥1).

- [ ] **Step 5: Final commit (if Step 3 required an edit)**

```bash
git add -A && git commit -m "$(cat <<'EOF'
chore: final consistency sweep for skills update

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review (lead, before reporting done)

- **Spec coverage:** Frente 2 (Tasks 1-5) covers the OC skill structure, 9 rules, references, evals, README. Frente 1 (Tasks 6-10) covers all 18 skills in 5 batches; reverse cross-refs folded into batches A & C. Task 11 covers validation. ✓
- **Out-of-scope respected:** no installer mechanism rewrite (only a read-check), no eval runner, no unrelated refactor. ✓
- **Naming consistency:** skill dir/name `golang-object-calisthenics` and cross-ref `samber/cc-skills-golang@golang-object-calisthenics` used consistently across all tasks. ✓
