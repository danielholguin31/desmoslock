#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const usage = 'usage: build-pages-manifest.mjs <40-char-source-sha> <web-dir> <upload-dir> <bundle.zip> <receipt.json>'
const [sourceCommit, webArgument, uploadArgument, bundleArgument, receiptArgument] = process.argv.slice(2)

if (!/^[0-9a-f]{40}$/.test(sourceCommit || '') || !webArgument || !uploadArgument || !bundleArgument || !receiptArgument) {
  console.error(usage)
  process.exit(2)
}

const allowedFiles = [
  '404.html',
  '_headers',
  '_redirects',
  'admin/admin.css',
  'admin/admin.js',
  'admin/index.html',
  'admin/vendor/supabase.js',
  'config.js',
  'index.html',
  'pricing.js',
  'robots.txt',
  'site.css',
  'site.js'
]

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8']
])

const secretPatterns = [
  ['private key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ['Supabase secret key', /sb_secret_[A-Za-z0-9_-]{16,}/],
  ['GitHub token', /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['AWS access key', /AKIA[A-Z0-9]{16}/],
  ['Stripe secret key', /sk_(?:live|test)_[A-Za-z0-9]{16,}/],
  ['JWT-like bearer value', /eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/]
]

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0
const sha256 = body => createHash('sha256').update(body).digest('hex')
const webRoot = await realpath(webArgument)
const uploadPath = path.resolve(uploadArgument)
const bundlePath = path.resolve(bundleArgument)
const receiptPath = path.resolve(receiptArgument)
const expectedBaseName = `desmoslock-pages-${sourceCommit}`

if (path.basename(uploadPath) !== expectedBaseName) throw new Error(`upload directory must be named ${expectedBaseName}`)
if (path.basename(bundlePath) !== `${expectedBaseName}.zip`) throw new Error(`bundle must be named ${expectedBaseName}.zip`)
if (path.basename(receiptPath) !== `${expectedBaseName}.json`) throw new Error(`receipt must be named ${expectedBaseName}.json`)
if (!(await lstat(webRoot)).isDirectory()) throw new Error(`web root is not a directory: ${webRoot}`)
if (new Set([uploadPath, bundlePath, receiptPath]).size !== 3) throw new Error('all outputs must use different paths')
for (const [label, outputPath] of [['bundle', bundlePath], ['receipt', receiptPath]]) {
  const relative = path.relative(uploadPath, outputPath)
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..')) {
    throw new Error(`${label} output must not be inside the upload directory`)
  }
}

const gitEnvironment = { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
const gitBuffer = (...args) => execFileSync('git', args, {
  env: gitEnvironment,
  maxBuffer: 32 * 1024 * 1024
})
const gitText = (...args) => gitBuffer(...args).toString('utf8').trim()
const repoRoot = gitText('-C', webRoot, 'rev-parse', '--show-toplevel')
const deployRoot = path.relative(repoRoot, webRoot).split(path.sep).join('/')
if (deployRoot !== 'web') throw new Error(`expected deploy root web, found ${deployRoot}`)
const generatorRelativePath = 'scripts/build-pages-manifest.mjs'
const generatorPath = await realpath(fileURLToPath(import.meta.url))
const expectedGeneratorPath = await realpath(path.join(repoRoot, generatorRelativePath))
if (generatorPath !== expectedGeneratorPath) {
  throw new Error(`generator must run from the source repository: ${expectedGeneratorPath}`)
}

for (const [label, outputPath] of [['upload directory', uploadPath], ['bundle', bundlePath], ['receipt', receiptPath]]) {
  const relative = path.relative(repoRoot, outputPath)
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..')) {
    throw new Error(`${label} output must be outside the source repository`)
  }
  try {
    await lstat(outputPath)
    throw new Error(`${label} output already exists: ${outputPath}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

const canonicalCommit = gitText('-C', repoRoot, 'rev-parse', `${sourceCommit}^{commit}`)
if (canonicalCommit !== sourceCommit) throw new Error('source commit is not a canonical full commit SHA')
if (gitText('-C', repoRoot, 'rev-parse', 'HEAD') !== sourceCommit) {
  throw new Error('source commit must equal the checked-out HEAD')
}
if (gitBuffer('-C', repoRoot, 'status', '--porcelain=v1', '--untracked-files=all').byteLength !== 0) {
  throw new Error('source checkout has tracked, staged, or untracked differences from HEAD')
}
if (gitBuffer(
  '-C', repoRoot, 'ls-files', '--others', '--ignored', '--exclude-standard', '--', deployRoot
).byteLength !== 0) {
  throw new Error('web deploy root contains ignored files that are absent from the commit tree')
}

const generatorObject = gitText(
  '-C', repoRoot, 'rev-parse', `${sourceCommit}:${generatorRelativePath}`
)
const generatorCommittedBody = gitBuffer('-C', repoRoot, 'cat-file', 'blob', generatorObject)
const generatorRunningBody = await readFile(generatorPath)
if (!generatorCommittedBody.equals(generatorRunningBody)) {
  throw new Error('running generator differs from the source commit')
}

const treeObject = gitText('-C', repoRoot, 'rev-parse', `${sourceCommit}:${deployRoot}`)
const treeRows = gitBuffer(
  '-C', repoRoot, 'ls-tree', '-r', '-z', '--full-tree', sourceCommit, '--', deployRoot
).toString('utf8').split('\0').filter(Boolean)
const treeEntries = treeRows.map(row => {
  const match = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/.exec(row)
  if (!match) throw new Error(`could not parse committed tree row: ${row}`)
  const [, mode, type, object, fullPath] = match
  if (mode !== '100644' || type !== 'blob') {
    throw new Error(`unsupported committed entry ${fullPath}: ${mode} ${type}`)
  }
  return { object, path: fullPath.slice(`${deployRoot}/`.length) }
})
treeEntries.sort((left, right) => compareText(left.path, right.path))

const committedPaths = treeEntries.map(entry => entry.path)
if (JSON.stringify(committedPaths) !== JSON.stringify(allowedFiles)) {
  throw new Error(
    `committed web file set is not the explicit static allowlist: ${committedPaths.join(', ')}`
  )
}

const entries = treeEntries.map(entry => {
  if (entry.path === '_worker.js' || entry.path.startsWith('functions/')) {
    throw new Error(`Pages Functions are forbidden in this static bundle: ${entry.path}`)
  }
  const body = gitBuffer('-C', repoRoot, 'cat-file', 'blob', entry.object)
  const filename = path.posix.basename(entry.path)
  const extension = path.posix.extname(filename).toLowerCase()
  const mime = filename === '_headers' || filename === '_redirects'
    ? 'text/plain; charset=utf-8'
    : (mimeTypes.get(extension) || 'application/octet-stream')
  if (mime.startsWith('text/') || mime.startsWith('application/json')) {
    const text = body.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(body)) {
      throw new Error(`text asset is not valid UTF-8: ${entry.path}`)
    }
    for (const [description, pattern] of secretPatterns) {
      if (pattern.test(text)) throw new Error(`${description} detected in Pages file: ${entry.path}`)
    }
  }
  return {
    body,
    metadata: {
      path: entry.path,
      bytes: body.byteLength,
      mime,
      sha256: sha256(body),
      git_blob: entry.object
    }
  }
})

const redirects = entries.find(entry => entry.metadata.path === '_redirects')?.body.toString('utf8')
const headers = entries.find(entry => entry.metadata.path === '_headers')?.body.toString('utf8')
const expectedRedirects = [
  '/download/mac https://github.com/desmoslock/desmoslock-releases/releases/latest/download/DesmosLock-mac.dmg 302',
  '/download/mac-intel https://github.com/desmoslock/desmoslock-releases/releases/latest/download/DesmosLock-mac-intel.dmg 302',
  '/download/windows https://github.com/desmoslock/desmoslock-releases/releases/latest/download/DesmosLock-setup.exe 302',
  '/download/linux https://github.com/desmoslock/desmoslock-releases/releases/latest/download/DesmosLock.AppImage 302',
  '/releases https://github.com/desmoslock/desmoslock-releases/releases/latest 302',
  ''
].join('\n')
const expectedHeaders = [
  '/*',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  ''
].join('\n')
if (redirects !== expectedRedirects) throw new Error('Pages redirects do not match the five stable org routes')
if (headers !== expectedHeaders) throw new Error('Pages headers do not match the preserved security policy')

const publicConfig = entries.find(entry => entry.metadata.path === 'config.js')?.body.toString('utf8') || ''
const publicKeyMatches = [...publicConfig.matchAll(/supabaseKey:\s*'([^']+)'/g)]
const publicUrlMatches = [...publicConfig.matchAll(/supabaseUrl:\s*'([^']+)'/g)]
if (publicKeyMatches.length !== 1 || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publicKeyMatches[0][1])) {
  throw new Error('web config must contain exactly one Supabase publishable key')
}
if (publicUrlMatches.length !== 1 || !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(publicUrlMatches[0][1])) {
  throw new Error('web config must contain exactly one HTTPS Supabase project URL')
}

await mkdir(path.dirname(uploadPath), { recursive: true })
await mkdir(uploadPath, { mode: 0o755 })
for (const entry of entries) {
  const destination = path.join(uploadPath, ...entry.metadata.path.split('/'))
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, entry.body, { flag: 'wx', mode: 0o644 })
  const written = await readFile(destination)
  const stats = await lstat(destination)
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`materialized upload entry is not a regular file: ${entry.metadata.path}`)
  }
  if (written.byteLength !== entry.metadata.bytes || sha256(written) !== entry.metadata.sha256) {
    throw new Error(`materialized upload entry differs from committed Git blob: ${entry.metadata.path}`)
  }
}

const walkRegularFiles = async (directory, prefix = '') => {
  const names = await readdir(directory)
  names.sort(compareText)
  const files = []
  for (const name of names) {
    const absolute = path.join(directory, name)
    const relative = prefix ? `${prefix}/${name}` : name
    const stats = await lstat(absolute)
    if (stats.isSymbolicLink()) throw new Error(`symlink is forbidden in upload directory: ${relative}`)
    if (stats.isDirectory()) files.push(...await walkRegularFiles(absolute, relative))
    else if (stats.isFile()) files.push(relative)
    else throw new Error(`non-file entry is forbidden in upload directory: ${relative}`)
  }
  return files
}
const materializedPaths = await walkRegularFiles(uploadPath)
if (JSON.stringify(materializedPaths) !== JSON.stringify(allowedFiles)) {
  throw new Error(`materialized upload file set differs from allowlist: ${materializedPaths.join(', ')}`)
}

await mkdir(path.dirname(bundlePath), { recursive: true })
gitBuffer(
  '-C', repoRoot,
  'archive',
  '--format=zip',
  '-0',
  '--mtime=2000-01-01T00:00:00Z',
  `--output=${bundlePath}`,
  `${sourceCommit}:${deployRoot}`,
  ...allowedFiles
)
const archive = await readFile(bundlePath)
execFileSync('unzip', ['-tqq', bundlePath], { stdio: 'ignore' })
const archiveMembers = execFileSync('unzip', ['-Z1', bundlePath], { encoding: 'utf8' })
  .split('\n').filter(member => member && !member.endsWith('/')).sort(compareText)
if (JSON.stringify(archiveMembers) !== JSON.stringify(allowedFiles)) {
  throw new Error(`ZIP regular-file set differs from allowlist: ${archiveMembers.join(', ')}`)
}
for (const entry of entries) {
  const archivedBody = execFileSync('unzip', ['-p', bundlePath, entry.metadata.path], {
    maxBuffer: 32 * 1024 * 1024
  })
  if (sha256(archivedBody) !== entry.metadata.sha256 || archivedBody.byteLength !== entry.metadata.bytes) {
    throw new Error(`ZIP member differs from committed Git blob: ${entry.metadata.path}`)
  }
}

const files = entries.map(entry => entry.metadata)
const canonicalFileSet = files
  .map(file => `${file.path}\0${file.bytes}\0${file.mime}\0${file.sha256}\0${file.git_blob}\n`)
  .join('')
const receipt = {
  schema_version: 1,
  manifest_kind: 'integrity-receipt',
  source_commit: sourceCommit,
  source_web_tree: treeObject,
  generator: {
    path: generatorRelativePath,
    git_blob: generatorObject,
    bytes: generatorRunningBody.byteLength,
    sha256: sha256(generatorRunningBody)
  },
  release_repository: 'desmoslock/desmoslock-releases',
  pages_project: 'desmoslock',
  pages_url: 'https://desmoslock.pages.dev',
  deploy_root: 'web',
  upload_directory: {
    dirname: path.basename(uploadPath),
    file_count: files.length,
    file_set_sha256: sha256(canonicalFileSet)
  },
  file_count: files.length,
  total_file_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  file_set_sha256: sha256(canonicalFileSet),
  archive: {
    filename: path.basename(bundlePath),
    format: 'zip-store',
    bytes: archive.byteLength,
    sha256: sha256(archive)
  },
  bundle_audit: {
    pages_function_files: 0,
    runtime_config_files: 0,
    secret_pattern_matches: 0
  },
  cloudflare_upload_contract: {
    static_asset_files: files.length - 2,
    static_asset_bytes: files
      .filter(file => file.path !== '_headers' && file.path !== '_redirects')
      .reduce((sum, file) => sum + file.bytes, 0),
    special_configuration_files: ['_headers', '_redirects'],
    special_configuration_bytes: files
      .filter(file => file.path === '_headers' || file.path === '_redirects')
      .reduce((sum, file) => sum + file.bytes, 0),
    integrity_hash_algorithm: 'sha256',
    transport_manifest: 'generated-by-wrangler-not-this-receipt'
  },
  requested_project_contract: {
    bindings: 0,
    secrets: 0,
    analytics: false,
    verification: 'cloudflare-connector-required'
  },
  files
}

await mkdir(path.dirname(receiptPath), { recursive: true })
const receiptBody = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)
await writeFile(receiptPath, receiptBody, { flag: 'wx', mode: 0o644 })
console.log(
  `wrote verified ${files.length}-file upload directory, deterministic ${receipt.archive.bytes}-byte ZIP, and integrity receipt; receipt_sha256=${sha256(receiptBody)}`
)
