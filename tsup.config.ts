import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		"src/index": "src/index.ts",
	},
	format: ["esm"],
	target: "node20",
	clean: true,
	shims: true,
	dts: false,
	sourcemap: false,
	onSuccess: "mkdir -p dist/src && cp src/harness.dart dist/src/",
});
