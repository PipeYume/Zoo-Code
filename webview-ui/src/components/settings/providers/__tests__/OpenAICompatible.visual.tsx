import React from "react"

import { expect, test } from "../../../../../playwright/coverage-fixture"
import { applyVisualTheme, visualThemes } from "../../../../../playwright/themes"
import { OpenAICompatibleAzureFixture, OpenAICompatibleExtraBodyFixture } from "./OpenAICompatible.visual.fixture"

test("renders Azure OpenAI endpoint and deployment guidance in the VS Code dark theme", async ({ mount, page }) => {
	// The full provider bundle leaves bare Zod references after CT tree-shaking.
	await page.evaluate(() => Object.assign(globalThis, { z: undefined, z$1: undefined }))
	const component = await mount(<OpenAICompatibleAzureFixture />)

	await component.evaluate((element) => {
		const { document } = element.ownerDocument.defaultView!
		document.documentElement.className = "vscode-dark"
		document.body.className = "vscode-dark"
		document.body.dataset.vscodeThemeId = "Default Dark Modern"
	})

	await expect
		.poll(() =>
			component.evaluate((element) => {
				return getComputedStyle(element.ownerDocument.body)
					.getPropertyValue("--vscode-editor-background")
					.trim()
			}),
		)
		.toBe("#1f1f1f")

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("openai-compatible-azure-guidance-dark.png")
})

for (const theme of visualThemes) {
	test(`renders a populated Extra Body editor in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		await applyVisualTheme(page, theme)
		await page.evaluate(() => Object.assign(globalThis, { z: undefined, z$1: undefined }))
		const component = await mount(<OpenAICompatibleExtraBodyFixture />)

		await expect.poll(() => component.getByTestId("openai-extra-body-input").isVisible()).toBe(true)

		await component.evaluate(async () => {
			await document.fonts.ready
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
		})

		await expect(component).toHaveScreenshot(`openai-compatible-extra-body-${theme.name}.png`)
	})
}
