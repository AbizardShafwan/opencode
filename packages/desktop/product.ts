// The desktop product identity. Packaging, scripts and the main process read every app id, name,
// protocol and CLI resource name from here so the three surfaces cannot drift apart.
//
// Source package names and OPENCODE_* build variables stay upstream: they are compatibility
// contracts, not product identity.
export const product = {
  name: "Memyr",
  appId: "ai.memyr.desktop",
  protocol: "memyr",
  // Base name for Linux packages, the executable and the CLI.
  packageName: "memyr",
  // This fork has no update service, so packaged builds never run the updater.
  updates: false,
  cli: {
    appId: "memyr",
    resource: "memyr-cli",
    executable: "memyr",
    versionFile: "memyr-cli.version",
    // A Linux CLI shipped next to the Windows app so WSL installs Memyr, not upstream OpenCode.
    wslResource: "memyr-cli-linux",
  },
} as const

export type DesktopChannel = "dev" | "beta" | "prod"

export function channelIdentity(channel: DesktopChannel) {
  if (channel === "dev")
    return {
      appId: `${product.appId}.dev`,
      name: `${product.name} Dev`,
      packageName: `${product.packageName}-dev`,
    }

  if (channel === "beta")
    return {
      appId: `${product.appId}.beta`,
      name: `${product.name} Beta`,
      packageName: `${product.packageName}-beta`,
    }

  return { appId: product.appId, name: product.name, packageName: product.packageName }
}
