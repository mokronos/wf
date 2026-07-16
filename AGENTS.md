When im using these words im talking about the following:
- "you": i mean you, the coding agent helping me implement and design this system
- "agent": i'm talking about the agent that is using this library/system to create workflows, etc.
- "user": i'm talking about the user of the agent

## Type Discipline

- Never use `any` or `unknown`. Model every compile-time-known shape with Effect Schema (the schema is the single source of truth; derive TS types via `typeof X.Type`), brand identifiers where mix-ups are possible, and parse external/dynamic data at the boundary with `Schema.decodeUnknown*` instead of casting. No `as` casts to silence the compiler.

<!-- effect-solutions:start -->
## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.

## Local Effect Source

The Effect v4 repository is cloned to `~/.local/share/effect-solutions/effect` for reference.
Use this to explore APIs, find usage examples, and understand implementation
details when the documentation isn't enough.
<!-- effect-solutions:end -->
