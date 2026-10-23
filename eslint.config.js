import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: [
			"**/node_modules/**",
			"**/dist/**",
			"packages/proto-ts/src/gen/**",
			"brand/generated/**",
			// Native projects and the bundle copied into them (npx cap add / sync).
			"apps/mobile/ios/**",
			"apps/mobile/android/**",
			"apps/mobile/www/**",
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
		// Accessibility of the JSX: labels, roles, alt text, keyboard access.
		// Its peer range stops at ESLint 9; it only reads the AST and the
		// context methods ESLint 10 still has, and lint fails loudly if not.
		files: ["apps/web/**/*.tsx"],
		...jsxA11y.flatConfigs.recommended,
		rules: {
			...jsxA11y.flatConfigs.recommended.rules,
			// Radio cards put their text two elements under the label
			// (label > span > b); the default search depth of 2 misses it.
			"jsx-a11y/label-has-associated-control": ["error", { depth: 3 }],
		},
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
