# Test Data Generation

## Rules

- NEVER hardcode IDs, emails, timestamps, or environment-specific values
- Use helpers for ALL dynamic data
- Each test must generate its own unique data

## Helpers Available

```typescript
import { Helpers } from '../../../lib/helpers/helpers';

// ProcessId — required for most gRPC calls
const processId = Helpers.generateProcessId(); // returns unique string

// UUID
const uuid = Helpers.generateUUID(); // returns v4 UUID string

// Unique string with prefix
const name = `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
```

## Patterns for Different Field Types

| Proto Type | Generation Strategy |
|---|---|
| string (ID) | `Helpers.generateProcessId()` or `Helpers.generateUUID()` |
| string (name) | `` `test-name-${Date.now()}` `` |
| string (email) | `` `test-${Date.now()}@test.com` `` |
| int32/int64 | `Math.floor(Math.random() * 1000)` |
| uint32/uint64 | `Math.floor(Math.random() * 1000)` |
| float/double | `Math.random() * 100` |
| bool | `true` / `false` (test both) |
| enum | Use enum values from proto (test valid and invalid) |
| map<K,V> | `{ [key]: value }` — test empty and populated |
| repeated | `[]` — test empty, single, multiple items |
| optional | Test with and without the field |

## Boundary Values

| Type | Min | Max |
|---|---|---|
| int32 | -2147483648 | 2147483647 |
| uint32 | 0 | 4294967295 |
| int64 | Use BigInt or string | Use BigInt or string |
| string | `""` (empty) | Very long string (1000+ chars) |
