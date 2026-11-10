import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  {
    rules: {
      eqeqeq: "error",
      "no-var": "error",
      "prefer-const": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Extension pages: ES modules with the DOM and the chrome.* APIs.
    files: ["src/panel/**/*.js"],
    languageOptions: { sourceType: "module", globals: { ...globals.browser, chrome: "readonly" } },
  },
  {
    // The content script is a classic script: it cannot import modules.
    files: ["src/content.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, chrome: "readonly" } },
  },
  {
    files: ["src/background.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.serviceworker, chrome: "readonly" },
    },
  },
  {
    files: ["scripts/**/*.mjs", "tests/unit/**/*.js", "eslint.config.js"],
    languageOptions: { sourceType: "module", globals: globals.node },
  },
];
