# Test Coverage Rules for Proto Fields

## Field Type → What to Plan

| Field type | What to plan |
|---|---|
| `required string` | happy path + empty string edge case |
| `optional field` | test present + test absent |
| `oneof` | one test per variant + test with none (if valid) |
| `enum` | valid value + unknown/invalid value |
| `repeated` | empty list + single item + multiple items |
| `uint32` | typical value + 0 (min boundary) + max (4294967295) |
| `uint64` | typical value + 0 (min boundary) + max (18446744073709551615) — never use uint32 max here |
| `int32` | typical value + negative + max (2147483647) + min (-2147483648) |
| `int64` | typical value + 0 + max (9223372036854775807) + min (-9223372036854775808) |
| `bool` | both `true` and `false` |
| `string (ID)` | valid ID + empty string + malformed |

## oneof Fields (highest priority edge cases)

Every oneof variant must have its own test case.

```
oneof identity {
  string email = 1;
  string phone = 2;
}
→ plan: test email path, test phone path, test neither (if allowed)
```

## Response Shape with oneof result

```
oneof result {
  SuccessModel success = 1;
  ErrorModel error = 2;
}
→ success path: verify success field is set, error field is absent
→ error path: verify error field is set, success field is absent
→ never expect both simultaneously
```

## Test Count
- Never add placeholder test cases (e.g. "TBD", "Additional edge case"). If you run out of meaningful cases before reaching 10, stop there.
- More complex schemas (many fields, multiple oneof, map types) naturally produce more test cases — up to 10 is fine.

## What to Highlight in save_notes

Your notes must tell the implementer:
- Which fields are optional or oneof — both paths need testing
- Enum type name (so implementer knows where to import it)
- Any uint32/int64 fields — boundary values need special handling
- Service prerequisites: does this method need an existing user/contest/account?
- Any Insert-or-Replace semantics — what makes a record unique (Name? ID?)
