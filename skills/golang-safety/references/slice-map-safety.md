# Slice and Map Safety Deep Dive

## Range Loop Variable Capture

### Go 1.22+: per-iteration scoping (current default)

Since Go 1.22 each loop iteration creates a **new** loop variable, so the classic closure-capture bug no longer occurs. Do NOT add the old `v := v` shadow copy — it is now redundant noise (and `gofmt`/`govet` consider it pointless):

```go
// ✓ Good (Go 1.22+) — each iteration has its own v, no shadow copy needed
var funcs []func()
for _, v := range []string{"a", "b", "c"} {
    funcs = append(funcs, func() { fmt.Println(v) })
}
for _, f := range funcs {
    f() // prints "a", "b", "c"
}
```

This applies only when `go.mod` declares `go 1.22` or later — the new semantics are gated on the module's language version, not the toolchain version. If your module still targets `go 1.21` or earlier, see the historical workaround below.

### Pre-Go 1.22: shared loop variable (legacy only)

Before Go 1.22 the range variable was reused across iterations, so capturing it in a closure or storing its address made all references point to the final value. The fix was to shadow it:

```go
// ✗ Bad (pre-1.22) — all closures see the last value of v ("c", "c", "c")
for _, v := range []string{"a", "b", "c"} {
    funcs = append(funcs, func() { fmt.Println(v) })
}

// ✓ Fix (pre-1.22 only) — re-declare v in the inner scope
for _, v := range []string{"a", "b", "c"} {
    v := v
    funcs = append(funcs, func() { fmt.Println(v) })
}
```

## Storing Pointer to Loop Variable

In Go 1.22+, `&item` is safe because each iteration has its own `item`. Taking `&items[i]` is still preferable — it is clearer and avoids copying the element:

```go
type Item struct{ Name string }
items := []Item{{Name: "a"}, {Name: "b"}}
var ptrs []*Item

// ✓ Good — take the address of the slice element directly
for i := range items {
    ptrs = append(ptrs, &items[i])
}
```

On pre-1.22 modules, `&item` was an outright bug: every pointer aliased the single shared loop variable, so all of `ptrs` ended up pointing at the last element (`"b"`). Taking `&items[i]` was the fix then and remains the clearer choice now.

## Slice Header vs Backing Array

A slice is a 3-word struct: `{pointer, length, capacity}`. Multiple slices can share the same backing array:

```
a := make([]int, 3, 5)
┌─────┬─────┬─────┐
│ ptr │ len=3│cap=5│  ← slice header for a
└──┬──┴─────┴─────┘
   │
   ▼
┌───┬───┬───┬───┬───┐
│ 0 │ 0 │ 0 │   │   │  ← backing array (5 elements)
└───┴───┴───┴───┴───┘

b := a[1:2]
┌─────┬─────┬─────┐
│ ptr │ len=1│cap=4│  ← slice header for b (shares backing array)
└──┬──┴─────┴─────┘
   │ (points to a[1])
```

This is why `append(a, x)` can affect `b` if `a` has spare capacity. Use the full slice expression `a[:len(a):len(a)]` to set cap == len and force a new allocation on append.

## Subslice Retains Full Backing Array

Subslice retention: MUST use `slices.Clone` or `copy` when keeping a small slice from a large backing array. Slicing a large slice for a small piece prevents GC of the entire backing array:

```go
// ✗ Bad — small keeps the entire 1MB array alive
func getHeader(data []byte) []byte {
    return data[:64] // shares backing array with data
}

// ✓ Good — copy to release the large array
func getHeader(data []byte) []byte {
    header := make([]byte, 64)
    copy(header, data[:64])
    return header
}

// ✓ Good (Go 1.21+) — use slices.Clone
import "slices"

func getHeader(data []byte) []byte {
    return slices.Clone(data[:64])
}
```

## Standard Library Clone Helpers (Go 1.21+)

```go
import (
    "maps"
    "slices"
)

// Shallow copy a slice
clone := slices.Clone(original)

// Shallow copy a map
clone := maps.Clone(original)
```

These are the preferred way to make defensive copies. They are clearer than manual `make` + `copy` and handle nil inputs correctly (returning nil, not an empty collection).

## Map Iteration Order

Map iteration order MUST NOT be depended upon — it is randomized by the runtime:

```go
// ✗ Bad — output order changes between runs
m := map[string]int{"a": 1, "b": 2, "c": 3}
for k, v := range m {
    fmt.Printf("%s=%d ", k, v) // could be "b=2 a=1 c=3" or any permutation
}

// ✓ Good (Go 1.23+) — sort keys when order matters
keys := slices.Sorted(maps.Keys(m))
for _, k := range keys {
    fmt.Printf("%s=%d ", k, m[k])
}
```

## Deleting During Iteration

### Maps — safe

Deleting map entries during `range` is explicitly safe in Go:

```go
// ✓ Safe — defined behavior
for k, v := range m {
    if shouldDelete(v) {
        delete(m, k) // safe during range
    }
}
```

### Slices — needs care

Deleting from a slice during iteration requires index management:

```go
// ✗ Bad — skips elements after deletion
for i, v := range items {
    if shouldDelete(v) {
        items = append(items[:i], items[i+1:]...) // shifts elements, next iteration skips one
    }
}

// ✓ Good — iterate backwards
for i := len(items) - 1; i >= 0; i-- {
    if shouldDelete(items[i]) {
        items = append(items[:i], items[i+1:]...)
    }
}

// ✓ Good (Go 1.21+) — use slices.DeleteFunc
items = slices.DeleteFunc(items, shouldDelete)
```

## Comparing Slices and Maps

Slice/map comparison MUST use `slices.Equal`/`maps.Equal` (Go 1.21+), NEVER `==` (which doesn't compile for slices). Use standard library helpers:

```go
import (
    "maps"
    "slices"
)

// ✓ Good (Go 1.21+)
slices.Equal(a, b)      // element-wise comparison
maps.Equal(m1, m2)      // key-value comparison

// For custom comparison
slices.EqualFunc(a, b, func(x, y Item) bool {
    return x.ID == y.ID
})
```

→ See `samber/cc-skills-golang@golang-modernize` skill for Go 1.22+ loop variable semantics.
