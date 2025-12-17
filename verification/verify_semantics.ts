import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Using the built JS
const serverJsPath = path.join(__dirname, "../dist/src/index.js");
const projectPath = path.join(__dirname, "../test_app");

console.log(`Starting MCP server at ${serverJsPath}`);

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

let stage = "start";

let buffer = "";

server.stdout.on("data", (data) => {
  buffer += data.toString();
  const lines = buffer.split("\n");
  // The last part might be incomplete
  buffer = lines.pop() || "";
  
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
        console.log(`[Client] Processing line: \${line.substring(0, 50)}...`);
        const msg = JSON.parse(line);
        handleMessage(msg);
    } catch (e) {
        console.log(`[Client] Failed to parse line: \${e.message}`);
    }
  }
});

function handleMessage(msg: any) {
    console.log(`[Client] Handling message ID: ${msg.id}, Stage: ${stage}`);
    if (msg.error || (msg.result && msg.result.isError)) {
        console.error("Error received:", msg.error || msg.result);
        server.kill();
        process.exit(1);
    }

    if (msg.result && msg.id === 2) { // start_app response (ID 2)
        console.log("App started. Reading logs first...");
        stage = "read_logs_initial";
        send("tools/call", {
            name: "read_logs",
            arguments: { lines: 10 }
        });
    } else if (msg.result && msg.id === 3 && stage === "read_logs_initial") { // read_logs (ID 3)
        console.log("Logs received. Now fetching accessibility tree...");
        // console.log(msg.result.content[0].text);
        stage = "get_a11y";
        send("tools/call", {
            name: "get_accessibility_tree",
            arguments: {}
        });
    } else if (msg.result && msg.id === 4 && stage === "get_a11y") { // get_a11y (ID 4)
        console.log("Accessibility tree received!");
        const treeJson = msg.result.content[0].text;
        // console.log(treeJson);
        const tree = JSON.parse(treeJson);
        
        // Basic assertion
        if (tree.id !== undefined && tree.rect !== undefined) {
            console.log(`✅ Verified: Root node has ID (\${tree.id}) and Rect. Tree size: \${treeJson.length} chars.`);
            console.log("!!! FULL SUCCESS !!!");
        } else {
            console.error("❌ Failed: Invalid accessibility tree structure.");
            console.error(treeJson);
            process.exit(1);
        }

        console.log("Testing screenshot (device mode)...");
        stage = "screenshot_device";
        send("tools/call", {
            name: "take_screenshot",
            arguments: { save_path: "verify_device.png" }
        });
    } else if (msg.result && msg.id === 5 && stage === "screenshot_device") { // screen1 (ID 5)
        console.log("✅ Screenshot (device) success.");
        
        console.log("Testing screenshot (skia mode)...");
        stage = "screenshot_skia";
        send("tools/call", {
            name: "take_screenshot",
            arguments: { save_path: "verify_skia.png", type: "skia" }
        });
    } else if (msg.result && msg.id === 6 && stage === "screenshot_skia") { // screen2 (ID 6)
        console.log("✅ Screenshot (skia) success.");
        
        console.log("Stopping app...");
        send("tools/call", {
            name: "stop_app",
            arguments: {}
        });
    } else if (msg.result && msg.id === 7) { // stop (ID 7)
        console.log("App stopped. Exiting.");
        process.exit(0);
    }
}

// Start sequence
send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "verify-semantics", version: "1.0.0" },
});

// Start App
setTimeout(() => {
    console.log("Starting app...");
    send("tools/call", {
        name: "start_app",
        arguments: {
            project_path: projectPath,
            device_id: "macos"
        }
    });
}, 100);
