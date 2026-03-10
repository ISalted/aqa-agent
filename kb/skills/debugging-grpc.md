# Debugging gRPC Test Failures

## Decision Tree

```
Test Failed
├── Compilation Error?
│   ├── Import path wrong → check lib/ structure
│   ├── Type mismatch → proto changed? Run npm run proto
│   └── Missing module → check if wrapper/types exist
│
├── Runtime Error?
│   ├── ECONNREFUSED → service not running
│   ├── UNAVAILABLE → service starting up / network issue
│   ├── DEADLINE_EXCEEDED → slow service, increase timeout?
│   └── UNIMPLEMENTED → method not deployed yet
│
├── Assertion Failed?
│   ├── Schema check failed → proto updated, types stale
│   ├── Wrong field name → check proto for exact casing
│   ├── Unexpected null → field is optional in proto
│   └── Wrong error code → check backend validation logic
│
└── Flaky (passes sometimes)?
    ├── Shared state → tests must be independent
    ├── Timing → no sleep() — find proper signal
    └── Data collision → use unique data per test
```

## Common Fixes

### Import Path Issues
- Fixtures: `../../../lib/fixtures`
- Helpers: `../../../lib/helpers/helpers`
- Types: `../../../lib/clients/gRPC/types/{service}/`
- Depth depends on test file location in `tests/grpc/{service}/`

### Proto/Type Mismatch
1. Run `npm run proto` to regenerate types
2. Check the proto file for field name casing (PascalCase in proto → PascalCase in TS)
3. Optional fields may be `undefined` — handle with optional chaining

### Service Wrapper Mismatch
1. Read the wrapper file to see actual method signatures
2. Wrapper may use different parameter names than proto
3. Some wrappers add ProcessId automatically — don't duplicate

### Test Independence
- Never store results from one test to use in another
- Always generate fresh data per test
- Don't depend on test execution order
