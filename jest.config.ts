import type { Config } from "jest"

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/__tests__"],
  testMatch: ["**/*.test.ts", "**/*.test.tsx"],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          // Separate tsconfig for tests — allows test runner globals without
          // polluting the production tsconfig. Inherits all other options.
          types: ["jest", "node"],
          module: "commonjs",
          moduleResolution: "node",
          esModuleInterop: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  // Tests that hit the running dev server (e2e / integration) need a longer
  // timeout — the engine can be slow on first compile.
  testTimeout: 30_000,
}

export default config
