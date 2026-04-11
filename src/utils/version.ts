interface VersionInfo {
  version: string
  name?: string
  date?: string
  url?: string
}

/**
 * Fetches version.json from the app root.
 * Returns the version string, or "dev" if the file is absent (local dev).
 */
export async function loadVersion(): Promise<string> {
  try {
    const res = await fetch('./version.json', { cache: 'no-store' })
    if (!res.ok) return 'dev'
    const data: VersionInfo = await res.json()
    return data.version ?? 'dev'
  } catch {
    return 'dev'
  }
}

/**
 * Fetches version.json and updates document.title to include the version.
 * Call once at app startup.
 */
export async function applyVersionToTitle(appName = 'PureCut CNC'): Promise<void> {
  const version = await loadVersion()
  document.title = `${appName} ${version}`
}
