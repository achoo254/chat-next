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
		// recommended-latest: the hooks rules plus every React Compiler rule, so
		// code the compiler would skip fails lint instead of shipping unoptimized.
		files: ["apps/web/**/*.{ts,tsx}"],
		...reactHooks.configs.flat["recommended-latest"],
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
		// pm2 loads them with require(): CommonJS imports are the only kind.
		rules: { "@typescript-eslint/no-require-imports": "off" },
	},
);
