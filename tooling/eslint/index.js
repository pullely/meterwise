// @ts-check
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

/** @type {import('eslint').Linter.FlatConfig[]} */
const config = [
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      // Guard against the public-id<->UUID-column bug class: a public actor id
      // (`*.subjectId`, e.g. `usr_<hex>`) must never be stored directly in a
      // UUID column (created_by / revoked_by / updated_by). Decode it first via
      // `uuidFromPublicId` from `@saas/db`. (The `Uuid` brand is the full
      // type-level guard; this catches the most common shape syntactically.)
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Property[key.name=/^(createdBy|revokedBy|updatedBy)$/] > MemberExpression[property.name='subjectId']",
          message:
            "Don't persist a public actor id (`*.subjectId`, e.g. `usr_<hex>`) into a UUID column (created_by/revoked_by/updated_by). Decode it first with `uuidFromPublicId` from `@saas/db`.",
        },
      ],
    },
  },
  {
    ignores: ["dist/**", ".wrangler/**", "coverage/**", "*.tsbuildinfo"],
  },
];

export default config;
