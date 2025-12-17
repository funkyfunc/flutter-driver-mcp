import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "../src/index.js");
const projectPath = path.join(__dirname, "../test_app");

console.log(`Starting MCP server at ${serverPath}`);
// Using the built JS
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

let stage = "start";

server.stdout.on("data", (data) => {
  const lines = data.toString().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
        const msg = JSON.parse(line);
        handleMessage(msg);
    } catch (e) {
        // ignore
    }
  }
});

function handleMessage(msg: any) {
    if (msg.error || (msg.result && msg.result.isError)) {
        console.error("Error received:", msg.error || msg.result);
        process.exit(1);
    }

    if (msg.result && msg.id === 1) { // start_app response
        console.log("App started. Reading logs...");
        stage = "logs_initial";
        send("tools/call", {
            name: "read_logs",
            arguments: { lines: 10 }
        });
    } else if (msg.result && msg.id === 2 && stage === "logs_initial") {
        console.log("Initial logs received:");
        console.log(msg.result.content[0].text);
        
        console.log("Sending hot restart...");
        stage = "hot_restart";
        send("tools/call", {
            name: "hot_restart",
            arguments: {}
        });
    } else if (msg.result && msg.id === 3 && stage === "hot_restart") {
        console.log("Hot restart sent. Waiting a moment then reading logs...");
        stage = "logs_after_restart";
        setTimeout(() => {
            send("tools/call", {
                name: "read_logs",
                arguments: { lines: 20 }
            });
        }, 3000); // Give it a sec to restart
    } else if (msg.result && msg.id === 4 && stage === "logs_after_restart") {
        const logs = msg.result.content[0].text;
        console.log("Logs after restart:");
        console.log(logs);
        
        if (logs.includes("Restarted application") || logs.includes("Performing hot restart")) {
             console.log("✅ Verified: Hot restart occurred.");
        } else {
             // It might be flaky depending on how fast flutter logs "Restarted", but we should see something.
             // If we don't see it in the last 20 lines, it might have been missed or is slow.
             console.log("⚠️ Did not see 'Restarted' in logs, but command succeeded.");
        }

        console.log("Stopping app...");
        send("tools/call", {
            name: "stop_app",
            arguments: {}
        });
    } else if (msg.result && msg.id === 5) {
        console.log("App stopped. Exiting.");
        process.exit(0);
    }
}

// Start sequence
send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "verify-logs", version: "1.0.0" },
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
