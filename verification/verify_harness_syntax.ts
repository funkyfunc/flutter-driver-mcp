import { execa } from 'execa';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getHarnessCode } from '../src/harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    console.log('[Verify] Starting Dart Harness Syntax Verification...');
    
    // 1. Get the generated Dart code from the template
    // 1. Get the generated Dart code from the template (using 'test_app' so imports match the dummy project)
    const dartCode = getHarnessCode('test_app');

    // 2. Define path to the test app
    const testAppPath = path.resolve(__dirname, '../../test_app');
    const integrationTestDir = path.join(testAppPath, 'integration_test');
    const harnessFilePath = path.join(integrationTestDir, 'mcp_harness.dart');

    try {
        // 3. Ensure integration_test directory exists in test_app
        await fs.mkdir(integrationTestDir, { recursive: true });

        // 4. Write the generated Dart code to the test_app
        await fs.writeFile(harnessFilePath, dartCode, 'utf-8');
        console.log(`[Verify] Wrote generated harness to ${harnessFilePath}`);

        // 5. Run 'dart analyze' on that file
        console.log('[Verify] Running "dart analyze"...');
        const result = await execa('dart', ['analyze', 'integration_test/mcp_harness.dart'], {
            cwd: testAppPath,
            reject: false
        });

        console.log(`[Debug] exitCode=${result.exitCode}`);
        const errorLines = result.stdout.split('\n').filter(line => line.includes('error -'));
        if (errorLines.length > 0) {
            console.log(`❌ ACTUAL ERRORS FOUND:\n${errorLines.join('\n')}`);
            process.exit(1);
        }

        console.log('✅ [Verify] SUCCESS: Harness Dart code has no syntax errors!');
        process.exit(0);
    } catch (e: any) {
        console.log(`[Debug] CAUGHT EXCEPTION: ${e}`);
        process.exit(1);
    } finally {
        try { await fs.unlink(harnessFilePath); } catch (e) {}
    }
}

main();
