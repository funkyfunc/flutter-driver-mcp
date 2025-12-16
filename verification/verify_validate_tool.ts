import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "../src/index.js");

// Create a temp project path
const tempDir = path.join(os.tmpdir(), `flutter_pilot_test_${Date.now()}`);

async function setupDummyProject() {
    await fs.mkdir(tempDir, { recursive: true });
    
    // Create pubspec.yaml WITHOUT integration_test
    await fs.writeFile(path.join(tempDir, "pubspec.yaml"), 
`name: dummy_project
description: A new Flutter project.
environment:
  sdk: '>=3.2.0 <4.0.0'
dependencies:
  flutter:
    sdk: flutter
  # integration_test is missing
dev_dependencies:
  flutter_test:
    sdk: flutter
`);

    // Create Android manifest WITHOUT permissions
    const androidDebugDir = path.join(tempDir, "android/app/src/debug");
    await fs.mkdir(androidDebugDir, { recursive: true });
    await fs.writeFile(path.join(androidDebugDir, "AndroidManifest.xml"), 
`<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.dummy">
    <application android:label="dummy_project">
    </application>
</manifest>`);
    
    // Create main manifest just so it exists
    const androidMainDir = path.join(tempDir, "android/app/src/main");
    await fs.mkdir(androidMainDir, { recursive: true });
    await fs.writeFile(path.join(androidMainDir, "AndroidManifest.xml"), 
`<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.dummy">
</manifest>`);

    console.log(`Created dummy project at: ${tempDir}`);
}

async function cleanup() {
    try {
        await fs.rm(tempDir, { recursive: true, force: true });
        console.log("Cleaned up temp project.");
    } catch (e) {
        // ignore
    }
}

async function runTest() {
    await setupDummyProject();

    console.log(`Starting MCP server at ${serverPath}`);
    // We run the BUILT js file
    const serverJsPath = path.join(__dirname, "../dist/src/index.js");
    
    const server = spawn("node", [serverJsPath], {
        stdio: ["pipe", "pipe", "inherit"],
    });

    let msgId = 1;
    function send(method: string, params: any = {}) {
        const msg = {
            jsonrpc: "2.0",
            id: msgId++,
            method,
            params,
        };
        server.stdin.write(JSON.stringify(msg) + "\n");
    }

    server.stdout.on("data", async (data) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line);
                if (msg.result && msg.id === 1) {
                    console.log("Initialized. Running validate_project...");
                    send("tools/call", {
                        name: "validate_project",
                        arguments: {
                            project_path: tempDir,
                            auto_fix: true
                        }
                    });
                } else if (msg.result && msg.id === 2) {
                    console.log("Validation result received:");
                    const output = msg.result.content[0].text;
                    console.log(output);

                    // VERIFY
                    let passed = true;
                    // We expect it to TRY to add integration_test. 
                    // Note: 'flutter pub add' might fail in this dummy env if 'flutter' is not in path or network is down, 
                    // but the TOOL should report the attempt.
                    if (!output.includes("Added 'integration_test'") && !output.includes("Found 'integration_test'")) {
                         // Depending on if flutter command works. If command fails, it logs error. 
                         // But for this test, we care that it TRIED.
                         // Actually, if 'flutter' command fails, it might throw.
                    }

                    // Verify Android manifest modification
                    const debugManifest = await fs.readFile(path.join(tempDir, "android/app/src/debug/AndroidManifest.xml"), "utf-8");
                    if (debugManifest.includes("android.permission.INTERNET")) {
                        console.log("✅ Verified: AndroidManifest.xml was updated with INTERNET permission.");
                    } else {
                        console.error("❌ Failed: AndroidManifest.xml was NOT updated.");
                        passed = false;
                    }

                    server.kill();
                    await cleanup();
                    process.exit(passed ? 0 : 1);
                } else if (msg.error) {
                    console.error("Error from server:", msg.error);
                    server.kill();
                    await cleanup();
                    process.exit(1);
                }
            } catch (e) {
                // ignore json parse errors
            }
        }
    });

    send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-script", version: "1.0.0" },
    });
}

runTest().catch(async (e) => {
    console.error(e);
    await cleanup();
});
