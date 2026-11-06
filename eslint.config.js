import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["frontend/vendor/**", "node_modules/**"],
  },
  js.configs.recommended,
  {
    files: ["frontend/**/*.js"],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "module",
      globals: {
        ...globals.browser,
        marked: "readonly",
        hljs: "readonly",
        mermaid: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off",
    },
  },
];
