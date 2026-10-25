import { expect, story } from "../../storybook/playwright/story"

for (const width of [360, 1100]) {
  story(`shows persisted reply attribution without hover at ${width}px`, async ({ mount, page }, testInfo) => {
    await page.setViewportSize({ width, height: 700 })
    const timeline = await mount("current-session-timeline-rows--reply-attribution")
    const labels = timeline.locator('[data-slot="reply-attribution"]')
    await expect(labels).toHaveCount(2)
    await expect(labels.nth(0)).toContainText("old-model")
    await expect(labels.nth(0)).toContainText("Thinking: high")
    await expect(labels.nth(1)).toContainText("new-model")
    await expect(labels.nth(1)).toContainText("Thinking: disabled")
    await expect(labels.nth(0)).toBeVisible()
    await expect(labels.nth(1)).toBeVisible()
    expect(await labels.evaluateAll((items) => items.every((item) => item.scrollWidth <= item.clientWidth))).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`reply-${width}.png`), fullPage: true })
  })
}
