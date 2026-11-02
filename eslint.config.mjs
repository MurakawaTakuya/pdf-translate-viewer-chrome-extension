import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier/flat";

export default [
  {
    ignores: [
      "lib/**",
      "fonts/**",
      "icons/**",
      "LICENSES/**",
      "reports/**",
      "node_modules/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["*.js"],
    languageOptions: {
      globals: { ...globals.browser, chrome: "readonly", pdfjsLib: "readonly" },
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  { rules: { "no-unused-vars": ["error", { ignoreRestSiblings: true }] } },
  prettier,
];
