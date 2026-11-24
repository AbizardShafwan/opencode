import { expect, test } from "bun:test"
import { ConfigProvider, Effect, Redacted } from "effect"
import { Env } from "../src/env"

test("password falls back to OPENCODE_SERVER_PASSWORD when branded password is unset", () => {
  const provider = ConfigProvider.fromEnv({
    env: { OPENCODE_SERVER_PASSWORD: "host-password" },
  })
  const value = Effect.runSync(
    Effect.gen(function* () {
      return yield* Env.password
    }).pipe(Effect.provide(ConfigProvider.layer(provider))),
  )
  expect(value && Redacted.value(value)).toBe("host-password")
})

test("session environment omits server credentials", () => {
  const previousPassword = process.env.OPENCODE_PASSWORD
  const previousLegacyPassword = process.env.OPENCODE_SERVER_PASSWORD
  const previousValue = process.env.OPENCODE_SESSION_ENV_TEST
  process.env.OPENCODE_PASSWORD = "password"
  process.env.OPENCODE_SERVER_PASSWORD = "legacy"
  process.env.OPENCODE_SESSION_ENV_TEST = "included"

  const environment = Env.session()

  if (previousPassword === undefined) delete process.env.OPENCODE_PASSWORD
  else process.env.OPENCODE_PASSWORD = previousPassword
  if (previousLegacyPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = previousLegacyPassword
  if (previousValue === undefined) delete process.env.OPENCODE_SESSION_ENV_TEST
  else process.env.OPENCODE_SESSION_ENV_TEST = previousValue

  expect(environment.OPENCODE_PASSWORD).toBeUndefined()
  expect(environment.OPENCODE_SERVER_PASSWORD).toBeUndefined()
  expect(environment.OPENCODE_SESSION_ENV_TEST).toBe("included")
})
