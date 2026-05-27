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

## The 9 Rules

### 1. One level of indentation per method

**Flexible**

Deep nesting hides logic. Minimize it — once a method passes ~2 levels of nesting,
extract the inner work into a named helper or use early returns. The goal is
readability, not a literal one-level cap.

```go
// Bad — a loop wrapping an if wrapping the real work
func (r *Report) Summarize(orders []Order) Summary {
	var s Summary
	for _, o := range orders {
		if o.Status == StatusPaid {
			s.Count++
			s.Total = s.Total.Add(o.Total)
		}
	}
	return s
}

// Good — the inner work moves into a named helper, flattening Summarize
func (r *Report) Summarize(orders []Order) Summary {
	var s Summary
	for _, o := range orders {
		s.addPaid(o)
	}
	return s
}

func (s *Summary) addPaid(o Order) {
	if o.Status != StatusPaid {
		return
	}
	s.Count++
	s.Total = s.Total.Add(o.Total)
}
```

See `samber/cc-skills-golang@golang-code-style` (Reduce Nesting) for the early-return form.

### 2. Don't use the ELSE keyword

**Rigid**

Use guard clauses and early returns; keep the happy path at minimal indentation.
This is already idiomatic Go — the linters even flag the `else` after a terminating
`if` body.

```go
// Bad — the else just hides the early return
func authorize(u User) error {
	if u.IsActive {
		// ... long happy path nested under the if ...
		return nil
	} else {
		return ErrInactive
	}
}

// Good — guard first, happy path at top level
func authorize(u User) error {
	if !u.IsActive {
		return ErrInactive
	}
	// ... happy path, no nesting ...
	return nil
}
```

### 3. Wrap primitives and strings

**Flexible**

Give domain values their own type — `type UserID string`, `type Celsius float64`,
`type Email string` — and add a constructor that enforces the invariant. Apply this
at boundaries and wherever invariants or units matter. Do **not** wrap every `int`;
a type with no behavior or safety is just noise.

```go
// Good — a defined type with a validating constructor and behavior
type Email string

func NewEmail(s string) (Email, error) {
	s = strings.TrimSpace(s)
	if !strings.Contains(s, "@") {
		return "", fmt.Errorf("invalid email: %q", s)
	}
	return Email(s), nil
}

// Good — Money carries currency and prevents accidental float arithmetic
type Money struct {
	cents    int64
	currency string
}

func (m Money) Add(o Money) Money {
	return Money{cents: m.cents + o.cents, currency: m.currency}
}

// Bad — a wrapper that adds no behavior or safety; just use int
type Count int
```

See `samber/cc-skills-golang@golang-structs-interfaces` for designing such types.

### 4. First-class collections

**Flexible**

When a slice or map carries behavior or invariants, wrap it in a struct that owns
those operations instead of passing the raw collection around and duplicating the
logic at every call site. Leave collections that are just data in transit alone.

```go
// Bad — Total/IsEmpty logic gets re-implemented wherever []LineItem travels
func total(items []LineItem) Money { /* ... */ }

// Good — Cart owns its items and the rules over them
type Cart struct {
	items []LineItem
}

func (c *Cart) Add(item LineItem) { c.items = append(c.items, item) }

func (c *Cart) IsEmpty() bool { return len(c.items) == 0 }

func (c *Cart) Total() Money {
	var sum Money
	for _, it := range c.items {
		sum = sum.Add(it.Price)
	}
	return sum
}
```

### 5. One dot per line → Law of Demeter

**Flexible**

Read this as the Law of Demeter rather than a literal dot count: don't reach through
a chain of objects to get at distant state. Ask the immediate collaborator for what
you need. Fluent builders (`strings.Builder`, query builders) are a legitimate
exception — they return the same object to chain on.

```go
// Bad — reaching through three objects couples you to all of them
code := order.Customer().Address().Country().Code()

// Good — ask the immediate collaborator; Order hides the traversal
code := order.ShippingCountryCode()

// Fine — fluent builder chaining is an accepted exception
var b strings.Builder
b.WriteString("a")
b.WriteString("b")
```

### 6. Don't abbreviate

**Flexible**

> **Go conflict:** Short names proportional to scope are idiomatic in Go. Loop
> indexes (`i`), `ctx`, request/response (`r`, `w`), `err`, and single-letter
> receivers are correct, not lazy — the Go community treats them as standard.

Reinterpret the rule as: no cryptic or inconsistent abbreviations. Long-lived and
exported identifiers must be descriptive and spelled out; tightly scoped locals may
be short. Defer fully to `samber/cc-skills-golang@golang-naming`.

```go
// Good — short where scope is tiny, descriptive where it lives long
func (c *Cart) Total(ctx context.Context, userRepo UserRepository) Money {
	for i, it := range c.items {
		_ = i
		_ = it
	}
	// ...
}

// Bad — cryptic, inconsistent abbreviations
func (c *Cart) calcTotAmt(usrRpstry UserRepository, flg2 bool) Money
```

### 7. Keep all entities small

**Flexible**

Favor small functions, small files, small packages, and — most valuably in Go —
small interfaces. `io.Reader` is one method; that is the model to aim for. These are
heuristics, not hard line counts.

```go
// Good — a small, single-method interface composes and mocks easily
type Notifier interface {
	Notify(ctx context.Context, msg Message) error
}

// Bad — a fat interface forces every implementer to satisfy unrelated methods
type Service interface {
	Notify(ctx context.Context, msg Message) error
	Archive(id string) error
	Reindex() error
	Migrate(v int) error
}
```

See `samber/cc-skills-golang@golang-structs-interfaces` for small-interface design.

### 8. High cohesion over field count

**Flexible**

The original rule caps a class at two instance variables. That is impractical in Go —
configs and aggregates legitimately have many fields — so **the literal "2" is
dropped**. Adapt it to cohesion: a struct's fields should belong together. Group
related fields into sub-structs and split god-structs by responsibility.

```go
// Bad — a flat god-struct mixing customer, address, and payment concerns
type Order struct {
	ID            string
	CustomerName  string
	Street        string
	City          string
	PostalCode    string
	CardLast4     string
	CardExpMonth  int
	CardExpYear   int
}

// Good — related fields cluster into cohesive sub-structs
type Order struct {
	ID       string
	Customer string
	ShipTo   Address
	Payment  Payment
}

type Address struct {
	Street     string
	City       string
	PostalCode string
}

type Payment struct {
	CardLast4 string
	ExpMonth  int
	ExpYear   int
}
```

### 9. No getters/setters — tell, don't ask

**Flexible**

Expose behavior, not state. Let callers tell an object what to do rather than pulling
out its data, mutating it, and pushing it back.

> **Go conflict:** Exported struct fields ARE idiomatic in Go, unlike Java. The
> target is NOT "make every field private" — it is "don't write Java-style
> `GetX()`/`SetX()` pairs around private fields when you could expose the field or,
> better, a behavior method".

```go
// Bad — ask for state, mutate outside, set it back
account.SetBalance(account.GetBalance() - amount)

// Good — tell the object what to do; it guards its own invariant
account.Withdraw(amount)
```

## When NOT to apply

- **Stdlib-style plumbing and transport/adapter code** — wrapping here is ceremony.
- **Simple DTOs and wire/serialization structs** — rules 3 (wrap primitives), 8
  (cohesion over field count), and 9 (no getters/setters) don't apply; exported flat
  fields are exactly what a serialization struct should be.
- **Performance hot paths** — don't wrap primitives or collections when allocations
  and indirection matter (see `samber/cc-skills-golang@golang-performance`).
- **Naming** — where idiomatic short names (`i`, `ctx`, `err`, single-letter
  receivers) read better, they beat "don't abbreviate".

## Cross-References

- → See the `samber/cc-skills-golang@golang-code-style` skill for reduce-nesting,
  early returns, and eliminating `else` (rules 1 and 2)
- → See the `samber/cc-skills-golang@golang-naming` skill for the authority on
  identifier naming and acceptable short names (rule 6)
- → See the `samber/cc-skills-golang@golang-structs-interfaces` skill for value
  types, small interfaces, and receiver design (rules 3 and 7)
- → See the `samber/cc-skills-golang@golang-design-patterns` skill for constructors,
  functional options, and builders that shape rich domain types
