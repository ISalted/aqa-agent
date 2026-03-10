# Error Assertions for gRPC Tests

## gRPC Status Codes

| Code | Name | When to test |
|---|---|---|
| 0 | OK | Successful responses |
| 3 | INVALID_ARGUMENT | Missing required fields, invalid values |
| 5 | NOT_FOUND | Non-existent resource IDs |
| 6 | ALREADY_EXISTS | Duplicate creation attempts |
| 7 | PERMISSION_DENIED | Unauthorized access |
| 13 | INTERNAL | Server-side errors |
| 14 | UNAVAILABLE | Service down (infra test) |

## Assertion Patterns

### Successful response
```typescript
const response = await grpcClient.service.method(validRequest);
expect(response).toBeDefined();
expect(response.SomeField).toBeDefined();
```

### Expected error
```typescript
try {
  await grpcClient.service.method(invalidRequest);
  throw new Error('Expected error was not thrown');
} catch (error: any) {
  expect(error.code).toBe(3); // INVALID_ARGUMENT
  expect(error.details).toContain('specific error text');
}
```

### Error enum values (project-specific)
Some services return structured errors with enum types:
- `ValidationError` — field-level validation failures
- `NoSqlError` — database operation failures
- `NotFoundError` — resource not found

Check the proto contract for service-specific error enums.

## Common Mistakes

- Don't assert on exact error messages if they change frequently
- Don't use `expect().rejects.toThrow()` — use try/catch for gRPC errors
- Always assert the error code, not just that an error was thrown
- Check both `error.code` and `error.details` for comprehensive validation
