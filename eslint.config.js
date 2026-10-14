import js from "@eslint/js";
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
		files: ["**/*.mjs", "scripts/**"],
		languageOptions: {
			globals: { process: "readonly", console: "readonly", URL: "readonly" },
		},
	},
);
