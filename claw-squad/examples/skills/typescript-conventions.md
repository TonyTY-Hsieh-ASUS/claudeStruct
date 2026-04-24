---
name: typescript-conventions
description: TypeScript style & patterns; apply when editing .ts/.tsx files
apply_to: ["**/*.ts", "**/*.tsx"]
---

# TypeScript conventions

## Imports

- Prefer named imports; avoid default exports for new modules.
- Import types with the `type` modifier: `import type { Foo } from "./bar.js"`.
- Use `.js` extensions in relative imports (ESM rules).

## Strictness

- No `any`. If the type is genuinely unknown use `unknown` and narrow at the boundary.
- Prefer discriminated unions over optional flags for state that can be one of a few variants.
- Exhaustive switches: end with `const _x: never = value;` to catch missing cases at compile time.

## Error handling

- Validate at the system boundary (user input, network response). Inside the system, trust your own types.
- Never silently swallow errors. If you must suppress one, comment the specific reason.

## Testing

- One assertion per test where possible; tight tests make regressions obvious.
- Use vitest's `expect(x).toBe(y)` for primitives, `toEqual` for deep equality, `toMatchObject` for partial shapes.
