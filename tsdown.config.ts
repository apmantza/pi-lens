import { type UserConfig, defineConfig } from "tsdown"

export default defineConfig({
  tsconfig: "./tsconfig.build.json",
  entry: ["./index.ts"],
  copy: [
    { from: "./skills", to: "./dist/skills" }
  ],
}) satisfies UserConfig as UserConfig

