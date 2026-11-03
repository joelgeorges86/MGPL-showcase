import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      ".tmp_pi003/**",
    ],
  },
  {
    files: ["public/**/*.js", "scripts/**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ...js.configs.recommended.languageOptions,
      ecmaVersion: 2022,
      sourceType: "script",
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-console": "off",
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  ...tseslint.config(
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      files: ["src/**/*.ts", "test/**/*.ts"],
      rules: {
        "no-console": "off",
        "prefer-const": "off",
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-require-imports": "off",
        "@typescript-eslint/no-unused-vars": "off",
      },
    },
    eslintConfigPrettier,
  ),
  {
    files: ["public/**/*.js", "scripts/**/*.js"],
    languageOptions: {
      parserOptions: {
        project: false,
        program: null,
      },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // The browser scripts in public/ load as classic <script> tags in
  // public/index.html, so they run with the browser's globals and share
  // functions through window. Each name is listed explicitly: a new browser API
  // or shared function is declared here on purpose, not picked up silently.
  {
    files: ["public/**/*.js"],
    ignores: ["public/sw.js"],
    languageOptions: {
      globals: {
        // Browser APIs the scripts use.
        AbortController: "readonly",
        alert: "readonly",
        Blob: "readonly",
        cancelAnimationFrame: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        confirm: "readonly",
        console: "readonly",
        CustomEvent: "readonly",
        document: "readonly",
        fetch: "readonly",
        FileReader: "readonly",
        getComputedStyle: "readonly",
        indexedDB: "readonly",
        localStorage: "readonly",
        navigator: "readonly",
        Notification: "readonly",
        prompt: "readonly",
        requestAnimationFrame: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        window: "readonly",
        // Functions one script defines and others call, through window.
        apiFetch: "readonly",
        closeFleetModal: "readonly",
        loadPlayabilityMatrix: "readonly",
        openFleetModal: "readonly",
        renderAnalyticsVisualizer: "readonly",
        showToast: "readonly",
      },
    },
  },
  // The service worker runs in a ServiceWorkerGlobalScope, not a window.
  {
    files: ["public/sw.js"],
    languageOptions: {
      globals: {
        caches: "readonly",
        fetch: "readonly",
        self: "readonly",
        URL: "readonly",
      },
    },
  },
  // typescript-eslint's recommended config replaces no-unused-vars with its own
  // rule, so the options on the base rule above never applied to public/. Apply
  // them here. Caught errors are ignored: the scripts often catch and discard.
  {
    files: ["public/**/*.js"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      // An HTML-escaping replace() that maps a character to itself is a no-op.
      // Seventeen such escapes once reached public/ (AI-077); this keeps them out.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='replace'][arguments.0.regex.pattern='&'][arguments.1.value='&']",
          message:
            "This replace() swaps a character for itself, so it escapes nothing. Use the HTML entity (AI-077).",
        },
        {
          selector:
            "CallExpression[callee.property.name='replace'][arguments.0.regex.pattern='<'][arguments.1.value='<']",
          message:
            "This replace() swaps a character for itself, so it escapes nothing. Use the HTML entity (AI-077).",
        },
        {
          selector:
            "CallExpression[callee.property.name='replace'][arguments.0.regex.pattern='>'][arguments.1.value='>']",
          message:
            "This replace() swaps a character for itself, so it escapes nothing. Use the HTML entity (AI-077).",
        },
        {
          selector:
            "CallExpression[callee.property.name='replace'][arguments.0.regex.pattern='\"'][arguments.1.value='\"']",
          message:
            "This replace() swaps a character for itself, so it escapes nothing. Use the HTML entity (AI-077).",
        },
        {
          selector:
            "CallExpression[callee.property.name='replace'][arguments.0.regex.pattern=\"'\"][arguments.1.value=\"'\"]",
          message:
            "This replace() swaps a character for itself, so it escapes nothing. Use the HTML entity (AI-077).",
        },
      ],
    },
  },
  {
    files: ["scripts/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        __dirname: "readonly",
        console: "readonly",
        process: "readonly",
        require: "readonly",
      },
    },
  },
];
