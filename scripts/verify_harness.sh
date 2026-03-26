#!/bin/sh
# Verify harness.dart Dart syntax by running flutter analyze inside the test_app Flutter project

HARNESS_SRC="$(dirname "$0")/../src/harness/harness.dart"
TEST_APP="$(dirname "$0")/../test_app"
TEMP_FILE="$TEST_APP/integration_test/mcp_harness_verify.dart"

mkdir -p "$TEST_APP/integration_test"

# Inject stub import/main so dart analyze can resolve all symbols
sed \
  -e "s|// INJECT_IMPORT|import 'package:test_app/main.dart' as app;|" \
  -e "s|// INJECT_MAIN|app.main();|" \
  "$HARNESS_SRC" > "$TEMP_FILE"

cd "$TEST_APP" && flutter pub get --no-example > /dev/null 2>&1 && flutter analyze integration_test/mcp_harness_verify.dart
EXIT=$?

rm -f "$TEMP_FILE"
exit $EXIT
