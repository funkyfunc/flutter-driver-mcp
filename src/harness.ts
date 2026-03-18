import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function getHarnessCode(packageName?: string): string {
  // Read harness.dart from the same directory at runtime
  const dartFilePath = path.join(__dirname, 'harness.dart');
  let content = fs.readFileSync(dartFilePath, 'utf-8');

  // Inject the dynamically built import and main() trigger based on the package name
  if (packageName) {
    content = content.replace(
      '// INJECT_IMPORT',
      `import 'package:${packageName}/main.dart' as app;`
    );
    content = content.replace(
      '// INJECT_MAIN',
      'app.main();'
    );
  }

  return content;
}