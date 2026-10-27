import { expect, story } from "../../storybook/playwright/story"

for (const theme of ["original", "norse-dark", "norse-light"]) {
  story(`keeps the open Used header readable below the session title while scrolling (${theme})`, async ({ mount, page }) => {
    await page.addInitScript((theme) => {
      localStorage.setItem("opencode-theme-id", theme === "original" ? "oc-2" : "norse")
    }, theme)
    const root = await mount("current-tool-group--sticky-header", {
      args: { height: "720" },
      globals: { theme: theme === "norse-light" ? "light" : "dark" },
    })
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme === "original" ? "oc-2" : "norse")
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    const scroller = root.locator('[data-story="sticky-header-scroll"]')
    const header = root.getByRole("button", { name: "Used 37 Write, Shell, Grep, Edit", exact: true })

    const top = (locator: typeof header) =>
      locator.evaluate((node) => {
        const scroller = node.closest('[data-story="sticky-header-scroll"]')!

        return node.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      })

    await page.keyboard.press("Tab")
    await header.focus()
    await expect(header).toBeFocused()
    expect(await scroller.evaluate((node) => node.scrollHeight > node.clientHeight * 2)).toBe(true)
    await scroller.evaluate((node) => (node.scrollTop = 900))
    await expect.poll(() => top(header)).toBe(48)
    // Norse diffuses moving rows through glass; the original design uses an opaque surface.
    if (theme === "original") await expect(header).toHaveCSS("background-color", /^rgb\(/)
    if (theme !== "original") {
      await expect(header).toHaveCSS("backdrop-filter", "blur(24px) saturate(1.2)")
      await expect(header).toHaveCSS("background-color", /\/ 0\.6\)|, 0\.6\)/)
      await expect
        .poll(() =>
          header.evaluate((node) => {
            const bounds = node.getBoundingClientRect()
            return Math.max(
              ...[
                '[data-component="context-tool-group-trigger"]',
                '[data-slot="tool-status-mark"]',
                '[data-slot="collapsible-arrow"]',
              ].map((selector) => {
                const content = node.querySelector(selector)!.getBoundingClientRect()
                return Math.abs(content.y + content.height / 2 - bounds.y - bounds.height / 2)
              }),
            )
          }),
        )
        .toBeLessThanOrEqual(1)
    }
    await expect(header).toHaveCSS("height", "36px")

    // Nested file headers stack below the stuck Used header instead of covering it.
    const file = root.locator('[data-component="sticky-accordion-header"]').filter({ hasText: "model.ts" })
    // Outside a timeline row the diff sizes itself only after it renders on screen (content-visibility: auto),
    // and a header can stick only while its diff extends below it.
    await file.scrollIntoViewIfNeeded()
    await expect
      .poll(() => file.evaluate((node) => node.parentElement!.getBoundingClientRect().height))
      .toBeGreaterThan(400)
    await file.evaluate((node) => {
      const scroller = node.closest<HTMLElement>('[data-story="sticky-header-scroll"]')!
      scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 60
    })
    await expect.poll(() => top(header)).toBe(48)
    await expect.poll(() => top(file)).toBe(84)
    if (theme === "original") await expect(file).toHaveCSS("background-color", /^rgb\(/)
    if (theme !== "original") {
      await expect(file).toHaveCSS("background-color", theme === "norse-light" ? "rgb(226, 231, 240)" : "rgb(30, 30, 36)")
      await expect(file).toHaveCSS("backdrop-filter", "none")
    }

    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => top(header)).toBe(48)
    await expect(header).toHaveCSS("height", "36px")

    await expect(header).toBeFocused()
    if (theme !== "original") {
      await expect(header).toHaveCSS("outline-width", "2px")
      await expect(header).toHaveCSS("outline-offset", "-2px")
    }
    await header.press("Enter")
    await expect(header).toHaveAttribute("aria-expanded", "false")
    await expect.poll(() => top(header)).toBe(48)
    await expect(root.locator('[data-slot="context-tool-group-item"]')).toHaveCount(0)
  })
}
