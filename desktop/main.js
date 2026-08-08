const { app, BrowserWindow, ipcMain, globalShortcut, Menu, powerMonitor, screen, shell, session } = require('electron')
const path = require('path')
const fs = require('fs')
const { execFile } = require('child_process')

const IS_MAC = process.platform === 'darwin'

/* ------------------------------------------------------------------ state */

let win = null              // the calculator window
let blockers = []           // opaque covers for every other display
let locked = false
let watchdog = null
let lastAwayReport = 0
let lastFsKick = 0
let lastAppScan = 0
let displaySignature = ''

const NORMAL_SIZE = { width: 1280, height: 860 }

const STORE_FILE = () => path.join(app.getPath('userData'), 'desmoslock-store.json')

// Origins the renderer may reach: whichever DesmosLock server the user pointed
// at (LAN address, localhost, or a school domain). Nothing else.
const allowedOrigins = new Set()

function allowServerOrigin (raw) {
  try {
    const { origin } = new URL(String(raw))
    allowedOrigins.add(origin)
    allowedOrigins.add(origin.replace(/^http/, 'ws'))
    return origin
  } catch { return null }
}

function readStore () {
  try { return JSON.parse(fs.readFileSync(STORE_FILE(), 'utf8')) } catch { return {} }
}

function writeStore (data) {
  try {
    fs.mkdirSync(path.dirname(STORE_FILE()), { recursive: true })
    fs.writeFileSync(STORE_FILE(), JSON.stringify(data, null, 2))
  } catch (err) {
    console.error('[store] write failed', err.message)
  }
}

function report (kind, detail = '') {
  if (!win || win.isDestroyed()) return
  win.webContents.send('lock:event', { kind, detail, at: Date.now() })
}

function status () {
  return {
    locked,
    covering: isCovering(),
    onTop: win && !win.isDestroyed() ? win.isAlwaysOnTop() : false,
    allSpaces: win && !win.isDestroyed() ? win.isVisibleOnAllWorkspaces() : false,
    displays: screen.getAllDisplays().length,
    blockers: blockers.length
  }
}

/* ------------------------------------------------- other running apps

   Before a student starts, everything else has to be shut. We enumerate GUI
   apps with plain `ps` / `tasklist` rather than scripting the window server,
   because those need an Automation permission prompt that a student can simply
   decline — and a check they can decline is not a check.

   We never kill anything. Terminating another app risks destroying unsaved work
   that is not ours to lose, so we refuse to start and name what is in the way.
--------------------------------------------------------------------------- */

// Helpers, agents and our own processes: present on every machine, not "apps".
const APP_IGNORE = new Set([
  'DesmosLock', 'Electron', 'Finder', 'Dock', 'SystemUIServer', 'ControlCenter',
  'NotificationCenter', 'Spotlight', 'loginwindow', 'WindowServer', 'Terminal',
  'iTerm2', 'explorer', 'ApplicationFrameHost', 'TextInputHost', 'ShellExperienceHost',
  'SearchHost', 'StartMenuExperienceHost', 'SystemSettings', 'universalaccessd'
])

const looksLikeHelper = (name) =>
  /helper|crashpad|renderer|gpu process|\(plugin\)|\(service\)|\(gpu\)|agent$|daemon$|xpc|updater$/i.test(name)

function parseMacApps (stdout) {
  const apps = new Map()
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\/.*)$/)
    if (!m) continue
    const [, pid, execPath] = m
    // Only real bundles, and nothing shipped inside the OS.
    if (!execPath.includes('.app/Contents/MacOS/')) continue
    if (execPath.startsWith('/System/') || execPath.startsWith('/usr/')) continue
    if (execPath.startsWith('/Library/') && !execPath.startsWith('/Library/Application Support/')) continue
    const bundle = execPath.match(/([^/]+)\.app\/Contents\/MacOS\//)
    if (!bundle) continue
    const name = bundle[1]
    if (APP_IGNORE.has(name) || looksLikeHelper(name)) continue
    if (!apps.has(name)) apps.set(name, Number(pid))
  }
  return [...apps].map(([name, pid]) => ({ name, pid }))
}

function parseWindowsApps (stdout) {
  const apps = new Map()
  for (const raw of stdout.split('\n')) {
    const name = raw.trim()
    if (!name || APP_IGNORE.has(name) || looksLikeHelper(name)) continue
    if (/^desmoslock$/i.test(name)) continue
    if (!apps.has(name)) apps.set(name, 0)
  }
  return [...apps].map(([name, pid]) => ({ name, pid }))
}

function listRunningApps () {
  return new Promise((resolve) => {
    const done = (fn) => (err, stdout) => resolve(err ? [] : fn(String(stdout || '')))
    if (IS_MAC) {
      execFile('/bin/ps', ['-axo', 'pid=,comm='], { maxBuffer: 8e6 }, done(parseMacApps))
    } else if (process.platform === 'win32') {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -ExpandProperty ProcessName"],
      { maxBuffer: 8e6 }, done(parseWindowsApps))
    } else {
      execFile('/bin/ps', ['-axo', 'pid=,comm='], { maxBuffer: 8e6 }, done((out) => {
        const apps = new Map()
        for (const line of out.split('\n')) {
          const m = line.trim().match(/^(\d+)\s+(\/\S+)$/)
          if (!m) continue
          const name = m[2].split('/').pop()
          if (!/^\/(usr\/bin|opt|snap|usr\/lib)/.test(m[2])) continue
          if (APP_IGNORE.has(name) || looksLikeHelper(name)) continue
          if (!apps.has(name)) apps.set(name, Number(m[1]))
        }
        return [...apps].map(([name, pid]) => ({ name, pid }))
      }))
    }
  })
}

/* ------------------------------------------------- keyboard / shortcut net */

// Swallowed system-wide while locked. Whatever the OS lets us take, we take;
// whatever it doesn't, the watchdog catches and the teacher hears about.
const BLOCKED_ACCELERATORS = [
  // quit / close / hide
  'CommandOrControl+Q', 'CommandOrControl+W', 'CommandOrControl+M', 'CommandOrControl+H',
  'CommandOrControl+Shift+H', 'CommandOrControl+Alt+H', 'Alt+F4',
  // app switching
  'CommandOrControl+Tab', 'CommandOrControl+Shift+Tab', 'CommandOrControl+`',
  'Alt+Tab', 'Alt+Shift+Tab', 'Alt+Escape', 'Alt+Space',
  'CommandOrControl+Alt+Escape', 'CommandOrControl+Shift+Escape',
  // Spaces / Mission Control / Exposé  (the swipe-to-another-desktop routes)
  'Control+Left', 'Control+Right', 'Control+Up', 'Control+Down',
  'Control+Alt+Left', 'Control+Alt+Right', 'Control+Shift+Left', 'Control+Shift+Right',
  'Control+1', 'Control+2', 'Control+3', 'Control+4',
  'F3', 'Control+F3', 'Alt+F3', 'F4', 'F11', 'F12',
  // Spotlight / launchers / OS shells
  'CommandOrControl+Space', 'CommandOrControl+Alt+Space', 'Alt+Shift+Space',
  'Super', 'Super+D', 'Super+E', 'Super+L', 'Super+R', 'Super+Tab', 'Super+Up', 'Super+Down',
  // new windows / files / printing / find
  'CommandOrControl+N', 'CommandOrControl+Shift+N', 'CommandOrControl+T',
  'CommandOrControl+O', 'CommandOrControl+P', 'CommandOrControl+S', 'CommandOrControl+F',
  // devtools / reload
  'CommandOrControl+R', 'CommandOrControl+Shift+R', 'CommandOrControl+Shift+I',
  'CommandOrControl+Alt+I', 'CommandOrControl+Shift+J', 'CommandOrControl+Shift+C',
  // screenshots
  'PrintScreen', 'Alt+PrintScreen', 'CommandOrControl+PrintScreen',
  'CommandOrControl+Shift+3', 'CommandOrControl+Shift+4', 'CommandOrControl+Shift+5',
  'CommandOrControl+Shift+6',
  // remaining function row
  'F1', 'F2', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10'
]

function registerBlockers () {
  for (const accel of BLOCKED_ACCELERATORS) {
    try {
      globalShortcut.register(accel, () => report('blocked_key', accel))
    } catch {
      // Not every accelerator exists on every platform. Ignore.
    }
  }
  // Emergency override: the teacher's per-test unlock code, entered in-app.
  try {
    globalShortcut.register('CommandOrControl+Alt+Shift+U', () => {
      if (win && !win.isDestroyed()) win.webContents.send('lock:event', { kind: 'override_prompt', at: Date.now() })
    })
  } catch {}
}

function unregisterBlockers () {
  globalShortcut.unregisterAll()
}

// Second net: keystrokes that reach the window itself.
function installInputFilter (contents) {
  contents.on('before-input-event', (event, input) => {
    if (!locked) return
    const key = (input.key || '').toLowerCase()
    const mod = input.control || input.meta || input.alt

    const isDevTools = mod && input.shift && ['i', 'j', 'c'].includes(key)
    const isReload = mod && key === 'r'
    const isFunction = /^f\d{1,2}$/.test(key)
    const isSwitch = (input.alt || input.meta) && key === 'tab'
    const isSpaces = input.control && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)
    const isPrint = key === 'printscreen'
    const isQuit = mod && ['q', 'w', 'm', 'h', 'n', 't', 'p', 'o', 's'].includes(key)

    if (isDevTools || isReload || isFunction || isSwitch || isSpaces || isPrint || isQuit) {
      event.preventDefault()
      report('blocked_key', input.key)
    }
  })
}

/* ------------------------------------------------------ covering the screen

   macOS notes, because this is where the last version leaked:

   - Native fullscreen (and therefore Electron's kiosk mode) parks the window in
     its OWN Space. A three-finger swipe or Ctrl+Arrow walks straight out of it.
     So we never stay in native fullscreen; the watchdog kicks us back out.
   - Simple fullscreen covers the display's full frame, menu bar and dock
     included, while staying on the current Space.
   - NSScreenSaverWindowLevel puts the window above every other app's windows,
     the dock and the menu bar. Even when another app steals key focus, there is
     nothing of it visible or clickable underneath us.
   - "Can join all Spaces" makes the window follow the student into every desktop
     they swipe to, so switching Spaces shows the same lock.
   - One window only covers one display. Every other display gets its own opaque
     blocker window with the same level and behaviour.

   Tried and rejected: entering kiosk to borrow its presentation options
   (DisableProcessSwitching / DisableForceQuit) and then leaving fullscreen.
   Measured on macOS 15 — the options are dropped on the way out of fullscreen
   (workArea stays 949 of 982), so it bought nothing but a 2s animation.
--------------------------------------------------------------------------- */

function coveredDisplay () {
  if (!win || win.isDestroyed()) return screen.getPrimaryDisplay()
  try { return screen.getDisplayMatching(win.getBounds()) } catch { return screen.getPrimaryDisplay() }
}

// Measured on macOS 15: a plain setBounds() to the display's full bounds gets
// clamped to the work area (1512x949 of a 1512x982 screen) whether the window
// is framed or not — the menu bar strip stays live and clickable. Simple
// fullscreen is the only mode that covers all 982 rows without handing the
// window its own Space.
function coverWindow (w, display) {
  w.setAlwaysOnTop(true, 'screen-saver', 1)
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })

  if (IS_MAC) {
    if (w.isFullScreen()) w.setFullScreen(false)
    if (!w.isSimpleFullScreen()) w.setSimpleFullScreen(true)
  } else {
    if (!w.isKiosk()) w.setKiosk(true)
  }

  // Belt and braces for platforms/displays where the above is a no-op.
  const b = display.bounds
  const cur = w.getBounds()
  if (cur.width < b.width || cur.height < b.height) w.setBounds(b)
}

function uncoverWindow (w) {
  if (IS_MAC) { if (w.isSimpleFullScreen()) w.setSimpleFullScreen(false) } else { w.setKiosk(false) }
  if (w.isFullScreen()) w.setFullScreen(false)
  w.setAlwaysOnTop(false)
  w.setVisibleOnAllWorkspaces(false)
}

function applyCover () {
  if (!win || win.isDestroyed()) return null
  const display = coveredDisplay()
  coverWindow(win, display)
  return display
}

function isCovering () {
  if (!win || win.isDestroyed()) return false
  if (IS_MAC) return win.isSimpleFullScreen()
  return win.isKiosk() || win.isFullScreen()
}

/* --------------------------------------------------------------- blockers */

function displaysSignature () {
  return screen.getAllDisplays().map(d => `${d.id}:${d.bounds.x},${d.bounds.y},${d.bounds.width},${d.bounds.height}`).join('|')
}

function makeBlocker (display) {
  const b = display.bounds
  const w = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,     // swallows clicks without stealing focus from the calculator
    backgroundColor: '#ffffff',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false }
  })
  w.loadFile(path.join(__dirname, 'renderer', 'blocked.html'))
  w.setContentProtection(true)
  w.once('ready-to-show', () => {
    if (w.isDestroyed()) return
    w.showInactive()
    coverWindow(w, display)   // covers that display's dock/menu bar too
  })
  return w
}

function spawnBlockers () {
  killBlockers()
  const main = coveredDisplay()
  for (const display of screen.getAllDisplays()) {
    if (display.id === main.id) continue
    try { blockers.push(makeBlocker(display)) } catch (err) { console.error('[blocker]', err.message) }
  }
  displaySignature = displaysSignature()
}

function killBlockers () {
  for (const w of blockers) { try { if (!w.isDestroyed()) { w.destroy() } } catch {} }
  blockers = []
}

/* --------------------------------------------------------------- watchdog */

function startWatchdog () {
  stopWatchdog()
  displaySignature = displaysSignature()
  watchdog = setInterval(() => {
    if (!locked || !win || win.isDestroyed()) return

    // A display was plugged in, unplugged or resized: re-cover everything.
    const sig = displaysSignature()
    if (sig !== displaySignature) {
      report('display_changed', `${displaySignature.split('|').length} -> ${sig.split('|').length} displays`)
      displaySignature = sig
      applyCover()
      spawnBlockers()
    }

    // macOS can pull us into native fullscreen (green button, gestures), which
    // would park us in a swipe-able Space. Drop straight back out.
    if (IS_MAC && win.isFullScreen() && Date.now() - lastFsKick > 1500) {
      lastFsKick = Date.now()
      win.setFullScreen(false)
      setTimeout(applyCover, 400)
    }

    if (!win.isVisible()) win.show()
    if (win.isMinimized()) win.restore()
    if (!win.isAlwaysOnTop() || !isCovering()) applyCover()

    // Keep the other displays covered even if a blocker died.
    for (const w of blockers) {
      if (w.isDestroyed()) continue
      if (!w.isVisible()) w.showInactive()
      if (!w.isAlwaysOnTop()) w.setAlwaysOnTop(true, 'screen-saver', 1)
      w.moveTop()
    }
    if (blockers.some(w => w.isDestroyed())) spawnBlockers()

    // Something launched during the test: the teacher hears about it.
    if (Date.now() - lastAppScan > 10000) {
      lastAppScan = Date.now()
      listRunningApps().then((apps) => {
        if (locked && apps.length) report('other_app_opened', apps.map(a => a.name).slice(0, 6).join(', '))
      })
    }

    if (!win.isFocused()) {
      win.moveTop()
      win.focus()
      app.focus({ steal: true })
      const t = Date.now()
      if (t - lastAwayReport > 4000) {
        lastAwayReport = t
        report('left_app', 'Another window took focus')
      }
    }
  }, 300)
}

function stopWatchdog () {
  if (watchdog) clearInterval(watchdog)
  watchdog = null
}

/* ------------------------------------------------------------ lock engage */

function engageLock () {
  if (!win || win.isDestroyed()) return status()
  locked = true
  lastAwayReport = 0

  win.setMenuBarVisibility(false)
  win.setClosable(false)
  win.setMinimizable(false)
  win.setMovable(false)
  win.setContentProtection(true) // blocks screen capture / screen sharing

  applyCover()
  spawnBlockers()
  registerBlockers()
  startWatchdog()

  win.show()
  win.focus()
  app.focus({ steal: true })
  return status()
}

function releaseLock () {
  locked = false
  stopWatchdog()
  unregisterBlockers()
  killBlockers()
  if (!win || win.isDestroyed()) return status()

  uncoverWindow(win)
  win.setClosable(true)
  win.setMinimizable(true)
  win.setMovable(true)
  win.setResizable(true)
  win.setContentProtection(false)
  win.setMenuBarVisibility(true)

  const display = coveredDisplay()
  win.setBounds({
    width: Math.min(NORMAL_SIZE.width, display.workAreaSize.width),
    height: Math.min(NORMAL_SIZE.height, display.workAreaSize.height),
    x: display.workArea.x + Math.round((display.workAreaSize.width - Math.min(NORMAL_SIZE.width, display.workAreaSize.width)) / 2),
    y: display.workArea.y + Math.round((display.workAreaSize.height - Math.min(NORMAL_SIZE.height, display.workAreaSize.height)) / 2)
  })
  return status()
}

/* ---------------------------------------------------------------- windows */

function createWindow () {
  win = new BrowserWindow({
    width: NORMAL_SIZE.width,
    height: NORMAL_SIZE.height,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#ffffff',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win.show())
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  installInputFilter(win.webContents)

  win.on('close', (e) => {
    if (locked) {
      e.preventDefault()
      report('quit_attempt', 'Window close blocked')
      win.show(); win.focus()
    }
  })

  win.on('blur', () => {
    if (!locked) return
    const t = Date.now()
    if (t - lastAwayReport > 4000) {
      lastAwayReport = t
      report('left_app', 'Window lost focus')
    }
    setImmediate(() => { if (locked && win && !win.isDestroyed()) { win.focus(); app.focus({ steal: true }) } })
  })

  win.on('minimize', (e) => {
    if (locked) { e.preventDefault(); win.restore(); win.focus() }
  })

  win.on('enter-full-screen', () => {
    // Never sit in a Space of our own while locked.
    if (locked && IS_MAC) setTimeout(() => { if (locked) win.setFullScreen(false) }, 0)
  })

  win.on('leave-full-screen', () => { if (locked) setTimeout(applyCover, 30) })
  win.on('moved', () => { if (locked) applyCover() })
  win.on('resize', () => { if (locked) applyCover() })

  // No outbound navigation, ever.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); if (locked) report('blocked_key', 'navigation blocked') }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!locked && /^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('context-menu', (e) => { if (locked) e.preventDefault() })
}

/* -------------------------------------------------------------- app hooks */

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus() }
  })

  app.whenReady().then(() => {
    Menu.setApplicationMenu(buildMenu())

    // Only our own files, Desmos, and the DesmosLock server may load.
    // Everything else is dropped — no browsing your way out of a test.
    session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
      const url = details.url
      let origin = ''
      try { origin = new URL(url).origin } catch {}
      const allowed =
        url.startsWith('file://') ||
        url.startsWith('devtools://') ||
        url.startsWith('blob:') ||
        url.startsWith('data:') ||
        /^https?:\/\/([a-z0-9-]+\.)*desmos\.com\//i.test(url) ||
        allowedOrigins.has(origin) ||
        allowedOrigins.has(origin.replace(/^ws/, 'http'))
      cb({ cancel: !allowed })
    })

    createWindow()

    screen.on('display-added', () => { if (locked) { applyCover(); spawnBlockers() } })
    screen.on('display-removed', () => { if (locked) { applyCover(); spawnBlockers() } })
    screen.on('display-metrics-changed', () => { if (locked) { applyCover(); spawnBlockers() } })

    powerMonitor.on('lock-screen', () => { if (locked) report('screen_locked', 'Screen locked') })
    powerMonitor.on('suspend', () => { if (locked) report('screen_locked', 'Machine suspended') })
    powerMonitor.on('resume', () => {
      if (!locked || !win) return
      applyCover(); spawnBlockers()
      win.show(); win.focus(); app.focus({ steal: true })
    })

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  })

  app.on('before-quit', (e) => {
    if (locked) {
      e.preventDefault()
      report('quit_attempt', 'Quit blocked')
      if (win && !win.isDestroyed()) { win.show(); win.focus() }
    }
  })

  app.on('will-quit', () => { stopWatchdog(); unregisterBlockers(); killBlockers() })
  app.on('window-all-closed', () => { if (!IS_MAC) app.quit() })
}

function buildMenu () {
  // Minimal menu: keeps copy/paste working inside the calculator, and keeps
  // macOS from installing its default quit/hide-heavy menu.
  const template = [
    ...(IS_MAC ? [{ label: 'DesmosLock', submenu: [{ role: 'about' }] }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    }
  ]
  return Menu.buildFromTemplate(template)
}

/* -------------------------------------------------------------------- IPC */

ipcMain.handle('lock:engage', () => engageLock())
ipcMain.handle('lock:release', () => releaseLock())
ipcMain.handle('lock:status', () => status())

ipcMain.handle('apps:scan', () => listRunningApps())

ipcMain.handle('net:allow-server', (_e, url) => allowServerOrigin(url))

ipcMain.handle('store:get', (_e, key) => readStore()[key] ?? null)
ipcMain.handle('store:set', (_e, key, value) => {
  const data = readStore()
  if (value === null || value === undefined) delete data[key]
  else data[key] = value
  writeStore(data)
  return true
})

ipcMain.handle('window:mode', (_e, mode) => {
  if (!win || win.isDestroyed() || locked) return false
  if (mode === 'console') {
    win.setResizable(true)
    if (!win.isMaximized()) win.setSize(NORMAL_SIZE.width, NORMAL_SIZE.height, true)
    win.center()
  }
  return true
})

ipcMain.handle('app:quit', () => {
  if (locked) return false
  app.quit()
  return true
})
