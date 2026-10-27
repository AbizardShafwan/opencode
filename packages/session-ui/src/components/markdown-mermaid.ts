let loaded: ReturnType<typeof loadMermaid> | undefined

let sequence = 0

let pending = Promise.resolve()

export function renderMermaidSvg(
  source: string,
  theme = document.documentElement.dataset.colorScheme === "light" ? "default" : "dark",
  signal?: AbortSignal,
) {
  // Mermaid's configuration is global. Keep initialization and rendering together so
  // concurrent diagrams cannot pick up another request's theme.
  const result = pending.then(async () => {
    if (signal?.aborted) return
    const mermaid = await (loaded ??= loadMermaid())

    if (signal?.aborted) return
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme === "default" ? "default" : "dark",
      flowchart: { htmlLabels: false },
    })

    if (!(await mermaid.parse(source, { suppressErrors: true }))) return

    return (await mermaid.render(`markdown-mermaid-${sequence++}`, source)).svg
  })

  pending = result.then(
    () => {},
    () => {},
  )

  return result
}

async function loadMermaid() {
  const { default: mermaid } = await import("mermaid")

  return mermaid
}
