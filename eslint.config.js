import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: [
			"**/node_modules/**",
			"**/dist/**",
			"packages/proto-ts/src/gen/**",
			"packages/brand/generated/**",
			"plans/**",
		],
	},
	js.configs.recommended,
	...tseslint.configs.strict,
	{
		rules: {
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-non-null-assertion": "error",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
		},
	},
	{
		files: ["apps/web/**/*.{ts,tsx}"],
		...reactHooks.configs.flat.recommended,
	},
	{
		files: ["**/*.mjs", "scripts/**"],
		languageOptions: {
			globals: { process: "readonly", console: "readonly", URL: "readonly" },
		},
	},
	{
		// CommonJS config files (pm2 ecosystem).
		files: ["**/*.cjs"],
		languageOptions: {
			sourceType: "commonjs",
			globals: { module: "writable", require: "readonly" },
		},
	},
);
