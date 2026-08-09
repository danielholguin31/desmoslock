/* DesmosLock admin console.

   Everything privileged here is enforced in Postgres, not in this file: roles,
   seat counts and school isolation all come from row-level security and
   security-definer RPCs. Hiding a button is a courtesy; the database is the
   actual boundary. */

const $ = (s) => document.querySelector(s)
const $$ = (s) => [...document.querySelectorAll(s)]

const sb = SupabaseSDK.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
})

const state = { user: null, school: null, members: [], invites: [], tests: [] }

/* ─────────────────────────────────────────────────────── helpers */

const show = (v) => {
  $('#view-auth').classList.toggle('on', v === 'auth')
  $('#view-onboard').classList.toggle('on', v === 'onboard')
  $('#view-shell').classList.toggle('on', v === 'shell')
}

function toast (msg, ms = 2800) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.remove('hidden')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.add('hidden'), ms)
}

function msg (sel, text, kind = 'err') {
  const el = $(sel)
  if (!el) return
  el.textContent = text || ''
  el.className = 'msg ' + kind + (text ? '' : ' hidden')
}

function confirmDialog (title, body, ok = 'Confirm') {
  return new Promise((resolve) => {
    $('#modal-title').textContent = title
    $('#modal-body').textContent = body
    $('#modal-yes').textContent = ok
    $('#modal').classList.remove('hidden')
    const done = (v) => {
      $('#modal').classList.add('hidden')
      $('#modal-yes').removeEventListener('click', yes)
      $('#modal-no').removeEventListener('click', no)
      resolve(v)
    }
    const yes = () => done(true)
    const no = () => done(false)
    $('#modal-yes').addEventListener('click', yes)
    $('#modal-no').addEventListener('click', no)
  })
}

const dateFmt = (d) => d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
const ago = (d) => {
  if (!d) return 'never'
  const s = Math.round((Date.now() - new Date(d)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return Math.round(s / 60) + 'm ago'
  if (s < 86400) return Math.round(s / 3600) + 'h ago'
  if (s < 2592000) return Math.round(s / 86400) + 'd ago'
  return dateFmt(d)
}

function friendly (e) {
  const m = String(e?.message || e || 'Something went wrong')
  if (/anonymous/i.test(m)) return 'Anonymous sign-ins are disabled for this project.'
  if (/email not confirmed/i.test(m)) return 'Confirm your email address first, or turn off "Confirm email" in Supabase → Authentication → Providers.'
  if (/invalid login credentials/i.test(m)) return 'Wrong email or password.'
  if (/already registered/i.test(m)) return 'An account with that email already exists — sign in instead.'
  if (/admins only/i.test(m)) return 'Only admins can do that.'
  if (/failed to fetch/i.test(m)) return 'Cannot reach the server. Check your connection.'
  return m
}

/* ───────────────────────────────────────────────────────── auth */

let authMode = 'login'

function setAuthMode (mode) {
  authMode = mode
  const s = mode === 'signup'
  $('#auth-h').textContent = s ? 'Create your account' : 'Admin console'
  $('#auth-sub').textContent = s
    ? 'For the person who manages the licence. Teachers sign in from the desktop app.'
    : "Sign in to manage your school's licence, teachers and tests."
  $('#auth-go').textContent = s ? 'Create account' : 'Sign in'
  $('#fld-name').classList.toggle('hidden', !s)
  $('#swap-label').textContent = s ? 'Already have an account?' : 'New here?'
  $('#auth-swap').textContent = s ? 'Sign in' : 'Create an account'
  $('#a-pass').setAttribute('autocomplete', s ? 'new-password' : 'current-password')
  msg('#auth-err', '')
  msg('#auth-ok', '')
}

$('#auth-swap').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'signup' : 'login'))

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const btn = $('#auth-go')
  btn.disabled = true
  msg('#auth-err', ''); msg('#auth-ok', '')

  const email = $('#a-email').value.trim()
  const password = $('#a-pass').value

  try {
    if (authMode === 'signup') {
      const { data, error } = await sb.auth.signUp({
        email, password, options: { data: { name: $('#a-name').value.trim() } }
      })
      if (error) throw error
      if (!data.session) {
        msg('#auth-ok', 'Account created. Confirm it from the email we just sent, then sign in.', 'ok')
        setAuthMode('login')
        return
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password })
      if (error) throw error
    }
    $('#a-pass').value = ''
    await boot()
  } catch (err) {
    msg('#auth-err', friendly(err))
  } finally {
    btn.disabled = false
  }
})

$('#sign-out').addEventListener('click', async () => { await sb.auth.signOut(); location.reload() })
$('#ob-out').addEventListener('click', async () => { await sb.auth.signOut(); location.reload() })
$('#ob-recheck').addEventListener('click', () => boot())

/* ────────────────────────────────────────────────── onboarding */

$('#ob-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const btn = $('#ob-go')
  btn.disabled = true
  msg('#ob-err', '')
  try {
    const { error } = await sb.rpc('create_school', {
      p_name: $('#ob-name').value.trim(),
      p_domain: $('#ob-domain').value.trim() || null
    })
    if (error) throw error
    await boot()
    toast('School created — you have a 30-day trial')
  } catch (err) {
    msg('#ob-err', friendly(err))
  } finally {
    btn.disabled = false
  }
})

/* ───────────────────────────────────────────────────── loading */

async function loadAll () {
  const { data: ov, error } = await sb.rpc('school_overview')
  if (error) throw error
  state.school = Array.isArray(ov) ? ov[0] : ov
  if (!state.school) return false

  const [members, invites, tests] = await Promise.all([
    sb.from('school_members').select('*').order('role'),
    sb.from('invites').select('*').is('accepted_at', null).order('created_at', { ascending: false }),
    sb.from('tests').select('id,title,join_code,locked,active,created_at,teacher_id').order('created_at', { ascending: false }).limit(200)
  ])
  state.members = members.data || []
  state.invites = invites.data || []
  state.tests = tests.data || []
  return true
}

/* ─────────────────────────────────────────────────── rendering */

function isAdmin () { return ['owner', 'admin'].includes(state.school?.my_role) }

function renderSide () {
  const s = state.school
  $('#ss-name').textContent = s.name
  $('#ss-status').textContent = s.status
  $('#ss-status').className = 'chip ' + s.status
  $('#ss-days').textContent = s.status === 'trial'
    ? (s.days_left >= 0 ? `${s.days_left} days left` : 'expired')
    : `renews ${dateFmt(s.term_end)}`

  const me = state.members.find(m => m.user_id === state.user.id)
  const name = me?.name || state.user.email.split('@')[0]
  $('#me-name').textContent = name
  $('#me-role').textContent = s.my_role
  $('#me-ava').textContent = name[0].toUpperCase()

  // Teachers do not get the billing or settings tabs.
  for (const tab of ['billing', 'settings']) {
    $(`.nav-item[data-tab="${tab}"]`).classList.toggle('hidden', !isAdmin())
  }
}

function renderOverview () {
  const s = state.school
  const used = s.seats_used || 0
  const total = s.seats_purchased || 0
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0

  $('#ov-sub').textContent = s.status === 'trial'
    ? `You are on a free trial with ${total} seats. Buy a licence whenever you are ready — nothing is lost when the trial ends.`
    : `Licence runs ${dateFmt(s.term_start)} to ${dateFmt(s.term_end)}.`

  $('#sc-used').textContent = PRICING.num(used)
  $('#sc-of').textContent = ` of ${PRICING.num(total)}`
  $('#sc-renew').textContent = dateFmt(s.term_end)

  const bar = $('#sc-bar')
  bar.style.width = pct + '%'
  bar.className = 'bar-fill' + (used > total ? ' over' : pct >= 80 ? ' warn' : '')

  $('#sc-note').textContent = used > total
    ? `You are ${PRICING.num(used - total)} over. Nothing stops working — we reconcile at renewal, or top up now at ${PRICING.money(s.price_per_seat, true)} per student.`
    : used === 0
      ? 'No students have sat a test yet. A student counts once per licence year, however many tests they sit.'
      : `${pct}% used. A student counts once per licence year, however many tests they sit.`

  const teachers = state.members.length
  $('#st-teachers').textContent = teachers
  $('#st-invites').textContent = state.invites.length
    ? `${state.invites.length} pending invite${state.invites.length === 1 ? '' : 's'}`
    : 'no pending invites'
  $('#st-tests').textContent = PRICING.num(s.tests || 0)
  $('#st-price').textContent = PRICING.money(s.price_per_seat, true)
  $('#st-annual').textContent = PRICING.money((s.price_per_seat || 0) * Math.max(used, 0))
  $('#st-annual-sub').textContent = `${PRICING.num(used)} students × ${PRICING.money(s.price_per_seat, true)}`

  const steps = [
    { done: true, html: '<b>School created.</b> You are the owner.' },
    { done: teachers > 1 || state.invites.length > 0, html: '<b>Invite your teachers.</b> They join by signing in with the address you invite.' },
    { done: (s.tests || 0) > 0, html: '<b>Run a test.</b> Teachers create one in the desktop app and read out the class code.' },
    { done: s.status === 'active', html: '<b>Buy a licence.</b> Request a quote when you know your student numbers.' }
  ]
  $('#ov-steps').innerHTML = steps.map(st => `<li class="${st.done ? 'done' : ''}">${st.html}</li>`).join('')
}

function renderMembers () {
  const el = $('#members')
  $('#mem-count').textContent = state.members.length
  if (!state.members.length) { el.innerHTML = '<div class="empty">Nobody yet.</div>'; return }

  el.innerHTML = ''
  for (const m of state.members) {
    const isMe = m.user_id === state.user.id
    const row = document.createElement('div')
    row.className = 'row'
    row.innerHTML = `
      <span class="ava"></span>
      <span class="who"><b></b><small></small></span>
      <span class="tag ${m.role}">${m.role}</span>
      <span class="meta">${m.tests_created} test${m.tests_created === 1 ? '' : 's'} · seen ${ago(m.last_sign_in_at)}</span>
      <span class="acts"></span>`
    row.querySelector('.ava').textContent = (m.name || m.email)[0].toUpperCase()
    row.querySelector('.who b').textContent = m.name + (isMe ? ' (you)' : '')
    row.querySelector('.who small').textContent = m.email

    if (isAdmin() && !isMe && m.role !== 'owner') {
      const acts = row.querySelector('.acts')
      const sel = document.createElement('select')
      sel.innerHTML = '<option value="teacher">Teacher</option><option value="admin">Admin</option>'
      sel.value = m.role
      sel.addEventListener('change', async () => {
        const { error } = await sb.rpc('set_member_role', { p_user: m.user_id, p_role: sel.value })
        if (error) { toast(friendly(error)); sel.value = m.role; return }
        toast(`${m.name} is now ${sel.value === 'admin' ? 'an admin' : 'a teacher'}`)
        refresh()
      })
      const del = document.createElement('button')
      del.className = 'btn tiny danger'
      del.textContent = 'Remove'
      del.addEventListener('click', async () => {
        if (!await confirmDialog('Remove this teacher?',
          `${m.name} loses access to the school. Tests they already ran are kept.`, 'Remove')) return
        const { error } = await sb.rpc('remove_member', { p_user: m.user_id })
        if (error) return toast(friendly(error))
        toast(`${m.name} removed`)
        refresh()
      })
      acts.append(sel, del)
    }
    el.appendChild(row)
  }
}

function renderInvites () {
  const el = $('#invites')
  $('#inv-count').textContent = state.invites.length
  $('#invites-panel').classList.toggle('hidden', !isAdmin())
  if (!state.invites.length) { el.innerHTML = '<div class="empty">No invitations waiting.</div>'; return }

  el.innerHTML = ''
  for (const i of state.invites) {
    const row = document.createElement('div')
    row.className = 'row'
    row.innerHTML = `
      <span class="who"><b></b><small>invited ${ago(i.created_at)}</small></span>
      <span class="tag ${i.role}">${i.role}</span>
      <span class="acts"><button class="btn tiny ghost">Cancel</button></span>`
    row.querySelector('.who b').textContent = i.email
    row.querySelector('button').addEventListener('click', async () => {
      const { error } = await sb.from('invites').delete().eq('id', i.id)
      if (error) return toast(friendly(error))
      toast('Invitation cancelled')
      refresh()
    })
    el.appendChild(row)
  }
}

function renderTests () {
  const el = $('#tests')
  $('#tests-count').textContent = state.tests.length
  if (!state.tests.length) {
    el.innerHTML = '<div class="empty">No tests yet. Teachers create them in the desktop app.</div>'
    return
  }
  const byId = Object.fromEntries(state.members.map(m => [m.user_id, m.name]))
  el.innerHTML = ''
  for (const t of state.tests) {
    const row = document.createElement('div')
    row.className = 'row'
    const tag = !t.active ? '<span class="tag">ended</span>'
      : t.locked ? '<span class="tag locked">locked</span>'
        : '<span class="tag live">open</span>'
    row.innerHTML = `
      <span class="who"><b></b><small></small></span>
      ${tag}
      <span class="meta">${dateFmt(t.created_at)}</span>`
    row.querySelector('.who b').textContent = t.title
    row.querySelector('.who small').textContent =
      `${byId[t.teacher_id] || 'A teacher'} · code ${t.active ? t.join_code : '—'}`
    el.appendChild(row)
  }
}

function renderBilling () {
  const s = state.school
  const used = s.seats_used || 0
  $('#lic').innerHTML = `
    <div><dt>Status</dt><dd style="text-transform:capitalize">${s.status}</dd></div>
    <div><dt>Seats purchased</dt><dd>${PRICING.num(s.seats_purchased)}</dd></div>
    <div><dt>Seats used</dt><dd>${PRICING.num(used)}</dd></div>
    <div><dt>Price per student / year</dt><dd>${PRICING.money(s.price_per_seat, true)}</dd></div>
    <div><dt>Term</dt><dd>${dateFmt(s.term_start)} → ${dateFmt(s.term_end)}</dd></div>
    <div><dt>Annual value at current usage</dt><dd>${PRICING.money((s.price_per_seat || 0) * used)}</dd></div>
    <div><dt>Purchase order</dt><dd>${s.purchase_order || '—'}</dd></div>`

  $('#b-contact').value = s.billing_contact || ''
  $('#b-email').value = s.billing_email || ''
  $('#b-po').value = s.purchase_order || ''

  const short = Math.max(0, used - (s.seats_purchased || 0))
  $('#upsell-copy').textContent = short > 0
    ? `You are ${PRICING.num(short)} students over your ${PRICING.num(s.seats_purchased)} seats. Nothing has stopped working — request a quote to true it up.`
    : 'Top up at any time at your current per-student rate, pro-rated to the end of your term. Nothing stops working if you go over — we reconcile at renewal.'
}

function renderSettings () {
  $('#s-name').value = state.school.name
  $('#s-domains').value = (state.school.allowed_domains || []).join(', ')
}

function renderAll () {
  renderSide(); renderOverview(); renderMembers(); renderInvites(); renderTests()
  if (isAdmin()) { renderBilling(); renderSettings() }
}

async function refresh () { await loadAll(); renderAll() }

/* ────────────────────────────────────────────────────── actions */

$('#invite-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  msg('#inv-err', ''); msg('#inv-ok', '')
  const email = $('#inv-email').value.trim()
  const { error } = await sb.rpc('invite_member', { p_email: email, p_role: $('#inv-role').value })
  if (error) return msg('#inv-err', friendly(error))
  $('#inv-email').value = ''
  msg('#inv-ok', `${email} can now join by signing in with that address.`, 'ok')
  refresh()
})

$('#bill-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  msg('#bill-err', ''); msg('#bill-ok', '')
  const { error } = await sb.rpc('update_school_profile', {
    p_name: state.school.name,
    p_domains: state.school.allowed_domains,
    p_billing_email: $('#b-email').value.trim(),
    p_billing_contact: $('#b-contact').value.trim(),
    p_purchase_order: $('#b-po').value.trim()
  })
  if (error) return msg('#bill-err', friendly(error))
  msg('#bill-ok', 'Saved', 'ok')
  refresh()
})

$('#school-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  msg('#school-err', ''); msg('#school-ok', '')
  const domains = $('#s-domains').value.split(',').map(d => d.trim().replace('@', '').toLowerCase()).filter(Boolean)
  const { error } = await sb.rpc('update_school_profile', {
    p_name: $('#s-name').value.trim(),
    p_domains: domains,
    p_billing_email: state.school.billing_email,
    p_billing_contact: state.school.billing_contact,
    p_purchase_order: state.school.purchase_order
  })
  if (error) return msg('#school-err', friendly(error))
  msg('#school-ok', 'Saved', 'ok')
  refresh()
})

$$('.nav-item').forEach(b => b.addEventListener('click', () => {
  $$('.nav-item').forEach(x => x.classList.toggle('on', x === b))
  $$('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab))
}))

/* ───────────────────────────────────────────────────────── boot */

async function boot () {
  const { data } = await sb.auth.getSession()
  const user = data?.session?.user
  if (!user || user.is_anonymous) { show('auth'); setAuthMode('login'); return }
  state.user = user

  // Picks up an invitation or a matching email domain on first sign-in.
  try { await sb.rpc('claim_membership') } catch {}

  const hasSchool = await loadAll()
  if (!hasSchool) {
    $('#ob-email').textContent = user.email
    show('onboard')
    return
  }
  renderAll()
  show('shell')
}

boot()
