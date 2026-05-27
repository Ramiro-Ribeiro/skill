<!-- markdownlint-disable ol-prefix -->

# Go Workspaces for Multi-Package Repositories

## When to Use Workspaces

Use Go workspaces (`go.work`) when:

- Developing multiple related modules that import each other
- Building a monorepo with separate Go modules
- Testing local changes across module boundaries
- Avoiding `replace` directives in every module

**Don't use workspaces for:**

- Single-module projects
- Projects that only use external dependencies
- Simple applications

## Workspace Structure

Example monorepo with multiple modules:

```
my-monorepo/
├── go.work                    # Workspace file (see below)
├── pkg/
│   ├── auth/                 # Module 1: github.com/user/my-monorepo/pkg/auth
│   │   ├── go.mod
│   │   ├── cmd/
│   │   │   └── auth-server/
│   │   │       └── main.go
│   │   └── internal/
│   │       └── handler/
│   │           └── auth.go
│   └── user/                 # Module 2: github.com/user/my-monorepo/pkg/user
│       ├── go.mod
│       ├── cmd/
│       │   └── user-server/
│       │       └── main.go
│       └── internal/
│           └── handler/
│               └── user.go
├── cmd/
│   └── api/                 # Module 3: github.com/user/my-monorepo/cmd/api
│       ├── go.mod
│       └── main.go
└── tools/
    └── cli/                  # Module 4: github.com/user/my-monorepo/tools/cli
        ├── go.mod
        └── cmd/
            └── mycli/
                └── main.go
```

## Creating a Workspace

1. **Initialize the workspace:**

```bash
go work init
```

`go work init` creates an empty `go.work` with just a Go directive — it does not auto-discover modules:

```go
go 1.21
```

2. **Add modules to workspace:**

```bash
go work use ./pkg/auth
go work use ./pkg/user
go work use ./cmd/api
go work use ./tools/cli
```

You can also initialize and add in one step: `go work init ./pkg/auth ./pkg/user`. After adding, `go.work` lists the modules:

```go
go 1.21

use (
    ./pkg/auth
    ./pkg/user
    ./cmd/api
    ./tools/cli
)
```

3. **Use modules without replace directives:**

In `pkg/user/go.mod`:

```go
module github.com/user/my-monorepo/pkg/user

go 1.21

require github.com/user/my-monorepo/pkg/auth v0.0.0
```

The workspace automatically resolves `pkg/auth` to the local directory.

## Workspace Commands

```bash
go work init              # Initialize new workspace
go work use ./path/to/mod # Add module to workspace
go work use -rm ./path    # Remove module from workspace
go work sync              # Sync workspace with module changes
```
