// DSH client half: completion notifications + matching sounds + settings UI.
// Build wraps this file into the web plugin bundle:
//   - `React` is provided by the bundle wrapper (require("react"))
//   - `apply(ctx)` is the plugin entry; inject: ["slots", "timer"] set by the wrapper
//   - completion records are polled from the host endpoint /dsh-notification-center/poll
// This file is plain JavaScript (no TS/JSX) so it can be bundled as-is.

const STORAGE_KEY = 'dsh.completionNotify.v4'
const CAT_KEYS = ['turn', 'subagent', 'workflow', 'job', 'error', 'max-tokens', 'blocked', 'other', 'manual', 'approval']
const SOUND_DEFAULTS = {
  turn: 'success',
  subagent: 'ping',
  workflow: 'tada',
  job: 'pop',
  error: 'error',
  'max-tokens': 'beep',
  blocked: 'whoosh',
  other: 'marimba',
  manual: 'soft',
  approval: 'alarm'
}
const buildCatConf = () => {
  const o = {}
  for (const k of CAT_KEYS) o[k] = { notify: k !== 'manual', soundOn: k !== 'manual', sound: SOUND_DEFAULTS[k] || 'chime', file: '', fileName: '', url: '', volume: 1 }
  return o
}
const DEFAULTS = {
  notif: true,
  sound: true,
  cooldownMs: 3000,
  catConf: buildCatConf(),
  showBell: true
}
function loadSettings() {
  const base = JSON.parse(JSON.stringify(DEFAULTS))
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw)
      if (saved && typeof saved === 'object') {
        for (const k of Object.keys(base)) {
          const b = base[k]
          const s = saved[k]
          if (s === undefined) continue
          if (k === 'catConf' && s && typeof s === 'object') {
            for (const kk of Object.keys(b)) {
              if (s[kk] && typeof s[kk] === 'object') {
                const merged = Object.assign({}, b[kk], s[kk])
                // migrate: old data had no soundOn; sound was gated by notify
                if (typeof s[kk].soundOn !== 'boolean') merged.soundOn = merged.notify !== false
                if (typeof merged.volume !== 'number' || !isFinite(merged.volume) || merged.volume > 1) merged.volume = 1
                b[kk] = merged
              }
            }
          } else if (b !== null && typeof b === 'object' && !Array.isArray(b) && s !== null && typeof s === 'object' && !Array.isArray(s)) {
            Object.assign(b, s)
          } else {
            base[k] = s
          }
        }
      }
    }
  } catch (_) { /* corrupt or unavailable storage */ }
  return base
}
const settings = loadSettings()
const settingsListeners = new Set()
const subscribeSettings = (fn) => {
  settingsListeners.add(fn)
  return () => settingsListeners.delete(fn)
}
const saveSettings = () => {
  let ok = true
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch (_) { ok = false }
  for (const fn of settingsListeners) {
    try { fn() } catch (_) { /* ignore */ }
  }
  return ok
}
const volOf = (v) => {
  const n = Number(v)
  return typeof n === 'number' && isFinite(n) ? Math.max(0, Math.min(1, n)) : 1
}

const state = { open: false, status: '' }
let sessionId = ''
let lastId = 0
let synced = false
let polling = false
let lastNotifyAt = 0
let audioCtx = null
const history = []

const ensureAudio = () => {
  try {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    if (!audioCtx) audioCtx = new AC()
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
    return audioCtx
  } catch (_) { return null }
}
const playTone = (tone, vol) => {
  const ac = ensureAudio()
  if (!ac || tone === 'none') return
  try {
    const t0 = ac.currentTime
    const note = (freq, t, dur, type, g) => {
      const osc = ac.createOscillator()
      const gain = ac.createGain()
      osc.type = type || 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(Math.max(0.001, g), t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      osc.connect(gain)
      gain.connect(ac.destination)
      osc.start(t)
      osc.stop(t + dur + 0.05)
    }
    const sweep = (f0, f1, t, dur, type, g) => {
      const osc = ac.createOscillator()
      const gain = ac.createGain()
      osc.type = type || 'triangle'
      osc.frequency.setValueAtTime(f0, t)
      osc.frequency.exponentialRampToValueAtTime(f1, t + dur)
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(Math.max(0.001, g), t + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      osc.connect(gain)
      gain.connect(ac.destination)
      osc.start(t)
      osc.stop(t + dur + 0.05)
    }
    const noiseBurst = (t, dur, freq, g) => {
      const sr = ac.sampleRate || 44100
      const len = Math.max(1, Math.floor(sr * dur))
      const buffer = ac.createBuffer(1, len, sr)
      const data = buffer.getChannelData(0)
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len)
      const src = ac.createBufferSource()
      src.buffer = buffer
      const filter = ac.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.value = freq
      filter.Q.value = 0.7
      const gain = ac.createGain()
      gain.gain.setValueAtTime(Math.max(0.001, g), t)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      src.connect(filter)
      filter.connect(gain)
      gain.connect(ac.destination)
      src.start(t)
      src.stop(t + dur + 0.05)
    }
    switch (tone) {
      case 'chime':
        ;[880, 1174.66, 1567.98].forEach((f, i) => note(f, t0 + i * 0.12, 0.45, 'sine', vol * 0.32))
        break
      case 'ding':
        note(1318.51, t0, 0.5, 'sine', vol * 0.3)
        note(987.77, t0 + 0.18, 0.6, 'sine', vol * 0.3)
        break
      case 'pop':
        sweep(660, 1320, t0, 0.18, 'triangle', vol * 0.4)
        break
      case 'soft':
        ;[523.25, 659.25, 783.99].forEach((f, i) => note(f, t0 + i * 0.1, 0.5, 'sine', vol * 0.18))
        break
      case 'beep':
        note(880, t0, 0.08, 'square', vol * 0.2)
        note(880, t0 + 0.12, 0.08, 'square', vol * 0.2)
        note(1174.66, t0 + 0.24, 0.14, 'square', vol * 0.2)
        break
      case 'ping':
        note(1567.98, t0, 0.6, 'sine', vol * 0.3)
        break
      case 'success':
        ;[523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(f, t0 + i * 0.09, 0.4, 'sine', vol * 0.28))
        break
      case 'error':
        note(233.08, t0, 0.25, 'sawtooth', vol * 0.2)
        note(174.61, t0 + 0.22, 0.35, 'sawtooth', vol * 0.2)
        break
      case 'whoosh':
        noiseBurst(t0, 0.35, 2200, vol * 0.3)
        note(300, t0, 0.35, 'sine', vol * 0.12)
        break
      case 'marimba':
        ;[523.25, 783.99, 659.25, 987.77].forEach((f, i) => note(f, t0 + i * 0.11, 0.35, 'triangle', vol * 0.3))
        break
      case 'twinkle':
        ;[2093, 2637.02, 3135.96].forEach((f, i) => note(f, t0 + i * 0.07, 0.3, 'sine', vol * 0.16))
        break
      case 'alarm':
        ;[660, 880, 660, 880].forEach((f, i) => note(f, t0 + i * 0.22, 0.14, 'square', vol * 0.2))
        break
      case 'bell':
        note(1567.98, t0, 0.9, 'sine', vol * 0.28)
        note(2093, t0, 0.5, 'sine', vol * 0.12)
        note(1567.98, t0 + 0.25, 0.7, 'sine', vol * 0.16)
        break
      case 'bubble':
        ;[392, 523.25, 659.25, 783.99].forEach((f, i) => note(f, t0 + i * 0.09, 0.12, 'triangle', vol * 0.26))
        break
      case 'coin':
        ;[1318.51, 1567.98, 1975.53].forEach((f, i) => note(f, t0 + i * 0.055, 0.09, 'square', vol * 0.2))
        note(2637.02, t0 + 0.17, 0.35, 'sine', vol * 0.18)
        break
      case 'harp':
        ;[1567.98, 1318.51, 1174.66, 1046.5, 783.99].forEach((f, i) => note(f, t0 + i * 0.08, 0.28, 'triangle', vol * 0.28))
        break
      case 'horn':
        note(220, t0, 0.6, 'sawtooth', vol * 0.2)
        note(330, t0 + 0.05, 0.55, 'sawtooth', vol * 0.14)
        break
      case 'laser':
        sweep(2000, 200, t0, 0.25, 'square', vol * 0.22)
        break
      case 'melody':
        ;[523.25, 659.25, 783.99, 1046.5, 1318.51].forEach((f, i) => note(f, t0 + i * 0.12, 0.3, 'sine', vol * 0.26))
        break
      case 'piano':
        note(523.25, t0, 0.3, 'triangle', vol * 0.3)
        note(1046.5, t0, 0.2, 'sine', vol * 0.12)
        note(392, t0 + 0.14, 0.25, 'triangle', vol * 0.2)
        break
      case 'tada':
        ;[523.25, 659.25, 783.99].forEach((f, i) => note(f, t0 + i * 0.12, 0.25, 'triangle', vol * 0.28))
        note(1046.5, t0 + 0.38, 0.6, 'triangle', vol * 0.3)
        break
      default:
        note(880, t0, 0.4, 'sine', vol * 0.3)
    }
  } catch (e) { console.log('tone failed', e) }
}
const playUrl = (url, vol) => {
  try {
    const audio = new Audio(url)
    audio.volume = Math.max(0, Math.min(1, vol))
    audio.play().catch(() => { playTone('chime', vol) })
  } catch (_) { playTone('chime', vol) }
}
const playCat = (conf) => {
  if (!conf) return
  const vol = volOf(conf.volume)
  if (conf.sound === 'file' && conf.file) { playUrl(conf.file, vol); return }
  if (conf.sound === 'url' && conf.url) { playUrl(conf.url, vol); return }
  if (conf.sound === 'none' || conf.sound === 'file' || conf.sound === 'url') return
  playTone(conf.sound || 'chime', vol)
}

const showNotification = (title, body) => {
  if (!('Notification' in window)) return 'unsupported'
  const fire = () => {
    try {
      new Notification(String(title), { body: String(body || '') })
      return 'granted'
    } catch (_) { return 'error' }
  }
  if (Notification.permission === 'granted') return fire()
  if (Notification.permission === 'denied') return 'denied'
  Notification.requestPermission().then((p) => { if (p === 'granted') fire() }).catch(() => {})
  return 'requested'
}

// Packaged-shell detection: Electron / Tauri renderers have no browser address
// bar and may hard-deny the HTML5 Notification permission (e.g. deepseek-harness-desktop).
const IS_ELECTRON = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent)
const IS_TAURI = typeof window !== 'undefined' && !!(window.__TAURI__ || window.__TAURI_INTERNALS__)
const IS_PACKAGED = IS_ELECTRON || IS_TAURI
const NOTIF_LABEL = IS_PACKAGED ? '系统通知' : '浏览器通知'

// Native OS notification via the host process (node-notifier). Used when running
// inside a packaged shell, where the renderer's HTML5 Notification is denied —
// the host shows a real out-of-app system notification instead.
const nativeNotify = (title, body) => {
  try {
    const url = '/dsh-notification-center/notify?title=' + encodeURIComponent(title || '') + '&body=' + encodeURIComponent(body || '')
    fetch(url).catch(() => {})
    return 'native'
  } catch (_) { return 'error' }
}

// Open the shell's settings panel and navigate to our "通知中心" section.
// The shell keeps the open/active section as component-local state with no
// public API, so this drives the DOM: click the settings trigger, then the nav cell.
const openFullSettings = () => {
  try {
    const trigger = document.querySelector('button[aria-haspopup="dialog"][aria-expanded]')
    if (trigger && trigger.getAttribute('aria-expanded') === 'false') trigger.click()
    setTimeout(() => {
      try {
        const dialog = document.querySelector('[role="dialog"]')
        const scope = dialog || document
        const els = scope.querySelectorAll('span, div, a, button, li')
        for (const el of els) {
          if (String(el.textContent || '').trim() !== '通知中心') continue
          if (el.closest('.dsh-cn-set, .dsh-cn-menu, .dsh-cn-wrap')) continue
          let cell = el
          for (let i = 0; i < 6 && cell; i++) {
            const tag = cell.tagName
            if (tag === 'BUTTON' || tag === 'A' || cell.getAttribute('role') === 'button') {
              cell.click()
              return
            }
            cell = cell.parentElement
          }
        }
      } catch (_) { /* ignore */ }
    }, 60)
  } catch (_) { /* ignore */ }
}

const KIND_LABEL = { turn: '对话', subagent: '子任务', workflow: 'Workflow', job: '后台任务', approval: '批准', test: '测试' }
const stopKeyOf = (item) => {
  if (!item || item.kind !== 'turn') return null
  let k = item.reason || 'other'
  if (k === 'aborted') k = item.abortCause === 'user' || !item.abortCause ? 'manual' : 'other'
  if (k === 'interrupted') k = 'manual'
  if (k !== 'completed' && k !== 'error' && k !== 'max-tokens' && k !== 'blocked' && k !== 'other' && k !== 'manual') k = 'other'
  return k
}
const categoryOf = (item) => {
  if (item.kind !== 'turn') return item.kind
  const sk = stopKeyOf(item)
  return sk === 'completed' ? 'turn' : (sk || 'other')
}
const handleItem = (item) => {
  if (!item) return
  const key = categoryOf(item)
  const conf = settings.catConf && settings.catConf[key]
  // Always record into the recent-events list, regardless of notify/sound/cooldown.
  history.push({ kind: item.kind, title: item.title, body: item.body, at: item.at || Date.now() })
  if (history.length > 20) history.shift()
  if (item.kind !== 'test') {
    if (!conf || (conf.notify === false && conf.soundOn === false)) return
  }
  // Cooldown only guards completion-style events (对话/子任务/Workflow/后台任务).
  // Stop reasons (手动/报错/超长/阻塞/其他) and approval are deliberate, meaningful
  // events and always notify — a manual stop right after a completion must not be
  // silently dropped by the cooldown.
  const COOLDOWN_EXEMPT = ['approval', 'test', 'error', 'max-tokens', 'blocked', 'other', 'manual']
  if (COOLDOWN_EXEMPT.indexOf(key) === -1) {
    const now = Date.now()
    if (now - lastNotifyAt < (Number(settings.cooldownMs) || 0)) return
  }
  lastNotifyAt = Date.now()
  if (settings.notif && (!conf || conf.notify !== false)) {
    if (IS_PACKAGED) nativeNotify(item.title, item.body)
    else showNotification(item.title, item.body)
  }
  if (settings.sound && (!conf || conf.soundOn !== false)) {
    if (conf) playCat(conf)
    else playTone('chime', 1)
  }
}

const POLL_URL = '/dsh-notification-center/poll'
const poll = async () => {
  if (polling) return
  polling = true
  try {
    const url = POLL_URL + '?session=' + encodeURIComponent(sessionId) + '&after=' + lastId
    const res = await fetch(url)
    const data = await res.json()
    if (data && Array.isArray(data.items) && data.items.length) {
      if (synced) data.items.forEach(handleItem)
      if (typeof data.lastId === 'number') lastId = data.lastId
    }
  } catch (e) { /* host endpoint not ready yet */ }
  polling = false
  synced = true
}

function apply(ctx) {
  const stopTimer = ctx.interval(poll, 1500)
  poll()

  const unlockOnce = () => {
    ensureAudio()
    if (settings.notif && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(() => {}).catch(() => {})
    }
  }
  ctx.effect(() => {
    document.addEventListener('click', unlockOnce, { once: true, capture: true })
    return () => document.removeEventListener('click', unlockOnce, { capture: true })
  })

  // Settings nav icon: the shell hardcodes a gear for unknown section ids.
  // Find the nav entry by label text '通知' inside the settings dialog and
  // insert a stroke bell; runs synchronously in a MutationObserver (no flash).
  const BELL_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>'
  const hiddenSvgs = new Set()
  const patchNavIcon = () => {
    try {
      const dialog = document.querySelector('[role="dialog"]')
      const scope = dialog || document
      const all = scope.querySelectorAll('span, div, a, button, li')
      for (const el of all) {
        if (el.children.length > 0) continue
        if (String(el.textContent || '').trim() !== '通知中心') continue
        if (el.closest('.dsh-cn-set, .dsh-cn-menu, .dsh-cn-wrap')) continue
        let cell = el
        for (let i = 0; i < 8 && cell; i++) {
          const svg = cell.querySelector('svg')
          if (svg) {
            if (svg.style.display !== 'none') {
              svg.style.display = 'none'
              hiddenSvgs.add(svg)
            }
            break
          }
          cell = cell.parentElement
        }
        if (!el.previousElementSibling || !el.previousElementSibling.classList || !el.previousElementSibling.classList.contains('dsh-cn-navbell')) {
          const bell = document.createElement('span')
          bell.className = 'dsh-cn-navbell'
          bell.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;line-height:0;'
          bell.innerHTML = BELL_SVG
          el.parentNode.insertBefore(bell, el)
        }
      }
    } catch (_) { /* ignore */ }
  }
  const restoreNavIcons = () => {
    try {
      for (const bell of document.querySelectorAll('.dsh-cn-navbell')) bell.remove()
      for (const s of hiddenSvgs) s.style.display = ''
    } catch (_) { /* ignore */ }
    hiddenSvgs.clear()
  }
  ctx.effect(() => {
    patchNavIcon()
    let observer = null
    try {
      observer = new MutationObserver(() => { patchNavIcon() })
      observer.observe(document.body, { childList: true, subtree: true })
    } catch (_) { /* observer unavailable */ }
    const stopInterval = ctx.interval(patchNavIcon, 1000)
    return () => {
      if (observer) observer.disconnect()
      stopInterval()
      restoreNavIcons()
    }
  })

  function Toggle(props) {
    return React.createElement('button', {
      className: 'dsh-cn-toggle' + (props.on ? ' on' : ''),
      'aria-label': props.label || '',
      title: props.label || '',
      onClick: (e) => { e.stopPropagation(); props.onChange(!props.on) }
    })
  }
  function BellIcon(props) {
    const size = props && props.size ? props.size : 16
    return React.createElement('svg', {
      width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round'
    },
      React.createElement('path', { d: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9' }),
      React.createElement('path', { d: 'M13.73 21a2 2 0 0 1-3.46 0' })
    )
  }
  function ChevronIcon(props) {
    return React.createElement('svg', {
      width: props.size || 14, height: props.size || 14, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round'
    },
      React.createElement('path', { d: 'm6 9 6 6 6-6' })
    )
  }
  function DSelect(props) {
    const [open, setOpen] = React.useState(false)
    const [wrapEl, setWrapEl] = React.useState(null)
    React.useEffect(() => {
      if (!open) return
      const onDoc = (e) => {
        const t = e && e.target
        if (t && t.closest && t.closest('.dsh-cn-ds')) return
        setOpen(false)
      }
      const onKey = (e) => {
        if (e.key === 'Escape') setOpen(false)
      }
      document.addEventListener('click', onDoc)
      document.addEventListener('keydown', onKey)
      return () => {
        document.removeEventListener('click', onDoc)
        document.removeEventListener('keydown', onKey)
      }
    }, [open])
    React.useEffect(() => {
      if (!open || !wrapEl) return
      try {
        const menu = wrapEl.querySelector('.dsh-cn-ds-menu')
        const sel = wrapEl.querySelector('.dsh-cn-ds-item.sel')
        if (menu && sel) {
          const target = sel.offsetTop - (menu.clientHeight - sel.clientHeight) / 2
          menu.scrollTop = Math.max(0, Math.min(target, menu.scrollHeight - menu.clientHeight))
        }
      } catch (_) { /* ignore */ }
    }, [open, wrapEl, props.value])
    const opts = props.options || []
    const cur = opts.find((o) => o[0] === props.value) || opts[0]
    return React.createElement('div', { className: 'dsh-cn-ds' + (open ? ' open' : '') },
      React.createElement('button', {
        className: 'dsh-cn-ds-btn',
        title: props.title || '',
        onClick: (e) => {
          e.stopPropagation()
          setWrapEl(e.currentTarget.parentElement)
          setOpen((v) => !v)
        }
      },
        React.createElement('span', { className: 'dsh-cn-ds-label' }, cur ? cur[1] : ''),
        React.createElement('span', { className: 'dsh-cn-ds-chevron' }, React.createElement(ChevronIcon, { size: 12 }))
      ),
      open && React.createElement('div', { className: 'dsh-cn-ds-menu' },
        opts.map((o) => React.createElement('button', {
          key: o[0],
          className: 'dsh-cn-ds-item' + (o[0] === props.value ? ' sel' : ''),
          onClick: (e) => { e.stopPropagation(); setOpen(false); props.onChange(o[0]) }
        }, o[1]))
      )
    )
  }
  const SOUND_OPTIONS = [
    ['chime', '三连音'], ['ding', '叮咚'], ['pop', '清脆弹响'], ['soft', '柔和'], ['beep', '电子哔声'], ['ping', '提示叮'], ['success', '成功音'], ['error', '错误音'], ['whoosh', '嗖声'], ['marimba', '马林巴'], ['twinkle', '闪烁音'], ['alarm', '闹钟'], ['bell', '铃铛'], ['bubble', '气泡'], ['coin', '金币'], ['harp', '竖琴'], ['horn', '号角'], ['laser', '激光'], ['melody', '旋律'], ['piano', '钢琴'], ['tada', '欢呼'], ['none', '静音'], ['file', '自定义文件'], ['url', '自定义 URL']
  ]
  const SOUND_LABEL = { chime: '三连音', ding: '叮咚', pop: '清脆弹响', soft: '柔和', beep: '电子哔声', ping: '提示叮', success: '成功音', error: '错误音', whoosh: '嗖声', marimba: '马林巴', twinkle: '闪烁音', alarm: '闹钟', bell: '铃铛', bubble: '气泡', coin: '金币', harp: '竖琴', horn: '号角', laser: '激光', melody: '旋律', piano: '钢琴', tada: '欢呼', none: '静音', file: '自定义文件', url: '自定义 URL' }
  const soundSummary = (conf) => {
    if (!conf) return ''
    if (conf.sound === 'file') return conf.fileName ? '文件: ' + conf.fileName : '自定义文件'
    if (conf.sound === 'url') return conf.url ? 'URL 音效' : '自定义 URL'
    return SOUND_LABEL[conf.sound] || '三连音'
  }

  function NotifyBell() {
    const [, force] = React.useState(0)
    const [testCd, setTestCd] = React.useState(0)
    const rerender = () => force((x) => x + 1)
    React.useEffect(() => subscribeSettings(rerender), [])
    React.useEffect(() => {
      if (testCd <= 0) return
      const stop = ctx.interval(() => setTestCd((c) => c - 1), 1000)
      return stop
    }, [testCd])
    React.useEffect(() => {
      if (!state.open) return
      const onDoc = (e) => {
        const t = e && e.target
        if (t && t.closest && t.closest('.dsh-cn-wrap')) return
        state.open = false
        rerender()
      }
      const onKey = (e) => {
        if (e.key === 'Escape') { state.open = false; rerender() }
      }
      document.addEventListener('click', onDoc)
      document.addEventListener('keydown', onKey)
      return () => {
        document.removeEventListener('click', onDoc)
        document.removeEventListener('keydown', onKey)
      }
    }, [state.open])
    const setStatus = (s) => { state.status = s; rerender() }
    const grant = () => {
      if (!('Notification' in window)) { setStatus(IS_PACKAGED ? '当前环境不支持网页系统通知' : '当前浏览器不支持系统通知'); return }
      Notification.requestPermission().then((p) => {
        if (p === 'granted') setStatus('✓ 通知权限已开启')
        else if (p === 'denied') setStatus(IS_PACKAGED ? '✗ 该桌面应用禁用了网页通知：请在系统设置/应用设置中开启通知权限' : '✗ 已被拒绝，请点击浏览器地址栏左侧图标手动允许')
        else setStatus('未授权')
      }).catch(() => { setStatus('授权请求失败') })
    }
    const test = () => {
      if (testCd > 0) return
      setTestCd(2)
      if (settings.sound) {
        const conf = settings.catConf && settings.catConf.turn
        if (conf) playCat(conf)
        else playTone('chime', 1)
      }
      let status = 'off'
      if (settings.notif) {
        status = IS_PACKAGED ? nativeNotify('通知中心测试', '来自通知插件的测试') : showNotification('通知中心测试', '来自通知插件的测试')
        history.push({ kind: 'test', title: '通知中心测试', body: '手动测试', at: Date.now() })
      }
      const map = {
        granted: '✓ 通知已发送，音效已播放',
        native: '✓ 系统通知已发送（应用外），音效已播放',
        requested: '已请求通知权限，请在浏览器弹窗中点击允许；音效已播放',
        denied: IS_PACKAGED ? '✗ 系统通知被应用禁用（音效已播放）：请在该桌面应用的设置里开启通知权限' : '✗ 通知被浏览器拒绝（音效已播放）；请点击上方「授权」或修改站点设置',
        unsupported: '当前环境不支持系统通知（音效已播放）',
        error: '通知发送失败（音效已播放）',
        off: '通知已关闭（音效已播放）'
      }
      setStatus(map[status] || status)
    }
    const permText = !('Notification' in window) ? '不支持'
      : Notification.permission === 'granted' ? '已开启'
      : Notification.permission === 'denied' ? '已拒绝'
      : '未授权'
    const rows = []
    rows.push(React.createElement('div', { key: 't', className: 'dsh-cn-menu-title' }, '通知中心'))
    rows.push(React.createElement('div', { key: 'r1', className: 'dsh-cn-row' },
      React.createElement('span', null, NOTIF_LABEL),
      React.createElement(Toggle, { on: settings.notif, label: NOTIF_LABEL + '开关', onChange: (v) => { settings.notif = v; saveSettings(); rerender() } })
    ))
    rows.push(React.createElement('div', { key: 'r2', className: 'dsh-cn-row' },
      React.createElement('span', null, '完成音效'),
      React.createElement(Toggle, { on: settings.sound, label: '完成音效开关', onChange: (v) => { settings.sound = v; saveSettings(); rerender() } })
    ))
    if (!IS_PACKAGED) {
      rows.push(React.createElement('div', { key: 'r3', className: 'dsh-cn-row' },
        React.createElement('span', null, '通知权限: ' + permText),
        React.createElement('button', { className: 'dsh-cn-mini', onClick: (e) => { e.stopPropagation(); grant() } }, '授权')
      ))
    }
    rows.push(React.createElement('div', { key: 'r4', className: 'dsh-cn-row' },
      React.createElement('span', null, '测试'),
      React.createElement('button', {
        className: 'dsh-cn-mini primary',
        disabled: testCd > 0,
        onClick: (e) => { e.stopPropagation(); test() }
      }, testCd > 0 ? '播放 (' + testCd + 's)' : '播放')
    ))
    rows.push(React.createElement('div', { key: 'r5', className: 'dsh-cn-row' },
      React.createElement('button', {
        className: 'dsh-cn-mini primary',
        style: { flex: 1 },
        onClick: (e) => { e.stopPropagation(); state.open = false; rerender(); openFullSettings() }
      }, '完整设置')
    ))
    if (state.status) {
      const cls = state.status.indexOf('✗') === 0 ? 'err' : state.status.indexOf('✓') === 0 ? 'ok' : 'warn'
      rows.push(React.createElement('div', { key: 'st', className: 'dsh-cn-status ' + cls }, state.status))
    }
    if (settings.showBell === false) return null
    return React.createElement('div', { className: 'dsh-cn-wrap' },
      React.createElement('button', {
        className: 'dsh-cn-bell',
        title: '通知设置',
        'aria-label': '通知设置',
        onClick: (e) => { e.stopPropagation(); state.open = !state.open; rerender() }
      }, React.createElement(BellIcon, null)),
      state.open && React.createElement('div', { className: 'dsh-cn-menu' }, rows)
    )
  }

  function Row(props) {
    return React.createElement('div', { className: 'dsh-cn-set-row' },
      React.createElement('div', { className: 'dsh-cn-set-label' },
        props.label,
        props.hint ? React.createElement('div', { className: 'dsh-cn-set-hint' }, props.hint) : null
      ),
      React.createElement('div', { className: 'dsh-cn-set-ctl' }, props.children)
    )
  }
  function timeAgo(ts) {
    const diff = Date.now() - (Number(ts) || 0)
    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
    return Math.floor(diff / 3600000) + ' 小时前'
  }
  function CatRow(props) {
    const [open, setOpen] = React.useState(false)
    const [msg, setMsg] = React.useState('')
    const { k, label, hint, conf, onChange } = props
    const apply = (patch) => onChange(k, Object.assign({}, conf, patch))
    const handleFile = (e) => {
      const file = e && e.target && e.target.files && e.target.files[0]
      if (e && e.target) e.target.value = ''
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = String(reader.result || '')
        const next = Object.assign({}, conf, { file: dataUrl, fileName: file.name, sound: 'file' })
        const ok = onChange(k, next)
        setMsg(ok ? '✓ 已保存音效文件：' + file.name : '✗ 文件过大，无法保存（建议小于 3MB）')
      }
      reader.onerror = () => setMsg('✗ 读取文件失败')
      reader.readAsDataURL(file)
    }
    const clearFile = () => { apply({ file: '', fileName: '', sound: 'chime' }); setMsg('') }
    const preview = () => { playCat(conf) }
    const vol = volOf(conf.volume)
    const masterOn = !!(conf.notify || conf.soundOn)
    return React.createElement('div', { className: 'dsh-cn-cat' },
      React.createElement('div', {
        className: 'dsh-cn-cat-head',
        role: 'button',
        'aria-expanded': open,
        title: open ? '收起设置' : '展开自定义音效',
        onClick: () => setOpen(!open)
      },
        React.createElement('div', { className: 'dsh-cn-set-label' },
          label,
          hint ? React.createElement('div', { className: 'dsh-cn-set-hint' }, hint) : null
        ),
        React.createElement('div', { className: 'dsh-cn-set-ctl' },
          React.createElement('span', { className: 'dsh-cn-cat-summary' }, '音效: ' + soundSummary(conf) + ' · ' + Math.round(vol * 100) + '%'),
          React.createElement('span', { className: 'dsh-cn-caption' }, '总开关'),
          React.createElement('span', { className: 'dsh-cn-cat-chevron' + (open ? ' open' : '') },
            React.createElement(ChevronIcon, null)
          ),
          React.createElement(Toggle, { on: masterOn, label: label + ' 总开关', onChange: (v) => apply({ notify: v, soundOn: v }) })
        )
      ),
      open && React.createElement('div', { className: 'dsh-cn-cat-body' },
        React.createElement('div', { className: 'dsh-cn-set-row' },
          React.createElement('div', { className: 'dsh-cn-set-label' }, NOTIF_LABEL + ' / 音效'),
          React.createElement('div', { className: 'dsh-cn-set-ctl' },
            React.createElement('span', { className: 'dsh-cn-caption' }, NOTIF_LABEL),
            React.createElement(Toggle, { on: !!conf.notify, label: label + ' ' + NOTIF_LABEL + '开关', onChange: (v) => apply({ notify: v }) }),
            React.createElement('span', { className: 'dsh-cn-caption', style: { marginLeft: 6 } }, '音效'),
            React.createElement(Toggle, { on: !!conf.soundOn, label: label + ' 音效开关', onChange: (v) => apply({ soundOn: v }) })
          )
        ),
        React.createElement('div', { className: 'dsh-cn-set-row' },
          React.createElement('div', { className: 'dsh-cn-set-label' }, '音效类型'),
          React.createElement(DSelect, {
            value: conf.sound || 'chime',
            options: SOUND_OPTIONS,
            title: '音效类型',
            onChange: (v) => {
              apply({ sound: v })
              if (v !== 'file' && v !== 'url' && v !== 'none') playTone(v, volOf(conf.volume))
            }
          })
        ),
        conf.sound === 'file' && React.createElement('div', { className: 'dsh-cn-set-row' },
          React.createElement('div', { className: 'dsh-cn-set-label' }, '音频文件', React.createElement('div', { className: 'dsh-cn-set-hint' }, conf.fileName ? '已选择: ' + conf.fileName : '选择本地音频（mp3/wav/ogg），自动保存到浏览器')),
          React.createElement('div', { className: 'dsh-cn-set-ctl' },
            React.createElement('label', { className: 'dsh-cn-mini', style: { cursor: 'pointer' } },
              conf.fileName ? '更换' : '选择文件',
              React.createElement('input', { type: 'file', accept: 'audio/*', style: { display: 'none' }, onChange: handleFile })
            ),
            conf.fileName ? React.createElement('button', { className: 'dsh-cn-mini', onClick: clearFile }, '清除') : null
          )
        ),
        conf.sound === 'url' && React.createElement('div', { className: 'dsh-cn-set-row' },
          React.createElement('div', { className: 'dsh-cn-set-label' }, '音频 URL', React.createElement('div', { className: 'dsh-cn-set-hint' }, '音频直链（mp3/wav/ogg）')),
          React.createElement('input', {
            className: 'dsh-cn-input', type: 'text', placeholder: 'https://example.com/sound.mp3',
            value: conf.url || '',
            onChange: (e) => apply({ url: e.target.value })
          })
        ),
        React.createElement('div', { className: 'dsh-cn-set-row' },
          React.createElement('div', { className: 'dsh-cn-set-label' }, '音量'),
          React.createElement('div', { className: 'dsh-cn-set-ctl' },
            React.createElement('input', {
              type: 'range', min: 0, max: 100, className: 'dsh-cn-range',
              value: Math.round(vol * 100),
              onChange: (e) => apply({ volume: Number(e.target.value) / 100 })
            }),
            React.createElement('span', { className: 'dsh-cn-caption' }, Math.round(vol * 100) + '%'),
            React.createElement('button', { className: 'dsh-cn-mini primary', onClick: preview }, '试听')
          )
        ),
        msg ? React.createElement('div', { className: 'dsh-cn-status ' + (msg.indexOf('✗') === 0 ? 'err' : 'ok') }, msg) : null
      )
    )
  }
  function NotifySettingsPage() {
    const [, force] = React.useState(0)
    const [testMsg, setTestMsg] = React.useState('')
    const [testCd, setTestCd] = React.useState(0)
    const rerender = () => force((x) => x + 1)
    React.useEffect(() => {
      if (testCd <= 0) return
      const stop = ctx.interval(() => setTestCd((c) => c - 1), 1000)
      return stop
    }, [testCd])
    const set = (patch) => { Object.assign(settings, patch); saveSettings(); rerender() }
    const catChange = (k, next) => {
      settings.catConf[k] = next
      const ok = saveSettings()
      rerender()
      return ok
    }
    const reset = () => {
      Object.assign(settings, JSON.parse(JSON.stringify(DEFAULTS)))
      saveSettings()
      rerender()
    }
    const grant = () => {
      if (!('Notification' in window)) return
      Notification.requestPermission().then(() => rerender()).catch(() => {})
    }
    const testNotif = () => {
      if (testCd > 0) return
      setTestCd(2)
      if (settings.sound) {
        const conf = settings.catConf && settings.catConf.turn
        if (conf) playCat(conf)
        else playTone('chime', 1)
      }
      let status = 'off'
      if (settings.notif) {
        status = IS_PACKAGED ? nativeNotify('通知中心测试', '来自通知插件的测试通知') : showNotification('通知中心测试', '来自通知插件的测试通知')
        history.push({ kind: 'test', title: '通知中心测试', body: '手动测试', at: Date.now() })
        if (history.length > 20) history.shift()
      }
      const map = {
        granted: '✓ 通知已发送',
        native: '✓ 系统通知已发送（应用外）',
        requested: '已请求权限，请在浏览器弹窗中允许',
        denied: IS_PACKAGED ? '✗ 系统通知被应用禁用：请在该桌面应用的设置里开启通知权限' : '✗ 通知被浏览器拒绝，点击「授权」或修改站点设置',
        unsupported: '当前环境不支持系统通知',
        error: '通知发送失败',
        off: '「' + NOTIF_LABEL + '」总开关已关闭'
      }
      setTestMsg(map[status] || status)
      rerender()
    }
    const permText = !('Notification' in window) ? '不支持'
      : Notification.permission === 'granted' ? '已开启'
      : Notification.permission === 'denied' ? (IS_PACKAGED ? '已禁用' : '已拒绝')
      : '未授权'
    const cooldownOptions = [
      [0, '无'], [2000, '2 秒'], [5000, '5 秒'], [10000, '10 秒'], [30000, '30 秒']
    ]
    const kindRows = [
      ['turn', '对话完成', '对话自然生成完成'],
      ['subagent', '子任务完成', '子代理结束'],
      ['workflow', 'Workflow 完成', '多代理工作流结束'],
      ['job', '后台任务完成', '后台命令结束'],
      ['approval', '等待批准', '模型请求权限/批准时，需要你操作']
    ]
    const stopRows = [
      ['error', '报错停止', '生成过程中出错'],
      ['max-tokens', '超长截断', '达到最大长度限制'],
      ['blocked', '被阻塞', '系统拦截未开始生成'],
      ['other', '其他原因停止', '非手动取消的其他停止'],
      ['manual', '手动停止/打断', '你点击停止/打断生成（默认不通知）']
    ]
    return React.createElement('div', { className: 'dsh-cn-set' },
      React.createElement('div', { className: 'dsh-cn-set-head' },
        React.createElement('span', { className: 'dsh-cn-set-head-icon' }, React.createElement(BellIcon, { size: 18 })),
        React.createElement('div', null,
          React.createElement('div', { className: 'dsh-cn-set-title' }, '通知中心'),
          React.createElement('div', { className: 'dsh-cn-set-sub' }, '每个事件可独立配置通知开关与音效')
        )
      ),
      React.createElement('div', { className: 'dsh-cn-set-group' },
        React.createElement('div', { className: 'dsh-cn-set-group-title' }, '总开关'),
        React.createElement(Row, { label: NOTIF_LABEL, hint: '总开关，需要授权' },
          React.createElement(Toggle, { on: settings.notif, label: NOTIF_LABEL, onChange: (v) => set({ notif: v }) })
        ),
        React.createElement(Row, { label: '完成音效', hint: '总开关' },
          React.createElement(Toggle, { on: settings.sound, label: '完成音效', onChange: (v) => set({ sound: v }) })
        ),
        !IS_PACKAGED && React.createElement(Row, { label: '通知权限', hint: '当前: ' + permText },
          React.createElement('button', { className: 'dsh-cn-mini', onClick: grant }, '授权')
        ),
        React.createElement(Row, { label: NOTIF_LABEL + '测试', hint: testMsg || '发送一条测试通知并播放对话音效' },
          React.createElement('button', {
            className: 'dsh-cn-mini primary',
            disabled: testCd > 0,
            onClick: testNotif
          }, testCd > 0 ? '测试 (' + testCd + 's)' : '测试')
        ),
        React.createElement(Row, { label: '通知冷却间隔', hint: '防止连续完成事件轰炸（等待批准不受限制）' },
          React.createElement(DSelect, { value: Number(settings.cooldownMs) || 0, options: cooldownOptions, title: '通知冷却间隔', onChange: (v) => set({ cooldownMs: Number(v) }) })
        )
      ),
      React.createElement('div', { className: 'dsh-cn-set-group' },
        React.createElement('div', { className: 'dsh-cn-set-group-title' }, '事件'),
        kindRows.map(([k, label, hint]) => React.createElement(CatRow, {
          key: k, k: k, label: label, hint: hint,
          conf: settings.catConf[k],
          onChange: catChange
        }))
      ),
      React.createElement('div', { className: 'dsh-cn-set-group' },
        React.createElement('div', { className: 'dsh-cn-set-group-title' }, '停止原因'),
        stopRows.map(([k, label, hint]) => React.createElement(CatRow, {
          key: k, k: k, label: label, hint: hint,
          conf: settings.catConf[k],
          onChange: catChange
        }))
      ),
      React.createElement('div', { className: 'dsh-cn-set-group' },
        React.createElement('div', { className: 'dsh-cn-set-group-title' }, '界面'),
        React.createElement(Row, { label: '输入栏显示铃铛', hint: '关闭后仅保留系统通知与音效' },
          React.createElement(Toggle, { on: settings.showBell, label: '输入栏铃铛', onChange: (v) => set({ showBell: v }) })
        ),
        React.createElement(Row, { label: '恢复默认设置' },
          React.createElement('button', { className: 'dsh-cn-mini', onClick: reset }, '重置')
        )
      ),
      React.createElement('div', { className: 'dsh-cn-set-group' },
        React.createElement('div', { className: 'dsh-cn-set-group-title' }, '最近事件'),
        history.length === 0
          ? React.createElement('div', { className: 'dsh-cn-empty' }, '暂无记录')
          : React.createElement('div', { className: 'dsh-cn-history' },
              history.slice().reverse().map((h, i) => React.createElement('div', { key: i, className: 'dsh-cn-history-item' },
                React.createElement('span', { className: 't' }, timeAgo(h.at)),
                React.createElement('span', { className: 'k' }, KIND_LABEL[h.kind] || h.kind),
                React.createElement('span', null, h.title + (h.body ? ' · ' + h.body : ''))
              ))
            )
      )
    )
  }

  const slots = ctx.get('slots')
  if (slots !== undefined) {
    slots.inject('conversation.input.left', () => slots.register(
      { name: 'conversation.input.left', id: 'completion-notify', order: 0, label: '通知中心' },
      (props) => {
        const sid = props && props.sessionId ? String(props.sessionId) : ''
        if (sid) sessionId = sid
        return React.createElement(NotifyBell, null)
      }
    ))
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'completion-notify', order: 30, label: '通知中心' },
      () => React.createElement(NotifySettingsPage, null)
    ))
  }

  // package styles (self-contained style tag)
  const cssId = 'dsh-completion-notify-css'
  ctx.effect(() => {
    let tag = document.getElementById(cssId)
    if (!tag) {
      tag = document.createElement('style')
      tag.id = cssId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }
    return () => {
      if (tag && tag.parentNode) tag.parentNode.removeChild(tag)
    }
  })
}

const CSS = [
  '.dsh-cn-wrap{position:relative;display:inline-flex;align-items:center;margin-right:2px;}',
  '.dsh-cn-bell{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;transition:background .12s,color .12s;}',
  '.dsh-cn-bell:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.1));color:var(--dsw-alias-label-primary,#222);}',
  '.dsh-cn-menu{position:absolute;bottom:calc(100% + 8px);left:0;z-index:60;min-width:236px;padding:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.12));display:flex;flex-direction:column;gap:1px;font-family:inherit;}',
  '.dsh-cn-menu-title{padding:6px 8px 4px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#222);}',
  '.dsh-cn-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 8px;border-radius:8px;color:var(--dsw-alias-label-primary,#222);font-size:13px;white-space:nowrap;}',
  '.dsh-cn-row:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08));}',
  '.dsh-cn-caption{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#999);}',
  '.dsh-cn-status{padding:4px 8px 6px;font-size:12px;color:var(--dsw-alias-label-secondary,#888);white-space:normal;line-height:1.5;}',
  '.dsh-cn-status.ok{color:var(--dsw-alias-state-success-primary,#2e9e5b);}',
  '.dsh-cn-status.warn{color:var(--dsw-alias-state-warn-primary,#c07f1a);}',
  '.dsh-cn-status.err{color:var(--dsw-alias-state-error-primary,#d64545);}',
  '.dsh-cn-toggle{position:relative;width:32px;height:18px;border:none;border-radius:10px;background:var(--dsw-alias-border-l2,#c9c9c9);box-shadow:inset 0 0 0 1px rgba(128,128,128,.28);cursor:pointer;padding:0;flex:none;transition:background .15s;}',
  '.dsh-cn-toggle::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.35);transition:left .15s;}',
  '.dsh-cn-toggle.on{background:#3b82f6;box-shadow:inset 0 0 0 1px rgba(0,0,0,.18);}',
  '.dsh-cn-toggle.on::after{left:16px;}',
  '.dsh-cn-mini{padding:3px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06));color:var(--dsw-alias-label-primary,#222);cursor:pointer;font-size:13px;line-height:1.5;flex:none;}',
  '.dsh-cn-mini:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14));}',
  '.dsh-cn-mini.primary{background:#3b82f6;border-color:transparent;color:#fff;}',
  '.dsh-cn-mini.primary:hover{opacity:.9;}',
  '.dsh-cn-mini:disabled{opacity:.5;cursor:default;}',
  '.dsh-cn-ds{position:relative;display:inline-flex;flex:none;align-items:center;}',
  '.dsh-cn-ds-btn{display:inline-flex;align-items:center;justify-content:space-between;gap:6px;min-width:112px;max-width:200px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06));color:var(--dsw-alias-label-primary,#222);cursor:pointer;font-size:13px;line-height:1.5;}',
  '.dsh-cn-ds-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14));}',
  '.dsh-cn-ds-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
  '.dsh-cn-ds-chevron{display:inline-flex;align-items:center;color:var(--dsw-alias-label-secondary,#888);transition:transform .15s;flex:none;}',
  '.dsh-cn-ds.open .dsh-cn-ds-chevron{transform:rotate(180deg);}',
  '.dsh-cn-ds-menu{position:absolute;top:calc(100% + 4px);right:0;left:auto;min-width:148px;max-width:min(240px,100%);max-height:min(240px,60vh);overflow-y:auto;padding:4px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.12));display:flex;flex-direction:column;gap:1px;z-index:80;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2,#c9c9c9) transparent;}',
  '.dsh-cn-ds-menu::-webkit-scrollbar{width:6px;}',
  '.dsh-cn-ds-menu::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,#c9c9c9);border-radius:3px;}',
  '.dsh-cn-ds-item{display:flex;align-items:center;flex:none;max-width:100%;padding:5px 10px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#222);cursor:pointer;font-size:12px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
  '.dsh-cn-ds-item:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08));}',
  '.dsh-cn-ds-item.sel{color:#3b82f6;font-weight:600;}',
  '.dsh-cn-input{padding:0 12px;height:34px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));border-radius:8px;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.04));color:var(--dsw-alias-label-primary,#222);font-size:13px;line-height:1.5;width:220px;box-sizing:border-box;}',
  '.dsh-cn-range{-webkit-appearance:none;appearance:none;height:4px;border-radius:2px;background:var(--dsw-alias-border-l2,#c9c9c9);outline:none;cursor:pointer;width:100px;flex:none;}',
  '.dsh-cn-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;background:#3b82f6;cursor:pointer;box-shadow:0 0 0 2px rgba(255,255,255,.6);}',
  '.dsh-cn-range::-moz-range-thumb{width:14px;height:14px;border:none;border-radius:50%;background:#3b82f6;cursor:pointer;box-shadow:0 0 0 2px rgba(255,255,255,.6);}',
  '.dsh-cn-set{display:flex;flex-direction:column;gap:18px;padding:4px 2px;max-width:680px;font-family:inherit;}',
  '.dsh-cn-set-head{display:flex;align-items:center;gap:10px;}',
  '.dsh-cn-set-head-icon{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08));color:var(--dsw-alias-brand-primary,#3b82f6);flex:none;}',
  '.dsh-cn-set-title{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary,#222);}',
  '.dsh-cn-set-sub{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#999);margin-top:2px;}',
  '.dsh-cn-set-group{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));border-radius:12px;padding:4px;background:var(--dsw-alias-bg-base,transparent);}',
  '.dsh-cn-set-group-title{font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary,#222);padding:10px 10px 4px;}',
  '.dsh-cn-set-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 10px;border-radius:8px;}',
  '.dsh-cn-set-row:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.05));}',
  '.dsh-cn-set-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary,#222);display:flex;flex-direction:column;gap:2px;min-width:0;}',
  '.dsh-cn-set-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#999);}',
  '.dsh-cn-set-ctl{display:flex;align-items:center;gap:8px;flex:none;}',
  '.dsh-cn-cat{display:flex;flex-direction:column;}',
  '.dsh-cn-cat-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 10px;border-radius:8px;cursor:pointer;user-select:none;}',
  '.dsh-cn-cat-head:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.05));}',
  '.dsh-cn-cat-summary{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;}',
  '.dsh-cn-cat-chevron{display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary,#888);transition:transform .15s;flex:none;}',
  '.dsh-cn-cat-chevron.open{transform:rotate(180deg);}',
  '.dsh-cn-cat-body{display:flex;flex-direction:column;gap:2px;padding:6px 10px 8px 30px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));}',
  '.dsh-cn-history{display:flex;flex-direction:column;gap:2px;padding:2px 6px 8px 10px;max-height:240px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2,#c9c9c9) transparent;}',
  '.dsh-cn-history::-webkit-scrollbar{width:6px;}',
  '.dsh-cn-history::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,#c9c9c9);border-radius:3px;}',
  '.dsh-cn-history-item{display:flex;align-items:baseline;gap:8px;font-size:12px;color:var(--dsw-alias-label-primary,#222);padding:3px 0;}',
  '.dsh-cn-history-item .t{color:var(--dsw-alias-label-secondary,#888);flex:none;font-size:11px;}',
  '.dsh-cn-history-item .k{flex:none;color:var(--dsw-alias-brand-primary,#3b82f6);font-size:11px;}',
  '.dsh-cn-empty{font-size:12px;color:var(--dsw-alias-label-secondary,#888);padding:4px 10px 8px;}'
].join('')
