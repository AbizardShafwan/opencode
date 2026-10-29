import { expect, test } from "bun:test"
import path from "node:path"

test.each([
  { channel: "memyr", version: undefined, expected: "1.0.0" },
  { channel: "memyr", version: "1.0.1", expected: "1.0.1" },
  { channel: "preview-test", version: undefined, expected: "0.0.0-preview-test-123" },
])("resolves build version for $channel with override $version", async (input) => {
  const child = Bun.spawn(
    [process.execPath, "--eval", 'import { Script } from "./src/index.ts"; console.log(Script.version)'],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        OPENCODE_CHANNEL: input.channel,
        OPENCODE_VERSION: input.version,
        OPENCODE_BUMP: undefined,
        GITHUB_RUN_NUMBER: "123",
        GITHUB_RUN_ATTEMPT: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, error).toBe(0)
  expect(output.trim().split("\n").at(-1)).toBe(input.expected)
})
