---
name: golang-large-scale
description: "Cross-cutting production Go reference — architecture, project layout, graceful shutdown, gRPC, Kafka/RabbitMQ, Redis cache patterns, database/sql, security, pprof profiling, OTel observability, and module/monorepo concerns. Use when the question spans multiple Go subsystems, involves large-scale system design, or no single specific skill covers the topic. Prefer the specific golang-* skills (golang-concurrency, golang-testing, golang-error-handling, etc.) for focused questions on those topics."
---

# Go at Scale

## Philosophy

**Clear is better than clever.** Prefer obvious code over abstraction. The standard library is the style guide — when in doubt, mirror `net/http`, `database/sql`, `io`, `context`.

**Errors are values, not exceptions.** Every `error` is a control-flow signal. Treat the unhappy path with the same care as the happy path. No `panic` outside `main.main` startup and truly unrecoverable invariants.

**Concurrency is a feature, not a default.** A goroutine without a known lifetime is a leak. Every `go f()` must answer: who cancels it, who waits for it, where does its error go?

**Composition over inheritance.** Small interfaces, defined at the consumer. Accept interfaces, return concrete types. Embed for behavior reuse, never for "is-a" hierarchies.

---

## Project Layout

Follow the de-facto standard (see `golang-standards/project-layout`, but do not cargo-cult — only add directories you need):

```
.
├── cmd/<binary>/main.go     # entry points only — no business logic
├── internal/                # private packages (compiler-enforced)
│   ├── <domain>/            # split by domain, not by layer (no /controllers /services /models)
│   └── platform/            # cross-cutting infra (db, http, telemetry)
├── pkg/                     # ONLY if you intend external import; otherwise omit
├── api/                     # OpenAPI / protobuf definitions
├── go.mod
└── go.work                  # multi-module monorepo only
```

**Anti-patterns**:
- `pkg/` containing everything (use `internal/`)
- Layered packages (`controllers/`, `services/`, `repositories/`) — leads to circular dependencies and anemic domain. Organize by feature/domain.
- A `util/` or `common/` package — almost always a sign of misplaced abstraction. Move helpers next to their sole consumer until a second caller appears.
- `init()` with side effects (db connections, network calls). Wire dependencies explicitly in `main`.

---

## Error Handling Patterns

Errors are values. The unhappy path deserves the same care as the happy one. A returned `error` is a control-flow signal; design it for the caller, not the producer.

### The Three Shapes of Error

```go
// 1. SENTINEL — known condition, comparable by identity
var ErrNotFound = errors.New("not found")

// 2. TYPED — caller needs to inspect fields
type ValidationError struct {
    Field  string
    Reason string
}
func (e *ValidationError) Error() string { return e.Field + ": " + e.Reason }

// 3. OPAQUE — wrapping for context; caller doesn't branch on the underlying type
return fmt.Errorf("save user %s: %w", id, err)
```

Pick the **least powerful** shape that meets the caller's needs:
- Caller checks "did this specific thing happen?" → sentinel.
- Caller needs structured details (field name, retry-after, HTTP status) → typed.
- Caller only logs / propagates → opaque wrap.

Over-typing is as costly as under-typing — every typed error becomes a public API contract.

### Wrap with %w, Add Context

```go
// WRONG — context-free, untraceable from a log line
return err

// WRONG — context, but kills the chain
return fmt.Errorf("save user %s: %v", id, err)

// RIGHT
return fmt.Errorf("save user %s: %w", id, err)
```

- Every wrap names the **operation** + a **key identifier**.
- `"save: %w"` is useless. `"save user u_123: %w"` is debuggable.
- Use `%v` only when intentionally hiding the chain (e.g., sanitizing internal errors at an API boundary).
- Lowercase, no trailing punctuation, no "failed to" prefix — wraps compose into readable chains:
  ```
  user signup: save user u_123: insert into users: conn refused
  ```

### Inspect with errors.Is / errors.As

```go
if errors.Is(err, ErrNotFound) {
    // sentinel anywhere in the chain
}

var verr *ValidationError
if errors.As(err, &verr) {
    return badRequest(w, verr.Field, verr.Reason)
}
```

Rules:
- **Never** `err.Error() == "not found"` string comparisons. Brittle, breaks on wrap.
- `errors.Is` for sentinels and equality-checkable errors.
- `errors.As` for typed errors — note: pointer to a pointer is normal; `*ValidationError` is the pointer type to extract.
- Implementing `Is(error) bool` / `As(any) bool` on a custom type lets you match against synthetic targets (rare; needed for net errors, OS errors).

### Multi-Error: errors.Join

Combine independent failures (Go 1.20+):

```go
var errs []error
for _, v := range items {
    if err := validate(v); err != nil {
        errs = append(errs, fmt.Errorf("item %s: %w", v.ID, err))
    }
}
if err := errors.Join(errs...); err != nil { return err }
```

`errors.Is` / `errors.As` traverse joined errors. Useful for batch validation, parallel fan-out summaries. Don't use it to "report everything that went wrong" if the caller can only act on the first — return early instead.

### Don't Log and Return

```go
// WRONG — same error reported twice (or more, up the stack)
if err != nil {
    log.Error("save failed", "error", err)
    return err
}
```

Pick one:
- **Return** at every layer; wrap with context as it travels up.
- **Log** exactly once, at the top (handler, job runner, top of a goroutine).

A duplicated error log makes investigation harder — you read the same line at 6 different timestamps with 6 different wrapping prefixes. Pick the top of the stack as the single source of truth.

Exception: log + return is acceptable when the layers cross process/goroutine boundaries and the log carries context the caller can't reconstruct. Document why.

### Don't Discard

```go
_ = file.Close()                // bad if Close can fail meaningfully
```

`Close` on a `*os.File` opened for writing can fail (flush). On a `Body`, drain + close to allow connection reuse:

```go
defer func() {
    _, _ = io.Copy(io.Discard, resp.Body)   // drain
    _ = resp.Body.Close()
}()
```

`errcheck` lint enforces this. If you really don't care, comment why: `//nolint:errcheck // best effort cleanup`.

### Errors in defer

```go
func write(name string, data []byte) (err error) {
    f, err := os.Create(name)
    if err != nil { return err }
    defer func() {
        if cerr := f.Close(); cerr != nil && err == nil {
            err = fmt.Errorf("close %s: %w", name, cerr)
        }
    }()
    if _, err = f.Write(data); err != nil {
        return fmt.Errorf("write %s: %w", name, err)
    }
    return nil
}
```

Named return value + defer-assigning-to-err is the standard idiom. Don't shadow `err` in the defer.

### Panic vs Error

| Panic                                                | Error                                |
|------------------------------------------------------|--------------------------------------|
| Programmer bug (nil map write, impossible state)     | Anything a caller might handle       |
| Startup invariants (missing required config in main) | All runtime conditions               |
| Truly unrecoverable (binary corrupt, OOM)            | I/O, network, validation, not-found  |

Recover **only** at goroutine entry points and server middleware — a single bad request shouldn't crash the process:

```go
func recoverMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if rec := recover(); rec != nil {
                stack := debug.Stack()
                slog.ErrorContext(r.Context(), "panic recovered",
                    "panic", rec, "stack", string(stack))
                http.Error(w, "internal", http.StatusInternalServerError)
            }
        }()
        next.ServeHTTP(w, r)
    })
}
```

Same pattern for every long-running goroutine spawned at startup. Bare `go f()` with a panic-inducing bug kills the process.

### Transient vs Permanent: Retry Classification

Some errors are worth retrying; most aren't. Classify at the boundary that knows:

```go
type RetryableError struct{ Err error }
func (e *RetryableError) Error() string { return e.Err.Error() }
func (e *RetryableError) Unwrap() error { return e.Err }

func isRetryable(err error) bool {
    var re *RetryableError
    if errors.As(err, &re) { return true }
    if errors.Is(err, context.DeadlineExceeded) { return false } // caller chose budget
    if errors.Is(err, context.Canceled)         { return false }
    return false
}
```

For HTTP: `5xx` (server) + `429` (rate limit, honor `Retry-After`) + connection errors are retryable. `4xx` is not.
For DB: serialization failure (`40001`), deadlock (`40P01`), connection error — retryable. Constraint violation — not.

Retry with backoff (`cenkalti/backoff/v4` or write a small jittered exponential loop). **Always** bound retries by `ctx` deadline and a max attempt count.

### Don't Translate at Every Layer

```go
// WRONG — opaque translation loses information
if errors.Is(err, sql.ErrNoRows) {
    return ErrUserNotFound
}

// RIGHT — translate at domain boundaries, wrap elsewhere
// in postgres.UserRepo.Get:
if errors.Is(err, sql.ErrNoRows) {
    return nil, app.ErrUserNotFound   // domain sentinel
}
return nil, fmt.Errorf("query: %w", err)
```

Adapter packages translate driver-specific errors into domain errors **once**. Inner code wraps; outer code translates.

### HTTP / RPC Error Mapping

Map domain errors to transport errors **at the boundary**:

```go
func writeError(w http.ResponseWriter, r *http.Request, err error) {
    log := slog.With("path", r.URL.Path, "method", r.Method)

    switch {
    case errors.Is(err, app.ErrNotFound):
        http.Error(w, "not found", http.StatusNotFound)
    case errors.As(err, new(*app.ValidationError)):
        var v *app.ValidationError
        errors.As(err, &v)
        writeJSON(w, http.StatusBadRequest, errResp{Field: v.Field, Reason: v.Reason})
    case errors.Is(err, context.Canceled):
        // client gone; no response needed
    case errors.Is(err, context.DeadlineExceeded):
        http.Error(w, "timeout", http.StatusGatewayTimeout)
    default:
        log.ErrorContext(r.Context(), "unhandled", "error", err)
        http.Error(w, "internal", http.StatusInternalServerError)
    }
}
```

Rules:
- Only the boundary maps to HTTP status / gRPC code.
- Never leak internal error strings to clients (PII, stack info, schema names). Public message generic; internal log detailed.
- gRPC: use `status.Error(codes.X, msg)`; map sentinels to canonical codes.

### Error Context as Structured Data

A typed error can carry structured attributes for logging:

```go
type DBError struct {
    Op    string
    Query string
    Err   error
}
func (e *DBError) Error() string { return e.Op + ": " + e.Err.Error() }
func (e *DBError) Unwrap() error { return e.Err }
func (e *DBError) LogValue() slog.Value {                  // slog.LogValuer
    return slog.GroupValue(
        slog.String("op", e.Op),
        slog.String("query", e.Query),
        slog.String("cause", e.Err.Error()),
    )
}
```

When logged via `slog.Any("error", err)`, the structured form is emitted automatically. Cleaner than re-extracting fields at the log site.

### Stack Traces

Stdlib `errors` does not capture stacks. Three options:
- **`fmt.Errorf` wrap chains** with operation + identifier — usually enough.
- **`pkg/errors`** (deprecated but stable) — `errors.WithStack(err)`.
- **`cockroachdb/errors`** — modern, integrates with stdlib `errors.Is`/`As`, captures stacks, supports network-safe redaction.

Add stack capture **at error origin** (the leaf), not at every wrap. Otherwise you get a forest of stacks.

For panics, `debug.Stack()` in the recover middleware is enough.

### Sentinel Naming and Placement

- `var ErrXxx = errors.New("xxx")` — package-level.
- Define in the package whose API returns it. `app.ErrNotFound` lives in `app`, not `postgres`.
- Name `Err<Condition>`: `ErrNotFound`, `ErrAlreadyExists`, `ErrConflict`.
- One word per condition. Don't `ErrUserNotFound`, `ErrOrderNotFound`, `ErrAccountNotFound` — one `ErrNotFound`, callers know the subject from context.

### When to Return error vs (T, error) vs Just Action

- Returns a value that may be invalid → `(T, error)`. Caller must check err before using T.
- Action with no value → `error`.
- Action that genuinely can't fail (after type-system / invariant guarantees) → no return. Don't invent error returns "in case it ever fails."

### Anti-Patterns

- `if err != nil { return err }` chains without wrapping — error reads "not found" at the top with no operation context. Wrap.
- `panic` for runtime conditions a caller could handle.
- `recover` outside goroutine boundaries / middleware. Catches bugs you wanted to find.
- One-of God error type with discriminator string (`Error{Type: "not_found"}`). Use sentinels + types.
- Error messages capitalized / ending in punctuation. Composes badly: `"Database error.: connection refused."`.
- Errors as exceptions — long-distance non-local jumps via `panic`+`recover` for control flow.
- Translating every error to a top-level enum at every layer (loses information). Translate at boundaries.
- Comparing errors by `.Error() == "..."`.
- `if err.Error() != ""` to test for an error — use `err != nil`.
- Throwing away wrapping by re-creating the error: `return errors.New(err.Error())` — both opaque and stack-free.

### Workflow: Designing an Error for a New Function

1. What does the caller need to do with this error? (Branch? Log? Propagate?)
2. Cheapest shape that supports that — opaque > sentinel > typed.
3. Name the operation + an identifier in the wrap message.
4. Define sentinels in the consumer's package, not the producer's.
5. Map to transport (HTTP / gRPC) only at the outermost boundary.
6. Log at the boundary, once.
7. Cover the error path with a test (`errors.Is(got, want)` assertion).

### Error Handling Checklist

```
[ ] Every error wrapped with %w + operation + key identifier (no bare return err)
[ ] errors.Is / errors.As used; no .Error() string comparisons
[ ] Sentinels defined in the consumer package (domain), not the adapter
[ ] No log-and-return — log once at the boundary
[ ] errcheck clean; explicit comments on intentional _ = err
[ ] Named return + defer-assign for resource cleanup errors
[ ] panic only for programmer bugs; recover only at goroutine + middleware boundaries
[ ] Retry classification explicit (transient vs permanent), bounded by ctx + max attempts
[ ] Transport mapping (HTTP / gRPC) only at the outermost layer
[ ] Public error messages generic; internal logs detailed (no PII / internal schema leakage)
[ ] errorlint enabled in golangci-lint (catches non-%w wraps, errors.Is misuse)
[ ] Tests assert on errors.Is / errors.As — not message contents
```

---

## Context

`context.Context` is a contract about cancellation and deadlines — not a bag of values.

- First parameter, always named `ctx`. Never store in a struct.
- Pass `ctx` to every blocking call: I/O, RPC, DB, channel ops with `select`.
- `context.WithTimeout` / `WithCancel` — **always `defer cancel()`** even on the timeout path (releases resources immediately).
- `context.Value` only for request-scoped values that cross API boundaries (request ID, auth subject, trace span). Never for optional function arguments. Use typed keys, never raw strings.
- `context.Background()` only at process entry (`main`, top-level tests, long-running workers). `context.TODO()` is a `// FIXME` you can grep for.

```go
ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
defer cancel()
resp, err := client.Do(req.WithContext(ctx))
```

---

## Context Cancellation Patterns

Cancellation is cooperative — `ctx.Done()` is a signal, not a kill. Code must check it. A goroutine that ignores `ctx` is unkillable.

### The Four Sources of Cancellation

1. **Caller cancel** — `ctx, cancel := context.WithCancel(parent); cancel()`
2. **Deadline / timeout** — `WithDeadline`, `WithTimeout`
3. **Parent cancel** — propagates down the tree automatically
4. **Cause** (Go 1.20+) — `WithCancelCause(parent)` lets you attach an error: `cancel(errBudgetExceeded)`; retrieve with `context.Cause(ctx)`

```go
ctx, cancel := context.WithCancelCause(parent)
go func() {
    if budgetExceeded() { cancel(errBudgetExceeded) }
}()
// downstream:
if err := ctx.Err(); err != nil {
    return fmt.Errorf("aborted: %w", context.Cause(ctx))
}
```

### Pattern 1: Always defer cancel

```go
ctx, cancel := context.WithTimeout(parent, 5*time.Second)
defer cancel()   // even on success — releases the timer immediately
```

`go vet` flags missing `cancel()`. Don't silence it.

### Pattern 2: Select with ctx.Done in Loops

```go
for {
    select {
    case <-ctx.Done():
        return ctx.Err()
    case item := <-work:
        if err := process(ctx, item); err != nil { return err }
    }
}
```

**Every** `for { select { } }` loop must have a `<-ctx.Done()` arm. Otherwise the goroutine is unkillable.

### Pattern 3: Cancel-on-First-Error (errgroup)

```go
g, ctx := errgroup.WithContext(ctx)   // ctx cancels when any goroutine returns error
for _, u := range urls {
    u := u
    g.Go(func() error {
        return fetch(ctx, u)           // siblings see ctx canceled, abort early
    })
}
return g.Wait()
```

Use when sibling work becomes pointless once one fails (parallel fetch, fan-out validation).

Bound parallelism: `g.SetLimit(8)` (Go 1.20+).

### Pattern 4: Detach for Background Cleanup

A handler completes; you want to fire-and-forget a metric flush or audit log. Request `ctx` will cancel — you don't want that.

```go
// WRONG: cleanup gets canceled when handler returns
go cleanup(ctx)

// RIGHT: detached context with its own bounded deadline
go func() {
    bg, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
    defer cancel()
    cleanup(bg)
}()
```

`context.WithoutCancel` (Go 1.21+) preserves values (request ID, trace span) but drops the cancellation chain. Pre-1.21: copy values manually or use a fresh `context.Background()` and re-attach what you need.

### Pattern 5: Convert ctx to Channel Close

When integrating with an API that takes a `<-chan struct{}` (or `done` channel) instead of `ctx`:

```go
done := make(chan struct{})
go func() {
    <-ctx.Done()
    close(done)
}()
oldAPI(done)
```

Reverse direction (channel → ctx):

```go
ctx, cancel := context.WithCancel(parent)
go func() { <-ch; cancel() }()
```

### Pattern 6: Distinguishing Cancel from Deadline

```go
err := op(ctx)
switch {
case errors.Is(err, context.Canceled):
    // caller bailed — return without logging at error level
case errors.Is(err, context.DeadlineExceeded):
    // budget exhausted — log + metric, may want different fallback
}
```

Don't treat both identically. Cancel = expected, not an error to alert on. Deadline = SLO signal.

### Pattern 7: Don't Reset the Deadline

A child context can only **shorten** the parent's deadline, never extend it. If you need a longer budget for a sub-task (e.g., background flush), detach with `context.WithoutCancel` and start a fresh deadline.

### Pattern 8: Server Request Cancellation

`http.Request.Context()` is canceled when the client disconnects. Propagate it to all downstream calls — abort wasted work:

```go
func handler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    result, err := svc.Do(ctx, ...)        // db, RPC, etc. all see cancel
    if err != nil {
        if errors.Is(err, context.Canceled) {
            return     // client gone — don't waste bytes on a response
        }
        http.Error(w, "internal", 500); return
    }
    _ = json.NewEncoder(w).Encode(result)
}
```

### Pattern 9: Worker Lifecycle

```go
type Worker struct {
    ctx    context.Context
    cancel context.CancelFunc
    done   chan struct{}
}

func NewWorker(parent context.Context) *Worker {
    ctx, cancel := context.WithCancel(parent)
    w := &Worker{ctx: ctx, cancel: cancel, done: make(chan struct{})}
    go w.run()
    return w
}

func (w *Worker) run() {
    defer close(w.done)
    for {
        select {
        case <-w.ctx.Done(): return
        case job := <-jobs:  process(w.ctx, job)
        }
    }
}

func (w *Worker) Shutdown(ctx context.Context) error {
    w.cancel()
    select {
    case <-w.done:       return nil
    case <-ctx.Done():   return ctx.Err()   // shutdown deadline exceeded
    }
}
```

`Shutdown` takes its own ctx — the caller chooses how long to wait for a clean stop before giving up.

### Anti-Patterns

- **Ignoring `ctx.Err()` after a blocking call.** `db.Query(ctx, ...)` may return non-nil err just because ctx canceled; surface that, don't translate to "db error".
- **Storing `ctx` in a struct.** Except for explicit long-running types (Worker above) where you own its lifetime. Never on shared singletons (Server, Repo) — leads to using a stale, canceled ctx.
- **Passing `nil` ctx.** Use `context.TODO()` if you genuinely don't have one yet; `nil` panics on `.Done()`.
- **Using `ctx.Value` for cancellation-adjacent state** (e.g., "isAdmin"). Cancellation API is for cancellation. Pass auth as a typed arg or attach to a request-scoped struct.
- **Long sleeps without cancel awareness.** Replace `time.Sleep(d)` with:

  ```go
  select {
  case <-time.After(d):
  case <-ctx.Done(): return ctx.Err()
  }
  ```

  Note: `time.After` leaks until it fires. For long sleeps in a hot path, use `time.NewTimer` + `Stop` on cancel.

### Cancellation Checklist

```
[ ] Every WithTimeout / WithCancel / WithDeadline has a deferred cancel()
[ ] Every for-select loop has a <-ctx.Done() arm
[ ] context.Canceled and context.DeadlineExceeded handled distinctly where it matters
[ ] Background fire-and-forget uses context.WithoutCancel + fresh deadline
[ ] http.Request.Context() propagated to all downstream calls
[ ] Workers expose Shutdown(ctx) that respects caller's drain budget
[ ] No time.Sleep in a path that should be cancelable
[ ] ctx not stored in shared/long-lived structs (worker types excepted)
```

---

## Concurrency Patterns

**Default: don't.** Reach for goroutines only when there's a measured reason — latency-hiding I/O, fan-out across independent work, background workers, event loops. Most code is faster, simpler, and bug-free as sequential.

### The Three Questions for Every `go`

Every `go f()` must answer:
1. **Lifetime** — who joins it? (`WaitGroup`, `errgroup.Wait`, channel close, `ctx` cancel)
2. **Cancellation** — does it respect `ctx`? (every blocking op + every loop has a `<-ctx.Done()` arm)
3. **Errors** — where does its `error` go? (errgroup, error channel, log-and-drop with reason)

If you can't answer all three, don't start the goroutine. An untracked goroutine is a leak.

### Sync Primitives: When to Use What

| Need                                  | Use                                  |
|---------------------------------------|--------------------------------------|
| Protect shared state, short critical section | `sync.Mutex` — default            |
| Many readers, few writers, profiled hot lock | `sync.RWMutex` — only after profile |
| Counter, flag, single pointer swap    | `sync/atomic` (`atomic.Int64`, `atomic.Bool`, `atomic.Pointer[T]`) |
| Wait for N goroutines                 | `sync.WaitGroup` (or errgroup)       |
| Run-once initialization               | `sync.Once`                          |
| Broadcast wakeup to many waiters      | Close a channel (preferred) or `sync.Cond` |
| Object reuse to reduce allocations    | `sync.Pool`                          |
| Bounded parallelism                   | `errgroup.SetLimit` or semaphore (`chan struct{}`) |
| Deduplicate concurrent identical work | `singleflight.Group`                 |
| Rate limit a producer                 | `golang.org/x/time/rate.Limiter`     |

**Mutex first, channels for signaling.** "Share memory by communicating" is half the advice — the other half is "communicate by sharing memory when ownership is shared." Use mutex for state, channels for ownership transfer / events.

### Channel Idioms

```go
// CLOSE to broadcast — every receiver unblocks; the channel returns zero, ok=false
done := make(chan struct{})
go func() {
    // ... when ready:
    close(done)
}()
<-done                        // any number of waiters can <-done; all wake

// NIL channel disables a select arm — useful for one-shot signals
var stop chan struct{}        // nil
select {
case <-work:
case <-stop:                  // never fires while stop is nil
}

// BUFFERED for handoff (signal-and-go), UNBUFFERED for synchronous handoff
sig := make(chan struct{}, 1) // doesn't block sender if receiver hasn't arrived

// SEND on a closed channel panics; CLOSE on a closed channel panics
// Convention: the sender owns close, never the receiver.

// Drain a channel after producer stops
for v := range ch { ... }     // exits when ch is closed
```

Rules:
- The **sender** closes. Multiple senders → no one closes; use a context cancel or a `sync.Once` guard.
- `len(ch)` and `cap(ch)` are debugging hints, never branch logic — racy.
- Don't use channels as queues you peek into. Buffered chan + select is fine; channel-as-data-structure is not.

### Fan-Out: errgroup

```go
g, ctx := errgroup.WithContext(ctx)
g.SetLimit(8)                                  // bound parallelism

for _, id := range ids {
    id := id                                   // pre-Go 1.22 only
    g.Go(func() error {
        return fetch(ctx, id)                  // ctx canceled if any sibling errors
    })
}
return g.Wait()
```

- `errgroup.WithContext` cancels `ctx` on the first error or `Wait` return. Siblings see cancel and abort.
- `SetLimit(n)` (Go 1.20+) caps concurrent goroutines without manual semaphores.
- Don't share state across goroutines without sync. Each closure writes to its **own** result slot (`results[i]`) — no mutex needed if indices don't collide.

### Fan-In: Merge Multiple Channels

```go
func merge[T any](ctx context.Context, cs ...<-chan T) <-chan T {
    out := make(chan T)
    var wg sync.WaitGroup
    wg.Add(len(cs))
    for _, c := range cs {
        c := c
        go func() {
            defer wg.Done()
            for v := range c {
                select {
                case out <- v:
                case <-ctx.Done(): return
                }
            }
        }()
    }
    go func() { wg.Wait(); close(out) }()
    return out
}
```

Producer (each `c`) closes its source. Fan-in goroutines exit on source close or `ctx`. The merge goroutine waits, then closes `out`.

### Pipeline: Staged Processing

```go
func stage1(ctx context.Context, in <-chan A) <-chan B {
    out := make(chan B)
    go func() {
        defer close(out)
        for v := range in {
            b := transform(v)
            select {
            case out <- b:
            case <-ctx.Done(): return
            }
        }
    }()
    return out
}

// usage
out := stage3(ctx, stage2(ctx, stage1(ctx, source)))
```

- Each stage owns its output channel and closes it on exit.
- Every send selects on `ctx.Done()` to allow cancellation mid-stage.
- Backpressure is automatic: a slow downstream blocks upstream sends.

### Worker Pool

```go
func runPool[T, U any](ctx context.Context, n int, in <-chan T, work func(context.Context, T) (U, error)) <-chan result[U] {
    out := make(chan result[U])
    var wg sync.WaitGroup
    wg.Add(n)
    for i := 0; i < n; i++ {
        go func() {
            defer wg.Done()
            for v := range in {
                u, err := work(ctx, v)
                select {
                case out <- result[U]{u, err}:
                case <-ctx.Done(): return
                }
            }
        }()
    }
    go func() { wg.Wait(); close(out) }()
    return out
}
type result[U any] struct { V U; Err error }
```

Use when work is plentiful and you want a fixed concurrency cap. For one-shot fan-out with known IDs, `errgroup.SetLimit` is simpler.

### Bounded Parallelism via Semaphore

When you can't use errgroup (e.g., goroutines launched at different times from different callers):

```go
sem := make(chan struct{}, 10)        // 10 in flight max

func do(ctx context.Context, x X) error {
    select {
    case sem <- struct{}{}:
    case <-ctx.Done(): return ctx.Err()
    }
    defer func() { <-sem }()
    // ... real work ...
    return nil
}
```

Or `golang.org/x/sync/semaphore` for weighted semaphores (work has different sizes).

### singleflight: Dedupe Concurrent Identical Work

```go
import "golang.org/x/sync/singleflight"

var sf singleflight.Group

func (s *Service) GetUser(ctx context.Context, id string) (*User, error) {
    v, err, _ := sf.Do("user:"+id, func() (any, error) {
        return s.repo.Get(ctx, id)
    })
    if err != nil { return nil, err }
    return v.(*User), nil
}
```

Use for read-through caches, expensive deterministic lookups, thundering-herd protection. **All callers share the same `error`** — a cancellation in one caller's `ctx` doesn't cancel the in-flight call others are waiting on. If that matters, use `DoChan` and `select` on `ctx.Done()` per caller:

```go
ch := sf.DoChan(key, work)
select {
case res := <-ch: ...
case <-ctx.Done():
    sf.Forget(key)                    // optional: don't poison subsequent calls
    return ctx.Err()
}
```

### Rate Limiting

```go
import "golang.org/x/time/rate"

lim := rate.NewLimiter(rate.Limit(100), 20)   // 100/s sustained, burst 20

if err := lim.Wait(ctx); err != nil { return err }
// ... do the rate-limited thing ...
```

- `Wait(ctx)` blocks until a token is available or ctx is canceled.
- `Allow()` non-blocking; returns false if no token.
- `Reserve()` gives a reservation you can cancel.
- One limiter per resource. For per-user limits, a map of limiters with a sweep (LRU or TTL) to evict idle.

### Atomic Pointer Swap (Lock-Free Snapshots)

Read-mostly state (config, routing table) that updates rarely:

```go
type RoutingTable struct{ /* ... */ }

var current atomic.Pointer[RoutingTable]

// reader (hot path) — no lock
rt := current.Load()
rt.Lookup(...)

// writer (cold path)
new := build()
current.Store(new)
```

Writers must build a **new** value; never mutate the loaded one. Old readers continue using their snapshot — GC reclaims it once they're done.

### sync.Once

```go
var (
    once  sync.Once
    res   *Resource
    initErr error
)

func get() (*Resource, error) {
    once.Do(func() { res, initErr = expensiveInit() })
    return res, initErr
}
```

For lazy initialization at first use. Prefer eager init in `main` (explicit, fails fast) — `sync.Once` is fine for unavoidable lazy cases.

Go 1.21+: `sync.OnceFunc`, `sync.OnceValue[T]`, `sync.OnceValues[T, U]` — cleaner ergonomics.

### sync.Pool

```go
var bufPool = sync.Pool{
    New: func() any { return new(bytes.Buffer) },
}

func handle(w io.Writer, r io.Reader) error {
    buf := bufPool.Get().(*bytes.Buffer)
    buf.Reset()
    defer bufPool.Put(buf)

    if _, err := io.Copy(buf, r); err != nil { return err }
    _, err := buf.WriteTo(w)
    return err
}
```

- For high-churn allocations on hot paths only. Profile first.
- **Reset state on Get** — pool items are not zeroed.
- Pool may drop items at any GC. Never use for state that must persist.
- Don't pool things with finalizers, file descriptors, or anything where leaks matter.

### Broadcast: Close-to-Wake vs sync.Cond

```go
// Close-to-wake — N receivers all unblock when channel closes. Idiomatic for one-shot.
done := make(chan struct{})
// many goroutines: <-done
close(done)                             // wakes them all

// sync.Cond — repeated wakeups, condition variable
var (
    mu sync.Mutex
    c  = sync.NewCond(&mu)
)
// waiter
mu.Lock()
for !ready { c.Wait() }
mu.Unlock()
// signaler
mu.Lock()
ready = true
c.Broadcast()
mu.Unlock()
```

Prefer channel close for one-shot. `Cond` only for repeated wakeup of waiters with a shared condition — rare in Go; usually a buffered channel + select is clearer.

### Select Quirks

```go
// Default arm = non-blocking. Don't use for "I'll try again later" without a timer.
select {
case work <- v:
default:                            // drops! Make sure that's intended.
}

// Multiple ready arms — Go picks one at random. Don't rely on order.

// Empty select blocks forever. Use as a debug "park goroutine" or in main if you intend to.
select {}

// A nil channel arm never fires — useful for dynamically disabling cases.
var tick <-chan time.Time           // nil; arm disabled
if shouldTick { tick = time.Tick(d) }
select {
case <-tick: ...
case <-ctx.Done(): return
}
```

### Race Detector

`go test -race -count=1 ./...` — **non-optional in CI** for any code with goroutines.

- 5-10× CPU, 5-10× memory. Acceptable for tests; usually too costly for prod.
- Catches read/write races, not deadlocks or leaks.
- A failure points at one read and one write — if shown in your output, fix the synchronization, never silence.
- For prod soak: `-race` builds are valid binaries; some teams run a small `-race` canary in staging.

### Goroutine Leak Detection

In tests:

```go
import "go.uber.org/goleak"

func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}
```

Fails the suite if extra goroutines exist after tests complete. Catches "goroutine started, never joined."

In prod: `runtime.NumGoroutine()` as a gauge metric. Monotonic growth = leak. Pair with `goroutine?debug=2` pprof dump for diagnosis (see pprof section).

### Common Bugs

- **Loop var capture (pre-Go 1.22)** — `for _, x := range xs { go func() { use(x) }() }` captures the same `x`. Shadow with `x := x`. Go 1.22+ scopes per-iteration; still worth shadowing explicitly when the func is detached and outlives the loop.
- **`time.After` in a hot select loop** — leaks one timer per iteration until it fires. Use `time.NewTimer` + `Reset` + `Stop` on cancel.
- **Goroutine writes to test state after test ends** — `goleak` catches it; `t.Cleanup(close(done))` + `wg.Wait()` prevents it.
- **Closing a channel from multiple senders** — panics. Wrap with `sync.Once`, or use a context cancel for shutdown signal.
- **Send on a closed channel** — panics. Refactor: receivers handle close; senders coordinate via a separate done channel.
- **RWMutex starvation** — under high read load, writers can starve. Profile before assuming RW is faster.
- **Lock ordering deadlock** — multiple mutexes acquired in different orders. Define a global order and document it; prefer a single coarser lock.
- **Forgotten `cancel()`** — `context.WithCancel/Timeout` without `defer cancel()` leaks the timer or never frees children. `go vet` catches the common case.

### Goroutine Lifecycle Discipline

For a long-lived component (Worker, Server, Manager):

```go
type Manager struct {
    ctx    context.Context
    cancel context.CancelFunc
    g      *errgroup.Group
    done   chan struct{}
}

func New(parent context.Context) *Manager {
    ctx, cancel := context.WithCancel(parent)
    g, ctx := errgroup.WithContext(ctx)
    return &Manager{ctx: ctx, cancel: cancel, g: g, done: make(chan struct{})}
}

func (m *Manager) Start() {
    m.g.Go(m.runLoop)
    m.g.Go(m.runReaper)
    go func() {
        _ = m.g.Wait()
        close(m.done)
    }()
}

func (m *Manager) Stop(ctx context.Context) error {
    m.cancel()
    select {
    case <-m.done:    return nil
    case <-ctx.Done(): return ctx.Err()      // shutdown budget exceeded
    }
}
```

- One owning ctx per component.
- `Stop(ctx)` takes its own deadline from the caller — the caller decides how long to wait.
- All inner goroutines join into `m.g`; one `Wait` joins them all.

### Anti-Patterns

- Goroutines launched with no join, no done channel, no ctx awareness. Leaks waiting to happen.
- Unbounded `go f()` per request — OOMs under load. Always cap.
- `sync.Mutex` embedded in a public struct field — exposes locking to callers. Keep mutexes unexported; expose methods that lock internally.
- Copy of a struct containing a mutex — copies the lock state. `go vet` catches it. Use a pointer or move the mutex out.
- `select { case <-ctx.Done(): return ctx.Err() default: }` — busy-waits. Drop the default or sleep with a timer.
- Channel-of-channels for "wait for completion." Use `WaitGroup` or `done chan struct{}`.
- `sync.Map` for everything. It's optimized for two specific patterns (stable keys with mostly-reads, or keys that grow and never overlap). For everything else, `map + Mutex` is faster and clearer.
- Reading `len(ch)` to decide whether to send. Race; use `select` with `default`.
- `time.Sleep` as synchronization between goroutines. Always wrong. Use a channel, WaitGroup, or polling assertion.
- Spawning goroutines inside `init()` — runs at import time, no ctx, no shutdown hook, can't be tested cleanly.

### Concurrency Checklist

```
[ ] Every `go` has a known joiner, ctx awareness, and an error path
[ ] Bounded parallelism (errgroup.SetLimit, semaphore, or worker pool)
[ ] Mutex by default; channels for signaling and ownership transfer
[ ] Senders own channel close; never close from receiver side
[ ] Every for-select loop has a <-ctx.Done() arm
[ ] No time.After in hot select loops; use NewTimer + Stop
[ ] No time.Sleep used as a synchronization primitive
[ ] Long-lived components expose Start / Stop(ctx) with bounded drain
[ ] go test -race -count=1 ./... clean in CI
[ ] goleak (or equivalent) wired in TestMain
[ ] runtime.NumGoroutine() exported as a gauge in prod
[ ] sync.Pool items reset on Get; no resources / fds pooled
[ ] singleflight used for thundering-herd-prone read-through caches
[ ] Rate limiters per resource, with ctx-aware Wait
[ ] No goroutines spawned in init()
```

---

## Interfaces

**Define interfaces in the consumer package, not the producer.** A `UserStore` interface belongs next to the function that calls it, not next to the Postgres implementation.

- Small interfaces (1-3 methods). `io.Reader`, `io.Writer` are the gold standard.
- "Accept interfaces, return structs." Callers compose with whatever satisfies the contract; you return the maximum useful type.
- No `IFoo` / `FooImpl` naming. Interface is the noun (`Store`), implementation gets the qualifier (`PostgresStore`, `InMemoryStore`).
- Never expose an interface "just in case." Add it when a second implementation (often a test fake) exists.

---

## Generics

Available since Go 1.18. **Reach for them last, not first.** Most code is clearer with interfaces or concrete types. Generics shine in three places: container/algorithm libraries, type-safe utility wrappers, and eliminating `interface{}` + reflection.

```go
// GOOD — type-safe container, single implementation, many element types
type Set[T comparable] struct{ m map[T]struct{} }

func NewSet[T comparable]() *Set[T]          { return &Set[T]{m: map[T]struct{}{}} }
func (s *Set[T]) Add(v T)                    { s.m[v] = struct{}{} }
func (s *Set[T]) Has(v T) bool               { _, ok := s.m[v]; return ok }

// GOOD — algorithm that genuinely doesn't care about T
func Map[T, U any](in []T, f func(T) U) []U {
    out := make([]U, len(in))
    for i, v := range in { out[i] = f(v) }
    return out
}

// GOOD — replace reflect-based helper with a typed wrapper
func Must[T any](v T, err error) T {
    if err != nil { panic(err) }
    return v
}
```

### Constraints

Use the predeclared ones first: `any`, `comparable`. Reach into `golang.org/x/exp/constraints` (or define your own) for `Ordered`, `Integer`, `Signed`:

```go
type Number interface { ~int | ~int64 | ~float64 }

func Sum[T Number](xs []T) T {
    var s T
    for _, x := range xs { s += x }
    return s
}
```

The `~` (underlying type) lets `type Celsius float64` satisfy `Number`. Without `~`, only the exact type matches.

### Type Inference

Let the compiler infer when calling — don't write `Map[int, string](xs, f)` if `Map(xs, f)` compiles. Inference fails on return-only generics — that's a signal to redesign or accept the explicit annotation.

### When NOT to Use Generics

- **An interface already fits.** `io.Reader` doesn't need to be `Reader[T]`. Method dispatch on a small interface beats a type parameter.
- **Single concrete caller.** Write the concrete version. Add the parameter on the second caller, not in anticipation.
- **Performance.** Generics in Go use GCShape stenciling — boxing still occurs for pointer-shaped types. They are not a free `C++ template` speedup. Benchmark before claiming a win.
- **Method type parameters.** Not supported on methods (only on the receiver type). If you need it, redesign as a free function or push the parameter to the type.

### Anti-Patterns

- `func Foo[T any](x T) T` where `T` is unused beyond a single passthrough — delete the parameter, use `any` or the concrete type.
- A "generic repository" `Repo[T]` with `Save`, `Find`, `Delete`. Different entities have different queries, transactions, invariants. You end up casting back to concretes or adding parameters until the abstraction breaks. Write per-entity repos.
- Replacing every `interface{}` in legacy code with a type parameter. Only do it where it eliminates a real cast or reflection call.

### Generics Checklist

```
[ ] At least two real call sites with different types (not hypothetical)
[ ] Cannot be expressed as cleanly with an interface
[ ] Constraint is as narrow as possible (not `any` if `comparable` works)
[ ] Type inference works at call sites (no required explicit annotations)
[ ] No method-level type parameter assumption (only type-level)
[ ] If performance-motivated: benchmark vs interface version exists
```

---

## Dependency Injection

**Constructor injection. No globals. No service locators. No framework until you can prove the pain.**

Go's design favors explicit wiring in `main`. Most production services need nothing more. Reach for `wire` / `fx` only when manual wiring genuinely hurts — and that bar is higher than people think.

### Core Pattern

```go
type Service struct {
    repo   UserRepo            // small interface defined in THIS package
    clock  func() time.Time    // inject time — never call time.Now() directly
    log    *slog.Logger
}

func NewService(repo UserRepo, clock func() time.Time, log *slog.Logger) *Service {
    return &Service{repo: repo, clock: clock, log: log}
}
```

Rules:
- One constructor per type. Name it `New<Type>`.
- Dependencies are **fields**, not parameters re-passed to every method.
- All dependencies in the constructor signature — no later `SetX` mutation. The type is fully constructed and usable on return.
- Return concrete types (`*Service`), accept interfaces (`UserRepo`). See Interfaces section.

### Wire in main

```go
func main() {
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM)
    defer stop()

    cfg := mustLoadConfig()
    log := newLogger(cfg.Env)

    db, err := openDB(ctx, cfg.DBURL)
    if err != nil { log.Error("db open", "error", err); os.Exit(1) }
    defer db.Close()

    userRepo := postgres.NewUserRepo(db)
    mailer   := mail.NewSMTPClient(cfg.SMTP)
    clock    := time.Now

    svc := app.NewService(userRepo, clock, log.With("component", "user"))
    srv := http.NewServer(svc, log)

    runServer(ctx, srv, log)
}
```

Object graph is **linear and readable top-to-bottom**. A new contributor traces it without tooling.

### Inject Time, Randomness, IDs

Any nondeterministic source becomes a flaky test. Inject the source as a function:

```go
type Service struct {
    clock func() time.Time
    newID func() string
    rng   func() float64
}
```

In prod: `time.Now`, `uuid.NewString`, `rand.Float64`.
In tests: a fixed `clock`, a deterministic `newID` (counter), a seeded `rng`.

Don't inject a `Clock` interface with one method — a function value is enough and avoids ceremony.

### Functional Options (When Constructors Grow)

Constructor with 3+ optional/tunable params drifts toward unreadable. Use functional options for **optionals**, not for required deps:

```go
type ServiceOption func(*Service)

func WithRetries(n int) ServiceOption       { return func(s *Service) { s.retries = n } }
func WithTimeout(d time.Duration) ServiceOption { return func(s *Service) { s.timeout = d } }

func NewService(repo UserRepo, log *slog.Logger, opts ...ServiceOption) *Service {
    s := &Service{repo: repo, log: log, retries: 3, timeout: 5*time.Second}
    for _, o := range opts { o(s) }
    return s
}

// caller:
svc := NewService(repo, log, WithRetries(5))
```

Required deps stay positional. Optional/tunable deps become options with sensible defaults.

### Config Object Anti-Pattern

```go
// AVOID — opaque, allows partial construction, no compile-time check on required fields
type Config struct {
    Repo UserRepo
    Log  *slog.Logger
    // ...20 more fields
}
func NewService(c Config) *Service { ... }
```

Use only when:
- 8+ fields make a positional constructor unreadable.
- All fields conceptually belong together (settings loaded from env/file).

For service deps, prefer positional + functional options. A `Config` struct is for **values** (timeouts, addresses, feature flags), not for **collaborators**.

### Interface Where the Consumer Lives

The producer (`postgres.UserRepo`) does **not** define the interface. The consumer (`app.Service`) does:

```go
// package app
type UserRepo interface {
    Get(ctx context.Context, id string) (*User, error)
    Save(ctx context.Context, u *User) error
}

// package postgres
type UserRepo struct { db *sql.DB }            // concrete; no interface declared
func NewUserRepo(db *sql.DB) *UserRepo { ... } // returns concrete
func (r *UserRepo) Get(ctx context.Context, id string) (*User, error) { ... }
```

`*postgres.UserRepo` satisfies `app.UserRepo` structurally. The Postgres package has no idea who consumes it — and shouldn't.

### Layering and Cycles

DI naturally enforces a DAG:

```
main
 ├── http      (consumes app)
 ├── app       (defines interfaces; consumes nothing concrete)
 ├── postgres  (consumes db, implements app interfaces structurally)
 └── platform  (db, logger, telemetry — leaf)
```

If `app` imports `postgres`, you've broken the inversion. Check: every domain package depends only on **its own** interfaces and stdlib. Adapters (postgres, http, kafka) depend on domain, never the reverse.

### Testing

Constructors with explicit deps make tests trivial:

```go
func TestService_Create(t *testing.T) {
    repo := &fakeUserRepo{}                    // in-memory fake — not a mock
    clock := func() time.Time { return time.Unix(1700000000, 0) }
    svc := NewService(repo, clock, slog.Default())

    _, err := svc.Create(t.Context(), "alice")
    if err != nil { t.Fatal(err) }
    // assert on repo state
}
```

Fakes (real in-memory implementations) over mocks. See Testing section.

### When to Reach for a DI Framework

`google/wire` (compile-time codegen) or `uber-go/fx` (runtime container). Reasons to adopt:

1. The `main` function exceeds a few hundred lines of wiring across many binaries.
2. Multiple binaries share large overlapping object graphs (server + worker + cli in one repo).
3. Cycles in wiring are appearing — you need a tool to detect them.

Reasons to **stay** with manual wiring:

- Single binary, ≤ 50 components.
- New contributors can't trace flow.
- Test setup is becoming a parallel wiring system to the framework — that's a sign DI is over-engineered for the problem.

If choosing one:
- **`wire`** — generates plain Go in `wire_gen.go`. No runtime magic; errors at `go generate`. Preferred when manual wiring is the issue.
- **`fx`** — runtime container, lifecycle hooks, modules. Heavier; good for very large apps with hot-loaded modules. Beware reflection-based wiring obscuring the graph.

Never both. Never a third (no `dig`-only stack — `fx` wraps `dig`).

### Globals — When They're (Just Barely) OK

| Acceptable                              | Not acceptable                          |
|-----------------------------------------|-----------------------------------------|
| Sentinel errors (`var ErrNotFound = ...`) | Database handles                      |
| Compile-time constants                  | HTTP clients                            |
| `slog.Default()` as a fallback only     | Caches, registries, "managers"          |
| `prometheus.DefaultRegisterer`          | Loggers (inject)                        |

A global `var db *sql.DB` is a test-isolation defect waiting to happen. Inject.

### Lifecycle

Constructors do **construction**. Not network I/O, not goroutine starts, not background work.

```go
// BAD — constructor that blocks on the network
func NewClient(url string) *Client {
    conn := dial(url)                          // blocks; no ctx; no error
    return &Client{conn: conn}
}

// GOOD — construction is cheap; explicit Start / Connect with ctx
func NewClient(url string) *Client { return &Client{url: url} }
func (c *Client) Connect(ctx context.Context) error { ... }
```

For types that own goroutines:

```go
svc := NewWorker(deps)
if err := svc.Start(ctx); err != nil { ... }
// ... use ...
_ = svc.Stop(shutdownCtx)
```

`Start` / `Stop` are explicit, ctx-aware, mirror your shutdown sequence.

### Anti-Patterns

- **Service locator** — passing a `Container` / `Registry` everyone calls `Get[T]()` on. Hides the dependency graph; defeats the type system.
- **Field injection via reflection / tags** — Go isn't Spring. No.
- **Package-level `var x = NewX()`** — runs at import time, can't fail, can't be replaced in tests, ties initialization to import order.
- **`init()` doing wiring** — same problem, even worse: ordering is fragile across packages.
- **Singletons** — every "the one true X" hits a test isolation wall. Inject; let `main` enforce uniqueness.
- **Constructors that take a `*Service` to mutate** — return a fresh value, don't mutate inputs.
- **Optional deps as nilable pointers** with `if s.cache != nil { ... }` scattered everywhere. Use a no-op implementation (`noopCache{}`) by default; eliminates the nil check.
- **Re-wrapping a logger inside every constructor** (`log.With("component", "user")` in 30 places). Either do it once at wire time (in `main`) or accept a plain `*slog.Logger` and skip the prefix.

### DI Checklist

```
[ ] One constructor per type, all deps in the signature
[ ] Concrete return types, interfaces declared in consumer packages
[ ] No package-level state (except sentinels, constants, true singletons like metrics registries)
[ ] time.Now, rand, uuid injected as functions (or behind tiny interfaces)
[ ] Optional deps via functional options with no-op defaults; no nil checks at call sites
[ ] Constructors are pure — no I/O, no goroutines, no panics
[ ] Long-lived components expose Start(ctx) / Stop(ctx)
[ ] Object graph traceable top-to-bottom in main (or single wire.go)
[ ] Tests instantiate via the same constructor, with fakes — no test-only DI path
[ ] DI framework only after manual wiring is the actual bottleneck
```

---

## Testing Strategies

### The Pyramid (Go-flavored)

```
        ╱╲     e2e          — full binary, real network. Few. Slow. High signal on integration.
       ╱──╲    integration  — package + real DB/Redis/HTTP. Some. Moderate speed.
      ╱────╲   unit         — pure functions, single struct + fakes. Many. Milliseconds.
```

Most code is unit-testable. Push logic out of HTTP handlers and DB layers into pure domain functions — they're trivial to test. Reserve integration tests for the seams.

**No "service layer 100% mocked" tests.** Either test against fakes (real in-memory impl) for unit, or hit the real dependency (testcontainer) for integration. Mocks-everywhere produces tests coupled to implementation that pass while behavior breaks.

### Black-Box vs White-Box

| Style       | Package           | Use when                                          |
|-------------|-------------------|---------------------------------------------------|
| Black-box   | `foo_test`        | Default. Tests exercise only the public API.      |
| White-box   | `foo`             | Need to test unexported helpers — rare and a smell. |
| Mixed       | both, separate files | Common — public-API tests + a few internals tests. |

Black-box tests double as documentation: a reader sees exactly what the package exposes and how to use it.

### Table-Driven Tests

```go
func TestParse(t *testing.T) {
    cases := []struct {
        name    string
        in      string
        want    Foo
        wantErr error
    }{
        {"empty", "", Foo{}, ErrEmpty},
        {"valid", "x=1", Foo{X: 1}, nil},
        {"malformed", "x=", Foo{}, ErrMalformed},
    }
    for _, tc := range cases {
        t.Run(tc.name, func(t *testing.T) {
            t.Parallel()
            got, err := Parse(tc.in)
            if !errors.Is(err, tc.wantErr) {
                t.Fatalf("err: got %v want %v", err, tc.wantErr)
            }
            if !reflect.DeepEqual(got, tc.want) {
                t.Errorf("got %+v want %+v", got, tc.want)
            }
        })
    }
}
```

Rules:
- Always `t.Run(tc.name, ...)`. Lets you target one case: `go test -run TestParse/malformed`.
- `t.Parallel()` inside `t.Run`. Combined with shuffle (`go test -shuffle=on`), exposes shared-state bugs early.
- Go 1.22+: loop variable capture is fixed; earlier versions need `tc := tc`. Pin the minimum or always shadow.
- Keep the case struct flat. If a row needs heavy setup, write a dedicated test function — don't grow the struct.

### Subtests for Hierarchy

```go
func TestService(t *testing.T) {
    t.Run("Create", func(t *testing.T) {
        t.Run("rejects empty name", func(t *testing.T) { ... })
        t.Run("emits user_created event", func(t *testing.T) { ... })
    })
    t.Run("Delete", func(t *testing.T) { ... })
}
```

Run a slice: `go test -run TestService/Create`.

### Naming

- `TestXxx` — the test function.
- Subtest names: imperative, present tense, describe the **behavior** under test. `"rejects empty name"`, not `"TestEmptyName"`, not `"empty_name_returns_error"`.
- Failure message names the property: `t.Errorf("status: got %d want %d", got, want)` — not `t.Error("wrong")`.

### Helpers

```go
func newTestService(t *testing.T) (*Service, *fakeRepo) {
    t.Helper()
    repo := newFakeRepo()
    svc := NewService(repo, fixedClock(t), slog.Default())
    return svc, repo
}
```

- `t.Helper()` at the top of every helper — failure locations point to the caller, not the helper.
- Helpers take `*testing.T` so they can fail fast.
- Helpers should construct, not assert (mostly). Assertion helpers are fine when named clearly.

### Cleanup and Temp State

- `t.Cleanup(fn)` over `defer fn()`. Runs in reverse order, runs even on `t.FailNow`/panic, composes through helpers.
- `t.TempDir()` for filesystem tests — auto-removed.
- `t.Setenv(k, v)` for env-var-dependent code — auto-restored. Blocks `t.Parallel()` (correct: env is process-global).
- `t.Context()` (Go 1.24+) — auto-cancels at end of test. Replaces hand-rolled `ctx, cancel := ...`.

### Fakes Over Mocks

```go
// Fake — a real in-memory implementation of the same interface
type fakeUserRepo struct {
    mu    sync.Mutex
    users map[string]*User
}
func newFakeRepo() *fakeUserRepo { return &fakeUserRepo{users: map[string]*User{}} }
func (r *fakeUserRepo) Save(_ context.Context, u *User) error {
    r.mu.Lock(); defer r.mu.Unlock()
    r.users[u.ID] = u
    return nil
}
func (r *fakeUserRepo) Get(_ context.Context, id string) (*User, error) {
    r.mu.Lock(); defer r.mu.Unlock()
    u, ok := r.users[id]
    if !ok { return nil, ErrNotFound }
    return u, nil
}
```

Use a fake when:
- The interface has a meaningful state (repos, caches, queues).
- Tests want to assert on outcomes (the user was saved), not on calls (`.Save` was called with X).

Use a mock (gomock, testify/mock) only when:
- The dependency is a remote service with no realistic in-memory equivalent.
- You truly need to assert on the **call** (e.g., metrics, logging side-effects).

Default to fakes. They survive refactors; mocks shatter at every signature change.

### Equality and Diffs

- `reflect.DeepEqual` for structs without unexported fields.
- `google/go-cmp` (`cmp.Diff`) for anything non-trivial — readable diffs, configurable options (ignore unexported, transform time, allow approximation):

  ```go
  if diff := cmp.Diff(want, got, cmpopts.IgnoreUnexported(Foo{})); diff != "" {
      t.Errorf("mismatch (-want +got):\n%s", diff)
  }
  ```
- For floats: `cmpopts.EquateApprox(0, 1e-9)`.
- For time: `cmpopts.EquateApproxTime(time.Second)` or inject a fixed clock so equality is exact.

### HTTP Handler Tests

```go
func TestUserHandler_Create(t *testing.T) {
    svc, repo := newTestService(t)
    h := NewHandler(svc)

    body := strings.NewReader(`{"name":"alice"}`)
    req := httptest.NewRequest(http.MethodPost, "/users", body)
    req = req.WithContext(t.Context())
    rec := httptest.NewRecorder()

    h.ServeHTTP(rec, req)

    if rec.Code != http.StatusCreated {
        t.Fatalf("status: got %d want %d, body=%s", rec.Code, http.StatusCreated, rec.Body)
    }
    if _, err := repo.Get(t.Context(), "alice"); err != nil {
        t.Errorf("user not persisted: %v", err)
    }
}
```

- `httptest.NewRequest` / `httptest.NewRecorder` for unit-level handler tests (no socket).
- `httptest.NewServer` for tests that need a real URL (e.g., an HTTP client under test) — auto-closed via `t.Cleanup(s.Close)`.

### Integration Tests with Real Dependencies

Use `testcontainers-go`:

```go
func TestUserRepo_Integration(t *testing.T) {
    if testing.Short() { t.Skip("integration") }

    ctx := t.Context()
    container, err := postgres.Run(ctx, "postgres:16-alpine",
        postgres.WithDatabase("test"),
        postgres.WithUsername("test"),
        postgres.WithPassword("test"),
        testcontainers.WithWaitStrategy(wait.ForListeningPort("5432/tcp")),
    )
    if err != nil { t.Fatal(err) }
    t.Cleanup(func() { _ = container.Terminate(ctx) })

    dsn, _ := container.ConnectionString(ctx, "sslmode=disable")
    db := mustOpen(t, dsn)
    runMigrations(t, db)

    repo := NewUserRepo(db)
    // ... exercise repo against the real schema
}
```

Patterns:
- Gate with `if testing.Short()` so `go test -short` runs only the fast tests.
- One container per package (via `TestMain`) when tests can share — much faster than per-test.
- Per-test isolation via transactions: `BEGIN` in setup, `ROLLBACK` in `t.Cleanup`. No data leaks between tests.
- Migrations run once per container, not per test.

### TestMain

```go
func TestMain(m *testing.M) {
    // shared setup (start container, run migrations)
    code := m.Run()
    // shared teardown
    os.Exit(code)
}
```

Use sparingly — shared state in `TestMain` defeats `t.Parallel()` benefits. Prefer per-test setup; reach for `TestMain` when setup cost is genuinely prohibitive.

### Golden Files

For tests with large expected outputs (rendered templates, codegen, JSON schemas):

```go
func TestRender(t *testing.T) {
    got := Render(input)
    golden := filepath.Join("testdata", t.Name()+".golden")

    if *update {
        if err := os.WriteFile(golden, got, 0o644); err != nil { t.Fatal(err) }
    }
    want, _ := os.ReadFile(golden)
    if !bytes.Equal(got, want) {
        t.Errorf("mismatch; re-run with -update to regenerate")
    }
}

var update = flag.Bool("update", false, "update golden files")
```

`testdata/` is a magic directory — Go tooling ignores it. Commit goldens; review diffs in PRs.

### Fuzzing

Built into `go test` (Go 1.18+):

```go
func FuzzParse(f *testing.F) {
    f.Add("x=1")
    f.Add("")
    f.Fuzz(func(t *testing.T, in string) {
        got, err := Parse(in)
        if err != nil { return }
        // round-trip invariant
        if Stringify(got) != in {
            t.Errorf("roundtrip: got %q want %q", Stringify(got), in)
        }
    })
}
```

Run: `go test -fuzz=FuzzParse -fuzztime=30s`.
Corpus failures land in `testdata/fuzz/FuzzParse/` — commit them as regression tests.

Fuzz boundaries that take untrusted input: parsers, decoders, validators. Look for invariants (idempotence, round-trip, no panic) rather than specific outputs.

### Race Detector

```bash
go test -race -count=1 ./...
```

Non-optional in CI for any code using goroutines. `-race` is slow (5-10×); run on the full suite in CI, scoped (`-run`) locally during development.

`-count=1` disables the test cache when you need a clean run.

### Coverage

```bash
go test -coverprofile=cover.out ./...
go tool cover -html=cover.out
go tool cover -func=cover.out
```

Use as a **map**, not a target. Coverage thresholds in CI ("require 80%") incentivize trivial tests that hit lines without verifying behavior. Look at the report to find untested critical paths; don't enforce a number.

For integration coverage, `go build -cover` + run binary + `go tool covdata` (Go 1.20+).

### Benchmarks

```go
func BenchmarkParse(b *testing.B) {
    in := "x=1&y=2&z=3"
    b.ReportAllocs()
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        _, _ = Parse(in)
    }
}
```

- `b.ReportAllocs()` always. Allocations are usually the story.
- `b.ResetTimer()` after non-trivial setup.
- Sub-benchmarks for input size sweeps:

  ```go
  for _, n := range []int{10, 100, 1000} {
      b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) { ... })
  }
  ```

- Compare runs with `benchstat`:

  ```bash
  go test -bench=. -count=10 > old.txt
  # change code
  go test -bench=. -count=10 > new.txt
  benchstat old.txt new.txt
  ```

  Trust the p-value, not a single delta.

### Flakes — Zero Tolerance

A flaky test is a defect. Triage immediately:
1. Reproduce with `go test -run TestX -count=100 -race`.
2. Hunt the source: shared global, timing dependency (`time.Sleep`), test order coupling.
3. Fix the test or fix the code. **Never** retry-flag a flake away.

Common causes:
- `time.Sleep` for "wait for goroutine" — replace with synchronization primitive or polling assertion.
- Tests sharing a temp file / port / global registry.
- Map iteration order assumptions (Go intentionally randomizes).
- Goroutine outlives the test and writes to its state.

### Determinism

- Inject `clock` so time is exact (see DI section).
- Seed random sources used by tests:

  ```go
  rng := rand.New(rand.NewSource(42))
  ```

- Don't depend on wall-clock ordering across processes (file mtimes, log line ordering).

### Property-Based Testing

For algorithms with general invariants, `pgregory.net/rapid` or stdlib fuzz with assertions. Don't reach for it until you have a real invariant — most CRUD code doesn't.

### Snapshot Testing

Not idiomatic in Go (the goldens pattern above covers the use case). Avoid JS-style snapshot libraries — they encourage "approve whatever the code outputs" reviews.

### Test Organization

```
internal/user/
├── user.go
├── user_test.go              # black-box unit tests (package user_test)
├── service.go
├── service_test.go
├── repo_pg.go
├── repo_pg_integration_test.go  # gated by build tag or testing.Short()
└── testdata/
    ├── fixture.json
    └── fuzz/
```

- Tests live next to code, in the same directory.
- Build tags for slow/integration tests if `testing.Short()` isn't enough:

  ```go
  //go:build integration
  ```

  Run with `go test -tags=integration`.

### CI Configuration

Run in this order — fast feedback first:
1. `gofmt -s -l .` (fail on diff)
2. `go vet ./...`
3. `golangci-lint run`
4. `go test -short -race -count=1 ./...`        (unit)
5. `go test -race -count=1 ./...`               (with integration)
6. `go test -bench=. -benchmem -run=^$ ./...`   (perf-sensitive packages only)
7. `govulncheck ./...`

Cache modules and build cache between runs. Parallelize packages with `-p N`.

### Anti-Patterns

- Mocks for the database. Use real Postgres via testcontainers.
- `time.Sleep` to "wait for" async work. Synchronize properly.
- One test asserting many behaviors via dozens of `if`s — split into subtests.
- Tests that share state through global vars.
- Conditional skips (`if runtime.GOOS == ...`) without a clear reason commented.
- `t.Log` everywhere "for debugging" — clutters output. Use `-v` or fix the test design.
- Re-running with `t.Skip` instead of fixing the test.
- Asserting via panics (`if x { panic(...) }`) — use `t.Fatalf`.
- "Helper" assertions that swallow errors. `t.Helper()` and bubble the failure up.

### Testing Checklist

```
[ ] Public API tested via package _test (black-box default)
[ ] Table-driven with named subtests; t.Parallel() where safe
[ ] go test -race -count=1 ./... clean
[ ] -shuffle=on passes
[ ] Fakes for stateful collaborators; mocks reserved for remote services
[ ] DB / Redis / Kafka integration tests use testcontainers, gated by -short
[ ] Time, randomness, IDs injected — no wall-clock or rand.Float64 in production code paths
[ ] t.Cleanup, t.TempDir, t.Setenv, t.Context used over manual setup/teardown
[ ] cmp.Diff for non-trivial equality, with diff-friendly options
[ ] HTTP handlers tested via httptest; clients via httptest.NewServer
[ ] Golden files in testdata/ with -update flag; diffs reviewed in PR
[ ] Fuzz tests on parsers/decoders/validators; corpus committed
[ ] Benchmarks compared with benchstat over ≥10 runs
[ ] Zero tolerance for flakes — triaged on first occurrence
```

---

## Observability with OpenTelemetry

Three signals: **traces** (causal flow), **metrics** (aggregates), **logs** (events). OTel unifies the SDK and wire protocol (OTLP) — pick OTel for new services. Vendor lock-in lives in the backend, not the instrumentation.

### Setup

One initialization per process, in `main`, before any instrumented code runs.

```go
import (
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/metric"
    "go.opentelemetry.io/otel/sdk/resource"
    "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

func initOTel(ctx context.Context, cfg Config) (shutdown func(context.Context) error, err error) {
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.Version),
            semconv.DeploymentEnvironment(cfg.Env),
        ),
        resource.WithFromEnv(),                   // OTEL_RESOURCE_ATTRIBUTES
        resource.WithProcess(),
        resource.WithHost(),
    )
    if err != nil { return nil, err }

    // Trace pipeline
    traceExp, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithEndpoint(cfg.OTLPEndpoint),
        otlptracegrpc.WithInsecure(),             // TLS in prod
    )
    if err != nil { return nil, err }

    tp := trace.NewTracerProvider(
        trace.WithBatcher(traceExp,
            trace.WithMaxQueueSize(2048),
            trace.WithBatchTimeout(5*time.Second),
        ),
        trace.WithResource(res),
        trace.WithSampler(trace.ParentBased(
            trace.TraceIDRatioBased(cfg.SampleRatio),
        )),
    )
    otel.SetTracerProvider(tp)

    // Metric pipeline
    metricExp, err := otlpmetricgrpc.New(ctx,
        otlpmetricgrpc.WithEndpoint(cfg.OTLPEndpoint),
        otlpmetricgrpc.WithInsecure(),
    )
    if err != nil { return nil, err }

    mp := metric.NewMeterProvider(
        metric.WithResource(res),
        metric.WithReader(metric.NewPeriodicReader(metricExp,
            metric.WithInterval(30*time.Second))),
    )
    otel.SetMeterProvider(mp)

    // W3C trace context + baggage propagation
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return func(ctx context.Context) error {
        return errors.Join(tp.Shutdown(ctx), mp.Shutdown(ctx))
    }, nil
}
```

Call `shutdown` during graceful shutdown (see Graceful Shutdown section) — it flushes batched spans/metrics. Skipping it loses the last seconds of data, exactly when you need them.

### Tracers and Meters per Package

```go
var (
    tracer = otel.Tracer("github.com/acme/svc/internal/user")
    meter  = otel.Meter("github.com/acme/svc/internal/user")
)
```

Name = the import path. Backends use it to group instrumentation. Do **not** create a new Tracer per request.

### Spans

```go
func (s *Service) CreateUser(ctx context.Context, name string) (*User, error) {
    ctx, span := tracer.Start(ctx, "Service.CreateUser",
        oteltrace.WithAttributes(
            attribute.String("user.name", name),
        ),
    )
    defer span.End()

    u, err := s.repo.Save(ctx, &User{Name: name})
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, fmt.Errorf("save: %w", err)
    }
    span.SetAttributes(attribute.String("user.id", u.ID))
    return u, nil
}
```

Rules:
- **Span per operation that crosses a boundary** — HTTP call, DB query, RPC, queue publish/consume. Not every internal function.
- Name: `<Subject>.<Verb>` or RPC `<service>/<method>`. Stable, low-cardinality.
- `defer span.End()` immediately after `Start` — never forget on early return.
- On error: `RecordError(err)` + `SetStatus(codes.Error, msg)`. Both. `RecordError` alone leaves status `Unset`.
- Attributes: low-cardinality keys. User ID OK on a span (per-trace); not on a metric label.
- Don't repeat attributes already on the resource (service name, env).

### Semantic Conventions

Use `semconv` constants — backends understand them, dashboards work out of the box.

```go
import semconv "go.opentelemetry.io/otel/semconv/v1.26.0"

span.SetAttributes(
    semconv.HTTPRequestMethodKey.String("POST"),
    semconv.URLPath("/users"),
    semconv.HTTPResponseStatusCode(201),
)
```

Pin the semconv version. Conventions evolve; don't mix versions in one service.

### Context Propagation

Trace context lives in `ctx`. Every cross-boundary call must pass it.

Inbound (extract):
```go
// HTTP server middleware
func otelMiddleware(next http.Handler) http.Handler {
    return otelhttp.NewHandler(next, "http.server")
}
```

Outbound (inject):
```go
// HTTP client
client := &http.Client{Transport: otelhttp.NewTransport(http.DefaultTransport)}

// gRPC
conn, _ := grpc.NewClient(addr,
    grpc.WithStatsHandler(otelgrpc.NewClientHandler()),
)
```

For custom carriers (Kafka headers, custom RPC):
```go
otel.GetTextMapPropagator().Inject(ctx, propagation.MapCarrier(headers))
// on the other side:
ctx = otel.GetTextMapPropagator().Extract(ctx, propagation.MapCarrier(headers))
```

### Sampling

Head-based sampling decides at trace start; tail-based at the collector.

- `AlwaysSample()` — dev only. Cost explodes at scale.
- `TraceIDRatioBased(0.01)` — 1% of traces. Common prod default.
- `ParentBased(...)` — respect upstream sample decision. Critical in microservices: half-sampled traces are useless.
- Tail sampling (latency outliers, errors) lives in the OTel Collector, not the SDK.

```go
trace.WithSampler(trace.ParentBased(trace.TraceIDRatioBased(0.01)))
```

### Metrics

Three instrument families that matter:

```go
var (
    reqCounter, _ = meter.Int64Counter("http.server.requests",
        metric.WithDescription("Count of HTTP requests"),
        metric.WithUnit("{request}"),
    )
    reqDuration, _ = meter.Float64Histogram("http.server.duration",
        metric.WithDescription("HTTP request duration"),
        metric.WithUnit("s"),
        metric.WithExplicitBucketBoundaries(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10),
    )
    inflight, _ = meter.Int64UpDownCounter("http.server.active_requests",
        metric.WithUnit("{request}"),
    )
)
```

Use:
```go
start := time.Now()
inflight.Add(ctx, 1, metric.WithAttributes(attrs...))
defer inflight.Add(ctx, -1, metric.WithAttributes(attrs...))

// ... handle ...

reqCounter.Add(ctx, 1, metric.WithAttributes(attrs...))
reqDuration.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attrs...))
```

Instrument choice:
- **Counter** — monotonic; rate-of-change matters (requests, errors, bytes).
- **UpDownCounter** — value goes up and down (in-flight, queue depth, open connections).
- **Histogram** — distribution (latency, sizes). Bucket boundaries matter — pick for your SLO.
- **Gauge** (observable) — sampled current value (memory, goroutine count). Register an observation callback.

### Cardinality Discipline

**Cardinality kills metric backends.** Every unique label combination = a separate time series.

| Safe label                | Dangerous label             |
|---------------------------|-----------------------------|
| `http.route` (`/users/:id`) | `http.target` (`/users/12345`) |
| `http.status_code`        | `user.id`                   |
| `db.operation` (`SELECT`) | `db.statement`              |
| `peer.service`            | `request.id`                |

Rule of thumb: total time series per metric ≤ a few thousand. If a label can take >100 values, leave it on **spans** (which are per-request) and out of **metrics** (aggregated).

### Auto-Instrumentation Libraries

Use the contrib libraries; don't hand-roll:
- `otelhttp` — `net/http` client + server.
- `otelgrpc` — gRPC client + server.
- `otelsql` (`XSAM/otelsql`) — wraps `database/sql` driver.
- `otelpgx` — native pgx instrumentation.
- `otelmongo`, `otelredis`, `otelsarama` (Kafka), etc.

They handle propagation, span naming, error recording, and standard attributes. Reaching past them is a smell.

### Logs Bridge

OTel logs are GA. Bridge slog → OTel so log records carry trace context and ship via OTLP alongside spans/metrics:

```go
import "go.opentelemetry.io/contrib/bridges/otelslog"

logger := otelslog.NewLogger("svc",
    otelslog.WithLoggerProvider(lp),
)
slog.SetDefault(logger)
```

Or keep slog as the primary handler and inject `trace_id`/`span_id` via a handler middleware (see slog section) — both approaches valid; pick one per service.

### Exemplars

Histogram exemplars link a metric bucket to a specific trace. Prometheus + OTLP supports this. When latency p99 spikes, click the bucket → see the slow trace. Configure your exporter to emit exemplars; pick a span from the histogram-recording call.

### Collector

Run the OpenTelemetry Collector as a sidecar or DaemonSet:

```
SDK (in app) → Collector → Backend(s)
```

Benefits:
- Reduces app egress (batching, compression).
- Tail-based sampling (sample slow/error traces, drop the rest).
- Multi-backend fanout (Tempo + Jaeger, Prometheus + remote write).
- Decouples app lifecycle from backend availability — collector buffers on outage.

App config: `OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4317`. Done.

### Performance Cost

Reasonable defaults:
- Span creation: ~1µs. Negligible per-request, expensive in tight loops.
- BatchSpanProcessor with 5s timeout / 512 queue: ~1% CPU at moderate QPS.
- Metric record: nanoseconds; attribute construction is the cost. Cache attribute sets:

  ```go
  okAttrs := metric.WithAttributes(attribute.String("status", "ok"))
  // hot path:
  counter.Add(ctx, 1, okAttrs)
  ```

- Don't instrument inside an inner loop running 1M times/req. Span the outer operation.

### Testing Instrumentation

```go
import (
    "go.opentelemetry.io/otel/sdk/trace"
    "go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestService_CreateUser_EmitsSpan(t *testing.T) {
    rec := tracetest.NewSpanRecorder()
    tp := trace.NewTracerProvider(trace.WithSpanProcessor(rec))
    t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
    otel.SetTracerProvider(tp)

    svc := newTestService(t)
    _, _ = svc.CreateUser(t.Context(), "alice")

    spans := rec.Ended()
    if len(spans) != 1 || spans[0].Name() != "Service.CreateUser" {
        t.Fatalf("expected one span; got %+v", spans)
    }
}
```

`tracetest.SpanRecorder` and `metric/sdk/metricdata` give programmatic access to emitted telemetry.

### Anti-Patterns

- Span per internal function — explodes trace count, drowns the actual flow.
- High-cardinality labels on **metrics** (user IDs, URLs, request IDs).
- `AlwaysSample()` in prod.
- Not calling `TracerProvider.Shutdown` — loses the last seconds of data.
- `noopTracer` because "tracing wasn't initialized" — silent and surprising. Init OTel even in tests (with a recorder).
- Mixing `prometheus/client_golang` and OTel metrics in the same service — pick one, bridge if you must.
- Custom propagation header names — use W3C `traceparent`, `tracestate`. Anything else breaks interop.
- Recording `time.Now().Sub(start)` manually when `otelhttp` / `otelgrpc` already does it.
- `span.SetAttributes` after `span.End()` — silently dropped.
- Hand-rolled span IDs / trace IDs — use the SDK.

### Workflow: Instrumenting a New Service

1. `initOTel` in `main`; defer `shutdown` from graceful shutdown.
2. Wrap inbound: `otelhttp.NewHandler` / `otelgrpc.NewServer`.
3. Wrap outbound: HTTP `Transport`, gRPC `StatsHandler`, DB driver.
4. Add one custom span per business operation (`Service.CreateUser`). Not internal funcs.
5. Add metrics for the four golden signals: rate, errors, duration (RED) + saturation if applicable.
6. Inject trace IDs into structured logs (slog handler middleware).
7. Verify in dev: a request emits one trace, N spans, N metric updates; trace context propagates across at least one outbound call.
8. In prod: start with 1% sampling, tail-sample in the collector for errors + slow.

### OTel Checklist

```
[ ] initOTel in main, shutdown wired into graceful shutdown sequence
[ ] Resource has service.name, service.version, deployment.environment
[ ] W3C TraceContext + Baggage propagators registered
[ ] Tracer/Meter per package, named after import path
[ ] otelhttp / otelgrpc / otelsql (or pgx) wrap all I/O boundaries
[ ] Spans only at boundaries + business operations; not every function
[ ] Errors on spans: RecordError + SetStatus(Error)
[ ] Histograms have explicit, SLO-aligned bucket boundaries
[ ] Metric labels low-cardinality; high-cardinality data stays on spans
[ ] Sampling: ParentBased + TraceIDRatioBased; tail sampling in collector
[ ] semconv constants at a pinned version
[ ] Logs carry trace_id / span_id; emitted via OTel or slog handler middleware
[ ] Tests use tracetest.SpanRecorder to assert span emission
[ ] OTel Collector deployed; app talks to it, not the backend directly
```

---

## Structured Logging with slog

`log/slog` is the stdlib structured logger (Go 1.21+). Default to it. Drop `logrus`, `zap`, `zerolog` unless you have measured perf reasons (zap/zerolog are faster on hot paths). Even then, prefer a `slog.Handler` adapter over a parallel logging stack.

### Setup

One logger per process, configured at startup, injected (never package-global except as a fallback).

```go
func newLogger(env string) *slog.Logger {
    var h slog.Handler
    opts := &slog.HandlerOptions{
        Level:     slog.LevelInfo,    // overridden by config / env
        AddSource: env != "prod",     // file:line in dev; off in prod (cost)
    }
    if env == "prod" {
        h = slog.NewJSONHandler(os.Stdout, opts)
    } else {
        h = slog.NewTextHandler(os.Stderr, opts)
    }
    return slog.New(h)
}
```

Set as default once, for libraries that can't accept an injected logger:

```go
slog.SetDefault(logger)
```

### Levels

Four levels — use them deliberately:

| Level   | Meaning                                                   | Example |
|---------|-----------------------------------------------------------|---------|
| `Debug` | Verbose, dev-only; off by default in prod                 | "cache hit", "loop iteration N" |
| `Info`  | Lifecycle + state changes operators want to see           | "server started", "user created", "job completed" |
| `Warn`  | Recoverable degradation; not pageable on its own          | "fallback activated", "retry succeeded after 3 attempts" |
| `Error` | Operator action needed; correlates with alerts            | "db connection failed", "request failed: <details>" |

No `Fatal` — slog doesn't have it. If startup fails, log Error and `os.Exit(1)` (or return from `main`).

Dynamic level (production tunable):

```go
var lvl = new(slog.LevelVar)        // safe for concurrent SetLevel
lvl.Set(slog.LevelInfo)
h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: lvl})

// expose via admin endpoint or SIGUSR1 to flip Debug on without restart
lvl.Set(slog.LevelDebug)
```

### Logging Calls

**Key-value pairs, not formatted strings.**

```go
// WRONG — message text holds variable data; ungrepable, uncardinality-controlled
log.Info(fmt.Sprintf("user %s created in tenant %s", u.ID, u.Tenant))

// RIGHT
log.Info("user created", "user_id", u.ID, "tenant", u.Tenant)
```

The message is a **constant string** describing the event. All variability lives in attributes.

Prefer `slog.Attr` over loose pairs for hot paths and type safety:

```go
log.LogAttrs(ctx, slog.LevelInfo, "user created",
    slog.String("user_id", u.ID),
    slog.String("tenant", u.Tenant),
    slog.Duration("elapsed", elapsed),
)
```

`LogAttrs` avoids the `any...` boxing of `Info`/`Debug`/etc. — measurably cheaper at high QPS.

### Attribute Conventions

Pick a convention at project start, enforce in review:

- `snake_case` keys (matches most log aggregators).
- Stable key names — `user_id` always means the same thing across services. Document in a shared `logfields` package.
- Don't log secrets, tokens, full request bodies, PII unless redacted. Add a redaction wrapper at the handler level if PII is a concern (`slog.Handler` middleware).
- `error` key for errors: `slog.Any("error", err)` — most JSON handlers serialize via `Error() string`. Use `slog.String("error", err.Error())` if you need the literal string only.

### Context-Bound Attributes

Attach request-scoped fields once, every subsequent log in that scope carries them:

```go
log := log.With(
    "request_id", reqID,
    "user_id", userID,
    "route", r.URL.Path,
)
// pass `log` down — every emit gets these attributes for free
```

Per-component prefix with `WithGroup`:

```go
dbLog := log.WithGroup("db")
dbLog.Info("query executed", "rows", n, "duration_ms", d.Milliseconds())
// JSON: {"db":{"rows":12,"duration_ms":4}, ...}
```

### Logger via Context

Two camps:
1. **Explicit injection** — pass `*slog.Logger` as a struct field or function arg. Cleanest, easy to test.
2. **`ctx` carries the logger** — `LoggerFromContext(ctx)`. Convenient for middleware-augmented loggers but couples to `ctx.Value`.

Default to (1). Use (2) only inside HTTP/RPC middleware chains where threading a logger through every function would be churn. Provide a helper:

```go
type ctxKey struct{}

func WithLogger(ctx context.Context, l *slog.Logger) context.Context {
    return context.WithValue(ctx, ctxKey{}, l)
}
func FromContext(ctx context.Context) *slog.Logger {
    if l, ok := ctx.Value(ctxKey{}).(*slog.Logger); ok { return l }
    return slog.Default()
}
```

### Errors

```go
if err := doIt(ctx); err != nil {
    log.ErrorContext(ctx, "do it failed",
        "error", err,
        "user_id", uid,
    )
    return fmt.Errorf("do it: %w", err)
}
```

Rules:
- `*Context` variants (`ErrorContext`, `InfoContext`, etc.) when ctx is available — handlers can extract trace/span IDs from it.
- **Log once.** At the top of the call stack (handler / job runner). Wrap with `%w` everywhere else and return.
- If you log + return, document why — usually it's wrong.

### Tracing Correlation

Inject trace/span IDs into every log line. With OpenTelemetry, write a `slog.Handler` middleware:

```go
type otelHandler struct{ slog.Handler }

func (h otelHandler) Handle(ctx context.Context, r slog.Record) error {
    if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
        r.AddAttrs(
            slog.String("trace_id", sc.TraceID().String()),
            slog.String("span_id", sc.SpanID().String()),
        )
    }
    return h.Handler.Handle(ctx, r)
}
```

Now every `*Context` log auto-correlates with traces in your backend.

### Sampling Hot Paths

High-QPS Info logs flood the pipeline. Sample at the handler:

```go
type sampledHandler struct {
    slog.Handler
    n uint64                  // 1-in-N
    c atomic.Uint64
}

func (h *sampledHandler) Handle(ctx context.Context, r slog.Record) error {
    if r.Level >= slog.LevelWarn { return h.Handler.Handle(ctx, r) }
    if h.c.Add(1)%h.n == 0     { return h.Handler.Handle(ctx, r) }
    return nil
}
```

Always log Warn+ unsampled. Add `"sampled":true` attribute when dropping.

### Performance

- `slog.LogAttrs` > `slog.Info(msg, ...any)` — avoids `any` boxing.
- `JSONHandler` is ~2× slower than `zap`/`zerolog` on micro-benchmarks. Rarely matters at 10k QPS; matters at 1M QPS. Switch handler, keep the API.
- `AddSource: true` adds runtime.Caller cost — off in prod hot paths.
- Disabled-level calls are nearly free (`Enabled` check before record assembly). Don't pre-compute expensive args:

  ```go
  // bad — fmt.Sprintf runs even if Debug is off
  log.Debug("payload", "body", fmt.Sprintf("%+v", body))

  // good — slog defers attribute construction
  log.Debug("payload", "body", body)        // body's String() / Marshal runs only if emitted
  ```

  For genuinely expensive logs, gate with `if log.Enabled(ctx, slog.LevelDebug) { ... }`.

### Testing

Capture logs in tests:

```go
var buf bytes.Buffer
log := slog.New(slog.NewJSONHandler(&buf, nil))
// ... run code under test
if !strings.Contains(buf.String(), `"event":"user_created"`) {
    t.Fatal("expected user_created log")
}
```

For richer assertions, write a custom `slog.Handler` that records `slog.Record`s into a slice.

### Anti-Patterns

- `fmt.Sprintf` inside the message string.
- `log.Printf` / `log.Println` (stdlib `log` package) in new code — unstructured, no levels.
- Package-global `var log = ...` referencing a non-injected logger. Test isolation suffers; level changes propagate poorly.
- Logging the same error at every wrap. Wrap silently, log once.
- Logging request/response bodies wholesale. Sample, truncate, or redact.
- Using log level to encode business meaning (`Warn` for "user not found" — that's `Info` or no log at all).
- Inconsistent keys (`userID` vs `user_id` vs `uid` across services). Pick one, enforce in review.

### slog Checklist

```
[ ] Single *slog.Logger constructed in main, injected (or via ctx in HTTP/RPC chain)
[ ] JSON handler in prod, text in dev; level via LevelVar for runtime control
[ ] Constant message strings; all variability in key-value attrs
[ ] snake_case keys; shared logfields package for cross-service names
[ ] LogAttrs in hot paths; Info/Debug elsewhere for ergonomics
[ ] *Context variants used wherever ctx is in scope
[ ] Trace/span IDs injected via custom Handler middleware
[ ] No secrets/PII/full bodies logged unredacted
[ ] Errors logged exactly once at the top of the stack
[ ] AddSource off in prod hot paths
[ ] High-QPS Info paths sampled; Warn+ always unsampled
[ ] Tests capture logs via bytes.Buffer or recording handler
```

---

## HTTP Services

- `net/http` is enough for most services. Reach for `chi` / `gin` / `echo` for routing ergonomics, not because stdlib "can't scale."
- Server timeouts are **not optional**: set `ReadHeaderTimeout`, `ReadTimeout`, `WriteTimeout`, `IdleTimeout`. The defaults are unbounded.
- Graceful shutdown:

```go
ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
defer stop()

srv := &http.Server{Addr: ":8080", Handler: mux, ReadHeaderTimeout: 5*time.Second}
go func() {
    if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
        log.Error("server", "err", err)
    }
}()
<-ctx.Done()
shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
defer cancel()
_ = srv.Shutdown(shutdownCtx)
```

- Middleware: chain explicitly, no magic. Recover panics at the outermost layer and convert to 500.
- Request body: `http.MaxBytesReader` to cap size. Defer `Body.Close()`.
- JSON: `encoding/json` is fine. For hot paths, consider `json.Decoder` streaming over `Unmarshal`. Don't optimize until profiled.

---

## gRPC

gRPC is HTTP/2 + Protocol Buffers. Use it for internal service-to-service communication where you need strong contracts, streaming, or bi-directional flow. For public APIs, prefer REST/JSON unless clients are controlled.

### Protobuf and Code Generation

Define the contract in `.proto`, generate Go code, never write generated code by hand.

```proto
// api/user/v1/user.proto
syntax = "proto3";
package user.v1;
option go_package = "github.com/acme/svc/gen/user/v1;userv1";

service UserService {
  rpc GetUser(GetUserRequest) returns (GetUserResponse);
  rpc ListUsers(ListUsersRequest) returns (stream GetUserResponse);
  rpc BatchCreate(stream CreateUserRequest) returns (BatchCreateResponse);
  rpc Chat(stream ChatMessage) returns (stream ChatMessage);
}

message GetUserRequest  { string id = 1; }
message GetUserResponse { string id = 1; string name = 2; }
```

Generation:

```bash
buf generate                          # preferred: buf.build ecosystem
# or manually:
protoc --go_out=. --go-grpc_out=. api/user/v1/user.proto
```

Use `buf` (`bufbuild/buf`) for linting, breaking-change detection, and registry. `buf lint` in CI; `buf breaking --against .git#branch=main` blocks backwards-incompatible changes.

Rules:
- One `.proto` file per service. One package per version (`user.v1`, `user.v2`).
- Never remove or renumber fields. Deprecate with `[deprecated = true]`; add new fields instead.
- Use `optional` (proto3 `optional` keyword / `oneof` wrapper) when absence is semantically different from zero value.
- Commit generated code or generate in CI — pick one, never both.

### Server Setup

```go
import (
    "google.golang.org/grpc"
    "google.golang.org/grpc/health"
    "google.golang.org/grpc/health/grpc_health_v1"
    "google.golang.org/grpc/reflection"
    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
)

func newGRPCServer(svc *Service, log *slog.Logger) *grpc.Server {
    srv := grpc.NewServer(
        grpc.StatsHandler(otelgrpc.NewServerHandler()),      // traces + metrics
        grpc.ChainUnaryInterceptor(
            recoveryInterceptor(log),
            loggingInterceptor(log),
            authInterceptor(authz),
        ),
        grpc.ChainStreamInterceptor(
            streamRecoveryInterceptor(log),
            streamLoggingInterceptor(log),
            streamAuthInterceptor(authz),
        ),
    )

    userv1.RegisterUserServiceServer(srv, svc)

    // Health check — required for k8s readiness and load-balancer probes
    healthSrv := health.NewServer()
    grpc_health_v1.RegisterHealthServer(srv, healthSrv)
    healthSrv.SetServingStatus("user.v1.UserService", grpc_health_v1.HealthCheckResponse_SERVING)

    // Reflection — allows grpcurl, Postman, etc. in dev. Disable in prod if sensitive.
    reflection.Register(srv)

    return srv
}
```

Listening:

```go
lis, err := net.Listen("tcp", ":9090")
if err != nil { log.Error("listen", "error", err); os.Exit(1) }
go func() {
    if err := srv.Serve(lis); err != nil {
        log.Error("grpc serve", "error", err)
    }
}()
```

### Client Setup

```go
conn, err := grpc.NewClient("dns:///user-svc:9090",
    grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{
        MinVersion: tls.VersionTLS12,
    })),
    grpc.WithStatsHandler(otelgrpc.NewClientHandler()),
    grpc.WithChainUnaryInterceptor(
        metadataInterceptor(),
        retryInterceptor(),
    ),
)
if err != nil { return err }
defer conn.Close()

client := userv1.NewUserServiceClient(conn)
```

- `grpc.NewClient` (not deprecated `grpc.Dial`) — Go 1.x; non-blocking by default. Connection is established on first RPC.
- `dns:///` scheme lets gRPC re-resolve on connection failures — critical for service discovery.
- Always `defer conn.Close()` at the scope that owns the connection. Connections are long-lived; don't create per-request.
- `credentials.NewTLS` for production. `insecure.NewCredentials()` only inside a trusted private network and even then document why.

### Error Handling

gRPC errors are `status.Status` — always map domain errors at the boundary:

```go
import (
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

func (s *Service) GetUser(ctx context.Context, req *userv1.GetUserRequest) (*userv1.GetUserResponse, error) {
    u, err := s.repo.Get(ctx, req.Id)
    switch {
    case errors.Is(err, app.ErrNotFound):
        return nil, status.Errorf(codes.NotFound, "user %s not found", req.Id)
    case errors.Is(err, app.ErrPermission):
        return nil, status.Error(codes.PermissionDenied, "access denied")
    case err != nil:
        return nil, status.Errorf(codes.Internal, "get user: %v", err)
    }
    return &userv1.GetUserResponse{Id: u.ID, Name: u.Name}, nil
}
```

Canonical code mapping:

| Domain condition     | gRPC code           |
|----------------------|---------------------|
| Not found            | `NotFound`          |
| Already exists       | `AlreadyExists`     |
| Validation failed    | `InvalidArgument`   |
| Auth failed          | `Unauthenticated`   |
| Forbidden            | `PermissionDenied`  |
| Rate limited         | `ResourceExhausted` |
| Timeout              | `DeadlineExceeded`  |
| Caller cancelled     | `Canceled`          |
| Transient server err | `Unavailable`       |
| Bug / unhandled      | `Internal`          |

On the client:

```go
resp, err := client.GetUser(ctx, req)
if err != nil {
    st, ok := status.FromError(err)
    if ok && st.Code() == codes.NotFound {
        return nil, app.ErrNotFound
    }
    return nil, fmt.Errorf("get user: %w", err)
}
```

Translate back to domain errors at the client boundary. Callers shouldn't know they're talking gRPC.

Rich errors (attach structured details):

```go
import "google.golang.org/genproto/googleapis/rpc/errdetails"

st, _ := status.New(codes.InvalidArgument, "validation failed").
    WithDetails(&errdetails.BadRequest{
        FieldViolations: []*errdetails.BadRequest_FieldViolation{
            {Field: "email", Description: "invalid format"},
        },
    })
return nil, st.Err()
```

### Interceptors

Interceptors are middleware for gRPC. Always use `grpc.ChainUnaryInterceptor` / `grpc.ChainStreamInterceptor` — chaining order matters (outermost first).

Recovery (prevent a panic from crashing the server):

```go
func recoveryInterceptor(log *slog.Logger) grpc.UnaryServerInterceptor {
    return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (resp any, err error) {
        defer func() {
            if r := recover(); r != nil {
                log.ErrorContext(ctx, "panic", "method", info.FullMethod,
                    "panic", r, "stack", string(debug.Stack()))
                err = status.Errorf(codes.Internal, "internal error")
            }
        }()
        return handler(ctx, req)
    }
}
```

Logging:

```go
func loggingInterceptor(log *slog.Logger) grpc.UnaryServerInterceptor {
    return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
        start := time.Now()
        resp, err := handler(ctx, req)
        code := codes.OK
        if err != nil { code = status.Code(err) }
        log.InfoContext(ctx, "grpc",
            "method", info.FullMethod,
            "code", code,
            "duration_ms", time.Since(start).Milliseconds(),
        )
        return resp, err
    }
}
```

Auth (extract token from metadata):

```go
func authInterceptor(authz Authorizer) grpc.UnaryServerInterceptor {
    return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
        md, ok := metadata.FromIncomingContext(ctx)
        if !ok { return nil, status.Error(codes.Unauthenticated, "missing metadata") }
        tokens := md.Get("authorization")
        if len(tokens) == 0 { return nil, status.Error(codes.Unauthenticated, "missing token") }
        claims, err := authz.Verify(tokens[0])
        if err != nil { return nil, status.Error(codes.Unauthenticated, "invalid token") }
        return handler(context.WithValue(ctx, claimsKey{}, claims), req)
    }
}
```

For streaming interceptors, same shape but `grpc.StreamServerInterceptor` wraps a `grpc.ServerStream`.

### Metadata

gRPC metadata = HTTP headers equivalent. Key-value, string pairs.

```go
// Client send
ctx = metadata.AppendToOutgoingContext(ctx,
    "x-request-id", reqID,
    "x-tenant",     tenantID,
)

// Server receive
md, ok := metadata.FromIncomingContext(ctx)
if !ok { ... }
reqID := md.Get("x-request-id")          // returns []string

// Server send response metadata
grpc.SetHeader(ctx, metadata.Pairs("x-rate-limit-remaining", "99"))
```

Binary metadata keys end with `-bin`; values are base64-encoded by the framework.

### Streaming Patterns

**Server streaming** — client sends one request, server pushes multiple responses. Use for: feed subscriptions, progress events, large result sets.

```go
func (s *Service) ListUsers(req *userv1.ListUsersRequest, stream userv1.UserService_ListUsersServer) error {
    for {
        u, err := cursor.Next()
        if err == io.EOF { return nil }
        if err != nil { return status.Errorf(codes.Internal, "cursor: %v", err) }
        if err := stream.Send(&userv1.GetUserResponse{Id: u.ID, Name: u.Name}); err != nil {
            return err   // client gone; err is already a gRPC status
        }
        select {
        case <-stream.Context().Done(): return stream.Context().Err()
        default:
        }
    }
}
```

**Client streaming** — client pushes multiple messages, server replies once. Use for: batch ingestion, chunked upload.

```go
func (s *Service) BatchCreate(stream userv1.UserService_BatchCreateServer) error {
    var created int
    for {
        req, err := stream.Recv()
        if err == io.EOF {
            return stream.SendAndClose(&userv1.BatchCreateResponse{Created: int32(created)})
        }
        if err != nil { return err }
        if err := s.repo.Save(stream.Context(), toUser(req)); err != nil {
            return status.Errorf(codes.Internal, "save: %v", err)
        }
        created++
    }
}
```

**Bidi streaming** — both sides send concurrently. Use for: chat, real-time sync, control planes.

```go
func (s *Service) Chat(stream userv1.UserService_ChatServer) error {
    g, ctx := errgroup.WithContext(stream.Context())
    g.Go(func() error {
        for {
            msg, err := stream.Recv()
            if err == io.EOF || errors.Is(err, context.Canceled) { return nil }
            if err != nil { return err }
            s.broadcast(msg)
        }
    })
    g.Go(func() error {
        for {
            select {
            case msg := <-s.outbox:
                if err := stream.Send(msg); err != nil { return err }
            case <-ctx.Done(): return nil
            }
        }
    })
    return g.Wait()
}
```

Rules for streaming:
- Always check `stream.Context().Done()` in send loops — the client may disconnect.
- `stream.Send` and `stream.Recv` are **not safe** for concurrent use on the same stream per type. Use two goroutines (one send, one recv) as shown in bidi.
- For large payloads, stream chunks rather than one huge message — the default max message size is 4 MiB (server) / unlimited (client send).
- Set `grpc.MaxCallRecvMsgSize` / `MaxCallSendMsgSize` explicitly on both sides.

### Deadlines and Timeouts

gRPC propagates deadlines across hops automatically via `grpc-timeout` header. The downstream service sees the remaining budget, not a fresh timeout.

```go
// Client
ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
defer cancel()
resp, err := client.GetUser(ctx, req)
```

Server always checks and respects the incoming deadline — it's in `ctx`. Don't set a *longer* deadline than the parent: a child context can only shorten, never extend. If downstream needs more time, it must detach (see Context Cancellation section) — which is almost always wrong for RPC.

### Load Balancing

gRPC connections are long-lived HTTP/2 — a single TCP connection carries all RPCs. A round-robin DNS load balancer routes at TCP level, not RPC level. Use client-side load balancing:

```go
conn, _ := grpc.NewClient("dns:///user-svc:9090",
    grpc.WithDefaultServiceConfig(`{"loadBalancingConfig": [{"round_robin":{}}]}`),
    // ...
)
```

`dns:///` triggers periodic re-resolution. For service meshes (Istio, Linkerd) this is handled transparently — don't fight it.

For fine-grained control, use `xds:///` with a control plane or a gRPC-aware LB (Envoy, grpc-lb).

### TLS and mTLS

```go
// Server — TLS
creds, err := credentials.NewServerTLSFromFile("cert.pem", "key.pem")
srv := grpc.NewServer(grpc.Creds(creds))

// Server — mTLS (require client cert)
tlsCfg := &tls.Config{
    ClientAuth: tls.RequireAndVerifyClientCert,
    ClientCAs:  certPool,
}
srv := grpc.NewServer(grpc.Creds(credentials.NewTLS(tlsCfg)))

// Client — mTLS
cert, _ := tls.LoadX509KeyPair("client.pem", "client-key.pem")
conn, _ := grpc.NewClient(addr, grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{
    Certificates: []tls.Certificate{cert},
    RootCAs:      certPool,
})))
```

mTLS is the preferred auth mechanism for internal service-to-service calls — no header tokens to leak, certificate rotation is auditable.

### Health Checking

Standard `grpc_health_v1.HealthServer`:

```go
healthSrv := health.NewServer()
grpc_health_v1.RegisterHealthServer(srv, healthSrv)
healthSrv.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)    // overall
healthSrv.SetServingStatus("user.v1.UserService", grpc_health_v1.HealthCheckResponse_SERVING)

// During shutdown, flip before GracefulStop
healthSrv.SetServingStatus("", grpc_health_v1.HealthCheckResponse_NOT_SERVING)
srv.GracefulStop()
```

k8s liveness/readiness can use `grpc_health_probe` binary or the native gRPC health protocol (k8s 1.24+ natively supports gRPC probes).

### Graceful Stop

```go
// Signal received
healthSrv.SetServingStatus("", grpc_health_v1.HealthCheckResponse_NOT_SERVING)

stopDone := make(chan struct{})
go func() {
    srv.GracefulStop()        // waits for in-flight RPCs; drains streams
    close(stopDone)
}()
select {
case <-stopDone:
case <-shutdownCtx.Done():   // budget exceeded — force
    srv.Stop()
}
```

`GracefulStop` stops accepting new connections and waits for in-flight RPCs to complete. Pair it with a budget from the shutdown ctx.

### Testing

Unit test service handlers with a real in-process server — no mocks for the transport:

```go
func TestUserService_GetUser(t *testing.T) {
    repo := newFakeRepo()
    repo.users["u1"] = &User{ID: "u1", Name: "alice"}

    srv := grpc.NewServer()
    userv1.RegisterUserServiceServer(srv, NewService(repo))

    lis := bufconn.Listen(1 << 20)           // in-memory connection
    t.Cleanup(func() { srv.Stop() })
    go srv.Serve(lis)

    conn, _ := grpc.NewClient("passthrough:///test",
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
            return lis.DialContext(ctx)
        }),
    )
    t.Cleanup(func() { conn.Close() })

    client := userv1.NewUserServiceClient(conn)
    resp, err := client.GetUser(t.Context(), &userv1.GetUserRequest{Id: "u1"})
    if err != nil { t.Fatal(err) }
    if resp.Name != "alice" { t.Errorf("got %q want alice", resp.Name) }
}
```

`google.golang.org/grpc/test/bufconn` provides in-memory transport — full gRPC semantics, no OS sockets.

For interceptor testing, inject them in the `grpc.NewServer()` call.

### Performance

- Default max message size 4 MiB — tune via `grpc.MaxCallRecvMsgSize`.
- Keepalives prevent idle connection drops by NAT / LBs:

  ```go
  grpc.WithKeepaliveParams(keepalive.ClientParameters{
      Time:                10 * time.Second,
      Timeout:             3 * time.Second,
      PermitWithoutStream: true,
  })
  ```

  Server counterpart: `grpc.KeepaliveEnforcementPolicy` — match client settings or the server will close the connection.
- Connection pooling: gRPC multiplexes over one connection. Multiple `conn` objects are wasteful. Share one `grpc.ClientConn` per target across the process lifetime.
- Protobuf is fast, but allocation is still the cost. Use `protoc-gen-go` field reuse patterns for very hot paths (avoid for most code).
- Use `otelgrpc` stats handler, not interceptors, for lower overhead — the stats handler is called once per message, not per frame.

### Anti-Patterns

- Recreating `grpc.ClientConn` per request — expensive, defeats connection multiplexing.
- Returning bare Go `error` from server handlers — must be a `status.Error`, otherwise the client gets `codes.Unknown`.
- Ignoring `stream.Context().Done()` in server send loops — goroutine leaked until the stream is garbage-collected.
- `reflection.Register` in prod on sensitive services — exposes the full service definition.
- Hardcoded `localhost` targets — use the `dns:///` scheme so resolution is dynamic.
- `status.Error(codes.Internal, err.Error())` — leaks internal error detail to the client. Use generic message; log detail internally.
- Calling `GracefulStop` without a deadline — hangs if a stream never completes.
- Mixing unary and streaming semantics in the same RPC — define separate RPCs; don't abuse empty fields as control messages.
- Sending one huge proto instead of streaming chunks — hits message size limit and gives no progress feedback.

### gRPC Checklist

```
[ ] .proto files linted with buf lint; breaking changes blocked in CI
[ ] Generated code committed or generated reproducibly in CI
[ ] otelgrpc stats handler on server + client (not interceptor — lower overhead)
[ ] ChainUnaryInterceptor + ChainStreamInterceptor: recovery → logging → auth
[ ] domain errors mapped to correct gRPC codes at the service boundary
[ ] client re-maps gRPC status codes back to domain errors
[ ] metadata used for cross-cutting concerns (request-id, tenant, auth)
[ ] grpc_health_v1 registered; SetServingStatus flipped before GracefulStop
[ ] GracefulStop paired with a deadline; fallback srv.Stop() on budget expiry
[ ] TLS on all connections; mTLS for service-to-service
[ ] dns:/// scheme + round_robin for client-side load balancing
[ ] Keepalive params set on client + matching enforcement policy on server
[ ] One shared grpc.ClientConn per target per process
[ ] bufconn-based in-process tests for handlers; fakes for repo layer
[ ] reflection.Register gated behind dev/staging flag only
[ ] Max message size explicitly set on both sides
[ ] Stream send/recv loops check ctx.Done(); use errgroup for bidi
```

---

## Message Queues (Kafka / RabbitMQ)

Message queues decouple producers from consumers in time and space. Use them for: async work that survives producer restarts, fan-out to multiple consumers, rate-mismatch absorption, event sourcing, cross-service integration where you don't need a synchronous answer.

**When NOT to use:** if you need a response in the same request, use gRPC or HTTP. Queues add at-least-once delivery complexity; every consumer must be idempotent. That cost must be justified.

### Kafka

Kafka is a distributed, ordered, durable log. Each **topic** is split into **partitions**; each **consumer group** gets one independent offset per partition. Messages within a partition are ordered; across partitions, they are not.

**Library choice:**
- `segmentio/kafka-go` — idiomatic Go, no CGo, easier to test.
- `confluentinc/confluent-kafka-go` — wraps librdkafka (CGo), most battle-tested, best performance.
- `IBM/sarama` — pure Go, wide adoption but verbose API.

Pick one and stick to it. Examples below use `kafka-go`.

#### Producer

```go
import "github.com/segmentio/kafka-go"

type Producer struct {
    w *kafka.Writer
}

func NewProducer(brokers []string) *Producer {
    return &Producer{
        w: &kafka.Writer{
            Addr:                   kafka.TCP(brokers...),
            Balancer:               &kafka.LeastBytes{},    // or Hash for key-based routing
            RequiredAcks:           kafka.RequireAll,       // acks from all in-sync replicas
            Async:                  false,                  // sync by default — no silent drops
            MaxAttempts:            5,
            BatchTimeout:           5 * time.Millisecond,
            WriteTimeout:           10 * time.Second,
            AllowAutoTopicCreation: false,                  // create topics explicitly in prod
        },
    }
}

func (p *Producer) Publish(ctx context.Context, topic string, key, value []byte) error {
    return p.w.WriteMessages(ctx, kafka.Message{
        Topic: topic,
        Key:   key,
        Value: value,
        Headers: []kafka.Header{
            {Key: "content-type", Value: []byte("application/json")},
        },
    })
}

func (p *Producer) Close() error { return p.w.Close() }
```

Rules:
- `RequiredAcks: RequireAll` — waits for all in-sync replicas. Never `RequireNone` for durable events.
- `Async: false` by default. Async drops errors silently unless you provide a `Completion` callback.
- Key determines partition. Same key → same partition → ordered delivery to a consumer. Empty key → round-robin.
- Close the writer on shutdown to flush the batch and commit final acks.
- For exactly-once semantics: use idempotent producers (`kafka.Writer` + `RequiredAcks: RequireAll` + broker `enable.idempotence=true`) combined with transactional APIs (available in `confluent-kafka-go`).

#### Consumer Group

```go
func NewConsumerGroup(brokers []string, topic, groupID string) *kafka.Reader {
    return kafka.NewReader(kafka.ReaderConfig{
        Brokers:        brokers,
        Topic:          topic,
        GroupID:        groupID,
        MinBytes:       10e3,                              // 10 KB
        MaxBytes:       10e6,                              // 10 MB
        MaxWait:        500 * time.Millisecond,
        CommitInterval: 0,                                 // 0 = manual commit
        StartOffset:    kafka.LastOffset,                  // or FirstOffset for replay
    })
}

func runConsumer(ctx context.Context, r *kafka.Reader, handle func(context.Context, kafka.Message) error) error {
    for {
        msg, err := r.FetchMessage(ctx)
        if err != nil {
            if errors.Is(err, context.Canceled) || errors.Is(err, io.EOF) { return nil }
            return fmt.Errorf("fetch: %w", err)
        }

        if err := handle(ctx, msg); err != nil {
            // Do NOT commit — message will be redelivered
            return fmt.Errorf("handle offset %d: %w", msg.Offset, err)
        }

        if err := r.CommitMessages(ctx, msg); err != nil {
            return fmt.Errorf("commit offset %d: %w", msg.Offset, err)
        }
    }
}
```

Rules:
- `FetchMessage` + `CommitMessages` (manual commit). Never `ReadMessage` (auto-commits before processing — risks silent loss on crash).
- Commit **only after** successful processing. Failure before commit = redelivery. Handler must be idempotent.
- `CommitInterval: 0` — manual. Avoid auto-commit intervals unless you accept at-most-once semantics.
- One `kafka.Reader` per goroutine. They are not safe for concurrent use.
- Close the reader on shutdown: `r.Close()` triggers the next `FetchMessage` to return `io.EOF`.

#### Partitioning Strategy

| Goal                                    | Key strategy                                |
|-----------------------------------------|---------------------------------------------|
| Ordered processing per entity           | Entity ID (user ID, order ID)               |
| Maximize parallelism                    | Empty key (round-robin)                     |
| Co-locate related events                | Tenant ID or aggregate ID                   |
| Geographic affinity                     | Region prefix                               |

Partition count is fixed at topic creation (re-partitioning = rebalance). Overestimate: 6–12 partitions per topic for a medium service.

#### Dead Letter Queue (DLQ)

```go
func runConsumerWithDLQ(ctx context.Context, r *kafka.Reader, dlq *Producer, handle func(context.Context, kafka.Message) error) error {
    for {
        msg, err := r.FetchMessage(ctx)
        if err != nil { return err }

        if err := handle(ctx, msg); err != nil {
            slog.ErrorContext(ctx, "handler failed, routing to DLQ",
                "topic", msg.Topic, "offset", msg.Offset, "error", err)
            dlqMsg := kafka.Message{
                Topic: msg.Topic + ".dlq",
                Key:   msg.Key,
                Value: msg.Value,
                Headers: append(msg.Headers,
                    kafka.Header{Key: "x-error", Value: []byte(err.Error())},
                    kafka.Header{Key: "x-original-offset", Value: []byte(strconv.FormatInt(msg.Offset, 10))},
                ),
            }
            if err := dlq.w.WriteMessages(ctx, dlqMsg); err != nil {
                return fmt.Errorf("dlq write: %w", err)  // DLQ write failed — stop, investigate
            }
        }

        if err := r.CommitMessages(ctx, msg); err != nil { return err }
    }
}
```

DLQ conventions:
- Name: `<topic>.dlq` or `<topic>.dead-letter`.
- Attach original topic, offset, error reason, timestamp as headers.
- Monitor DLQ depth as a metric. Alert on non-zero.
- Replay: a separate CLI reads the DLQ and republishes to the original topic after the bug is fixed.

#### Schema Registry

For teams with multiple producers/consumers and strict schema evolution:

```go
import "github.com/riferrei/srclient"

client := srclient.CreateSchemaRegistryClient("http://schema-registry:8081")
schema, err := client.GetLatestSchema("user-events-value")
if err != nil { return err }

// Confluent wire format: [0x00][4-byte schema ID][avro/protobuf payload]
var buf bytes.Buffer
buf.WriteByte(0x00)
binary.Write(&buf, binary.BigEndian, int32(schema.ID()))
// ... encode with schema ...
```

- Use Avro or Protobuf (not JSON) with the schema registry.
- Compatibility mode `BACKWARD` (default) — new schema can read old data. Set at the subject level.
- `buf` + Protobuf is an alternative to schema registry for teams already using gRPC.

#### Observability

```go
// Wrap handler for tracing + metrics
func tracedHandler(tracer trace.Tracer, next func(context.Context, kafka.Message) error) func(context.Context, kafka.Message) error {
    return func(ctx context.Context, msg kafka.Message) error {
        // Extract trace context from headers
        carrier := propagation.MapCarrier{}
        for _, h := range msg.Headers { carrier[h.Key] = string(h.Value) }
        ctx = otel.GetTextMapPropagator().Extract(ctx, carrier)

        ctx, span := tracer.Start(ctx, "consumer."+msg.Topic,
            trace.WithAttributes(
                attribute.String("messaging.system", "kafka"),
                attribute.String("messaging.destination", msg.Topic),
                attribute.Int64("messaging.kafka.partition", int64(msg.Partition)),
                attribute.Int64("messaging.kafka.offset", msg.Offset),
            ),
        )
        defer span.End()

        err := next(ctx, msg)
        if err != nil {
            span.RecordError(err)
            span.SetStatus(codes.Error, err.Error())
        }
        return err
    }
}
```

Metrics to export: consumer lag (critical — broker offset − committed offset), messages processed/s, processing latency histogram, DLQ depth, rebalance count.

Consumer lag via `kafka-go`:
```go
lag, err := r.ReadLag(ctx)    // returns lag for current partition
```

Or query the broker directly and export as a gauge.

---

### RabbitMQ

RabbitMQ implements AMQP. Producers publish to **exchanges**; exchanges route to **queues** via **bindings** and routing keys. Consumers read from queues.

**Library:** `rabbitmq/amqp091-go` (official, maintained fork of `streadway/amqp`).

#### Topology

Declare topology idempotently at startup (not in hot paths):

```go
func declareTopology(ch *amqp091.Channel) error {
    // Exchange — the routing hub
    if err := ch.ExchangeDeclare(
        "user.events",   // name
        "topic",         // type: direct | fanout | topic | headers
        true,            // durable
        false,           // auto-delete
        false,           // internal
        false,           // no-wait
        nil,
    ); err != nil { return fmt.Errorf("exchange: %w", err) }

    // Queue — the consumer's inbox
    if _, err := ch.QueueDeclare(
        "user.events.notifications",
        true,  // durable
        false, // auto-delete
        false, // exclusive
        false, // no-wait
        amqp091.Table{
            "x-dead-letter-exchange":    "user.events.dlx",
            "x-message-ttl":            int32(3600000),   // 1h TTL before DLQ
            "x-queue-type":             "quorum",         // quorum queue — preferred over classic
        },
    ); err != nil { return fmt.Errorf("queue: %w", err) }

    // Binding — pattern match: user.# = all user events
    return ch.QueueBind("user.events.notifications", "user.#", "user.events", false, nil)
}
```

Exchange types:
- `direct` — exact routing key match.
- `fanout` — broadcast to all bound queues (ignore routing key).
- `topic` — wildcard routing key (`user.#`, `*.created`). Most flexible.
- `headers` — match on header attributes. Rare.

**Quorum queues** over classic queues for new deployments — better durability, no data loss on node restart.

#### Publisher with Confirms

```go
type Publisher struct {
    conn    *amqp091.Connection
    ch      *amqp091.Channel
    confirms chan amqp091.Confirmation
}

func NewPublisher(url string) (*Publisher, error) {
    conn, err := amqp091.Dial(url)
    if err != nil { return nil, err }
    ch, err := conn.Channel()
    if err != nil { return nil, err }
    if err := ch.Confirm(false); err != nil { return nil, err }   // enable publisher confirms
    return &Publisher{conn: conn, ch: ch, confirms: ch.NotifyPublish(make(chan amqp091.Confirmation, 128))}, nil
}

func (p *Publisher) Publish(ctx context.Context, exchange, key string, body []byte) error {
    if err := p.ch.PublishWithContext(ctx, exchange, key, true, false, amqp091.Publishing{
        ContentType:  "application/json",
        DeliveryMode: amqp091.Persistent,       // survive broker restart
        Body:         body,
    }); err != nil { return fmt.Errorf("publish: %w", err) }

    select {
    case confirm := <-p.confirms:
        if !confirm.Ack { return errors.New("broker nacked message") }
    case <-ctx.Done():
        return ctx.Err()
    }
    return nil
}
```

Rules:
- `DeliveryMode: Persistent` — survives broker restart. Mandatory for durable events.
- Publisher confirms (`ch.Confirm`) — broker acks/nacks the message. Without it, `Publish` returns nil even if the message was dropped.
- `Mandatory: true` — returns error if no queue is bound. Prevents silent drops when routing is misconfigured.
- Channel is **not** goroutine-safe. One channel per goroutine. Connections can be shared.

#### Consumer with Manual Ack

```go
func RunConsumer(ctx context.Context, ch *amqp091.Channel, queue string, handle func(context.Context, amqp091.Delivery) error) error {
    if err := ch.Qos(32, 0, false); err != nil { // prefetch 32 messages
        return fmt.Errorf("qos: %w", err)
    }

    msgs, err := ch.ConsumeWithContext(ctx, queue,
        "",    // consumer tag (auto)
        false, // auto-ack — ALWAYS false; manual ack required
        false, // exclusive
        false, // no-local
        false, // no-wait
        nil,
    )
    if err != nil { return fmt.Errorf("consume: %w", err) }

    for {
        select {
        case <-ctx.Done(): return nil
        case msg, ok := <-msgs:
            if !ok { return errors.New("channel closed") }
            if err := handle(ctx, msg); err != nil {
                slog.ErrorContext(ctx, "handler failed",
                    "queue", queue, "deliveryTag", msg.DeliveryTag, "error", err)
                _ = msg.Nack(false, false)    // false, false = don't requeue → goes to DLX
                continue
            }
            if err := msg.Ack(false); err != nil {
                return fmt.Errorf("ack %d: %w", msg.DeliveryTag, err)
            }
        }
    }
}
```

Rules:
- `auto-ack: false` — always. Auto-ack removes the message before processing; a crash loses it.
- `msg.Ack(false)` after successful processing.
- `msg.Nack(false, false)` on failure with `requeue=false` → routes to dead-letter exchange. `requeue=true` risks infinite loops on poison messages.
- `ch.Qos(prefetchCount, 0, false)` — limits in-flight messages per consumer. Without it, the consumer pulls the entire queue into memory.

#### Connection Recovery

AMQP connections and channels drop (network blip, broker restart). The library does not auto-reconnect. Implement reconnection:

```go
func withReconnect(ctx context.Context, url string, run func(*amqp091.Connection) error) error {
    for {
        conn, err := amqp091.Dial(url)
        if err != nil {
            slog.Error("amqp dial", "error", err)
            select {
            case <-ctx.Done(): return nil
            case <-time.After(5 * time.Second): continue
            }
        }

        closed := make(chan *amqp091.Error, 1)
        conn.NotifyClose(closed)

        if err := run(conn); err != nil {
            slog.Error("amqp run", "error", err)
        }
        conn.Close()

        select {
        case <-ctx.Done(): return nil
        case amqpErr := <-closed:
            slog.Warn("amqp connection closed", "error", amqpErr)
            time.Sleep(2 * time.Second)    // backoff before reconnect
        }
    }
}
```

For production: exponential backoff with jitter; distinguish temporary vs permanent errors (`amqp091.Error.Recover`).

#### Dead Letter Exchange (DLX)

```go
// DLX — receives messages nacked with requeue=false
ch.ExchangeDeclare("user.events.dlx", "fanout", true, false, false, false, nil)
ch.QueueDeclare("user.events.dlq", true, false, false, false, nil)
ch.QueueBind("user.events.dlq", "#", "user.events.dlx", false, nil)
```

RabbitMQ attaches DLX metadata headers to dead-lettered messages: `x-death` (array of death records), `x-first-death-reason`, `x-first-death-exchange`.

---

### Transactional Outbox Pattern

The root problem: persisting to DB and publishing to a queue in the same request is a two-phase operation. One can succeed and the other fail, leaving state inconsistent.

```
           ┌─────────────────────────────────┐
           │         Application             │
           │                                 │
  request──▶  BEGIN TRANSACTION              │
           │  INSERT INTO users ...          │
           │  INSERT INTO outbox             │
           │    (topic, key, payload, status)│
           │  COMMIT                         │
           │                                 │
           │  ┌── Outbox Worker ────────┐    │
           │  │  SELECT WHERE status=   │    │
           │  │    'pending' FOR UPDATE │    │
           │  │  Publish to Kafka/AMQP  │    │
           │  │  UPDATE status='sent'   │    │
           │  └─────────────────────────┘    │
           └─────────────────────────────────┘
```

```go
// In the request handler (same DB transaction)
func (s *Service) CreateUser(ctx context.Context, tx *sql.Tx, u *User) error {
    if err := insertUser(ctx, tx, u); err != nil { return err }
    payload, _ := json.Marshal(UserCreatedEvent{ID: u.ID, Name: u.Name})
    _, err := tx.ExecContext(ctx,
        `INSERT INTO outbox (id, topic, key, payload, status, created_at)
         VALUES ($1, $2, $3, $4, 'pending', now())`,
        uuid.NewString(), "user.events", u.ID, payload)
    return err
}

// Outbox worker (separate goroutine, own DB connection)
func runOutboxWorker(ctx context.Context, db *sql.DB, pub Publisher) error {
    for {
        select {
        case <-ctx.Done(): return nil
        case <-time.After(500 * time.Millisecond):
        }
        if err := flushOutbox(ctx, db, pub); err != nil {
            slog.ErrorContext(ctx, "outbox flush", "error", err)
        }
    }
}

func flushOutbox(ctx context.Context, db *sql.DB, pub Publisher) error {
    tx, err := db.BeginTx(ctx, nil)
    if err != nil { return err }
    defer tx.Rollback()

    rows, err := tx.QueryContext(ctx,
        `SELECT id, topic, key, payload FROM outbox
         WHERE status = 'pending' ORDER BY created_at
         LIMIT 100 FOR UPDATE SKIP LOCKED`)
    if err != nil { return err }
    defer rows.Close()

    var ids []string
    for rows.Next() {
        var id, topic, key string; var payload []byte
        if err := rows.Scan(&id, &topic, &key, &payload); err != nil { return err }
        if err := pub.Publish(ctx, topic, key, payload); err != nil { return err }
        ids = append(ids, id)
    }
    if err := rows.Err(); err != nil { return err }
    if len(ids) == 0 { return tx.Commit() }

    _, err = tx.ExecContext(ctx,
        `UPDATE outbox SET status='sent' WHERE id = ANY($1)`, pq.Array(ids))
    if err != nil { return err }
    return tx.Commit()
}
```

Rules:
- `FOR UPDATE SKIP LOCKED` — multiple outbox workers run safely in parallel.
- Message delivery is at-least-once (worker may crash after publish, before UPDATE). Consumer must be idempotent.
- Archive or delete sent rows on a schedule — the table is a hot write target.
- Alternative: CDC (Change Data Capture) with Debezium reads the Postgres WAL and publishes directly. No outbox table, but requires Kafka Connect infrastructure.

---

### Common Patterns

**Competing consumers** — multiple goroutines read from the same consumer group / queue. Each message processed exactly once per group. Natural parallelism and failure isolation.

**Fan-out** — one event, multiple consumer groups (Kafka) or one exchange → multiple queues (RabbitMQ). Each group processes independently.

**Saga / choreography** — each service listens to events and publishes its own completion events. No central coordinator. Compensating transactions handle failures. Complex to debug; use a correlation ID on every message.

**Event sourcing** — the queue / log *is* the source of truth. State is rebuilt by replaying from offset 0. Kafka's `log.retention.bytes` / `cleanup.policy=compact` controls retention. Heavy design commitment; consider carefully.

---

### Testing

```go
// Kafka: use testcontainers
func startKafka(t *testing.T) string {
    if testing.Short() { t.Skip("integration") }
    ctx := t.Context()
    c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
        ContainerRequest: testcontainers.ContainerRequest{
            Image:        "confluentinc/cp-kafka:7.6.0",
            ExposedPorts: []string{"9092/tcp"},
            Env: map[string]string{
                "KAFKA_ADVERTISED_LISTENERS":             "PLAINTEXT://localhost:9092",
                "KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR": "1",
                "KAFKA_AUTO_CREATE_TOPICS_ENABLE":        "true",
            },
            WaitingFor: wait.ForListeningPort("9092/tcp"),
        },
        Started: true,
    })
    if err != nil { t.Fatal(err) }
    t.Cleanup(func() { _ = c.Terminate(ctx) })
    host, _ := c.Host(ctx)
    port, _ := c.MappedPort(ctx, "9092")
    return host + ":" + port.Port()
}

// RabbitMQ: testcontainers or rabbitmq.Run from testcontainers-go community module
```

For unit tests, abstract the broker behind an interface:

```go
type EventPublisher interface {
    Publish(ctx context.Context, topic string, key, value []byte) error
}

type inMemoryPublisher struct {
    mu   sync.Mutex
    msgs []Message
}
func (p *inMemoryPublisher) Publish(_ context.Context, topic string, key, value []byte) error {
    p.mu.Lock(); defer p.mu.Unlock()
    p.msgs = append(p.msgs, Message{Topic: topic, Key: key, Value: value})
    return nil
}
```

Fakes for unit tests; real broker via testcontainers for integration tests. Never mock `kafka.Writer` or `amqp091.Channel` — too brittle.

### Anti-Patterns

- Auto-ack / auto-commit before processing — risks losing messages on crash.
- `requeue: true` on failure with no retry count — infinite poison-pill loop. Use DLX/DLQ with a max-retry counter in headers.
- Publishing inside a DB transaction without the outbox pattern — two-phase risk.
- One goroutine per message — unbounded goroutine explosion under load. Use a worker pool.
- Consumers that do heavy compute inline — slows the consumer loop, grows lag. Offload to a worker pool or a separate stage.
- Fat messages — embedding full entity state. Prefer events with an ID; consumers fetch current state from the owning service. (Tradeoff: extra roundtrip. "Fat event" is OK when consumers need a snapshot and the source is write-heavy.)
- Ignoring consumer lag — the most important SLO metric for queues. Alert on it.
- Shared channels across goroutines (RabbitMQ) — channels are not thread-safe.
- Not closing the producer / channel on shutdown — buffered messages are lost.
- Schema changes without compatibility checks — breaks consumers silently.
- Topic / queue names without a versioning strategy — `user-events` becomes `user-events-v2` becomes unmaintainable.

### Message Queue Checklist

```
[ ] Consumers idempotent — at-least-once delivery is the contract
[ ] Manual ack/commit; commit only after successful processing
[ ] DLQ/DLX configured; depth monitored and alerted
[ ] Publisher confirms enabled (RabbitMQ) / RequireAll acks (Kafka)
[ ] Messages Persistent / durable queues / topics replicated ≥ 3
[ ] Outbox pattern for atomic DB write + publish; consumer idempotency
[ ] Prefetch (QoS) set to bound in-flight messages per consumer
[ ] Consumer lag exported as a metric; alert threshold defined
[ ] One channel per goroutine (RabbitMQ); one reader per goroutine (kafka-go)
[ ] Connection recovery loop with backoff (RabbitMQ)
[ ] Retry count tracked in headers; max-retry → DLQ, not infinite requeue
[ ] Schema compatibility enforced (buf breaking or schema registry)
[ ] Trace context propagated via message headers; consumer extracts span
[ ] Testing: in-memory fake for unit; testcontainers for integration
[ ] Producer closed on shutdown; unflushed batches committed
[ ] Consumer lag, DLQ depth, processing latency in dashboards/alerts
```

---

## Graceful Shutdown

A process that exits cleanly drops zero in-flight requests, flushes telemetry, releases DB connections, and signals readiness to the orchestrator. Crashing or `os.Exit(0)` mid-request is a defect — not "good enough."

### The Signal Contract

Kubernetes / systemd / Docker send `SIGTERM` and wait `terminationGracePeriodSeconds` (k8s default 30s) before `SIGKILL`. Your shutdown budget = that grace period **minus** load-balancer deregistration delay.

```go
ctx, stop := signal.NotifyContext(context.Background(),
    os.Interrupt, syscall.SIGTERM)
defer stop()       // restores default handlers; idempotent
```

- `SIGINT` (`os.Interrupt`) — local Ctrl-C.
- `SIGTERM` — orchestrator-initiated.
- `SIGKILL` — uncatchable. If you reach it, you over-ran the budget.
- `SIGHUP` — historically "reload config." Don't repurpose for shutdown.

Never `os.Exit` from a goroutine. Return from `main` so `defer`s run.

### Order of Operations

Shut down **producers before consumers**, **inbound before outbound**, **stateful sinks last**.

```
1. Flip readiness probe to NOT READY     → LB stops sending new traffic
2. (Wait deregistration window, e.g. 5s) → in-flight LB-routed requests drain
3. Stop accepting new work
   - http.Server.Shutdown                → finishes in-flight handlers
   - gRPC GracefulStop
   - message consumer.Pause / Unsubscribe
4. Cancel background workers (ctx cancel) and Wait()
5. Flush observability — log handler, trace exporter, metric exporter
6. Close DB pool, Redis client, RPC clients
7. Return from main
```

Skipping step 1 = dropping requests already in flight when the listener closes. Skipping step 5 = losing the last seconds of logs/traces — exactly the ones explaining why you shut down.

### Pattern: Process-Wide Shutdown

```go
func main() {
    ctx, stop := signal.NotifyContext(context.Background(),
        os.Interrupt, syscall.SIGTERM)
    defer stop()

    log := newLogger("prod")
    db := mustOpenDB(ctx)
    workers := startWorkers(ctx, db, log)
    srv := newServer(db, log)

    // Readiness gate — flipped to false at shutdown
    ready := &atomic.Bool{}
    ready.Store(true)
    srv.Handler = withReadiness(srv.Handler, ready)

    // Run server
    serverErr := make(chan error, 1)
    go func() {
        if err := srv.ListenAndServe(); err != nil &&
            !errors.Is(err, http.ErrServerClosed) {
            serverErr <- err
        }
        close(serverErr)
    }()

    select {
    case <-ctx.Done():
        log.Info("shutdown signal received")
    case err := <-serverErr:
        log.Error("server crashed", "error", err)
    }

    // 1. Mark not ready, give LB time to deregister
    ready.Store(false)
    time.Sleep(5 * time.Second)              // tune to your LB

    // 2. Total budget for the rest
    shutdownCtx, cancel := context.WithTimeout(
        context.Background(), 25*time.Second)
    defer cancel()

    // 3. Stop accepting new HTTP work; finish in-flight
    if err := srv.Shutdown(shutdownCtx); err != nil {
        log.Error("http shutdown", "error", err)
    }

    // 4. Cancel + drain workers
    workers.Stop(shutdownCtx)

    // 5. Flush telemetry
    _ = tracerProvider.Shutdown(shutdownCtx)
    _ = meterProvider.Shutdown(shutdownCtx)

    // 6. Close DB last — others may still be writing during step 3-5
    _ = db.Close()

    log.Info("shutdown complete")
}
```

### Readiness vs Liveness

- **Liveness** — "is the process alive?" Stays `200` until process dies. Failing liveness = restart.
- **Readiness** — "should I receive traffic?" Flipped to `503` first thing in shutdown. Failing readiness = drained, not restarted.

```go
func withReadiness(next http.Handler, ready *atomic.Bool) http.Handler {
    mux := http.NewServeMux()
    mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
        w.WriteHeader(http.StatusOK)              // liveness — always 200 while alive
    })
    mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
        if !ready.Load() { w.WriteHeader(503); return }
        w.WriteHeader(http.StatusOK)
    })
    mux.Handle("/", next)
    return mux
}
```

Pre-shutdown sleep gives the orchestrator a poll interval to notice. Without it, traffic still routes for several seconds after `Shutdown` starts.

### http.Server.Shutdown — What It Does

- Stops accepting new connections.
- Closes idle keep-alive connections immediately.
- Waits for active handlers to finish OR `ctx` deadline.
- Returns `ctx.Err()` if the deadline hits — at that point in-flight requests are abandoned. The handlers themselves are **not** canceled by `Shutdown` (Go 1.19+: pass `Server.BaseContext` returning a cancelable ctx to give yourself a hook).

To force cancellation of long handlers when the budget is short, derive each request ctx from a shutdown signal:

```go
shutdownCh := make(chan struct{})
srv.BaseContext = func(net.Listener) context.Context {
    ctx, cancel := context.WithCancel(context.Background())
    go func() { <-shutdownCh; cancel() }()
    return ctx
}
// ...later, before srv.Shutdown:
close(shutdownCh)
```

Use sparingly — preferable to budget enough time for handlers to finish on their own.

### Background Workers

Workers must:
1. Accept a ctx from the orchestrator.
2. Exit promptly when ctx is canceled (every loop has a `<-ctx.Done()` arm — see Cancellation section).
3. Expose `Stop(ctx)` that triggers cancel and **waits** for the goroutine(s) to drain, bounded by the caller's ctx.

```go
type Workers struct {
    cancel context.CancelFunc
    g      *errgroup.Group
}

func startWorkers(parent context.Context, ...) *Workers {
    ctx, cancel := context.WithCancel(parent)
    g, ctx := errgroup.WithContext(ctx)
    for i := 0; i < n; i++ {
        g.Go(func() error { return runWorker(ctx) })
    }
    return &Workers{cancel: cancel, g: g}
}

func (w *Workers) Stop(ctx context.Context) {
    w.cancel()
    done := make(chan error, 1)
    go func() { done <- w.g.Wait() }()
    select {
    case <-done:                        // clean drain
    case <-ctx.Done():                  // shutdown budget exceeded
    }
}
```

### In-Flight Work That Can't Be Dropped

For message consumers, RPC long-polls, or jobs without idempotency:
- Stop fetching new work first.
- Finish (or checkpoint) the message in hand.
- Acknowledge / commit offset before exit. Half-processed + acked = lost. Half-processed + un-acked = redelivery (handle idempotently on restart).

### Telemetry Flush

OpenTelemetry batch exporters hold spans/metrics in memory until the export tick. Always call `Shutdown(ctx)` on TracerProvider and MeterProvider before exit — they flush + close.

slog `JSONHandler` writes to `os.Stdout` line-buffered; no explicit flush. If using a buffered writer or remote shipper, call its `Close`/`Sync`.

### Budget Allocation

Given a 30s k8s grace period:

| Phase                          | Budget |
|--------------------------------|--------|
| LB deregistration sleep        | 5s     |
| http.Server.Shutdown           | 15s    |
| Worker drain                   | 5s     |
| Telemetry flush                | 3s     |
| Margin (in case any overruns)  | 2s     |

Pass child contexts with explicit timeouts, not a single shared one. Otherwise a slow phase consumes the entire budget and starves the next.

### Anti-Patterns

- `os.Exit(0)` at end of `main` (or anywhere). Defers don't run.
- `log.Fatal` / `log.Panic` in non-startup paths — bypasses shutdown.
- Calling `srv.Shutdown(context.Background())` — no deadline, can hang forever.
- Closing DB before in-flight handlers complete — they fail with "use of closed connection."
- Skipping the readiness gate / pre-shutdown sleep — drops traffic that's already on the way.
- Catching `SIGTERM` and exiting immediately. Defeats the grace period.
- Per-request goroutines without a `WaitGroup` / errgroup — `Shutdown` can't see them, so it returns "clean" while orphans keep running.
- Re-using `signal.Notify` channels without `signal.Stop` — leaks notifications across tests.
- Long deferred cleanup in `main` without a budget — drift past `SIGKILL`.

### Testing Shutdown

- Unit-test `Stop(ctx)` semantics: cancel happens, `Wait` returns, deadline respected.
- Integration: start the server, fire a slow request, send `SIGTERM`, assert the slow request completes and new requests get 503 (or connection refused after Shutdown).
- Chaos / soak test: shutdown under load, count dropped vs completed requests. Should be zero dropped if budget is right.

### Graceful Shutdown Checklist

```
[ ] signal.NotifyContext used; SIGTERM + SIGINT handled
[ ] Readiness probe flips to 503 first; sleep ≥ LB poll interval
[ ] http.Server.Shutdown with explicit timeout context
[ ] Workers expose Stop(ctx) that cancels and Waits, bounded by caller ctx
[ ] Message consumers stop fetching, finish in-hand, ack, then exit
[ ] TracerProvider.Shutdown / MeterProvider.Shutdown called
[ ] DB / Redis / RPC clients Close()'d after server + workers stopped
[ ] No os.Exit, log.Fatal, log.Panic outside startup
[ ] Each shutdown phase has its own deadline; total fits in grace period
[ ] Integration test exercises shutdown under load with zero dropped requests
```

---

## Database / SQL

`database/sql` is a connection-pool + driver abstraction, not an ORM. Most production Go services use it directly or with a thin layer (`sqlx`, `sqlc`, `pgx`). Avoid `gorm` for anything non-trivial — magic plus reflection hides the queries and the lifecycle.

### Driver Choice

- **PostgreSQL**: `jackc/pgx/v5` directly (native, faster, better types) or via `pgx/stdlib` adapter when you need the `database/sql` interface for tooling.
- **MySQL**: `go-sql-driver/mysql`.
- **SQLite**: `mattn/go-sqlite3` (cgo) or `modernc.org/sqlite` (pure Go, slower).
- **Code generation**: `sqlc` — write SQL, generate typed Go. Beats hand-written `Scan` calls and beats ORMs.

### Connection Pool Configuration

Defaults are **wrong** for production. Always set:

```go
db, err := sql.Open("pgx", dsn)
if err != nil { return err }

db.SetMaxOpenConns(25)              // cap total — sized to DB max_connections / replicas
db.SetMaxIdleConns(25)              // keep idle == max to avoid churn
db.SetConnMaxLifetime(30*time.Minute) // recycle to handle DNS / failover / proxies
db.SetConnMaxIdleTime(5*time.Minute)  // free truly idle
```

Rules:
- `MaxOpenConns` × replicas ≤ DB server connection limit (leave headroom for migrations, admin, pgbouncer).
- `MaxIdleConns` ≥ `MaxOpenConns` to avoid open/close churn (otherwise idle conns are aggressively closed).
- `ConnMaxLifetime` is non-optional behind any load balancer / proxy / cloud DB. 30m is a common starting point.
- `sql.Open` does **not** connect. Call `db.PingContext(ctx)` at startup with a short timeout to fail fast.

### Always Pass Context

```go
// WRONG
rows, err := db.Query("SELECT ...")

// RIGHT
rows, err := db.QueryContext(ctx, "SELECT ...")
```

`db.Query`, `db.Exec`, `db.QueryRow`, `Tx.Query`, etc., all have `Context` variants. Use only the `*Context` ones. Cancellation + deadlines depend on it; without ctx, a slow query holds a connection until completion.

### Always Close Rows

```go
rows, err := db.QueryContext(ctx, q, args...)
if err != nil { return err }
defer rows.Close()             // releases the connection back to the pool

for rows.Next() {
    if err := rows.Scan(&x, &y); err != nil { return err }
    // ...
}
if err := rows.Err(); err != nil { return err }   // CHECK — Next() returning false hides errors
```

Forgetting `rows.Close()` leaks connections. Forgetting `rows.Err()` hides scan / IO failures.

`golangci-lint` rule: `sqlclosecheck`. Enable it.

### Single-Row Query

```go
var u User
err := db.QueryRowContext(ctx, `SELECT id, name FROM users WHERE id=$1`, id).
    Scan(&u.ID, &u.Name)
switch {
case errors.Is(err, sql.ErrNoRows):
    return ErrUserNotFound
case err != nil:
    return fmt.Errorf("user %d: %w", id, err)
}
```

`sql.ErrNoRows` is the **only** way to distinguish "not found" from "error". Always check it explicitly.

### Always Parameterize

```go
// SQL INJECTION — NEVER
db.QueryContext(ctx, "SELECT * FROM u WHERE name='"+name+"'")

// SAFE
db.QueryContext(ctx, "SELECT * FROM u WHERE name=$1", name)
```

No exceptions, no "but it's an internal user". Identifiers (table/column names) can't be parameterized — validate against an allowlist if dynamic.

### Transactions

```go
tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
if err != nil { return err }
defer tx.Rollback()                       // safe no-op after Commit

if _, err := tx.ExecContext(ctx, q1, args1...); err != nil { return err }
if _, err := tx.ExecContext(ctx, q2, args2...); err != nil { return err }

return tx.Commit()
```

Rules:
- `defer tx.Rollback()` immediately after `BeginTx`. Becomes a no-op after `Commit`. Catches every early-return path.
- Specify isolation explicitly. Default varies by driver/DB; don't rely on it.
- Pass `tx` (not `db`) to all calls inside the transaction. A common bug: helper function takes `*sql.DB` and bypasses the active `tx`. Fix by accepting an interface that both satisfy:

  ```go
  type DBTX interface {
      ExecContext(context.Context, string, ...any) (sql.Result, error)
      QueryContext(context.Context, string, ...any) (*sql.Rows, error)
      QueryRowContext(context.Context, string, ...any) *sql.Row
  }
  ```

- Short transactions. Long ones hold locks and connections. No HTTP / RPC / sleep inside a `tx`.
- Don't nest transactions in `database/sql` (no real nesting). Use savepoints if needed, or restructure.
- Retry on serialization failure (`SQLSTATE 40001` for Postgres, `1213` deadlock for MySQL) — only safe if the transaction body is idempotent.

### NULL Handling

`Scan` into a `string` fails on NULL. Use:
- `sql.NullString`, `sql.NullInt64`, `sql.NullTime` for stdlib.
- `*string`, `*int` pointers — nil means NULL. Cleaner for JSON encoding.
- `pgx` native types (`pgtype.Text`, etc.) when using pgx directly.

Don't `COALESCE(col, '')` in SQL to avoid NULL handling — it loses information.

### Prepared Statements

`database/sql` prepares + caches per connection automatically. Manual `db.Prepare` is rarely a win and complicates pooling (the stmt is bound to a connection). Use only for tight hot loops with the same query, and benchmark.

### Migrations

Schema is code. Versioned, checked in, applied at deploy.

- `golang-migrate/migrate`, `pressly/goose`, or `atlas` — pick one.
- Up + down for every migration. Test the down.
- Migrations run **before** the new binary starts serving. Coordinate with deploy.
- Never edit a committed migration after merge. Add a new one.
- Backwards-compatible schema for rolling deploys: add column nullable → backfill → make NOT NULL in a second migration. Drop column only after all binaries no longer reference it.

### Observability

- Wrap the driver for tracing: `XSAM/otelsql` for OpenTelemetry. Spans on every query, attributes for SQL + duration.
- Expose pool stats: `db.Stats()` → emit `OpenConnections`, `InUse`, `Idle`, `WaitCount`, `WaitDuration` as gauges/counters. `WaitDuration` rising = pool exhaustion.
- Log slow queries at the application layer (or use `pg_stat_statements` on Postgres). Don't log every query.

### Testing

- **No mocks for `*sql.DB`.** Use a real database:
  - `testcontainers-go` to spin up Postgres per test suite.
  - Or `dockertest`.
  - Or a shared dev DB with per-test schema isolation (`SET search_path` / transaction-per-test rolled back).
- Fast variant: `pgx` against an in-memory Postgres-compatible (none are truly compatible — accept the testcontainer cost).
- Avoid `sqlite` as a substitute for Postgres in tests. Dialect differences (JSONB, arrays, `RETURNING`, upsert syntax) will bite.

### Anti-Patterns

- `db.Query` (no Context) — kills cancellation.
- Missing `rows.Close()` / `rows.Err()`.
- `SELECT *` in production code — schema changes silently break Scan order.
- String-concatenation queries.
- ORM with auto-migrate on startup — schema changes via reflection on struct edits. Use explicit migrations.
- Storing `*sql.Tx` in a struct that outlives one operation.
- Default pool settings.

### SQL Checklist

```
[ ] MaxOpenConns, MaxIdleConns, ConnMaxLifetime, ConnMaxIdleTime all set
[ ] db.PingContext at startup; fail fast on bad DSN
[ ] All queries use *Context variants
[ ] Every rows.Close() deferred; rows.Err() checked after the loop
[ ] sql.ErrNoRows handled explicitly with errors.Is
[ ] Parameterized queries everywhere; identifiers from allowlist
[ ] Transactions short, isolation explicit, defer Rollback after BeginTx
[ ] Helpers accept DBTX-style interface so they work in or out of a tx
[ ] NULL-able columns use Null* types or pointers
[ ] Pool stats exported; slow queries observable
[ ] Tests hit a real DB (testcontainers), not a mock
[ ] sqlclosecheck enabled in golangci-lint
```

---

## Cache Patterns (Redis)

A cache is a performance optimisation, not a source of truth. Design for the possibility that the cache is empty, wrong, or unavailable — the system must still function (degraded is acceptable; broken is not).

**When to cache:**
- Read-heavy, write-rare data with expensive computation or I/O.
- Session state that must survive across instances.
- Rate-limit counters, distributed locks, pub/sub coordination.
- Result sets shared across many users (product catalogue, config, feature flags).

**When NOT to cache:**
- Data that must always be fresh (financial balances, inventory counts). Cache it only with a TTL short enough that stale reads are acceptable — or don't.
- When cache invalidation is complex enough to introduce bugs. The source of truth is simpler.

### Client Setup (go-redis)

```go
import "github.com/redis/go-redis/v9"

func newRedisClient(cfg Config) *redis.Client {
    rdb := redis.NewClient(&redis.Options{
        Addr:            cfg.RedisAddr,         // "host:6379"
        Password:        cfg.RedisPassword,
        DB:              0,
        MaxRetries:      3,
        MinRetryBackoff: 8 * time.Millisecond,
        MaxRetryBackoff: 512 * time.Millisecond,
        DialTimeout:     5 * time.Second,
        ReadTimeout:     3 * time.Second,
        WriteTimeout:    3 * time.Second,
        PoolSize:        10,                    // per CPU or per service — profile
        MinIdleConns:    5,
        ConnMaxIdleTime: 5 * time.Minute,
        ConnMaxLifetime: 30 * time.Minute,
    })
    return rdb
}
```

Cluster:

```go
rdb := redis.NewClusterClient(&redis.ClusterOptions{
    Addrs:    []string{"node1:6379", "node2:6379", "node3:6379"},
    PoolSize: 10,
})
```

Sentinel (HA failover):

```go
rdb := redis.NewFailoverClient(&redis.FailoverOptions{
    MasterName:    "mymaster",
    SentinelAddrs: []string{"sentinel1:26379", "sentinel2:26379"},
})
```

Always call `rdb.Ping(ctx)` at startup. Fail fast on misconfigured address — don't let the service start without a working cache if it's load-bearing.

### Pattern 1: Cache-Aside (Lazy Loading)

Read from cache; on miss, read from source and populate. Most common pattern.

```go
func (s *Service) GetUser(ctx context.Context, id string) (*User, error) {
    key := "user:" + id

    // 1. Try cache
    val, err := s.rdb.Get(ctx, key).Bytes()
    if err == nil {
        var u User
        if err := json.Unmarshal(val, &u); err == nil {
            return &u, nil
        }
    }
    if err != nil && !errors.Is(err, redis.Nil) {
        // Cache unavailable — log, continue to DB (degrade gracefully)
        s.log.WarnContext(ctx, "cache get failed", "key", key, "error", err)
    }

    // 2. Miss — read from source
    u, err := s.repo.Get(ctx, id)
    if err != nil { return nil, err }

    // 3. Populate cache (best-effort, don't fail the request on error)
    if data, err := json.Marshal(u); err == nil {
        ttl := 5*time.Minute + jitter(30*time.Second)   // jitter prevents stampede
        if err := s.rdb.Set(ctx, key, data, ttl).Err(); err != nil {
            s.log.WarnContext(ctx, "cache set failed", "key", key, "error", err)
        }
    }

    return u, nil
}

func jitter(max time.Duration) time.Duration {
    return time.Duration(rand.Int63n(int64(max)))
}
```

Rules:
- Cache errors on GET are **warnings**, not failures — degrade to the source.
- Cache errors on SET are **warnings** — the request still succeeds.
- Add jitter to TTLs. Identical TTLs cause thundering herd when many keys expire simultaneously.
- Never return an error solely because the cache is unavailable.

### Pattern 2: Read-Through

The cache layer fetches from the source on miss automatically. Same as cache-aside but encapsulated:

```go
type Cache[T any] struct {
    rdb    *redis.Client
    fetch  func(ctx context.Context, key string) (T, error)
    ttl    time.Duration
    prefix string
}

func (c *Cache[T]) Get(ctx context.Context, id string) (T, error) {
    key := c.prefix + id
    val, err := c.rdb.Get(ctx, key).Bytes()
    if err == nil {
        var v T
        if err := json.Unmarshal(val, &v); err == nil { return v, nil }
    }

    v, err := c.fetch(ctx, id)
    if err != nil { return v, err }

    if data, err := json.Marshal(v); err == nil {
        _ = c.rdb.Set(ctx, key, data, c.ttl).Err()
    }
    return v, nil
}
```

### Pattern 3: Write-Through

Write to DB and cache atomically. Cache always warm; no cold misses after first write.

```go
func (s *Service) UpdateUser(ctx context.Context, u *User) error {
    if err := s.repo.Save(ctx, u); err != nil { return err }

    data, err := json.Marshal(u)
    if err != nil { return err }
    key := "user:" + u.ID
    if err := s.rdb.Set(ctx, key, data, 5*time.Minute).Err(); err != nil {
        s.log.WarnContext(ctx, "cache write-through failed", "key", key, "error", err)
        // Delete the key to avoid serving stale data from here on
        _ = s.rdb.Del(ctx, key).Err()
    }
    return nil
}
```

Tradeoff: every write hits both DB and cache. For write-heavy workloads, use cache-aside instead.

### Pattern 4: Cache Invalidation

On mutation, delete the cache key rather than re-populating — avoids a race between the write and the re-populate:

```go
func (s *Service) DeleteUser(ctx context.Context, id string) error {
    if err := s.repo.Delete(ctx, id); err != nil { return err }
    if err := s.rdb.Del(ctx, "user:"+id).Err(); err != nil {
        s.log.WarnContext(ctx, "cache invalidation failed", "id", id, "error", err)
    }
    return nil
}
```

For invalidating groups of keys, use a namespace counter (logical versioning):

```go
// Bump the version of all "products" cache entries
func (s *Service) InvalidateAllProducts(ctx context.Context) error {
    return s.rdb.Incr(ctx, "products:version").Err()
}

// Build key including the version
func productKey(ctx context.Context, rdb *redis.Client, id string) (string, error) {
    v, err := rdb.Get(ctx, "products:version").Result()
    if err != nil { v = "1" }
    return "product:" + v + ":" + id, nil
}
```

Old keys expire naturally via TTL. No `SCAN` + bulk delete needed.

### Pattern 5: Stampede Prevention (Probabilistic Early Expiration)

When a hot key expires, thousands of requests hit the DB simultaneously — the **cache stampede**.

**Option A: singleflight** — deduplicate concurrent misses within a single instance:

```go
var sf singleflight.Group

func (s *Service) GetUser(ctx context.Context, id string) (*User, error) {
    v, err, _ := sf.Do("user:"+id, func() (any, error) {
        return s.getFromCacheOrDB(ctx, id)
    })
    if err != nil { return nil, err }
    return v.(*User), nil
}
```

**Option B: Probabilistic early expiration (PER)** — recompute before the key actually expires, probabilistically, so one request pays the cost while others still serve the cached value:

```go
func (s *Service) GetWithPER(ctx context.Context, key string, ttl time.Duration, fetch func() ([]byte, error)) ([]byte, error) {
    type stored struct {
        Data    []byte    `json:"d"`
        Expires time.Time `json:"e"`
    }

    val, err := s.rdb.Get(ctx, key).Bytes()
    if err == nil {
        var st stored
        if json.Unmarshal(val, &st) == nil {
            remaining := time.Until(st.Expires)
            // recompute if within 10% of TTL, with probability inversely proportional to remaining time
            if remaining > 0 && rand.Float64() > float64(remaining)/float64(ttl)*10 {
                return st.Data, nil
            }
        }
    }

    data, err := fetch()
    if err != nil { return nil, err }
    payload, _ := json.Marshal(stored{Data: data, Expires: time.Now().Add(ttl)})
    _ = s.rdb.Set(ctx, key, payload, ttl).Err()
    return data, nil
}
```

For most services, singleflight is sufficient. PER is for extremely hot keys under heavy traffic.

### Pipeline: Batch Commands

Reduce round-trips by sending multiple commands in one TCP write:

```go
pipe := s.rdb.Pipeline()
getA := pipe.Get(ctx, "key:a")
getB := pipe.Get(ctx, "key:b")
getC := pipe.Get(ctx, "key:c")
if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
    return err
}
valA, _ := getA.Result()
valB, _ := getB.Result()
valC, _ := getC.Result()
```

`TxPipeline()` wraps in `MULTI`/`EXEC` — atomic but not serializable. For true atomicity, use Lua.

**Bulk get with `MGET`:**

```go
keys := []string{"user:1", "user:2", "user:3"}
vals, err := s.rdb.MGet(ctx, keys...).Result()
// vals[i] is nil on miss
```

### Atomic Operations with Lua

Redis executes Lua scripts atomically. Use for operations that require read-then-write without a race:

```go
var incrIfExists = redis.NewScript(`
    local v = redis.call("GET", KEYS[1])
    if v == false then return 0 end
    return redis.call("INCR", KEYS[1])
`)

func (s *Service) IncrIfExists(ctx context.Context, key string) (int64, error) {
    return incrIfExists.Run(ctx, s.rdb, []string{key}).Int64()
}
```

`redis.NewScript` computes the SHA1 at construction; `Run` uses `EVALSHA` with a fallback to `EVAL` on cache miss. Safe for production — no hot-path string hashing.

### Distributed Lock (Redlock)

For coordinating work across instances — use `go-redis/redislock` or implement with `SET NX PX`:

```go
import "github.com/bsm/redislock"

locker := redislock.New(s.rdb)

lock, err := locker.Obtain(ctx, "lock:report:"+reportID, 30*time.Second, &redislock.Options{
    RetryStrategy: redislock.LinearBackoff(100 * time.Millisecond),
})
if errors.Is(err, redislock.ErrNotObtained) {
    return ErrAlreadyRunning
}
if err != nil { return err }
defer lock.Release(ctx)

return generateReport(ctx, reportID)
```

Manual implementation (when you can't add a dep):

```go
token := uuid.NewString()
ok, err := s.rdb.SetNX(ctx, "lock:"+key, token, 30*time.Second).Result()
if err != nil { return err }
if !ok { return ErrLocked }

defer func() {
    // Release only if we still own it — Lua for atomicity
    releaseScript.Run(ctx, s.rdb, []string{"lock:" + key}, token)
}()
```

```lua
-- release script
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
else
    return 0
end
```

Rules:
- Lock TTL must exceed the worst-case execution time of the locked work. If the work can run long, extend with `lock.Refresh(ctx, ttl, nil)`.
- Redlock (multi-node) provides better safety but adds complexity. Use for critical sections; for coordination in a single Redis setup, `SET NX PX` is usually sufficient.
- Locks are leases, not guarantees. Fencing tokens (incrementing counter) are needed for true mutual exclusion when the locked resource has no built-in version checking.

### Rate Limiting

Sliding window with sorted sets:

```go
var rateLimitScript = redis.NewScript(`
    local key   = KEYS[1]
    local limit = tonumber(ARGV[1])
    local now   = tonumber(ARGV[2])
    local window = tonumber(ARGV[3])

    redis.call("ZREMRANGEBYSCORE", key, 0, now - window)
    local count = redis.call("ZCARD", key)
    if count >= limit then return 0 end
    redis.call("ZADD", key, now, now)
    redis.call("EXPIRE", key, math.ceil(window / 1000))
    return 1
`)

func (s *Service) Allow(ctx context.Context, userID string, limit int, window time.Duration) (bool, error) {
    now := time.Now().UnixMilli()
    allowed, err := rateLimitScript.Run(ctx, s.rdb,
        []string{"ratelimit:" + userID},
        limit, now, window.Milliseconds(),
    ).Int()
    return allowed == 1, err
}
```

For simpler fixed-window: `INCR` + `EXPIRE`. Less accurate at window boundaries.

`golang.org/x/time/rate` for in-process limiting (cheaper, per-instance). Redis rate limiter for distributed, cross-instance limiting.

### Pub/Sub

```go
// Publisher
func (s *Service) PublishEvent(ctx context.Context, event Event) error {
    data, _ := json.Marshal(event)
    return s.rdb.Publish(ctx, "events:"+event.Type, data).Err()
}

// Subscriber
func (s *Service) Subscribe(ctx context.Context, patterns ...string) {
    sub := s.rdb.PSubscribe(ctx, patterns...)   // pattern subscribe
    defer sub.Close()

    ch := sub.Channel()
    for {
        select {
        case <-ctx.Done(): return
        case msg, ok := <-ch:
            if !ok { return }
            s.handle(ctx, msg.Channel, []byte(msg.Payload))
        }
    }
}
```

Redis pub/sub is fire-and-forget — messages are lost if no subscriber is listening at delivery time. Not durable. For durable messaging, use Redis Streams or Kafka/RabbitMQ.

**Redis Streams** (`XADD` / `XREADGROUP`) — persistent, consumer group semantics, ACK required. Closer to Kafka than pub/sub. Use when you need durability without a separate broker.

### TTL Strategy

| Data type                   | TTL recommendation                              |
|-----------------------------|--------------------------------------------------|
| User session                | 30m – 24h (sliding, reset on activity)          |
| Entity cache (user, product)| 5 – 30m + jitter                               |
| Short-lived token (CSRF, OTP)| Exact expiry, no jitter                        |
| Rate limit counter          | Window duration                                  |
| Distributed lock            | Worst-case task duration × 2                    |
| Computed aggregate          | Until next scheduled recomputation + 10%        |
| Feature flags               | 60s (frequent reload, low staleness tolerance)  |

Rules:
- All keys must have a TTL — no eternal keys unless you have a clear eviction/cleanup strategy.
- Monitor keyspace for keys without TTL: `redis-cli --scan | xargs redis-cli TTL | grep -c "^-1"`.
- Use `EXPIREAT` (absolute timestamp) for keys that expire on a business event (token valid until date X).

### Eviction Policy

Set in `redis.conf` or at runtime: `CONFIG SET maxmemory-policy`.

| Policy              | When to use                                     |
|---------------------|-------------------------------------------------|
| `allkeys-lru`       | Pure cache — evict least recently used          |
| `volatile-lru`      | Mix of cached + persistent keys; evict only TTL-keyed LRU |
| `allkeys-lfu`       | Hot-key skew — evict least frequently used      |
| `noeviction`        | Session store / primary storage — never evict, error instead |

Default is `noeviction` — changes behaviour from "cache" to "storage". For a cache, use `allkeys-lru`. Set `maxmemory` explicitly.

### Key Naming

```
<service>:<entity>:<id>
<service>:<entity>:<id>:<field>
<service>:lock:<resource>
<service>:ratelimit:<user_id>
<service>:session:<token>
```

- Colon as separator — Redis Cluster hashes on `{...}` notation for co-location: `product:{123}:price` and `product:{123}:stock` go to the same slot.
- Short key names reduce memory. At scale, `u:123` vs `user:123` matters.
- Document the namespace in a `KEYS.md` in the service repo — keyspace is a shared contract.

### Observability

`go-redis` provides hook interfaces:

```go
type metricsHook struct{ /* otel meter */ }

func (m *metricsHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
    return func(ctx context.Context, cmd redis.Cmder) error {
        start := time.Now()
        err := next(ctx, cmd)
        // record command latency, hit/miss, error
        m.histogram.Record(ctx, time.Since(start).Seconds(),
            metric.WithAttributes(
                attribute.String("cmd", cmd.Name()),
                attribute.Bool("error", err != nil && !errors.Is(err, redis.Nil)),
            ),
        )
        return err
    }
}

rdb.AddHook(&metricsHook{})
```

Or use `go-redis/extra/redisotel/v9` for automatic OTel tracing:

```go
import "github.com/redis/go-redis/extra/redisotel/v9"
redisotel.InstrumentTracing(rdb)
redisotel.InstrumentMetrics(rdb)
```

Metrics to track: hit rate (hits / (hits + misses)), latency histogram per command, connection pool saturation (`PoolStats`), evictions/s, memory usage.

Hit rate < 80% usually means TTL too short, keyspace too large, or poor key design.

```go
stats := rdb.PoolStats()
// stats.Hits, stats.Misses, stats.Timeouts, stats.TotalConns, stats.IdleConns
```

### Testing

```go
// Integration — testcontainers
func startRedis(t *testing.T) *redis.Client {
    if testing.Short() { t.Skip("integration") }
    ctx := t.Context()
    c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
        ContainerRequest: testcontainers.ContainerRequest{
            Image:        "redis:7-alpine",
            ExposedPorts: []string{"6379/tcp"},
            WaitingFor:   wait.ForListeningPort("6379/tcp"),
        },
        Started: true,
    })
    if err != nil { t.Fatal(err) }
    t.Cleanup(func() { _ = c.Terminate(ctx) })
    host, _ := c.Host(ctx)
    port, _ := c.MappedPort(ctx, "6379")
    return redis.NewClient(&redis.Options{Addr: host + ":" + port.Port()})
}

// Unit — in-memory fake implementing the cache interface
type noopCache struct{}
func (noopCache) Get(_ context.Context, _ string) ([]byte, error) { return nil, ErrMiss }
func (noopCache) Set(_ context.Context, _, _ string, _ time.Duration) error { return nil }
func (noopCache) Del(_ context.Context, _ string) error { return nil }
```

Isolate tests with key prefixes or `FLUSHDB` in `t.Cleanup` (never in prod).

### Anti-Patterns

- Caching mutable data without invalidation — stale reads silently accumulate.
- TTL-less keys — memory leaks, keyspace grows unbounded.
- `KEYS *` in production — O(N) scan, blocks Redis, causes latency spikes. Use `SCAN` with a cursor.
- Storing large objects (> 100 KB) — serialization cost, memory pressure, network saturation. Break into smaller keys or reconsider whether Redis is the right store.
- Using Redis as the primary database (no DB backup) — Redis persistence (`RDB`/`AOF`) is not a replacement for Postgres. Redis is a cache and coordination layer.
- One Redis connection per request — connection pool exists for a reason. Share `*redis.Client`.
- Ignoring cache errors — cascading to the DB silently under Redis outage is correct; ignoring the error and returning stale/zero data is not.
- `FLUSHDB` / `FLUSHALL` in application code — only in test teardown, never in business logic.
- Encoding sensitive data unencrypted — Redis data is plaintext on the wire and at rest unless TLS + encryption-at-rest are configured. Sessions and tokens should be encrypted or use opaque handles.
- Shared keyspace across services — prefix every key with the service name; treat keyspace as a private API.

### Cache Checklist

```
[ ] All keys have TTLs; no eternal keys in a cache workload
[ ] TTLs include jitter to prevent synchronised expiry stampede
[ ] Cache unavailability degrades to source gracefully (warning log, not error)
[ ] Cache-aside: commit only after successful DB write; invalidate on failure
[ ] Stampede prevention: singleflight for per-instance; PER or locking for cross-instance
[ ] Distributed locks use SET NX PX + Lua release; TTL > worst-case task duration
[ ] Pipeline / MGET used for bulk operations (≥3 keys in one round-trip)
[ ] Lua scripts used for atomic read-modify-write operations
[ ] Key naming convention documented; service-prefixed; cluster-safe {} notation where needed
[ ] maxmemory and maxmemory-policy configured; allkeys-lru for pure cache
[ ] Hit rate, latency, pool stats exported as metrics; hit rate < 80% = investigate
[ ] redisotel (or custom hook) for OTel tracing + metrics on every command
[ ] Tests: in-memory fake for unit; testcontainers Redis for integration
[ ] Sensitive data encrypted before storage; TLS on Redis connection
[ ] No KEYS * in application code; SCAN with cursor only
[ ] Keyspace shared with no other service; all keys namespaced
```

---

## Modules & Monorepo

- One module per deployable unit. Don't split a service into a dozen tiny modules — module boundaries are versioning boundaries, not package boundaries.
- `go.work` for multi-module monorepos. Do not commit `go.work.sum` selectively; commit the whole file.
- Pin minimum Go in `go.mod` (`go 1.22`). Bump deliberately.
- `replace` directives only for local development overrides — never in a released `go.mod`. CI should reject them.
- `go mod tidy -v` clean in CI.

---

## Security Best Practices

Security is a property of the system, not a feature you add at the end. Bake it into every layer: input validation at boundaries, least privilege everywhere, secrets out of source, dependencies under continuous scrutiny. The Go toolchain provides strong baselines; using them is non-negotiable.

### Threat Model First

Before writing security code, write down what you are defending against. A public API has a different threat surface than an internal cron job. Common axes:

- **Attacker capability**: anonymous internet, authenticated user, malicious admin, compromised dependency, malicious co-tenant.
- **Asset value**: PII, payment data, auth tokens, internal credentials, integrity of state.
- **Trust boundaries**: where untrusted input enters; where it crosses into a privileged context.

If you cannot name the threat, you cannot defend against it. Document it in the repo (`SECURITY.md` or an ADR).

### Input Validation at the Boundary

Validate at the system boundary, exactly once, with explicit rules. Downstream code trusts validated values.

```go
type CreateUserRequest struct {
    Name  string `json:"name"`
    Email string `json:"email"`
}

func (r *CreateUserRequest) Validate() error {
    if utf8.RuneCountInString(r.Name) < 1 || utf8.RuneCountInString(r.Name) > 64 {
        return &ValidationError{Field: "name", Reason: "length 1-64"}
    }
    if _, err := mail.ParseAddress(r.Email); err != nil {
        return &ValidationError{Field: "email", Reason: "invalid"}
    }
    return nil
}
```

Rules:
- Allowlist over denylist. Define what is valid; reject everything else.
- Length limits on every string field. Unbounded strings are a DoS vector (memory exhaustion, regex blowup, expensive downstream processing).
- Numeric range checks. `int64` from JSON can be anything; verify it fits the domain.
- Use `encoding/json.Decoder.DisallowUnknownFields()` for strict APIs — catches typos, exposes attacker probing.
- Cap request body: `http.MaxBytesReader(w, r.Body, 1<<20)` (1 MiB or your real limit). The default is unbounded.

### SQL Injection

Always parameterize. Never concatenate user input into a query. See the Database/SQL section for the full pattern. Table and column identifiers cannot be parameterized — validate against an allowlist when they must be dynamic.

`golangci-lint` rule: `gosec` G201, G202.

### Command Injection

Never pass user-controlled strings to a shell.

```go
// DANGEROUS
exec.Command("sh", "-c", "convert "+userPath+" out.png")

// SAFE — argv form, no shell interpolation
exec.Command("convert", userPath, "out.png")
```

If you must invoke through a shell, validate the input against a strict allowlist (`^[a-zA-Z0-9_.-]+$` and equivalents) and prefer `os/exec.LookPath` + argv. `os.Setenv` from user input is also a vector.

### Path Traversal

User input as a filesystem path requires bounding to an allowed root.

```go
func safeJoin(root, name string) (string, error) {
    p := filepath.Join(root, filepath.Clean("/"+name))
    if !strings.HasPrefix(p, filepath.Clean(root)+string(filepath.Separator)) {
        return "", errors.New("path escapes root")
    }
    return p, nil
}
```

Better: use Go 1.24+ `os.Root` (rooted file access — kernel-enforced sandbox where supported):

```go
root, err := os.OpenRoot("/var/data/uploads")
if err != nil { return err }
defer root.Close()
f, err := root.Open(name)   // cannot escape via .. or symlinks
```

Never let user input choose absolute paths. Reject `..` segments. Reject NUL bytes (`\x00`).

### XSS, Output Encoding

For HTML output, use `html/template`, **never** `text/template`:

```go
import "html/template"

t := template.Must(template.ParseFiles("page.html"))
t.Execute(w, data)   // auto-escapes by context (HTML, attribute, JS, URL)
```

`html/template` is context-aware — it escapes differently inside `<script>` vs an attribute vs an `href`. Bypassing with `template.HTML` / `template.JS` is a code smell; mark the call site and review every use.

For JSON APIs, `encoding/json` escapes `<`, `>`, `&` by default (good for HTML embedding). `SetEscapeHTML(false)` only for non-HTML consumers.

### CSRF

For cookie-authenticated browser apps, CSRF tokens or `SameSite=Lax`/`Strict` cookies. Always set explicitly:

```go
http.SetCookie(w, &http.Cookie{
    Name:     "session",
    Value:    token,
    Path:     "/",
    Secure:   true,                  // HTTPS only
    HttpOnly: true,                  // no JS access
    SameSite: http.SameSiteLaxMode,  // CSRF mitigation
    MaxAge:   3600,
})
```

For pure JSON APIs with `Authorization: Bearer` (no cookies), CSRF is generally not applicable — but verify your CORS policy doesn't allow credentialed cross-origin requests.

### CORS

`Access-Control-Allow-Origin: *` combined with `Access-Control-Allow-Credentials: true` is rejected by browsers but inviting confusion. Be explicit:

- Allowlist exact origins for credentialed requests. Echo the validated origin back.
- Reject `null` origin.
- Don't reflect `Origin` blindly — that's the same as `*` with credentials enabled.

Use `rs/cors` or a hand-rolled middleware with explicit allowlist; never wildcard with credentials.

### Authentication

- **Passwords**: hash with `golang.org/x/crypto/bcrypt` (cost 12+) or Argon2id (`golang.org/x/crypto/argon2`). Never SHA-256, never MD5, never plain. Tune cost so a single hash takes ~100ms on your hardware.
- **Storage**: hash only. Never log the plaintext, never the hash unredacted.
- **Comparison**: `subtle.ConstantTimeCompare` for any secret comparison (tokens, signatures). Direct `==` leaks timing.
- **Session tokens**: 256 bits of entropy from `crypto/rand` (never `math/rand`). Treat as opaque; rotate on privilege change.
- **JWT**: prefer opaque tokens with a server-side store. If JWT is required:
  - Pin algorithm — never accept `alg: none`, never trust the header to choose the algorithm.
  - Short expiry; refresh via a separate flow.
  - Validate `aud`, `iss`, `exp`, `nbf` every time.
  - Use `lestrrat-go/jwx/v2` over `dgrijalva/jwt-go` (the latter is unmaintained and historically had `alg: none` issues).

### Authorization

- Check at every entry point, not in middleware alone. Defense in depth.
- Object-level: verify the authenticated user owns / can access the resource. This is where IDOR (Insecure Direct Object Reference) bugs live.
- Default deny. Explicit grants only.
- Centralize policy decisions (`Authorizer` interface) — don't sprinkle `if user.IsAdmin` checks through handlers.

### Crypto

**Use the standard library and `golang.org/x/crypto`. Do not roll your own.**

- TLS: `crypto/tls` with `MinVersion: tls.VersionTLS12` (TLS 1.3 preferred). Strict cipher suites enforced automatically in 1.3.
- Symmetric encryption: AES-GCM (`crypto/cipher.NewGCM`) for authenticated encryption. Use ChaCha20-Poly1305 (`x/crypto/chacha20poly1305`) on CPUs without AES-NI.
- Nonces: 96-bit random for AES-GCM. **Never reuse a (key, nonce) pair.** A single reuse breaks confidentiality and authenticity.
- KDF: HKDF for key derivation from high-entropy material; Argon2id / scrypt for low-entropy (passwords).
- Asymmetric: Ed25519 for signatures, X25519 for key exchange. RSA only when interoperability demands it (use 3072-bit minimum, OAEP padding for encryption, PSS for signatures).
- Randomness: `crypto/rand.Read` for everything security-sensitive. `math/rand` is **not** a CSPRNG.

If you find yourself implementing a cryptographic primitive, stop. Reach for the standard library or a reviewed library; if neither fits, the design is probably wrong.

### Constant-Time Comparison

```go
import "crypto/subtle"

if subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
    return errUnauthorized
}
```

Use for HMACs, session tokens, password equality after hashing, any signature verification not handled by a higher-level API.

### Secrets Management

- **Never in source**, never in plaintext config files committed to the repo. `git-secrets` or `gitleaks` in pre-commit / CI.
- Source of truth: environment variables (12-factor), a secrets manager (Vault, AWS Secrets Manager, GCP Secret Manager), or sealed Kubernetes secrets. Pick one and never deviate.
- Load at startup, fail fast on missing required secrets, log only their presence ("loaded DB password") never values.
- Rotate. Plan for rotation from day one: support two valid credentials simultaneously during rollover.
- Don't pass secrets via command-line args — they leak in `/proc/<pid>/cmdline` and shell history.
- Redact in logs: a custom `slog.Handler` or attribute key prefix (`secret_*`) the handler scrubs. Better: type secrets as a wrapper that overrides `LogValue` to return `"[redacted]"`:

```go
type Secret string
func (s Secret) LogValue() slog.Value     { return slog.StringValue("[REDACTED]") }
func (s Secret) GoString() string         { return "[REDACTED]" }
func (s Secret) String() string           { return "[REDACTED]" }
func (s Secret) Reveal() string           { return string(s) }
```

Accessor (`Reveal`) is the only path to the plaintext; everything else logs the redacted form.

### Dependencies and Supply Chain

- `govulncheck ./...` in CI. Blocks merges on known CVEs that affect your call graph.
- Pin module versions (`go.sum` committed, GOFLAGS=`-mod=readonly` in CI).
- Renovate / Dependabot for updates. Review the diff — supply chain attacks land via "trusted" minor upgrades.
- Vendor (`go mod vendor`) for hermetic builds when reproducibility matters more than checkout speed.
- Audit transitive dependencies: `go list -m all | wc -l` is a risk metric. Every dep is an attack surface.
- Build with `-trimpath` and `-buildvcs=true` (default) for reproducible binaries and provenance.

### TLS Configuration

```go
srv := &http.Server{
    Addr: ":443",
    TLSConfig: &tls.Config{
        MinVersion:               tls.VersionTLS12,
        PreferServerCipherSuites: true,                       // 1.2 only; ignored in 1.3
        CurvePreferences:         []tls.CurveID{tls.X25519, tls.CurveP256},
    },
}
```

- Reject TLS < 1.2. Prefer 1.3 (auto-negotiated when both peers support it).
- Trust the OS / Go default root CAs for outbound clients; pin where supply chain is critical (mutual TLS, narrow scope).
- HSTS for browser-facing services: `Strict-Transport-Security: max-age=31536000; includeSubDomains`.

### Secure HTTP Headers

For any browser-facing endpoint:

```go
w.Header().Set("Content-Security-Policy", "default-src 'self'")
w.Header().Set("X-Content-Type-Options", "nosniff")
w.Header().Set("Referrer-Policy", "no-referrer")
w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
w.Header().Set("X-Frame-Options", "DENY")
```

JSON APIs: `Content-Type: application/json; charset=utf-8` and `X-Content-Type-Options: nosniff` prevents content-sniffing attacks.

### Server Hardening

- Set all four HTTP server timeouts (see HTTP Services). Unbounded timeouts are a Slowloris vector.
- `http.MaxBytesReader` on every request body.
- Rate limit per IP / per user / per endpoint at the edge (LB, gateway) and in-app for defense in depth. `golang.org/x/time/rate` for the in-app layer.
- Hide internal errors from clients: generic message externally, detailed internally (see Errors section).
- Disable the default `net/http/pprof` mux in production unless you bind it to a private interface (see pprof section).
- Run as a non-root user inside the container. `USER 65532:65532` in the Dockerfile or `runAsNonRoot: true` in Kubernetes.

### Rate Limiting and DoS

- Per-IP and per-account limiters at the edge.
- Reject oversized requests early (`MaxBytesReader`).
- Bound concurrent work per request (no unbounded fan-out).
- Avoid `regexp` against attacker-controlled patterns or input. Go's stdlib `regexp` is RE2 (linear time, no backtracking) — safer than PCRE, but compiling user-supplied patterns is still a memory vector. `regexp.MustCompile` at init, never at request time with user input.
- Timeouts on every outbound call.
- Resource limits in the platform (cgroup memory, file descriptors) so a single bad input can't take the host.

### Time-Safe Operations

- Token / HMAC comparison: `subtle.ConstantTimeCompare`.
- Don't branch on secret data in a way that affects timing or cache.
- For cryptographic envelope decryption: use AEAD (AES-GCM, ChaCha20-Poly1305) — failed authentication returns a single error, no oracle for partial decryption.

### Deserialization

- `encoding/json` is safe by default (no code execution path). Untrusted JSON is still a memory/recursion vector — set body limits and a depth-bounded decoder for deeply nested payloads (you may need a custom decoder; stdlib does not bound by default).
- `encoding/gob` is **not safe** for untrusted input — it can construct arbitrary types from the wire. Never expose `gob` decoding to an untrusted source.
- YAML: prefer `sigs.k8s.io/yaml` (round-trips through JSON, strict typing) over `gopkg.in/yaml.v3` for untrusted YAML.
- XML: `encoding/xml` has had entity expansion (billion-laughs) issues historically. Avoid XML from untrusted sources; if forced, disable entity expansion and bound input size.

### Race Conditions as Security Bugs

A TOCTOU (Time-Of-Check / Time-Of-Use) bug becomes a security issue when the check authorizes and the use mutates state.

```go
// VULNERABLE
if hasPermission(user, file) {
    return os.ReadFile(file)        // file could be swapped between check and use
}

// SAFER — operate on a handle that captures identity
f, err := os.Open(file)
if err != nil { return err }
defer f.Close()
if !hasPermissionOnHandle(user, f) { return errForbidden }
return io.ReadAll(f)
```

For account-state mutations: use database transactions with `SELECT ... FOR UPDATE` or optimistic concurrency tokens, not check-then-act in application code.

### Lint and Scan

Mandatory in CI:

- `govulncheck ./...` — known CVEs in your call graph (not just direct deps).
- `gosec` (via `golangci-lint`) — pattern-based detection of common pitfalls. Tune the ruleset; suppress with reasoned `//nolint:gosec` only.
- `staticcheck` — many bugs that are also security-relevant (errors ignored, format string mismatches).
- `errorlint` — non-`%w` wraps that may leak internal details when stringified.
- `bodyclose` — leaked HTTP response bodies (resource exhaustion).
- `noctx` — HTTP calls without context (uncancellable, DoS surface).

For production builds: `-trimpath`, `-buildmode=pie` where supported, strip debug info (`-ldflags="-s -w"`) for binaries that ship to untrusted environments. Keep symbols for internal services so panics are debuggable.

### Logging Discipline

- Never log secrets, full tokens, full request bodies, raw passwords, full PAN/PII.
- Redact at the source (typed `Secret` wrapper above) rather than relying on a downstream scrubber.
- Audit logs for privileged actions (privilege changes, secret access, admin actions). Separate sink from operational logs, with stricter retention and integrity controls.
- Be careful with structured log fields — an attacker who controls a field value can inject newlines into less rigorous backends. The slog JSON handler escapes correctly; text handler is more vulnerable.

### Anti-Patterns

- `math/rand` for tokens, IDs that must be unguessable, jitter that affects security timing.
- `==` on secret-bearing strings.
- `fmt.Sprintf` to build SQL, shell commands, file paths, HTML.
- Storing secrets in `Config` structs passed around and logged with `%+v`.
- Trusting `X-Forwarded-For` blindly — only trust headers set by a known proxy you control; trim untrusted hops.
- Custom crypto, custom random, custom authentication protocols.
- "We're behind a firewall" as a defense. Defense in depth or it's no defense.
- Per-request `regexp.Compile` of user-controlled patterns.
- Disabling certificate verification (`InsecureSkipVerify: true`) anywhere except a clearly-marked dev path.
- `panic` paths that expose internal state via error messages or stack traces returned to the client.
- "Patch later" — pinned-old version of a dep with a known CVE.

### Workflow: Pre-Release Security Pass

1. Run `govulncheck`, `gosec`, `staticcheck`. Resolve or document.
2. Search for `InsecureSkipVerify`, `math/rand`, `exec.Command("sh"`, `fmt.Sprintf` near SQL/HTML. Justify or fix each.
3. Confirm all secrets sourced from the secrets manager, never the repo.
4. Confirm `MaxBytesReader`, all four HTTP timeouts, and rate limiting are in place on every public endpoint.
5. Confirm authorization checks at the object level, not just at route entry.
6. Confirm `pprof` and admin endpoints bound to a private interface or behind admin auth.
7. Run `go test -race ./...` and review any data race fix as a security candidate.
8. Threat-model the new surface: what does an authenticated user gain? An anonymous attacker? A compromised dependency?

### Security Checklist

```
[ ] Threat model documented (SECURITY.md or ADR)
[ ] All input validated at the boundary with allowlists + size caps
[ ] http.MaxBytesReader on every body; all four HTTP timeouts set
[ ] Parameterized SQL only; identifiers from allowlist
[ ] No exec.Command("sh", "-c", ...) with user input
[ ] Path access via os.Root or strict join-and-prefix-check
[ ] html/template (not text/template) for HTML output
[ ] Cookies Secure + HttpOnly + SameSite=Lax/Strict
[ ] CORS explicit allowlist; never *+credentials
[ ] Passwords: bcrypt cost ≥ 12 or Argon2id; never logged
[ ] Tokens / IDs from crypto/rand; never math/rand
[ ] Constant-time comparison for secret equality
[ ] JWT: pinned algorithm, validated aud/iss/exp; or use opaque tokens
[ ] AEAD (AES-GCM / ChaCha20-Poly1305); nonces never reused
[ ] TLS MinVersion 1.2; HSTS for browser-facing endpoints
[ ] Security headers set (CSP, X-Content-Type-Options, Referrer-Policy)
[ ] Secrets from a manager or env, never source; redacted in logs via Secret type
[ ] govulncheck, gosec, staticcheck, errorlint, bodyclose, noctx in CI
[ ] No InsecureSkipVerify outside explicit dev flag
[ ] Container runs as non-root; pprof / admin endpoints on private interface
[ ] Rate limiting per IP and per account at the edge + in-app
[ ] Audit logs for privileged actions, separate sink
```

---

## Performance

Rules in order:
1. **Don't optimize without `pprof`.** `go test -bench -cpuprofile`, `net/http/pprof` in prod (behind admin auth).
2. Allocation is usually the cost. `-benchmem`, then `-gcflags="-m"` to see escape analysis.
3. Preallocate slices when size is known: `make([]T, 0, n)`.
4. Strings vs bytes: `strings.Builder` for concatenation. `[]byte(s)` and `string(b)` are copies — minimize round-trips.
5. Reuse buffers via `sync.Pool` only for hot paths. Measure.
6. `unsafe`, SIMD assembly, generics specialization — last resort, well-commented, fenced behind benchmarks that justify them.

---

## Profiling with pprof

**Measure before optimizing. Always.** `pprof` is the only authority — intuition about Go performance is wrong more often than right.

### Profile Types

| Profile | What it shows | When to use |
|---------|---------------|-------------|
| `cpu` | Where CPU time is spent (sampled) | "Service is hot" / high CPU usage |
| `heap` | Live allocations (in-use) and total (alloc) | OOM, GC pressure, memory growth |
| `goroutine` | All goroutine stacks | Suspected leaks, deadlocks |
| `block` | Time blocked on synchronization | Lock/channel contention (must enable) |
| `mutex` | Mutex contention | Hot lock suspicion (must enable) |
| `threadcreate` | OS thread creation | Rarely needed; cgo or syscall storms |
| `trace` | Full execution trace | Latency outliers, scheduler issues |

### Enabling pprof

**In a server** — import the side-effect package, expose on an internal port:

```go
import _ "net/http/pprof"   // registers /debug/pprof on DefaultServeMux

go func() {
    // SEPARATE listener — never expose on the public mux
    log.Fatal(http.ListenAndServe("127.0.0.1:6060", nil))
}()
```

Block and mutex profilers must be turned on (they have overhead):

```go
runtime.SetBlockProfileRate(1)         // every block event; tune higher in prod
runtime.SetMutexProfileFraction(1)     // 1 = every contention event
```

**In tests / benchmarks**:

```bash
go test -bench=. -benchmem -cpuprofile=cpu.out -memprofile=mem.out -blockprofile=block.out
```

**One-off in code** (long-running batch job):

```go
f, _ := os.Create("cpu.prof")
defer f.Close()
pprof.StartCPUProfile(f)
defer pprof.StopCPUProfile()
```

### Collecting

```bash
# CPU profile — 30s sample of live process
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# Heap (in-use objects right now)
go tool pprof http://localhost:6060/debug/pprof/heap

# Heap with allocations since start (cumulative)
go tool pprof -alloc_space http://localhost:6060/debug/pprof/heap

# Goroutines — full dump
curl -s http://localhost:6060/debug/pprof/goroutine?debug=2 > goroutines.txt

# Block / mutex
go tool pprof http://localhost:6060/debug/pprof/block
go tool pprof http://localhost:6060/debug/pprof/mutex

# Execution trace (2s window — keep it short, files balloon)
curl -s http://localhost:6060/debug/pprof/trace?seconds=2 > trace.out
go tool trace trace.out
```

### Analyzing

```bash
go tool pprof cpu.out
```

Interactive commands inside pprof:
- `top` — top N functions by flat (self) time
- `top -cum` — by cumulative time (includes callees) — usually more useful
- `list <regex>` — annotated source of matching functions
- `web` — call graph SVG in browser (needs Graphviz)
- `peek <regex>` — callers and callees of a function
- `disasm <regex>` — disassembly with samples

Web UI (recommended for anything non-trivial):

```bash
go tool pprof -http=:8081 cpu.out
```

Gives flame graph, source view, top, peek — all clickable. **Flame graph is the default lens** for CPU and alloc profiles.

### Reading Heap Profiles

Two axes: **inuse vs alloc**, **space vs objects**.

- `inuse_space` — bytes currently live → matches RSS pressure
- `inuse_objects` — count currently live → matches GC pressure
- `alloc_space` — total bytes ever allocated → matches GC work over the window
- `alloc_objects` — total allocation count → matches GC overhead

Rule of thumb:
- High `alloc_space` but low `inuse_space` → churn. Pool, reduce per-request allocations.
- High `inuse_space` → genuine retention. Look for caches, slices held longer than needed, goroutine-leaked stacks.

### Diffing Profiles

Regression hunting — capture before/after, diff:

```bash
go tool pprof -base=before.out after.out
# or
go tool pprof -diff_base=before.out after.out      # shows what got worse vs base
```

For benchmarks, use `benchstat`:

```bash
go test -bench=. -count=10 > old.txt
# make change
go test -bench=. -count=10 > new.txt
benchstat old.txt new.txt
```

Trust `benchstat`'s p-value and delta — single-run benchmarks lie.

### Goroutine Leak Diagnosis

Symptoms: goroutine count grows monotonically, memory creeps, no obvious leak in heap.

```bash
curl -s http://localhost:6060/debug/pprof/goroutine?debug=2 > g.txt
# Look for stacks that should be transient but show high counts
# Group by stack signature
grep -E "^goroutine [0-9]+" g.txt | wc -l           # total count
```

Common culprits: missing `ctx` cancel, `time.After` in select loops, unbuffered channel send with no receiver, `http.Response.Body` never closed (also burns FDs).

### Production Safety

- Bind pprof to `127.0.0.1` or a private interface. Never expose `/debug/pprof` publicly — it leaks code paths, goroutine dumps, can be DoSed via long `?seconds=` params.
- CPU profiling cost: ~5% overhead during the sample window. Heap profiling: cheap. Block/mutex: noticeable; sample (`SetBlockProfileRate(N)` where N>1) in prod.
- Continuous profiling (Pyroscope, Datadog, Polar Signals, GCP Cloud Profiler) > ad-hoc when you have the budget. Catches regressions without you remembering to look.

### Workflow: Investigating Slow Endpoint

1. Reproduce under load (`vegeta`, `wrk`, `hey`).
2. Capture CPU profile during steady-state load: `?seconds=30`.
3. `go tool pprof -http=:8081 cpu.out` → flame graph. Find the widest box that's *your* code (not runtime/syscall).
4. `list <func>` to see line-level samples. Confirm with reading the code.
5. Form a hypothesis, write a benchmark that exercises the suspect path, fix, `benchstat` old vs new.
6. Re-profile in load test. Confirm the wide box shrunk.
7. Ship.

### pprof Checklist

```
[ ] pprof bound to private interface only
[ ] CPU profile collected during steady-state load, not cold start
[ ] Heap analyzed both inuse and alloc; right axis chosen for the question
[ ] Block/mutex rate enabled only when investigating contention
[ ] Regression measured with benchstat across ≥10 runs, not single-shot
[ ] Diff of before/after captured for the PR description
[ ] Flame graph (web UI) used for anything beyond top-10 inspection
```

---

## Tooling

Mandatory in CI:
- `gofmt -s` (simplify) — failure blocks merge.
- `go vet ./...`
- `golangci-lint run` with at minimum: `errcheck`, `govet`, `staticcheck`, `revive`, `gosec`, `gocritic`, `ineffassign`, `unused`, `bodyclose`, `contextcheck`, `errorlint`, `nilerr`, `noctx`, `gocyclo`.
- `go test -race -count=1 ./...`
- `govulncheck ./...` for known CVEs.

Local: `gofumpt` (stricter `gofmt`), `goimports`, optionally `golines` for line-length.

---

## Workflow: Adding a Feature

1. **Define the contract first** — function signature, error sentinels, the interface the caller will see. Confirm with the user.
2. **Write the failing test** (table-driven, exercises the public function only).
3. **Implement the minimum** to pass. No speculative branches.
4. **Wire into `main`** if it's a new entrypoint; otherwise add to the existing constructor.
5. **Observability**: one structured log at state change, span if it crosses a network boundary, metric only if operationally interesting.
6. **Run** `go vet`, `golangci-lint`, `go test -race`. All clean.

---

## Code Review Checklist

```
[ ] All errors wrapped with operation + identifier context
[ ] Every goroutine has a known lifetime and respects ctx
[ ] ctx is first param, never stored, never nil
[ ] No init() side effects; deps wired in main
[ ] Interfaces defined at consumer, small, no IFoo naming
[ ] No mocks for DB/cache — use fakes or testcontainers
[ ] Server has all four timeouts set; graceful shutdown wired
[ ] Logs are structured key-value; no fmt.Sprintf into messages
[ ] No global state, no package-level vars except sentinels/configs
[ ] `go test -race` clean, table-driven, t.Parallel where safe
[ ] golangci-lint clean; no //nolint without a reason comment
[ ] Benchmarks accompany any perf-motivated change
```

---

## References

- Effective Go — https://go.dev/doc/effective_go
- Go Code Review Comments — https://github.com/golang/go/wiki/CodeReviewComments
- Uber Go Style Guide — https://github.com/uber-go/guide
- Google Go Style — https://google.github.io/styleguide/go/
- Standard project layout — https://github.com/golang-standards/project-layout (use selectively)
