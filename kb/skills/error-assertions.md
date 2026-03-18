# Error Assertions for gRPC Tests

## Key Principle

This project returns errors as structured fields in the response object — NOT as thrown exceptions.
Never use try/catch for business logic error testing.

## Assertion Patterns

### Successful response
```typescript
const response = await gRPC.service.method(validArgs);
ResponseChecker.strictCheck(response);
expect(response.successField).toBeDefined();
expect(response.error).toBeUndefined();
```

### Expected error — single type
```typescript
const response = await gRPC.service.method(invalidArgs);
expect(response.error).toBeDefined();
expect(response.error?.errortype).toBe(ServiceErrorType.SOME_ERROR);
expect(response.successField).toBeUndefined();
```

### Expected error — multiple valid types
```typescript
// Use when validation order is non-deterministic
const response = await gRPC.service.method(invalidArgs);
expect([ServiceErrorType.ERROR_A, ServiceErrorType.ERROR_B])
  .toContain(response.error?.errortype);
```

### Error enum imports
```typescript
// Import error enums from generated code:
import { UsersGrpcErrorType } from "@lib/clients/gRPC/services/generated/UsersGrpcService/UsersGrpcService_pb";
import { ContestEngineErrorType } from "@lib/clients/gRPC/services/generated/ContestEngineService/ContestEngine_pb";
import { XpEngineXpGrpcType } from "@lib/clients/gRPC/services/generated/XpEngine/XpEngine_pb";
```

## Error Enum Values (project-specific)

| Enum | Variants |
|---|---|
| `UsersGrpcErrorType` | `EMAIL_MISSING_AT`, `EMAIL_LOCAL_DOT_RULES`, `EMAIL_LABEL_EDGE_HYPHEN`, ... |
| `ContestEngineErrorType` | `ValidationError`, `NoSqlError`, `NotFoundError` |

Check the proto contract for the full list of service-specific error enum values.

## Common Mistakes

- Do NOT use `try/catch` — errors come back in the response, not as exceptions
- Do NOT use `expect().rejects.toThrow()` — same reason
- Always assert the specific `errortype` enum value, not just that `error` is defined
- Always assert the success field is `undefined` when testing error paths
- Always assert the error field is `undefined` when testing success paths
