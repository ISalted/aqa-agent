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

Format: `{TEST-ID} | {Type} | {Short description}`
- TEST-ID: `{SERVICE-PREFIX}-{NUMBER}` (e.g., CW-001, ME-001)
- Type: Schema, Positive, Negative, Boundary, Edge

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
