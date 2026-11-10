import { expect, story } from "../../storybook/playwright/story"

story(
  "context limits open with inherited settings, agree with Core, and write an explicit maximum",
  async ({ mount, page }, testInfo) => {
    const panel = await mount("extensions-context-limits--inherited")
    await expect(panel.getByRole("textbox", { name: "Context limit", exact: true })).toHaveValue("372k")
    const identity = panel.locator('[data-slot="session-context-identity"]')
    const usage = panel.locator('[data-slot="session-context-occupancy"]')
    await expect(identity.getByText("Fixture", { exact: true })).toBeVisible()
    await expect(identity.locator('[data-slot="session-context-trigger"]')).toHaveCount(0)
    await expect(usage.getByRole("progressbar", { name: "Context usage" })).toHaveAttribute("aria-valuenow", "81")
    await expect(usage.getByText("300,000", { exact: true })).toHaveCount(2)
    await expect(usage.getByText("372,000", { exact: true })).toBeVisible()
    await expect(panel.getByText("81%", { exact: true })).toBeVisible()
    await expect(panel.getByText("~364k", { exact: true })).toBeVisible()
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    await page.screenshot({ path: testInfo.outputPath("context-limit-wide.png"), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: testInfo.outputPath("context-summary-narrow.png"), fullPage: true })
    await panel.getByRole("button", { name: "Use default", exact: true }).scrollIntoViewIfNeeded()
    await expect(panel.locator('[data-slot="session-context-limit"]')).toBeVisible()
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath("context-limit-narrow.png"), fullPage: true })
    await panel.getByRole("button", { name: "Max", exact: true }).click()
    await expect(panel.getByLabel("Writes")).toContainText('"softLimit":1000000')
    await expect(panel.getByLabel("Writes")).toContainText('"modelKey":"fixture/Alpha","limit":1000000')
    await panel.getByRole("button", { name: "Use default", exact: true }).click()
    await expect(panel.getByLabel("Writes")).toContainText('"modelKey":"fixture/Alpha","limit":null')
  },
)

story("a delayed context-limit save cannot write another session's model default", async ({ mount }) => {
  const panel = await mount("extensions-context-limits--inherited")
  await expect(panel.getByRole("textbox", { name: "Context limit", exact: true })).toHaveValue("372k")
  await panel.getByRole("button", { name: "Hold updates" }).click()
  await panel.getByRole("button", { name: "500k", exact: true }).click()
  await expect(panel.getByLabel("Writes")).toHaveText('/api/session/ses_Alpha {"metadata":{"softLimit":500000}}')
  await panel.getByRole("button", { name: "Switch session" }).click()
  await expect(panel.getByRole("textbox", { name: "Context limit", exact: true })).toHaveValue("250k")
  await panel.getByRole("button", { name: "Release updates" }).click()
  // This subsequent completed save is the barrier: the earlier response has resumed before it.
  await panel.getByRole("button", { name: "64k", exact: true }).click()
  await panel.getByRole("button", { name: "Release updates" }).click()
  await expect(panel.getByLabel("Writes")).toHaveText(
    '/api/session/ses_Alpha {"metadata":{"softLimit":500000}}\n/api/session/ses_Beta {"metadata":{"softLimit":64000}}',
  )
})

story("unmounting the context panel cancels a pending default save", async ({ mount }) => {
  const panel = await mount("extensions-context-limits--inherited")
  await expect(panel.getByRole("textbox", { name: "Context limit", exact: true })).toHaveValue("372k")
  await panel.getByRole("button", { name: "Hold updates" }).click()
  await panel.getByRole("button", { name: "500k", exact: true }).click()
  await expect(panel.getByLabel("Writes")).toHaveText('/api/session/ses_Alpha {"metadata":{"softLimit":500000}}')
  await panel.getByRole("button", { name: "Unmount panel" }).click()
  await panel.getByRole("button", { name: "Release updates" }).click()
  await expect(panel.getByRole("textbox", { name: "Context limit", exact: true })).toHaveCount(0)
  await expect(panel.getByLabel("Writes")).toHaveText('/api/session/ses_Alpha {"metadata":{"softLimit":500000}}')
})

story("a debounced slider edit is discarded when its session changes", async ({ mount, page }) => {
  const panel = await mount("extensions-context-limits--inherited")
  await expect(panel.getByRole("textbox", { name: "Context limit", exact: true })).toHaveValue("372k")
  await page.clock.install()
  await panel.getByRole("slider").evaluate((element: HTMLInputElement) => {
    element.value = "500000"
    element.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await panel.getByRole("button", { name: "Switch session" }).click()
  await page.clock.runFor(300)
  await expect(panel.getByRole("textbox", { name: "Context limit", exact: true })).toHaveValue("250k")
  await expect(panel.getByLabel("Writes")).toBeEmpty()
})
