import { builtinModules } from "node:module";

import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const directivePattern =
  /^\s*(eslint-disable(?:-next-line|-line)?|eslint-enable)(?=\s|$)(.*)$/su;

// Suppressions sit on the security review surface: each one must name the rules
// it silences and give a reason, so a copied suppression carries its rationale.
const describedDirectives = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require ESLint disable directives to name their rules and give a reason",
    },
    schema: [],
    messages: {
      unlimited:
        "{{directive}} must name the rules it disables; blanket suppression is not allowed.",
      undescribed:
        "{{directive}} must give a reason as ` -- <reason>` after the rule list.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const match = directivePattern.exec(comment.value);
          if (match === null || match[1] === "eslint-enable") continue;
          const [, directive, rest] = match;
          const [rules, ...reason] = rest.split(/\s--(?:\s|$)/u);
          const messageId =
            rules.trim() === ""
              ? "unlimited"
              : reason.join(" ").trim() === ""
                ? "undescribed"
                : null;
          if (messageId !== null)
            context.report({
              loc: comment.loc,
              messageId,
              data: { directive },
            });
        }
      },
    };
  },
};

const nodeOnlyMessage = "Browser bundles must not import Node built-ins.";
const browserForbiddenPaths = [
  ...builtinModules
    .filter((name) => !name.startsWith("_"))
    .map((name) => ({ name, message: nodeOnlyMessage })),
  {
    name: "electron",
    message:
      "Only the Electron main process and preload may import electron; renderers use the trusted bridge.",
  },
];
const nodeProtocolPattern = { group: ["node:*"], message: nodeOnlyMessage };
const webAppPattern = {
  regex: "^(?:@desmoslock/web(?:/|$)|(?:\\.\\./)+(?:apps/)?web/)",
  message: "The desktop app must not import web code; share it via packages/.",
};

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "supabase/functions/**"],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      desmoslock: { rules: { "described-directives": describedDirectives } },
    },
    rules: {
      "desmoslock/described-directives": "error",
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          fixStyle: "inline-type-imports",
        },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },
  {
    files: ["packages/*/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: browserForbiddenPaths,
          patterns: [
            nodeProtocolPattern,
            {
              regex:
                "^(?:@desmoslock/(?:web|desktop)(?:/|$)|(?:\\.\\./)+apps/)",
              message: "Shared packages must not depend on an application.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/web/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: browserForbiddenPaths,
          patterns: [
            nodeProtocolPattern,
            {
              regex:
                "^(?:@desmoslock/desktop(?:/|$)|(?:\\.\\./)+(?:apps/)?desktop/)",
              message:
                "The web app must not import desktop code; share it via packages/.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/desktop/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [webAppPattern] }],
    },
  },
  {
    // Sandboxed renderer bundles: esbuild platform "browser" in build-app.mjs.
    files: [
      "apps/desktop/src/renderer.ts",
      "apps/desktop/src/student-session-view.ts",
      "apps/desktop/src/assessment-protection-view-state.ts",
      "apps/desktop/src/calculator/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: browserForbiddenPaths,
          patterns: [
            nodeProtocolPattern,
            webAppPattern,
            {
              regex: "^\\.\\.?/main/(?!assessment-protection-types\\.js$)",
              message:
                "Renderer code must not import Electron main-process modules; only the dependency-free main/assessment-protection-types.js is shared.",
            },
          ],
        },
      ],
    },
  },
);
