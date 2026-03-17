# skill-trade — Planner Context

## Services

| Service | Tests dir | Proto |
|---|---|---|
| Users | `tests/grpc/users/` | `UsersGrpcService.proto` |
| Partners | `tests/grpc/partners/` | `PartnersGrpcService.proto` |
| ContestEngine | `tests/grpc/contest-engine/` | `ContestEngine.proto` |
| XpEngine | `tests/grpc/xpengine/` | `XpEngine.proto` |
| BrokerIntegration | `tests/grpc/broker-integration/` | `BrokerIntegration.proto` |
| BrokerSettings | `tests/grpc/broker-settings/` | `BrokerSettings.proto` |
| TraderSettings | `tests/grpc/trader-settings/` | `TraderSettings.proto` |
| ClientWallets | `tests/grpc/client-wallets/` | `ClientWallets.proto` |

## Coverage Targets

| Module | Target | Priority |
|---|---|---|
| Users, ContestEngine, XpEngine, ClientWallets | 100% | P1 |
| All other services | 80% minimum | P2 |

## ContestEngine Specifics

Contest lifecycle: **create → publish → register → start → end**
- User must be registered before any contest operation
- Use future date for contest start (+1 day minimum)
- `createContest` has a built-in 1s delay — account for it in flow tests
- Default allowed assets: `["ETHUSD", "BTCUSD"]` (progressive only)

## XpEngine Specifics

- Always register user first, then manipulate XP state
- Use `XpEngineXpGrpcType` enum for trader/partner types

## Hard Constraints

- Proto files are the source of truth for field names and types
- NEVER hardcode IDs, timestamps, or environment-specific values in test plans
- Each test must be fully self-contained — no dependencies between tests
