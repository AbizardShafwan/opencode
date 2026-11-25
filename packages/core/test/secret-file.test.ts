import { describe, expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KV } from "@opencode/core/kv"
import { SecretFile } from "@opencode/core/secret-file"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/schema/session-event"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Duration, Effect } from "effect"
import { TestClock } from "effect/testing"
import { execFileSync } from "node:child_process"
import fs from "fs/promises"
import path from "path"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([KV.node, Bus.node, SecretFile.node])))

describe("SecretFile", () => {
  it.effect("persists protection in KV, follows symlinks and expires after the TTL", () =>
    Effect.gen(function* () {
      const secretFiles = yield* SecretFile.Service
      const kv = yield* KV.Service
      const tmp = (yield* tmpdirScoped()).path
      const secret = path.join(tmp, "token")
      const link = path.join(tmp, "link")
      yield* Effect.promise(() => fs.writeFile(secret, "value"))
      yield* Effect.promise(() => fs.symlink(secret, link))

      expect(yield* secretFiles.isProtected(link)).toBe(false)
      yield* secretFiles.register(secret, "ses_secret")

      const stored = yield* kv.scan({ prefix: "secret.file/" })
      expect(stored.entries).toHaveLength(1)
      expect(stored.entries[0]?.value).toMatchObject({ sessionID: "ses_secret", realpath: yield* realpath(secret) })
      expect(yield* secretFiles.isProtected(secret)).toBe(true)
      expect(yield* secretFiles.isProtected(link)).toBe(true)
      expect(yield* secretFiles.matchPathsInCommand(`adb pair host "$(cat ${secret})"`)).toHaveLength(1)
      expect(yield* secretFiles.matchPathsInCommand("cat other")).toEqual([])
      expect(yield* secretFiles.readSecretBytes(yield* secretFiles.active())).toEqual(["value"])

      yield* TestClock.adjust(Duration.sum(SecretFile.TTL, Duration.seconds(1)))
      expect(yield* secretFiles.isProtected(secret)).toBe(false)
      expect((yield* kv.scan({ prefix: "secret.file/" })).entries).toEqual([])
    }),
  )

  it.effect("scrubs exact and trimmed secret contents", () =>
    Effect.sync(() => {
      expect(SecretFile.scrub("token=abc123\n and abc123", ["abc123\n"])).toBe("token=[REDACTED] and [REDACTED]")
      expect(SecretFile.scrub("nothing here", [])).toBe("nothing here")
    }),
  )

  it.effect("purges secret-file KV rows when a session is archived or deleted", () =>
    Effect.gen(function* () {
      const secretFiles = yield* SecretFile.Service
      const bus = yield* Bus.Service
      const kv = yield* KV.Service
      const tmp = (yield* tmpdirScoped()).path
      const first = path.join(tmp, "first")
      const second = path.join(tmp, "second")
      yield* Effect.promise(() => fs.writeFile(first, "one"))
      yield* Effect.promise(() => fs.writeFile(second, "two"))

      const s1 = Session.ID.make("ses_secret_one")
      const s2 = Session.ID.make("ses_secret_two")
      yield* secretFiles.register(first, s1)
      yield* secretFiles.register(second, s2)
      expect((yield* kv.scan({ prefix: "secret.file/" })).entries).toHaveLength(2)

      yield* bus.publish(SessionEvent.Archived, { sessionID: s1 })
      yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow)
      expect(yield* secretFiles.isProtected(first)).toBe(false)
      expect(yield* secretFiles.isProtected(second)).toBe(true)

      yield* bus.publish(SessionEvent.Deleted, { sessionID: s2 })
      yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow)
      expect((yield* kv.scan({ prefix: "secret.file/" })).entries).toEqual([])
    }),
  )

  const fifoEffect = process.platform === "win32" ? it.effect.skip : it.effect

  fifoEffect("skips named pipes in readSecretBytes without blocking or draining while keeping read/grep blocked", () =>
    Effect.gen(function* () {
      const secretFiles = yield* SecretFile.Service
      const tmp = (yield* tmpdirScoped()).path
      const fifo = path.join(tmp, "secret.fifo")
      const regular = path.join(tmp, "regular.secret")
      execFileSync("mkfifo", [fifo])
      yield* Effect.promise(() => fs.writeFile(regular, "regular-secret-value"))

      yield* secretFiles.register(fifo, "ses_fifo")
      yield* secretFiles.register(regular, "ses_fifo")

      expect(yield* secretFiles.isProtected(fifo)).toBe(true)
      const failure = yield* Effect.flip(secretFiles.assertReadable(fifo))
      expect(failure.message).toBe(SecretFile.PROTECTED_MESSAGE)

      // No writer is attached to `fifo`; readSecretBytes must stat and skip it without opening/blocking.
      expect(yield* secretFiles.readSecretBytes(yield* secretFiles.active())).toEqual(["regular-secret-value"])
    }),
  )

  it.effect("normalizes win32 drive casing, slashes, UNC paths, and MSYS prefixes in keys and commands", () =>
    Effect.sync(() => {
      expect(SecretFile.normalizeKeyPath("c:\\Users\\Alice\\secret.txt", "win32")).toBe(
        SecretFile.normalizeKeyPath("C:/users/alice/secret.txt\\", "win32"),
      )
      expect(SecretFile.normalizeKeyPath("/Tmp/Secret", "linux")).not.toBe(
        SecretFile.normalizeKeyPath("/tmp/secret", "linux"),
      )

      const winEntry = {
        path: "C:\\Users\\Alice\\my secret\\token.txt",
        realpath: "C:\\Users\\Alice\\my secret\\token.txt",
      }
      expect(SecretFile.matchesCommandPath('cat "C:\\Users\\Alice\\my secret\\token.txt"', winEntry, "win32")).toBe(true)
      expect(SecretFile.matchesCommandPath('cat "c:/users/ALICE/my secret/token.txt"', winEntry, "win32")).toBe(true)
      expect(SecretFile.matchesCommandPath('cat "/c/Users/Alice/my secret/token.txt"', winEntry, "win32")).toBe(true)
      expect(SecretFile.matchesCommandPath("cat /c/Users/Alice/my\\ secret/token.txt", winEntry, "win32")).toBe(true)
      expect(SecretFile.matchesCommandPath("cat /cygdrive/c/Users/Alice/my\\ secret/token.txt", winEntry, "win32")).toBe(
        true,
      )
      expect(SecretFile.matchesCommandPath("cat /mnt/c/Users/Alice/my\\ secret/token.txt", winEntry, "win32")).toBe(true)
      expect(SecretFile.matchesCommandPath("cat other.txt", winEntry, "win32")).toBe(false)

      const uncEntry = { path: "\\\\Server\\Secrets\\tok.txt", realpath: "\\\\Server\\Secrets\\tok.txt" }
      expect(SecretFile.matchesCommandPath("type \\\\server\\secrets\\tok.txt", uncEntry, "win32")).toBe(true)
      expect(SecretFile.matchesCommandPath("cat //server/SECRETS/tok.txt", uncEntry, "win32")).toBe(true)
    }),
  )
})

const realpath = (file: string) => Effect.promise(() => fs.realpath(file))
