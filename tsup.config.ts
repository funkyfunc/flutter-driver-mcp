import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		"src/index": "src/index.ts",
		"verification/verify_harness_syntax":
			"verification/verify_harness_syntax.ts",
		"verification/verify_tools": "verification/verify_tools.ts",
		"verification/verify_integration": "verification/verify_integration.ts",
		"verification/verify_validate_tool": "verification/verify_validate_tool.ts",
	},
	format: ["esm"],
	target: "node20",
	clean: true,
	shims: true,
	dts: false,
	sourcemap: true,
	onSuccess: "mkdir -p dist/src && cp src/harness.dart dist/src/",
});
