# Object Calisthenics Details

This reference expands the 9 rules in `SKILL.md` with a Java→Go mapping table, an
end-to-end refactor walkthrough, and the exceptions that override the rules.

## Java→Go mapping

Each rule keeps Jeff Bay's original *intent* but trades the Java mechanism for the
Go-idiomatic equivalent. **Rigid** rules always apply to domain code; **Flexible**
rules are heuristics — use judgment.

| Rule | Original intent | Java mechanism | Go-idiomatic equivalent | Rigid/Flexible |
| --- | --- | --- | --- | --- |
| 1. One level of indentation | Keep methods shallow and readable | Extract Method into private methods | Named helper methods + early returns; aim for ~2 levels, not a literal cap | Flexible |
| 2. No ELSE | Keep the happy path unnested | Guard clauses instead of `if/else` | Guard clauses + early `return`; linters flag `else` after a terminating `if` | Rigid |
| 3. Wrap primitives and strings | Give domain values type, units, and invariants | Small wrapper classes (`Email`, `Money`) | Defined types (`type Email string`) with a validating `New...` constructor; skip wrappers with no behavior | Flexible |
| 4. First-class collections | A collection's behavior lives with the collection | Wrapper class around a single `List` field | Struct owning a slice/map (`Cart`, `Users`) that owns the operations and invariants | Flexible |
| 5. One dot per line | Don't reach through object chains (Law of Demeter) | Tell-don't-ask method on the collaborator | Ask the immediate collaborator; fluent builders (`strings.Builder`) are an accepted exception | Flexible |
| 6. Don't abbreviate | Names reveal intent | Spell out every identifier fully | Short names proportional to scope (`i`, `ctx`, `err`, single-letter receivers) are correct; no cryptic abbreviations — defer to `samber/cc-skills-golang@golang-naming` | Flexible |
| 7. Keep all entities small | Small units compose and are understood quickly | Small classes, short methods | Small functions, files, packages, and especially small interfaces (`io.Reader`) | Flexible |
| 8. No more than two instance variables | High cohesion; fields belong together | Hard cap of 2 fields per class | Literal "2" is dropped; group related fields into cohesive sub-structs, split god-structs | Flexible |
| 9. No getters/setters | Tell, don't ask — expose behavior, not state | Private fields, behavior methods only | Behavior methods over Java-style `GetX`/`SetX`; exported fields are fine in Go — avoid the getter/setter ceremony | Flexible |

## Refactor walkthrough

We start from an anemic, primitive-obsessed `User` and refactor it into a rich model,
applying the rules one labeled step at a time.

### Step 0 — the starting point

The struct is a data bag: a bare `string`, Java-style getter/setter, and validation
scattered across every caller.

```go
type User struct {
	Email string
}

func (u *User) GetEmail() string  { return u.Email }
func (u *User) SetEmail(e string) { u.Email = e }

// Caller 1 — validation lives here
func register(u *User, raw string) error {
	raw = strings.TrimSpace(raw)
	if !strings.Contains(raw, "@") {
		return fmt.Errorf("invalid email: %q", raw)
	}
	u.SetEmail(raw)
	return nil
}

// Caller 2 — and again here, slightly differently (drift)
func updateContact(u *User, raw string) error {
	if !strings.Contains(raw, "@") {
		return errors.New("bad email")
	}
	u.SetEmail(raw)
	return nil
}
```

The same invariant is enforced twice, inconsistently — the classic symptom of a
primitive that should be a type.

### Step 1 — introduce an `Email` value object (rule 3)

Wrap the primitive in a defined type and move the invariant into one validating
constructor. Inside the constructor, guard first and return early — no `else`
(rule 2).

```go
type Email string

func NewEmail(raw string) (Email, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("email is required")
	}
	if !strings.Contains(raw, "@") {
		return "", fmt.Errorf("invalid email: %q", raw)
	}
	return Email(raw), nil
}

func (e Email) String() string { return string(e) }
```

Validation now exists in exactly one place, and an `Email` value cannot be
constructed in an invalid state.

### Step 2 — replace getter/setter with behavior (rule 9)

`User` no longer holds a raw string, and the `GetEmail`/`SetEmail` pair disappears.
Callers *tell* the user to change its address; the user guards its own invariant.

```go
type User struct {
	email Email
}

func NewUser(rawEmail string) (*User, error) {
	email, err := NewEmail(rawEmail)
	if err != nil {
		return nil, err
	}
	return &User{email: email}, nil
}

// Behavior, not a setter: re-validates through the same constructor.
func (u *User) ChangeEmail(rawEmail string) error {
	email, err := NewEmail(rawEmail)
	if err != nil {
		return err
	}
	u.email = email
	return nil
}

func (u *User) Email() Email { return u.email }
```

`Email()` is an accessor, not a Java getter — it returns the rich value object, and
there is no `SetEmail` that lets a caller bypass validation. Both original callers
collapse to `NewUser(raw)` / `u.ChangeEmail(raw)`, and the duplicated, drifting
validation is gone.

### Step 3 — a first-class collection where it fits (rule 4)

When users travel together with rules over the group, wrap the slice instead of
passing `[]*User` around and re-implementing lookups everywhere.

```go
type Users struct {
	items []*User
}

func (us *Users) Add(u *User) error {
	if us.contains(u.Email()) {
		return fmt.Errorf("duplicate email: %s", u.Email())
	}
	us.items = append(us.items, u)
	return nil
}

func (us *Users) contains(email Email) bool {
	for _, u := range us.items {
		if u.Email() == email {
			return true
		}
	}
	return false
}

func (us *Users) Len() int { return len(us.items) }
```

The uniqueness invariant now lives with the collection that owns it, not at each call
site.

### Final result

```go
type Email string

func NewEmail(raw string) (Email, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("email is required")
	}
	if !strings.Contains(raw, "@") {
		return "", fmt.Errorf("invalid email: %q", raw)
	}
	return Email(raw), nil
}

func (e Email) String() string { return string(e) }

type User struct {
	email Email
}

func NewUser(rawEmail string) (*User, error) {
	email, err := NewEmail(rawEmail)
	if err != nil {
		return nil, err
	}
	return &User{email: email}, nil
}

func (u *User) ChangeEmail(rawEmail string) error {
	email, err := NewEmail(rawEmail)
	if err != nil {
		return err
	}
	u.email = email
	return nil
}

func (u *User) Email() Email { return u.email }

type Users struct {
	items []*User
}

func (us *Users) Add(u *User) error {
	if us.contains(u.Email()) {
		return fmt.Errorf("duplicate email: %s", u.Email())
	}
	us.items = append(us.items, u)
	return nil
}

func (us *Users) contains(email Email) bool {
	for _, u := range us.items {
		if u.Email() == email {
			return true
		}
	}
	return false
}

func (us *Users) Len() int { return len(us.items) }
```

Net effect: the invariant moved from scattered caller code into typed constructors,
the struct gained behavior instead of getters/setters, and the group rule moved into
a first-class collection.

## Exceptions and edge cases

These are the cases where a rule legitimately yields. Forcing the rule here produces
ceremony, not clarity.

### Builders and fluent APIs — Law of Demeter exception (rule 5)

Rule 5 forbids reaching *through* a chain of distinct objects. A fluent builder is
not that: every call returns the *same* object (or a thin successor) so you can keep
configuring it. Chaining is the intended API, not a Demeter violation.

```go
// Fine — every call returns the same *strings.Builder / *Query
q := NewQuery().
	From("users").
	Where("active", true).
	OrderBy("created_at").
	Build()

// Still a violation — these are three different objects you don't own
code := order.Customer().Address().Country().Code() // ask order.ShippingCountryCode() instead
```

### DTOs and wire/serialization structs — exempt from rules 3, 8, 9

A struct that exists only to (de)serialize JSON, protobuf, SQL rows, or config is
*data in transit*, not a domain model. It should be a flat bag of exported primitive
fields with struct tags. Wrapping primitives (rule 3), splitting it for cohesion
(rule 8), or hiding fields behind behavior methods (rule 9) all fight the
serializer.

```go
// Correct — a DTO is meant to be a flat, exported, primitive-typed bag.
type CreateUserRequest struct {
	Email    string `json:"email"`
	FullName string `json:"full_name"`
	AgeYears int    `json:"age_years"`
	IsActive bool   `json:"is_active"`
}
```

Map the DTO to a rich domain type *at the boundary* (`NewUser(req.Email)`), and let
the calisthenics rules apply to the domain type, not the DTO.

### Performance hot paths — exempt from wrapping primitives/collections (rules 3, 4)

In a measured hot path, wrapping primitives or collections adds allocation,
indirection, and lost cache locality. When a benchmark says the wrapper costs you,
use the raw primitive or slice. Optimize the proven hot path; keep the rich model
everywhere else. See `samber/cc-skills-golang@golang-performance` for when and how to
make that call (and to confirm it with benchmarks first).

### Idiomatic short names beat "don't abbreviate" (rule 6)

Go deliberately uses short names proportional to scope. Loop indexes (`i`), `ctx`,
request/response (`r`, `w`), `err`, and single-letter receivers are standard and
read *better* than spelled-out alternatives — `for index := range items` is noise.
Rule 6 only forbids *cryptic, inconsistent* abbreviations (`usrRpstry`, `calcTotAmt`).
`samber/cc-skills-golang@golang-naming` is the authority on which short names are
acceptable; defer to it whenever rule 6 and idiomatic naming seem to conflict.
