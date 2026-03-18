# Test Data Generation

## Rules

- NEVER hardcode IDs, emails, timestamps, or environment-specific values
- Use helpers fixture for ALL dynamic data
- Each test must generate its own unique data

## Helpers Available

```typescript
// helpers is a Playwright fixture — access it in the test function
test("example", async ({ gRPC, helpers }) => {
  const processId = helpers.generateProcessId(); // unique string
  const uuid = helpers.generateUUID();           // v4 UUID string
  const currentDate = helpers.getCurrentDate();  // current date
});

// Unique string with prefix — use when helpers methods aren't sufficient
const name = `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Unique email
function uniqEmail() {
  return `test${Date.now()}${Math.random().toString(16).slice(2)}@example.com`;
}
```

## Patterns for Different Field Types

| Proto Type | Generation Strategy |
|---|---|
| string (ID) | `helpers.generateProcessId()` or `helpers.generateUUID()` |
| string (name) | `` `test-name-${Date.now()}` `` |
| string (email) | `` `test${Date.now()}${Math.random().toString(16).slice(2)}@example.com` `` |
| int32 | `Math.floor(Math.random() * 1000)` |
| int64 | `String(Math.floor(Math.random() * 1000))` — pass as string |
| uint32 | `Math.floor(Math.random() * 1000)` |
| uint64 | `String(Math.floor(Math.random() * 1000))` — pass as string; for max boundary use `"18446744073709551615"` |
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
| int64 | `"-9223372036854775808"` (as string) | `"9223372036854775807"` (as string) |
| uint64 | `"0"` or `0n` (BigInt) | `"18446744073709551615"` (as string) — NEVER use `Number.MAX_SAFE_INTEGER` |
| string | `""` (empty) | Very long string (1000+ chars) |
