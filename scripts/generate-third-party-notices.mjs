import { readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const licenseNames = [
  'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'LICENCE.txt',
  'COPYING', 'COPYING.md', 'COPYING.txt'
]

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function workspacePackages(root) {
  const packagesRoot = path.join(root, 'packages')
  const result = new Map()
  for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = path.join(packagesRoot, entry.name, 'package.json')
    if (!existsSync(manifest)) continue
    const data = await readJson(manifest)
    result.set(data.name, { manifest, data })
  }
  return result
}

function externalManifest(requesterDirectory, dependency) {
  let current = requesterDirectory
  while (true) {
    const candidate = path.join(current, 'node_modules', dependency, 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

async function licenseText(packageDirectory) {
  const entries = await readdir(packageDirectory)
  const byUppercase = new Map(entries.map((entry) => [entry.toUpperCase(), entry]))
  for (const expected of licenseNames) {
    const actual = byUppercase.get(expected.toUpperCase())
    if (actual) return readFile(path.join(packageDirectory, actual), 'utf8')
  }
  const readme = entries.find((entry) => /^readme(?:\.[^.]+)?$/i.test(entry))
  if (readme) {
    const content = await readFile(path.join(packageDirectory, readme), 'utf8')
    const heading = content.search(/^#{1,6}\s+licen[cs]e\s*$/im)
    if (heading >= 0) {
      const section = content.slice(heading).replace(/^#{1,6}\s+licen[cs]e\s*\r?\n/im, '').trim()
      if (section) return section
    }
  }
  return undefined
}

function dependencyNames(manifest) {
  return [...new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {})
  ])].sort()
}

export async function generateWorkbenchNotices(root = repositoryRoot) {
  const workspaces = await workspacePackages(root)
  const entry = workspaces.get('forge-workbench')
  if (!entry) throw new Error('forge-workbench workspace was not found')

  const visitedManifests = new Set()
  const thirdParty = new Map()

  async function visit(manifestPath, manifest, isWorkspace) {
    const canonical = path.resolve(manifestPath).toLowerCase()
    if (visitedManifests.has(canonical)) return
    visitedManifests.add(canonical)

    if (!isWorkspace) {
      const packageDirectory = path.dirname(manifestPath)
      const text = await licenseText(packageDirectory)
      if (!manifest.name || !manifest.version || !manifest.license || !text?.trim()) {
        throw new Error(`Incomplete license metadata for ${manifest.name ?? manifestPath}`)
      }
      thirdParty.set(`${manifest.name}@${manifest.version}`, {
        name: manifest.name,
        version: manifest.version,
        license: typeof manifest.license === 'string' ? manifest.license : JSON.stringify(manifest.license),
        text: text.trim()
      })
    }

    const requesterDirectory = path.dirname(manifestPath)
    for (const dependency of dependencyNames(manifest)) {
      const workspace = workspaces.get(dependency)
      if (workspace) {
        await visit(workspace.manifest, workspace.data, true)
        continue
      }

      const dependencyManifest = externalManifest(requesterDirectory, dependency)
      if (!dependencyManifest) {
        if (manifest.optionalDependencies?.[dependency] || manifest.peerDependenciesMeta?.[dependency]?.optional) continue
        throw new Error(`Installed production dependency not found: ${manifest.name} -> ${dependency}`)
      }
      await visit(dependencyManifest, await readJson(dependencyManifest), false)
    }
  }

  await visit(entry.manifest, entry.data, true)
  const packages = [...thirdParty.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  )
  if (packages.length === 0) throw new Error('No third-party production dependencies were found')

  const sections = packages.map((pkg) => [
    '='.repeat(80),
    `${pkg.name} ${pkg.version}`,
    `License: ${pkg.license}`,
    '-'.repeat(80),
    pkg.text
  ].join('\n'))

  return [
    'FORGE Workbench — Third-Party Notices',
    '',
    'This file contains license notices for third-party software bundled in the',
    'FORGE Workbench executable. FORGE itself is licensed under Apache-2.0; see',
    'LICENSE in the distribution root.',
    '',
    `Bundled packages: ${packages.length}`,
    '',
    ...sections,
    ''
  ].join('\n')
}

async function main() {
  const outputIndex = process.argv.indexOf('--output')
  if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
    throw new Error('Usage: node scripts/generate-third-party-notices.mjs --output <file>')
  }
  const output = path.resolve(process.argv[outputIndex + 1])
  await writeFile(output, await generateWorkbenchNotices(), 'utf8')
  process.stdout.write(`${output}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
