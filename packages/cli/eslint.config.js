import baseConfig from "../../tooling/eslint/index.js";

export default [
  ...baseConfig,
  {
    files: ["src/**/*.ts"],
    rules: {
      // CLI prints to stdout/stderr — `console.log` is the legitimate output
      // channel here. The base config warns on `console.log`; turn it off
      // for this package only.
      "no-console": "off",
    },
  },
];
