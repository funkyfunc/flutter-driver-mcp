"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const url_1 = require("url");
const __dirname = path_1.default.dirname((0, url_1.fileURLToPath)(import.meta.url));
const serverPath = path_1.default.join(__dirname, "../dist/index.js");
const projectPath = path_1.default.join(__dirname, "../test_app");
console.log(`Starting MCP server at ${serverPath}`);
const server = (0, child_process_1.spawn)("node", [serverPath], {
    stdio: ["pipe", "pipe", "inherit"],
});
let msgId = 1;
function send(method, params = {}) {
    const msg = {
        jsonrpc: "2.0",
        id: msgId++,
        method,
        params,
    };
    const str = JSON.stringify(msg);
    console.log(`[Client -> Server]: ${str}`);
    server.stdin.write(str + "\n");
}
server.stdout.on("data", (data) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
        if (!line.trim())
            continue;
        console.log(`[Server -> Client]: ${line}`);
        try {
            const json = JSON.parse(line);
            handleMessage(json);
        }
        catch (e) {
            // console.error("Failed to parse JSON:", line);
        }
    }
});
function handleMessage(msg) {
    if (msg.result && msg.id === 1) {
        // Initialize response
        console.log("Initialized. Starting app...");
        send("tools/call", {
            name: "start_app",
            arguments: {
                project_path: projectPath,
                device_id: "macos" // Force macOS for now as we are on darwin
            }
        });
    }
    else if (msg.result && msg.id === 2) {
        // Start app response
        console.log("App started! Getting widget tree...");
        send("tools/call", {
            name: "get_widget_tree",
            arguments: {}
        });
    }
    else if (msg.result && msg.id === 3) {
        // Widget tree response
        console.log("Got widget tree!");
        // console.log(JSON.stringify(msg.result, null, 2));
        console.log("Stopping app...");
        send("tools/call", {
            name: "stop_app",
            arguments: {}
        });
    }
    else if (msg.result && msg.id === 4) {
        console.log("App stopped. Exiting.");
        process.exit(0);
    }
    else if (msg.error) {
        console.error("Error:", msg.error);
        process.exit(1);
    }
}
// Start sequence
send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "verify-script", version: "1.0.0" },
});
