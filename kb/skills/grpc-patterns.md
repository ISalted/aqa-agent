# gRPC Test Patterns

## File Structure

Every test file follows this exact structure:

```typescript
import { test, expect } from '../../../lib/fixtures';
import { createCheckers } from 'ts-interface-checker';
// ... other imports

test.describe('{ServiceName} — {MethodName}', () => {

  test('Schema | Validate response', async ({ grpcClient }) => {
    // Schema validation — ALWAYS FIRST
  });

  test('{METHOD-ID} | Happy path description', async ({ grpcClient }) => {
    // Positive test case
  });

  test('{METHOD-ID} | Negative scenario', async ({ grpcClient }) => {
    // Negative test case
  });
});
```

## Test Naming

Format: `{TEST-ID}: {Short description}`
- TEST-ID: `{PREFIX}-{NNN}`
- PREFIX: exactly 3 uppercase letters derived from the method/topic mnemonic
- NNN: zero-padded sequence starting from `001`
- The schema test is always first and must also use the same sequence
- Do NOT use `Schema | ...`, `Positive | ...`, or unnumbered titles

Examples:
- `UCW-001: Schema validation for UpdateClientWallet response`
- `UCW-002: Deposit increases wallet balance`
- `GCW-001: Schema validation for GetClientWallets response`
- `CRG-001: Cancel registration for registered account succeeds`

The scenario type (`schema`, `positive`, `negative`, `boundary`, `edge`) belongs in metadata/plan fields, not in the human-readable test title prefix.

## Service Wrapper Calls

```typescript
// Always access via grpcClient fixture
const response = await grpcClient.clientWallets.getWallets({
  ProcessId: helpers.generateProcessId(),
  TradingAccountId: accountId,
});
```

## Error Handling

```typescript
// gRPC errors come as thrown exceptions
try {
  await grpcClient.service.method({ /* invalid data */ });
  expect(true).toBe(false); // Should not reach here
} catch (error: any) {
  expect(error.code).toBe(grpc.status.INVALID_ARGUMENT);
  expect(error.details).toContain('expected error text');
}
```

## Important

- One file per RPC method
- `test.describe()` wraps all tests for a method
- Fixture `grpcClient` is provided by Playwright — never instantiate manually
- Each test is independent — no shared mutable state between tests
