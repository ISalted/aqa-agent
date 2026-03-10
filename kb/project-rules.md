# Project Rules (extracted from skill-trade/CLAUDE.md)

## Hard Constraints
- NEVER edit files in `lib/clients/gRPC/services/generated/` — auto-generated from proto
- NEVER use `sleep`/`waitForTimeout` — find the root cause
- NEVER change assertions to match buggy backend — report the bug
- NEVER delete tests to make a suite pass
- NEVER commit secrets or real PII — use `.env`
- NEVER hardcode IDs, timestamps, or environment-specific values
- Proto files are the source of truth for method signatures and field names

## Architecture
```
tests/grpc/{service}/{method}.test.ts   — one file per method
lib/clients/gRPC/services/{Service}.ts  — service wrappers
lib/clients/gRPC/services/generated/    — DO NOT EDIT
lib/clients/gRPC/proto/*.proto          — contract source of truth
lib/clients/gRPC/types/{service}/       — ts-interface-checker definitions
lib/fixtures.ts                         — Playwright fixtures
lib/helpers/helpers.ts                  — Helpers class + extensions
```

## Test Pattern (mandatory)
1. Schema validation test FIRST (ts-interface-checker)
2. Happy path / positive tests
3. Negative / error tests
4. Boundary tests (optional fields, edge values)

## Naming
- Test files: `{methodName}.test.ts` (camelCase)
- Test IDs: `{SERVICE_PREFIX}-{NUMBER}` (e.g., CW-001)
- Test dirs: `tests/grpc/{service-name}/` (kebab-case)

## Coverage Policy
- P1 (schema + happy path) = mandatory for every method
- P2 (negatives) = expected
- P3 (boundaries/edge) = nice to have
