import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "../src/index.js");
const projectPath = path.join(__dirname, "../../test_app");

console.log(`Starting MCP server at ${serverPath}`);
const server = spawn("node", [serverPath], {
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

server.stdout.on("data", (data) => {
  const lines = data.toString().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    console.log(`[Server]: ${line}`);
    try {
        const json = JSON.parse(line);
        if (json.id === 1) {
             send("tools/call", {
                name: "validate_project",
                arguments: { project_path: projectPath }
            });
        } else if (json.id === 2) {
            console.log("Validation Result:", JSON.stringify(json.result, null, 2));
            process.exit(0);
        }
    } catch (e) {}
  }
});

send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "verify-validate", version: "1.0.0" },
});
