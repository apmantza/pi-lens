import { UserConfig } from "vite"
import { defineConfig } from "vitest/config"

export default defineConfig({
    test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
    ],
    },
}) satisfies UserConfig as UserConfig
