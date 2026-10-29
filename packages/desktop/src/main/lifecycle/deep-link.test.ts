import { expect, test } from "bun:test"
import { consoleReturnWindow } from "./deep-link"

test("finds the Console return window", () => {
  // `memyr://` is the registered scheme; an upstream `opencode://` link still answers when this
  // process is handed it directly.
  expect(consoleReturnWindow("memyr://console/authorized?window=window-a")).toBe("window-a")
  expect(consoleReturnWindow("opencode://console/authorized?window=window-a")).toBe("window-a")
  expect(consoleReturnWindow("memyr://console/authorized?window=window%20b")).toBe("window b")
  expect(consoleReturnWindow("memyr://console/other?window=window-a")).toBeUndefined()
  expect(consoleReturnWindow("memyr://other/authorized?window=window-a")).toBeUndefined()
  expect(consoleReturnWindow("https://console/authorized?window=window-a")).toBeUndefined()
  expect(consoleReturnWindow("not a url")).toBeUndefined()
  expect(consoleReturnWindow("memyr://console/authorized")).toBeUndefined()
})
