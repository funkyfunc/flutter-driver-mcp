# Contributing to Flutter Pilot MCP

Thank you for your interest in contributing to Flutter Pilot MCP! This project acts as the vital bridge between AI agents (via the Model Context Protocol) and Flutter applications (via the `integration_test` harness). 

## 🚀 Getting Started

1. **Clone the repository**
2. **Install dependencies**: `npm install`
3. **Build the project**: `npm run build`

## 🧪 Development Workflow

Any time you modify the TypeScript source or the Dart harness (`src/harness.dart`), you must ensure the project is fully tested. We have a robust, strict validation pipeline:

- **Format**: `npm run format` (Biome)
- **Lint**: `npm run lint:fix` (Biome)
- **Typecheck**: `npm run typecheck`
- **Verify Harness**: `npm run verify-harness` (Runs the Dart analyzer on the injected code)
- **Verify Tools**: `npm run verify-tools` (Instantiates the MCP server and validates the 24+ Zod schemas)

👉 **The God Command**: You can run all of the above sequentially using:
```bash
npm run validate
```

### End-to-End Integration Testing

To truly test your changes, you must run the integration test suite, which boots up our bundled Flutter `test_app` on macOS and executes every single tool natively over the actual WebSocket connection.

```bash
npm run verify-integration
```
*Note: You must have the Flutter SDK installed and configured on your machine to run the end-to-end integration tests.*

## 🧠 Code Architecture & Guidelines

Before making major changes or adding new tools, you MUST read our internal architecture guide: **[AGENTS.md](./AGENTS.md)**. 

Both humans and AI agents must abide by the conventions described there. Of particular importance:
1. **Optimize for Cognitive Load**: Use intent-based naming.
2. **Flatten the Logic**: Use aggressive early returns and guard clauses.
3. **Unified Selectors**: Make life easy for LLMs by parsing flat target string selectors.

## 💬 Pull Requests

- Keep PRs strictly focused on a single responsibility.
- **Ensure that `npm run validate` and `npm run verify-integration` pass locally before submitting your PR.**
- If you add a new tool, document it in `AGENTS.md`, and add a validation step inside `verification/verify_integration.ts` to guarantee we maintain full test coverage!
