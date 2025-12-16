# Flutter Test Pilot MCP Server

An MCP server that enables LLMs to drive Flutter applications using `integration_test`.

## Architecture
- **Host**: Node.js MCP Server.
- **Client**: Dart Harness running inside the Flutter app.
- **Protocol**: JSON-RPC over WebSocket.

## Installation

```bash
npm install
npm run build
```

## Usage

Add to your MCP Client configuration (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "flutter-pilot": {
      "command": "node",
      "args": ["/path/to/flutter-test-pilot-mcp/dist/src/index.js"]
    }
  }
}
```

## Tools

- `validate_project`: Checks project prerequisites (dependencies, entitlements) and can `auto_fix` them.
- `start_app`: Injects the harness and starts the app.
- `tap`: Tap a widget.
- `enter_text`: Enter text.
- `get_widget_tree`: Get the UI state.
- `stop_app`: Stop the session.
