# Schema Validation Pattern

Every test file MUST start with a schema validation test as the first test case.

## Pattern

```typescript
import { createCheckers } from 'ts-interface-checker';
import responseTI from '../../../lib/clients/gRPC/types/{service}/{ResponseType}-ti';

test('Schema | Validate {MethodName} response', async ({ grpcClient }) => {
  const response = await grpcClient.{serviceName}.{methodName}({
    // minimal valid request
  });
  
  const checker = createCheckers(responseTI);
  checker.{ResponseType}.check(response);
});
```

## Rules

- Import the `-ti` (type info) file, not the regular type file
- Use `createCheckers()` to create the checker instance
- Call `.check()` — it throws if the response doesn't match the schema
- This test must pass before any other tests run
- The schema test validates that the backend response matches the proto contract
- If schema validation fails, all other tests for this method are meaningless

## Type Info Files

Type info files are generated alongside proto types. They live in:
`lib/clients/gRPC/types/{service}/{TypeName}-ti.ts`

If the `-ti` file doesn't exist, run `npm run proto` first.
