import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')
const DB_FILE = path.join(DATA_DIR, 'db.json')

const EMPTY = {
  teachers: [],
  sessions: [],
  students: [],
  alerts: [],
  tokens: {} // token -> { kind: 'teacher'|'student', id }
}

function load () {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8')
    return { ...EMPTY, ...JSON.parse(raw) }
  } catch {
    return structuredClone(EMPTY)
  }
}

export const db = load()

let writeQueued = false
export function save () {
  // Debounced atomic write. Every mutation calls this; we coalesce them.
  if (writeQueued) return
  writeQueued = true
  setTimeout(() => {
    writeQueued = false
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      const tmp = DB_FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2))
      fs.renameSync(tmp, DB_FILE)
    } catch (err) {
      console.error('[db] write failed:', err.message)
    }
  }, 50)
}
