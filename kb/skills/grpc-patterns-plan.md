# gRPC Test Planning Patterns

## Test Naming Convention

Format: `{PREFIX}-{NNN}: {Short scenario title}`
- PREFIX: exactly 3 uppercase letters derived from the method name
- NNN: zero-padded sequence starting from `001`
- Schema test is always first: `PREFIX-001`

**Prefix derivation rule:**
Take the first letter of each CamelCase word, left to right, until you have 3 letters.
If result has fewer than 3 letters, extend with the next letters of the first word.

Examples:
- `InsertOrReplaceMissionsGroup` → I+O+R+M+G → first 3 = **IOR**
- `InsertOrReplaceRewardPack`    → I+O+R+R+P → first 3 = **IOR**
- `GetMission`  → G+M → only 2 words, pad with next letter of "Mission" → **GMI**
- `CreateUser`  → C+U → only 2 words, pad with next letter of "Create"  → **CRU**
- `UpdateClientWallet` → U+C+W → **UCW**

## Test Types

| Type | When to use |
|---|---|
| `schema` | Always first — validates response structure matches proto |
| `positive` | Valid input, happy path, expected success |
| `negative` | Invalid input, expected error response |
| `boundary` | Min/max values, empty strings, zero, max int |
| `edge` | Optional fields absent/present, oneof variants, empty repeated |

## Priority Levels

| Priority | Meaning |
|---|---|
| P1 | Critical — schema test + happy path (must have) |
| P2 | Important — main negative cases (should have) |
| P3 | Nice to have — boundary/edge cases |

## Test Count

- 5–10 test cases per method total (including schema test)
- Always: 1 schema (P1) + 1 positive (P1) + 1 negative (P2) minimum
- Add boundary/edge (P3) for complex fields: oneof, optional, enum, uint32 max

## File Naming

One file per RPC method: `{methodName}.test.ts` (camelCase)
