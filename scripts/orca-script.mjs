// A script in an Orca checkout (ORCA_DIR), shared by the catalog scripts and tools.
import { existsSync } from 'node:fs'
import path from 'node:path'

export function orcaScript(orcaDir, area, name) {
  // Why both places: Orca later moved its scripts into per-area folders.
  const files = [
    path.join(orcaDir, 'config', 'scripts', 'plugin-authoring', area, name),
    path.join(orcaDir, 'config', 'scripts', name)
  ]
  const file = files.find((candidate) => existsSync(candidate))
  if (!file) {
    throw new Error(`${orcaDir} is not an Orca checkout (missing ${files.join(' and ')})`)
  }
  return file
}
