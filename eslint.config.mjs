import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";
import unusedImports from "eslint-plugin-unused-imports";
import promise from "eslint-plugin-promise";
import sonarjs from "eslint-plugin-sonarjs";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.next/**"
    ]
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    plugins: {
      import: importPlugin,
      "unused-imports": unusedImports,
      promise,
      sonarjs
    },

    rules: {
        
      // IMPORTS

      "import/no-unresolved": "off",
      "import/order": [
        "warn",
        {
          "groups": ["builtin", "external", "internal"],
          "newlines-between": "always"
        }
      ],

      // UNUSED IMPORTS

      "unused-imports/no-unused-imports": "warn",

      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ],

  
      // PROMISE SAFETY  

      "promise/always-return": "off",
      "promise/no-nesting": "warn",

    
      // CODE QUALITY

      "sonarjs/no-duplicate-string": "warn",
      "sonarjs/no-identical-functions": "warn",

      "complexity": ["warn", 12],

      "max-lines-per-function": [
        "warn",
        {
          max: 90,
          skipBlankLines: true,
          skipComments: true
        }
      ],


      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": "warn",


      "no-console": "off"
    }
  },

  // describe() callbacks are natural test containers that grow large.
  // Length and duplicate-string rules don't apply to test scaffolding.
  {
    files: ["**/__tests__/**/*.ts", "**/*.test.ts"],
    rules: {
      "max-lines-per-function": "off",
      "sonarjs/no-duplicate-string": "off",
    },
  },

  prettier
];