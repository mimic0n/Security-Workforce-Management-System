import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/*.js"]
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module"
      }
    },
    plugins: {
      "@typescript-eslint": tsPlugin
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          "message": "Direct calls to Date.now() are forbidden by SWMS Rule #1. Use injected Clock."
        },
        {
          "selector": "NewExpression[callee.name='Date'][arguments.length=0]",
          "message": "Direct calls to new Date() without arguments are forbidden by SWMS Rule #1. Use injected Clock.now()."
        },
        {
          "selector": "CallExpression[callee.name='setTimeout']",
          "message": "Direct calls to setTimeout are forbidden by SWMS Rule #1. Use injected Clock.schedule or pg-boss."
        },
        {
          "selector": "CallExpression[callee.name='setInterval']",
          "message": "Direct calls to setInterval are forbidden by SWMS Rule #1. Use injected Clock.schedule or pg-boss."
        }
      ]
    }
  },
  {
    files: ["**/core/clock/**", "**/*.spec.ts", "**/test/**", "**/db/**"],
    rules: {
      "no-restricted-syntax": "off"
    }
  }
];
