# gRPC Test Patterns

## File Structure

Every test file follows this exact structure:

```typescript
import { test, expect } from "@fixtures";
import { ServiceErrorType } from "@lib/clients/gRPC/services/generated/{Service}/{Service}_pb";
import { createCheckers } from "ts-interface-checker";
import serviceTypes from "@lib/clients/gRPC/types/{service}/{service}.types-ti";

const { MethodNameResponse: ResponseChecker } = createCheckers(serviceTypes);

test.describe("{ServiceName} — {MethodName} @grpc @{service} @{method-kebab} @S{8hex}", () => {

  test("PREFIX-001: Schema validation for MethodName response @T{8hex}", async ({ gRPC }) => {
    // Schema validation — ALWAYS FIRST
    const response = await gRPC.{service}.{methodName}(/* minimal valid args */);
    ResponseChecker.strictCheck(response);
  });

  test("PREFIX-002: Happy path description @T{8hex}", async ({ gRPC }) => {
    // Positive test case
  });

  test("PREFIX-003: Negative scenario @T{8hex}", async ({ gRPC }) => {
    // Negative test case
  });
});
```

## Test Naming

Format: `{PREFIX}-{NNN}: {Short description}`
- PREFIX: exactly 3 uppercase letters from the method name (see derivation rule below)
- NNN: zero-padded sequence starting from `001`
- Schema test is always `PREFIX-001`
- Do NOT use `Schema | ...`, `Positive | ...`, or unnumbered titles

**Prefix derivation:** take first letter of each CamelCase word left to right.
If fewer than 3 words, pad with next letters of the first word.
- `UpdateClientWallet` → U+C+W → **UCW**
- `GetClientWallets`   → G+C+W → **GCW**
- `GetMission`         → G+M → pad → **GMI**
- `CreateUser`         → C+U → pad → **CRU**

Examples:
- `UCW-001: Schema validation for UpdateClientWallet response`
- `UCW-002: Deposit increases wallet balance`
- `GCW-001: Schema validation for GetClientWallets response`
- `CRG-001: Cancel registration for registered account succeeds`

The scenario type (`schema`, `positive`, `negative`, `boundary`, `edge`) belongs in metadata/plan fields, not in the human-readable test title.

## Tags

Every `test.describe` and every `test` must include Testomatio tags:

```typescript
// describe — suite-level tags
test.describe("gRPC Users Service - RegisterUser @grpc @users @register-user @S846f8e1d", () => {
  // test — individual test tag
  test("REG-001: Register user successfully with valid data @T81627bc6", async ({ gRPC }) => {
```

- `@grpc` — always present
- `@{service}` — service name lowercase (e.g. `@users`, `@contest-engine`)
- `@{method-kebab}` — method name in kebab-case (e.g. `@register-user`)
- `@S{8hex}` — Testomatio suite ID (generate a random 8-char hex)
- `@T{8hex}` — Testomatio test ID on every `test()` call (generate a random 8-char hex)

## Service Wrapper Calls

```typescript
// Always access via gRPC fixture — use positional args as defined in the wrapper
const response = await gRPC.users.registerUser(email, password);
const response = await gRPC.contestEngine.createContest(name, startDate, assets);

// Check the service wrapper file to get the exact method signature
```

## Error Handling

This project returns errors as structured fields in the response — NOT as thrown exceptions.

```typescript
// ✅ Correct — errors are in the response object
const response = await gRPC.service.method(invalidArgs);
expect(response.error).toBeDefined();
expect(response.error?.errortype).toBe(ServiceErrorType.SOME_ERROR);
expect(response.successField).toBeUndefined();

// ✅ Multiple valid error types (when validation order is non-deterministic)
expect([ServiceErrorType.ERROR_A, ServiceErrorType.ERROR_B])
  .toContain(response.error?.errortype);

// ❌ Wrong — do NOT use try/catch for business logic errors
try {
  await gRPC.service.method(invalidArgs);
} catch (error: any) { ... }
```

## Important

- One file per RPC method
- `test.describe()` wraps all tests for a method
- Fixture is `gRPC` — never instantiate gRPC clients manually
- Each test is independent — no shared mutable state between tests
- Always read the service wrapper to get exact method signatures before writing tests
