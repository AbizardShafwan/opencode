import { expect, story } from "../../storybook/playwright/story"

story("Norse file rows stay transparent when collapsed and readable when expanded", async ({ mount, page }) => {
  await page.addInitScript(() => localStorage.setItem("opencode-theme-id", "norse"))
  const root = await mount("current-tool-group--patch-follow-ups", { globals: { theme: "dark" } })
  await expect(page.locator("html")).toHaveAttribute("data-theme", "norse")
  const file = root.locator('[data-slot="accordion-item"]').filter({ hasText: "a.ts" })
  const header = file.locator('[data-component="sticky-accordion-header"]')
  const trigger = file.getByRole("button")
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await expect(header).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expect(trigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const shell = root.locator('[data-timeline-part-id="patch_shell"]')
  const fileName = file.locator('[data-slot="apply-patch-file-name-container"]')
  const shellName = shell.locator('[data-slot="norse-shell-command"]')
  await expect
    .poll(async () => (await fileName.boundingBox())!.x - (await shellName.boundingBox())!.x)
    .toBe(0)
  await trigger.focus()
  await expect(trigger).toHaveCSS("outline-width", "2px")
  await trigger.press("Enter")
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await expect(file.getByRole("region")).toBeVisible()
  await expect(header).toHaveCSS("backdrop-filter", "none")
  await expect(header).toHaveCSS("background-image", "none")
  await expect(header).toHaveCSS("background-color", "rgb(30, 30, 36)")
  await expect(file.locator('[data-component="file"] pre')).toHaveCSS("background-color", "rgb(30, 30, 36)")
  await expect(header).toHaveCSS("height", "32px")
  await page.setViewportSize({ width: 390, height: 844 })
  await expect
    .poll(async () => (await fileName.boundingBox())!.x - (await shellName.boundingBox())!.x)
    .toBe(0)
  await trigger.press("Enter")
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await expect(header).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
})

story("keeps grouped file choices when the Used group reopens", async ({ mount }) => {
  const root = await mount("current-session-research-agents--agent-research", { args: { scenario: "workflow" } })
  const group = root.locator('[data-component="collapsed-tool-group"]').filter({ hasText: "Patch" })
  const disclosure = group.getByRole("button", { name: /^Used \d+ .*Edit.*Write.*Patch$/ })
  await disclosure.click()

  const files = group.locator(
    '[data-timeline-part-ids="tool_family_edit,tool_family_write,tool_family_write_extra,tool_family_patch"] [data-slot="accordion-item"]',
  )

  await expect(files).toHaveCount(3)

  for (const file of await files.all()) {
    const trigger = file.locator('[data-slot="accordion-trigger"]')
    await expect(trigger).toHaveAttribute("aria-expanded", "false")
    await expect(file.locator('[data-component="file"]')).toHaveCount(0)
    await trigger.click()
    await expect(file.getByRole("region")).toBeVisible()
  }

  await disclosure.click()
  await disclosure.click()
  await expect(files).toHaveCount(3)

  for (const file of await files.all()) {
    await expect(file.locator('[data-slot="accordion-trigger"]')).toHaveAttribute("aria-expanded", "true")
    await expect(file.getByRole("region")).toBeVisible()
  }
})

for (const tool of ["edit", "write"]) {
  story(`${tool} preserves input fallback and disclosure through completion`, async ({ mount }) => {
    const root = await mount("current-session-file-changes--file-tool-fallbacks", { args: { tool } })
    const file = root.getByRole("button", { name: /example\.ts/ })
    await expect(file).toHaveAttribute("aria-expanded", "false")
    await file.click()
    await expect(root.locator('[data-component="file"]')).toContainText(tool === "edit" ? "after" : "written")
    await root.getByRole("button", { name: "Complete file tool" }).click()
    await expect(root.getByText("Example diagnostic")).toBeVisible()
    await expect(file).toHaveAttribute("aria-expanded", "true")
    await file.click()
    await expect(file).toHaveAttribute("aria-expanded", "false")
    await expect(root.getByText("Example diagnostic")).toBeVisible()
  })
}

// Product regression from 010cd6131e: an empty write renders no file row. Remove `fail` once it is fixed.
story.fail("empty writes still show a file row", async ({ mount }) => {
  const root = await mount("current-session-file-changes--file-tool-fallbacks", {
    args: { tool: "write", empty: true },
  })

  await root.getByRole("button", { name: "Complete file tool" }).click()
  const file = root.getByRole("button", { name: /example\.ts/ })
  await expect(file).toHaveAttribute("aria-expanded", "false")
  await file.click()
  await expect(file).toHaveAttribute("aria-expanded", "true")
  await expect(root.locator('[data-component="file"]')).toBeAttached()
  await expect(file).toBeVisible()
})
