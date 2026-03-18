# Schema Validation Pattern

Every test file MUST start with a schema validation test as the first test case.

## Pattern

```typescript
import { createCheckers } from "ts-interface-checker";
import serviceTypes from "@lib/clients/gRPC/types/{service}/{service}.types-ti";

const { MethodNameResponse: ResponseChecker } = createCheckers(serviceTypes);

test.describe("... @grpc @{service} @S{8hex}", () => {
  test("PREFIX-001: Schema validation for MethodName response @T{8hex}", async ({ gRPC }) => {
    const response = await gRPC.{service}.{methodName}(/* minimal valid args */);
    ResponseChecker.strictCheck(response);  // throws if response doesn't match schema
  });
});
```

## Rules

- Import the `-ti` (type info) file using `@lib/...` alias, not relative paths
- Destructure the checker at module level: `const { ResponseType: ResponseChecker } = createCheckers(...)`
- Call `.strictCheck()` — it throws if the response doesn't match the schema
- Schema test is always `PREFIX-001` and is always the first test in the describe block
- If schema validation fails, all other tests for this method are meaningless

## Type Info Files

Type info files are generated alongside proto types. They live in:
`lib/clients/gRPC/types/{service}/{typeName}.types-ti.ts`

Import using the `@lib` alias:
```typescript
import usersTypes from "@lib/clients/gRPC/types/users/users.types-ti";
import contestEngineTypes from "@lib/clients/gRPC/types/contest-engine/contestEngine.types-ti";
```

If the `-ti` file doesn't exist, run `npm run proto` first.
