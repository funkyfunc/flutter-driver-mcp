import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "../src/index.js");

const server = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "inherit"] });

server.stdout.on("data", (data) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const json = JSON.parse(line);
            if (json.id === 1) {
                // List tools response
                const tools = json.result.tools;
                const hasScrollUntilVisible = tools.some((t: any) => t.name === "scroll_until_visible");
                const getWidgetTree = tools.find((t: any) => t.name === "get_widget_tree");
                const hasSummaryOnly = getWidgetTree.inputSchema.properties.summaryOnly !== undefined;
                
                if (hasScrollUntilVisible && hasSummaryOnly) {
                    console.log("✅ scroll_until_visible found and get_widget_tree has summaryOnly");
                    process.exit(0);
                } else {
                    console.error("❌ Tools verification failed");
                    console.log(JSON.stringify(tools, null, 2));
                    process.exit(1);
                }
            }
        } catch (e) {}
    }
});

server.stdin.write(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
}) + "\n");

