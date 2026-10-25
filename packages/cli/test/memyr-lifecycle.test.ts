import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readlink, rm, chmod } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { lifecycle } from "../../../scripts/memyr/lifecycle"

// The lifecycle installer targets POSIX symlink/rename semantics (Windows uses WSL).
test.skipIf(process.platform === "win32")(
  "isolated install/update/uninstall preserves upstream and the previous working release on failure",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "memyr-lifecycle-test-"))
    try {
      const input = {
        root,
        prefix: path.join(root, "install"),
        bin: path.join(root, "bin"),
        artifact: path.join(root, "artifact"),
      }
      await mkdir(input.bin)
      await Bun.write(path.join(input.bin, "opencode"), "upstream sentinel")
      await Bun.write(input.artifact, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo memyr v0.0.0-memyr-1; fi\n')
      await chmod(input.artifact, 0o755)
      await lifecycle({ ...input, action: "install" })
      const first = await readlink(path.join(input.prefix, "current"))
      expect(await Bun.file(path.join(input.bin, "memyr")).text()).toContain("memyr-1")
      await Bun.write(input.artifact, "#!/bin/sh\necho upstream-version\n")
      await expect(lifecycle({ ...input, action: "update" })).rejects.toThrow("Not a Memyr build")
      expect(await readlink(path.join(input.prefix, "current"))).toBe(first)
      await Bun.write(input.artifact, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo memyr v0.0.0-memyr-2; fi\n')
      await lifecycle({ ...input, action: "update" })
      expect(await readlink(path.join(input.prefix, "current"))).not.toBe(first)
      expect(await Bun.file(path.join(first, "memyr")).text()).toContain("memyr-1")
      await lifecycle({ ...input, action: "uninstall" })
      expect(await Bun.file(path.join(input.bin, "memyr")).exists()).toBe(false)
      expect(await Bun.file(path.join(input.bin, "opencode")).text()).toBe("upstream sentinel")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

// The lifecycle installer targets POSIX symlink/rename semantics (Windows uses WSL).
test.skipIf(process.platform === "win32")(
  "refuses unrelated commands and nonempty installation directories",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "memyr-lifecycle-test-"))
    try {
      const input = {
        root,
        action: "install" as const,
        prefix: path.join(root, "install"),
        bin: path.join(root, "bin"),
      }
      await mkdir(input.bin)
      await Bun.write(path.join(input.bin, "memyr"), "unrelated")
      await expect(lifecycle(input)).rejects.toThrow("not owned")
      await rm(path.join(input.bin, "memyr"))
      await mkdir(input.prefix)
      await Bun.write(path.join(input.prefix, "keep"), "unrelated")
      await expect(lifecycle(input)).rejects.toThrow("nonempty")
      expect(await Bun.file(path.join(input.prefix, "keep")).text()).toBe("unrelated")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
