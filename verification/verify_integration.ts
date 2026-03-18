import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "../src/index.js");
const projectPath = path.join(__dirname, "../../test_app");

console.log(`[Integration] Starting MCP server at ${serverPath}`);
const server = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
});

// Ensure the server process is always cleaned up
function cleanup() {
  try { server.kill("SIGKILL"); } catch(e) {}
  // Also kill any orphaned flutter processes from the test
  try {
    const { execSync } = require("child_process");
    execSync("pkill -f 'test_app.*flutter'", { stdio: "ignore" });
    execSync("pkill -f 'test_app.app'", { stdio: "ignore" });
  } catch(e) {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });
process.on("SIGTERM", () => { cleanup(); process.exit(1); });
process.on("uncaughtException", (e) => { console.error(e); cleanup(); process.exit(1); });

let msgId = 1;
const expectedCallbacks = new Map<number, (res: any) => void>();

function send(method: string, params: any = {}): Promise<any> {
  const id = msgId++;
  const msg = {
    jsonrpc: "2.0",
    id,
    method,
    params,
  };
  const str = JSON.stringify(msg);
  console.log(`\n[Client -> Server]: ${str}`);
  server.stdin.write(str + "\n");
  
  return new Promise((resolve, reject) => {
    expectedCallbacks.set(id, (res) => {
      if (res.error || (res.result && res.result.isError)) {
        reject(res.error || res.result);
      } else {
        resolve(res.result);
      }
    });
  });
}

server.stdout.on("data", (data) => {
  const lines = data.toString().split("\n");
  for (const line of lines) {
    if (!line.trim() || line.startsWith("MCP:")) continue; // ignore raw dart stdout for parsing
    try {
        const json = JSON.parse(line);
        if (json.id && expectedCallbacks.has(json.id)) {
            const cb = expectedCallbacks.get(json.id)!;
            expectedCallbacks.delete(json.id);
            console.log(`[Server -> Client]: ${JSON.stringify(json).substring(0, 200)}...`);
            cb(json);
        }
    } catch (e) {
        // console.error("Failed to parse JSON:", line);
    }
  }
});

async function runTests() {
  try {
    // 0. Init
    await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "verify-script", version: "1.0.0" },
    });

    console.log("Initialized. Starting app...");
    await send("tools/call", {
        name: "start_app",
        arguments: { project_path: projectPath, device_id: "macos" }
    });

    console.log("App active. Waiting a moment to settle...");
    await new Promise(r => setTimeout(r, 2000));

    // 1. Assert exists
    console.log("\n--- Testing assert_exists ---");
    await send("tools/call", { name: "assert_exists", arguments: { target: "text=\"Welcome Home\"" } });
    
    // 2. Assert text equals
    console.log("\n--- Testing assert_text_equals ---");
    await send("tools/call", { name: "assert_text_equals", arguments: { target: "#welcome_text", expectedText: "Welcome Home" } });
    
    // 3. Enter text
    console.log("\n--- Testing enter_text ---");
    await send("tools/call", { name: "enter_text", arguments: { target: "type=TextField", text: "Hello World" } });
    await send("tools/call", { name: "assert_text_equals", arguments: { target: "type=TextField", expectedText: "Hello World" } });

    // 4. Tap & check state (Checkbox)
    console.log("\n--- Testing assert_state (checkbox false) ---");
    await send("tools/call", { name: "assert_state", arguments: { target: "#my_checkbox", stateKey: "value", expectedValue: false } });
    console.log("\n--- Testing tap (checkbox) ---");
    await send("tools/call", { name: "tap", arguments: { target: "#my_checkbox" } });
    console.log("\n--- Testing assert_state (checkbox true) ---");
    await send("tools/call", { name: "assert_state", arguments: { target: "#my_checkbox", stateKey: "value", expectedValue: true } });

    // 5. Explore screen
    console.log("\n--- Testing explore_screen ---");
    const exploreRaw = await send("tools/call", { name: "explore_screen", arguments: {} });
    const exploreResText = exploreRaw.content[0].text;
    const exploreRes = JSON.parse(exploreResText);
    
    if (!exploreRes.interactive_elements_count || exploreRes.interactive_elements_count < 3) {
      console.log(exploreResText);
      throw new Error(`Expected at least 3 interactive elements, got ${exploreRes.interactive_elements_count}`);
    }
    
    // 6. Navigate directly
    console.log("\n--- Testing navigate_to ---");
    await send("tools/call", { name: "navigate_to", arguments: { route: "/details" } });
    
    // 7. Verify we are on details screen
    console.log("\n--- Testing assert_exists (Details Screen) ---");
    await send("tools/call", { name: "assert_exists", arguments: { target: "text=\"Item 5\"" } });

    // 8. Stop
    console.log("\n✅ ALL INTEGRATION TESTS PASSED!");
    await send("tools/call", { name: "stop_app", arguments: {} });
    process.exit(0);

  } catch (error) {
    console.error("❌ TEST FAILED:", error);
    try { await send("tools/call", { name: "stop_app", arguments: {} }); } catch(e){}
    process.exit(1);
  }
}

// Start sequence
runTests();
