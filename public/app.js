

// ── Feature flags (Tier 1 items 2–5) — flip to false to disable without redeploying the rest ──
const FLAGS = {
  voiceLog:     true,   // item 2: voice food entry
  photoLog:     true,   // item 2: photo food entry (pre-existing flow, now flag-gated)
  trainingLoad: true,   // item 3: CTL/ATL/TSB
  fueling:      true,   // item 4: planned-workout fueling
  trends:       true,   // item 5: insights tab
  briefCoach:   true,   // item 6: trend-grounded coach note in daily brief
  backups:      true,   // item 7: nightly D1 → R2 backups tile
  quickAdd:     true,   // item 8: copy-yesterday + favorites carousel
  pwa:          true,   // item 9: PWA install + web push
  tpAutoRefresh:true,   // item 10: TP cookie auto-refresh + expiry banner
  wellness:     true,   // 1.5A/B: TP wellness ingest + slim check-in + Today tile
  readiness:    true,   // 1.5C: morning readiness score card
  bodyComp:     true,   // 1.5D: fat vs lean mass charts under Trends
  anomalyAlert: true,   // 1.5E: HRV/RHR anomaly banner
  readinessActions: true, // 1.5F: fueling shift + deficit dial-back
};

// ── Auth & Onboarding ──
const GOOGLE_CLIENT_ID = '480646952925-03r0p3jkdvfjdpnhlqbam4hnfjq0hp63.apps.googleusercontent.com';
let _authToken = null;   // long-lived session token (NOT the Google ID token)
let _currentUser = null;

// Helper: returns auth headers for all protected API calls
function authHeaders(extra) {
  const h = { 'Content-Type': 'application/json' };
  if (_authToken) h['authorization'] = 'Bearer ' + _authToken;
  return Object.assign(h, extra || {});
}

function showScreen(screen) {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('onboarding-screen').classList.add('hidden');
  document.getElementById('app').style.display = 'none';
  if (screen === 'login') document.getElementById('login-screen').classList.remove('hidden');
  else if (screen === 'onboarding') document.getElementById('onboarding-screen').classList.remove('hidden');
  else if (screen === 'app') document.getElementById('app').style.display = '';
}

async function handleGoogleSignIn(response) {
  try {
    // Send the short-lived Google ID token to the server once
    // Server verifies it and returns a long-lived session token (30 days)
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: response.credential })
    });
    const data = await res.json();
    if (data.error) { alert('Sign-in failed: ' + data.error); return; }
    _currentUser = data.user;
    _authToken = data.sessionToken;
    localStorage.setItem('authToken', data.sessionToken);
    if (!_currentUser.onboarded) {
      showScreen('onboarding');
    } else {
      applyUserProfile(_currentUser);
      showScreen('app');
      _initApp();
      // Ensure mood check-in prompt shows after fresh sign-in
      setTimeout(maybeShowWelcomeModal, 800);
    }
  } catch (e) {
    alert('Sign-in error: ' + e.message);
  }
}

function applyUserProfile(user) {
  if (user.calories) MACROS.calories = user.calories;
  if (user.protein)  MACROS.protein  = user.protein;
  if (user.carbs)    MACROS.carbs    = user.carbs;
  if (user.fat)      MACROS.fat      = user.fat;
  if (user.tdee)     TDEE = user.tdee;
  // Sync to localStorage so existing settings UI works
  const goals = getStorage('userGoals', {});
  goals.weight   = user.current_weight || goals.weight;
  goals.goal     = user.goal_weight || goals.goal;
  goals.goalDate = user.goal_date || goals.goalDate;
  setStorage('userGoals', goals);
  const macros = { calories: MACROS.calories, protein: MACROS.protein, carbs: MACROS.carbs, fat: MACROS.fat };
  setStorage('userMacros', macros);
  // Clear any cached adjusted macros so D1 profile takes priority
  localStorage.removeItem('adaptiveMacros');
  localStorage.removeItem('garminAdjustedMacros');
}

// Onboarding navigation
let _onbStep = 0;
function onbGoTo(step) {
  document.querySelectorAll('.onb-step').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.onb-dot').forEach(d => d.classList.remove('active'));
  document.querySelector(`.onb-step[data-step="${step}"]`).classList.add('active');
  for (let i = 0; i <= step; i++) document.querySelector(`.onb-dot[data-step="${i}"]`).classList.add('active');
  _onbStep = step;
  if (step === 3) renderOnbSummary();
}
function onbNext(from) {
  if (from === 0) {
    if (!document.getElementById('onb-gender').value || !document.getElementById('onb-age').value) { alert('Please fill in all fields'); return; }
  } else if (from === 1) {
    if (!document.getElementById('onb-height').value || !document.getElementById('onb-weight').value) { alert('Please fill in all fields'); return; }
  } else if (from === 2) {
    if (!document.getElementById('onb-goal-weight').value || !document.getElementById('onb-activity').value) { alert('Please fill in all fields'); return; }
  }
  onbGoTo(from + 1);
}
function onbBack(from) { onbGoTo(from - 1); }

function calcOnbMacros() {
  const gender = document.getElementById('onb-gender').value;
  const age = parseInt(document.getElementById('onb-age').value) || 25;
  const heightIn = parseInt(document.getElementById('onb-height').value) || 70;
  const weightLbs = parseFloat(document.getElementById('onb-weight').value) || 170;
  const goalLbs = parseFloat(document.getElementById('onb-goal-weight').value) || weightLbs;
  const goalDate = document.getElementById('onb-goal-date').value;
  const activity = document.getElementById('onb-activity').value;

  // Mifflin-St Jeor
  const weightKg = weightLbs * 0.453592;
  const heightCm = heightIn * 2.54;
  let bmr;
  if (gender === 'male') bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + 5;
  else bmr = 10 * weightKg + 6.25 * heightCm - 5 * age - 161;

  const multipliers = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, extra: 1.9 };
  const tdee = Math.round(bmr * (multipliers[activity] || 1.375));

  // Calculate deficit from goal
  let deficit = 500; // default
  if (goalDate && goalLbs < weightLbs) {
    const daysLeft = Math.max(1, Math.round((new Date(goalDate + 'T12:00:00') - nowEST()) / 86400000));
    const lbsToLose = weightLbs - goalLbs;
    const calsToLose = lbsToLose * 3500;
    deficit = Math.min(1000, Math.max(250, Math.round(calsToLose / daysLeft)));
  }

  const calories = Math.max(1200, tdee - deficit);
  const protein = Math.round(weightLbs * 1.0); // 1g per lb
  const fat = Math.round(calories * 0.25 / 9);
  const carbs = Math.round((calories - protein * 4 - fat * 9) / 4);

  return { gender, age, heightIn, weightLbs, goalLbs, goalDate, activity, tdee, deficit, calories, protein, fat, carbs };
}

function renderOnbSummary() {
  const m = calcOnbMacros();
  document.getElementById('onb-summary').innerHTML =
    `<div class="onb-summary-row"><span class="onb-summary-label">TDEE</span><span class="onb-summary-val">${m.tdee.toLocaleString()} kcal</span></div>` +
    `<div class="onb-summary-row"><span class="onb-summary-label">Daily Deficit</span><span class="onb-summary-val">~${m.deficit} kcal</span></div>`;
  document.getElementById('onb-macros').innerHTML =
    `<div class="onb-macro-card"><div class="onb-macro-val" style="color:#f59e0b">${m.calories.toLocaleString()}</div><div class="onb-macro-label">Calories</div></div>` +
    `<div class="onb-macro-card"><div class="onb-macro-val" style="color:#4ade80">${m.protein}g</div><div class="onb-macro-label">Protein</div></div>` +
    `<div class="onb-macro-card"><div class="onb-macro-val" style="color:#60a5fa">${m.carbs}g</div><div class="onb-macro-label">Carbs</div></div>` +
    `<div class="onb-macro-card"><div class="onb-macro-val" style="color:#f87171">${m.fat}g</div><div class="onb-macro-label">Fat</div></div>`;
  const weeksEst = m.goalLbs < m.weightLbs ? Math.round((m.weightLbs - m.goalLbs) / (m.deficit * 7 / 3500) * 10) / 10 : 0;
  const lbsPerWeek = m.deficit * 7 / 3500;
  document.getElementById('onb-deficit-note').textContent = m.goalLbs < m.weightLbs
    ? `~${lbsPerWeek.toFixed(1)} lbs/week loss | ~${weeksEst} weeks to goal`
    : 'Maintenance / lean gain targets';
}

async function onbFinish() {
  const m = calcOnbMacros();
  const body = {
    gender: m.gender, age: m.age, height_inches: m.heightIn,
    current_weight: m.weightLbs, goal_weight: m.goalLbs, goal_date: m.goalDate,
    activity_level: m.activity, tdee: m.tdee, calories: m.calories,
    protein: m.protein, carbs: m.carbs, fat: m.fat
  };
  try {
    const res = await fetch('/api/user/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + _authToken },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.error) { alert('Save failed: ' + data.error); return; }
    _currentUser = data.user;
    applyUserProfile(_currentUser);
    showScreen('app');
    _initApp();
  } catch (e) {
    alert('Error saving profile: ' + e.message);
  }
}

// On page load: check for saved token (localStorage) or cookie fallback
async function checkAuth() {
  const saved = localStorage.getItem('authToken');
  if (saved) _authToken = saved;

  // Always hit /api/user — if localStorage was wiped (iOS Safari ITP),
  // the HttpOnly session cookie still gets sent automatically by the browser.
  // The server validates the Bearer token AND falls back to the cookie, so a
  // stale localStorage token can't lock us out while the cookie is still good.
  try {
    const headers = _authToken ? { 'authorization': 'Bearer ' + _authToken } : {};
    const res = await fetch('/api/user', { headers, credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      if (data.user) {
        // Re-populate localStorage from cookie-authenticated session
        if (data.sessionToken && data.sessionToken !== _authToken) {
          _authToken = data.sessionToken;
          localStorage.setItem('authToken', data.sessionToken);
        }
        _currentUser = data.user;
        if (!_currentUser.onboarded) {
          showScreen('onboarding');
        } else {
          applyUserProfile(_currentUser);
          showScreen('app');
          _initApp();
        }
        return;
      }
    } else if (res.status !== 401) {
      // Server hiccup (5xx, D1 blip) — NOT an auth failure. Never log the user
      // out for this; load the app with cached data and let it retry later.
      if (_authToken) {
        console.warn('[auth] /api/user returned', res.status, '— loading app with cached session');
        showScreen('app');
        _initApp();
        return;
      }
      showScreen('login');
      initGoogleSignIn();
      return;
    }
  } catch (e) {
    if (_authToken) {
      console.warn('[auth] Network error checking session, loading app offline:', e.message);
      showScreen('app');
      _initApp();
      return;
    }
  }

  // Explicit 401 — server rejected both the Bearer token and the cookie
  localStorage.removeItem('authToken');
  _authToken = null;
  showScreen('login');
  initGoogleSignIn();
}

function initGoogleSignIn() {
  if (typeof google === 'undefined' || !google.accounts) {
    setTimeout(initGoogleSignIn, 200);
    return;
  }
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleGoogleSignIn,
    auto_select: true,
    itp_support: true
  });
  google.accounts.id.renderButton(document.getElementById('g_id_signin'), {
    theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', width: 280
  });
  // Silently re-auth if they're already signed in to Google (covers iOS Safari ITP
  // localStorage wipes and fresh devices where they're signed in to Google)
  google.accounts.id.prompt();
}

// ── End Auth ──

let MACROS = { calories: 1500, protein: 165, carbs: 86, fat: 55 };
let TDEE   = 2208; // Mifflin-St Jeor × 1.375 (lightly active, no exercise) — TrainingPeaks adds run calories on top
const MACRO_COLORS = { calories: '#f59e0b', protein: '#4ade80', carbs: '#60a5fa', fat: '#f87171' };

const PROGRAM = {
  A: { name: 'Push Day A', exercises: [
    { name: 'Barbell Bench Press', sets: 4, reps: '6–8', notes: 'Primary chest builder' },
    { name: 'Incline Dumbbell Press', sets: 3, reps: '8–10', notes: '' },
    { name: 'Overhead Press', sets: 4, reps: '6–8', notes: 'Seated or standing' },
    { name: 'Lateral Raises', sets: 3, reps: '12–15', notes: 'Light, controlled' },
    { name: 'Tricep Pushdowns', sets: 3, reps: '10–12', notes: '' },
    { name: 'Overhead Tricep Ext.', sets: 3, reps: '10–12', notes: '' },
  ]},
  B: { name: 'Pull Day B', exercises: [
    { name: 'Barbell Row', sets: 4, reps: '6–8', notes: 'Brace core hard' },
    { name: 'Lat Pulldown', sets: 3, reps: '8–10', notes: '' },
    { name: 'Seated Cable Row', sets: 3, reps: '10–12', notes: '' },
    { name: 'Face Pulls', sets: 3, reps: '15–20', notes: 'Shoulder health essential' },
    { name: 'Barbell Curl', sets: 3, reps: '8–10', notes: '' },
    { name: 'Hammer Curl', sets: 3, reps: '10–12', notes: '' },
  ]},
  C: { name: 'Legs & Core Day C', exercises: [
    { name: 'Barbell Squat', sets: 4, reps: '6–8', notes: 'Prioritize depth & form' },
    { name: 'Romanian Deadlift', sets: 3, reps: '8–10', notes: 'Hip hinge focus' },
    { name: 'Leg Press', sets: 3, reps: '10–12', notes: '' },
    { name: 'Leg Curl', sets: 3, reps: '10–12', notes: '' },
    { name: 'Calf Raise', sets: 4, reps: '15–20', notes: '' },
    { name: 'Plank', sets: 3, reps: '45–60s', notes: '' },
  ]}
};

const WEEK = [
  { day: 'Mon', type: 'lift', sess: 'C' },
  { day: 'Tue', type: 'run', sess: null },
  { day: 'Wed', type: 'run', sess: null },
  { day: 'Thu', type: 'run', sess: null },
  { day: 'Fri', type: 'lift', sess: 'A' },
  { day: 'Sat', type: 'longrun', sess: 'B', optLift: true },
  { day: 'Sun', type: 'recoveryrun', sess: null },
];

const DAY_MAP = { Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6, Sun:0 };
// ── EST Date Helpers ──
let _nowESTcache = null, _nowESTcacheTs = 0;
function nowEST() {
  // Cache the EST time for 1 second, but always return a COPY
  // so callers can safely call setDate/setMonth etc without poisoning the cache
  const now = Date.now();
  if (now - _nowESTcacheTs >= 1000 || !_nowESTcache) {
    _nowESTcache = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    _nowESTcacheTs = now;
  }
  return new Date(_nowESTcache); // always a fresh copy
}

function dateToKey(d) {
  // Format a date object as YYYY-MM-DD
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const todayKey = () => dateToKey(nowEST());

// ── Selected Day (for viewing/editing past days) ──
let selectedDateKey = todayKey();

function getSelectedDateKey() { return selectedDateKey; }

function setSelectedDay(dateKey) {
  selectedDateKey = dateKey;
  updateDateNavBar();
  renderRings();
  renderFoodLog();
  renderWeekStrip();
  checkCopyYesterday();
  renderWeeklyBalance();
}

function shiftSelectedDay(delta) {
  const d = new Date(selectedDateKey + 'T12:00:00'); // noon to avoid DST edge
  d.setDate(d.getDate() + delta);
  const newKey = dateToKey(d);
  // Don't allow going into the future past today
  if (newKey > todayKey()) return;
  setSelectedDay(newKey);
}

function updateDateNavBar() {
  const today = todayKey();
  const isToday = selectedDateKey === today;
  const labelEl = document.getElementById('selectedDayLabel');
  const subEl   = document.getElementById('selectedDaySub');
  const nextBtn = document.getElementById('nextDayBtn');

  // Human-friendly label
  const d = new Date(selectedDateKey + 'T12:00:00');
  const dayName = d.toLocaleDateString('en-US', { weekday:'long' });
  const dateFmt = d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });

  if (isToday) {
    labelEl.textContent = 'Today';
    labelEl.style.color = 'var(--green)';
    subEl.textContent = dateFmt;
  } else {
    const diffDays = Math.round((new Date(today + 'T12:00:00') - d) / 86400000);
    labelEl.textContent = diffDays === 1 ? 'Yesterday' : dayName;
    labelEl.style.color = 'var(--text)';
    subEl.textContent = dateFmt + (diffDays > 1 ? ` · ${diffDays} days ago` : '');
  }

  // Disable next button when viewing today
  nextBtn.style.opacity = isToday ? '0.3' : '1';
  nextBtn.style.pointerEvents = isToday ? 'none' : 'auto';
}

function getYesterdayKey() {
  const d = nowEST();
  d.setDate(d.getDate() - 1);
  return dateToKey(d);
}

// ── Header Date Display ──
function updateHeaderDate() {
  const d = nowEST();
  const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const el = document.getElementById('headerDateLabel');
  if (el) el.textContent = label;

  // Update goal sub-header dynamically
  const goalEl = document.getElementById('headerGoalSub');
  if (goalEl) {
    const goals = getStorage('userGoals', {});
    const gw    = goals.goal     || 163;
    const gd    = goals.goalDate || '';
    if (gd) {
      const daysLeft = Math.max(0, Math.round((new Date(gd + 'T12:00:00') - new Date(todayKey() + 'T12:00:00')) / 86400000));
      const dateStr  = new Date(gd + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      goalEl.textContent = `Goal: ${gw} lbs by ${dateStr} · ${daysLeft} day${daysLeft !== 1 ? 's' : ''} left`;
    } else {
      const cw = goals.weight || 165;
      goalEl.textContent = `${cw} → ${gw} lbs`;
    }
  }
}

// ── Auto Midnight Refresh ──
function scheduleMidnightRefresh() {
  // Calculate ms until next midnight EST using date math (handles sleep/wake correctly)
  const now = nowEST();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 1, 0); // 00:00:01 next day
  const msUntilMidnight = tomorrow.getTime() - now.getTime();

  setTimeout(() => {
    // New day — clear today's burn adjustment so yesterday's run doesn't carry over
    setStorage('garminAdjustedMacros', null);
    updateHeaderDate();
    renderWeekStrip();
    renderRings();
    renderFoodLog();
    renderWeightTrend();
    renderWeeklyBalance();
    checkCopyYesterday();
    checkAdaptiveMacros();
    initGreetingTile();
    maybeShowWelcomeModal();
    showToast('🌅 Good morning! New day started.');
    scheduleMidnightRefresh();
  }, msUntilMidnight);
}

let activeSession = 'A';

// ── HTML escape helper — prevents XSS from user-entered names in innerHTML ──
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Render scheduler — batches multiple render calls within one animation frame ──
const _pendingRenders = new Set();
let   _renderRAF = null;
function scheduleRender(fn) {
  _pendingRenders.add(fn);
  if (!_renderRAF) {
    _renderRAF = requestAnimationFrame(() => {
      _renderRAF = null;
      const fns = [..._pendingRenders];
      _pendingRenders.clear();
      fns.forEach(f => f());
    });
  }
}

function getStorage(key, def) {
  try { const v = localStorage.getItem(key); if (v === null) return def; const parsed = JSON.parse(v); return parsed !== null && parsed !== undefined ? parsed : def; } catch { return def; }
}
function setStorage(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
    try { _syncOnWrite(key); } catch(_) {}
    return true;
  } catch(e) {
    console.error('setStorage failed for key:', key, e);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// D1 LOG SYNC (Tier 1, item 1) — server-authoritative food/weight/shoes/lifts.
// localStorage stays the offline cache; every entry carries _id (uuid) and
// _u (unix ms). Merge is last-write-wins on _u/updated_at. A shadow copy of
// the last-synced state ('_syncShadow_*') detects local changes + deletions.
// Tombstones are only emitted for recent dates so the 90-day prune sweep
// never deletes server history.
// ═══════════════════════════════════════════════════════════════════════
const SYNC_TABLES = ['food', 'weight', 'shoes', 'lifts', 'blood'];
const SYNC_KEY_MAP = { foodEntries: 'food', weightLog: 'weight', shoeGarage: 'shoes', shoeRuns: 'shoes', liftLog2: 'lifts', bloodResults: 'blood' };
const SYNC_MERGE_DAYS = 90;      // only merge server rows this recent into local cache
const SYNC_TOMBSTONE_DAYS = 30;  // only report deletions this recent (older = prune, not delete)
let _syncApplying = false;       // guard: writes made by the sync engine itself
const _syncTimers = {};

function _syncUuid() {
  try { return crypto.randomUUID(); } catch(_) {
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
}

function _syncOnWrite(key) {
  if (_syncApplying) return;
  const table = SYNC_KEY_MAP[key];
  if (!table || !_authToken) return;
  clearTimeout(_syncTimers[table]);
  _syncTimers[table] = setTimeout(() => syncLogTable(table), 2000);
}

function _syncCutoffKey(days) {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().slice(0, 10);
}

// Raw write that never re-triggers the sync scheduler
function _syncSet(key, val) {
  const was = _syncApplying; _syncApplying = true;
  try { setStorage(key, val); } finally { _syncApplying = was; }
}

// ── Per-table serializers: local diff vs shadow → rows to push ──────────
function _syncFoodRows() {
  const all = getStorage('foodEntries', {});
  const shadow = getStorage('_syncShadow_food', {});
  const tombCutoff = _syncCutoffKey(SYNC_TOMBSTONE_DAYS);
  const rows = []; let mutated = false;
  for (const [date, arr] of Object.entries(all)) {
    if (!Array.isArray(arr) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    for (const e of arr) {
      if (!e._id) { e._id = _syncUuid(); mutated = true; }
      const h = JSON.stringify({ ...e, _u: 0 });
      const sh = shadow[date]?.[e._id];
      if (!sh || sh.h !== h) {
        e._u = Date.now(); mutated = true;
        rows.push({ date, entry_id: e._id, payload: e, updated_at: e._u, deleted: 0 });
      }
    }
    // Entries in shadow but gone locally → recent ones are real deletions
    const localIds = new Set(arr.map(e => e._id));
    for (const id of Object.keys(shadow[date] || {})) {
      if (!localIds.has(id) && date >= tombCutoff) {
        rows.push({ date, entry_id: id, payload: {}, updated_at: Date.now(), deleted: 1 });
      }
    }
  }
  // Whole days deleted locally
  for (const date of Object.keys(shadow)) {
    if (!all[date] && date >= tombCutoff) {
      for (const id of Object.keys(shadow[date])) {
        rows.push({ date, entry_id: id, payload: {}, updated_at: Date.now(), deleted: 1 });
      }
    }
  }
  if (mutated) _syncSet('foodEntries', all);
  return rows;
}

function _syncWeightRows() {
  const log = getStorage('weightLog', {});
  const shadow = getStorage('_syncShadow_weight', {});
  const rows = [];
  for (const [date, lbs] of Object.entries(log)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(Number(lbs) > 0)) continue;
    if (shadow[date] !== lbs) rows.push({ date, weight_lbs: Number(lbs), updated_at: Date.now() });
  }
  return rows;
}

function _syncShoeRows() {
  const shoes = getStorage('shoeGarage', []);
  const runs = getStorage('shoeRuns', []);
  const shadow = getStorage('_syncShadow_shoes', {});
  const rows = []; let mutShoes = false, mutRuns = false;
  for (const s of shoes) {
    if (!s.id) { s.id = _syncUuid(); mutShoes = true; }
    const rowId = 'shoe:' + s.id, h = JSON.stringify({ ...s, _u: 0 });
    if (shadow[rowId]?.h !== h) {
      s._u = Date.now(); mutShoes = true;
      rows.push({ shoe_id: rowId, payload: { kind: 'shoe', data: s }, updated_at: s._u, deleted: 0 });
    }
  }
  for (const r of runs) {
    if (!r._id) { r._id = _syncUuid(); mutRuns = true; }
    const rowId = 'run:' + r._id, h = JSON.stringify({ ...r, _u: 0 });
    if (shadow[rowId]?.h !== h) {
      r._u = Date.now(); mutRuns = true;
      rows.push({ shoe_id: rowId, payload: { kind: 'run', data: r }, updated_at: r._u, deleted: 0 });
    }
  }
  const liveIds = new Set([...shoes.map(s => 'shoe:' + s.id), ...runs.map(r => 'run:' + r._id)]);
  for (const rowId of Object.keys(shadow)) {
    if (!liveIds.has(rowId)) rows.push({ shoe_id: rowId, payload: {}, updated_at: Date.now(), deleted: 1 });
  }
  if (mutShoes) _syncSet('shoeGarage', shoes);
  if (mutRuns) _syncSet('shoeRuns', runs);
  return rows;
}

function _syncLiftRows() {
  const log = getStorage('liftLog2', {});
  const shadow = getStorage('_syncShadow_lifts', {});
  const tombCutoff = _syncCutoffKey(SYNC_TOMBSTONE_DAYS);
  const rows = []; let mutated = false;
  for (const [key, val] of Object.entries(log)) {
    if (!val || typeof val !== 'object') continue;
    const date = (val.date && /^\d{4}-\d{2}-\d{2}$/.test(val.date)) ? val.date : key.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const h = JSON.stringify({ ...val, _u: 0 });
    if (shadow[key]?.h !== h) {
      val._u = Date.now(); mutated = true;
      rows.push({ date, entry_id: key, payload: val, updated_at: val._u, deleted: 0 });
    }
  }
  for (const [key, sh] of Object.entries(shadow)) {
    if (!log[key] && sh.d >= tombCutoff) {
      rows.push({ date: sh.d, entry_id: key, payload: {}, updated_at: Date.now(), deleted: 1 });
    }
  }
  if (mutated) _syncSet('liftLog2', log);
  return rows;
}

// ── Per-table mergers: server rows → local (LWW, recent window only) ────
function _syncApplyFood(rows) {
  const all = getStorage('foodEntries', {});
  const mergeCutoff = _syncCutoffKey(SYNC_MERGE_DAYS);
  let changed = false;
  for (const r of rows) {
    if (!r.date || r.date < mergeCutoff) continue;
    const arr = all[r.date] || (all[r.date] = []);
    const idx = arr.findIndex(e => e._id === r.entry_id);
    const localU = idx >= 0 ? (arr[idx]._u || 0) : 0;
    if (r.updated_at <= localU) continue;
    if (r.deleted) { if (idx >= 0) { arr.splice(idx, 1); changed = true; } }
    else if (r.payload) {
      const entry = { ...r.payload, _id: r.entry_id, _u: r.updated_at };
      if (idx >= 0) arr[idx] = entry; else arr.push(entry);
      changed = true;
    }
    if (all[r.date] && all[r.date].length === 0) delete all[r.date];
  }
  if (changed) {
    _syncSet('foodEntries', all);
    try { renderFoodLog(); renderRings(); } catch(_) {}
  }
}

function _syncApplyWeight(rows) {
  const log = getStorage('weightLog', {});
  const shadow = getStorage('_syncShadow_weight', {});
  let changed = false;
  for (const r of rows) {
    // Local unsynced edit (differs from shadow) wins until pushed
    const localDirty = log[r.date] !== undefined && log[r.date] !== shadow[r.date];
    if (!localDirty && log[r.date] !== r.weight_lbs) { log[r.date] = r.weight_lbs; changed = true; }
  }
  if (changed) _syncSet('weightLog', log);
}

function _syncApplyShoes(rows) {
  const shoes = getStorage('shoeGarage', []);
  const runs = getStorage('shoeRuns', []);
  let changed = false;
  for (const r of rows) {
    const [kind, id] = [r.shoe_id.slice(0, r.shoe_id.indexOf(':')), r.shoe_id.slice(r.shoe_id.indexOf(':') + 1)];
    const list = kind === 'shoe' ? shoes : kind === 'run' ? runs : null;
    if (!list) continue;
    const idKey = kind === 'shoe' ? 'id' : '_id';
    const idx = list.findIndex(x => x[idKey] === id);
    const localU = idx >= 0 ? (list[idx]._u || 0) : 0;
    if (r.updated_at <= localU) continue;
    if (r.deleted) { if (idx >= 0) { list.splice(idx, 1); changed = true; } }
    else if (r.payload?.data) {
      const item = { ...r.payload.data, [idKey]: id, _u: r.updated_at };
      if (idx >= 0) list[idx] = item; else list.push(item);
      changed = true;
    }
  }
  if (changed) { _syncSet('shoeGarage', shoes); _syncSet('shoeRuns', runs); }
}

function _syncApplyLifts(rows) {
  const log = getStorage('liftLog2', {});
  const mergeCutoff = _syncCutoffKey(SYNC_MERGE_DAYS);
  let changed = false;
  for (const r of rows) {
    if (!r.date || r.date < mergeCutoff) continue;
    const localU = log[r.entry_id]?._u || 0;
    if (r.updated_at <= localU) continue;
    if (r.deleted) { if (log[r.entry_id]) { delete log[r.entry_id]; changed = true; } }
    else if (r.payload) { log[r.entry_id] = { ...r.payload, _u: r.updated_at }; changed = true; }
  }
  if (changed) _syncSet('liftLog2', log);
}

// ── Shadow rebuild after a successful sync ──────────────────────────────
function _syncRebuildShadow(table) {
  if (table === 'food') {
    const all = getStorage('foodEntries', {}), sh = {};
    for (const [date, arr] of Object.entries(all)) {
      if (!Array.isArray(arr)) continue;
      sh[date] = {};
      for (const e of arr) if (e._id) sh[date][e._id] = { h: JSON.stringify({ ...e, _u: 0 }) };
    }
    _syncSet('_syncShadow_food', sh);
  } else if (table === 'weight') {
    _syncSet('_syncShadow_weight', { ...getStorage('weightLog', {}) });
  } else if (table === 'shoes') {
    const sh = {};
    for (const s of getStorage('shoeGarage', [])) if (s.id) sh['shoe:' + s.id] = { h: JSON.stringify({ ...s, _u: 0 }) };
    for (const r of getStorage('shoeRuns', [])) if (r._id) sh['run:' + r._id] = { h: JSON.stringify({ ...r, _u: 0 }) };
    _syncSet('_syncShadow_shoes', sh);
  } else if (table === 'blood') {
    const sh = {};
    for (const e of getStorage('bloodResults', [])) {
      if (e?.id) sh[String(e.id)] = { h: JSON.stringify({ ...e, _u: 0 }), d: e.date };
    }
    _syncSet('_syncShadow_blood', sh);
  } else if (table === 'lifts') {
    const sh = {};
    for (const [key, val] of Object.entries(getStorage('liftLog2', {}))) {
      if (!val || typeof val !== 'object') continue;
      const date = (val.date && /^\d{4}-\d{2}-\d{2}$/.test(val.date)) ? val.date : key.slice(0, 10);
      sh[key] = { h: JSON.stringify({ ...val, _u: 0 }), d: date };
    }
    _syncSet('_syncShadow_lifts', sh);
  }
}

function _syncBloodRows() {
  const results = getStorage('bloodResults', []);
  const shadow = getStorage('_syncShadow_blood', {});
  const rows = []; let mutated = false;
  for (const e of results) {
    if (!e || !e.date) continue;
    if (!e.id) { e.id = Date.now() + Math.random(); mutated = true; }
    const key = String(e.id);
    const h = JSON.stringify({ ...e, _u: 0 });
    if (shadow[key]?.h !== h) {
      e._u = Date.now(); mutated = true;
      rows.push({ date: e.date, entry_id: key, payload: e, updated_at: e._u, deleted: 0 });
    }
  }
  const liveIds = new Set(results.map(e => String(e.id)));
  for (const [key, sh] of Object.entries(shadow)) {
    if (!liveIds.has(key)) rows.push({ date: sh.d || '1970-01-01', entry_id: key, payload: {}, updated_at: Date.now(), deleted: 1 });
  }
  if (mutated) _syncSet('bloodResults', results);
  return rows;
}

function _syncApplyBlood(rows) {
  const results = getStorage('bloodResults', []);
  let changed = false;
  for (const r of rows) {
    const idx = results.findIndex(e => String(e.id) === r.entry_id);
    const localU = idx >= 0 ? (results[idx]._u || 0) : 0;
    if (r.updated_at <= localU) continue;
    if (r.deleted) { if (idx >= 0) { results.splice(idx, 1); changed = true; } }
    else if (r.payload?.date) {
      const entry = { ...r.payload, _u: r.updated_at };
      if (idx >= 0) results[idx] = entry; else results.push(entry);
      changed = true;
    }
  }
  if (changed) {
    results.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    _syncSet('bloodResults', results);
    try { renderBloodWorkPage(); } catch(_) {}
  }
}

const _SYNC_IMPL = {
  blood:  { toRows: _syncBloodRows,  apply: _syncApplyBlood },
  food:   { toRows: _syncFoodRows,   apply: _syncApplyFood },
  weight: { toRows: _syncWeightRows, apply: _syncApplyWeight },
  shoes:  { toRows: _syncShoeRows,   apply: _syncApplyShoes },
  lifts:  { toRows: _syncLiftRows,   apply: _syncApplyLifts },
};

// ── Core sync: pull-merge, then push local diff, then settle shadow ─────
async function syncLogTable(table) {
  if (!_authToken) return false;
  const impl = _SYNC_IMPL[table];
  try {
    const since = getStorage('_syncPull_' + table, 0);
    const res = await fetch('/api/log/' + table + '?since=' + since, { headers: authHeaders() });
    if (res.status === 401) return false;           // session problem — checkAuth owns that
    if (!res.ok) throw new Error('pull ' + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'pull failed');
    _syncApplying = true;
    try { impl.apply(data.rows || []); } finally { _syncApplying = false; }

    const rows = impl.toRows();
    for (let i = 0; i < rows.length; i += 400) {
      const pr = await fetch('/api/log/' + table, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ entries: rows.slice(i, i + 400) })
      });
      if (!pr.ok) throw new Error('push ' + pr.status);
    }
    _syncRebuildShadow(table);
    _syncSet('_syncPull_' + table, data.now);
    _syncSet('_syncDirty_' + table, 0);
    _syncSet('_syncLastOk', Date.now());
    return true;
  } catch (e) {
    _syncSet('_syncDirty_' + table, 1);
    console.warn('[sync]', table, e.message);
    return false;
  }
}

async function syncAllLogs() {
  for (const t of SYNC_TABLES) await syncLogTable(t);
  try { updateSyncStatusUI(); } catch(_) {}
}

// Settings: force-push everything local → server (safety backfill)
async function forceBackfillSync() {
  showToast('☁️ Backfilling all local data to server…');
  for (const t of SYNC_TABLES) {
    _syncSet('_syncShadow_' + t, {});   // empty shadow = everything looks new
  }
  await syncAllLogs();
  const dirty = SYNC_TABLES.filter(t => getStorage('_syncDirty_' + t, 0));
  showToast(dirty.length ? '⚠️ Backfill incomplete for: ' + dirty.join(', ') : '✅ Backfill complete — all data on server');
}

// ═══════════════════════════════════════════════════════════════════════
// WELLNESS + READINESS (Tier 1.5) — Garmin data via TP drives the morning
// card, slim check-in, body-comp charts, anomaly banner, and deficit policy.
// ═══════════════════════════════════════════════════════════════════════

async function renderReadinessCard() {
  if (!FLAGS.readiness) return;
  const card = document.getElementById('readinessCard');
  if (!card || !getStorage('tpConnected', null)) return;
  try {
    const res = await fetch('/api/readiness/today', { headers: authHeaders() });
    const d = await res.json();
    if (!d.ok) return;
    card.style.display = 'block';
    const scoreEl = document.getElementById('rdScore'), bandEl = document.getElementById('rdBand'), narrEl = document.getElementById('rdNarrative');

    if (!d.row) {
      scoreEl.textContent = '…';
      bandEl.textContent = 'GATHERING';
      bandEl.style.color = 'var(--text3)';
      narrEl.textContent = d.gathering ? `Building your baseline — ${d.have || 0}/${d.need || 14} days of HRV data so far.` : 'No wellness data yet today.';
      renderWellnessRow();
      return;
    }
    const colors = { primed: '#22c55e', ready: '#4ade80', guarded: '#f59e0b', compromised: '#ef4444' };
    const c = colors[d.row.band] || 'var(--text)';
    scoreEl.textContent = d.row.score;
    scoreEl.style.color = c;
    bandEl.textContent = d.row.band.toUpperCase();
    bandEl.style.color = c;
    narrEl.textContent = d.row.narrative || '';
    setStorage('readinessToday', { date: d.row.date, score: d.row.score, band: d.row.band, narrative: d.row.narrative, fetched: Date.now() });

    // Anomaly banner (1.5E)
    const ab = document.getElementById('rdAnomalyBanner');
    if (FLAGS.anomalyAlert && d.anomalies?.length) {
      const kinds = { hrv_rhr_combo: 'HRV low + RHR elevated', rhr_solo: 'Resting HR well above baseline', hrv_trend: 'HRV >20% below baseline two days running' };
      ab.textContent = '⚠️ ' + d.anomalies.map(a => kinds[a.kind] || a.kind).join(' · ') + ' — treat today as recovery.';
      ab.style.display = 'block';
    } else ab.style.display = 'none';

    // Detail: per-component bars
    const detail = document.getElementById('rdDetail');
    const comps = d.row.inputs?.components || {};
    const labels = { hrv: 'HRV', rhr: 'RHR', sleep: 'Sleep', bb: 'Body Battery', tsb: 'Form (TSB)' };
    detail.innerHTML = Object.entries(comps).map(([k, v]) => `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
        <div style="width:82px;font-size:10px;font-weight:700;color:var(--text2)">${labels[k] || k}</div>
        <div style="flex:1;height:8px;background:var(--surface2);border-radius:4px;overflow:hidden">
          <div style="width:${Math.round(v)}%;height:100%;background:${v >= 70 ? '#22c55e' : v >= 45 ? '#f59e0b' : '#ef4444'}"></div>
        </div>
        <div style="width:28px;text-align:right;font-size:10px;font-weight:700">${Math.round(v)}</div>
      </div>`).join('');

    // 30-day sparkline
    try {
      const hres = await fetch('/api/readiness?days=30', { headers: authHeaders() });
      const h = await hres.json();
      const rows = h.rows || [];
      if (rows.length >= 2) {
        const W = 200, H = 26;
        const pt = (r, i) => `${(i / (rows.length - 1) * W).toFixed(1)},${(H - 2 - (r.score / 100) * (H - 4)).toFixed(1)}`;
        document.getElementById('rdSparkline').innerHTML =
          `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:220px;height:${H}px"><polyline points="${rows.map(pt).join(' ')}" fill="none" stroke="${c}" stroke-width="1.5" opacity="0.7"/></svg>`;
      }
    } catch(_) {}

    renderWellnessRow();
    applyReadinessDeficitPolicy();
    renderTPBanners();
  } catch (e) { console.warn('[readiness]', e.message); }
}

function toggleReadinessDetail() {
  const d = document.getElementById('rdDetail');
  if (d) d.style.display = d.style.display === 'none' ? 'block' : 'none';
}

// Wellness metric grid with 7-day deltas (1.5B Today tile)
async function renderWellnessRow() {
  if (!FLAGS.wellness) return;
  const row = document.getElementById('wellnessRow');
  if (!row) return;
  try {
    const res = await fetch('/api/wellness?days=9', { headers: authHeaders() });
    const d = await res.json();
    if (!d.ok || !d.rows?.length) return;
    const rows = d.rows; // date DESC
    const today = rows[0];
    const baseline = f => {
      const vals = rows.slice(1).map(r => r[f]).filter(v => v != null);
      return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    };
    const mood = getMoodLog()[todayKey()] || {};
    const fmt = (v, dec) => v == null ? '—' : (+v).toFixed(dec);
    const delta = (v, b, invert, dec) => {
      if (v == null || b == null) return '';
      const dv = v - b;
      if (Math.abs(dv) < Math.pow(10, -dec) / 2) return '';
      const good = invert ? dv < 0 : dv > 0;
      return `<span style="color:${good ? '#22c55e' : '#f59e0b'};font-size:8.5px"> ${dv > 0 ? '▲' : '▼'}${Math.abs(dv).toFixed(dec)}</span>`;
    };
    const cells = [
      { l: 'Weight', v: fmt(today.weight_lbs, 1), d: delta(today.weight_lbs, baseline('weight_lbs'), true, 1), c: '#f59e0b' },
      { l: 'Sleep', v: fmt(today.sleep_total_hrs, 1) + (today.sleep_total_hrs != null ? 'h' : ''), d: delta(today.sleep_total_hrs, baseline('sleep_total_hrs'), false, 1), c: '#a78bfa' },
      { l: 'HRV', v: fmt(today.hrv_ms, 0), d: delta(today.hrv_ms, baseline('hrv_ms'), false, 0), c: '#22c55e' },
      { l: 'RHR', v: fmt(today.resting_hr_bpm, 0), d: delta(today.resting_hr_bpm, baseline('resting_hr_bpm'), true, 0), c: '#ef4444' },
      { l: 'Battery', v: fmt(today.body_battery_wake, 0), d: delta(today.body_battery_wake, baseline('body_battery_wake'), false, 0), c: '#3b82f6' },
      { l: 'Stress', v: fmt(today.stress_avg, 0), d: delta(today.stress_avg, baseline('stress_avg'), true, 0), c: '#f97316' },
      { l: 'Mood', v: mood.mood ? mood.mood + '/5' : '—', d: '', c: '#eab308' },
      { l: 'Energy', v: mood.energy ? mood.energy + '/5' : '—', d: '', c: '#14b8a6' },
    ];
    row.innerHTML = cells.map(x => `
      <div style="text-align:center;background:var(--surface2);border-radius:10px;padding:7px 2px">
        <div style="font-size:12.5px;font-weight:800;color:${x.c}">${x.v}${x.d}</div>
        <div style="font-size:8.5px;color:var(--text3);font-weight:700;letter-spacing:0.5px;text-transform:uppercase">${x.l}</div>
      </div>`).join('');
  } catch(_) {}
}

// Override sheet (1.5B advanced affordance)
function openOverrideModal() {
  document.getElementById('ovDate').value = todayKey();
  document.getElementById('ovValue').value = '';
  document.getElementById('overrideModal').classList.add('open');
}
async function saveOverride() {
  const date = document.getElementById('ovDate').value;
  const field = document.getElementById('ovField').value;
  const raw = document.getElementById('ovValue').value.trim();
  try {
    const res = await fetch('/api/wellness/override', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ date, field, value: raw === '' ? null : parseFloat(raw) })
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'failed');
    document.getElementById('overrideModal').classList.remove('open');
    showToast(raw === '' ? 'Override removed' : '✅ Override saved');
    renderReadinessCard();
    setStorage('trendsCache', null);
  } catch (e) { showToast('⚠️ ' + e.message); }
}

// Deficit dial-back (1.5F): policy strict|soft|adaptive, default soft
function applyReadinessDeficitPolicy() {
  if (!FLAGS.readinessActions) return;
  const banner = document.getElementById('readinessDeficitBanner');
  if (!banner) return;
  const rd = getStorage('readinessToday', null);
  const policy = getStorage('readinessDeficitPolicy', 'soft');
  const undone = getStorage('readinessDeficitUndo_' + todayKey(), false);
  let bump = null;
  if (rd?.date === todayKey() && policy !== 'strict' && !undone) {
    const tdee = getStorage('userTDEE', null) || TDEE;
    const base = getStorage('userMacros', null) || MACROS;
    if (rd.band === 'compromised') bump = { calories: tdee, label: `Readiness ${rd.score} (compromised) → target set to maintenance today` };
    else if (rd.band === 'guarded' && policy === 'adaptive') {
      const deficit = tdee - base.calories;
      bump = { calories: base.calories + Math.round(deficit * 0.25), label: `Readiness ${rd.score} (guarded) → deficit reduced 25% today` };
    }
  }
  setStorage('readinessDeficitBump', bump);
  if (bump) {
    document.getElementById('readinessDeficitText').textContent = '🛌 ' + bump.label;
    banner.style.display = 'flex';
  } else banner.style.display = 'none';
  scheduleRender(renderRings);
  try { updateMacroTargetsRow(); } catch(_) {}
}

function applyReadinessBump(m) {
  if (!FLAGS.readinessActions || !m) return m;
  const bump = getStorage('readinessDeficitBump', null);
  if (!bump) return m;
  const extra = bump.calories - m.calories;
  if (extra <= 0) return m;
  // Recovery-day surplus goes to carbs
  return { ...m, calories: bump.calories, carbs: m.carbs + Math.round(extra / 4), _readiness: true };
}

function undoReadinessDeficit() {
  setStorage('readinessDeficitUndo_' + todayKey(), true);
  applyReadinessDeficitPolicy();
  showToast('Keeping the normal deficit today');
}

// ── TP lifecycle banners (Tier 2, item 10) ───────────────────────────────
async function checkTPLifecycle() {
  if (!FLAGS.tpAutoRefresh || !getStorage('tpConnected', null)) return;
  try {
    const res = await fetch('/api/tp/status', { headers: authHeaders() });
    const d = await res.json();
    const expired = d.status === 'expired' || d.error === 'cookie_expired';
    setStorage('tpLifecycle', { status: expired ? 'expired' : d.status || 'active', last_refreshed_at: d.last_refreshed_at || null, expired_at: d.expired_at || null, checked: Date.now() });
    renderTPBanners();
  } catch(_) {}
}

function renderTPBanners() {
  const lc = getStorage('tpLifecycle', null);
  const expired = FLAGS.tpAutoRefresh && lc?.status === 'expired';
  for (const id of ['tpExpiredBannerLift', 'tpExpiredBannerBrief']) {
    const el = document.getElementById(id);
    if (el) el.style.display = expired ? 'block' : 'none';
  }
  const line = document.getElementById('tpLifecycleLine');
  if (line && lc) {
    line.textContent = lc.status === 'expired'
      ? `⚠️ Expired ${lc.expired_at ? Math.max(1, Math.round((Date.now() - lc.expired_at) / 86400000)) + ' day(s) ago' : ''} — paste a fresh cookie above`
      : lc.last_refreshed_at ? `Token refreshed ${new Date(lc.last_refreshed_at).toLocaleString()}` : 'Active';
    line.style.color = lc.status === 'expired' ? '#fbbf24' : '';
  }
}

// ── PWA + Web Push (Tier 2, item 9) ──────────────────────────────────────
let _swReg = null;
let _deferredInstallPrompt = null;

function initPWA() {
  if (!FLAGS.pwa || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').then(reg => {
    _swReg = reg;
    // New version ready → offer reload
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          showToast('⬆️ Update ready', () => location.reload());
        }
      });
    });
  }).catch(e => console.warn('[pwa] sw register failed:', e.message));

  // Install affordances
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    _deferredInstallPrompt = e;
    maybeShowInstallBanner('chromium');
  });
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIOS && !standalone) maybeShowInstallBanner('ios');

  // Keep server tz current (used for local-time reminders)
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && getStorage('tzSynced', '') !== tz) {
      fetch('/api/user/tz', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ tz }) })
        .then(() => setStorage('tzSynced', tz)).catch(() => {});
    }
  } catch(_) {}
}

function maybeShowInstallBanner(kind) {
  const dismissed = getStorage('installBannerDismissed', 0);
  if (Date.now() - dismissed < 30 * 86400000) return;
  const el = document.getElementById('installBanner');
  if (!el) return;
  el.style.display = 'flex';
  document.getElementById('installBannerText').textContent = kind === 'ios'
    ? 'Install: tap Share → "Add to Home Screen"'
    : 'Install Macro Tracker on your home screen';
  const btn = document.getElementById('installBannerBtn');
  btn.style.display = kind === 'ios' ? 'none' : 'inline-block';
  btn.onclick = async () => {
    if (_deferredInstallPrompt) {
      _deferredInstallPrompt.prompt();
      await _deferredInstallPrompt.userChoice;
      _deferredInstallPrompt = null;
    }
    dismissInstallBanner();
  };
}
function dismissInstallBanner() {
  setStorage('installBannerDismissed', Date.now());
  const el = document.getElementById('installBanner');
  if (el) el.style.display = 'none';
}

// ── Push subscription management ──
function _vapidToBytes(b64u) {
  const pad = '='.repeat((4 - b64u.length % 4) % 4);
  const raw = atob((b64u + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function updatePushSettingsUI() {
  if (!FLAGS.pwa) return;
  const section = document.getElementById('notifSection');
  if (!section) return;
  section.style.display = 'block';
  const toggle = document.getElementById('pushToggle');
  const line = document.getElementById('pushStatusLine');

  let subscribed = false;
  try {
    const reg = _swReg || await navigator.serviceWorker?.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    subscribed = !!sub;
  } catch(_) {}
  toggle.classList.toggle('on', subscribed);
  line.textContent = subscribed ? 'On — this device receives reminders'
    : (Notification?.permission === 'denied' ? 'Blocked in browser settings' : 'Off');

  // Reminder toggles from prefs
  try {
    const res = await fetch('/api/prefs', { headers: authHeaders() });
    const d = await res.json();
    const rem = d.prefs?.reminders || {};
    document.getElementById('remWeighinToggle').classList.toggle('on', !!rem.morning_weighin?.on);
    document.getElementById('remEveningToggle').classList.toggle('on', !!rem.evening_log?.on);
  } catch(_) {}

  // Device list
  try {
    const res = await fetch('/api/push/subscriptions', { headers: authHeaders() });
    const d = await res.json();
    const list = document.getElementById('pushDeviceList');
    list.innerHTML = (d.subscriptions || []).map(s => `
      <div style="display:flex;justify-content:space-between;align-items:center;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:8px 12px;margin-bottom:6px">
        <div>
          <div style="font-size:12px;font-weight:600">${esc(s.device_label || 'Device')}</div>
          <div style="font-size:10px;color:var(--text3)">${s.last_used_at ? 'last push ' + new Date(s.last_used_at).toLocaleDateString() : 'never used'}</div>
        </div>
        <button onclick="removePushDevice('${esc(s.endpoint).replace(/'/g, '')}')" style="background:none;border:none;color:var(--red);font-size:12px;font-weight:700;cursor:pointer">Remove</button>
      </div>`).join('');
  } catch(_) {}
}

async function togglePush(btn) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    showToast('⚠️ Push not supported here' + (/iphone|ipad/i.test(navigator.userAgent) ? ' — install to Home Screen first' : ''));
    return;
  }
  const reg = _swReg || await navigator.serviceWorker.getRegistration() || await navigator.serviceWorker.register('/sw.js');
  const existing = await reg.pushManager.getSubscription();

  if (existing) {
    try { await fetch('/api/push/unsubscribe', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ endpoint: existing.endpoint }) }); } catch(_) {}
    await existing.unsubscribe();
    showToast('🔕 Push disabled on this device');
    updatePushSettingsUI();
    return;
  }

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { showToast('⚠️ Notification permission denied'); updatePushSettingsUI(); return; }
  try {
    const vres = await fetch('/api/push/vapid', { headers: authHeaders() });
    const { key } = await vres.json();
    if (!key) throw new Error('no VAPID key on server');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: _vapidToBytes(key) });
    const j = sub.toJSON();
    const label = /iphone|ipad/i.test(navigator.userAgent) ? 'iPhone' : /android/i.test(navigator.userAgent) ? 'Android' : 'Desktop';
    await fetch('/api/push/subscribe', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys, device_label: label + ' · ' + (navigator.platform || '') })
    });
    showToast('🔔 Push enabled — try the test button');
  } catch (e) {
    showToast('⚠️ Subscribe failed: ' + e.message);
  }
  updatePushSettingsUI();
}

async function removePushDevice(endpoint) {
  try {
    await fetch('/api/push/unsubscribe', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ endpoint }) });
    const reg = _swReg || await navigator.serviceWorker?.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub && sub.endpoint === endpoint) await sub.unsubscribe();
  } catch(_) {}
  updatePushSettingsUI();
}

async function toggleReminder(kind, btn) {
  btn.classList.toggle('on');
  const on = btn.classList.contains('on');
  const defaults = { morning_weighin: '07:00', evening_log: '20:30' };
  try {
    const res = await fetch('/api/prefs', { headers: authHeaders() });
    const d = await res.json();
    const reminders = d.prefs?.reminders || {};
    reminders[kind] = { on, time: reminders[kind]?.time || defaults[kind] };
    await fetch('/api/prefs', { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ reminders }) });
    showToast(on ? '✅ Reminder on' : 'Reminder off');
  } catch (e) { showToast('⚠️ Could not save: ' + e.message); btn.classList.toggle('on'); }
}

async function sendTestPush() {
  try {
    const res = await fetch('/api/push/test', { method: 'POST', headers: authHeaders() });
    const d = await res.json();
    showToast(d.sent ? `🔔 Sent to ${d.sent} device${d.sent > 1 ? 's' : ''}` : '⚠️ No devices subscribed — enable push first');
  } catch (e) { showToast('⚠️ ' + e.message); }
}

// ── Quick-add favorites + meal-aware copy (Tier 2, item 8) ───────────────
let _favList = [];

async function renderFavChips(forceFetch) {
  if (!FLAGS.quickAdd) return;
  const wrap = document.getElementById('favChipsWrap'), row = document.getElementById('favChips');
  if (!wrap || !row) return;

  const cache = getStorage('favCache', null);
  const fresh = cache && Date.now() - cache.fetched < 24 * 3600 * 1000;
  if (cache?.favorites?.length) { _favList = cache.favorites; _paintFavChips(); }
  if (fresh && !forceFetch) return;
  try {
    const res = await fetch('/api/log/favorites', { headers: authHeaders() });
    const d = await res.json();
    if (d.ok) {
      _favList = d.favorites || [];
      setStorage('favCache', { favorites: _favList, fetched: Date.now() });
      _paintFavChips();
    }
  } catch (_) {}
}

function _paintFavChips() {
  const wrap = document.getElementById('favChipsWrap'), row = document.getElementById('favChips');
  if (!_favList.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  row.innerHTML = _favList.slice(0, 20).map((f, i) => `
    <div class="quick-food-chip" data-fi="${i}" onclick="favQuickLog(${i})">
      <div class="qfc-name">${f.pinned ? '📌 ' : ''}${esc(f.name)}</div>
      <div class="qfc-cal">${f.calories} kcal · ${Math.round(f.protein)}g pro</div>
    </div>`).join('');
  // Long-press: edit sheet (with pin toggle) instead of instant log
  row.querySelectorAll('.quick-food-chip').forEach(chip => {
    let t = null, fired = false;
    const start = () => { fired = false; t = setTimeout(() => { fired = true; favOpenEdit(parseInt(chip.dataset.fi)); }, 550); };
    const cancel = () => { if (t) clearTimeout(t); t = null; };
    chip.addEventListener('touchstart', start, { passive: true });
    chip.addEventListener('touchend', e => { cancel(); if (fired) { e.preventDefault(); } });
    chip.addEventListener('touchmove', cancel);
    chip.addEventListener('mousedown', start);
    chip.addEventListener('mouseup', cancel);
    chip.addEventListener('mouseleave', cancel);
    chip.addEventListener('click', e => { if (fired) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  });
}

function favQuickLog(i) {
  const f = _favList[i];
  if (!f) return;
  addFoodEntry({ name: f.name, calories: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat, icon: f.icon || '⚡' });
}

// Long-press → the quick-log confirm sheet with one editable item + pin toggle
let _quickLogPinKey = null;
function favOpenEdit(i) {
  const f = _favList[i];
  if (!f) return;
  _quickLogItems = [{ name: f.name, calories: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat, quality: 'full' }];
  _quickLogPinKey = f.key;
  document.getElementById('quickLogTranscript').textContent = 'Edit before logging';
  document.getElementById('quickLogLoading').style.display = 'none';
  document.getElementById('quickLogModal').classList.add('open');
  renderQuickLogSheet();
  const pinBtn = document.getElementById('quickLogPinBtn');
  if (pinBtn) {
    pinBtn.style.display = 'block';
    pinBtn.textContent = f.pinned ? '📌 Unpin from quick add' : '📌 Pin to front of quick add';
  }
}

async function toggleFavPin() {
  if (!_quickLogPinKey) return;
  const fav = _favList.find(f => f.key === _quickLogPinKey);
  const cache = getStorage('favCache', { favorites: _favList, fetched: 0 });
  let pinned = (getStorage('favPinned', null)) || _favList.filter(f => f.pinned).map(f => f.key);
  if (pinned.includes(_quickLogPinKey)) pinned = pinned.filter(k => k !== _quickLogPinKey);
  else if (pinned.length < 5) pinned.push(_quickLogPinKey);
  else { showToast('⚠️ Max 5 pinned — unpin something first'); return; }
  setStorage('favPinned', pinned);
  if (fav) fav.pinned = pinned.includes(_quickLogPinKey);
  _favList.sort((x, y) => (y.pinned - x.pinned) || (y.score - x.score));
  setStorage('favCache', { favorites: _favList, fetched: cache.fetched });
  _paintFavChips();
  try { await fetch('/api/prefs', { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ pinned_foods: pinned }) }); } catch(_) {}
  closeQuickLogModal();
  showToast(fav?.pinned ? '📌 Pinned' : 'Unpinned');
}

// Meal window helpers: breakfast <10am, lunch 10–3, dinner >3pm
function currentMealWindow() {
  const h = nowEST().getHours();
  return h < 10 ? 'breakfast' : h < 15 ? 'lunch' : 'dinner';
}
function entryMealWindow(e) {
  const m = String(e.time || '').match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h < 10 ? 'breakfast' : h < 15 ? 'lunch' : 'dinner';
}
// Most recent prior day (≤7 back) with entries in the current meal window
function findMealCopySource() {
  const all = getStorage('foodEntries', {});
  const meal = currentMealWindow();
  for (let back = 1; back <= 7; back++) {
    const d = new Date(getSelectedDateKey() + 'T12:00:00');
    d.setDate(d.getDate() - back);
    const key = dateToKey(d);
    const entries = (all[key] || []).filter(e => entryMealWindow(e) === meal);
    if (entries.length) return { key, entries, back, meal };
  }
  return null;
}

// ── Coach note (Tier 2, item 6) ──────────────────────────────────────────
async function renderCoachNote(force) {
  if (!FLAGS.briefCoach) return;
  const section = document.getElementById('greetingCoachSection');
  const body = document.getElementById('coachNoteBody');
  if (!section || !body) return;
  if (force) { section.style.display = 'block'; body.innerHTML = '<span style="color:var(--text3)">Regenerating…</span>'; }
  try {
    const res = await fetch('/api/brief/coach' + (force ? '?force=1' : ''), { headers: authHeaders() });
    const d = await res.json();
    if (!res.ok || !d.ok || !d.note) { if (!force) section.style.display = 'none'; return; }
    const chip = { keep_going: ['🟢 keep going', '#22c55e'], adjust: ['🟠 adjust', '#f59e0b'], recover: ['🔴 recover', '#ef4444'] }[d.verdict] || ['', 'var(--text2)'];
    section.style.display = 'block';
    body.innerHTML = `${esc(d.note)} <span style="font-size:10px;font-weight:700;color:${chip[1]};white-space:nowrap">${chip[0]}</span>`;
  } catch (e) { if (!force) section.style.display = 'none'; }
}

// Long-press the coach section (600ms) to force a regeneration
function initCoachLongPress() {
  const el = document.getElementById('greetingCoachSection');
  if (!el || el._lpBound) return;
  el._lpBound = true;
  let t = null;
  const start = () => { t = setTimeout(() => { t = null; renderCoachNote(true); }, 600); };
  const cancel = () => { if (t) clearTimeout(t); t = null; };
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchmove', cancel);
  el.addEventListener('mousedown', start);
  el.addEventListener('mouseup', cancel);
  el.addEventListener('mouseleave', cancel);
}

// ── Backups tile (Tier 2, item 7) ────────────────────────────────────────
async function updateBackupStatusUI() {
  if (!FLAGS.backups) return;
  const dot = document.getElementById('backupDot'), line = document.getElementById('backupStatusLine');
  if (!dot || !line) return;
  try {
    const res = await fetch('/api/backup/status', { headers: authHeaders() });
    const d = await res.json();
    if (!d.ok || !d.last) { dot.textContent = '🔴'; line.textContent = 'No backup yet — tap "Back up now"'; return; }
    const ageH = (Date.now() - d.last) / 3600000;
    dot.textContent = ageH < 36 ? '🟢' : ageH < 72 ? '🟠' : '🔴';
    const mb = (d.total_bytes / 1048576).toFixed(2);
    line.textContent = `Last: ${new Date(d.last).toLocaleString()} · ${mb} MB · nightly 8:15 UTC`;
  } catch (e) { dot.textContent = '⚪'; line.textContent = 'Status unavailable'; }
}

async function runBackupNow() {
  showToast('🗄️ Running backup…');
  try {
    const res = await fetch('/api/backup/run', { method: 'POST', headers: authHeaders() });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'backup failed');
    const total = Object.values(d.manifest.tables).reduce((s, t) => s + (t.rows || 0), 0);
    showToast(`✅ Backed up ${total.toLocaleString()} rows across ${Object.keys(d.manifest.tables).length} tables`);
    updateBackupStatusUI();
  } catch (e) { showToast('⚠️ Backup failed: ' + e.message); }
}

function updateSyncStatusUI() {
  const el = document.getElementById('syncStatusLine');
  if (!el) return;
  const last = getStorage('_syncLastOk', 0);
  const dirty = SYNC_TABLES.filter(t => getStorage('_syncDirty_' + t, 0));
  el.textContent = (!last ? 'Never synced'
    : dirty.length ? `⚠️ Pending: ${dirty.join(', ')} — retries automatically`
    : `Last synced ${new Date(last).toLocaleTimeString()}`) + ` · build ${BUILD_ID}`;
}
// ═══ End D1 log sync ═══

// ── SVG Ring ──
let ringMode = 'consumed'; // 'consumed' | 'remaining'

function setRingMode(mode) {
  ringMode = mode;
  document.getElementById('toggleConsumed').style.cssText  = `padding:5px 14px;border-radius:16px;border:none;font-family:inherit;font-size:11px;font-weight:700;cursor:pointer;transition:all 0.2s;background:${mode==='consumed'?'var(--green)':'transparent'};color:${mode==='consumed'?'#fff':'var(--text3)'}`;
  document.getElementById('toggleRemaining').style.cssText = `padding:5px 14px;border-radius:16px;border:none;font-family:inherit;font-size:11px;font-weight:700;cursor:pointer;transition:all 0.2s;background:${mode==='remaining'?'var(--blue)':'transparent'};color:${mode==='remaining'?'#fff':'var(--text3)'}`;
  renderRings();
}

function makeSVGRing(consumed, max, color, label, unit, mode) {
  const r = 36, circ = 2 * Math.PI * r;
  const remaining = Math.max(0, max - consumed);
  const over = consumed > max;

  if (mode === 'remaining') {
    const pct  = Math.min(remaining / max, 1);
    const dash = pct * circ;
    const ringColor = over ? '#ef4444' : color;
    const displayVal = over ? `-${Math.round(consumed - max)}` : (unit === 'kcal' ? Math.round(remaining) : remaining.toFixed(1).replace(/\.0$/,''));
    return `<div class="ring-wrap">
      <svg width="90" height="90" viewBox="0 0 90 90">
        <circle cx="45" cy="45" r="${r}" fill="none" stroke="#e8eaf2" stroke-width="8"/>
        <circle cx="45" cy="45" r="${r}" fill="none" stroke="${ringColor}" stroke-width="8"
          stroke-dasharray="${dash} ${circ}" stroke-linecap="round"
          transform="rotate(-90 45 45)" style="transition:stroke-dasharray 0.5s ease"/>
        <text x="45" y="41" text-anchor="middle" fill="${over?'#ef4444':'#eef0f6'}" font-size="12" font-weight="700" font-family="Plus Jakarta Sans,sans-serif">${displayVal}</text>
        <text x="45" y="55" text-anchor="middle" fill="#4d5468" font-size="9" font-family="Plus Jakarta Sans,sans-serif">${unit} left</text>
      </svg>
      <div class="ring-lbl" style="color:${ringColor}">${label}</div>
    </div>`;
  } else {
    const pct  = Math.min(consumed / max, 1);
    const dash = pct * circ;
    const ringColor = over ? '#ef4444' : color;
    const displayVal = unit === 'kcal' ? Math.round(consumed) : (Number.isInteger(consumed) ? consumed : consumed.toFixed(1).replace(/\.0$/,''));
    return `<div class="ring-wrap">
      <svg width="90" height="90" viewBox="0 0 90 90">
        <circle cx="45" cy="45" r="${r}" fill="none" stroke="#e8eaf2" stroke-width="8"/>
        <circle cx="45" cy="45" r="${r}" fill="none" stroke="${ringColor}" stroke-width="8"
          stroke-dasharray="${dash} ${circ}" stroke-linecap="round"
          transform="rotate(-90 45 45)" style="transition:stroke-dasharray 0.5s ease"/>
        <text x="45" y="41" text-anchor="middle" fill="#eef0f6" font-size="13" font-weight="700" font-family="Plus Jakarta Sans,sans-serif">${displayVal}</text>
        <text x="45" y="55" text-anchor="middle" fill="#4d5468" font-size="9" font-family="Plus Jakarta Sans,sans-serif">${unit}</text>
      </svg>
      <div class="ring-lbl" style="color:${ringColor}">${label}</div>
    </div>`;
  }
}

function renderWeekStrip() {
  const todayDow = nowEST().getDay();
  const typeColors = { lift:'#22c55e', run:'#3b82f6', rest:'#4d5468', optional:'#8b5cf6', longrun:'#f59e0b', recoveryrun:'#06b6d4' };
  const typeBg     = { lift:'#0d2d1a', run:'#0d1e3d', rest:'#1a1d26', optional:'#1a1030', longrun:'#2d1f05', recoveryrun:'#051e26' };
  const typeIcons  = { lift:'🏋️', run:'🏃', rest:'😴', optional:'🏋️', longrun:'🏃', recoveryrun:'🚶' };

  const nowE = nowEST();
  const dow  = nowE.getDay();
  const diffToMon = (dow === 0 ? -6 : 1 - dow);
  const weekKeys = WEEK.map((s, i) => {
    const d = nowEST();
    d.setDate(nowE.getDate() + diffToMon + i);
    return dateToKey(d);
  });

  document.getElementById('weekStrip').innerHTML = WEEK.map((s, i) => {
    const isToday    = DAY_MAP[s.day] === todayDow;
    const isSelected = weekKeys[i] === getSelectedDateKey();
    const c   = typeColors[s.type];
    const bg  = isToday ? typeBg[s.type] : 'var(--surface)';
    const border = isToday ? c + '60' : 'var(--border)';

    const subLabel = s.type === 'optional'
      ? `<div class="week-day-sess" style="color:#8b5cf6">OPT</div>`
      : s.type === 'longrun' && s.optLift
        ? `<div class="week-day-sess" style="color:#f59e0b">LONG</div><div style="font-size:7px;color:#8b5cf6;font-weight:800;margin-top:1px">+B OPT</div>`
      : s.type === 'longrun'
        ? `<div class="week-day-sess" style="color:#f59e0b">LONG</div>`
      : s.type === 'recoveryrun'
        ? `<div class="week-day-sess" style="color:#06b6d4">EASY</div>`
      : s.sess && s.type === 'lift'
        ? `<div class="week-day-sess" style="color:${c}">${s.sess}</div>`
      : `<div style="height:13px"></div>`;

    const selectedClass = isSelected ? ' selected' : (isToday ? ' today-card' : '');

    return `<div class="week-day${selectedClass}" style="background:${bg};border-color:${border};" onclick="setSelectedDay('${weekKeys[i]}')">
      <div class="week-day-name${isToday ? ' active-name' : ''}" style="${isToday ? `color:${c}` : ''}">${s.day}</div>
      <div class="week-day-icon">${typeIcons[s.type]}</div>
      ${subLabel}
    </div>`;
  }).join('');
}

function logMacros() {
  const cals = parseFloat(document.getElementById('in-calories').value) || 0;
  const prot = parseFloat(document.getElementById('in-protein').value)  || 0;
  const carbs= parseFloat(document.getElementById('in-carbs').value)    || 0;
  const fat  = parseFloat(document.getElementById('in-fat').value)      || 0;
  if (!cals && !prot && !carbs && !fat) { showToast('⚠️ Enter at least one value'); return; }
  const name = document.getElementById('manualFoodName').value.trim() || 'Manual Entry';
  addFoodEntry({ name, calories: cals, protein: prot, carbs, fat, icon: '✍️' });
  ['calories','protein','carbs','fat'].forEach(k => document.getElementById('in-'+k).value = '');
}

// ── Workout Page — Per-Set Logging ──
let currentSets = {};
let currentRPE  = {};

function getLastWorkout(sessKey, exIdx) {
  const liftLog = getStorage('liftLog2', {});
  const keys = Object.keys(liftLog)
    .filter(k => k.endsWith('-' + sessKey))
    .sort().reverse();
  if (!keys.length) return null;
  return liftLog[keys[0]]?.exercises?.[exIdx] || null;
}

function getSuggestedWeight(lastSets, targetReps, lastRPE) {
  if (!lastSets || !lastSets.length) return null;
  const completed = lastSets.filter(s => s.done && parseFloat(s.weight) > 0);
  if (!completed.length) return null;
  const avgWt = completed.reduce((s, x) => s + parseFloat(x.weight), 0) / completed.length;
  const rpe = lastRPE || 8;
  let mult = 1.0;
  if      (rpe <= 6)  mult = 1.05;
  else if (rpe === 7) mult = 1.025;
  else if (rpe === 8) mult = 1.0;
  else if (rpe === 9) mult = 0.975;
  else                mult = 0.95;
  return Math.round((avgWt * mult) / 2.5) * 2.5;
}

// ══════════════════════════════════════════════════════════
// WORKOUT ENGINE v2 — Timer · Rest · Set Types · PR · Charts
// ══════════════════════════════════════════════════════════

// ── Globals ──────────────────────────────────────────────────
let workoutTimerInterval = null;
let workoutStartTime     = null;
let restTimerTimeout     = null;
let restTimerInterval    = null;
let restTimerEnd         = null;
let currentRestDuration  = 90; // seconds

// ── PR Store ─────────────────────────────────────────────────
function getPRs() { return getStorage('liftPRs', {}); }
function savePRs(prs) { setStorage('liftPRs', prs); }

function checkAndUpdatePR(exName, weight, reps) {
  const prs  = getPRs();
  const key  = exName.toLowerCase().replace(/\s+/g, '_');
  const w    = parseFloat(weight) || 0;
  const r    = parseInt(reps)     || 0;
  if (!w || !r) return false;
  // Epley 1RM estimate
  const est1rm = w * (1 + r / 30);
  const prev   = prs[key] || { weight: 0, reps: 0, est1rm: 0 };
  if (est1rm > (prev.est1rm || 0)) {
    prs[key] = { weight: w, reps: r, est1rm: Math.round(est1rm * 10) / 10, date: todayKey() };
    savePRs(prs);
    return { weight: w, reps: r, est1rm: Math.round(est1rm) };
  }
  return false;
}

function flashPR(exName, pr) {
  document.querySelectorAll('.pr-flash').forEach(e => e.remove());
  const el = document.createElement('div');
  el.className = 'pr-flash';
  el.innerHTML = `<div class="pr-flash-icon">🏆</div>
    <div>
      <div class="pr-flash-text">New PR — ${esc(exName)}!</div>
      <div class="pr-flash-sub">${pr.weight} lbs × ${pr.reps} reps · ~${pr.est1rm} lbs 1RM</div>
    </div>`;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.4s'; setTimeout(() => el.remove(), 400); }, 3500);
}

// ── Workout Timer ─────────────────────────────────────────────
function startWorkoutTimer() {
  if (workoutTimerInterval) return; // already running
  if (!workoutStartTime) workoutStartTime = Date.now();
  workoutTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - workoutStartTime) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    const el = document.getElementById('workoutTimerDisplay');
    if (el) el.textContent = `${m}:${s.toString().padStart(2,'0')}`;
  }, 1000);
}

function stopWorkoutTimer() {
  clearInterval(workoutTimerInterval);
  workoutTimerInterval = null;
}

function getWorkoutDuration() {
  if (!workoutStartTime) return 0;
  return Math.floor((Date.now() - workoutStartTime) / 1000);
}

function resetWorkoutTimer() {
  stopWorkoutTimer();
  workoutStartTime = null;
  const el = document.getElementById('workoutTimerDisplay');
  if (el) el.textContent = '0:00';
}

function updateTimerStats() {
  // Count done sets and total volume across all exercises
  let totalDone = 0, totalVol = 0;
  Object.values(currentSets).forEach(sets => {
    sets.forEach(s => {
      if (s.done) {
        totalDone++;
        totalVol += (parseFloat(s.weight) || 0) * (parseInt(s.reps) || 0);
      }
    });
  });
  const sd = document.getElementById('timerSetsCount');
  const vd = document.getElementById('timerVolumeCount');
  if (sd) sd.textContent = totalDone;
  if (vd) vd.textContent = totalVol >= 1000 ? (totalVol / 1000).toFixed(1) + 'k' : Math.round(totalVol);
}

// ── Rest Timer ────────────────────────────────────────────────
function startRestTimer(seconds) {
  clearTimeout(restTimerTimeout);
  clearInterval(restTimerInterval);
  const overlay = document.getElementById('restTimerOverlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  restTimerEnd = Date.now() + seconds * 1000;
  const totalMs = seconds * 1000;

  function tick() {
    const remaining = Math.max(0, Math.ceil((restTimerEnd - Date.now()) / 1000));
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    const countEl = document.getElementById('restTimerCount');
    const barEl   = document.getElementById('restTimerBarFill');
    if (countEl) countEl.textContent = `${m}:${s.toString().padStart(2,'0')}`;
    const pct = (restTimerEnd - Date.now()) / totalMs;
    if (barEl) barEl.style.width = Math.max(0, pct * 100) + '%';
  }
  tick();
  restTimerInterval = setInterval(() => {
    tick();
    if (Date.now() >= restTimerEnd) {
      clearInterval(restTimerInterval);
      overlay.style.display = 'none';
      // Vibrate if available
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      showToast('⏰ Rest complete — next set!');
    }
  }, 500);
}

function skipRestTimer() {
  clearTimeout(restTimerTimeout);
  clearInterval(restTimerInterval);
  const overlay = document.getElementById('restTimerOverlay');
  if (overlay) overlay.style.display = 'none';
}

// ── Set Type Management ───────────────────────────────────────
const SET_TYPES = {
  normal:  { label: 'W',   title: 'Normal',   cls: '',        desc: 'Working set' },
  warmup:  { label: 'W',   title: 'Warm-up',  cls: 'warmup',  desc: 'Not counted in volume' },
  drop:    { label: 'D',   title: 'Drop Set', cls: 'drop',    desc: 'Reduce weight, continue' },
  failure: { label: 'F',   title: 'Failure',  cls: 'failure', desc: 'Train to failure' },
};

let _setTypeMenuKey = null;
let _setTypeMenuIdx = null;

function openSetTypeMenu(key, si, btnEl) {
  closeSetTypeMenu();
  _setTypeMenuKey = key;
  _setTypeMenuIdx = si;
  const menu = document.createElement('div');
  menu.id = 'setTypeMenu';
  menu.className = 'set-type-menu';
  menu.innerHTML = Object.entries(SET_TYPES).map(([type, info]) =>
    `<div class="set-type-option" onclick="applySetType('${key}',${si},'${type}')">
      <span style="font-size:11px;font-weight:800;width:20px;color:${type==='warmup'?'#06b6d4':type==='drop'?'#a78bfa':type==='failure'?'#f87171':'var(--text3)'}">${info.title.slice(0,1)}</span>
      <div>
        <div style="font-size:13px;font-weight:700;color:var(--text)">${info.title}</div>
        <div style="font-size:10px;color:var(--text3)">${info.desc}</div>
      </div>
    </div>`
  ).join('');
  const rect = btnEl.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = Math.max(8, rect.left - 120) + 'px';
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', closeSetTypeMenuOutside), 10);
}

function closeSetTypeMenuOutside(e) {
  const menu = document.getElementById('setTypeMenu');
  if (menu && !menu.contains(e.target)) closeSetTypeMenu();
}

function closeSetTypeMenu() {
  const menu = document.getElementById('setTypeMenu');
  if (menu) menu.remove();
  document.removeEventListener('click', closeSetTypeMenuOutside);
}

function applySetType(key, si, type) {
  if (!currentSets[key]) return;
  currentSets[key][si].type = type;
  closeSetTypeMenu();
  // Re-render just the type button
  const btn = document.getElementById(`stype-${key}-${si}`);
  if (btn) {
    const info = SET_TYPES[type];
    btn.textContent = type === 'normal' ? (si + 1) : type.slice(0,1).toUpperCase();
    btn.className = 'set-type-btn ' + (info.cls || '');
    btn.title = info.title;
  }
  refreshExVolume(key);
}

// ── Add / Remove Sets ──────────────────────────────────────────
function addSetToExercise(key) {
  if (!currentSets[key]) currentSets[key] = [];
  const sets = currentSets[key];
  const lastSet = sets[sets.length - 1];
  sets.push({ weight: lastSet?.weight || '', reps: '', done: false, type: 'normal' });
  // Re-render the set rows section only
  const card = document.getElementById(`excard-${key}`);
  if (!card) return;
  const [sessKey, exIdxStr] = key.split('-');
  const ex = PROGRAM[sessKey]?.exercises?.[parseInt(exIdxStr)];
  const lastData = getLastWorkout(sessKey, parseInt(exIdxStr));
  const lastSets = lastData?.sets || null;
  const suggested = getSuggestedWeight(lastSets, ex?.reps, lastData?.rpe);
  // Replace set rows container
  const rowsContainer = card.querySelector('.set-rows');
  if (rowsContainer) rowsContainer.outerHTML = buildJustSetRows(key, ex?.reps || '8');
  else card.querySelector('.set-col-headers')?.insertAdjacentHTML('afterend', `<div class="set-rows">${buildOneSetRow(key, sets.length - 1, ex?.reps)}</div>`);
  refreshExVolume(key);
}

function removeSetFromExercise(key, si) {
  if (!currentSets[key] || currentSets[key].length <= 1) return;
  currentSets[key].splice(si, 1);
  const card = document.getElementById(`excard-${key}`);
  if (!card) return;
  const [sessKey, exIdxStr] = key.split('-');
  const ex = PROGRAM[sessKey]?.exercises?.[parseInt(exIdxStr)];
  const rowsContainer = card.querySelector('.set-rows');
  if (rowsContainer) rowsContainer.outerHTML = buildJustSetRows(key, ex?.reps || '8');
  refreshExVolume(key);
}

function buildJustSetRows(key, targetReps) {
  const sets = currentSets[key] || [];
  const rows = sets.map((s, si) => buildOneSetRow(key, si, targetReps)).join('');
  return `<div class="set-rows">${rows}</div>`;
}

function buildOneSetRow(key, si, targetReps) {
  const s = (currentSets[key] || [])[si];
  if (!s) return '';
  const type = s.type || 'normal';
  const info = SET_TYPES[type];
  const typeLabel = type === 'normal' ? (si + 1) : type.slice(0,1).toUpperCase();
  const isWarmup  = type === 'warmup';
  return `<div class="set-row" id="setrow-${key}-${si}">
    <button class="set-type-btn ${info?.cls||''}" id="stype-${key}-${si}" title="${info?.title||'Normal'}"
      onclick="openSetTypeMenu('${key}',${si},this)">${typeLabel}</button>
    <input class="set-weight-input${s.done?' completed':''}${isWarmup?' warmup-input':''}" type="number" id="sw-${key}-${si}"
      placeholder="0" value="${s.weight}"
      oninput="updateSet('${key}',${si},'weight',this.value)" style="${isWarmup?'opacity:0.6;':''}" />
    <input class="set-reps-input" type="number" id="sr-${key}-${si}"
      placeholder="${(targetReps+'').split('–')[0]||'8'}" value="${s.reps}"
      oninput="updateSet('${key}',${si},'reps',this.value)" />
    <button class="set-done-btn${s.done?' done':''}" id="sdb-${key}-${si}"
      onclick="toggleSetDone('${key}',${si})">${s.done?'✅':'○'}</button>
    <button class="btn-del-set" onclick="removeSetFromExercise('${key}',${si})" title="Remove set">✕</button>
  </div>`;
}

// ── Updated buildSetRows ──────────────────────────────────────
function buildSetRows(sessKey, exIdx, numSets, targetReps, lastSets, suggested, lastRPE) {
  const key = `${sessKey}-${exIdx}`;
  const ex  = PROGRAM[sessKey]?.exercises?.[exIdx];
  if (!currentSets[key]) {
    currentSets[key] = Array.from({ length: numSets }, () => ({
      weight: suggested ? String(suggested) : '',
      reps: '', done: false, type: 'normal',
    }));
  }
  currentRPE[key] = currentRPE[key] || lastRPE || 8;
  const sets = currentSets[key];

  // Previous session summary
  let suggestionHtml = '';
  if (lastSets && lastSets.length) {
    const done = lastSets.filter(s => s.done);
    const lastWeights = done.map(s => s.weight + ' lbs').join(', ') || '—';
    const lastRepsStr = done.map(s => s.reps + ' reps').join(', ')  || '—';
    const trend = suggested && parseFloat(done[0]?.weight) > 0
      ? (suggested > parseFloat(done[0].weight) ? '↑ ' : suggested < parseFloat(done[0].weight) ? '↓ ' : '') : '';
    const prs   = getPRs();
    const prKey = (ex?.name || '').toLowerCase().replace(/\s+/g, '_');
    const prData = prs[prKey];
    const prStr  = prData ? ` · 🏆 PR: ${prData.weight}×${prData.reps}` : '';
    suggestionHtml = `<div class="ex-suggestion" onclick="openExChart('${(ex?.name||'').replace(/'/g,"\'")}')">
      <span style="font-size:15px">🧠</span>
      <div class="ex-suggestion-text">
        Last: <strong>${lastWeights}</strong> · ${lastRepsStr}${lastRPE ? ' · RPE '+lastRPE : ''}${prStr}<br>
        ${suggested ? `Target: <strong>${trend}${suggested} lbs</strong>` : 'No suggestion yet'} <span style="font-size:10px;color:#60a5fa">· tap for chart →</span>
      </div></div>`;
  } else {
    suggestionHtml = `<div class="ex-suggestion">
      <span style="font-size:15px">💡</span>
      <div class="ex-suggestion-text">First session — enter your starting weight. Data builds over time.</div></div>`;
  }

  // Exercise notes shown inline during session
  const notesHtml = ex?.notes ? `<div style="font-size:11px;color:#60a5fa;background:#0d1e3d;border-radius:10px;padding:7px 10px;margin-bottom:10px;border:1px solid #1e3a5f">💬 ${ex.notes}</div>` : '';

  const colHeaders = `<div class="set-col-headers" style="margin-top:6px">
    <div class="set-col-lbl" style="width:32px">Type</div>
    <div class="set-col-lbl" style="flex:1;text-align:center">Weight (lbs)</div>
    <div class="set-col-lbl" style="width:54px;text-align:center">Reps</div>
    <div class="set-col-lbl" style="width:36px;text-align:center">✓</div>
    <div class="set-col-lbl" style="width:28px"></div>
  </div>`;

  const setRowsHtml = sets.map((s, si) => buildOneSetRow(key, si, targetReps)).join('');

  const rpeHtml = `<div style="font-size:10px;font-weight:700;color:var(--text3);letter-spacing:0.8px;text-transform:uppercase;margin-top:12px;margin-bottom:5px">How hard? (RPE)</div>
    <div class="rpe-row" id="rpe-${key}">
      ${[5,6,7,8,9,10].map(r =>
        `<button class="rpe-btn${currentRPE[key]===r?' active':''}" onclick="setRPE('${key}',${r})">${r}</button>`
      ).join('')}
    </div>`;

  const addSetBtn = `<button class="btn-add-set" onclick="addSetToExercise('${key}')">+ Add Set</button>`;

  const completedSets = sets.filter(s => s.done && parseFloat(s.weight) > 0 && s.type !== 'warmup');
  const totalVol = completedSets.reduce((sum, s) => sum + parseFloat(s.weight) * (parseInt(s.reps)||0), 0);
  const volHtml = completedSets.length
    ? `<div class="ex-volume">Volume: <span>${Math.round(totalVol).toLocaleString()} lbs</span> · ${completedSets.length}/${sets.filter(s=>s.type!=='warmup').length} sets</div>` : '';

  return notesHtml + suggestionHtml + colHeaders + `<div class="set-rows">${setRowsHtml}</div>` + addSetBtn + rpeHtml + volHtml;
}

function updateSet(key, si, field, val) {
  if (!currentSets[key]) return;
  currentSets[key][si][field] = val;
  refreshExVolume(key);
  updateTimerStats();
}

function refreshExVolume(key) {
  const sets = currentSets[key] || [];
  const done = sets.filter(s => s.done && parseFloat(s.weight) > 0 && s.type !== 'warmup');
  const vol  = done.reduce((sum, s) => sum + parseFloat(s.weight) * (parseInt(s.reps)||0), 0);
  const card = document.getElementById(`excard-${key}`);
  if (!card) return;
  let el = card.querySelector('.ex-volume');
  if (!el) { el = document.createElement('div'); el.className = 'ex-volume'; card.appendChild(el); }
  const allWorking = sets.filter(s => s.type !== 'warmup');
  el.innerHTML = done.length
    ? `Volume: <span>${Math.round(vol).toLocaleString()} lbs</span> · ${done.length}/${allWorking.length} sets`
    : '';
  updateTimerStats();
}

function toggleSetDone(key, si) {
  if (!currentSets[key]) return;
  const set = currentSets[key][si];
  const wtInput   = document.getElementById(`sw-${key}-${si}`);
  const repsInput = document.getElementById(`sr-${key}-${si}`);
  if (wtInput   && !set.weight) set.weight = wtInput.value   || wtInput.placeholder;
  if (repsInput && !set.reps)   set.reps   = repsInput.value || repsInput.placeholder;
  set.done = !set.done;
  const btn  = document.getElementById(`sdb-${key}-${si}`);
  const wtEl = document.getElementById(`sw-${key}-${si}`);
  if (btn)  { btn.textContent = set.done ? '✅' : '○'; btn.classList.toggle('done', set.done); }
  if (wtEl) { if (set.weight) wtEl.value = set.weight; wtEl.classList.toggle('completed', set.done); }
  const badge = document.getElementById(`exbadge-${key}`);
  if (badge) badge.classList.toggle('done', currentSets[key].every(s => s.done));
  refreshExVolume(key);

  if (set.done) {
    // Check PR
    const [sessKey, exIdxStr] = key.split('-');
    const ex = PROGRAM[sessKey]?.exercises?.[parseInt(exIdxStr)];
    if (ex && set.type !== 'warmup') {
      const pr = checkAndUpdatePR(ex.name, set.weight, set.reps);
      if (pr) flashPR(ex.name, pr);
    }
    // Start rest timer (skip for warmup sets)
    if (set.type !== 'warmup') {
      const dur = set.type === 'drop' ? 45 : (parseInt(key.split('-')[1]) === 0 ? 120 : 90);
      startRestTimer(dur);
    }
    updateTimerStats();
  } else {
    skipRestTimer();
  }
}

function setRPE(key, val) {
  currentRPE[key] = val;
  const row = document.getElementById(`rpe-${key}`);
  if (!row) return;
  row.querySelectorAll('.rpe-btn').forEach(b => b.classList.toggle('active', parseInt(b.textContent) === val));
}

// ── renderWorkoutPage ─────────────────────────────────────────

const EXERCISE_LIBRARY = {
  'Chest': [
    { name: 'Barbell Bench Press',     reps: '6–8',   notes: 'Primary chest builder' },
    { name: 'Incline Barbell Press',   reps: '8–10',  notes: 'Upper chest focus' },
    { name: 'Incline Dumbbell Press',  reps: '8–10',  notes: '' },
    { name: 'Dumbbell Fly',            reps: '12–15', notes: 'Light, full stretch' },
    { name: 'Cable Fly',               reps: '12–15', notes: '' },
    { name: 'Dip',                     reps: '8–12',  notes: 'Lean forward for chest' },
    { name: 'Push-Up',                 reps: '15–20', notes: '' },
    { name: 'Pec Deck',                reps: '12–15', notes: '' },
  ],
  'Back': [
    { name: 'Barbell Row',             reps: '6–8',   notes: 'Brace core hard' },
    { name: 'Deadlift',                reps: '3–5',   notes: 'Hip hinge, brace, drive' },
    { name: 'Lat Pulldown',            reps: '8–10',  notes: '' },
    { name: 'Seated Cable Row',        reps: '10–12', notes: '' },
    { name: 'Pull-Up',                 reps: '6–10',  notes: 'Full ROM' },
    { name: 'Chin-Up',                 reps: '6–10',  notes: 'Supinated grip' },
    { name: 'Single-Arm DB Row',       reps: '10–12', notes: '' },
    { name: 'Face Pulls',              reps: '15–20', notes: 'Shoulder health essential' },
    { name: 'Straight-Arm Pulldown',   reps: '12–15', notes: '' },
  ],
  'Shoulders': [
    { name: 'Overhead Press',          reps: '6–8',   notes: 'Seated or standing' },
    { name: 'Dumbbell Shoulder Press', reps: '8–10',  notes: '' },
    { name: 'Lateral Raises',          reps: '12–15', notes: 'Light, controlled' },
    { name: 'Front Raises',            reps: '12–15', notes: '' },
    { name: 'Rear Delt Fly',           reps: '15–20', notes: '' },
    { name: 'Arnold Press',            reps: '10–12', notes: '' },
    { name: 'Upright Row',             reps: '10–12', notes: '' },
    { name: 'Shrugs',                  reps: '12–15', notes: '' },
  ],
  'Triceps': [
    { name: 'Tricep Pushdowns',        reps: '10–12', notes: '' },
    { name: 'Overhead Tricep Ext.',    reps: '10–12', notes: '' },
    { name: 'Skull Crushers',          reps: '10–12', notes: '' },
    { name: 'Close-Grip Bench',        reps: '8–10',  notes: '' },
    { name: 'Cable Kickbacks',         reps: '12–15', notes: '' },
    { name: 'Dip (Tricep Focus)',      reps: '10–15', notes: 'Upright torso' },
  ],
  'Biceps': [
    { name: 'Barbell Curl',            reps: '8–10',  notes: '' },
    { name: 'Hammer Curl',             reps: '10–12', notes: '' },
    { name: 'Incline DB Curl',         reps: '10–12', notes: 'Full stretch' },
    { name: 'Preacher Curl',           reps: '10–12', notes: '' },
    { name: 'Cable Curl',              reps: '12–15', notes: '' },
    { name: 'Concentration Curl',      reps: '12–15', notes: '' },
  ],
  'Legs': [
    { name: 'Barbell Squat',           reps: '6–8',   notes: 'Prioritize depth & form' },
    { name: 'Romanian Deadlift',       reps: '8–10',  notes: 'Hip hinge focus' },
    { name: 'Leg Press',               reps: '10–12', notes: '' },
    { name: 'Leg Curl',                reps: '10–12', notes: '' },
    { name: 'Leg Extension',           reps: '12–15', notes: '' },
    { name: 'Calf Raise',              reps: '15–20', notes: '' },
    { name: 'Bulgarian Split Squat',   reps: '8–10',  notes: 'Each leg' },
    { name: 'Hack Squat',              reps: '10–12', notes: '' },
    { name: 'Walking Lunge',           reps: '12–15', notes: 'Each leg' },
    { name: 'Hip Thrust',              reps: '10–12', notes: '' },
  ],
  'Core': [
    { name: 'Plank',                   reps: '45–60s', notes: '' },
    { name: 'Cable Crunch',            reps: '15–20', notes: '' },
    { name: 'Hanging Leg Raise',       reps: '12–15', notes: '' },
    { name: 'Ab Wheel',                reps: '10–15', notes: '' },
    { name: 'Russian Twist',           reps: '20',    notes: '' },
    { name: 'Side Plank',              reps: '30–45s', notes: 'Each side' },
    { name: 'Dead Bug',                reps: '10–12', notes: '' },
  ],
  'Cardio / Conditioning': [
    { name: 'Treadmill',               reps: '20–30 min', notes: '' },
    { name: 'Rowing Machine',          reps: '15–20 min', notes: '' },
    { name: 'Kettlebell Swing',        reps: '15–20', notes: '' },
    { name: 'Box Jump',                reps: '8–10',  notes: '' },
    { name: 'Battle Ropes',            reps: '30–45s', notes: '' },
    { name: 'Sled Push',               reps: '4×20m', notes: '' },
  ],
};

// Session-specific exercise overrides (added/removed during session)
let sessionExOverrides = {}; // { 'A': [{name,sets,reps,notes,added:true}, ...] }
// Tracks removed program exercises by session+index: { 'A': [0,2] }
let sessionExRemoved = {};

function getSessionExercises(sessKey) {
  const base = PROGRAM[sessKey].exercises
    .map((ex, i) => ({ ...ex, _progIdx: i, _added: false }))
    .filter((ex, i) => !(sessionExRemoved[sessKey] || []).includes(i));
  const added = (sessionExOverrides[sessKey] || []);
  return [...base, ...added];
}


function openAddExerciseModal() {
  const sessKey = activeSession;
  // Get rep scheme from current session to suggest sets
  const sessName = PROGRAM[sessKey].name;

  const overlay = document.createElement('div');
  overlay.id = '_addExOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;flex-direction:column;overflow:hidden';

  // Build category HTML
  const cats = Object.keys(EXERCISE_LIBRARY);
  overlay.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;background:#0f172a;border-bottom:1px solid #1e293b;flex-shrink:0">
      <button onclick="document.body.removeChild(document.getElementById('_addExOverlay'))"
        style="background:#1e293b;border:none;border-radius:10px;color:#94a3b8;font-size:18px;width:36px;height:36px;cursor:pointer;font-family:inherit">✕</button>
      <div>
        <div style="font-size:16px;font-weight:700;color:#fff">Add Exercise</div>
        <div style="font-size:11px;color:#64748b">${PROGRAM[sessKey].name}</div>
      </div>
    </div>
    <div style="padding:10px 14px;background:#0f172a;flex-shrink:0">
      <input id="_exSearch" type="text" placeholder="Search exercises…"
        style="width:100%;background:#1e293b;border:1.5px solid #334155;border-radius:12px;padding:10px 14px;color:#fff;font-size:14px;outline:none;font-family:inherit;box-sizing:border-box"
        oninput="clearTimeout(window._exSearchTimer);window._exSearchTimer=setTimeout(()=>filterExercises(this.value),150)"/>
    </div>
    <div id="_exLibraryList" style="flex:1;overflow-y:auto;padding:8px 14px 80px">
      ${cats.map(cat => `
        <div class="_exCatSection">
          <div style="font-size:10px;font-weight:700;color:#475569;letter-spacing:1.5px;text-transform:uppercase;padding:10px 0 6px">${cat}</div>
          ${EXERCISE_LIBRARY[cat].map(ex => `
            <div class="_exRow" data-name="${ex.name}" data-cat="${cat}" data-reps="${ex.reps}" data-notes="${ex.notes || ''}"
              onclick="selectExerciseToAdd('${ex.name.replace(/'/g,"\'")}','${ex.reps}','${ex.notes.replace(/'/g,"\'")||''}')"
              style="display:flex;align-items:center;justify-content:space-between;padding:11px 12px;margin-bottom:4px;background:#111827;border-radius:12px;cursor:pointer;border:1px solid #1e293b">
              <div>
                <div style="font-size:13px;font-weight:600;color:#f1f5f9">${ex.name}</div>
                <div style="font-size:11px;color:#64748b;margin-top:2px">3 sets · ${ex.reps} reps${ex.notes ? ' · ' + ex.notes : ''}</div>
              </div>
              <div style="font-size:20px;color:#22c55e;font-weight:300">+</div>
            </div>
          `).join('')}
        </div>
      `).join('')}
    </div>`;

  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById('_exSearch').focus(), 100);
}

function filterExercises(q) {
  q = q.toLowerCase().trim();
  document.querySelectorAll('._exRow').forEach(row => {
    const name = row.dataset.name.toLowerCase();
    const cat  = row.dataset.cat.toLowerCase();
    row.style.display = (!q || name.includes(q) || cat.includes(q)) ? '' : 'none';
  });
  document.querySelectorAll('._exCatSection').forEach(sec => {
    const rows = sec.querySelectorAll('._exRow');
    const anyVisible = [...rows].some(r => r.style.display !== 'none');
    sec.style.display = anyVisible ? '' : 'none';
  });
}

function selectExerciseToAdd(name, reps, notes) {
  const sessKey = activeSession;
  if (!sessionExOverrides[sessKey]) sessionExOverrides[sessKey] = [];
  // Check not already in session
  const existing = getSessionExercises(sessKey);
  if (existing.some(e => e.name === name)) {
    showToast('⚠️ Already in this session');
    return;
  }
  sessionExOverrides[sessKey].push({ name, sets: 3, reps, notes, _added: true });
  // Close modal
  const ov = document.getElementById('_addExOverlay');
  if (ov) document.body.removeChild(ov);
  showToast('✅ ' + name + ' added!');
  renderWorkoutPage();
}

function removeExercise(sessKey, progIdx, isAdded, addedName) {
  if (isAdded) {
    // Remove from overrides
    if (sessionExOverrides[sessKey]) {
      sessionExOverrides[sessKey] = sessionExOverrides[sessKey].filter(e => e.name !== addedName);
    }
  } else {
    // Mark program exercise as removed
    if (!sessionExRemoved[sessKey]) sessionExRemoved[sessKey] = [];
    if (!sessionExRemoved[sessKey].includes(progIdx)) sessionExRemoved[sessKey].push(progIdx);
  }
  renderWorkoutPage();
}

function renderWorkoutPage() {
  // Start timer if not running
  startWorkoutTimer();

  document.getElementById('sessionTabs').innerHTML = ['A','B','C'].map(k =>
    `<button class="sess-btn ${activeSession===k?'active':''}" onclick="setSession('${k}')">${k}<br><span style="font-size:9px">${PROGRAM[k].name.split(' ').slice(0,2).join(' ')}</span></button>`
  ).join('');

  const sess = PROGRAM[activeSession];
  document.getElementById('sessionHeader').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="font-size:20px;font-weight:700;letter-spacing:-0.3px;color:var(--text)">${esc(sess.name)}</div>
        <div style="font-size:11px;color:var(--text2);margin-top:4px;font-weight:500">Tap set type to change · ✅ = mark done · + Add Set</div>
      </div>
      <span style="display:inline-block;padding:5px 14px;border-radius:20px;font-size:11px;font-weight:700;background:#0d2d1a;color:#22c55e">3×/wk</span>
    </div>`;

  const allExercises = getSessionExercises(activeSession);
  document.getElementById('exerciseList').innerHTML = allExercises.map((ex, i) => {
    const key       = `${activeSession}-${i}`;
    const lastData  = ex._added ? null : getLastWorkout(activeSession, ex._progIdx);
    const lastSets  = lastData?.sets  || null;
    const lastRPE   = lastData?.rpe   || null;
    const suggested = getSuggestedWeight(lastSets, ex.reps, lastRPE);
    const removeCall = ex._added
      ? `removeExercise('${activeSession}', -1, true, '${ex.name.replace(/'/g,"\\'")}')`
      : `removeExercise('${activeSession}', ${ex._progIdx}, false, '')`;
    const addedBadge = ex._added ? ' <span style="font-size:9px;background:#1e3a5f;color:#60a5fa;border-radius:6px;padding:2px 6px;font-weight:700;margin-left:4px">+ADDED</span>' : '';
    return `<div class="ex-card" id="excard-${key}">
      <div class="ex-header" style="display:flex;align-items:center">
        <div style="cursor:pointer;display:flex;align-items:center;flex:1;gap:8px" onclick="openExChart('${ex.name.replace(/'/g,"\\'")}')">
          <div class="ex-badge" id="exbadge-${key}">${i+1}</div>
          <div style="flex:1">
            <div class="ex-name">${esc(ex.name)}${addedBadge}</div>
            <div class="ex-meta">${ex.sets} × ${ex.reps}</div>
          </div>
          <div style="font-size:10px;color:#60a5fa;font-weight:600">📈</div>
        </div>
        <button onclick="${removeCall}" title="Remove"
          style="background:none;border:none;color:#ef4444;font-size:16px;cursor:pointer;padding:4px 8px;opacity:0.6;flex-shrink:0"
          onmouseenter="this.style.opacity='1'" onmouseleave="this.style.opacity='0.6'">🗑</button>
      </div>
      ${buildSetRows(activeSession, i, ex.sets, ex.reps, lastSets, suggested, lastRPE)}
    </div>`;
  }).join('') + `<div style="padding:8px 0 16px">
    <button onclick="openAddExerciseModal()"
      style="width:100%;background:#0f172a;border:1.5px dashed #334155;border-radius:14px;color:#60a5fa;font-size:14px;font-weight:700;padding:14px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px">
      <span style="font-size:20px">+</span> Add Exercise
    </button>
  </div>`;

  updateTimerStats();
}

function setSession(s) {
  activeSession = s;
  currentSets = {};
  currentRPE  = {};
  resetWorkoutTimer();
  if (document.getElementById('workoutNotesInput')) document.getElementById('workoutNotesInput').value = '';
  renderWorkoutPage();
}

// ── saveWorkout → show completion screen ──────────────────────
function saveWorkout() {
  const liftLog = getStorage('liftLog2', {});
  const key     = `${todayKey()}-${activeSession}`;
  const durSecs = getWorkoutDuration();
  const exercises = PROGRAM[activeSession].exercises.map((ex, i) => ({
    name: ex.name,
    sets: currentSets[`${activeSession}-${i}`] || [],
    rpe:  currentRPE[`${activeSession}-${i}`]  || null,
  }));
  const notes = (document.getElementById('workoutNotesInput')?.value || '').trim();
  liftLog[key] = { session: activeSession, date: todayKey(), exercises, notes, duration: durSecs };
  setStorage('liftLog2', liftLog);
  logInteraction('workout_saved', activeSession);
  const totalDone = exercises.reduce((n, ex) => n + ex.sets.filter(s => s.done).length, 0);
  const totalSets = exercises.reduce((n, ex) => n + ex.sets.length, 0);
  const totalVol  = exercises.reduce((n, ex) =>
    n + ex.sets.filter(s => s.done && s.type !== 'warmup').reduce((sv, s) => sv + (parseFloat(s.weight)||0) * (parseInt(s.reps)||0), 0), 0);

  // Collect today's PRs
  const prs = getPRs();
  const todayPRs = Object.values(prs).filter(p => p.date === todayKey());

  // Reset state
  currentSets = {};
  currentRPE  = {};
  stopWorkoutTimer();
  skipRestTimer();
  if (document.getElementById('workoutNotesInput')) document.getElementById('workoutNotesInput').value = '';

  renderStreakCard();
  showWorkoutComplete(totalDone, totalSets, totalVol, durSecs, todayPRs, exercises);
}


// ── Workout Complete Screen ───────────────────────────────────
function showWorkoutComplete(done, total, volume, durSecs, prList, exercises) {
  const overlay = document.getElementById('workoutCompleteOverlay');
  if (!overlay) { renderWorkoutPage(); return; }

  const m = Math.floor(durSecs / 60);
  const s = durSecs % 60;
  const durStr = durSecs > 0 ? `${m}:${s.toString().padStart(2,'0')}` : '—';

  // Workout ordinal
  const liftLog = getStorage('liftLog2', {});
  const totalWorkouts = Object.keys(liftLog).length;

  document.getElementById('wcSub').textContent = `Session #${totalWorkouts} · ${PROGRAM[activeSession].name}`;

  document.getElementById('wcStats').innerHTML = `
    <div class="wc-stat">
      <div class="wc-stat-val" style="color:#60a5fa">${durStr}</div>
      <div class="wc-stat-lbl">Duration</div>
    </div>
    <div class="wc-stat">
      <div class="wc-stat-val" style="color:#22c55e">${done}/${total}</div>
      <div class="wc-stat-lbl">Sets Done</div>
    </div>
    <div class="wc-stat">
      <div class="wc-stat-val" style="color:#f59e0b">${volume >= 1000 ? (volume/1000).toFixed(1)+'k' : Math.round(volume)}</div>
      <div class="wc-stat-lbl">Total Volume</div>
    </div>
    <div class="wc-stat">
      <div class="wc-stat-val" style="color:#a78bfa">${exercises.length}</div>
      <div class="wc-stat-lbl">Exercises</div>
    </div>`;

  const prContainer = document.getElementById('wcPRs');
  const prListEl    = document.getElementById('wcPRList');
  if (prList && prList.length > 0) {
    prContainer.style.display = 'block';
    prListEl.innerHTML = prList.map(p =>
      `<div class="wc-pr-item">🏆 ${p.weight} lbs × ${p.reps} reps · ~${p.est1rm} lbs 1RM</div>`
    ).join('');
  } else {
    prContainer.style.display = 'none';
  }

  overlay.style.display = 'flex';
}

function closeWorkoutComplete() {
  const overlay = document.getElementById('workoutCompleteOverlay');
  if (overlay) overlay.style.display = 'none';
  resetWorkoutTimer();
  renderWorkoutPage();
}

// ── Exercise Progress Chart ───────────────────────────────────
function openExChart(exName) {
  const modal = document.getElementById('exChartModal');
  if (!modal) return;

  const liftLog = getStorage('liftLog2', {});
  const prs     = getPRs();
  const prKey   = exName.toLowerCase().replace(/\s+/g, '_');
  const prData  = prs[prKey];

  // Gather all data points: { date, maxWeight, bestReps, est1rm }
  const points = [];
  Object.entries(liftLog).sort(([a],[b]) => a.localeCompare(b)).forEach(([k, log]) => {
    if (!log.exercises) return;
    log.exercises.forEach(ex => {
      if (ex.name !== exName) return;
      const done = (ex.sets || []).filter(s => s.done && s.type !== 'warmup' && parseFloat(s.weight) > 0);
      if (!done.length) return;
      // Best set by estimated 1RM
      let best = null;
      done.forEach(s => {
        const e1rm = (parseFloat(s.weight) || 0) * (1 + (parseInt(s.reps) || 0) / 30);
        if (!best || e1rm > best.est1rm) best = { weight: parseFloat(s.weight), reps: parseInt(s.reps) || 0, est1rm: e1rm };
      });
      if (best) points.push({ date: log.date || k.slice(0,10), ...best });
    });
  });

  // Title and sub
  document.getElementById('exChartTitle').textContent = exName;
  document.getElementById('exChartSub').textContent = points.length
    ? `${points.length} sessions logged` + (prData ? ` · 🏆 PR: ${prData.weight} lbs × ${prData.reps} reps` : '')
    : 'No data yet — log this exercise to see progress';

  // Draw SVG chart
  const svg = document.getElementById('exChartSvg');
  svg.innerHTML = '';
  const W = 300, H = 130, PAD = { t: 10, r: 10, b: 30, l: 40 };
  const iW = W - PAD.l - PAD.r;
  const iH = H - PAD.t - PAD.b;

  if (points.length >= 2) {
    const vals   = points.map(p => p.est1rm);
    const minV   = Math.min(...vals) * 0.92;
    const maxV   = Math.max(...vals) * 1.05;
    const xStep  = iW / (points.length - 1);
    const yScale = v => iH - ((v - minV) / (maxV - minV)) * iH;

    let svgParts = [];

    // Grid lines
    for (let i = 0; i <= 4; i++) {
      const y = PAD.t + (i / 4) * iH;
      const v = maxV - (i / 4) * (maxV - minV);
      svgParts.push(`<line x1="${PAD.l}" y1="${y}" x2="${W - PAD.r}" y2="${y}" stroke="#2a2f3d" stroke-width="1"/>`);
      svgParts.push(`<text x="${PAD.l - 4}" y="${y + 4}" text-anchor="end" fill="#4d5468" font-size="9" font-family="Plus Jakarta Sans,sans-serif">${Math.round(v)}</text>`);
    }

    // Line path
    const pts = points.map((p, i) => {
      const x = PAD.l + i * xStep;
      const y = PAD.t + yScale(p.est1rm);
      return `${x},${y}`;
    }).join(' ');
    svgParts.push(`<polyline points="${pts}" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`);

    // Area fill
    const firstX = PAD.l, lastX = PAD.l + (points.length - 1) * xStep;
    const areaBase = PAD.t + iH;
    const areaPath = `M${firstX},${areaBase} ` +
      points.map((p, i) => `L${PAD.l + i * xStep},${PAD.t + yScale(p.est1rm)}`).join(' ') +
      ` L${lastX},${areaBase} Z`;
    svgParts.push(`<path d="${areaPath}" fill="url(#chartGrad)" opacity="0.3"/>`);
    svgParts.push(`<defs><linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#22c55e"/><stop offset="100%" stop-color="#22c55e" stop-opacity="0"/></linearGradient></defs>`);

    // Dots + date labels (show every Nth)
    const showEvery = Math.max(1, Math.ceil(points.length / 5));
    points.forEach((p, i) => {
      const x = PAD.l + i * xStep;
      const y = PAD.t + yScale(p.est1rm);
      svgParts.push(`<circle cx="${x}" cy="${y}" r="3.5" fill="#22c55e" stroke="#0d1e3d" stroke-width="1.5"/>`);
      if (i % showEvery === 0 || i === points.length - 1) {
        const dateLabel = p.date ? p.date.slice(5) : '';
        svgParts.push(`<text x="${x}" y="${H - 6}" text-anchor="middle" fill="#4d5468" font-size="8" font-family="Plus Jakarta Sans,sans-serif">${dateLabel}</text>`);
      }
    });
    svg.innerHTML = svgParts.join('');
  } else if (points.length === 1) {
    svg.innerHTML = `<text x="150" y="70" text-anchor="middle" fill="#4d5468" font-size="12" font-family="Plus Jakarta Sans,sans-serif">Only 1 session — log more to see trends</text>`;
  } else {
    svg.innerHTML = `<text x="150" y="70" text-anchor="middle" fill="#4d5468" font-size="12" font-family="Plus Jakarta Sans,sans-serif">No data yet — log this exercise first</text>`;
  }

  // Stats row
  const best = points.length ? points.reduce((b, p) => p.est1rm > b.est1rm ? p : b) : null;
  const latest = points.length ? points[points.length - 1] : null;
  const first  = points.length ? points[0] : null;
  const pctChange = (first && latest && first.est1rm > 0)
    ? (((latest.est1rm - first.est1rm) / first.est1rm) * 100).toFixed(1) : null;

  document.getElementById('exChartStats').innerHTML = `
    <div class="ex-stat-box">
      <div class="ex-stat-val" style="color:#f59e0b">${best ? Math.round(best.est1rm) : '—'}</div>
      <div class="ex-stat-lbl">Best 1RM Est.</div>
    </div>
    <div class="ex-stat-box">
      <div class="ex-stat-val" style="color:#22c55e">${prData ? prData.weight : '—'}</div>
      <div class="ex-stat-lbl">PR Weight</div>
    </div>
    <div class="ex-stat-box">
      <div class="ex-stat-val" style="color:${pctChange > 0 ? '#22c55e' : '#f87171'}">${pctChange !== null ? (pctChange > 0 ? '+' : '') + pctChange + '%' : '—'}</div>
      <div class="ex-stat-lbl">Progress</div>
    </div>`;

  modal.style.display = 'flex';
}

function closeExChart() {
  const modal = document.getElementById('exChartModal');
  if (modal) modal.style.display = 'none';
}

// ── renderHistoryPage v2 ──────────────────────────────────────
function renderHistoryPage() {
  const liftLog = getStorage('liftLog2', {});
  const keys    = Object.keys(liftLog).sort().reverse();
  const el      = document.getElementById('historyList');
  if (!el) return;

  if (keys.length === 0) {
    el.innerHTML = '<div class="section-title">LIFT HISTORY</div><div class="empty-state">No workouts logged yet.<br>Complete a session to see history here.</div>';
    return;
  }

  const sectionTitle = '<div class="section-title" style="margin-bottom:14px">LIFT HISTORY</div>';
  el.innerHTML = sectionTitle + keys.map(k => {
    const log    = liftLog[k];
    const sess   = PROGRAM[log.session];
    const date   = log.date || k.slice(0,10);
    const durSecs = log.duration || 0;
    const durStr  = durSecs > 60 ? `${Math.floor(durSecs/60)}m ${durSecs%60}s` : (durSecs > 0 ? `${durSecs}s` : '');

    // Compute volume
    const vol = (log.exercises || []).reduce((n, ex) =>
      n + (ex.sets || []).filter(s => s.done && s.type !== 'warmup').reduce((sv, s) =>
        sv + (parseFloat(s.weight)||0) * (parseInt(s.reps)||0), 0), 0);

    // Exercise rows with best set per exercise
    const rows = (log.exercises || []).map(ex => {
      const done = (ex.sets || []).filter(s => s.done && parseFloat(s.weight) > 0);
      if (!done.length) return '';
      const bestSet = done.reduce((b, s) =>
        (parseFloat(s.weight) * (parseInt(s.reps)||1)) > (parseFloat(b.weight) * (parseInt(b.reps)||1)) ? s : b
      );
      const sets1rm = done.map(s => (parseFloat(s.weight)||0) * (1 + (parseInt(s.reps)||0)/30));
      const est1rm  = Math.max(...sets1rm);
      const volEx   = done.reduce((sv, s) => sv + (parseFloat(s.weight)||0)*(parseInt(s.reps)||0), 0);
      return `<div class="hist-row">
        <span class="hist-ex">${esc(ex.name)}</span>
        <span class="hist-wt">${bestSet.weight} lbs × ${bestSet.reps} · ${done.length} sets</span>
      </div>`;
    }).filter(Boolean).join('');

    // Badge color by session
    const sessionColors = { A:'#f59e0b', B:'#3b82f6', C:'#22c55e' };
    const badgeColor = sessionColors[log.session] || '#22c55e';
    const badgeBg    = log.session === 'A' ? '#2d1f05' : log.session === 'B' ? '#0d1e3d' : '#0d2d1a';

    return `<div class="hist-card">
      <div class="hist-header">
        <div>
          <div class="hist-sess" style="font-size:15px;font-weight:800">${esc(sess?.name || 'Session')}</div>
          <div class="hist-date">${date}${durStr ? ' · ⏱ ' + durStr : ''}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px">
          <span style="padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;background:${badgeBg};color:${badgeColor}">Day ${log.session}</span>
          ${vol > 0 ? `<span style="font-size:10px;font-weight:700;color:var(--text3)">${vol >= 1000 ? (vol/1000).toFixed(1)+'k' : Math.round(vol)} lbs</span>` : ''}
        </div>
      </div>
      ${rows || '<div style="font-size:12px;color:var(--text3)">No sets recorded</div>'}
      ${log.notes ? `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);font-size:12px;color:var(--text2);line-height:1.6">📝 ${esc(log.notes)}</div>` : ''}
    </div>`;
  }).join('');
}

// ── Program Page ──
function renderProgramPage() {
  document.getElementById('programList').innerHTML = Object.entries(PROGRAM).map(([key, sess]) =>
    `<div class="card" style="margin-bottom:14px">
      <div style="font-size:18px;font-weight:700;color:#22c55e;margin-bottom:12px;letter-spacing:-0.3px">Day ${key} — ${esc(sess.name)}</div>
      ${sess.exercises.map(ex => `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #e8eaf2">
          <div style="min-width:58px;height:32px;border-radius:20px;background:#0d2d1a;color:#22c55e;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;padding:0 8px">${ex.sets}×${ex.reps}</div>
          <div>
            <div style="font-size:14px;font-weight:600;color:var(--text)">${esc(ex.name)}</div>
            ${ex.notes ? `<div style="font-size:11px;color:var(--text2);margin-top:2px">${esc(ex.notes)}</div>` : ''}
          </div>
        </div>`).join('')}
    </div>`
  ).join('');
}


// ── Tab switching ──
function switchTab(name, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  if (btn) btn.classList.add('active');
  logInteraction('tab_visit', name);
  if (name === 'today') { selectedDateKey = todayKey(); updateDateNavBar(); scheduleRender(renderRings); renderWeekStrip(); renderStreakCard(); renderEventCountdowns(); renderQuickRecs(); renderUsualFoods(); safeCall(renderFavChips, 'renderFavChips'); safeCall(renderReadinessCard, 'renderReadinessCard'); renderWorkoutNutritionBanner(); renderFuelingBanner(); scheduleRender(renderFoodLog); scheduleRender(renderProteinPace); renderWeightTrend(); checkCopyYesterday(); scheduleRender(renderWeeklyBalance); renderWater(); renderSleepCard(); updateCheckinSummaryCard(); }
  if (name === 'lift') { renderWorkoutPage(); safeCall(renderTrainingLoad, 'renderTrainingLoad'); renderTPBanners(); }
  else { stopWorkoutTimer(); skipRestTimer(); }
  if (name === 'program') { renderProgramPage(); renderEventList(); }
  if (name === 'history') { renderBloodWorkPage(); renderHistoryPage(); }
  if (name === 'trends') renderTrendChart();
  if (name === 'shoes')  renderShoePage();
}

// ── Food Entry Log (individual entries per day) ──
function getFoodEntries(dateKey) {
  const key = dateKey || getSelectedDateKey();
  const all = getStorage('foodEntries', {});
  return all[key] || [];
}

function setFoodEntries(entries, dateKey) {
  const key      = dateKey || getSelectedDateKey();
  // Update foodEntries
  const all      = getStorage('foodEntries', {});
  all[key]       = entries;
  setStorage('foodEntries', all);
  // Keep macroLog in sync — single read+write
  const totals   = entries.reduce((acc, e) => ({
    calories: acc.calories + (e.calories || 0),
    protein:  acc.protein  + (e.protein  || 0),
    carbs:    acc.carbs    + (e.carbs    || 0),
    fat:      acc.fat      + (e.fat      || 0),
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  const macroLog = getStorage('macroLog', {});
  macroLog[key]  = { calories: Math.round(totals.calories), protein: Math.round(totals.protein), carbs: Math.round(totals.carbs), fat: Math.round(totals.fat) };
  setStorage('macroLog', macroLog);
}

function addFoodEntry(food) {
  const entries = getFoodEntries();
  const servings = food.servings || 1;
  const entry = {
    id:           Date.now(),
    name:         food.name || 'Food',
    calories:     food.calories || 0,
    protein:      food.protein  || 0,
    carbs:        food.carbs    || 0,
    fat:          food.fat      || 0,
    icon:         food.icon || '🍽️',
    time:         nowEST().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', timeZone:'America/New_York' }),
    servings,
    // Store per-serving base so editing can rescale
    baseMacros: {
      calories: Math.round((food.calories || 0) / servings * 10) / 10,
      protein:  Math.round((food.protein  || 0) / servings * 10) / 10,
      carbs:    Math.round((food.carbs    || 0) / servings * 10) / 10,
      fat:      Math.round((food.fat      || 0) / servings * 10) / 10,
    },
  };
  // Persist micros if provided
  if (food.micros && Object.keys(food.micros).length > 0) {
    entry.micros = food.micros;
    entry.baseMicros = Object.fromEntries(
      Object.entries(food.micros).map(([k, v]) => [k, Math.round(v / servings * 1000) / 1000])
    );
  }
  entries.push(entry);
  setFoodEntries(entries);
  logInteraction('food_logged', food.name);
  try { scheduleCheckinSync(3000); } catch(_) {}
  scheduleRender(renderRings);
  scheduleRender(renderFoodLog);
  scheduleRender(renderProteinPace);
  scheduleRender(renderWeeklyBalance);
  scheduleRender(renderMicronutrients);
  const isPast = getSelectedDateKey() !== todayKey();
  showToast(`✅ ${food.name} logged!${isPast ? ' (past day)' : ''}`);
}




function renderWorkoutNutritionBanner() {
  const banner = document.getElementById('workoutNutritionBanner');
  const title  = document.getElementById('workoutNutritionTitle');
  const msg    = document.getElementById('workoutNutritionMsg');
  if (!banner) return;

  const dow     = nowEST().getDay();
  const h       = nowEST().getHours();
  const todayW  = WEEK.find(d => DAY_MAP[d.day] === dow);
  const isLift  = todayW && (todayW.type === 'lift' || todayW.type === 'optional');
  const isRun   = todayW && (todayW.type === 'run' || todayW.type === 'longrun' || todayW.type === 'recoveryrun');
  const entries = getFoodEntries();
  const consumed = entries.reduce((s, e) => s + (e.calories || 0), 0);
  const macros   = getStorage('userMacros', null) || MACROS;

  if (!isLift && !isRun) { banner.style.display = 'none'; return; }

  banner.style.display = 'block';

  if (isLift) {
    title.textContent = '🏋️ Lift Day Fuel';
    if (h < 10) {
      msg.textContent = 'Pre-lift: aim for 40–50g carbs + 30g protein 60–90 min before you train. Oats + protein shake works great.';
    } else if (h >= 10 && h < 14) {
      msg.textContent = 'Mid-day lift window: make sure your pre-workout meal had carbs. Post-lift, hit 50g protein + 60g carbs within 30 min.';
    } else if (h >= 14 && h < 20) {
      const postLiftRemaining = Math.max(0, (macros.protein || 190) - consumed);
      msg.textContent = `Post-workout window. Target: 50g protein + 60g carbs NOW. You still have ${(macros.calories - consumed).toFixed(0)} kcal remaining today.`;
    } else {
      msg.textContent = 'Recovery night — prioritize protein before bed. Cottage cheese or casein shake ideal.';
    }
  } else if (isRun) {
    const isLong = todayW.type === 'longrun';
    title.textContent = isLong ? '🏃 Long Run Day' : '🏃 Run Day';
    if (h < 8) {
      msg.textContent = isLong ? 'Long run today — eat 60–80g carbs 2 hrs before. Hydrate well. Bring fuel if running 60+ min.' : 'Easy run day — light carbs before, focus on hitting protein target through the day.';
    } else {
      msg.textContent = isLong ? 'Post long run: replenish with 80–100g carbs + 40g protein ASAP. Your carb target is higher today.' : 'Post-run: good job. Keep carbs toward the higher end today to replenish glycogen.';
    }
  }
}

function renderStreakCard() {
  const liftLog  = getStorage('liftLog2', {});
  const shoeRuns = getShoeRuns();
  const streakEl = document.getElementById('streakCount');
  const subEl    = document.getElementById('streakSub');
  const dotRow   = document.getElementById('weekDotRow');
  if (!streakEl) return;

  const now = nowEST();

  // Helper: did the user complete a workout on a given YYYY-MM-DD key?
  // Counts: any liftLog entry for that date OR any shoeRun logged on that date
  function hasActivityOn(key) {
    const hasLift = Object.keys(liftLog).some(k => k.startsWith(key));
    const hasRun  = shoeRuns.some(r => r.date === key);
    return hasLift || hasRun;
  }

  // Count consecutive active days going back from today
  // Today is allowed to be empty without breaking the streak
  let streak = 0;
  for (let i = 0; i < 90; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const key = dateToKey(d);
    if (hasActivityOn(key)) {
      streak++;
    } else if (i > 0) {
      break; // gap found — stop (i=0 is today, allowed to be empty)
    }
  }

  streakEl.textContent = streak;
  subEl.textContent    = streak === 0
    ? 'Log a workout or run to start your streak!'
    : streak === 1 ? 'Day 1 — keep it going!'
    : `${streak} consecutive day${streak !== 1 ? 's' : ''} 🔥`;

  // ── Week dot row — show ALL workout days (lifts + runs) ──────
  const dow        = now.getDay();
  const diffToMon  = dow === 0 ? -6 : 1 - dow;
  const typeColors = { lift:'#22c55e', run:'#3b82f6', longrun:'#f59e0b', recoveryrun:'#06b6d4', optional:'#8b5cf6' };
  const typeIcons  = { lift:'🏋️', run:'🏃', longrun:'🏃', recoveryrun:'🚶', optional:'🏋️' };

  const weekDots = WEEK.map((s, i) => {
    const d = new Date(now);
    d.setDate(now.getDate() + diffToMon + i);
    const key      = dateToKey(d);
    const isRest   = s.type === 'rest';
    const isFuture = d > now;
    const hasLift  = Object.keys(liftLog).some(k => k.startsWith(key));
    const hasRun   = shoeRuns.some(r => r.date === key);
    const done     = hasLift || hasRun;
    // For lift days: check lift; for run days: check runs
    const isWorkout = !isRest;
    return { type: s.type, day: s.day, done, isFuture, isRest, isWorkout, hasLift, hasRun };
  });

  const workoutDays = weekDots.filter(d => d.isWorkout);
  const doneDays    = workoutDays.filter(d => d.done).length;

  dotRow.innerHTML =
    `<div style="font-size:10px;color:var(--text3);font-weight:700;margin-bottom:4px;letter-spacing:1px">THIS WEEK</div>` +
    `<div style="display:flex;gap:5px;align-items:center">` +
    weekDots.map(d => {
      if (d.isRest) {
        return `<div title="${d.day}: Rest" style="width:20px;height:20px;border-radius:6px;background:var(--surface2);border:1.5px solid var(--border);opacity:0.4"></div>`;
      }
      const color  = typeColors[d.type] || '#94a3b8';
      const icon   = typeIcons[d.type]  || '💪';
      let bg, border, label;
      if (d.done) {
        bg = color + '33'; border = color; label = '✓';
      } else if (d.isFuture) {
        bg = 'var(--surface2)'; border = color + '55'; label = icon;
      } else {
        bg = '#2d0f0f'; border = '#7f1d1d'; label = '✗';
      }
      return `<div title="${d.day}: ${d.type}${d.done ? ' ✓' : ''}" style="width:20px;height:20px;border-radius:6px;background:${bg};border:1.5px solid ${border};display:flex;align-items:center;justify-content:center;font-size:${d.done ? '11px' : '9px'};color:${d.done ? color : d.isFuture ? color + 'aa' : '#ef4444'}">${label}</div>`;
    }).join('') +
    `</div>` +
    `<div style="display:flex;gap:10px;margin-top:4px">` +
    `<div style="font-size:9px;color:var(--text3);font-weight:600">${doneDays}/${workoutDays.length} done this week</div>` +
    `<div style="font-size:9px;color:#22c55e;font-weight:600">🏋️ lifts</div>` +
    `<div style="font-size:9px;color:#3b82f6;font-weight:600">🏃 runs</div>` +
    `</div>`;
}

function renderProteinPace(entriesOverride) {
  const bar   = document.getElementById('proteinPaceBar');
  const label = document.getElementById('proteinPaceLabel');
  const hint  = document.getElementById('proteinPaceHint');
  if (!bar) return;

  const entries  = entriesOverride || getFoodEntries();
  const consumed = entries.reduce((s, e) => s + (e.protein || 0), 0);
  const macros   = getStorage('userMacros', null) || MACROS;
  const target   = macros.protein || 190;
  const pct      = Math.min(consumed / target, 1);

  // How many meals remain today
  const h = nowEST().getHours();
  const mealsLeft = h < 8 ? 4 : h < 12 ? 3 : h < 15 ? 2 : h < 19 ? 1 : 0;
  const remaining = Math.max(0, target - consumed);

  bar.style.width   = (pct * 100) + '%';
  bar.style.background = pct >= 1 ? '#22c55e' : pct >= 0.7 ? '#4ade80' : pct >= 0.4 ? '#f59e0b' : '#ef4444';
  label.textContent = `${consumed.toFixed(0)}g / ${target}g`;

  if (pct >= 1) {
    hint.textContent = '✅ Protein goal hit! Great work.';
  } else if (mealsLeft === 0) {
    hint.textContent = `⚠️ ${remaining.toFixed(0)}g short — consider a protein snack`;
  } else {
    const perMeal = (remaining / mealsLeft).toFixed(0);
    hint.textContent = `Need ${remaining.toFixed(0)}g more across ~${mealsLeft} meal${mealsLeft !== 1 ? 's' : ''} left (${perMeal}g each)`;
  }
}

function renderFoodLog() {
  const entries = getFoodEntries();
  const card = document.getElementById('foodLogCard');
  const list = document.getElementById('foodLogList');
  if (!card || !list) return;

  const isPast = getSelectedDateKey() !== todayKey();

  // Always show the card so users can add entries to past days
  card.style.display = 'block';

  // Past-day banner
  const pastBanner = isPast
    ? `<div style="background:#0d1e3d;border:1.5px solid #1e3a5f;border-radius:12px;padding:8px 12px;margin-bottom:10px;font-size:12px;color:#60a5fa;font-weight:600;display:flex;align-items:center;gap:8px">
        📅 Editing past day — changes will be saved to ${getSelectedDateKey()}
       </div>` : '';

  if (entries.length === 0) {
    list.innerHTML = pastBanner + `<div style="text-align:center;color:var(--text3);padding:20px 0;font-size:13px">No entries for this day.<br>Use the form above to add food.</div>`;
    return;
  }

  const totals = entries.reduce((a, e) => ({
    calories: a.calories + e.calories,
    protein:  a.protein  + e.protein,
    carbs:    a.carbs    + e.carbs,
    fat:      a.fat      + e.fat,
  }), { calories:0, protein:0, carbs:0, fat:0 });

  list.innerHTML = pastBanner + entries.map(e => `
    <div class="log-entry" id="entry-${e.id}">
      <div class="log-entry-icon">${e.icon || '🍽️'}</div>
      <div class="log-entry-info">
        <div class="log-entry-name">${esc(e.name)}${e.servings && e.servings !== 1 ? `<span style="font-size:10px;color:var(--text3);font-weight:600;margin-left:6px">×${e.servings}</span>` : ''}</div>
        <div class="log-entry-macros">${e.calories} kcal · ${e.protein}g P · ${e.carbs}g C · ${e.fat}g F</div>
        <div class="log-entry-time">${e.time || ''}</div>
      </div>
      <div class="log-entry-actions">
        <button class="log-action-btn edit" onclick="openEditEntry(${e.id})" title="Edit">✏️</button>
        <button class="log-action-btn del"  onclick="deleteEntry(${e.id})"   title="Delete">🗑️</button>
      </div>
    </div>`).join('') +
    `<div class="log-total-row">
      <div class="log-total-label">Total</div>
      <div class="log-total-macros">${Math.round(totals.calories)} kcal · ${totals.protein.toFixed(1)}g P · ${totals.carbs.toFixed(1)}g C · ${totals.fat.toFixed(1)}g F</div>
    </div>`;
}

// ── Edit Entry with Servings ──
let _editServings = 1;
let _editBaseMacros = null; // null = no base stored, edit macros directly

function openEditEntry(id) {
  const entries = getFoodEntries();
  const e = entries.find(x => x.id === id);
  if (!e) return;

  _editServings   = e.servings || 1;
  _editBaseMacros = e.baseMacros || null;

  document.getElementById('editEntryId').value  = id;
  document.getElementById('editEntryName').value = e.name;
  document.getElementById('editEntrySubtitle').textContent = e.name;

  const hasBase = !!_editBaseMacros;
  const servingsRow  = document.getElementById('editServingsRow');
  const macroLabel   = document.getElementById('editMacroLabel');
  const totalPreview = document.getElementById('editTotalPreview');

  if (hasBase) {
    // Show servings stepper — macro fields show per-serving values
    servingsRow.style.display = 'flex';
    macroLabel.textContent = 'Macros per serving (auto-calculated)';
    totalPreview.style.display = 'flex';
    document.getElementById('editServingBaseLabel').textContent =
      `Base: ${_editBaseMacros.calories} kcal · ${_editBaseMacros.protein}g P per serving`;
    document.getElementById('editServingsDisplay').textContent = _editServings % 1 === 0 ? _editServings : _editServings.toFixed(1);
    // Fill fields with per-serving values
    document.getElementById('editCalories').value = _editBaseMacros.calories;
    document.getElementById('editProtein').value  = _editBaseMacros.protein;
    document.getElementById('editCarbs').value    = _editBaseMacros.carbs;
    document.getElementById('editFat').value      = _editBaseMacros.fat;
    updateEditTotalPreview();
  } else {
    // No base stored — show total macros, editable directly
    servingsRow.style.display = 'none';
    macroLabel.textContent = 'Macros (total)';
    totalPreview.style.display = 'none';
    document.getElementById('editCalories').value = e.calories;
    document.getElementById('editProtein').value  = e.protein;
    document.getElementById('editCarbs').value    = e.carbs;
    document.getElementById('editFat').value      = e.fat;
  }

  document.getElementById('editEntryModal').classList.add('open');
}

function adjustEditServings(delta) {
  _editServings = Math.max(0.5, Math.round((_editServings + delta) * 2) / 2);
  document.getElementById('editServingsDisplay').textContent = _editServings % 1 === 0 ? _editServings : _editServings.toFixed(1);
  updateEditTotalPreview();
}

function onEditMacroInput() {
  // When user manually edits macro fields, clear base so we save as-is
  _editBaseMacros = null;
  document.getElementById('editServingsRow').style.display = 'none';
  document.getElementById('editTotalPreview').style.display = 'none';
  document.getElementById('editMacroLabel').textContent = 'Macros (total)';
}

function updateEditTotalPreview() {
  if (!_editBaseMacros) return;
  const s = _editServings;
  const b = _editBaseMacros;
  const totalEl = document.getElementById('editTotalText');
  totalEl.innerHTML =
    `<span style="color:#f59e0b;font-weight:700">${Math.round(b.calories*s)} kcal</span> · ` +
    `<span style="color:#22c55e">${(b.protein*s).toFixed(1)}g P</span> · ` +
    `<span style="color:#3b82f6">${(b.carbs*s).toFixed(1)}g C</span> · ` +
    `<span style="color:#ef4444">${(b.fat*s).toFixed(1)}g F</span>`;
}

function saveEditedEntry() {
  const id = parseInt(document.getElementById('editEntryId').value);
  const entries = getFoodEntries();
  const idx = entries.findIndex(x => x.id === id);
  if (idx === -1) return;

  const name = document.getElementById('editEntryName').value.trim() || entries[idx].name;

  let calories, protein, carbs, fat, baseMacros, servings;

  if (_editBaseMacros) {
    // Scale from base macros × servings
    const s = _editServings;
    const b = _editBaseMacros;
    calories   = Math.round(b.calories * s);
    protein    = Math.round(b.protein  * s * 10) / 10;
    carbs      = Math.round(b.carbs    * s * 10) / 10;
    fat        = Math.round(b.fat      * s * 10) / 10;
    baseMacros = b;
    servings   = s;
  } else {
    // Direct macro edit — treat as 1 serving
    calories   = parseFloat(document.getElementById('editCalories').value) || 0;
    protein    = parseFloat(document.getElementById('editProtein').value)  || 0;
    carbs      = parseFloat(document.getElementById('editCarbs').value)    || 0;
    fat        = parseFloat(document.getElementById('editFat').value)      || 0;
    servings   = 1;
    baseMacros = { calories, protein, carbs, fat };
  }

  entries[idx] = { ...entries[idx], name, calories, protein, carbs, fat, servings, baseMacros };
  setFoodEntries(entries);
  document.getElementById('editEntryModal').classList.remove('open');
  scheduleRender(renderRings);
  scheduleRender(renderFoodLog);
  scheduleRender(renderWeeklyBalance);
  showToast('✅ Entry updated!');
}

function deleteEntry(id) {
  const allEntries = getFoodEntries();
  const entry = allEntries.find(e => e.id === id);
  const remaining = allEntries.filter(e => e.id !== id);
  const savedDateKey = getSelectedDateKey();
  setFoodEntries(remaining);
  scheduleRender(renderRings);
  scheduleRender(renderFoodLog);
  scheduleRender(renderProteinPace);
  scheduleRender(renderWeeklyBalance);
  showToast('🗑️ Entry removed', () => {
    // Undo: restore entry
    const current = getFoodEntries(savedDateKey);
    current.push(entry);
    current.sort((a,b) => a.id - b.id);
    setFoodEntries(current, savedDateKey);
    scheduleRender(renderRings); scheduleRender(renderFoodLog); scheduleRender(renderProteinPace); scheduleRender(renderWeeklyBalance);
    showToast('↩️ Entry restored');
  });
}

function clearAllEntries() {
  if (!confirm('Clear all food entries for today?')) return;
  setFoodEntries([]);
  scheduleRender(renderRings);
  scheduleRender(renderFoodLog);
}

// ── Saved Foods & Smart Recommendations ──

const TIME_SLOTS = {
  breakfast:  { label: 'Breakfast',     hint: 'breakfast',      hours: [5,6,7,8,9],       dot: '#f59e0b' },
  morning:    { label: 'Morning Snack', hint: 'mid-morning',    hours: [9,10,11],          dot: '#06b6d4' },
  lunch:      { label: 'Lunch',         hint: 'lunch',          hours: [11,12,13,14],      dot: '#3b82f6' },
  afternoon:  { label: 'Afternoon',     hint: 'afternoon',      hours: [14,15,16,17],      dot: '#8b5cf6' },
  dinner:     { label: 'Dinner',        hint: 'dinner',         hours: [17,18,19,20,21],   dot: '#22c55e' },
  evening:    { label: 'Evening Snack', hint: 'evening',        hours: [20,21,22,23],      dot: '#ef4444' },
};

let selectedTimeSlot = null; // shared for scan/manual pickers

function getTimeSlot() {
  const h = nowEST().getHours();
  for (const [key, slot] of Object.entries(TIME_SLOTS)) {
    if (slot.hours.includes(h)) return key;
  }
  return 'lunch'; // default fallback
}

function toggleTimeSlot(btn, context) {
  if (context === 'ai') {
    document.querySelectorAll('#aiTimeSlotPicker .ts-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    aiSelectedSlot = btn.dataset.slot;
    return;
  }
  const picker = document.getElementById(context === 'scan' ? 'scanTimeSlotPicker' : 'manualTimeSlotPicker');
  picker.querySelectorAll('.ts-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  selectedTimeSlot = btn.dataset.slot;
}

function renderUsualFoods() {
  const card = document.getElementById('usualFoodsCard');
  if (!card) return;

  // ── Build frequency map from last 30 days ──────────────────
  const all    = getStorage('foodEntries', {});
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const todayK = todayKey();
  const freq   = {};

  Object.entries(all).forEach(([dateK, entries]) => {
    if (dateK === todayK) return;
    if (new Date(dateK + 'T12:00:00').getTime() < cutoff) return;
    entries.forEach(e => {
      if (!e.name) return;
      const key = e.name.toLowerCase().trim();
      if (!freq[key]) {
        freq[key] = {
          name:     e.name,
          icon:     e.icon || '🍽️',
          calories: e.baseMacros ? e.baseMacros.calories : (e.calories || 0),
          protein:  e.baseMacros ? e.baseMacros.protein  : (e.protein  || 0),
          carbs:    e.baseMacros ? e.baseMacros.carbs    : (e.carbs    || 0),
          fat:      e.baseMacros ? e.baseMacros.fat      : (e.fat      || 0),
          count: 0, times: []
        };
      }
      freq[key].count++;
      if (e.time) freq[key].times.push(e.time);
    });
  });

  const allFoods = Object.values(freq).sort((a, b) => b.count - a.count);
  if (allFoods.length === 0) { card.style.display = 'none'; return; }

  // ── Time-of-day filtering ───────────────────────────────────
  const hour = new Date().getHours();
  let timeLabel = '', timePeriod = '';
  if      (hour <  10) { timeLabel = '🌅 Morning picks';   timePeriod = 'morning'; }
  else if (hour <  13) { timeLabel = '☀️ Midday picks';    timePeriod = 'midday'; }
  else if (hour <  17) { timeLabel = '🌤 Afternoon picks'; timePeriod = 'afternoon'; }
  else if (hour <  20) { timeLabel = '🌆 Evening picks';   timePeriod = 'evening'; }
  else                 { timeLabel = '🌙 Night picks';     timePeriod = 'night'; }

  function parseHour(t) {
    if (!t) return -1;
    const parts = t.split(' ');
    const ampm  = parts[1];
    let [h]     = parts[0].split(':').map(Number);
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return h;
  }
  const slotHours = { morning:[5,10], midday:[10,13], afternoon:[13,17], evening:[17,20], night:[20,25] };
  const [lo, hi]  = slotHours[timePeriod] || [0, 24];

  const timeFoods = allFoods.filter(f =>
    f.times.length > 0 && f.times.some(t => { const h = parseHour(t); return h >= lo && h < hi; })
  );
  const top10 = (timeFoods.length >= 3 ? timeFoods : allFoods).slice(0, 10);

  document.getElementById('usualFoodsTimeLabel').textContent = timeLabel;
  document.getElementById('usualFoodsSubtitle').textContent  = `Top ${top10.length} from last 30 days`;

  // ── Store foods before rendering (avoids JSON-in-onclick bug) ──
  window._ufFoods = top10;
  window._ufQty   = new Array(top10.length).fill(1);

  // ── Yesterday same-time banner ──────────────────────────────
  const yDate = new Date(); yDate.setDate(yDate.getDate() - 1);
  const yKey  = yDate.toISOString().slice(0, 10);
  const yEntries = (all[yKey] || []).filter(e => {
    const h = parseHour(e.time); return h >= lo && h < hi;
  });

  const bannerEl   = document.getElementById('yesterdayRepeatBanner');
  const repeatList = document.getElementById('yesterdayRepeatList');
  if (yEntries.length > 0) {
    // Store yesterday entries in _ufYesterday for onclick access
    window._ufYesterday = yEntries.slice(0, 3);
    bannerEl.style.display = 'block';
    repeatList.innerHTML = window._ufYesterday.map((e, yi) => {
      const servings = e.servings || 1;
      return `<div class="uf-repeat-row">
        <div style="font-size:20px;width:28px;text-align:center">${e.icon || '🍽️'}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(e.name)}</div>
          <div style="font-size:10px;color:var(--text3)">${Math.round(e.calories)} kcal · ${e.protein}g pro${servings > 1 ? ' · ' + servings + '×' : ''}</div>
        </div>
        <button onclick="quickAddUsual(${yi})" style="padding:5px 10px;background:var(--green-soft);border:1.5px solid var(--green);border-radius:9px;color:#4ade80;font-size:11px;font-weight:700;cursor:pointer">+ Add</button>
      </div>`;
    }).join('');
  } else {
    bannerEl.style.display = 'none';
  }

  // ── Render top 10 list ──────────────────────────────────────
  document.getElementById('usualFoodsList').innerHTML = top10.map((f, i) =>
    `<div class="uf-row" id="uf-row-${i}">
      <div class="uf-icon">${f.icon}</div>
      <div class="uf-info">
        <div class="uf-name">${esc(f.name)}</div>
        <div class="uf-macros" id="uf-macros-${i}">${Math.round(f.calories)} kcal · ${f.protein}g pro · ${f.carbs}g carbs · ${f.fat}g fat</div>
      </div>
      <div class="uf-badge">${f.count}×</div>
      <div class="uf-stepper" id="uf-stepper-${i}">
        <button class="uf-step-btn" onclick="ufStep(${i},-1)">−</button>
        <div class="uf-step-val" id="uf-qty-${i}">1</div>
        <button class="uf-step-btn" onclick="ufStep(${i},1)">+</button>
        <button class="uf-add-btn" onclick="ufConfirm(${i})">Log</button>
      </div>
      <button class="uf-tap-btn" id="uf-tap-${i}" onclick="ufToggle(${i})">Add</button>
    </div>`
  ).join('');

  card.style.display = 'block';
}


function ufToggle(i) {
  if (!window._ufFoods || !window._ufFoods[i]) return;
  const stepper = document.getElementById(`uf-stepper-${i}`);
  const tapBtn  = document.getElementById(`uf-tap-${i}`);
  if (!stepper || !tapBtn) return;
  const isOpen = stepper.classList.contains('active');
  // Close all others
  document.querySelectorAll('.uf-stepper').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.uf-tap-btn').forEach(b => b.style.display = '');
  if (!isOpen) {
    stepper.classList.add('active');
    tapBtn.style.display = 'none';
    window._ufQty[i] = 1;
    document.getElementById(`uf-qty-${i}`).textContent = '1';
    ufUpdateMacros(i);
  }
}

function ufStep(i, delta) {
  if (!window._ufQty) return;
  const qty = Math.max(0.5, (window._ufQty[i] || 1) + delta);
  window._ufQty[i] = Math.round(qty * 2) / 2;
  document.getElementById(`uf-qty-${i}`).textContent = window._ufQty[i];
  ufUpdateMacros(i);
}

function ufUpdateMacros(i) {
  if (!window._ufFoods) return;
  const f  = window._ufFoods[i];
  if (!f) return;
  const q  = window._ufQty[i] || 1;
  const el = document.getElementById(`uf-macros-${i}`);
  if (el) el.textContent = `${Math.round(f.calories * q)} kcal · ${Math.round(f.protein*q*10)/10}g pro · ${Math.round(f.carbs*q*10)/10}g carbs · ${Math.round(f.fat*q*10)/10}g fat`;
}

function ufConfirm(i) {
  if (!window._ufFoods) return;
  const f = window._ufFoods[i];
  if (!f) return;
  const qty = window._ufQty[i] || 1;
  addFoodEntry({
    name:     f.name,
    icon:     f.icon || '🍽️',
    calories: Math.round(f.calories * qty),
    protein:  Math.round(f.protein  * qty * 10) / 10,
    carbs:    Math.round(f.carbs    * qty * 10) / 10,
    fat:      Math.round(f.fat      * qty * 10) / 10,
    servings: qty
  });
  const stepper = document.getElementById(`uf-stepper-${i}`);
  const tapBtn  = document.getElementById(`uf-tap-${i}`);
  if (stepper) stepper.classList.remove('active');
  if (tapBtn)  tapBtn.style.display = '';
  window._ufQty[i] = 1;
  const qEl = document.getElementById(`uf-qty-${i}`);
  if (qEl) qEl.textContent = '1';
  ufUpdateMacros(i);
}

// Yesterday banner uses index into _ufYesterday array
function quickAddUsual(yi) {
  if (!window._ufYesterday || !window._ufYesterday[yi]) return;
  const e    = window._ufYesterday[yi];
  const prev = e.servings || 1;
  const base = e.baseMacros || {
    calories: (e.calories || 0) / prev,
    protein:  (e.protein  || 0) / prev,
    carbs:    (e.carbs    || 0) / prev,
    fat:      (e.fat      || 0) / prev,
  };
  showServingsPrompt(e.name, prev, function(s) {
    s = s || 1;
    addFoodEntry({
      name:     e.name,
      icon:     e.icon || '🍽️',
      calories: Math.round(base.calories * s),
      protein:  Math.round(base.protein  * s * 10) / 10,
      carbs:    Math.round(base.carbs    * s * 10) / 10,
      fat:      Math.round(base.fat      * s * 10) / 10,
      servings: s
    });
  });
}

function renderQuickRecs() {

  const slot = getTimeSlot();
  const slotInfo = TIME_SLOTS[slot];
  const saved = getStorage('savedFoods', []);
  const recs = saved.filter(f => f.slot === slot);

  const card = document.getElementById('quickRecsCard');
  if (recs.length === 0) { card.style.display = 'none'; return; }

  card.style.display = 'block';
  document.querySelector('.meal-time-dot').style.background = slotInfo.dot;
  document.getElementById('mealTimeLabel').textContent = slotInfo.label + ' suggestions';
  document.getElementById('mealTimeHint').textContent = slotInfo.hint;

  document.getElementById('quickFoodsRow').innerHTML = recs.map((f, i) => {
    const idx = saved.findIndex(sf => sf.name === f.name && sf.slot === f.slot);
    return `<div class="quick-food-chip" onclick="quickAddFood(${idx})">
      <div class="qfc-name">${esc(f.name)}</div>
      <div class="qfc-cal">${f.calories} kcal · ${f.protein}g pro</div>

    </div>`;
  }).join('');
}


function showServingsPrompt(foodName, defaultServings, callback) {
  // Create modal overlay
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = `
    <div style="background:#1e293b;border-radius:16px;padding:24px;width:280px;box-shadow:0 8px 32px rgba(0,0,0,0.5)">
      <div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:4px">${esc(foodName)}</div>
      <div style="font-size:12px;color:#64748b;margin-bottom:16px">How many servings?</div>
      <input id="_srvInput" type="number" min="0.25" max="20" step="0.25" value="${defaultServings}"
        style="width:100%;background:#0f172a;border:1.5px solid #334155;border-radius:10px;padding:12px;color:#fff;font-size:20px;font-weight:700;text-align:center;outline:none;font-family:inherit;box-sizing:border-box"/>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button onclick="document.getElementById('_srvInput').value=Math.max(0.25,(parseFloat(document.getElementById('_srvInput').value)||1)-0.5)"
          style="flex:1;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#fff;font-size:20px;padding:8px;cursor:pointer">−</button>
        <button onclick="document.getElementById('_srvInput').value=(parseFloat(document.getElementById('_srvInput').value)||1)+0.5"
          style="flex:1;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#fff;font-size:20px;padding:8px;cursor:pointer">+</button>
      </div>
      <div style="display:flex;gap:10px;margin-top:16px">
        <button id="_srvCancel" style="flex:1;background:#0f172a;border:1px solid #334155;border-radius:10px;color:#94a3b8;font-size:14px;font-weight:600;padding:12px;cursor:pointer;font-family:inherit">Cancel</button>
        <button id="_srvConfirm" style="flex:1;background:linear-gradient(135deg,#22c55e,#16a34a);border:none;border-radius:10px;color:#fff;font-size:14px;font-weight:700;padding:12px;cursor:pointer;font-family:inherit">Add</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById('_srvInput').focus(), 50);
  document.getElementById('_srvCancel').onclick = () => document.body.removeChild(overlay);
  document.getElementById('_srvConfirm').onclick = () => {
    const val = parseFloat(document.getElementById('_srvInput').value) || 1;
    document.body.removeChild(overlay);
    callback(val);
  };
  overlay.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('_srvConfirm').click();
    if (e.key === 'Escape') document.getElementById('_srvCancel').click();
  });
}

function quickAddFood(idx) {
  const saved = getStorage('savedFoods', []);
  const f = saved[idx];
  if (!f) return;
  showServingsPrompt(f.name, 1, function(servings) {
    const s = servings || 1;
    addFoodEntry({
      name: f.name,
      calories: Math.round((f.calories||0) * s),
      protein:  Math.round((f.protein||0)  * s * 10) / 10,
      carbs:    Math.round((f.carbs||0)    * s * 10) / 10,
      fat:      Math.round((f.fat||0)      * s * 10) / 10,
      servings: s,
      icon: '⚡'
    });
    showToast(`✅ ${f.name} added!`);
  });
}

function deleteSavedFood(idx) {
  const saved = getStorage('savedFoods', []);
  saved.splice(idx, 1);
  setStorage('savedFoods', saved);
  renderQuickRecs();
}

function saveFoodToSlot(food, slot) {
  if (!slot) { showToast('⚠️ Pick a meal time first'); return false; }
  const saved = getStorage('savedFoods', []);
  // avoid exact duplicates in same slot
  const exists = saved.some(f => f.name === food.name && f.slot === slot);
  if (exists) { showToast('Already saved in that slot!'); return false; }
  saved.push({ ...food, slot });
  setStorage('savedFoods', saved);
  showToast(`⭐ Saved to ${TIME_SLOTS[slot].label}!`);
  return true;
}

function saveManualFood() {
  const name = document.getElementById('manualFoodName').value.trim();
  if (!name) { showToast('⚠️ Enter a food name'); return; }
  if (!selectedTimeSlot) { showToast('⚠️ Pick a meal time'); return; }
  const food = {
    name,
    calories: parseInt(document.getElementById('in-calories').value) || 0,
    protein:  parseFloat(document.getElementById('in-protein').value)  || 0,
    carbs:    parseFloat(document.getElementById('in-carbs').value)    || 0,
    fat:      parseFloat(document.getElementById('in-fat').value)      || 0,
  };
  saveFoodToSlot(food, selectedTimeSlot);
  document.getElementById('manualFoodName').value = '';
  // reset picker
  document.querySelectorAll('#manualTimeSlotPicker .ts-btn').forEach(b => b.classList.remove('active'));
  selectedTimeSlot = null;
  renderQuickRecs();
}


let _lastDeletedEntry = null;
let _lastDeletedDateKey = null;

function showToast(msg, undoFn) {
  // Remove any existing toast
  document.querySelectorAll('.app-toast').forEach(t => t.remove());
  const toast = document.createElement('div');
  toast.className = 'app-toast';
  toast.style.cssText = 'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:#1e222d;color:#eef0f6;padding:10px 16px;border-radius:20px;font-size:13px;font-weight:600;z-index:400;white-space:nowrap;box-shadow:0 4px 20px rgba(0,0,0,0.4);border:1px solid #2a2f3d;display:flex;align-items:center;gap:12px;transition:opacity 0.3s';
  const msgSpan = document.createElement('span');
  msgSpan.textContent = msg;
  toast.appendChild(msgSpan);
  if (undoFn) {
    const undoBtn = document.createElement('button');
    undoBtn.textContent = 'UNDO';
    undoBtn.style.cssText = 'background:#22c55e;color:#000;border:none;border-radius:10px;padding:4px 10px;font-size:11px;font-weight:800;cursor:pointer;font-family:inherit;flex-shrink:0';
    undoBtn.onclick = () => { undoFn(); toast.remove(); };
    toast.appendChild(undoBtn);
  }
  document.body.appendChild(toast);
  const timer = setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, undoFn ? 4000 : 2200);
  toast.dataset.timer = timer;
}


// All USDA searches go through /api/usda/search backend proxy (API key stays server-side)
async function fetchUSDA(query, opts = {}) {
  const params = new URLSearchParams({ query });
  if (opts.dataType) params.set('dataType', opts.dataType);
  if (opts.pageSize) params.set('pageSize', String(opts.pageSize));
  const res = await fetch(`/api/usda/search?${params}`);
  if (!res.ok) throw new Error(`USDA proxy error ${res.status}`);
  return res.json();
}

// ── Barcode Scanner ──
let scannerStream = null;
let scannedProduct = null;
let _scanId = 0; // guards against race conditions between concurrent scans
let servings = 1;

async function openScanner() {
  document.getElementById('scannerModal').classList.add('open');
  document.getElementById('foodResult').style.display = 'none';
  document.getElementById('scanStatus').textContent = '🔍 Scanning for barcode…';
  document.getElementById('scanSubtitle').textContent = 'Point your camera at a barcode';
  document.getElementById('cameraView').style.display = 'block';
  scannedProduct = null;
  servings = 1;
  selectedTimeSlot = null;
  document.getElementById('srvVal').textContent = '1';

  // Auto-select current time slot
  const currentSlot = getTimeSlot();
  document.querySelectorAll('#scanTimeSlotPicker .ts-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.slot === currentSlot);
  });
  selectedTimeSlot = currentSlot;

  try {
    await startScanner();
  } catch (e) {
    document.getElementById('scanStatus').textContent = '⚠️ Camera access denied. Please allow camera in browser settings.';
  }
}

// Consensus-based scanning: require the same barcode N times before accepting
let _scanBuffer = {};
let _scanAccepted = false;
const SCAN_CONSENSUS = 3;       // need 3 matching reads
const SCAN_WINDOW_MS = 3000;    // reset buffer after 3s of no matches
let _nativeScanRAF = null;      // requestAnimationFrame handle for native scanner

// Try native BarcodeDetector first (much more accurate), fall back to QuaggaJS
async function startScanner() {
  _scanBuffer = {};
  _scanAccepted = false;

  // Check for native BarcodeDetector API (Chrome, Edge, Android, Safari 17.2+)
  if ('BarcodeDetector' in window) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      const needed = ['ean_13', 'ean_8', 'upc_a', 'upc_e'].filter(f => formats.includes(f));
      if (needed.length > 0) {
        await startNativeScanner(needed);
        return;
      }
    } catch(e) { /* fall through to QuaggaJS */ }
  }

  // Fallback to QuaggaJS
  await startQuagga();
}

// ── Native BarcodeDetector scanner (high accuracy) ──
async function startNativeScanner(formats) {
  const container = document.getElementById('quagga-container');
  const detector = new BarcodeDetector({ formats });

  // Get camera stream
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: 'environment',
      width: { ideal: 1280 },
      height: { ideal: 720 },
    }
  });
  scannerStream = stream;

  // Create/reuse video element
  let vid = container.querySelector('video');
  if (!vid) {
    vid = document.createElement('video');
    container.appendChild(vid);
  }
  vid.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:18px;display:block';
  vid.setAttribute('playsinline', '');
  vid.setAttribute('autoplay', '');
  vid.srcObject = stream;
  await vid.play();

  // Hide any QuaggaJS canvas artifacts
  container.querySelectorAll('canvas').forEach(c => c.style.display = 'none');

  // Scan loop using requestAnimationFrame for smooth performance
  let lastScanTime = 0;
  const SCAN_INTERVAL = 150; // scan every 150ms for responsiveness

  async function scanFrame(timestamp) {
    if (_scanAccepted) return;

    if (timestamp - lastScanTime >= SCAN_INTERVAL) {
      lastScanTime = timestamp;
      try {
        const barcodes = await detector.detect(vid);
        for (const barcode of barcodes) {
          const code = barcode.rawValue;
          if (!code || !isValidBarcode(code)) continue;

          handleScanResult(code);
          if (_scanAccepted) return;
        }
      } catch(e) { /* frame not ready, skip */ }
    }

    _nativeScanRAF = requestAnimationFrame(scanFrame);
  }

  _nativeScanRAF = requestAnimationFrame(scanFrame);
}

// ── Shared consensus handler ──
function handleScanResult(code) {
  if (_scanAccepted) return;

  const now = Date.now();
  if (!_scanBuffer[code]) _scanBuffer[code] = [];
  _scanBuffer[code].push(now);

  // Clean old entries
  _scanBuffer[code] = _scanBuffer[code].filter(t => now - t < SCAN_WINDOW_MS);

  // Find the code with the most reads
  const best = Object.keys(_scanBuffer).reduce((a, b) =>
    (_scanBuffer[a]?.length || 0) >= (_scanBuffer[b]?.length || 0) ? a : b, code);
  const count = _scanBuffer[best]?.length || 0;

  if (count < SCAN_CONSENSUS) {
    document.getElementById('scanStatus').textContent = `🔍 Reading barcode… (${count}/${SCAN_CONSENSUS})`;
    return;
  }

  // Consensus reached!
  _scanAccepted = true;
  stopCamera();
  lookupBarcode(best);
}

// ── QuaggaJS fallback (for older browsers) ──
function startQuagga() {
  return new Promise((resolve, reject) => {
    if (!window.Quagga) {
      document.getElementById('scanStatus').textContent = '⚠️ Scanner library failed to load. Try manual entry.';
      reject(new Error('Quagga not loaded'));
      return;
    }

    _scanBuffer = {};
    _scanAccepted = false;

    Quagga.init({
      inputStream: {
        name: 'Live',
        type: 'LiveStream',
        target: document.getElementById('quagga-container'),
        constraints: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      },
      frequency: 15,
      decoder: {
        readers: ['ean_reader', 'ean_8_reader', 'upc_reader', 'upc_e_reader'],
        debug: { drawBoundingBox: false, showFrequency: false, drawScanline: false, showPattern: false },
        multiple: false,
      },
      locator: {
        patchSize: 'medium',
        halfSample: false,
      },
      locate: true,
      area: { top: '20%', right: '5%', bottom: '20%', left: '5%' },
    }, (err) => {
      if (err) {
        document.getElementById('scanStatus').textContent = '⚠️ Could not start camera: ' + err.message;
        reject(err);
        return;
      }
      Quagga.start();

      // Style the Quagga-injected video to fill the container
      const vid = document.querySelector('#quagga-container video');
      if (vid) {
        vid.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:18px;display:block';
      }
      const canvas = document.querySelector('#quagga-container canvas');
      if (canvas) canvas.style.display = 'none';

      resolve();
    });

    Quagga.onDetected((result) => {
      if (_scanAccepted) return;

      const code = result.codeResult?.code;
      if (!code) return;

      // Check confidence: average decodedCodes error (lower = better)
      const errors = (result.codeResult.decodedCodes || [])
        .filter(d => d.error != null)
        .map(d => d.error);
      const avgError = errors.length > 0 ? errors.reduce((a, b) => a + b, 0) / errors.length : 1;
      if (avgError > 0.12) return; // stricter threshold for noisy reads

      // Validate checksum for UPC/EAN
      if (!isValidBarcode(code)) return;

      handleScanResult(code);
    });
  });
}

function isValidBarcode(code) {
  if (!/^\d{8,14}$/.test(code)) return false;
  // UPC-A (12), EAN-13 (13), EAN-8 (8) checksum validation
  const digits = code.split('').map(Number);
  const len = digits.length;
  if (len !== 8 && len !== 12 && len !== 13 && len !== 14) return false;
  let sum = 0;
  for (let i = 0; i < len - 1; i++) {
    const weight = (len - 1 - i) % 2 === 0 ? 1 : 3;
    sum += digits[i] * weight;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === digits[len - 1];
}


function renderFoodResult() {
  if (!scannedProduct) return;
  const p = scannedProduct;
  const s = servings;
  document.getElementById('cameraView').style.display = 'none';
  document.getElementById('foodResult').style.display = 'block';
  document.getElementById('foodName').textContent = p.name || 'Unknown';
  document.getElementById('foodBrand').textContent = p.brand || '';
  document.getElementById('srvVal').textContent = s % 1 === 0 ? s : s.toFixed(1);
  const cal   = Math.round((p.calories || 0) * s);
  const prot  = Math.round((p.protein  || 0) * s * 10) / 10;
  const carbs = Math.round((p.carbs    || 0) * s * 10) / 10;
  const fat   = Math.round((p.fat      || 0) * s * 10) / 10;
  document.getElementById('foodMacros').innerHTML =
    `<span style="color:#ef4444">${cal} cal</span> &nbsp;
     <span style="color:#3b82f6">P: ${prot}g</span> &nbsp;
     <span style="color:#f59e0b">C: ${carbs}g</span> &nbsp;
     <span style="color:#22c55e">F: ${fat}g</span>
     <div style="font-size:10px;color:var(--text3);margin-top:4px">per serving · ${p.servingSize||''} · via ${p.source||'DB'}</div>`;
  // Sanity warning if macros look off
  const warn = document.getElementById('scanMacroWarning');
  if (warn) warn.style.display = 'none';
}

function adjustServings(delta) {
  if (!scannedProduct) return;
  servings = Math.max(0.5, Math.round((servings + delta) * 2) / 2);
  renderFoodResult();
}

function logScannedFood() {
  if (!scannedProduct) return;
  const p = scannedProduct;
  const s = servings;
  const entry = {
    name:     p.name,
    calories: Math.round((p.calories || 0) * s),
    protein:  Math.round((p.protein  || 0) * s * 10) / 10,
    carbs:    Math.round((p.carbs    || 0) * s * 10) / 10,
    fat:      Math.round((p.fat      || 0) * s * 10) / 10,
    servings: s,
    icon:     '🔍',
  };
  // Save to quick-add slot if selected
  if (selectedTimeSlot) saveFoodToSlot(entry, selectedTimeSlot);
  closeScanner();
  addFoodEntry(entry);
}

// ══════════════════════════════════════════════════════════════════
// ── MULTI-DATABASE FOOD LOOKUP ENGINE ─────────────────────────────
// Covers: USDA FoodData Central (SR28/Foundation/Branded/UPC),
//         Open Food Facts (world + US),
//         UPC ItemDB (broad product coverage)
//
// For photo AI: two-phase approach
//   Phase 1 — Vision: Claude identifies each food + estimated portion
//   Phase 2 — DB lookup: query USDA for each identified food
//             and replace estimated values with database-accurate macros
// ══════════════════════════════════════════════════════════════════

// ── API Keys (editable in Settings) ──
// ── Sanity-check a parsed product ──
function isSaneProduct(p) {
  if (!p || !p.name) return false;
  if (p.calories < 0 || p.calories > 5000) return false;
  if (p.protein  < 0 || p.protein  > 400)  return false;
  if (p.carbs    < 0 || p.carbs    > 600)  return false;
  if (p.fat      < 0 || p.fat      > 400)  return false;
  // Only cross-check if we have all macros and meaningful calories
  const calc = p.protein * 4 + p.carbs * 4 + p.fat * 9;
  if (p.calories > 50 && calc > 0 && (calc / p.calories < 0.3 || calc / p.calories > 3.0)) return false;
  return true;
}

// ── Parse Open Food Facts product ──
function parseOFProduct(p) {
  const n = p.nutriments || {};
  const servingQty = parseFloat(p.serving_quantity) || 0;
  const scale = servingQty > 0 ? servingQty / 100 : 1;

  function get(base) {
    const keys = [base, base.replace('-','_'), base.replace('_','-')];
    for (const k of keys) {
      const sv = n[`${k}_serving`];
      if (sv != null && !isNaN(+sv) && +sv >= 0) return +sv;
    }
    for (const k of keys) {
      const v = n[`${k}_100g`];
      if (v != null && !isNaN(+v) && +v >= 0) return +v * scale;
    }
    for (const k of keys) {
      if (n[k] != null && !isNaN(+n[k]) && +n[k] >= 0) return +n[k];
    }
    return 0;
  }

  let cals = get('energy-kcal');
  if (cals === 0) { const kj = get('energy'); if (kj > 0) cals = kj / 4.184; }

  return {
    name:        p.product_name_en || p.product_name || p.abbreviated_product_name || '',
    brand:       p.brands || '',
    calories:    Math.round(cals),
    protein:     Math.round(get('proteins') * 10) / 10,
    carbs:       Math.round(get('carbohydrates') * 10) / 10,
    fat:         Math.round(get('fat') * 10) / 10,
    servingSize: p.serving_size || (servingQty > 0 ? `${servingQty}g` : '1 serving'),
    source:      'Open Food Facts',
  };
}
// ── Parse USDA FoodData Central product (search result) ──
function parseUSDAProduct(f) {
  const nutr = id => {
    const hit = (f.foodNutrients||[]).find(x =>
      x.nutrientId===id || x.nutrientNumber===String(id) || x.nutrientId===String(id));
    return hit?.value ?? 0;
  };
  let servingG = parseFloat(f.servingSize) || 0;
  const unit = (f.servingSizeUnit||'g').toLowerCase();
  if (unit==='oz') servingG *= 28.3495;
  else if (unit==='lb') servingG *= 453.592;
  const scale = servingG > 0 ? servingG / 100 : 1;
  const cal100  = nutr(1008)||nutr(208);
  const prot100 = nutr(1003)||nutr(203);
  const carb100 = nutr(1005)||nutr(205);
  const fat100  = nutr(1004)||nutr(204);
  const micros  = parseMicronutrients ? parseMicronutrients(f.foodNutrients, scale) : {};
  return {
    name:        f.description || '',
    brand:       f.brandOwner || f.brandName || '',
    calories:    Math.round(cal100  * scale),
    protein:     Math.round(prot100 * scale * 10)/10,
    carbs:       Math.round(carb100 * scale * 10)/10,
    fat:         Math.round(fat100  * scale * 10)/10,
    servingSize: servingG > 0 ? `${f.servingSize}${f.servingSizeUnit||'g'}` : '100g',
    source:      'USDA FDC',
    micros,
  };
}

// ── Barcode lookup: sequential cascade across all databases ──
async function lookupBarcode(barcode) {
  const myId = ++_scanId;
  document.getElementById('scanStatus').textContent = `⏳ Looking up ${barcode}…`;
  document.getElementById('cameraView').style.display = 'none';
  stopCamera();

  try {
    const prod = await lookupBarcodeMultiDB(barcode);
    if (myId !== _scanId) return; // a newer scan started — discard this result
    if (prod && !prod.incomplete) {
      scannedProduct = prod;
      servings = 1;
      renderFoodResult();
      document.getElementById('scanStatus').textContent = `✅ Found: ${prod.name}`;
      return;
    }

    // Not found or incomplete — show label scan option
    const productName = prod?.name || '';
    showBarcodeNotFound(barcode, productName);

  } catch(e) {
    if (myId !== _scanId) return;
    showBarcodeNotFound(barcode, '');
    console.error('lookupBarcode error:', e);
  }
}

function showBarcodeNotFound(barcode, productName) {
  const nameHint = productName ? `<div style="font-size:12px;color:#94a3b8;margin-bottom:8px">Identified: ${esc(productName)}</div>` : '';
  document.getElementById('scanStatus').innerHTML = `
    <div style="text-align:center;padding:4px 0">
      ${nameHint}
      <div style="font-size:13px;font-weight:600;color:#f59e0b;margin-bottom:12px">
        ⚠️ Nutrition data not found for this barcode
      </div>
      <div style="font-size:12px;color:#94a3b8;margin-bottom:14px">
        Point camera at the <b style="color:#fff">Nutrition Facts label</b> to read it automatically
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button onclick="scanNutritionLabel('${esc(barcode)}','${esc(productName).replace(/'/g,"&#39;")}')"
          style="background:linear-gradient(135deg,#7c3aed,#4f46e5);border:none;border-radius:12px;padding:12px 16px;color:#fff;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px">
          📸 Scan Nutrition Label
        </button>
        <button onclick="rescanBarcode()"
          style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:10px 16px;color:#94a3b8;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">
          🔄 Try Barcode Again
        </button>
      </div>
    </div>`;
}

async function scanNutritionLabel(barcode, productName) {
  // Open a camera input specifically for reading the nutrition label
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';
  input.style.display = 'none';
  document.body.appendChild(input);

  input.onchange = async () => {
    const file = input.files[0];
    document.body.removeChild(input);
    if (!file) return;

    document.getElementById('scanStatus').textContent = '📸 Reading nutrition label…';

    const reader = new FileReader();
    reader.onload = async (e) => {
      const dataUrl = e.target.result;
      const base64  = dataUrl.split(',')[1];

      document.getElementById('scanStatus').textContent = '🤖 Extracting nutrition data…';

      try {
        const resp = await callClaudeAPI({
          model: 'claude-sonnet-4-6',
          max_tokens: 512,
          messages: [{role:'user', content:[
            {type:'image', source:{type:'base64', media_type:'image/jpeg', data:base64}},
            {type:'text', text: `This is a photo of a Nutrition Facts label${productName ? ` for "${productName}"` : ''}.
Extract the nutrition information per serving.
Return ONLY valid JSON:
{"name":"${productName || 'Food Item'}","serving_size":"e.g. 1 cup (140g)","calories":0,"protein":0,"carbs":0,"fat":0}
Use exact values from the label. If you cannot read a value clearly, use 0.`}
          ]}]
        });

        const txt = resp.content?.find(b=>b.type==='text')?.text || '';
        const data = JSON.parse(txt.replace(/```json|```/g,'').trim());

        if (data && data.calories >= 0) {
          scannedProduct = {
            name:        data.name || productName || 'Food Item',
            brand:       '',
            calories:    Math.round(data.calories || 0),
            protein:     Math.round((data.protein || 0) * 10) / 10,
            carbs:       Math.round((data.carbs   || 0) * 10) / 10,
            fat:         Math.round((data.fat     || 0) * 10) / 10,
            servingSize: data.serving_size || '1 serving',
            source:      'Label Scan',
          };
          servings = 1;
          renderFoodResult();
          document.getElementById('scanStatus').textContent = `✅ Label read: ${scannedProduct.name}`;
        } else {
          document.getElementById('scanStatus').textContent = '❌ Could not read label — try again with better lighting';
          showBarcodeNotFound(barcode, productName);
        }
      } catch(err) {
        document.getElementById('scanStatus').textContent = '❌ Error reading label';
        showBarcodeNotFound(barcode, productName);
      }
    };
    reader.readAsDataURL(file);
  };

  input.click();
}


function rescanBarcode() {
  document.getElementById('cameraView').style.display = 'block';
  document.getElementById('foodResult').style.display = 'none';
  document.getElementById('scanStatus').textContent = '🔍 Scanning for barcode…';
  scannedProduct = null;
  _scanBuffer = {};
  _scanAccepted = false;
  openScannerCamera();
}

function extractServingGrams(servingStr) {
  if (!servingStr) return 0;
  const ozMatch  = servingStr.match(/([\d.]+)\s*oz/i);
  if (ozMatch) return parseFloat(ozMatch[1]) * 28.3495;
  const gMatch   = servingStr.match(/([\d.]+)\s*g/i);
  if (gMatch) return parseFloat(gMatch[1]);
  const mlMatch  = servingStr.match(/([\d.]+)\s*ml/i);
  if (mlMatch) return parseFloat(mlMatch[1]); // assume 1g/ml
  const cupMatch = servingStr.match(/([\d.]+)\s*cup/i);
  if (cupMatch) return parseFloat(cupMatch[1]) * 240;
  const tbspMatch = servingStr.match(/([\d.]+)\s*tbsp/i);
  if (tbspMatch) return parseFloat(tbspMatch[1]) * 15;
  return 0;
}

// ── Enhanced AI nutrition prompt with multi-database knowledge ──
// ── Barcode lookup: cascade across all databases ──
async function lookupBarcodeMultiDB(barcode) {
  const log = msg => { const el = document.getElementById('scanStatus'); if(el) el.textContent = msg; };
  // Normalise barcode — OFF canonical format is EAN-13 (13 digits)
  const ean13  = barcode.length === 12 ? '0' + barcode : barcode;
  const upcA   = barcode.length === 13 && barcode.startsWith('0') ? barcode.slice(1) : barcode;
  const allCodes = [...new Set([barcode, ean13, upcA])];

  // OFF requires User-Agent header to avoid bot-detection bans
  const OFF_HDR = {
    'User-Agent': 'MacroTracker/1.0 (jeremy@dronenerd.com)',
    'Accept': 'application/json',
  };
  const OFF_FIELDS = 'product_name,product_name_en,abbreviated_product_name,brands,serving_size,serving_quantity,nutriments,nutrition_data_per,ecoscore_grade';

  // Cache check
  const cache = getStorage('barcodeCache', {});
  for (const code of allCodes) {
    if (cache[code]) { log('✅ Found (cached)'); return cache[code]; }
  }

  function saveCache(product) {
    allCodes.forEach(c => { cache[c] = product; });
    setStorage('barcodeCache', cache);
    return product;
  }

  // 1-3. Search OFF.net, USDA, OFF.org in parallel — first valid result wins
  log('⏳ Searching food databases…');

  const offSearch = async (baseUrl, label) => {
    for (const code of allCodes) {
      const r = await fetch(`${baseUrl}/api/v2/product/${code}?fields=${OFF_FIELDS}`, { headers: OFF_HDR });
      if (!r.ok) continue;
      const d = await r.json();
      if (d.status === 1 && d.product) {
        const p = parseOFProduct(d.product);
        if (isSaneProduct(p) && p.calories > 0) return p;
      }
    }
    throw new Error(`${label}: not found`);
  };

  const usdaSearch = async () => {
    for (const code of allCodes) {
      const r = await fetch(`/api/usda/search?query=${code}&dataType=Branded&pageSize=5`);
      if (!r.ok) continue;
      const d = await r.json();
      const foods = d.foods || [];
      const exact = foods.find(f => f.gtinUpc && allCodes.includes(f.gtinUpc));
      const hit = exact || foods.find(f => f.gtinUpc);
      if (hit) {
        const p = parseUSDAProduct(hit);
        if (isSaneProduct(p) && p.calories > 0) return p;
      }
    }
    throw new Error('USDA: not found');
  };

  try {
    const result = await Promise.any([
      offSearch('https://world.openfoodfacts.net', 'OFF.net'),
      usdaSearch(),
      offSearch('https://world.openfoodfacts.org', 'OFF.org'),
    ]);
    log('✅ Found in food database');
    return saveCache(result);
  } catch(e) { /* all three failed, continue to fallbacks */ }

  // 5. UPC ItemDB → USDA name lookup
  try {
    log('⏳ Searching UPC database…');
    const r = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${upcA}`);
    if (r.ok) {
      const d = await r.json();
      const item = (d.items || [])[0];
      if (item && item.title) {
        log(`⏳ Found "${item.title.slice(0,30)}" — looking up nutrition…`);
        const usdaHit = await searchUSDAByName(item.title);
        if (usdaHit) {
          usdaHit.name  = item.title;
          usdaHit.brand = item.brand || '';
          log('✅ Found via UPC + USDA');
          return saveCache(usdaHit);
        }
        return { name: item.title, brand: item.brand || '', calories: 0, protein: 0, carbs: 0, fat: 0, servingSize: '1 serving', source: 'UPC ItemDB', incomplete: true };
      }
    }
  } catch(e) { console.warn('UPCItemDB:', e); }

  // 6. AI fallback
  try {
    log('⏳ Asking AI to identify product…');
    const aiResp = await callClaudeAPI({
      model: 'claude-haiku-4-5-20251001', max_tokens: 300,
      messages: [{ role: 'user', content:
        `Barcode ${barcode} is a grocery product. Identify it and estimate nutrition per serving. ` +
        `Return ONLY JSON: {"name":"","brand":"","calories":0,"protein":0,"carbs":0,"fat":0,"servingSize":"1 serving"} or null if unknown.`
      }]
    });
    const txt = aiResp.content?.find(b => b.type === 'text')?.text || '';
    const parsed = JSON.parse(txt.replace(/```json|```/g, '').trim());
    if (parsed && parsed.name && parsed.calories > 0) {
      log('✅ AI identified product');
      return saveCache({ ...parsed, source: 'AI Est' });
    }
  } catch(e) { /* optional */ }

  return null;
}

// ── USDA name search (used by UPC fallback) ──
async function searchUSDAByName(name) {
  try {
    const r = await fetch(
      `/api/usda/search?query=${encodeURIComponent(name)}` +
      `&dataType=Branded,Foundation,SR%20Legacy&pageSize=3`
    );
    const d = await r.json();
    const hit = (d.foods||[])[0];
    return hit ? parseUSDAProduct(hit) : null;
  } catch(e) { return null; }
}

// ── Multi-DB text search for AI Search modal ──
async function searchFoodMultiDB(query) {
  const results = [];
  const seen = new Set();
  const dedup = p => { const k=p.name.toLowerCase().slice(0,25).trim(); if(seen.has(k))return false; seen.add(k);return true; };

  // 1. USDA Foundation + SR Legacy (best micros)
  try {
    const r = await fetch(
      `/api/usda/search?query=${encodeURIComponent(query)}&dataType=Foundation,SR%20Legacy&pageSize=5`
    );
    const d = await r.json();
    (d.foods||[]).forEach(f => { const p=parseUSDAProduct(f); if(isSaneProduct(p)&&dedup(p)) results.push({...p,microQuality:'full'}); });
  } catch(e) {}

  // 2. USDA Branded
  try {
    const r = await fetch(
      `/api/usda/search?query=${encodeURIComponent(query)}&dataType=Branded&pageSize=5`
    );
    const d = await r.json();
    (d.foods||[]).forEach(f => { const p=parseUSDAProduct(f); if(isSaneProduct(p)&&dedup(p)) results.push({...p,microQuality:'partial'}); });
  } catch(e) {}

  // 3. Open Food Facts text search
  try {
    const r = await fetch(
      `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}` +
      `&search_simple=1&action=process&json=1&page_size=4` +
      `&fields=product_name,brands,serving_size,serving_quantity,nutriments`
    );
    const d = await r.json();
    (d.products||[]).forEach(p => { const prod=parseOFProduct(p); if(isSaneProduct(prod)&&prod.calories>0&&dedup(prod)) results.push(prod); });
  } catch(e) {}

  return results.slice(0, 10);
}

// ── Two-phase photo AI: Vision + DB lookup ──
async function analyzePhotoWithDB() {
  if (!photoBase64) return;
  document.getElementById('photoStep1').style.display = 'none';
  document.getElementById('photoStep2').style.display = 'block';

  const msgEl  = document.getElementById('aiLoadingMsg');
  const hint   = document.getElementById('photoHint').value.trim();
  msgEl.textContent = 'Analysing photo…';

  try {
    // Single Opus call: identify food + estimate macros for EXACTLY what is visible
    // Sending the image every time — no text-only fallback that can hallucinate
    const prompt = `You are a registered dietitian and precise nutrition analyst.
Look at this food photo carefully.

CRITICAL RULES:
1. Only measure what is VISIBLE in the photo — the actual portion shown, not a full container or package
2. If you see a container/package, estimate only how much is inside or how much is being served
3. Use USDA FoodData Central / SR28 reference values for accuracy
4. Be conservative with portion sizes — people often underestimate
${hint ? `5. User note: "${hint}"` : ''}

For each distinct food item visible:
- Identify the food precisely (e.g. "plain nonfat Greek yogurt" not just "yogurt")
- Estimate the grams of THAT PORTION as it appears in the photo
- Look at the container/bowl/plate size for scale

Then calculate total macros by summing all items.

Return ONLY valid JSON (no markdown, no explanation):
{
  "meal_name": "concise descriptive name of what you see",
  "items": [
    {
      "name": "precise food name",
      "grams": 170,
      "calories": 100,
      "protein": 16,
      "carbs": 9,
      "fat": 0,
      "notes": "e.g. estimated from container label visible, or typical serving"
    }
  ],
  "total_calories": 100,
  "total_protein": 16,
  "total_carbs": 9,
  "total_fat": 0,
  "confidence": "high",
  "portion_notes": "brief explanation of how you estimated the portion"
}`;

    msgEl.textContent = 'Identifying food and calculating macros…';

    const resp = await callClaudeAPI({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{role:'user', content:[
        {type:'image', source:{type:'base64', media_type:'image/jpeg', data:photoBase64}},
        {type:'text', text:prompt}
      ]}]
    });

    const rawText = resp.content?.find(b=>b.type==='text')?.text || '';
    let result;
    try {
      result = JSON.parse(rawText.replace(/```json|```/g,'').trim());
    } catch(e) {
      // Try to extract JSON from response
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) result = JSON.parse(jsonMatch[0]);
      else throw new Error('Could not parse AI response');
    }

    // Build per-item description
    const items = result.items || [];
    const description = items.length > 0
      ? items.map(it => `${it.name} (~${it.grams}g): ${it.calories}cal P:${it.protein}g C:${it.carbs}g F:${it.fat}g`).join('\n')
        + (result.portion_notes ? `\n\n📐 ${result.portion_notes}` : '')
      : result.portion_notes || '';

    aiProduct = {
      name:        result.meal_name || 'Meal',
      description: description,
      calories:    Math.round(result.total_calories || 0),
      protein:     Math.round((result.total_protein || 0) * 10) / 10,
      carbs:       Math.round((result.total_carbs   || 0) * 10) / 10,
      fat:         Math.round((result.total_fat     || 0) * 10) / 10,
      confidence:  result.confidence || 'medium',
      db_verified: false,
    };

    aiServings = 1;
    renderAIResult();

  } catch(err) {
    document.getElementById('photoStep2').style.display = 'none';
    document.getElementById('photoStep1').style.display = 'block';
    document.getElementById('photoPreviewWrap').style.display = 'block';
    document.getElementById('photoPlaceholder').style.display = 'none';
    document.getElementById('analyzeBtn').disabled = false;
    document.getElementById('analyzeBtn').style.opacity = '1';
    showToast('\u274c Error: ' + (err.message || 'Try again'));
  }
}


function buildNutritionKnowledgePrompt(hint, visionData) {
  return `You are a precision sports nutrition expert with deep knowledge of:
- USDA FoodData Central / SR28 (gold standard US composition data)
- NCCDB (Nutrition Coordinating Center Food & Nutrient Database)
- Canadian Nutrient File (CNF 2015)
- McCance & Widdowson's CoFID (UK food composition)
- NEVO Dutch Food Composition Database
- Australian Food Composition Database (NUTTAB)
- Open Food Facts global product database

${hint ? `User note: "${hint}"` : ''}
${visionData ? `Food items identified: ${(visionData.items||[]).map(i=>`${i.display_name} (~${i.grams_in_photo}g)`).join(', ')}` : ''}

Using your cross-database nutritional knowledge, calculate the precise macros for this meal.

Key reference values you should use:
- Chicken breast (cooked): 165cal/100g, 31g protein, 0g carbs, 3.6g fat (USDA SR)
- White rice (cooked): 130cal/100g, 2.7g protein, 28g carbs, 0.3g fat (USDA SR)
- Brown rice (cooked): 123cal/100g, 2.7g protein, 26g carbs, 1g fat
- Salmon (cooked): 208cal/100g, 20g protein, 0g carbs, 13g fat
- Whole egg (large): 78cal, 6g protein, 0.6g carbs, 5g fat
- Broccoli (steamed): 35cal/100g, 2.4g protein, 7g carbs, 0.4g fat
- Sweet potato (baked): 90cal/100g, 2g protein, 21g carbs, 0.1g fat
- Olive oil: 884cal/100g, 0g protein, 0g carbs, 100g fat
- Ground beef 80/20 (cooked): 250cal/100g, 26g protein, 0g carbs, 17g fat
- Oats (dry): 389cal/100g, 17g protein, 66g carbs, 7g fat
- Greek yogurt (plain, 2%): 59cal/100g, 10g protein, 3.6g carbs, 0.4g fat

Return ONLY JSON:
{
  "meal_name": "Descriptive name",
  "description": "Breakdown per item with gram estimates and which database reference was used",
  "calories": <integer>,
  "protein": <number 1 decimal>,
  "carbs": <number 1 decimal>,
  "fat": <number 1 decimal>,
  "confidence": "high" | "medium" | "low"
}`;
}



async function openScannerCamera() {
  try { await startScanner(); } catch(e) {}
}

function stopCamera() {
  // Cancel native BarcodeDetector scan loop
  if (_nativeScanRAF) {
    cancelAnimationFrame(_nativeScanRAF);
    _nativeScanRAF = null;
  }
  try {
    if (window.Quagga) Quagga.stop();
  } catch(e) {}
  try {
    if (scannerStream) {
      scannerStream.getTracks().forEach(t => t.stop());
      scannerStream = null;
    }
  } catch(e) {}
  // Stop any video elements in the scanner
  document.querySelectorAll('#quagga-container video').forEach(v => {
    try { v.srcObject?.getTracks().forEach(t => t.stop()); v.srcObject = null; } catch(e) {}
  });
}

function closeScanner() {
  stopCamera();
  document.getElementById('scannerModal').classList.remove('open');
  document.getElementById('foodResult').style.display = 'none';
  document.getElementById('cameraView').style.display = 'block';
  document.getElementById('scanStatus').textContent = '🔍 Scanning for barcode…';
  scannedProduct = null;
}

// ── AI Food Search ──
let aiSearchProduct  = null;
let aiSearchServings = 1;

function openAISearch() {
  aiSearchProduct  = null;
  aiSearchServings = 1;
  document.getElementById('aiSearchInput').value = '';
  document.getElementById('aiSearchLoading').style.display  = 'none';
  document.getElementById('aiSearchResults').style.display  = 'none';
  document.getElementById('aiSearchSelected').style.display = 'none';
  document.getElementById('aiSearchExamples').style.display = 'flex';
  document.getElementById('aiSearchModal').classList.add('open');
  setTimeout(() => document.getElementById('aiSearchInput').focus(), 300);
}

function closeAISearch() {
  document.getElementById('aiSearchModal').classList.remove('open');
}

function setSearchExample(btn) {
  document.getElementById('aiSearchInput').value = btn.textContent.replace(/^[^\s]+\s/,'').trim();
  runAISearch();
}

function backToAISearch() {
  document.getElementById('aiSearchSelected').style.display = 'none';
  document.getElementById('aiSearchResults').style.display  = 'block';
  document.getElementById('aiSearchExamples').style.display = 'none';
}

// ── Food search tab switching ──
function switchFoodSearchTab(tab) {
  ['search','meal','supp'].forEach(t => {
    const btn = document.getElementById('fstab-'+t);
    const panel = document.getElementById('fstab-'+t+'-content');
    if (btn) btn.classList.toggle('fstab-active', t === tab);
    if (panel) panel.style.display = t === tab ? '' : 'none';
  });
  if (tab === 'supp') renderSuppPresets();
}

// Parse a USDA food item into a standardized product object
function usdaFoodToProduct(f) {
  const nutr = n => (f.foodNutrients || []).find(x =>
    x.nutrientId === n || x.nutrientNumber === String(n) ||
    x.nutrientId === String(n)
  );
  let servingG = parseFloat(f.servingSize) || 0;
  const sUnit = (f.servingSizeUnit || 'g').toLowerCase();
  if (sUnit === 'oz') servingG *= 28.3495;
  else if (sUnit === 'lb') servingG *= 453.592;
  const scale = servingG > 0 ? servingG / 100 : 1;
  return {
    name:     f.description,
    brand:    f.brandOwner || f.brandName || f.dataType || '',
    serving:  f.servingSize ? `${f.servingSize}${f.servingSizeUnit || 'g'}` : '100g',
    calories: Math.round((nutr(1008)?.value || nutr(208)?.value || 0) * scale),
    protein:  Math.round((nutr(1003)?.value || nutr(203)?.value || 0) * scale * 10) / 10,
    carbs:    Math.round((nutr(1005)?.value || nutr(205)?.value || 0) * scale * 10) / 10,
    fat:      Math.round((nutr(1004)?.value || nutr(204)?.value || 0) * scale * 10) / 10,
    micros:   parseMicronutrients(f.foodNutrients, scale),
    fdcId:    f.fdcId,
    dataType: f.dataType,
    source:   'usda',
    confidence: 'high',
  };
}

// Search USDA — Foundation + SR Legacy first (best micros), then Branded
async function searchUSDAFull(query) {
  // First: whole foods (Foundation Foods + SR Legacy) — most complete micronutrient data
  const [wfRes, brandedRes] = await Promise.all([
    fetch(`/api/usda/search?query=${encodeURIComponent(query)}&dataType=Foundation,SR%20Legacy&pageSize=6`),
    fetch(`/api/usda/search?query=${encodeURIComponent(query)}&dataType=Branded&pageSize=6`)
  ]);

  let results = [];

  if (wfRes.ok) {
    const wfData = await wfRes.json();
    const wf = (wfData.foods || []).map(f => ({ ...usdaFoodToProduct(f), microQuality: 'full' }))
      .filter(f => f.calories > 0);
    results.push(...wf);
  }

  if (brandedRes.ok) {
    const bData = await brandedRes.json();
    const branded = (bData.foods || []).map(f => ({ ...usdaFoodToProduct(f), microQuality: 'partial' }))
      .filter(f => f.calories > 0);
    results.push(...branded);
  }

  // Dedupe by name similarity, prefer Foundation/SR Legacy
  const seen = new Set();
  return results.filter(f => {
    const key = f.name.toLowerCase().slice(0, 30);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

async function runAISearch() {
  const query = document.getElementById('aiSearchInput').value.trim();
  if (!query) { showToast('⚠️ Describe a food first'); return; }

  document.getElementById('aiSearchExamples').style.display = 'none';
  document.getElementById('aiSearchResults').style.display  = 'none';
  document.getElementById('aiSearchSelected').style.display = 'none';
  document.getElementById('aiSearchLoading').style.display  = 'block';
  document.getElementById('aiSearchLoadingText').textContent = 'Searching USDA database…';

  try {
    const foods = await searchFoodMultiDB(query);

    if (foods.length > 0) {
      document.getElementById('aiSearchLoading').style.display = 'none';
      renderAISearchResults(foods);
      return;
    }

    // ── Fallback: Claude AI with full micro estimation ──
    document.getElementById('aiSearchLoadingText').textContent = 'Estimating with AI…';

    const prompt = 'You are a precise nutrition database. The user searched for: "' + query + '".' +
      ' Return 3 matching foods as JSON only, no markdown:' +
      ' {"results":[{"name":"Full food name","brand":"Brand or Generic","serving":"1 serving description",' +
      '"calories":0,"protein":0,"carbs":0,"fat":0,' +
      '"micros":{"vitC":0,"vitD":0,"vitB12":0,"calcium":0,"magnesium":0,"iron":0,"potassium":0,"zinc":0,"fiber":0,"sodium":0,"omega3":0},' +
      '"confidence":"high","microQuality":"estimated"}]}.' +
      ' Use real nutritional data. Fill in micros with best available estimates in mg or standard units.';

    const data = await callClaudeAPI({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });

    document.getElementById('aiSearchLoading').style.display = 'none';
    const text = (data.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON');
    const parsed = JSON.parse(jsonMatch[0]);
    renderAISearchResults((parsed.results || []).map(r => ({ ...r, source: 'ai' })));

  } catch (err) {
    document.getElementById('aiSearchLoading').style.display = 'none';
    document.getElementById('aiSearchExamples').style.display = 'flex';
    showToast('⚠️ Search failed — try again');
    console.error(err);
  }
}

function renderAISearchResults(results) {
  if (!results.length) {
    showToast('No results found — try a different description');
    document.getElementById('aiSearchExamples').style.display = 'flex';
    return;
  }

  const confIcon = { high: '✅', medium: '🟡', low: '⚪' };

  document.getElementById('aiSearchResultsList').innerHTML = results.map((r, i) => {
    const microCount = Object.keys(r.micros || {}).length;
    const microLabel = r.microQuality === 'full'     ? '🟢 Full micros' :
                       r.microQuality === 'partial'   ? '🟡 Partial micros' :
                       r.microQuality === 'estimated' ? '🔵 AI estimated' :
                       microCount > 5                 ? '🟢 Full micros' :
                       microCount > 0                 ? '🟡 Partial micros' : '⚪ Macros only';
    const srcBg = r.source === 'usda' ? '#0d1e3d' : '#1a1030';
    const srcCol = r.source === 'usda' ? '#60a5fa' : '#a78bfa';
    return `<div class="search-result-item" onclick="selectAISearchResult(${i})">
      <div style="flex:1">
        <div class="search-result-name">${esc(r.name)}</div>
        <div class="search-result-macros">${r.brand ? esc(r.brand) + ' · ' : ''}${esc(r.serving)}</div>
        <div class="search-result-macros" style="margin-top:3px">
          <span style="color:#f59e0b;font-weight:700">${r.calories} kcal</span> ·
          <span style="color:#22c55e">P ${r.protein}g</span> ·
          <span style="color:#3b82f6">C ${r.carbs}g</span> ·
          <span style="color:#ef4444">F ${r.fat}g</span>
          <span style="margin-left:6px;font-size:9px;background:${srcBg};color:${srcCol};padding:2px 6px;border-radius:8px;font-weight:700">${r.source === 'usda' ? 'USDA' : 'AI'}</span>
          <span style="margin-left:4px;font-size:9px;color:var(--text3)">${microLabel}</span>
        </div>
      </div>
      <div class="search-result-arrow">›</div>
    </div>`;
  }).join('');

  window._aiSearchResults = results;
  document.getElementById('aiSearchResults').style.display = 'block';
}

function selectAISearchResult(idx) {
  const r = window._aiSearchResults[idx];
  aiSearchProduct  = r;
  aiSearchServings = 1;

  document.getElementById('aiSearchResults').style.display  = 'none';
  renderAISearchFoodCard();
  document.getElementById('aiSearchSelected').style.display = 'block';
  document.getElementById('aiSearchServingsVal').textContent = '1';
}

function renderAISearchFoodCard() {
  if (!aiSearchProduct) return;
  const p = aiSearchProduct;
  const s = aiSearchServings;
  document.getElementById('aiSearchFoodCard').innerHTML = `
    <div class="food-name">${esc(p.name)}</div>
    <div class="food-brand">${esc(p.brand)} · ${esc(p.serving)} per serving</div>
    <div class="food-macros">
      <div class="food-macro-chip">
        <div class="food-macro-chip-val" style="color:#f59e0b">${Math.round(p.calories*s)}</div>
        <div class="food-macro-chip-lbl">kcal</div>
      </div>
      <div class="food-macro-chip">
        <div class="food-macro-chip-val" style="color:#22c55e">${(p.protein*s).toFixed(1)}g</div>
        <div class="food-macro-chip-lbl">protein</div>
      </div>
      <div class="food-macro-chip">
        <div class="food-macro-chip-val" style="color:#3b82f6">${(p.carbs*s).toFixed(1)}g</div>
        <div class="food-macro-chip-lbl">carbs</div>
      </div>
      <div class="food-macro-chip">
        <div class="food-macro-chip-val" style="color:#ef4444">${(p.fat*s).toFixed(1)}g</div>
        <div class="food-macro-chip-lbl">fat</div>
      </div>
    </div>`;
}

function adjustAISearchServings(delta) {
  aiSearchServings = Math.max(0.5, Math.round((aiSearchServings + delta) * 2) / 2);
  document.getElementById('aiSearchServingsVal').textContent = aiSearchServings;
  renderAISearchFoodCard();
}

function logAISearchFood() {
  if (!aiSearchProduct) return;
  const p = aiSearchProduct;
  const s = aiSearchServings;
  const scaledMicros = {};
  if (p.micros) {
    Object.entries(p.micros).forEach(([k, v]) => {
      scaledMicros[k] = Math.round(v * s * 1000) / 1000;
    });
  }
  addFoodEntry({
    name:     `${p.name}${s !== 1 ? ' ×'+s : ''}`,
    calories: Math.round(p.calories * s),
    protein:  Math.round(p.protein  * s * 10) / 10,
    carbs:    Math.round(p.carbs    * s * 10) / 10,
    fat:      Math.round(p.fat      * s * 10) / 10,
    icon: '🔍',
    micros: Object.keys(scaledMicros).length ? scaledMicros : undefined,
  });
  closeAISearch();
  showToast(`✅ ${p.name} logged!`);
}

// ── AI Photo Macro Estimator ──
let photoBase64 = null;
let aiProduct = null;
let aiServings = 1;
let aiSelectedSlot = null;

function openPhotoAI() {
  document.getElementById('photoModal').classList.add('open');
  resetPhoto();
  // Auto-select current time slot
  const slot = getTimeSlot();
  document.querySelectorAll('#aiTimeSlotPicker .ts-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.slot === slot);
  });
  aiSelectedSlot = slot;
}

function closePhotoModal() {
  document.getElementById('photoModal').classList.remove('open');
  resetPhoto();
}

function triggerCamera() { document.getElementById('cameraInput').click(); }
function triggerGallery() { document.getElementById('galleryInput').click(); }

// Downscale to ≤1024px max edge, JPEG q0.85 — keeps uploads small (worker caps ~2MB)
function downscalePhoto(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const maxEdge = 1024;
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      if (scale >= 1 && dataUrl.startsWith('data:image/jpeg')) return resolve(dataUrl);
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function handlePhotoInput(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    const dataUrl = await downscalePhoto(e.target.result);
    photoBase64 = dataUrl.split(',')[1];
    // Persist to sessionStorage so Android camera modal-collapse can restore it
    try { sessionStorage.setItem('pendingPhotoDataUrl', dataUrl); } catch(e) {}
    document.getElementById('photoPreview').src = dataUrl;
    document.getElementById('photoPreviewWrap').style.display = 'block';
    document.getElementById('photoPlaceholder').style.display = 'none';
    document.getElementById('analyzeBtn').disabled = false;
    document.getElementById('analyzeBtn').style.opacity = '1';
    // Make sure photo modal is open (Android camera can collapse it)
    document.getElementById('photoModal').classList.add('open');
  };
  reader.readAsDataURL(file);
  input.value = '';
}

// On page focus/visibility restore, check if there's a pending photo and re-open modal
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    try {
      const pending = sessionStorage.getItem('pendingPhotoDataUrl');
      if (pending && !photoBase64) {
        photoBase64 = pending.split(',')[1];
        document.getElementById('photoPreview').src = pending;
        document.getElementById('photoPreviewWrap').style.display = 'block';
        document.getElementById('photoPlaceholder').style.display = 'none';
        document.getElementById('analyzeBtn').disabled = false;
        document.getElementById('analyzeBtn').style.opacity = '1';
        document.getElementById('photoModal').classList.add('open');
      }
    } catch(e) {}
  }
});

function resetPhoto() {
  photoBase64 = null;
  aiProduct = null;
  aiServings = 1;
  try { sessionStorage.removeItem('pendingPhotoDataUrl'); } catch(e) {}
  document.getElementById('photoPreviewWrap').style.display = 'none';
  document.getElementById('photoPlaceholder').style.display = 'block';
  document.getElementById('analyzeBtn').disabled = true;
  document.getElementById('analyzeBtn').style.opacity = '0.4';
  document.getElementById('photoHint').value = '';
  document.getElementById('photoStep1').style.display = 'block';
  document.getElementById('photoStep2').style.display = 'none';
  document.getElementById('photoStep3').style.display = 'none';
}

const AI_LOADING_MSGS = [
  'Identifying ingredients and estimating portions…',
  'Checking protein content…',
  'Estimating carbohydrates…',
  'Calculating calories…',
  'Finalising macro breakdown…',
];

async function analyzePhoto() {
  analyzePhotoWithDB();
}

function renderAIResult() {
  const p = aiProduct;
  document.getElementById('photoStep2').style.display = 'none';
  document.getElementById('photoStep3').style.display = 'block';

  const confColor = { high: '#22c55e', medium: '#f59e0b', low: '#ef4444' }[p.confidence] || '#d97706';
  const confLabel = { high: '✅ High confidence', medium: '⚠️ Medium confidence', low: '⚠️ Low confidence — add a hint for better accuracy' }[p.confidence] || '';

  document.getElementById('aiMealName').textContent = p.name;
  document.getElementById('aiMealDesc').innerHTML =
    `<span style="color:${confColor};font-weight:700;font-size:11px">${confLabel}</span><br>${esc(p.description)}`;
  document.getElementById('aiSrvVal').textContent = aiServings;
  renderAIMacroChips();
}

function renderAIMacroChips() {
  const p = aiProduct;
  const s = aiServings;
  document.getElementById('aiMealMacros').innerHTML = [
    { label: 'Calories', val: Math.round(p.calories * s),                    unit: 'kcal', color: '#f59e0b' },
    { label: 'Protein',  val: Math.round(p.protein  * s * 10) / 10,          unit: 'g',    color: '#22c55e' },
    { label: 'Carbs',    val: Math.round(p.carbs    * s * 10) / 10,          unit: 'g',    color: '#3b82f6' },
    { label: 'Fat',      val: Math.round(p.fat      * s * 10) / 10,          unit: 'g',    color: '#ef4444' },
  ].map(m => `
    <div class="food-macro-chip">
      <div class="food-macro-chip-val" style="color:${m.color}">${m.val}</div>
      <div class="food-macro-chip-lbl">${m.label}</div>
      <div style="font-size:9px;color:var(--text3)">${m.unit}</div>
    </div>`).join('');
}

function adjustAIServings(delta) {
  aiServings = Math.max(0.25, Math.round((aiServings + delta) * 100) / 100);
  document.getElementById('aiSrvVal').textContent = aiServings % 1 === 0 ? aiServings : aiServings.toFixed(2).replace(/\.?0+$/, '');
  renderAIMacroChips();
}

function logAIFood() {
  if (!aiProduct) return;
  const p = aiProduct;
  const s = aiServings;
  addFoodEntry({
    name:     p.name,
    calories: Math.round(p.calories * s),
    protein:  Math.round(p.protein  * s * 10) / 10,
    carbs:    Math.round(p.carbs    * s * 10) / 10,
    fat:      Math.round(p.fat      * s * 10) / 10,
    icon: '🤖',
  });
  if (aiSelectedSlot) {
    saveFoodToSlot({ name: p.name, calories: Math.round(p.calories*s), protein: Math.round(p.protein*s*10)/10, carbs: Math.round(p.carbs*s*10)/10, fat: Math.round(p.fat*s*10)/10 }, aiSelectedSlot);
  }
  closePhotoModal();
  renderQuickRecs();
  showToast(`✅ ${p.name} logged!`);
}

// ═══════════════════════════════════════════════════════════════════════
// TRAINING LOAD (Tier 1, item 3) — CTL/ATL/TSB card on the Workout tab.
// Server computes from TrainingPeaks TSS; this renders and caches 30 min.
// ═══════════════════════════════════════════════════════════════════════
async function renderTrainingLoad() {
  if (!FLAGS.trainingLoad) return;
  const card = document.getElementById('trainingLoadCard');
  if (!card) return;
  if (!getStorage('tpConnected', null)) { card.style.display = 'none'; return; }

  const cache = getStorage('trainingLoadCache', null);
  let rows = (cache && Date.now() - cache.fetched < 30 * 60 * 1000) ? cache.rows : null;
  if (!rows) {
    try {
      const res = await fetch('/api/training/load?days=90', { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || ('API ' + res.status));
      rows = data.rows || [];
      setStorage('trainingLoadCache', { rows, fetched: Date.now() });
    } catch (e) {
      console.warn('[training-load]', e.message);
      card.style.display = 'none';
      return;
    }
  }
  if (!rows.length) { card.style.display = 'none'; return; }

  const last = rows[rows.length - 1];
  card.style.display = 'block';
  document.getElementById('tlCtl').textContent = Math.round(last.ctl);
  document.getElementById('tlAtl').textContent = Math.round(last.atl);
  const tsbEl = document.getElementById('tlTsb');
  const tsb = Math.round(last.tsb);
  const tsbColor = tsb > 5 ? '#22c55e' : tsb >= -10 ? 'var(--text)' : tsb >= -20 ? '#f59e0b' : '#ef4444';
  tsbEl.textContent = (tsb > 0 ? '+' : '') + tsb;
  tsbEl.style.color = tsbColor;

  const interp = tsb > 5 ? '🟢 Fresh — good day for quality'
    : tsb >= -10 ? '⚪ Building — hold the plan'
    : tsb >= -20 ? '🟠 Fatigued — consider an easy day'
    : '🔴 Very fatigued — back off';
  const interpEl = document.getElementById('tlInterpretation');
  interpEl.textContent = interp;
  interpEl.style.color = tsbColor;

  // Sparkline: CTL (solid) + ATL (faint) over the last 42 days
  const win = rows.slice(-42);
  const W = 300, H = 44;
  const vals = win.flatMap(r => [r.ctl, r.atl]);
  const max = Math.max(...vals, 1), min = Math.min(...vals, 0);
  const pt = (v, i) => `${(i / Math.max(win.length - 1, 1) * W).toFixed(1)},${(H - 4 - (v - min) / (max - min || 1) * (H - 8)).toFixed(1)}`;
  document.getElementById('tlSparkline').innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px">
      <polyline points="${win.map((r, i) => pt(r.atl, i)).join(' ')}" fill="none" stroke="#a78bfa" stroke-width="1.5" opacity="0.45"/>
      <polyline points="${win.map((r, i) => pt(r.ctl, i)).join(' ')}" fill="none" stroke="#3b82f6" stroke-width="2"/>
    </svg>`;
}

// ═══════════════════════════════════════════════════════════════════════
// PLANNED-WORKOUT FUELING (Tier 1, item 4) — if tomorrow's TP plan is a
// long/hard session, bump tonight's carb + calorie targets from 4pm.
// ═══════════════════════════════════════════════════════════════════════
function tomorrowKey() {
  const d = new Date(todayKey() + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function fetchTPPlanned() {
  if (!FLAGS.fueling || !getStorage('tpConnected', null)) return;
  try {
    const res = await fetch('/api/tp/planned?date=' + tomorrowKey(), { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok || !data.ok) return;
    const planned = data.planned || [];
    const dur = planned.reduce((s, p) => s + (p.duration_min || 0), 0);
    const tss = planned.reduce((s, p) => s + (p.tss_planned || 0), 0);
    const race = planned.some(p => p.type === 'Race');
    const main = planned.slice().sort((a, b) => (b.duration_min || 0) - (a.duration_min || 0))[0];
    const desc = main ? (main.distance_mi ? `${main.distance_mi}mi ${main.type.toLowerCase()}` : `${Math.round(main.duration_min || 0)}min ${main.type.toLowerCase()}`) : '';

    let bump = null;
    if (race) bump = { extraCarbs: 100, extraCals: 400, label: `Race day tomorrow (${desc}) → +100g carbs tonight` };
    else if (dur >= 75 || tss >= 90) bump = { extraCarbs: 60, extraCals: 240, label: `Tomorrow: ${desc} → +60g carbs tonight` };
    // 1.5F: hard day planned but readiness is shot → surface both options
    const rdf = getStorage('readinessToday', null);
    if (bump && FLAGS.readinessActions && rdf?.date === todayKey() && rdf.band === 'compromised') {
      bump.label = `Readiness ${rdf.score} (compromised) — consider moving tomorrow's ${desc}; if keeping it, ` + bump.label.replace(/^Tomorrow: |^Race day tomorrow \(/, '').replace(') → ', ' → ');
    }

    setStorage('fuelingBump', bump ? { date: todayKey(), ...bump } : null);
    renderFuelingBanner();
    scheduleRender(renderRings);
    updateMacroTargetsRow();
  } catch (e) { console.warn('[fueling]', e.message); }
}

// Active bump (or null): right day, not dismissed, evening window 4pm–midnight
function getFuelingBump() {
  if (!FLAGS.fueling) return null;
  const b = getStorage('fuelingBump', null);
  if (!b || b.date !== todayKey()) return null;
  if (getStorage('fuelingDismiss_' + todayKey(), false)) return null;
  if (nowEST().getHours() < 16) return null;
  return b;
}

function applyFuelingBump(m) {
  const b = getFuelingBump();
  if (!b || !m) return m;
  return { ...m, calories: m.calories + b.extraCals, carbs: m.carbs + b.extraCarbs, _fueling: true };
}

function renderFuelingBanner() {
  const banner = document.getElementById('fuelingBanner');
  if (!banner) return;
  const b = getFuelingBump();
  if (!b) { banner.style.display = 'none'; return; }
  document.getElementById('fuelingBannerText').textContent = b.label + ' (tap to dismiss)';
  banner.style.display = 'flex';
}

function dismissFuelingBanner() {
  setStorage('fuelingDismiss_' + todayKey(), true);
  renderFuelingBanner();
  scheduleRender(renderRings);
  updateMacroTargetsRow();
  showToast('Fueling suggestion dismissed for today');
}

// ═══════════════════════════════════════════════════════════════════════
// INSIGHTS / TRENDS (Tier 1, item 5) — five correlation charts rendered as
// inline SVG from one /api/trends payload, plus a cached weekly AI summary.
// ═══════════════════════════════════════════════════════════════════════

// Tiny SVG helpers — cheaper than a chart dependency
function _insLine(pts, color, w = 2, dash = '') {
  if (pts.length < 2) return '';
  return `<polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}
function _insMovAvg(vals, n) {
  return vals.map((_, i) => {
    const s = vals.slice(Math.max(0, i - n + 1), i + 1);
    return s.reduce((a, b) => a + b, 0) / s.length;
  });
}
function _insFit(pts) { // least-squares [slope, intercept]
  const n = pts.length;
  if (n < 2) return [0, pts[0]?.[1] || 0];
  const sx = pts.reduce((s, p) => s + p[0], 0), sy = pts.reduce((s, p) => s + p[1], 0);
  const sxx = pts.reduce((s, p) => s + p[0] * p[0], 0), sxy = pts.reduce((s, p) => s + p[0] * p[1], 0);
  const den = n * sxx - sx * sx;
  if (!den) return [0, sy / n];
  const m = (n * sxy - sx * sy) / den;
  return [m, (sy - m * sx) / n];
}
function _insEmpty(msg) {
  return `<div style="padding:24px 0;text-align:center;color:var(--text3);font-size:12px">${msg}</div>`;
}

async function renderInsights() {
  if (!FLAGS.trends) return;
  const section = document.getElementById('insightsSection');
  if (!section) return;
  section.style.display = 'block';

  let data = null;
  const cache = getStorage('trendsCache', null);
  if (cache && Date.now() - cache.fetched < 10 * 60 * 1000) data = cache.data;
  if (!data) {
    try {
      const res = await fetch('/api/trends?days=180', { headers: authHeaders() });
      data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || ('API ' + res.status));
      setStorage('trendsCache', { data, fetched: Date.now() });
    } catch (e) {
      document.getElementById('insWeight').innerHTML = _insEmpty('Could not load trends — ' + esc(e.message));
      return;
    }
  }

  _insRenderWeight(data);
  _insRenderDeficit(data);
  _insRenderSleep(data);
  _insRenderLoad(data);
  _insRenderProtein(data);
  if (FLAGS.bodyComp) safeCall(_insRenderBodyComp, '_insRenderBodyComp');
  else { const bc = document.getElementById('bodyCompCard'); if (bc) bc.style.display = 'none'; }

  // Weekly AI summary (server-cached per ISO week)
  try {
    const res = await fetch('/api/trends/summary', { headers: authHeaders() });
    const s = await res.json();
    if (s.ok && s.summary) {
      document.getElementById('insightsSummaryCard').style.display = 'block';
      document.getElementById('insightsSummary').textContent = s.summary;
    }
  } catch (_) {}
}

function _insRenderWeight(data) {
  const el = document.getElementById('insWeight'), note = document.getElementById('insWeightNote');
  const w = data.weights || [];
  if (w.length < 3) { el.innerHTML = _insEmpty('Log a few weigh-ins to see your trend'); note.textContent = ''; return; }
  const W = 320, H = 140, P = 8;
  const t0 = new Date(w[0].date).getTime(), t1 = new Date(w[w.length - 1].date).getTime();
  const lbs = w.map(x => x.lbs);
  const ma7 = _insMovAvg(lbs, 7), ma28 = _insMovAvg(lbs, 28);
  const gw = data.profile?.goal_weight;
  const lo = Math.min(...lbs, gw || Infinity) - 1, hi = Math.max(...lbs) + 1;
  const X = d => P + (new Date(d).getTime() - t0) / Math.max(t1 - t0, 1) * (W - 2 * P);
  const Y = v => H - P - (v - lo) / (hi - lo || 1) * (H - 2 * P);

  // Dashed plan line: from first weigh-in toward goal weight at goal date
  let target = '';
  if (gw && data.profile.goal_date) {
    const gt = new Date(data.profile.goal_date).getTime();
    const endV = lbs[0] + (gw - lbs[0]) * Math.min(1, (t1 - t0) / Math.max(gt - t0, 1));
    target = _insLine([[X(w[0].date), Y(lbs[0])], [X(w[w.length - 1].date), Y(endV)]], '#64748b', 1.5, '4,4');
  }
  const dots = w.map(x => `<circle cx="${X(x.date).toFixed(1)}" cy="${Y(x.lbs).toFixed(1)}" r="2" fill="#f59e0b" opacity="0.55"/>`).join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
    ${target}${dots}
    ${_insLine(w.map((x, i) => [X(x.date), Y(ma7[i])]), '#22c55e', 2)}
    ${_insLine(w.map((x, i) => [X(x.date), Y(ma28[i])]), '#3b82f6', 1.5)}
  </svg>`;

  // Rate of change: fit over the last 28 days vs what the plan needs
  const cut = t1 - 28 * 86400000;
  const recent = w.filter(x => new Date(x.date).getTime() >= cut).map(x => [(new Date(x.date).getTime() - cut) / 86400000, x.lbs]);
  const [slope] = _insFit(recent);
  const perWeek = slope * 7;
  let planned = null;
  if (gw && data.profile.goal_date) {
    const daysLeft = (new Date(data.profile.goal_date) - Date.now()) / 86400000;
    if (daysLeft > 0) planned = (gw - lbs[lbs.length - 1]) / daysLeft * 7;
  }
  note.textContent = `Last 4 weeks: ${perWeek > 0 ? '+' : ''}${perWeek.toFixed(2)} lbs/week` +
    (planned !== null ? ` · plan needs ${planned.toFixed(2)} lbs/week to hit ${gw} lbs by ${data.profile.goal_date}` : '') +
    ' · 🟢 7-day avg · 🔵 28-day avg · ▫ plan';
}

function _insWeekKey(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
  return d.toISOString().slice(0, 10);
}

function _insRenderDeficit(data) {
  const el = document.getElementById('insDeficit');
  const tdee = data.profile?.tdee || TDEE;
  // Daily calories: food_log totals as the base, check-in rows override
  const calByDate = {};
  for (const f of data.food || []) if (f.calories > 0) calByDate[f.date] = f.calories;
  for (const c of data.checkins || []) if (c.calories_consumed > 0) calByDate[c.date] = c.calories_consumed;
  const wByDate = {};
  for (const w of data.weights || []) wByDate[w.date] = w.lbs;
  const byWeek = {};
  for (const [date, cals] of Object.entries(calByDate)) {
    const wk = _insWeekKey(date);
    (byWeek[wk] = byWeek[wk] || { cals: [], weights: [] }).cals.push(cals);
    if (wByDate[date] > 0) byWeek[wk].weights.push(wByDate[date]);
  }
  const weeks = Object.keys(byWeek).sort().slice(-10);
  if (weeks.length < 2) { el.innerHTML = _insEmpty('Need a couple of weeks of logged food'); return; }
  const rows = weeks.map(wk => {
    const b = byWeek[wk];
    return { wk, deficit: tdee - b.cals.reduce((a, x) => a + x, 0) / b.cals.length,
             wavg: b.weights.length ? b.weights.reduce((a, x) => a + x, 0) / b.weights.length : null };
  });
  const W = 320, H = 130, P = 8, bw = (W - 2 * P) / rows.length;
  const maxD = Math.max(...rows.map(r => Math.abs(r.deficit)), 300);
  const zero = H / 2;
  const bars = rows.map((r, i) => {
    const h = Math.abs(r.deficit) / maxD * (H / 2 - P);
    const y = r.deficit >= 0 ? zero - h : zero;
    const dw = (r.wavg !== null && i > 0 && rows[i - 1].wavg !== null) ? r.wavg - rows[i - 1].wavg : null;
    return `<rect x="${(P + i * bw + 2).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" rx="2" fill="${r.deficit >= 0 ? '#22c55e' : '#ef4444'}" opacity="0.8"/>` +
      `<text x="${(P + i * bw + bw / 2).toFixed(1)}" y="${(r.deficit >= 0 ? zero + 12 : zero - 5).toFixed(1)}" text-anchor="middle" font-size="8" fill="#94a3b8">${Math.round(r.deficit)}</text>` +
      (dw !== null ? `<text x="${(P + i * bw + bw / 2).toFixed(1)}" y="${H - 2}" text-anchor="middle" font-size="8" fill="${dw <= 0 ? '#22c55e' : '#f59e0b'}">${dw > 0 ? '+' : ''}${dw.toFixed(1)}</text>` : '');
  }).join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto"><line x1="${P}" y1="${zero}" x2="${W - P}" y2="${zero}" stroke="#334155" stroke-width="1"/>${bars}</svg>`;
}

function _insRenderSleep(data) {
  const el = document.getElementById('insSleep'), note = document.getElementById('insSleepNote');
  const byDate = {};
  for (const c of data.checkins || []) byDate[c.date] = c;
  const pairs = [];
  for (const c of data.checkins || []) {
    if (!(c.sleep_hrs > 0)) continue;
    const next = new Date(c.date + 'T12:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
    const n = byDate[next.toISOString().slice(0, 10)];
    if (n && (n.energy > 0 || n.mood > 0)) pairs.push({ sleep: c.sleep_hrs, energy: n.energy || null, mood: n.mood || null });
  }
  if (pairs.length < 8) { el.innerHTML = _insEmpty('Need more sleep + mood/energy check-ins to correlate'); note.textContent = ''; return; }

  const panel = (key, color, label, ox) => {
    const pts = pairs.filter(p => p[key] > 0).map(p => [p.sleep, p[key]]);
    if (pts.length < 5) return '';
    const W2 = 150, H2 = 110, P2 = 14;
    const xs = pts.map(p => p[0]);
    const xlo = Math.min(...xs) - 0.3, xhi = Math.max(...xs) + 0.3;
    const X = v => ox + P2 + (v - xlo) / (xhi - xlo || 1) * (W2 - 2 * P2);
    const Y = v => H2 - P2 - (v - 1) / 4 * (H2 - 2 * P2);
    const [m, b] = _insFit(pts);
    return pts.map(p => `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="2.5" fill="${color}" opacity="0.5"/>`).join('') +
      _insLine([[X(xlo), Y(m * xlo + b)], [X(xhi), Y(m * xhi + b)]], color, 1.5) +
      `<text x="${ox + W2 / 2}" y="10" text-anchor="middle" font-size="9" font-weight="700" fill="${color}">${label}</text>`;
  };
  el.innerHTML = `<svg viewBox="0 0 320 115" style="width:100%;height:auto">${panel('energy', '#f59e0b', 'ENERGY', 0)}${panel('mood', '#a78bfa', 'MOOD', 165)}</svg>`;

  // Personal threshold: the split point with the biggest next-day energy gap
  let best = null;
  for (let s = 5.5; s <= 8.5; s += 0.5) {
    const below = pairs.filter(p => p.energy > 0 && p.sleep < s).map(p => p.energy);
    const above = pairs.filter(p => p.energy > 0 && p.sleep >= s).map(p => p.energy);
    if (below.length >= 4 && above.length >= 4) {
      const gap = above.reduce((a, v) => a + v, 0) / above.length - below.reduce((a, v) => a + v, 0) / below.length;
      if (!best || gap > best.gap) best = { s, gap };
    }
  }
  note.textContent = best && best.gap > 0.3
    ? `Your energy drops noticeably when sleep falls below ~${best.s} h (${best.gap.toFixed(1)} points lower next day)`
    : 'No strong sleep threshold detected yet — keep logging';
}

function _insRenderLoad(data) {
  const el = document.getElementById('insLoad');
  const load = data.load || [];
  if (load.length < 7) { el.innerHTML = _insEmpty('Connect TrainingPeaks and train — load appears here'); return; }
  const byWeek = {};
  for (const r of load) {
    const wk = _insWeekKey(r.date);
    (byWeek[wk] = byWeek[wk] || { tss: 0, ctl: 0 }).tss += r.tss;
    byWeek[wk].ctl = r.ctl; // last value in the week
  }
  const weeks = Object.keys(byWeek).sort().slice(-12);
  const W = 320, H = 130, P = 8, bw = (W - 2 * P) / weeks.length;
  const maxT = Math.max(...weeks.map(w => byWeek[w].tss), 100);
  const maxC = Math.max(...weeks.map(w => byWeek[w].ctl), 10);
  const bars = weeks.map((w, i) =>
    `<rect x="${(P + i * bw + 2).toFixed(1)}" y="${(H - P - byWeek[w].tss / maxT * (H - 2 * P)).toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${Math.max(byWeek[w].tss / maxT * (H - 2 * P), 1).toFixed(1)}" rx="2" fill="#3b82f6" opacity="0.55"/>`).join('');
  const ctlPts = weeks.map((w, i) => [P + i * bw + bw / 2, H - P - byWeek[w].ctl / maxC * (H - 2 * P)]);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">${bars}${_insLine(ctlPts, '#f59e0b', 2)}</svg>`;
}

// ── Body composition (Tier 1.5D): fat mass vs lean mass from wellness ────
async function _insRenderBodyComp() {
  const card = document.getElementById('bodyCompCard');
  if (!card) return;
  let rows;
  const cache = getStorage('bodyCompCache', null);
  if (cache && Date.now() - cache.fetched < 10 * 60 * 1000) rows = cache.rows;
  if (!rows) {
    try {
      const res = await fetch('/api/wellness?days=90', { headers: authHeaders() });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || 'wellness fetch failed');
      rows = (d.rows || []).slice().reverse(); // ASC
      setStorage('bodyCompCache', { rows, fetched: Date.now() });
    } catch (e) {
      document.getElementById('bcChart1').innerHTML = _insEmpty('Could not load body comp — ' + esc(e.message));
      return;
    }
  }
  const days = rows.filter(r => r.weight_lbs != null).map(r => {
    const fat = r.body_fat_pct != null ? r.weight_lbs * r.body_fat_pct / 100 : null;
    const lean = fat != null ? r.weight_lbs - fat : (r.muscle_mass_lbs ?? null);
    return { date: r.date, w: r.weight_lbs, fat, lean };
  });
  if (days.length < 3) {
    document.getElementById('bcChart1').innerHTML = _insEmpty('Need a few smart-scale readings for body comp');
    document.getElementById('bcChart2').innerHTML = ''; document.getElementById('bcCallout').textContent = '';
    return;
  }

  // Chart 1: weight (gray) + fat (red) + lean (green), 7d MAs; dashed gaps where comp missing
  const W = 320, H = 150, P = 8;
  const t0 = new Date(days[0].date).getTime(), t1 = new Date(days[days.length - 1].date).getTime();
  const X = d => P + (new Date(d).getTime() - t0) / Math.max(t1 - t0, 1) * (W - 2 * P);
  const allVals = days.flatMap(x => [x.w, x.fat, x.lean]).filter(v => v != null);
  const lo = Math.min(...allVals) - 2, hi = Math.max(...allVals) + 2;
  const Y = v => H - P - (v - lo) / (hi - lo || 1) * (H - 2 * P);
  const maOf = key => {
    const out = [];
    for (let i = 0; i < days.length; i++) {
      const win = days.slice(Math.max(0, i - 6), i + 1).map(x => x[key]).filter(v => v != null);
      out.push(win.length ? win.reduce((s, v) => s + v, 0) / win.length : null);
    }
    return out;
  };
  const seg = (key, ma, color, w) => {
    // contiguous runs solid; bridge gaps dashed
    let svg = '', run = [];
    let lastIdx = null;
    for (let i = 0; i < days.length; i++) {
      if (days[i][key] == null) continue;
      const pt = [X(days[i].date), Y(ma[i])];
      if (lastIdx != null && i - lastIdx > 1) {
        svg += _insLine([run[run.length - 1], pt], color, w, '3,4');
        svg += _insLine(run, color, w);
        run = [pt];
      } else run.push(pt);
      lastIdx = i;
    }
    if (run.length > 1) svg += _insLine(run, color, w);
    return svg;
  };
  document.getElementById('bcChart1').innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
    ${seg('w', maOf('w'), '#64748b', 1.2)}${seg('fat', maOf('fat'), '#ef4444', 2)}${seg('lean', maOf('lean'), '#22c55e', 2)}
  </svg>`;

  // Chart 2: weekly change in fat vs lean
  const byWeek = {};
  for (const x of days) {
    if (x.fat == null || x.lean == null) continue;
    const wk = _insWeekKey(x.date);
    (byWeek[wk] = byWeek[wk] || { fat: [], lean: [] }).fat.push(x.fat);
    byWeek[wk].lean.push(x.lean);
  }
  const weeks = Object.keys(byWeek).sort().slice(-9);
  const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
  const deltas = [];
  for (let i = 1; i < weeks.length; i++) {
    deltas.push({ wk: weeks[i], dFat: avg(byWeek[weeks[i]].fat) - avg(byWeek[weeks[i - 1]].fat), dLean: avg(byWeek[weeks[i]].lean) - avg(byWeek[weeks[i - 1]].lean) });
  }
  if (deltas.length) {
    const W2 = 320, H2 = 110, P2 = 8, bw = (W2 - 2 * P2) / deltas.length, zero = H2 / 2;
    const maxD = Math.max(...deltas.flatMap(x => [Math.abs(x.dFat), Math.abs(x.dLean)]), 0.5);
    const bars = deltas.map((x, i) => {
      const bx = P2 + i * bw;
      const fh = Math.abs(x.dFat) / maxD * (H2 / 2 - P2), lh = Math.abs(x.dLean) / maxD * (H2 / 2 - P2);
      return `<rect x="${(bx + 2).toFixed(1)}" y="${(x.dFat >= 0 ? zero - fh : zero).toFixed(1)}" width="${(bw / 2 - 3).toFixed(1)}" height="${Math.max(fh, 1).toFixed(1)}" rx="2" fill="#ef4444" opacity="0.85"/>` +
             `<rect x="${(bx + bw / 2 + 1).toFixed(1)}" y="${(x.dLean >= 0 ? zero - lh : zero).toFixed(1)}" width="${(bw / 2 - 3).toFixed(1)}" height="${Math.max(lh, 1).toFixed(1)}" rx="2" fill="#22c55e" opacity="0.85"/>`;
    }).join('');
    document.getElementById('bcChart2').innerHTML = `<svg viewBox="0 0 ${W2} ${H2}" style="width:100%;height:auto"><line x1="${P2}" y1="${zero}" x2="${W2 - P2}" y2="${zero}" stroke="#334155"/>${bars}</svg>`;
  } else document.getElementById('bcChart2').innerHTML = '';

  // Callout: 28-day rates + sustained lean-loss warning
  const cut = t1 - 28 * 86400000;
  const recent = days.filter(x => new Date(x.date).getTime() >= cut && x.fat != null);
  const callout = document.getElementById('bcCallout');
  if (recent.length >= 6) {
    const rate = key => {
      const pts = recent.map(x => [(new Date(x.date).getTime() - cut) / 86400000, x[key]]);
      return _insFit(pts)[0] * 7;
    };
    const fatRate = rate('fat'), leanRate = rate('lean');
    let html = `28-day rates: <b style="color:#ef4444">fat ${fatRate > 0 ? '+' : ''}${fatRate.toFixed(2)} lb/wk</b> · <b style="color:#22c55e">lean ${leanRate > 0 ? '+' : ''}${leanRate.toFixed(2)} lb/wk</b>`;
    if (leanRate < -0.15) html += `<div style="color:#f59e0b;margin-top:4px">⚠️ Losing lean mass — consider more protein or a smaller deficit.</div>`;
    callout.innerHTML = html;
  } else callout.textContent = '';
}

function _insRenderProtein(data) {
  const el = document.getElementById('insProtein');
  const target = data.profile?.protein || MACROS.protein;
  const byDate = {};
  for (const f of data.food || []) if (f.protein > 0) byDate[f.date] = f.protein;
  for (const c of data.checkins || []) if (c.protein_g > 0) byDate[c.date] = c.protein_g;
  const cell = 20, gap = 3, weeks = 13;
  const today = new Date(todayKey() + 'T12:00:00Z');
  const start = new Date(today); start.setUTCDate(start.getUTCDate() - (weeks * 7 - 1) - ((today.getUTCDay() + 6) % 7));
  let cells = '';
  for (let i = 0; ; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    if (d > today) break;
    const key = d.toISOString().slice(0, 10);
    const col = Math.floor(i / 7), row = i % 7;
    const g = byDate[key];
    const pct = g ? g / target : null;
    const fill = pct === null ? '#1e293b' : pct >= 0.9 ? '#22c55e' : pct >= 0.7 ? '#f59e0b' : '#ef4444';
    cells += `<rect x="${col * (cell + gap)}" y="${row * (cell + gap)}" width="${cell}" height="${cell}" rx="4" fill="${fill}" opacity="${pct === null ? 0.45 : 0.9}"><title>${key}: ${g ? Math.round(g) + 'g (' + Math.round(pct * 100) + '%)' : 'no log'}</title></rect>`;
  }
  const W = weeks * (cell + gap), H = 7 * (cell + gap);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">${cells}</svg>`;
}

// ═══════════════════════════════════════════════════════════════════════
// VOICE FOOD LOG (Tier 1, item 2) — mic → transcript → Claude parse →
// editable multi-item confirm sheet → addFoodEntry per item.
// ═══════════════════════════════════════════════════════════════════════
let _voiceRec = null;
let _quickLogItems = [];

function _resetVoiceBtn() {
  const btn = document.getElementById('voiceLogBtn');
  if (btn) btn.innerHTML = '<span style="font-size:16px">🎤</span> Voice';
}

function startVoiceLog() {
  if (!FLAGS.voiceLog) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showToast('⚠️ Voice input not supported in this browser — try Photo or Search'); return; }
  if (_voiceRec) { try { _voiceRec.stop(); } catch(_) {} _voiceRec = null; _resetVoiceBtn(); return; }
  try {
    const rec = new SR();
    _voiceRec = rec;
    rec.lang = 'en-US';
    rec.continuous = false;       // iOS Safari: single utterance
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    const btn = document.getElementById('voiceLogBtn');
    if (btn) btn.innerHTML = '<span style="font-size:16px">🔴</span> Listening…';
    rec.onresult = ev => {
      const transcript = ev.results?.[0]?.[0]?.transcript || '';
      if (transcript.trim()) parseVoiceFood(transcript.trim());
      else showToast('⚠️ Didn\'t catch that — try again');
    };
    rec.onerror = ev => {
      showToast(ev.error === 'not-allowed' ? '⚠️ Mic permission denied — enable in browser settings' : '⚠️ Mic error: ' + ev.error);
    };
    rec.onend = () => { _voiceRec = null; _resetVoiceBtn(); };
    rec.start();
  } catch (e) {
    _voiceRec = null; _resetVoiceBtn();
    showToast('⚠️ Could not start mic: ' + e.message);
  }
}

async function parseVoiceFood(transcript) {
  const modal = document.getElementById('quickLogModal');
  document.getElementById('quickLogTranscript').textContent = '“' + transcript + '”';
  document.getElementById('quickLogLoading').style.display = 'block';
  document.getElementById('quickLogList').innerHTML = '';
  document.getElementById('quickLogActions').style.display = 'none';
  document.getElementById('quickLogCancelOnly').style.display = 'block';
  modal.classList.add('open');

  const prompt = `You are a registered dietitian. Convert this spoken meal description into structured food entries.

Description: "${transcript}"

Rules:
- Split into distinct food items
- Use USDA FoodData Central reference values
- If the speaker gave explicit quantities ("three eggs", "two slices"), quality is "full"; if portions are implied, "partial"; if you guessed, "estimated"
- Round calories to whole numbers, macros to 0.1g

Return ONLY valid JSON, no markdown:
{"entries":[{"name":"food name","grams":120,"calories":210,"protein_g":18,"carbs_g":1,"fat_g":15,"quality":"full"}]}`;

  try {
    const resp = await callClaudeAPI({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
    const parsed = JSON.parse(clean.slice(s, e + 1));
    const entries = (parsed.entries || []).map(x => ({
      name:     String(x.name || 'Food').slice(0, 80),
      calories: Math.max(0, Math.round(x.calories || 0)),
      protein:  Math.max(0, Math.round((x.protein_g ?? x.protein ?? 0) * 10) / 10),
      carbs:    Math.max(0, Math.round((x.carbs_g ?? x.carbs ?? 0) * 10) / 10),
      fat:      Math.max(0, Math.round((x.fat_g ?? x.fat ?? 0) * 10) / 10),
      quality:  ['full', 'partial', 'estimated'].includes(x.quality) ? x.quality : 'estimated',
    }));
    if (!entries.length) throw new Error('no items recognized');
    _quickLogItems = entries;
    renderQuickLogSheet();
  } catch (err) {
    document.getElementById('quickLogLoading').style.display = 'none';
    document.getElementById('quickLogList').innerHTML =
      `<div style="color:var(--red);font-size:13px;padding:14px;text-align:center">Couldn't parse that — ${esc(err.message)}.<br>Try again or use manual entry.</div>`;
  }
}

function renderQuickLogSheet() {
  document.getElementById('quickLogLoading').style.display = 'none';
  const list = document.getElementById('quickLogList');
  const qBadge = q => q === 'full' ? '<span style="color:#22c55e">● exact</span>'
    : q === 'partial' ? '<span style="color:#f59e0b">● partial</span>'
    : '<span style="color:#a78bfa">● estimated</span>';
  list.innerHTML = _quickLogItems.map((it, i) => `
    <div class="quicklog-item" data-idx="${i}" style="background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:10px;margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <input type="text" value="${esc(it.name)}" oninput="_quickLogItems[${i}].name=this.value" style="flex:1;font-size:13px;font-weight:600" />
        <span style="font-size:10px;white-space:nowrap">${qBadge(it.quality)}</span>
        <button onclick="removeQuickLogItem(${i})" style="background:none;border:none;color:var(--red);font-size:16px;cursor:pointer;padding:2px 6px">✕</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px">
        ${[['calories','kcal','#f59e0b'],['protein','P g','#22c55e'],['carbs','C g','#3b82f6'],['fat','F g','#ef4444']].map(([k,l,c]) => `
          <div style="text-align:center">
            <input type="number" inputmode="decimal" value="${it[k]}" oninput="_quickLogItems[${i}].${k}=parseFloat(this.value)||0"
              style="width:100%;text-align:center;font-size:13px;font-weight:700;color:${c};padding:6px 2px" />
            <div style="font-size:9px;color:var(--text3);font-weight:600;margin-top:2px">${l}</div>
          </div>`).join('')}
      </div>
    </div>`).join('');
  const actions = document.getElementById('quickLogActions');
  actions.style.display = _quickLogItems.length ? 'block' : 'none';
  document.getElementById('quickLogCancelOnly').style.display = _quickLogItems.length ? 'none' : 'block';
  document.getElementById('quickLogConfirmBtn').textContent =
    `✅ Log ${_quickLogItems.length} item${_quickLogItems.length === 1 ? '' : 's'}`;
}

function removeQuickLogItem(i) {
  _quickLogItems.splice(i, 1);
  if (_quickLogItems.length) renderQuickLogSheet();
  else closeQuickLogModal();
}

function confirmQuickLog() {
  const items = _quickLogItems.slice();
  closeQuickLogModal();
  for (const it of items) {
    addFoodEntry({ name: it.name, calories: it.calories, protein: it.protein, carbs: it.carbs, fat: it.fat, icon: '🎤' });
  }
}

function closeQuickLogModal() {
  document.getElementById('quickLogModal').classList.remove('open');
  _quickLogItems = [];
  _quickLogPinKey = null;
  const pinBtn = document.getElementById('quickLogPinBtn');
  if (pinBtn) pinBtn.style.display = 'none';
}

// ── Settings ──
function openSettings() {
  document.getElementById('settingsModal').classList.add('open');
  const goals = getStorage('userGoals', {});
  if (goals.weight) document.getElementById('settingWeight').value     = goals.weight;
  if (goals.goal)   document.getElementById('settingGoalWeight').value = goals.goal;
  if (goals.goalDate) {
    document.getElementById('settingGoalDate').value = goals.goalDate;
    updateGoalDateHint();
  }
  // Populate macro fields
  const savedMacros = getStorage('userMacros', null) || MACROS;
  document.getElementById('settingCalories').value = savedMacros.calories;
  document.getElementById('settingProtein').value  = savedMacros.protein;
  document.getElementById('settingCarbs').value    = savedMacros.carbs;
  document.getElementById('settingFat').value      = savedMacros.fat;
  // Populate TDEE
  const savedTDEE = getStorage('userTDEE', null) || TDEE;
  document.getElementById('settingTDEE').value = savedTDEE;
  // Reset auto-calc result
  const res = document.getElementById('tdeeCalcResult');
  if (res) { res.style.display = 'none'; res.innerHTML = ''; }
  updateTPSettingsUI();
  updateSyncStatusUI();
  updateBackupStatusUI();
  updatePushSettingsUI();
  checkTPLifecycle();
}
function closeSettings() {
  document.getElementById('settingsModal').classList.remove('open');
}
async function saveGoalSettings() {
  const w        = parseInt(document.getElementById('settingWeight').value)     || 165;
  const g        = parseInt(document.getElementById('settingGoalWeight').value) || 163;
  const goalDate = document.getElementById('settingGoalDate').value || '';
  const cal = parseInt(document.getElementById('settingCalories').value)   || MACROS.calories;
  const pro = parseInt(document.getElementById('settingProtein').value)    || MACROS.protein;
  const crb = parseInt(document.getElementById('settingCarbs').value)      || MACROS.carbs;
  const fat = parseInt(document.getElementById('settingFat').value)        || MACROS.fat;
  const tdee = parseInt(document.getElementById('settingTDEE').value)      || TDEE;

  setStorage('userGoals', { weight: w, goal: g, goalDate });
  setStorage('userMacros', { calories: cal, protein: pro, carbs: crb, fat: fat });
  setStorage('userTDEE',   tdee);
  localStorage.removeItem('adaptiveMacros');
  localStorage.removeItem('garminAdjustedMacros');

  // Persist to D1 so a page refresh doesn't clobber these with the old server row.
  // The /api/user/profile endpoint expects a full profile body, so preserve the
  // onboarding-only fields (gender/age/height/activity_level) from _currentUser.
  const u = _currentUser || {};
  const body = {
    gender:         u.gender || null,
    age:            u.age || null,
    height_inches:  u.height_inches || null,
    current_weight: w,
    goal_weight:    g,
    goal_date:      goalDate || null,
    activity_level: u.activity_level || null,
    tdee, calories: cal, protein: pro, carbs: crb, fat
  };
  try {
    const res = await fetch('/api/user/profile', {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
    _currentUser = data.user;
  } catch (e) {
    showToast('⚠️ Saved locally but not synced: ' + e.message);
    return;
  }

  renderRings();
  renderProteinPace();
  renderWeeklyBalance();
  updateMacroTargetsRow();
  updateHeaderDate();
  renderEventCountdowns();
  showToast('✅ Goals & macros saved!');
}

function updateMacroTargetsRow() {
  // Single source of truth: garminAdjusted > adaptive > userMacros > MACROS defaults
  const garminAdj  = getStorage('garminAdjustedMacros', null);
  const adaptive   = getStorage('adaptiveMacros', null);
  const userMacros = getStorage('userMacros', null);
  const m = applyReadinessBump(applyFuelingBump(garminAdj || adaptive || userMacros || MACROS));

  const tdee   = getStorage('userTDEE', null) || TDEE;
  const goals  = getStorage('userGoals', {});
  const cw     = goals.weight || 165;
  const gw     = goals.goal   || 163;
  const deficit = tdee - m.calories;

  // Update tile values
  const el = id => document.getElementById(id);
  if (el('tileCalories'))    el('tileCalories').textContent    = m.calories.toLocaleString() + ' kcal';
  if (el('tileProtein'))     el('tileProtein').textContent     = m.protein + 'g';
  if (el('tileCarbs'))       el('tileCarbs').textContent       = m.carbs + 'g';
  if (el('tileFat'))         el('tileFat').textContent         = m.fat + 'g';

  // Dynamic notes
  if (el('tileCaloriesNote')) {
    if (garminAdj)      el('tileCaloriesNote').textContent = '🟠 Adjusted for run';
    else if (adaptive)  el('tileCaloriesNote').textContent = '🧠 Adaptive target';
    else if (deficit > 0) el('tileCaloriesNote').textContent = '~' + deficit.toLocaleString() + ' kcal deficit';
    else                el('tileCaloriesNote').textContent = 'Maintenance';
  }
  if (el('tileCarbsNote')) {
    el('tileCarbsNote').textContent = garminAdj ? 'Run fuel added' : 'Base target';
  }

  // Tip box
  if (el('macroTipBox')) {
    const src2 = garminAdj ? '🟠 Run day — extra fuel added' : adaptive ? '🧠 Adaptive macros active' : '🎯 Base cut targets';
    let tipTime = '';
    if (goals.goalDate) {
      const dl = Math.max(0, Math.round((new Date(goals.goalDate + 'T12:00:00') - new Date(todayKey() + 'T12:00:00')) / 86400000));
      tipTime = dl > 0 ? ' · ' + dl + ' days to goal' : ' · Goal date reached!';
    } else if (deficit > 0) {
      tipTime = ' · ~' + (Math.round(((cw-gw)*3500)/(deficit*7)*10)/10) + ' wks at this deficit';
    }
        el('macroTipBox').innerHTML = '💡 <span style="color:#4ade80">' + src2 + '.</span> Goal: ' + cw + ' → ' + gw + ' lbs' + tipTime + '. TrainingPeaks auto-adds carbs &amp; cals on run days.'
  }
}

function updateGoalDateHint() {
  const hint    = document.getElementById('goalDateHint');
  if (!hint) return;
  const dateVal = document.getElementById('settingGoalDate').value;
  const cw      = parseFloat(document.getElementById('settingWeight').value)     || 165;
  const gw      = parseFloat(document.getElementById('settingGoalWeight').value) || 163;
  if (!dateVal) { hint.textContent = ''; return; }
  const today   = new Date();
  const target  = new Date(dateVal + 'T00:00:00');
  const days    = Math.round((target - today) / 86400000);
  if (days <= 0) { hint.innerHTML = '<span style="color:#f87171">⚠️ Date must be in the future</span>'; return; }
  const lbs     = Math.max(0, cw - gw);
  const weeks   = days / 7;
  const lbsWk   = weeks > 0 ? (lbs / weeks).toFixed(2) : '?';
  const deficitDay = weeks > 0 ? Math.round((lbs * 3500) / days) : 0;
  let color = '#4ade80';
  let warning = '';
  if (parseFloat(lbsWk) > 2)      { color = '#f87171'; warning = ' ⚠️ Very aggressive'; }
  else if (parseFloat(lbsWk) > 1.5) { color = '#f59e0b'; warning = ' — moderate pace'; }
  else                             { warning = ' — healthy pace'; }
  hint.innerHTML = `<span style="color:${color}"><strong>${lbsWk} lbs/week</strong>${warning}</span><br>~${deficitDay} kcal/day deficit needed · ${days} days to go`;
}

function autoCalcTDEE() {
  const resultEl = document.getElementById('tdeeCalcResult');
  resultEl.style.display = 'block';

  // ── Pull all the inputs we need ──
  const goals        = getStorage('userGoals', {});
  const weightLog    = getWeightEntries();           // [{date, weight}] sorted asc
  const macroLog     = getStorage('macroLog', {});
  const baseTDEE     = getStorage('userTDEE', null) || TDEE;

  // Current weight: most recent weigh-in, fallback to settings field
  const latestEntry  = weightLog.length ? weightLog[weightLog.length - 1] : null;
  const currentWeight = latestEntry
    ? latestEntry.weight
    : parseFloat(document.getElementById('settingWeight')?.value) || goals.weight || 165;

  const goalWeight   = parseFloat(document.getElementById('settingGoalWeight')?.value) || goals.goal || 163;
  const goalDateStr  = document.getElementById('settingGoalDate')?.value || goals.goalDate || '';

  if (!goalDateStr) {
    resultEl.innerHTML = '⚠️ Set a <strong>Goal Date</strong> above first — needed to calculate your required daily deficit.';
    return;
  }

  const today      = new Date(todayKey() + 'T12:00:00');
  const goalDate   = new Date(goalDateStr + 'T12:00:00');
  const daysLeft   = Math.round((goalDate - today) / 86400000);

  if (daysLeft <= 0) {
    resultEl.innerHTML = '⚠️ Goal date is in the past. Update it to a future date.';
    return;
  }

  const lbsToLose  = Math.max(0, currentWeight - goalWeight);
  const totalDeficit = lbsToLose * 3500;             // kcal needed
  const dailyDeficit = Math.round(totalDeficit / daysLeft);
  const recommendedCals = Math.round(baseTDEE - dailyDeficit);

  // ── Layer 2: refine using actual logged data if we have enough ──
  let refinedSection = '';
  const recentWeights = weightLog.filter(e => {
    const d = new Date(e.date + 'T12:00:00');
    return (today - d) / 86400000 <= 14;
  });

  if (recentWeights.length >= 3) {
    const first = recentWeights[0];
    const last  = recentWeights[recentWeights.length - 1];
    const span  = Math.round((new Date(last.date + 'T12:00:00') - new Date(first.date + 'T12:00:00')) / 86400000);

    if (span >= 5) {
      const keys = Object.keys(macroLog).filter(k => k >= first.date && k <= last.date && macroLog[k].calories > 0);
      if (keys.length >= 4) {
        const avgEaten = keys.reduce((s, k) => s + macroLog[k].calories, 0) / keys.length;
        const actualLoss = first.weight - last.weight;

        // Max realistic fat loss: 0.25 lb/day (1.75/wk) — anything beyond is water weight
        const maxRealisticLoss = 0.25 * span;
        const clampedLoss = Math.min(Math.max(actualLoss, 0), maxRealisticLoss);
        const impliedDeficit = (clampedLoss * 3500) / span;
        const inferredTDEE = Math.round(avgEaten + impliedDeficit);

        // Only trust inferred TDEE if it's within 20% of our baseline — wilder swings = water weight
        const tdeeRatio = inferredTDEE / baseTDEE;
        const tdeeReliable = tdeeRatio >= 0.8 && tdeeRatio <= 1.2;

        if (tdeeReliable) {
          const refinedDailyDeficit = Math.round((lbsToLose * 3500) / daysLeft);
          const refinedCals = Math.max(1200, inferredTDEE - refinedDailyDeficit);
          // Only update fields if refined is better (closer to goal pace)
          document.getElementById('settingTDEE').value = inferredTDEE;
          document.getElementById('settingCalories').value = refinedCals;
          refinedSection = `
            <div style="margin-top:10px;padding:10px;background:var(--surface);border-radius:10px;border:1px solid #4ade8044">
              <div style="font-size:10px;font-weight:800;color:#4ade80;margin-bottom:4px">🧠 REFINED FROM YOUR ACTUAL LOGS</div>
              <div style="font-size:11px;color:var(--text2)">
                Based on ${span} days (${keys.length} food logs + ${recentWeights.length} weigh-ins)<br>
                Avg eaten: <strong>${Math.round(avgEaten)} kcal</strong> · Fat loss est: <strong>${clampedLoss.toFixed(1)} lbs</strong><br>
                Inferred TDEE: <strong>${inferredTDEE.toLocaleString()} kcal</strong><br>
                <span style="color:#4ade80;font-weight:700">Refined target: ${refinedCals.toLocaleString()} kcal/day</span>
              </div>
            </div>`;
        } else {
          // Show note but don't override — too much water weight noise
          refinedSection = `
            <div style="margin-top:10px;padding:10px;background:var(--surface);border-radius:10px;border:1px solid #f59e0b44">
              <div style="font-size:10px;font-weight:800;color:#f59e0b;margin-bottom:4px">⚠️ LOG DATA NOISY</div>
              <div style="font-size:11px;color:var(--text3)">
                Inferred TDEE (${inferredTDEE.toLocaleString()} kcal) is too far from your baseline (${baseTDEE.toLocaleString()} kcal) —
                likely water weight from starting your cut. Using forward-looking plan instead.
                Check back in ${Math.max(0, 14 - span)} more days for a reliable estimate.
              </div>
            </div>`;
        }
      }
    }
  }

  // If no valid refinement, use forward-looking calculation
  if (!refinedSection) {
    document.getElementById('settingTDEE').value = baseTDEE;
    document.getElementById('settingCalories').value = Math.max(1200, recommendedCals);
  }

  const lbsPerWeek = ((lbsToLose * 7) / daysLeft).toFixed(2);
  const paceColor  = parseFloat(lbsPerWeek) > 1.5 ? '#f87171' : parseFloat(lbsPerWeek) > 1.0 ? '#f59e0b' : '#4ade80';

  resultEl.innerHTML = `
    <div style="font-size:11px;color:var(--text2);line-height:1.8">
      <strong style="color:var(--text)">📊 Goal Plan</strong><br>
      Current: <strong>${currentWeight} lbs</strong> · Goal: <strong>${goalWeight} lbs</strong> · Need to lose: <strong>${lbsToLose.toFixed(1)} lbs</strong><br>
      Days remaining: <strong>${daysLeft}</strong> · Pace: <span style="color:${paceColor};font-weight:700">${lbsPerWeek} lbs/week</span><br>
      Required daily deficit: <strong>${dailyDeficit.toLocaleString()} kcal</strong><br>
      Base TDEE: <strong>${baseTDEE.toLocaleString()} kcal</strong> → <strong style="color:#f59e0b">Calorie target: ${Math.max(1200, recommendedCals).toLocaleString()} kcal/day</strong>
      ${refinedSection}
      <div style="margin-top:8px;font-size:10px;color:var(--text3)">Calorie target updated above. Hit <strong>Save</strong> to apply.</div>
    </div>`;
}

function renderGarminCard(calories, distance, duration, count) {
  const km    = (distance / 1000).toFixed(1);
  const miles = (distance / 1609.34).toFixed(1);
  const mins  = Math.round(duration / 60);
  const hrs   = mins >= 60 ? `${Math.floor(mins/60)}h ${mins%60}m` : `${mins}m`;
  const srcLabel = 'TrainingPeaks';
  const srcEmoji = '⛰️';

  document.getElementById('garminActivityTitle').textContent = count > 0 ? `${count} run${count>1?'s':''} today` : 'No runs today';
  document.getElementById('garminActivitySub').textContent   = count > 0
    ? `${srcEmoji} Synced from ${srcLabel}`
    : `${srcEmoji} ${srcLabel} · Rest day — standard macros apply`;

  document.getElementById('garminStatsRow').innerHTML = [
    { val: calories > 0 ? calories.toLocaleString() : '—', lbl: 'Calories', color: '#f59e0b' },
    { val: parseFloat(miles) > 0 ? miles + ' mi'    : '—', lbl: 'Distance', color: '#3b82f6' },
    { val: mins > 0 ? hrs                            : '—', lbl: 'Duration', color: '#22c55e' },
  ].map(s => `<div class="garmin-stat">
    <div class="garmin-stat-val" style="color:${s.color}">${s.val}</div>
    <div class="garmin-stat-lbl">${s.lbl}</div>
  </div>`).join('');

  // Show shoe row if there's a run and at least one active shoe
  const shoeRow = document.getElementById('todayShoeRow');
  if (shoeRow) {
    const hasRun    = parseFloat(miles) > 0;
    const hasShoes  = getShoes().filter(s => s.status === 'active').length > 0;
    if (hasRun && hasShoes) {
      shoeRow.style.display = 'flex';
      const todayRun  = getShoeRuns().find(r => r.date === todayKey());
      const labelEl   = document.getElementById('todayShoeLabel');
      const assignBtn = document.getElementById('todayShoeAssignBtn');
      if (todayRun) {
        const shoe = getShoes().find(s => s.id === todayRun.shoeId);
        labelEl.textContent = `👟 ${shoe?.name || 'Shoes'} · ${todayRun.miles.toFixed(2)} mi logged`;
        if (assignBtn) assignBtn.style.display = 'none';
      } else {
        labelEl.textContent = `👟 Which shoes did you wear? (${miles} mi)`;
        if (assignBtn) assignBtn.style.display = '';
      }
    } else {
      shoeRow.style.display = 'none';
    }
  }
}

function openTodayShoeAssign() {
  const cached = getStorage('tpToday', null);
  if (!cached || !cached.distance) { showToast('⚠️ No run data — sync TrainingPeaks first'); return; }
  promptShoeAssignment({
    date:       todayKey(),
    miles:      cached.distance / 1609.34,
    duration:   cached.duration || 0,
    calories:   cached.calories || 0,
    activityId: cached.activityId || null,
  });
}

function adjustMacrosForBurn(burnCalories) {
  const banner = document.getElementById('garminMacroBanner');
  const text   = document.getElementById('garminMacroText');

  // Persist burn calories keyed by date so it survives page reload
  const burnLog = getStorage('burnLog', {});
  const todayK  = todayKey();
  if (burnCalories > 0) {
    burnLog[todayK] = burnCalories;
    setStorage('burnLog', burnLog);
  }

  if (burnCalories <= 0) {
    banner.style.display = 'none';
    setStorage('garminAdjustedMacros', null);
    renderRings();
    return;
  }

  // Add ~60% of burn back as extra calories (don't eat back 100% — still want a deficit)
  const extraCals  = Math.round(burnCalories * 0.6);
  const extraCarbs = Math.round(extraCals * 0.65 / 4); // 65% from carbs

  const base = getStorage('adaptiveMacros', null) || getStorage('userMacros', null) || MACROS;
  const adjusted = {
    calories: base.calories + extraCals,
    carbs:    base.carbs    + extraCarbs,
    protein:  base.protein,
    fat:      base.fat,
  };

  setStorage('garminAdjustedMacros', adjusted);

  banner.style.display = 'flex';
  text.textContent = `🟠 Run detected! +${extraCals} kcal → ${adjusted.calories} kcal target, ${adjusted.carbs}g carbs`;

  // Update rings, targets row, and weekly balance
  renderRings(adjusted);
  updateMacroTargetsRow();
  renderWeeklyBalance();
}

// ── TrainingPeaks (cookie auth, proxied through the worker) ──

async function connectTrainingPeaks() {
  const input = document.getElementById('tpCookieInput');
  const cookie = (input.value || '').trim();
  if (!cookie) { showToast('⚠️ Paste your Production_tpAuth cookie value first'); return; }
  showToast('Connecting to TrainingPeaks…');
  try {
    const res = await fetch('/api/tp/auth', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ cookie })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) { showToast('⚠️ ' + (data.error || 'TrainingPeaks connection failed')); return; }
    input.value = '';
    setStorage('tpConnected', { athlete: data.athlete, connectedAt: Date.now() });
    setStorage('tpLifecycle', { status: 'active', last_refreshed_at: Date.now(), checked: Date.now() });
    renderTPBanners();
    updateTPSettingsUI();
    showToast('✅ Connected as ' + (data.athlete?.name || 'athlete'));
    fetchTPToday();
  } catch (e) {
    showToast('⚠️ TrainingPeaks error: ' + e.message);
  }
}

async function fetchTPToday() {
  if (!getStorage('tpConnected', null)) return;

  document.getElementById('garminCard').style.display = 'block';
  document.getElementById('garminActivitySub').textContent = 'Syncing from TrainingPeaks…';

  try {
    const res = await fetch('/api/tp/today?date=' + todayKey(), { headers: authHeaders() });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      if (data.error === 'cookie_expired') {
        document.getElementById('garminActivitySub').textContent = '⚠️ TrainingPeaks session expired — reconnect in Settings';
        setStorage('tpLifecycle', { status: 'expired', checked: Date.now() });
        renderTPBanners();
        return;
      }
      if (data.error === 'not_connected') {
        document.getElementById('garminActivitySub').textContent = '⚠️ TrainingPeaks not connected — see Settings';
        setStorage('tpConnected', null);
        updateTPSettingsUI();
        return;
      }
      throw new Error(data.error || ('API ' + res.status));
    }

    renderGarminCard(data.calories, data.distance, data.duration, data.count);
    // Device-reported workout calories are gross expenditure (include BMR during
    // the run). Our TDEE already covers BMR for the full day, so we only add the
    // NET incremental burn: ~75% of gross is the standard correction.
    const netBurn = Math.round((data.calories || 0) * 0.75);
    if (getStorage('tpAutoAdjust', true)) adjustMacrosForBurn(netBurn);
    setStorage('tpToday', { calories: data.calories, distance: data.distance, duration: data.duration, fetched: Date.now() });
    renderShoeStravaCard();
    // Items 3+4: server recomputes load in the background; refresh planned fueling now
    setStorage('trainingLoadCache', null);
    safeCall(fetchTPPlanned, 'fetchTPPlanned');

    // Prompt shoe assignment after run syncs
    if (data.count > 0 && data.distance > 0) {
      onStravaRunSynced({
        date:       todayKey(),
        miles:      data.distance / 1609.34,
        duration:   data.duration,
        calories:   data.calories,
        activityId: data.workouts && data.workouts[0] ? String(data.workouts[0].id) : null,
      });
    }
  } catch (err) {
    document.getElementById('garminActivitySub').textContent = '⚠️ TrainingPeaks sync failed — ' + err.message;
  }
}

function updateTPSettingsUI() {
  const conn = getStorage('tpConnected', null);
  const statusEl = document.getElementById('tpConnectStatus');
  const setupEl  = document.getElementById('tpSetupSteps');
  const panelEl  = document.getElementById('tpConnectedPanel');

  if (conn) {
    statusEl.className   = 'connect-status connected';
    statusEl.textContent = '🟢 Connected';
    setupEl.style.display  = 'none';
    panelEl.style.display  = 'block';
    // Show the activity card immediately — data fills in after async fetch
    document.getElementById('garminCard').style.display = 'block';
    document.getElementById('tpUsername').textContent = conn.athlete?.name || 'Athlete';
  } else {
    statusEl.className   = 'connect-status disconnected';
    statusEl.textContent = '⚪ Not connected';
    setupEl.style.display  = 'block';
    panelEl.style.display  = 'none';
  }
}

function toggleTPAutoAdjust(btn) {
  btn.classList.toggle('on');
  setStorage('tpAutoAdjust', btn.classList.contains('on'));
}

async function disconnectTrainingPeaks() {
  if (!confirm('Disconnect TrainingPeaks?')) return;
  try { await fetch('/api/tp/disconnect', { method: 'POST', headers: authHeaders() }); } catch(_) {}
  localStorage.removeItem('tpConnected');
  localStorage.removeItem('tpToday');
  updateTPSettingsUI();
  document.getElementById('garminCard').style.display = 'none';
  renderRings();
  showToast('TrainingPeaks disconnected');
}

// ── Weight Tracking & Trend ──
// Goal constants are now read dynamically from userGoals storage

function openWeightModal() {
  const log = getStorage('weightLog', {});
  const today = log[todayKey()];
  document.getElementById('weightInput').value = today || '';
  document.getElementById('weightModal').classList.add('open');
}

function saveWeight() {
  const val = parseFloat(document.getElementById('weightInput').value);
  if (!val || val < 50 || val > 500) { showToast('⚠️ Enter a valid weight'); return; }
  const log = getStorage('weightLog', {});
  log[todayKey()] = val;
  setStorage('weightLog', log);
  logInteraction('weight_logged', val);
  document.getElementById('weightModal').classList.remove('open');
  renderWeightTrend();
  checkAdaptiveMacros();
  showToast(`⚖️ ${val} lbs logged!`);
}

function getWeightTrend() {
  const log = getStorage('weightLog', {});
  const entries = Object.entries(log)
    .map(([date, weight]) => ({ date, weight }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30); // last 30 days
  return entries;
}

// Normalize weightLog (always stored as {date: number}) into sorted [{date, weight}] array
function getWeightEntries() {
  const log = getStorage('weightLog', {});
  return Object.entries(log)
    .map(([date, weight]) => ({ date, weight: parseFloat(weight) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Get most recent logged weight as a number, or null
function getLatestWeight() {
  const entries = getWeightEntries();
  return entries.length ? entries[entries.length - 1].weight : null;
}


function smoothedWeight(entries) {
  // 3-day rolling average
  return entries.map((e, i) => {
    const slice = entries.slice(Math.max(0, i-2), i+1);
    const avg = slice.reduce((s, x) => s + x.weight, 0) / slice.length;
    return { ...e, smoothed: Math.round(avg * 10) / 10 };
  });
}

function renderWeightTrend() {
  const entries = getWeightTrend();
  const card  = document.getElementById('weightTrendCard');
  const svg   = document.getElementById('weightSparkline');
  const badges = document.getElementById('weightBadges');
  const statBlock = document.getElementById('weightStatBlock');

  if (entries.length === 0) {
    svg.innerHTML = '<text x="150" y="34" text-anchor="middle" font-size="11" fill="#4d5468" font-family="Plus Jakarta Sans, sans-serif">Log your weight to see your trend</text>';
    badges.innerHTML = '';
    statBlock.style.display = 'none';
    return;
  }

  // Latest weight
  const latest = entries[entries.length - 1];
  document.getElementById('weightTrendVal').textContent = latest.weight;
  document.getElementById('weightTrendSubtitle').textContent = `${entries.length} day${entries.length>1?'s':''} tracked · Goal: ${GOAL_WEIGHT} lbs`;
  statBlock.style.display = 'block';

  // Sparkline
  const smoothed = smoothedWeight(entries);
  const weights  = smoothed.map(e => e.smoothed);
  const minW = Math.min(...weights) - 1;
  const maxW = Math.max(...weights) + 1;
  const W = 300, H = 60;
  const toX = (i) => entries.length === 1 ? W/2 : (i / (entries.length - 1)) * W;
  const toY = (w) => H - ((w - minW) / (maxW - minW)) * (H - 8) - 4;

  const points = smoothed.map((e, i) => `${toX(i).toFixed(1)},${toY(e.smoothed).toFixed(1)}`).join(' ');
  const firstPt = `${toX(0).toFixed(1)},${toY(smoothed[0].smoothed).toFixed(1)}`;
  const lastPt  = `${toX(smoothed.length-1).toFixed(1)},${toY(smoothed[smoothed.length-1].smoothed).toFixed(1)}`;

  // Goal line
  const goalY = toY(GOAL_WEIGHT);

  svg.innerHTML = `
    <defs>
      <linearGradient id="wGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#22c55e" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="#22c55e" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${goalY >= 0 && goalY <= H ? `<line x1="0" y1="${goalY.toFixed(1)}" x2="${W}" y2="${goalY.toFixed(1)}" stroke="#3b82f6" stroke-width="1" stroke-dasharray="4,3" opacity="0.5"/>
    <text x="${W-2}" y="${(goalY-3).toFixed(1)}" text-anchor="end" font-size="9" fill="#3b82f6" font-family="Plus Jakarta Sans,sans-serif" opacity="0.8">Goal</text>` : ''}
    <polyline points="${points}" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${lastPt.split(',')[0]}" cy="${lastPt.split(',')[1]}" r="3.5" fill="#22c55e"/>
  `;

  // Progress badges
  const totalLost  = START_WEIGHT - latest.weight;
  const remaining  = latest.weight - GOAL_WEIGHT;
  const daysIn     = entries.length;
  const expectedLost = (daysIn / GOAL_DAYS) * (START_WEIGHT - GOAL_WEIGHT);
  const diff       = totalLost - expectedLost;

  let statusClass = 'neutral', statusText = 'Keep logging';
  if (entries.length >= 5) {
    if (diff >= -0.3 && diff <= 0.5)   { statusClass = 'on-track'; statusText = '✅ On track'; }
    else if (diff < -0.3)              { statusClass = 'too-slow'; statusText = '⚠️ Behind pace'; }
    else if (diff > 0.5)               { statusClass = 'too-fast'; statusText = '⚡ Ahead of pace'; }
  }

  badges.innerHTML = [
    remaining > 0 ? `<span class="weight-badge neutral">📉 ${remaining.toFixed(1)} lbs to go</span>` : `<span class="weight-badge on-track">🎉 Goal reached!</span>`,
    totalLost > 0 ? `<span class="weight-badge on-track">−${totalLost.toFixed(1)} lbs lost</span>` : '',
    entries.length >= 3 ? `<span class="weight-badge ${statusClass}">${statusText}</span>` : '',
  ].filter(Boolean).join('');
}

// ── Adaptive Macro Adjustment ──
function checkAdaptiveMacros() {
  const entries = getWeightTrend();
  if (entries.length < 7) return; // Need at least a week of data

  // Get last 7 days average
  const last7 = entries.slice(-7);
  const avgWeight = last7.reduce((s, e) => s + e.weight, 0) / last7.length;

  // Get previous 7 days avg (if available)
  if (entries.length < 14) return;
  const prev7 = entries.slice(-14, -7);
  const prevAvg = prev7.reduce((s, e) => s + e.weight, 0) / prev7.length;

  const weeklyChange = avgWeight - prevAvg; // negative = losing
  const targetChange = -GOAL_WEEKLY_LB;     // we want ~-1.63 lbs/wk

  const diff = weeklyChange - targetChange; // positive = losing too slow, negative = too fast

  let newCalories = (getStorage('userMacros', null) || MACROS).calories;
  let msg = '';
  const baseMacros = getStorage('userMacros', null) || MACROS;

  if (Math.abs(diff) < 0.3) {
    msg = `✅ Perfect pace — losing ${Math.abs(weeklyChange).toFixed(1)} lbs/wk. Macros unchanged.`;
  } else if (diff > 0.3) {
    // Losing too slowly — cut more
    const cut = Math.round(diff * 500);
    newCalories = Math.max(1400, baseMacros.calories - cut);
    msg = `⚠️ Losing ${Math.abs(weeklyChange).toFixed(1)} lbs/wk — below target. Reducing calories by ${baseMacros.calories - newCalories} to ${newCalories} kcal.`;
  } else {
    // Losing too fast — add back
    const add = Math.round(Math.abs(diff) * 500);
    newCalories = Math.min(2400, baseMacros.calories + add);
    msg = `⚡ Losing ${Math.abs(weeklyChange).toFixed(1)} lbs/wk — ahead of target. Adding ${newCalories - baseMacros.calories} calories to ${newCalories} kcal to protect muscle.`;
  }

  // Update adaptive targets
  const adjustedProtein = baseMacros.protein; // always keep protein high
  const adjustedCarbs   = Math.round((newCalories - adjustedProtein * 4 - baseMacros.fat * 9) / 4);
  const adaptive = { calories: newCalories, protein: adjustedProtein, carbs: Math.max(50, adjustedCarbs), fat: baseMacros.fat };
  setStorage('adaptiveMacros', adaptive);

  const banner = document.getElementById('adaptiveMacroBanner');
  const text   = document.getElementById('adaptiveMacroText');
  banner.style.display = 'flex';
  text.textContent = msg;

  renderRings();
}

// renderRings — checks adaptive macros, TrainingPeaks adjustments, and ringMode
function renderRings(overrideMacros) {
  const adaptive   = getStorage('adaptiveMacros', null);
  const garminAdj  = getStorage('garminAdjustedMacros', null);
  const userMacros = getStorage('userMacros', null);
  const targets    = applyReadinessBump(applyFuelingBump(overrideMacros || garminAdj || adaptive || userMacros || MACROS));
  const macroLog  = getStorage('macroLog', {});
  const dayData   = macroLog[getSelectedDateKey()] || { calories:0, protein:0, carbs:0, fat:0 };
  document.getElementById('ringsRow').innerHTML =
    makeSVGRing(dayData.calories, targets.calories, '#f59e0b', 'Calories', 'kcal', ringMode) +
    makeSVGRing(dayData.protein,  targets.protein,  '#22c55e', 'Protein',  'g',    ringMode) +
    makeSVGRing(dayData.carbs,    targets.carbs,    '#3b82f6', 'Carbs',    'g',    ringMode) +
    makeSVGRing(dayData.fat,      targets.fat,      '#ef4444', 'Fat',      'g',    ringMode);

  // Update the macro targets row
  const tCal  = document.getElementById('targetCalories');
  const tPro  = document.getElementById('targetProtein');
  const tCarb = document.getElementById('targetCarbs');
  const tFat  = document.getElementById('targetFat');
  const tSrc  = document.getElementById('targetSource');
  if (tCal) tCal.textContent  = targets.calories;
  if (tPro) tPro.textContent  = targets.protein + 'g';
  if (tCarb) tCarb.textContent = targets.carbs + 'g';
  if (tFat) tFat.textContent  = targets.fat + 'g';
  safeCall(renderWhoopDayBadge, "whoopDayBadge");
  if (tSrc) {
    if (garminAdj || overrideMacros) {
      tSrc.textContent = '⛰️ TrainingPeaks';
      tSrc.style.color = '#1064a3';
    } else if (adaptive) {
      tSrc.textContent = '🧠 Adaptive';
      tSrc.style.color = '#8b5cf6';
    } else {
      tSrc.textContent = 'Base';
      tSrc.style.color = 'var(--text3)';
    }
  }
}

// ── WHOOP Day Badge on Today Page ──
function renderWhoopDayBadge() {
  const el = document.getElementById('whoopDayBadge');
  if (!el) return;
  const dateKey = getSelectedDateKey();
  const w = getWhoopForDate(dateKey);
  if (!w || (w.recovery == null && w.hrv == null)) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  const c = wrecoveryColor(w.recovery || 0);
  const rec = w.recovery != null ? w.recovery + '%' : '--';
  const hrv = w.hrv != null ? w.hrv + 'ms' : '--';
  const rhr = w.rhr != null ? w.rhr + 'bpm' : '--';
  const strain = w.strain != null ? w.strain.toFixed(1) : '--';
  const sleep = w.sleepPerf != null ? w.sleepPerf + '%' : '--';
  const debt = w.sleepDebt != null ? (w.sleepDebt/60).toFixed(1)+'h debt' : '';
  el.innerHTML = `<div style="background:${c.bg};border:1.5px solid ${c.border};border-radius:12px;padding:10px 14px;display:flex;align-items:center;gap:12px;cursor:pointer" onclick="switchTab('history');switchHistoryTab('whoop')">
    <div style="text-align:center;flex-shrink:0">
      <div style="font-size:18px;font-weight:900;color:${c.text}">${rec}</div>
      <div style="font-size:9px;font-weight:700;color:${c.text};text-transform:uppercase">Recovery</div>
    </div>
    <div style="flex:1;display:flex;gap:12px;flex-wrap:wrap">
      <span style="font-size:11px;color:var(--text2)">💚 HRV <b style="color:#22c55e">${hrv}</b></span>
      <span style="font-size:11px;color:var(--text2)">❤️ RHR <b style="color:#ef4444">${rhr}</b></span>
      <span style="font-size:11px;color:var(--text2)">⚡ Strain <b style="color:#3b82f6">${strain}</b></span>
      <span style="font-size:11px;color:var(--text2)">😴 Sleep <b style="color:#f59e0b">${sleep}</b>${debt?' · '+debt:''}</span>
    </div>
    <div style="font-size:9px;color:${c.text};opacity:0.7">💍</div>
  </div>`;
}

// ── Copy Yesterday's Meals ──
function checkCopyYesterday() {
  const btn = document.getElementById('copyYesterdayBtn');
  if (!btn) return;
  if (FLAGS.quickAdd) {
    const src = findMealCopySource();
    if (src) {
      btn.style.display = 'flex';
      const when = src.back === 1 ? "yesterday's" : `${src.back} days ago:`;
      btn.textContent = `📋 Copy ${when} ${src.meal} (${src.entries.length})`;
      return;
    }
  }
  const all = getStorage('foodEntries', {});
  const yEntries = all[getYesterdayKey()] || [];
  btn.style.display = yEntries.length > 0 ? 'flex' : 'none';
  if (yEntries.length > 0) {
    btn.textContent = `📋 Copy Yesterday's ${yEntries.length} meal${yEntries.length>1?'s':''}`;
  }
}

function copyYesterdayMeals() {
  // Meal-aware source when quickAdd is on; whole-previous-day otherwise
  let yEntries;
  if (FLAGS.quickAdd) {
    const src = findMealCopySource();
    if (src) yEntries = src.entries;
  }
  if (!yEntries) {
    const all = getStorage('foodEntries', {});
    const selDate = new Date(getSelectedDateKey() + 'T12:00:00');
    selDate.setDate(selDate.getDate() - 1);
    yEntries = all[dateToKey(selDate)] || [];
  }
  if (yEntries.length === 0) { showToast('No meals logged the previous day'); return; }

  // Store for the modal
  window._copyYesterdayEntries = yEntries;

  // Build the list
  const listEl = document.getElementById('copyYesterdayList');
  if (!listEl) return;
  listEl.innerHTML = yEntries.map((e, i) => {
    const cals = Math.round(e.calories || 0);
    const prot = Math.round(e.protein || 0);
    return `<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface2);border:1.5px solid var(--border);border-radius:12px;margin-bottom:8px;cursor:pointer">
      <input type="checkbox" checked data-yi="${i}" class="copy-y-cb" style="width:18px;height:18px;accent-color:#7c3aed;flex-shrink:0">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${e.name || 'Unknown'}</div>
        <div style="font-size:11px;color:var(--text2);margin-top:2px">${cals} cal · ${prot}g protein${e.servings && e.servings !== 1 ? ' · ' + e.servings + ' servings' : ''}</div>
      </div>
    </label>`;
  }).join('');

  document.getElementById('copyYesterdayModal').classList.add('open');
}

function toggleAllYesterdayItems() {
  const cbs = document.querySelectorAll('#copyYesterdayList .copy-y-cb');
  const allChecked = [...cbs].every(cb => cb.checked);
  cbs.forEach(cb => cb.checked = !allChecked);
}

function copySelectedYesterdayMeals() {
  const cbs = document.querySelectorAll('#copyYesterdayList .copy-y-cb:checked');
  if (cbs.length === 0) { showToast('No meals selected'); return; }

  const entries = window._copyYesterdayEntries || [];
  const selected = [...cbs].map(cb => {
    const idx = parseInt(cb.dataset.yi);
    const { _id, _u, ...rest } = entries[idx];  // fresh sync identity for the copy
    return {
      ...rest,
      id:   Date.now() + Math.random(),
      time: nowEST().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', timeZone:'America/New_York' }),
    };
  });

  const todayEntries = getFoodEntries();
  setFoodEntries([...todayEntries, ...selected]);
  document.getElementById('copyYesterdayModal').classList.remove('open');
  renderRings();
  renderFoodLog();
  renderWeeklyBalance();
  showToast(`📋 Copied ${selected.length} meal${selected.length > 1 ? 's' : ''}!`);
}

// ── Daily Greeting Tile (Calendar + Gmail + Quote) ──

let _googleAccessToken = null;
let _googleTokenClient = null;
let _greetingDataLoading = false;

function getTimeGreeting() {
  const h = nowEST().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function initGreetingTile() {
  // Set greeting and date
  const hello = document.getElementById('greetingHello');
  const dateEl = document.getElementById('greetingDate');
  const name = (_currentUser && _currentUser.name) ? _currentUser.name.split(' ')[0] : 'Jeremy';
  if (hello) hello.textContent = `${getTimeGreeting()}, ${esc(name)}`;
  if (dateEl) dateEl.textContent = nowEST().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });

  // Load quote
  loadDailyQuote();

  // Coach note grounded in 14-day trends (item 6)
  safeCall(renderCoachNote, 'renderCoachNote');
  safeCall(initCoachLongPress, 'initCoachLongPress');

  // Try loading calendar + gmail with saved token
  const savedToken = localStorage.getItem('googleAccessToken');
  const savedExp = parseInt(localStorage.getItem('googleTokenExpiry') || '0');
  if (savedToken && Date.now() < savedExp) {
    _googleAccessToken = savedToken;
    loadGreetingCalendar();
    loadGreetingGmail();
  } else {
    // Init token client for Gmail + Calendar scopes
    initGoogleTokenClient();
  }
}

function initGoogleTokenClient() {
  if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
    setTimeout(initGoogleTokenClient, 300);
    return;
  }
  _googleTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly',
    callback: (tokenResponse) => {
      if (tokenResponse.error) {
        console.warn('[Greeting] Token error:', tokenResponse.error);
        renderGreetingNoAuth();
        return;
      }
      _googleAccessToken = tokenResponse.access_token;
      const expiresIn = (tokenResponse.expires_in || 3600) * 1000;
      localStorage.setItem('googleAccessToken', _googleAccessToken);
      localStorage.setItem('googleTokenExpiry', String(Date.now() + expiresIn));
      loadGreetingCalendar();
      loadGreetingGmail();
    },
    prompt: '',
  });

  // Auto-request token (silently if already consented)
  requestGreetingToken();
}

function requestGreetingToken() {
  if (!_googleTokenClient) return;
  try {
    _googleTokenClient.requestAccessToken({ prompt: '' });
  } catch (e) {
    console.warn('[Greeting] Silent token request failed:', e);
    renderGreetingNoAuth();
  }
}

function renderGreetingNoAuth() {
  const calList = document.getElementById('greetingCalList');
  const mailList = document.getElementById('greetingMailList');
  if (calList) calList.innerHTML = `<button class="greeting-connect-btn" onclick="connectGreetingGoogle()">🔗 Connect Google Calendar</button>`;
  if (mailList) mailList.innerHTML = `<button class="greeting-connect-btn" onclick="connectGreetingGoogle()">🔗 Connect Gmail</button>`;
}

function connectGreetingGoogle() {
  if (_googleTokenClient) {
    _googleTokenClient.requestAccessToken({ prompt: 'consent' });
  } else {
    initGoogleTokenClient();
  }
}

async function loadGreetingCalendar() {
  const calList = document.getElementById('greetingCalList');
  if (!calList || !_googleAccessToken) return;
  calList.innerHTML = '<div class="greeting-loading">Loading calendar…</div>';

  try {
    const now = nowEST();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const tomorrowEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2).toISOString();
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(todayStart)}&timeMax=${encodeURIComponent(tomorrowEnd)}&singleEvents=true&orderBy=startTime&maxResults=8`;

    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + _googleAccessToken } });
    if (res.status === 401) {
      localStorage.removeItem('googleAccessToken');
      _googleAccessToken = null;
      renderGreetingNoAuth();
      return;
    }
    const data = await res.json();
    const events = (data.items || []).filter(e => e.status !== 'cancelled');

    if (events.length === 0) {
      calList.innerHTML = '<div class="greeting-empty">No events scheduled</div>';
      return;
    }

    // Split into today and tomorrow
    const todayDate = dateToKey(now);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowDate = dateToKey(tomorrow);

    let html = '';
    let lastGroup = '';

    events.forEach(ev => {
      const evStart = ev.start.dateTime || ev.start.date;
      const evDate = evStart.slice(0, 10);
      const isAllDay = !ev.start.dateTime;

      // Group header
      let group = evDate === todayDate ? 'Today' : evDate === tomorrowDate ? 'Tomorrow' : '';
      if (group && group !== lastGroup) {
        if (lastGroup) html += '<div style="height:6px"></div>';
        if (group === 'Tomorrow') html += `<div style="font-size:9px;font-weight:700;color:#4d5468;text-transform:uppercase;letter-spacing:1px;margin:4px 0 2px">Tomorrow</div>`;
        lastGroup = group;
      }

      let timeStr = 'All day';
      if (!isAllDay) {
        const d = new Date(evStart);
        timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' });
      }

      const title = esc(ev.summary || '(No title)');
      const loc = ev.location ? `<div class="greeting-event-loc">📍 ${esc(ev.location.split(',')[0])}</div>` : '';

      html += `<div class="greeting-event greet-animate">
        <div class="greeting-event-time">${timeStr}</div>
        <div class="greeting-event-title">${title}${loc}</div>
      </div>`;
    });

    calList.innerHTML = html;
  } catch (e) {
    console.warn('[Greeting] Calendar fetch error:', e);
    calList.innerHTML = '<div class="greeting-empty">Could not load calendar</div>';
  }
}

async function loadGreetingGmail() {
  const mailList = document.getElementById('greetingMailList');
  if (!mailList || !_googleAccessToken) return;
  mailList.innerHTML = '<div class="greeting-loading">Checking emails with AI…</div>';

  try {
    // Fetch all unread primary emails for AI triage
    const q = encodeURIComponent('is:unread category:primary');
    const url = `https://www.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=50`;
    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + _googleAccessToken } });
    if (res.status === 401) {
      localStorage.removeItem('googleAccessToken');
      _googleAccessToken = null;
      renderGreetingNoAuth();
      return;
    }
    const data = await res.json();
    const messages = data.messages || [];

    if (messages.length === 0) {
      mailList.innerHTML = '<div class="greeting-empty">Inbox zero — no new emails to address</div>';
      return;
    }

    // Fetch details + snippet for each message (parallel)
    const details = await Promise.all(
      messages.map(async (m) => {
        try {
          const r = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {
            headers: { 'Authorization': 'Bearer ' + _googleAccessToken }
          });
          return await r.json();
        } catch { return null; }
      })
    );

    const emailSummaries = details.filter(Boolean).map(msg => {
      const headers = msg.payload?.headers || [];
      const fromH = headers.find(h => h.name === 'From')?.value || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
      const snippet = msg.snippet || '';
      let fromName = fromH;
      const nameMatch = fromH.match(/^"?([^"<]+)"?\s*</);
      if (nameMatch) fromName = nameMatch[1].trim();
      else if (fromH.includes('@')) fromName = fromH.split('@')[0];
      return { from: fromName, subject, snippet: snippet.slice(0, 120) };
    });

    // Check cache first
    const cacheKey = 'aiEmailTriage_' + todayKey();
    const cached = getStorage(cacheKey, null);
    const emailHash = JSON.stringify(emailSummaries.map(e => e.subject)).slice(0, 200);
    if (cached && cached.hash === emailHash && cached.results) {
      renderAIEmailResults(mailList, cached.results);
      return;
    }

    // Send to Claude AI for triage
    try {
      const prompt = `You are Jeremy's personal email triage assistant. Review these unread emails and determine which ones he actually needs to address today vs which can be ignored (newsletters, promos, automated notifications, social media alerts, etc.).

EMAILS:
${emailSummaries.map((e, i) => `${i+1}. From: ${e.from} | Subject: ${e.subject} | Preview: ${e.snippet}`).join('\n')}

Return ONLY valid JSON array (no markdown). Each item for emails that NEED ATTENTION:
[{"index":1,"priority":"urgent|action|fyi","reason":"5-8 word reason why this needs attention"}]

Rules:
- "urgent": needs response today (client emails, boss, deadlines, money)
- "action": needs action soon (meetings, requests, approvals)
- "fyi": worth reading but no reply needed (important updates, relevant news)
- SKIP: newsletters, marketing, social notifications, automated alerts, promotional emails, subscription confirmations
- Max 5 items. Only include emails that genuinely need human attention.
- Return empty array [] if nothing needs attention.`;

      const resp = await callClaudeAPI({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      });

      const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const clean = text.replace(/```json|```/g, '').trim();
      const start = clean.indexOf('['), end = clean.lastIndexOf(']');
      let triaged = [];
      if (start >= 0 && end > start) {
        triaged = JSON.parse(clean.slice(start, end + 1));
      }

      // Map AI results back to email data
      const results = triaged.map(t => {
        const email = emailSummaries[t.index - 1];
        if (!email) return null;
        return { from: email.from, subject: email.subject, priority: t.priority || 'fyi', reason: t.reason || '' };
      }).filter(Boolean);

      // Cache results
      setStorage(cacheKey, { hash: emailHash, results, ts: Date.now() });
      renderAIEmailResults(mailList, results);

    } catch (aiErr) {
      console.warn('[Greeting] AI triage failed, showing raw list:', aiErr);
      // Fallback: show first 5 emails without AI
      let html = '';
      emailSummaries.slice(0, 5).forEach(e => {
        html += `<div class="greeting-email greet-animate">
          <div class="greeting-email-row">
            <div class="greeting-email-from">${esc(e.from)}</div>
            <div class="greeting-email-subject">${esc(e.subject)}</div>
          </div>
        </div>`;
      });
      mailList.innerHTML = html || '<div class="greeting-empty">No new emails</div>';
    }

  } catch (e) {
    console.warn('[Greeting] Gmail fetch error:', e);
    mailList.innerHTML = '<div class="greeting-empty">Could not load emails</div>';
  }
}

function renderAIEmailResults(mailList, results) {
  if (!results || results.length === 0) {
    mailList.innerHTML = '<div class="greeting-empty" style="color:#22c55e">All clear — nothing needs your attention right now</div>';
    return;
  }

  const badgeMap = { urgent: 'URGENT', action: 'ACTION', fyi: 'FYI' };
  let html = '';
  results.forEach(r => {
    const badge = `<span class="greeting-email-badge ${r.priority}">${badgeMap[r.priority] || 'FYI'}</span>`;
    html += `<div class="greeting-email greet-animate">
      <div class="greeting-email-row">
        <div class="greeting-email-from">${esc(r.from)}</div>
        <div class="greeting-email-subject">${esc(r.subject)}</div>
      </div>
      <div class="greeting-email-reason">${badge}${esc(r.reason)}</div>
    </div>`;
  });
  mailList.innerHTML = html;
}

function refreshGreetingTile() {
  localStorage.removeItem('dailyQuote');
  localStorage.removeItem('greetingCache');
  initGreetingTile();
  showToast('Refreshing daily briefing…');
}

function toggleGreetingTile() {
  const tile = document.getElementById('greetingTile');
  if (!tile) return;
  const minimized = tile.classList.toggle('minimized');
  localStorage.setItem('greetingMinimized', minimized ? '1' : '0');
}

// Restore minimized state on load
(function() {
  if (localStorage.getItem('greetingMinimized') === '1') {
    const tile = document.getElementById('greetingTile');
    if (tile) tile.classList.add('minimized');
  }
})();

// ── Daily Motivational Quote (Claude AI) ──
async function loadDailyQuote() {
  const QUOTE_KEY = 'dailyQuote';
  const today = todayKey();

  const cached = getStorage(QUOTE_KEY, null);
  if (cached && cached.date === today && cached.quote) {
    renderQuote(cached.quote, cached.author);
    return;
  }

  localStorage.removeItem(QUOTE_KEY);

  const textEl   = document.getElementById('dailyQuoteText');
  const authorEl = document.getElementById('dailyQuoteAuthor');
  if (textEl)   { textEl.textContent = 'Generating…'; textEl.className = 'greeting-quote-text greeting-loading'; }
  if (authorEl) authorEl.textContent = '';

  const goals  = getStorage('userGoals', {});
  const macros = getStorage('userMacros', null) || MACROS;
  const cw     = goals.weight || 165;
  const gw     = goals.goal   || 163;
  const cal    = macros.calories;
  const pro    = macros.protein;

  const prompt = `You are a personal coach for Jeremy, a 52-year-old man working to go from ${cw} lbs to ${gw} lbs. He follows a Push/Pull/Legs lifting program 3x per week, runs regularly (training for Grandma's Marathon in June 2026), and tracks macros at ${cal} kcal/day with ${pro}g protein.

Generate ONE short, powerful motivational quote for today (${nowEST().toLocaleDateString('en-US', {weekday:'long', month:'long', day:'numeric', timeZone:'America/New_York'})}). Touch on one of: strength at 52, nutrition discipline, weight loss, marathon training, or mental toughness.

Keep it under 30 words. Respond ONLY with valid JSON, no markdown:
{"quote": "The quote here.", "author": "— Author (or empty string if original)"}`;

  const fallbacks = [
    { quote: "The only bad workout is the one that didn't happen. Show up.", author: "" },
    { quote: "Discipline is choosing between what you want now and what you want most.", author: "— Abraham Lincoln" },
    { quote: "At 52, you're not slowing down. You're refining. Every rep counts double.", author: "" },
    { quote: "Your body can stand almost anything. It's your mind you have to convince.", author: "" },
    { quote: "Success is the sum of small efforts repeated day in and day out.", author: "— Robert Collier" },
    { quote: "The groundwork for all happiness is good health. Log your macros, lift heavy, repeat.", author: "" },
    { quote: "It never gets easier. You just get stronger.", author: "" },
    { quote: "Take care of your body. It's the only place you have to live.", author: "— Jim Rohn" },
    { quote: "Motivation gets you started. Habit keeps you going. Build the habit.", author: "" },
    { quote: "You don't have to be extreme. Just be consistent.", author: "" },
    { quote: "Every rep is a vote for the person you're becoming.", author: "" },
    { quote: "Strength does not come from the body. It comes from the will.", author: "" },
    { quote: "The pain you feel today will be the strength you feel tomorrow.", author: "" },
    { quote: "Fitness is not about being better than someone else. It's about being better than you used to be.", author: "" },
    { quote: "At 52, every mile you run is a gift to the next 30 years.", author: "" },
    { quote: "The marathon doesn't start at mile one. It starts the moment you decide to train.", author: "" },
    { quote: "Protein first. Always.", author: "" },
    { quote: "The deficit today builds the body tomorrow.", author: "" },
    { quote: "Champions aren't made in gyms. They're made from what they have deep inside.", author: "— Muhammad Ali" },
    { quote: "Do something today that your future self will thank you for.", author: "" },
  ];

  try {
    const resp = await callClaudeAPI({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    });

    if (!resp || !resp.content) throw new Error('No API response');
    const raw = resp.content.find(b => b.type === 'text')?.text || '';
    if (!raw) throw new Error('Empty response');
    const clean = raw.replace(/```json|```/g, '').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in: ' + clean.slice(0, 80));
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.quote) throw new Error('Missing quote field');

    const entry = { date: today, quote: parsed.quote, author: parsed.author || '', _apiFetched: true };
    setStorage(QUOTE_KEY, entry);
    renderQuote(entry.quote, entry.author);

  } catch (e) {
    console.warn('[Quote] API failed, using fallback:', e.message);
    const d = nowEST();
    const dayOfYear = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
    const fb = fallbacks[dayOfYear % fallbacks.length];
    setStorage(QUOTE_KEY, { date: 'retry', quote: fb.quote, author: fb.author });
    renderQuote(fb.quote, fb.author);
  }
}

function renderQuote(quote, author) {
  const textEl   = document.getElementById('dailyQuoteText');
  const authorEl = document.getElementById('dailyQuoteAuthor');
  if (!textEl) return;
  textEl.textContent = `"${quote}"`;
  textEl.className   = 'greeting-quote-text greet-animate';
  if (authorEl) authorEl.textContent = author || '';
}

// ── Weekly Calorie Balance ──
function renderWeeklyBalance() {
  const grid  = document.getElementById('weekBalanceGrid');
  const sumRow = document.getElementById('weeklySummaryRow');
  const rangeEl = document.getElementById('weekRangeLabel');
  if (!grid || !sumRow) return;

  // Build Mon–Sun using pure ms arithmetic — no setDate, no timezone mutation issues
  const todayStr   = todayKey();                              // 'YYYY-MM-DD' in EST
  const todayAnchor = new Date(todayStr + 'T12:00:00');       // noon local — stable anchor
  const DAY_MS     = 24 * 60 * 60 * 1000;
  const dow        = todayAnchor.getDay();                    // 0=Sun
  const diffToMon  = (dow === 0 ? -6 : 1 - dow);             // steps back to Monday
  const monMs      = todayAnchor.getTime() + diffToMon * DAY_MS;
  const weekDays   = Array.from({ length: 7 }, (_, i) => new Date(monMs + i * DAY_MS));

  const macroLog   = getStorage('macroLog', {});
  const burnLog    = getStorage('burnLog', {});
  const shoeRuns   = getShoeRuns(); // runs logged via shoe tracker (may have calorie data)
  // baseTDEE: use explicitly saved TDEE, else the calculated default (never fall to macro target)
  const _storedTDEE = getStorage('userTDEE', null);
  const baseTDEE = (typeof _storedTDEE === 'number' && _storedTDEE > 1000 && _storedTDEE < 6000)
    ? _storedTDEE
    : TDEE;


  const DAY_NAMES = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  const days = weekDays.map((d, i) => {
    const key     = dateToKey(d);
    const log     = macroLog[key];
    const hasData = !!log && log.calories > 0;
    const isToday = key === todayStr;
    const isPast  = key <= todayStr;

    // Burn calories from TrainingPeaks burnLog or shoe run estimate
    let dayBurn = (typeof burnLog[key] === 'number' ? burnLog[key] : 0);
    if (!dayBurn) {
      const dayRuns = shoeRuns.filter(r => r.date === key);
      dayBurn = dayRuns.reduce((s, r) => {
        if (r.calories && r.calories > 0) return s + r.calories;
        return s + Math.round((r.miles || 0) * 100);
      }, 0);
    }

    // Net balance: calories eaten minus maintenance (TDEE only — don't add burn on top,
    // since TDEE already includes base activity. Run burn reduces net deficit instead.)
    // Balance includes run burn — same as detail panel
    const balance   = hasData ? (log.calories - (baseTDEE + dayBurn)) : null;
    const dailyCals = hasData ? log.calories : null;
    return { name: DAY_NAMES[i], key, balance, hasData, isToday, isPast, dayBurn, dailyCals };
  });

  // Max absolute balance for scaling bars
  const maxAbs = Math.max(500, ...days.filter(d => d.balance !== null).map(d => Math.abs(d.balance)));

  // Range label
  const fmt = d => `${d.getMonth()+1}/${d.getDate()}`;
  if (rangeEl) rangeEl.textContent = `${fmt(weekDays[0])} – ${fmt(weekDays[6])}`;

  // Render bar chart
  grid.innerHTML = days.map(d => {
    const bal = d.balance;
    const isSurplus = bal > 0;
    const hasVal = bal !== null;
    const type = !hasVal ? 'none' : isSurplus ? 'surplus' : 'deficit';
    const barH = hasVal ? Math.max(4, Math.round((Math.abs(bal) / maxAbs) * 52)) : 3;
    const label = !hasVal
      ? (d.isPast ? '—' : '')
      : isSurplus
        ? `+${Math.abs(bal) >= 1000 ? (Math.abs(bal)/1000).toFixed(1)+'k' : Math.round(Math.abs(bal))}`
        : `-${Math.abs(bal) >= 1000 ? (Math.abs(bal)/1000).toFixed(1)+'k' : Math.round(Math.abs(bal))}`;
    const runIcon = d.dayBurn > 0 ? '🏃' : '';
    const calLine = d.dailyCals !== null
      ? `<div class="wbd-cals">${d.dailyCals >= 1000 ? (d.dailyCals/1000).toFixed(1)+'k' : d.dailyCals} kcal${runIcon ? ' '+runIcon : ''}</div>`
      : (runIcon ? `<div class="wbd-cals">${runIcon}</div>` : '');

    return `<div class="wbd${d.isToday ? ' wbd-today' : ''}" onclick="selectWeekDay('${d.key}')" data-wbd-key="${d.key}">
      <div class="wbd-name">${d.name}</div>
      <div class="wbd-bar-wrap">
        <div class="wbd-bar ${type}" style="height:${barH}px"></div>
      </div>
      <div class="wbd-val ${type}">${label}</div>
      ${calLine}
    </div>`;
  }).join('');

  // Weekly totals — balance already includes burn per day
  const loggedDays   = days.filter(d => d.balance !== null);
  const weeklyNet    = loggedDays.reduce((s, d) => s + d.balance, 0);
  const weeklyBurn   = days.reduce((s, d) => s + (d.dayBurn || 0), 0);
  const weightImpact = weeklyNet / 3500;    // lbs (neg = loss), burn already baked in
  const daysLogged   = loggedDays.length;
  const avgDailyCals = daysLogged > 0 ? Math.round(loggedDays.reduce((s, d) => s + d.dailyCals, 0) / daysLogged) : 0;

  const netColor = weeklyNet < 0 ? 'var(--green)' : weeklyNet > 0 ? 'var(--red)' : 'var(--text)';
  const wtColor  = weightImpact < 0 ? 'var(--green)' : weightImpact > 0 ? 'var(--red)' : 'var(--text)';
  const wtSign   = weightImpact < 0 ? '−' : weightImpact > 0 ? '+' : '';
  const netSign  = weeklyNet  < 0 ? '−' : weeklyNet  > 0 ? '+' : '';

  const burnTile = weeklyBurn > 0
    ? `<div class="weekly-stat">
        <div class="weekly-stat-val" style="color:#f97316">${weeklyBurn.toLocaleString()}</div>
        <div class="weekly-stat-lbl">Run Cals Burned</div>
      </div>`
    : '';

  sumRow.innerHTML = `
    <div class="weekly-stat">
      <div class="weekly-stat-val" style="color:${netColor}">${netSign}${Math.abs(Math.round(weeklyNet)).toLocaleString()}</div>
      <div class="weekly-stat-lbl">Net vs TDEE</div>
    </div>
    <div class="weekly-stat">
      <div class="weekly-stat-val" style="color:${wtColor}">${wtSign}${Math.abs(weightImpact).toFixed(2)} lbs</div>
      <div class="weekly-stat-lbl">Expected Change</div>
    </div>
    ${burnTile}
    <div class="weekly-stat">
      <div class="weekly-stat-val">${avgDailyCals > 0 ? avgDailyCals.toLocaleString() : '—'}</div>
      <div class="weekly-stat-lbl">Avg Daily Cals</div>
    </div>
    <div class="weekly-stat">
      <div class="weekly-stat-val">${daysLogged}/7</div>
      <div class="weekly-stat-lbl">Days Logged</div>
    </div>`;
}

let _selectedWbdKey = null;

function selectWeekDay(key) {
  const panel   = document.getElementById('wbdDetailPanel');
  const macroLog = getStorage('macroLog', {});
  const burnLog  = getStorage('burnLog', {});
  const baseTDEE = getStorage('userTDEE', null) || TDEE;

  // Deselect if clicking same day
  if (_selectedWbdKey === key) {
    _selectedWbdKey = null;
    panel.style.display = 'none';
    document.querySelectorAll('.wbd-selected').forEach(el => el.classList.remove('wbd-selected'));
    return;
  }
  _selectedWbdKey = key;

  // Highlight selected tile
  document.querySelectorAll('[data-wbd-key]').forEach(el => {
    el.classList.toggle('wbd-selected', el.dataset.wbdKey === key);
  });

  const log     = macroLog[key] || {};
  const burn    = (typeof burnLog[key] === 'number' ? burnLog[key] : 0);
  const cals    = Math.round(log.calories || 0);
  const protein = Math.round(log.protein  || 0);
  const carbs   = Math.round(log.carbs    || 0);
  const fat     = Math.round(log.fat      || 0);
  // Detail panel shows full deficit including run burn
  // Weekly bar uses base-only (already correct in renderWeeklyBalance)
  const totalDeficit = cals > 0 ? cals - (baseTDEE + burn) : null;
  const hasData = cals > 0;

  // Format date label
  const d = new Date(key + 'T12:00:00');
  const dayLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  const balColor  = totalDeficit === null ? 'var(--text3)' : totalDeficit < 0 ? 'var(--green)' : 'var(--red)';
  const balSign   = totalDeficit === null ? '' : totalDeficit < 0 ? '−' : '+';
  const balVal    = totalDeficit === null ? '—' : balSign + Math.abs(Math.round(totalDeficit)).toLocaleString();
  // Weight impact uses total deficit (base + run)
  const lbsImpact = totalDeficit !== null ? (totalDeficit / 3500) : null;
  const lbsStr    = lbsImpact !== null
    ? (lbsImpact < 0 ? '−' : '+') + Math.abs(lbsImpact).toFixed(2) + ' lbs'
    : '—';
  const lbsColor  = lbsImpact === null ? 'var(--text3)' : lbsImpact < 0 ? 'var(--green)' : 'var(--red)';

  panel.style.display = 'block';
  panel.innerHTML = `
    <div class="wbd-detail-title">${dayLabel}</div>
    ${!hasData ? '<div style="font-size:12px;color:var(--text3);text-align:center;padding:8px 0">No food logged this day</div>' : `
    <div class="wbd-detail-grid">
      <div class="wbd-detail-cell">
        <div class="wbd-detail-val" style="color:#f59e0b">${cals.toLocaleString()}</div>
        <div class="wbd-detail-lbl">Calories</div>
      </div>
      <div class="wbd-detail-cell">
        <div class="wbd-detail-val" style="color:#4ade80">${protein}g</div>
        <div class="wbd-detail-lbl">Protein</div>
      </div>
      <div class="wbd-detail-cell">
        <div class="wbd-detail-val" style="color:#60a5fa">${carbs}g</div>
        <div class="wbd-detail-lbl">Carbs</div>
      </div>
      <div class="wbd-detail-cell">
        <div class="wbd-detail-val" style="color:#f87171">${fat}g</div>
        <div class="wbd-detail-lbl">Fat</div>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <div style="flex:1;background:var(--surface);border-radius:10px;padding:8px;text-align:center">
        <div style="font-size:14px;font-weight:800;color:${balColor}">${balVal}</div>
        <div style="font-size:9px;color:var(--text3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-top:2px">vs Maintenance (${baseTDEE.toLocaleString()}${burn > 0 ? ' + 🏃' + burn.toLocaleString() : ''} kcal)</div>
      </div>
      <div style="flex:1;background:var(--surface);border-radius:10px;padding:8px;text-align:center">
        <div style="font-size:14px;font-weight:800;color:${lbsColor}">${lbsStr}</div>
        <div style="font-size:9px;color:var(--text3);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-top:2px">Est. Weight Impact</div>
      </div>
    </div>`}`;
}

// ═══════════════════════════════════════════════════════
// ── USDA FoodData Central Search ──
// ═══════════════════════════════════════════════════════

// All Claude API calls route through the Cloudflare worker proxy at /api/claude
// The actual API key lives in Cloudflare environment secrets (never in code)
// Long analyses on mobile: hold a screen wake lock so Android doesn't kill
// the connection when the display dims, and retry once if the network drops.
async function callClaudeAPIWithRetry(payload) {
  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch(_) {}
  try {
    try {
      return await callClaudeAPI(payload);
    } catch (e) {
      const netFail = e instanceof TypeError || /failed to fetch|load failed|network/i.test(e.message);
      if (!netFail) throw e;
      showToast('⚠️ Connection dropped — retrying…');
      return await callClaudeAPI(payload);
    }
  } finally {
    try { await wakeLock?.release(); } catch(_) {}
  }
}

// Submit to the async proxy and poll with short requests every 2.5s.
// Poll-time network blips are ignored — the job keeps running server-side.
async function callClaudeAPIAsync(payload, onProgress) {
  let sub;
  try {
    sub = await fetch('/api/claude/async', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
  } catch (e) {
    reportClientError('claude_async_submit', e, { payloadKB: Math.round(JSON.stringify(payload).length / 1024) });
    throw new Error('Could not reach the server to start the analysis (submit leg) — ' + e.message);
  }
  const sd = await sub.json().catch(() => ({}));
  if (!sub.ok || !sd.ok) throw new Error(sd.error?.message || ('submit failed: ' + sub.status));
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    await new Promise(r => setTimeout(r, 2500));
    if (onProgress) onProgress(Math.round((Date.now() - t0) / 1000));
    let d = null;
    try {
      const res = await fetch('/api/claude/job?id=' + sd.job_id, { headers: authHeaders() });
      d = await res.json();
    } catch (_) { continue; }  // blip — job is still running server-side
    if (d?.status === 'done') return d.result;
    if (d?.status === 'error') throw new Error(d.error || 'analysis failed');
  }
  throw new Error('analysis timed out after 3 minutes — try again');
}

async function callClaudeAPI(payload) {
  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`API error ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
  }
  return data;
}

async function searchUSDA(query, maxResults = 8) {
  const url = `/api/usda/search?query=${encodeURIComponent(query)}&pageSize=${maxResults}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('USDA API error');
  const data = await res.json();
  return (data.foods || []).map(f => {
    const nutr = n => (f.foodNutrients || []).find(x => x.nutrientId === n || x.nutrientNumber === String(n));
    return {
      fdcId:    f.fdcId,
      name:     f.description,
      brand:    f.brandOwner || f.brandName || '',
      calories: Math.round(nutr(1008)?.value || nutr('208')?.value || 0),
      protein:  Math.round((nutr(1003)?.value || nutr('203')?.value || 0) * 10) / 10,
      carbs:    Math.round((nutr(1005)?.value || nutr('205')?.value || 0) * 10) / 10,
      fat:      Math.round((nutr(1004)?.value || nutr('204')?.value || 0) * 10) / 10,
      servingSize: f.servingSize || 100,
      servingUnit: f.servingSizeUnit || 'g',
    };
  }).filter(f => f.calories > 0);
}

// ═══════════════════════════════════════════════════════
// ── Restaurant Food Search (USDA Branded DB) ──
// ═══════════════════════════════════════════════════════
async function runRestaurantSearch() {
  const q = document.getElementById('restaurantSearchInput').value.trim();
  if (!q) return;
  const loadEl  = document.getElementById('restaurantLoading');
  const resEl   = document.getElementById('restaurantResults');
  loadEl.style.display = 'block';
  resEl.innerHTML = '';
  try {
    // Use USDA branded foods (dataType=Branded catches restaurant items)
    const url = `/api/usda/search?query=${encodeURIComponent(q)}&dataType=Branded&pageSize=12`;
    const res  = await fetch(url);
    const data = await res.json();
    const foods = (data.foods || []).map(f => {
      const nutr = n => (f.foodNutrients || []).find(x => x.nutrientId === n || x.nutrientNumber === String(n));
      return {
        name:     f.description,
        brand:    f.brandOwner || f.brandName || '',
        calories: Math.round(nutr(1008)?.value || nutr('208')?.value || 0),
        protein:  Math.round((nutr(1003)?.value || nutr('203')?.value || 0) * 10) / 10,
        carbs:    Math.round((nutr(1005)?.value || nutr('205')?.value || 0) * 10) / 10,
        fat:      Math.round((nutr(1004)?.value || nutr('204')?.value || 0) * 10) / 10,
        servingSize: f.servingSize || 100,
        servingUnit: f.servingSizeUnit || 'g',
      };
    }).filter(f => f.calories > 0);

    loadEl.style.display = 'none';
    if (foods.length === 0) {
      resEl.innerHTML = '<div style="text-align:center;color:var(--text3);padding:20px;font-size:13px">No results found. Try a different search.</div>';
      return;
    }
    resEl.innerHTML = foods.map((f, i) => `
      <div class="db-result" onclick="openFoodDetail(${JSON.stringify(f).replace(/"/g, '&quot;')}, 'log')">
        <div class="db-result-info">
          <div class="db-result-name">${esc(f.name)}</div>
          <div class="db-result-meta">${f.brand ? esc(f.brand) + ' · ' : ''}${f.protein}g P · ${f.carbs}g C · ${f.fat}g F · per ${f.servingSize}${f.servingUnit}</div>
        </div>
        <div class="db-result-kcal">${f.calories}<br><span style="font-size:9px;color:var(--text3);font-weight:600">kcal</span></div>
      </div>`).join('');
  } catch(e) {
    loadEl.style.display = 'none';
    resEl.innerHTML = '<div style="color:var(--red);font-size:12px;padding:10px">Search failed. Check your connection and try again.</div>';
  }
}

function quickRestaurant(btn) {
  document.getElementById('restaurantSearchInput').value = btn.textContent.replace(/^[^ ]+ /,'');
  runRestaurantSearch();
}

// ═══════════════════════════════════════════════════════
// ── Shared Food Detail Modal ──
// ═══════════════════════════════════════════════════════
let fdFood = null, fdServings = 1, fdMode = 'log', fdRecipeCallback = null;

function openFoodDetail(food, mode, recipeCallback) {
  fdFood = food; fdServings = 1; fdMode = mode; fdRecipeCallback = recipeCallback || null;
  document.getElementById('fdTitle').textContent = mode === 'recipe' ? '➕ Add to Recipe' : '🍽️ Log Food';
  document.getElementById('fdServingsVal').textContent = '1';

  const card = document.getElementById('fdFoodCard');
  card.innerHTML = `
    <div class="food-name">${esc(food.name)}</div>
    ${food.brand ? `<div class="food-brand">${esc(food.brand)}</div>` : ''}
    <div class="food-macros" id="fdMacrosGrid"></div>`;
  renderFdMacros();

  const btns = document.getElementById('fdActionBtns');
  if (mode === 'recipe') {
    btns.innerHTML = `<button class="btn-green" onclick="addIngredientToRecipe()">➕ Add to Recipe</button>`;
  } else {
    btns.innerHTML = `<button class="btn-green" onclick="logFdFood()">LOG THIS FOOD ✓</button>`;
  }
  document.getElementById('foodDetailModal').classList.add('open');
}

function renderFdMacros() {
  const s = fdServings;
  const f = fdFood;
  document.getElementById('fdMacrosGrid').innerHTML = `
    <div class="food-macro-chip"><div class="food-macro-chip-val">${Math.round(f.calories*s)}</div><div class="food-macro-chip-lbl">kcal</div></div>
    <div class="food-macro-chip"><div class="food-macro-chip-val">${(f.protein*s).toFixed(1)}g</div><div class="food-macro-chip-lbl">Protein</div></div>
    <div class="food-macro-chip"><div class="food-macro-chip-val">${(f.carbs*s).toFixed(1)}g</div><div class="food-macro-chip-lbl">Carbs</div></div>
    <div class="food-macro-chip"><div class="food-macro-chip-val">${(f.fat*s).toFixed(1)}g</div><div class="food-macro-chip-lbl">Fat</div></div>`;
  document.getElementById('fdServingsVal').textContent = fdServings % 1 === 0 ? fdServings : fdServings.toFixed(1);
}

function adjustFdServings(delta) {
  fdServings = Math.max(0.5, fdServings + delta);
  renderFdMacros();
}

function logFdFood() {
  if (!fdFood) return;
  const s = fdServings;
  addFoodEntry({
    name:     fdFood.name + (s !== 1 ? ` (×${s})` : ''),
    calories: Math.round(fdFood.calories * s),
    protein:  Math.round(fdFood.protein  * s * 10) / 10,
    carbs:    Math.round(fdFood.carbs    * s * 10) / 10,
    fat:      Math.round(fdFood.fat      * s * 10) / 10,
    icon: '🍽️',
  });
  document.getElementById('foodDetailModal').classList.remove('open');
}

// ═══════════════════════════════════════════════════════

// ── Recipe Barcode Scanner ──────────────────────────────
let _recipeScanActive = false;

function openRecipeBarcode() {
  document.getElementById('recipeScanOverlay').style.display = 'block';
}

function closeRecipeBarcode() {
  stopRecipeCamera();
  document.getElementById('recipeScanOverlay').style.display = 'none';
}

let _recipeScanRAF = null;
let _recipeScanStream = null;

async function startRecipeBarcode() {
  const container = document.getElementById('recipeScanContainer');
  const status    = document.getElementById('recipeScanStatus');
  const btn       = document.getElementById('recipeScanBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Starting…';
  status.textContent = 'Requesting camera…';

  // Clear previous video
  container.innerHTML = '<div id="recipeScanHint" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#475569;font-size:12px">Initializing…</div>';

  // Try native BarcodeDetector first
  if ('BarcodeDetector' in window) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      const needed = ['ean_13','ean_8','upc_a','upc_e','code_128','code_39'].filter(f => formats.includes(f));
      if (needed.length > 0) {
        await startRecipeNativeScanner(container, status, btn, needed);
        return;
      }
    } catch(e) { /* fall through */ }
  }

  // Fallback: QuaggaJS
  if (!window.Quagga) {
    status.textContent = '⚠️ Scanner not loaded. Try text search.';
    btn.disabled = false; btn.textContent = '▶ Start Camera';
    return;
  }

  Quagga.init({
    inputStream: {
      name: 'Live',
      type: 'LiveStream',
      target: container,
      constraints: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    },
    decoder: { readers: ['ean_reader','ean_8_reader','upc_reader','upc_e_reader','code_128_reader','code_39_reader'] },
    locate: true,
    locator: { patchSize: 'medium', halfSample: false },
    frequency: 10,
  }, function(err) {
    if (err) {
      status.textContent = '⚠️ Camera error: ' + err.message;
      btn.disabled = false; btn.textContent = '▶ Retry';
      return;
    }
    Quagga.start();
    _recipeScanActive = true;
    btn.textContent = '⏹ Stop';
    btn.disabled = false;
    btn.onclick = stopRecipeCamera;
    status.textContent = 'Point at a barcode…';

    const video = container.querySelector('video');
    if (video) { video.style.cssText = 'width:100%;height:100%;object-fit:cover'; }
    const canvas = container.querySelector('canvas.drawingBuffer');
    if (canvas) canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%';
  });

  Quagga.onDetected(onRecipeBarcodeDetected);
}

async function startRecipeNativeScanner(container, status, btn, formats) {
  const detector = new BarcodeDetector({ formats });
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
  });
  _recipeScanStream = stream;

  const vid = document.createElement('video');
  vid.style.cssText = 'width:100%;height:100%;object-fit:cover';
  vid.setAttribute('playsinline', '');
  vid.setAttribute('autoplay', '');
  vid.srcObject = stream;
  container.innerHTML = '';
  container.appendChild(vid);
  await vid.play();

  _recipeScanActive = true;
  btn.textContent = '⏹ Stop';
  btn.disabled = false;
  btn.onclick = stopRecipeCamera;
  status.textContent = 'Point at a barcode…';

  let lastScan = 0;
  async function scanLoop(ts) {
    if (!_recipeScanActive) return;
    if (ts - lastScan >= 150) {
      lastScan = ts;
      try {
        const barcodes = await detector.detect(vid);
        for (const b of barcodes) {
          if (b.rawValue) {
            _recipeScanActive = false;
            stopRecipeCamera();
            lookupBarcodeForRecipe(b.rawValue);
            return;
          }
        }
      } catch(e) {}
    }
    _recipeScanRAF = requestAnimationFrame(scanLoop);
  }
  _recipeScanRAF = requestAnimationFrame(scanLoop);
}

function stopRecipeCamera() {
  if (_recipeScanRAF) { cancelAnimationFrame(_recipeScanRAF); _recipeScanRAF = null; }
  if (_recipeScanStream) { _recipeScanStream.getTracks().forEach(t => t.stop()); _recipeScanStream = null; }
  if (_recipeScanActive) {
    try { Quagga.offDetected(onRecipeBarcodeDetected); Quagga.stop(); } catch(e) {}
    _recipeScanActive = false;
  }
  const btn = document.getElementById('recipeScanBtn');
  if (btn) { btn.textContent = '▶ Start Camera'; btn.disabled = false; btn.onclick = startRecipeBarcode; }
}

function onRecipeBarcodeDetected(result) {
  const code = result.codeResult.code;
  if (!code || !isValidBarcode(code)) return;
  stopRecipeCamera();
  lookupBarcodeForRecipe(code);
}

async function lookupBarcodeForRecipe(barcode) {
  const status = document.getElementById('recipeScanStatus');
  const btn    = document.getElementById('recipeScanBtn');
  status.textContent = `⏳ Searching all databases for ${barcode}…`;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Looking up…'; }

  function parseOFF(p) {
    const n = p.nutriments || {};
    const servingQty = parseFloat(p.serving_quantity) || parseFloat(p.serving_size) || 0;
    const scale100g  = servingQty > 0 ? servingQty / 100 : 1;
    function getPerServing(base) {
      const bases = [base, base.replace('-','_')];
      for (const b of bases) {
        const sv = n[`${b}_serving`];
        if (sv !== undefined && sv !== null && sv !== '' && !isNaN(parseFloat(sv))) return parseFloat(sv);
      }
      for (const b of bases) {
        const v100 = n[`${b}_100g`];
        if (v100 !== undefined && v100 !== null && v100 !== '' && !isNaN(parseFloat(v100))) return parseFloat(v100) * scale100g;
      }
      return 0;
    }
    let calories = getPerServing('energy-kcal');
    if (calories === 0) { const kj = getPerServing('energy'); if (kj > 0) calories = kj / 4.184; }
    if (calories > 800 && servingQty > 0 && servingQty < 60) calories = calories * (servingQty / 100);
    return {
      name: p.product_name_en || p.product_name || p.abbreviated_product_name || '',
      brand: p.brands || '',
      calories: Math.round(calories),
      protein: Math.round(getPerServing('proteins') * 10) / 10,
      carbs:   Math.round(getPerServing('carbohydrates') * 10) / 10,
      fat:     Math.round(getPerServing('fat') * 10) / 10,
      servingSize: p.serving_size || (servingQty > 0 ? `${servingQty}g` : '1 serving'),
      source: 'Open Food Facts',
    };
  }

  // Fire all three lookups simultaneously
  const offWorld = fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}?fields=product_name,product_name_en,abbreviated_product_name,brands,serving_size,serving_quantity,nutriments,nutrition_data_per`)
    .then(r => r.json())
    .then(data => {
      if (data.status === 1 && data.product) {
        const prod = parseOFF(data.product);
        if (prod.name && prod.calories >= 0) return prod;
      }
      throw new Error('not found');
    });

  const offUS = fetch(`https://us.openfoodfacts.org/api/v2/product/${barcode}?fields=product_name,product_name_en,brands,serving_size,serving_quantity,nutriments,nutrition_data_per`)
    .then(r => r.json())
    .then(data => {
      if (data.status === 1 && data.product) {
        const prod = parseOFF(data.product);
        if (prod.name && prod.calories >= 0) return prod;
      }
      throw new Error('not found');
    });

  const usda = fetch(`/api/usda/search?query=${barcode}&dataType=Branded&pageSize=5`)
    .then(r => r.json())
    .then(data => {
      const foods = data.foods || [];
      const f = foods.find(x => x.gtinUpc === barcode || x.gtinUpc === barcode.replace(/^0+/,'')) || foods[0];
      if (!f) throw new Error('not found');
      const nutr = id => ((f.foodNutrients||[]).find(x => x.nutrientId===id||x.nutrientNumber===String(id))?.value ?? 0);
      const servingG = parseFloat(f.servingSize) || 0;
      const scale = servingG > 0 ? servingG / 100 : 1;
      const prod = {
        name: f.description || '',
        brand: f.brandOwner || '',
        calories: Math.round((nutr(1008)||nutr(208)) * scale),
        protein:  Math.round((nutr(1003)||nutr(203)) * scale * 10) / 10,
        carbs:    Math.round((nutr(1005)||nutr(205)) * scale * 10) / 10,
        fat:      Math.round((nutr(1004)||nutr(204)) * scale * 10) / 10,
        servingSize: servingG > 0 ? `${servingG}${f.servingSizeUnit||'g'}` : '100g',
        source: 'USDA',
      };
      if (!prod.name) throw new Error('no name');
      return prod;
    });

  try {
    // First database to return a valid result wins
    const prod = await Promise.any([offWorld, offUS, usda]);
    addIngToCurrentRecipe(prod);
    status.textContent = `✅ Added: ${prod.name.slice(0,35)}`;
    if (btn) { btn.disabled = false; btn.textContent = '▶ Scan Another'; btn.onclick = startRecipeBarcode; }
  } catch(e) {
    // All three failed
    status.textContent = `❌ Barcode ${barcode} not found in any database. Try text search.`;
    if (btn) { btn.disabled = false; btn.textContent = '▶ Scan Again'; btn.onclick = startRecipeBarcode; }
  }
}

// ── Recipe Builder ──
// ═══════════════════════════════════════════════════════
let currentRecipeIngredients = [];

function openNewRecipeModal() {
  currentRecipeIngredients = [];
  document.getElementById('recipeNameInput').value = '';
  document.getElementById('recipeIngSearchInput').value = '';
  document.getElementById('recipeIngResults').innerHTML = '';
  document.getElementById('recipeIngLoading').style.display = 'none';
  renderRecipeIngList();
  document.getElementById('newRecipeModal').classList.add('open');
}

async function searchRecipeIngredient() {
  const q = document.getElementById('recipeIngSearchInput').value.trim();
  if (!q) return;
  const loadEl = document.getElementById('recipeIngLoading');
  const resEl  = document.getElementById('recipeIngResults');
  loadEl.style.display = 'block';
  resEl.innerHTML = '';
  try {
    const foods = await searchUSDA(q, 6);
    loadEl.style.display = 'none';
    if (foods.length === 0) { resEl.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:8px">No results. Try a different term.</div>'; return; }
    resEl.innerHTML = foods.map((f,i) => `
      <div class="db-result" onclick='addIngToCurrentRecipe(${JSON.stringify(f)})'>
        <div class="db-result-info">
          <div class="db-result-name">${esc(f.name)}</div>
          <div class="db-result-meta">${f.calories} kcal · ${f.protein}g P · per ${f.servingSize}${f.servingUnit}</div>
        </div>
        <div style="font-size:18px;color:var(--green)">+</div>
      </div>`).join('');
  } catch(e) {
    loadEl.style.display = 'none';
    resEl.innerHTML = '<div style="color:var(--red);font-size:12px">Search failed.</div>';
  }
}

function addIngToCurrentRecipe(food) {
  currentRecipeIngredients.push({ ...food, qty: 1 });
  renderRecipeIngList();
  document.getElementById('recipeIngResults').innerHTML = '';
  document.getElementById('recipeIngSearchInput').value = '';
  showToast(`✅ ${food.name.slice(0,30)} added`);
}

function updateIngQty(i, val) {
  currentRecipeIngredients[i].qty = parseFloat(val) || 1;
  renderRecipeIngList();
}

function removeIngredient(i) {
  currentRecipeIngredients.splice(i, 1);
  renderRecipeIngList();
}

function renderRecipeIngList() {
  const listEl = document.getElementById('recipeIngredientsList');
  const totalEl = document.getElementById('recipeTotalBar');
  if (currentRecipeIngredients.length === 0) {
    listEl.innerHTML = '<div style="font-size:12px;color:var(--text3);font-style:italic">No ingredients yet — search above</div>';
    totalEl.style.display = 'none';
    return;
  }
  const totals = currentRecipeIngredients.reduce((a, ing) => ({
    calories: a.calories + ing.calories * ing.qty,
    protein:  a.protein  + ing.protein  * ing.qty,
    carbs:    a.carbs    + ing.carbs    * ing.qty,
    fat:      a.fat      + ing.fat      * ing.qty,
  }), { calories:0, protein:0, carbs:0, fat:0 });

  listEl.innerHTML = currentRecipeIngredients.map((ing, i) => `
    <div class="recipe-ingredient-row">
      <div class="recipe-ing-name">${ing.name.length > 32 ? esc(ing.name.slice(0,32))+'…' : esc(ing.name)}</div>
      <input class="ing-qty-input" type="number" value="${ing.qty}" min="0.25" step="0.25"
        onchange="updateIngQty(${i}, this.value)" title="Servings" />
      <div class="recipe-ing-macros">${Math.round(ing.calories*ing.qty)} kcal</div>
      <button onclick="removeIngredient(${i})" style="background:none;border:none;color:var(--red);font-size:16px;cursor:pointer;flex-shrink:0">✕</button>
    </div>`).join('');

  totalEl.style.display = 'flex';
  totalEl.style.justifyContent = 'space-between';
  totalEl.style.alignItems = 'center';
  totalEl.innerHTML = `
    <div style="font-size:11px;font-weight:700;color:var(--text2)">TOTAL</div>
    <div class="recipe-total-macros">${Math.round(totals.calories)} kcal · ${totals.protein.toFixed(1)}g P · ${totals.carbs.toFixed(1)}g C · ${totals.fat.toFixed(1)}g F</div>`;
}

function saveRecipe() {
  const name = document.getElementById('recipeNameInput').value.trim();
  if (!name) { showToast('⚠️ Enter a recipe name'); return; }
  if (currentRecipeIngredients.length === 0) { showToast('⚠️ Add at least one ingredient'); return; }

  const totals = currentRecipeIngredients.reduce((a, ing) => ({
    calories: a.calories + ing.calories * ing.qty,
    protein:  a.protein  + ing.protein  * ing.qty,
    carbs:    a.carbs    + ing.carbs    * ing.qty,
    fat:      a.fat      + ing.fat      * ing.qty,
  }), { calories:0, protein:0, carbs:0, fat:0 });

  const recipe = {
    id:          Date.now(),
    name,
    ingredients: currentRecipeIngredients.map(i => ({ ...i })),
    totals:      { calories: Math.round(totals.calories), protein: Math.round(totals.protein*10)/10, carbs: Math.round(totals.carbs*10)/10, fat: Math.round(totals.fat*10)/10 },
    created:     todayKey(),
  };
  const recipes = getStorage('savedRecipes', []);
  recipes.push(recipe);
  setStorage('savedRecipes', recipes);
  document.getElementById('newRecipeModal').classList.remove('open');
  renderRecipeList();
  showToast(`📖 "${name}" saved!`);
}

function deleteRecipe(id) {
  if (!confirm('Delete this recipe?')) return;
  const recipes = getStorage('savedRecipes', []).filter(r => r.id !== id);
  setStorage('savedRecipes', recipes);
  renderRecipeList();
  showToast('🗑️ Recipe deleted');
}

function logRecipe(id) {
  const recipe = getStorage('savedRecipes', []).find(r => r.id === id);
  if (!recipe) return;
  addFoodEntry({ name: recipe.name, ...recipe.totals, icon: '📖' });
  showToast(`✅ ${recipe.name} logged!`);
}

function renderRecipeList() {
  const recipes = getStorage('savedRecipes', []);
  const el = document.getElementById('recipeList');
  if (!el) return;
  if (recipes.length === 0) {
    el.innerHTML = '<div class="empty-state">No recipes yet.<br>Tap "+ Create New Recipe" to build your first one.</div>';
    return;
  }
  el.innerHTML = recipes.map(r => `
    <div class="recipe-card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div>
          <div class="recipe-name">📖 ${esc(r.name)}</div>
          <div class="recipe-meta">${r.ingredients.length} ingredients · Created ${r.created}</div>
        </div>
      </div>
      <div style="background:var(--surface2);border-radius:12px;padding:10px 12px;margin-bottom:10px">
        <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:6px">Nutrition (full recipe)</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <span style="font-size:12px;font-weight:700;color:var(--amber)">${r.totals.calories} kcal</span>
          <span style="font-size:12px;color:var(--green);font-weight:600">${r.totals.protein}g P</span>
          <span style="font-size:12px;color:var(--blue);font-weight:600">${r.totals.carbs}g C</span>
          <span style="font-size:12px;color:var(--red);font-weight:600">${r.totals.fat}g F</span>
        </div>
      </div>
      <div style="margin-bottom:10px">
        ${r.ingredients.map(ing => `<div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px solid var(--border)">
          <span style="color:var(--text2)">${esc(ing.name.slice(0,40))}</span>
          <span style="color:var(--text3);font-weight:600">×${ing.qty} · ${Math.round(ing.calories*ing.qty)} kcal</span>
        </div>`).join('')}
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn-recipe-log" onclick="logRecipe(${r.id})">✅ Log This Meal</button>
        <button class="btn-recipe-delete" onclick="deleteRecipe(${r.id})">🗑️ Delete</button>
      </div>
    </div>`).join('');
}

// ═══════════════════════════════════════════════════════
// ── Monthly Trend Charts ──
// ═══════════════════════════════════════════════════════
let currentTrendMetric = 'calories';

function setTrendMetric(metric, btn) {
  currentTrendMetric = metric;
  document.querySelectorAll('.chart-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderTrendChart();
}

function renderTrendChart() {
  const container = document.getElementById('monthChartContainer');
  const summaryRow = document.getElementById('trendSummaryRow');
  if (!container) return;

  const metric = currentTrendMetric;
  const isWeight = metric === 'weight';

  // Get last 30 days of data
  const today = nowEST();
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = nowEST();
    d.setDate(today.getDate() - i);
    const key = dateToKey(d);
    days.push({ key, label: d.getDate(), month: d.getMonth() });
  }

  let values;
  if (isWeight) {
    const weightLog = getStorage('weightLog', {});
    values = days.map(d => ({ ...d, val: weightLog[d.key] || null }));
  } else {
    const macroLog = getStorage('macroLog', {});
    values = days.map(d => {
      const log = macroLog[d.key];
      return { ...d, val: log ? (log[metric] || 0) : null };
    });
  }

  const logged = values.filter(v => v.val !== null);
  if (logged.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:30px 0">No data logged yet for this metric.</div>';
    summaryRow.innerHTML = '';
    return;
  }

  const maxVal = Math.max(...logged.map(v => v.val));
  const minVal = Math.min(...logged.map(v => v.val));
  const avgVal = logged.reduce((s, v) => s + v.val, 0) / logged.length;

  const colors = { calories:'#f59e0b', protein:'#22c55e', carbs:'#3b82f6', fat:'#ef4444', weight:'#8b5cf6' };
  const color = colors[metric];
  const target = isWeight ? null : (MACROS[metric] || null);

  // Bar chart
  const bars = values.map(d => {
    const hasVal = d.val !== null;
    const pct = hasVal ? Math.max(4, Math.round((d.val / (maxVal * 1.1)) * 100)) : 2;
    const isToday = d.key === todayKey();
    const overTarget = target && hasVal && d.val > target * 1.05;
    const barColor = overTarget ? '#ef4444' : (isToday ? color : color + 'cc');
    // Month boundary labels
    const showLabel = d.label === 1 || d.label % 7 === 1;
    return `<div class="month-bar-wrap">
      <div class="month-bar" style="height:${pct}%;background:${barColor};${isToday ? 'outline:2px solid #3b82f6;border-radius:5px 5px 0 0' : ''}"></div>
      <div class="month-bar-lbl">${showLabel ? d.label : ''}</div>
    </div>`;
  }).join('');

  container.innerHTML = `<div class="month-bar-chart">${bars}</div>`;

  // Summary stats
  const unit = isWeight ? 'lbs' : (metric === 'calories' ? 'kcal' : 'g');
  const trend = logged.length >= 7
    ? (logged[logged.length-1].val - logged[0].val).toFixed(1)
    : null;
  const trendStr = trend === null ? '—' : (trend > 0 ? `+${trend}` : trend);

  summaryRow.innerHTML = `
    <div class="weekly-stat" style="border-color:${color}30">
      <div class="weekly-stat-val" style="color:${color}">${Math.round(avgVal)}</div>
      <div class="weekly-stat-lbl">30-Day Avg (${unit})</div>
    </div>
    <div class="weekly-stat">
      <div class="weekly-stat-val">${Math.round(maxVal)}</div>
      <div class="weekly-stat-lbl">Peak</div>
    </div>
    <div class="weekly-stat">
      <div class="weekly-stat-val" style="color:${parseFloat(trendStr) < 0 && isWeight ? 'var(--green)' : parseFloat(trendStr) > 0 && !isWeight ? 'var(--red)' : 'var(--text)'}">${trendStr}</div>
      <div class="weekly-stat-lbl">30-Day Trend</div>
    </div>
    ${target ? `<div class="weekly-stat">
      <div class="weekly-stat-val" style="color:${Math.abs(avgVal-target)/target < 0.05 ? 'var(--green)' : 'var(--amber)'}">${Math.round((avgVal/target)*100)}%</div>
      <div class="weekly-stat-lbl">vs Target</div>
    </div>` : ''}`;
}

// ── Data Backup & Restore ──
const BACKUP_KEYS = [
  'liftPRs',
  'macroLog', 'foodEntries', 'weightLog',
  'savedFoods', 'savedRecipes', 'liftLog', 'liftLog2',
  'adaptiveMacros', 'garminAdjustedMacros', 'dailyQuote',
  'tpToday',
  'tpAutoAdjust',
  'shoeGarage', 'shoeRuns', 'bloodResults',
];

function exportData() {
  const backup = { _version: 1, _exported: new Date().toISOString(), data: {} };
  BACKUP_KEYS.forEach(key => {
    const val = localStorage.getItem(key);
    if (val !== null) backup.data[key] = val; // store raw strings to avoid double-parse
  });
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const date = dateToKey(nowEST());
  a.href     = url;
  a.download = `jeremymacro-backup-${date}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('✅ Backup downloaded!');
}

function importData(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const backup = JSON.parse(e.target.result);
      if (!backup.data) throw new Error('Invalid backup file');
      const allowedKeys = new Set(BACKUP_KEYS);
      let count = 0;
      Object.entries(backup.data).forEach(([key, val]) => {
        if (!allowedKeys.has(key)) return;
        localStorage.setItem(key, val);
        count++;
      });
      // Re-render everything
      renderRings();
      renderWeekStrip();
      renderFoodLog();
      renderWeightTrend();
      checkCopyYesterday();
      checkAdaptiveMacros();
      renderWeeklyBalance();
      renderRecipeList();

      const statusEl = document.getElementById('importStatus');
      statusEl.style.display = 'block';
      statusEl.textContent = `✅ Restored ${count} data entries successfully!`;
      showToast('✅ Data restored! All your logs are back.');
      setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
    } catch(err) {
      showToast('❌ Invalid backup file — please use a file exported from this app.');
    }
    input.value = ''; // reset so same file can be re-imported
  };
  reader.readAsText(file);
}

// ── SHOE TRACKER ──

const SHOE_COLORS = ['#f97316','#22c55e','#3b82f6','#8b5cf6','#ef4444','#06b6d4','#f59e0b','#ec4899'];
function getShoes()    { return getStorage('shoeGarage', []); }
function setShoes(s)   { setStorage('shoeGarage', s); }
function getShoeRuns() { return getStorage('shoeRuns', []); }
function setShoeRuns(r){ setStorage('shoeRuns', r); logInteraction('run_saved', r[r.length-1]?.miles || ''); }
// Photos stored separately to avoid quota issues with embedded base64
// Cache shoe photos in memory — reset any time photos are saved
let _shoePhotoCache = null;
function _invalidateShoePhotoCache() { _shoePhotoCache = null; }
function getShoePhoto(shoeId) {
  if (!_shoePhotoCache) _shoePhotoCache = getStorage('shoePhotos', {});
  return _shoePhotoCache[shoeId] || null;
}
// Migration: if old shoes have photoData embedded, move it out
function migrateShoePhotos() {
  const shoes  = getShoes();
  const photos = getStorage('shoePhotos', {});
  let changed  = false;
  shoes.forEach(s => {
    if (s.photoData) {
      photos[s.id] = s.photoData;
      delete s.photoData;
      s.hasPhoto = true;
      changed = true;
    }
  });
  if (changed) {
    _invalidateShoePhotoCache();
    setStorage('shoePhotos', photos);
    setStorage('shoeGarage', shoes);
  }
}

function shoeCurrentMiles(shoeId, runs) {
  const shoe = getShoes().find(s => s.id === shoeId);
  const runMiles = (runs || getShoeRuns()).filter(r => r.shoeId === shoeId).reduce((s,r) => s+(r.miles||0), 0);
  return runMiles + (shoe?.startMiles || 0) + (shoe?.mileageOffset || 0);
}
function lastRunDate(shoeId, runs) {
  const sr = (runs || getShoeRuns()).filter(r => r.shoeId === shoeId);
  return sr.length ? sr.map(r => r.date).sort().reverse()[0] : '';
}
function shoeAvgPace(shoeId, runs) {
  const sr = (runs || getShoeRuns()).filter(r => r.shoeId === shoeId && r.miles > 0 && r.duration > 0);
  if (!sr.length) return null;
  return sr.reduce((s,r) => s+r.duration/60, 0) / sr.reduce((s,r) => s+r.miles, 0);
}
function formatPace(minPerMile) {
  if (!minPerMile) return '—';
  const m = Math.floor(minPerMile);
  const s = Math.round((minPerMile - m) * 60);
  return `${m}:${String(s).padStart(2,'0')}/mi`;
}

function renderShoeStravaCard() {
  const card = document.getElementById('shoeStravaCard');
  if (!card) return;
  const cached = getStorage('tpToday', null);
  const isTP   = !!getStorage('tpConnected', null);
  if (!cached || !isTP) { card.style.display = 'none'; return; }

  const miles  = ((cached.distance || 0) / 1609.34).toFixed(2);
  const source = '⛰️ Synced from TrainingPeaks';

  document.getElementById('shoeStravaMiles').textContent = parseFloat(miles) > 0 ? `${miles} mi` : '0 mi';
  document.getElementById('shoeStravaSub').textContent   = source;
  card.style.display = 'flex';
}

function renderShoePage() {
  renderShoeStravaCard();
  const shoes  = getShoes();
  const runs   = getShoeRuns();
  const listEl  = document.getElementById('shoeList');
  const emptyEl = document.getElementById('shoeEmptyState');
  const summEl  = document.getElementById('shoeGarageSummary');
  const warnEl  = document.getElementById('shoeRetireWarning');
  if (!listEl) return;

  const totalMiles = runs.reduce((s, r) => s + (r.miles || 0), 0);
  summEl.textContent = `${shoes.length} pair${shoes.length !== 1 ? 's' : ''} · ${totalMiles.toFixed(1)} total miles logged`;

  // Garage count badge
  const countEl = document.getElementById('shoeGarageCount');
  if (countEl) countEl.textContent = shoes.length ? `${shoes.filter(s=>s.status==='active').length} active · ${shoes.filter(s=>s.status==='retired').length} retired` : '';

  // Retirement warnings
  const warnings = shoes.filter(s => {
    const mi = shoeCurrentMiles(s.id, runs);
    return s.status === 'active' && mi >= (s.retireMiles || 400) * 0.9;
  });
  if (warnings.length) {
    warnEl.style.display = 'block';
    warnEl.innerHTML = warnings.map(s => {
      const mi = shoeCurrentMiles(s.id, runs);
      return `⚠️ <strong>${s.name}</strong> is at ${mi.toFixed(0)} mi (${Math.round(mi / (s.retireMiles || 400) * 100)}% of ${s.retireMiles || 400} mi limit)`;
    }).join('<br>');
  } else { warnEl.style.display = 'none'; }

  if (!shoes.length) {
    listEl.innerHTML = '';
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  const sorted = [...shoes].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return lastRunDate(b.id, runs).localeCompare(lastRunDate(a.id, runs));
  });

  listEl.innerHTML = sorted.map(shoe => {
    const miles     = shoeCurrentMiles(shoe.id, runs);
    const retireMi  = shoe.retireMiles || 400;
    const pct       = Math.min(miles / retireMi, 1);
    const shoeRuns  = runs.filter(r => r.shoeId === shoe.id);
    const avgPace   = shoeAvgPace(shoe.id, runs);
    const lastDate  = lastRunDate(shoe.id, runs);
    const color     = shoe.color || SHOE_COLORS[parseInt(shoe.id) % SHOE_COLORS.length] || '#f97316';
    const barColor  = pct > 0.9 ? '#ef4444' : pct > 0.7 ? '#f59e0b' : '#22c55e';
    const miLeft    = Math.max(0, retireMi - miles);
    const photoSrc  = shoe.hasPhoto ? getShoePhoto(shoe.id) : null;

    // Photo or colour avatar
    const photoHtml = photoSrc
      ? `<img src="${photoSrc}" style="width:72px;height:72px;border-radius:14px;object-fit:cover;flex-shrink:0;cursor:pointer" onclick="openShoeDetail('${shoe.id}')" />`
      : `<div style="width:72px;height:72px;border-radius:14px;background:${color}22;border:2px solid ${color}55;display:flex;align-items:center;justify-content:center;font-size:34px;flex-shrink:0;cursor:pointer" onclick="openShoeDetail('${shoe.id}')">👟</div>`;

    return `<div class="shoe-card${shoe.status === 'retired' ? ' retired' : ''}">
      <div class="shoe-card-accent" style="background:${color}"></div>

      <!-- Header row: photo + info + actions -->
      <div style="display:flex;align-items:flex-start;gap:12px;padding-left:8px;margin-bottom:12px">
        ${photoHtml}
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:2px">
            <div class="shoe-name" style="cursor:pointer" onclick="openShoeDetail('${shoe.id}')">${esc(shoe.name)}</div>
            <span class="shoe-status-badge ${shoe.status === 'retired' ? 'shoe-status-retired' : 'shoe-status-active'}">${shoe.status === 'retired' ? 'Retired' : 'Active'}</span>
          </div>
          <div class="shoe-brand">${esc(shoe.brand || '')}${shoe.color ? ' · ' + esc(shoe.color) : ''}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:4px">Last run: ${lastDate ? new Date(lastDate + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' }) : 'Never'}</div>
        </div>
        <!-- Action buttons -->
        <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
          <button onclick="event.stopPropagation();openEditShoe('${shoe.id}')" style="background:var(--surface2);border:1.5px solid var(--border);border-radius:10px;color:var(--text2);font-size:11px;font-weight:700;padding:5px 10px;cursor:pointer;white-space:nowrap">✏️ Edit</button>
          <button onclick="event.stopPropagation();openShoeDetail('${shoe.id}')" style="background:var(--surface2);border:1.5px solid var(--border);border-radius:10px;color:#60a5fa;font-size:11px;font-weight:700;padding:5px 10px;cursor:pointer;white-space:nowrap">📋 Runs</button>
          <button onclick="event.stopPropagation();deleteShoe('${shoe.id}')" style="background:#2d0f0f;border:1.5px solid #7f1d1d;border-radius:10px;color:#f87171;font-size:11px;font-weight:700;padding:5px 10px;cursor:pointer;white-space:nowrap">🗑️ Delete</button>
        </div>
      </div>

      <!-- Mileage bar -->
      <div style="padding-left:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
          <div style="font-size:18px;font-weight:800;color:var(--text)">${miles.toFixed(1)} <span style="font-size:12px;font-weight:600;color:var(--text3)">mi</span></div>
          <div style="font-size:11px;color:var(--text3);font-weight:600">${Math.round(pct * 100)}% · ${miLeft.toFixed(0)} mi left of ${retireMi}</div>
        </div>
        <div class="shoe-mileage-bar-track" style="margin-bottom:10px">
          <div class="shoe-mileage-bar-fill" style="width:${pct * 100}%;background:${barColor}"></div>
        </div>
      </div>

      <!-- Stats grid -->
      <div class="shoe-stats-grid" style="padding-left:8px">
        <div class="shoe-stat"><div class="shoe-stat-val">${shoeRuns.length}</div><div class="shoe-stat-lbl">Runs</div></div>
        <div class="shoe-stat"><div class="shoe-stat-val">${avgPace ? formatPace(avgPace) : '—'}</div><div class="shoe-stat-lbl">Avg Pace</div></div>
        <div class="shoe-stat"><div class="shoe-stat-val">${shoeRuns.length ? (shoeRuns.reduce((s, r) => s + (r.miles || 0), 0) / shoeRuns.length).toFixed(1) : '—'}</div><div class="shoe-stat-lbl">Avg Miles</div></div>
        <div class="shoe-stat"><div class="shoe-stat-val">${miLeft.toFixed(0)}</div><div class="shoe-stat-lbl">Mi Left</div></div>
      </div>
    </div>`;
  }).join('');
}

function openAddShoeModal() {
  document.getElementById('editShoeId').value = '';
  document.getElementById('addShoeTitle').textContent = '👟 Add New Shoe';
  document.getElementById('shoeNameInput').value = '';
  document.getElementById('shoeBrandInput').value = '';
  document.getElementById('shoeStartMiles').value = '0';
  document.getElementById('shoeRetireMiles').value = '400';
  document.getElementById('shoeColorInput').value = '';
  document.getElementById('shoeStatusInput').value = 'active';
  document.getElementById('shoePhotoImg').style.display = 'none';
  document.getElementById('shoePhotoPlaceholder').style.display = 'block';
  document.getElementById('shoeAIStatus').style.display = 'none';
  window._shoePhotoData = null;
  document.getElementById('addShoeModal').classList.add('open');
}

function openEditShoe(shoeId) {
  const shoe = getShoes().find(s => s.id===shoeId);
  if (!shoe) return;
  document.getElementById('editShoeId').value = shoeId;
  document.getElementById('addShoeTitle').textContent = '✏️ Edit Shoe';
  document.getElementById('shoeNameInput').value = shoe.name||'';
  document.getElementById('shoeBrandInput').value = shoe.brand||'';
  document.getElementById('shoeStartMiles').value = shoe.startMiles||0;
  document.getElementById('shoeRetireMiles').value = shoe.retireMiles||400;
  document.getElementById('shoeColorInput').value = shoe.color||'';
  document.getElementById('shoeStatusInput').value = shoe.status||'active';
  const existingPhoto = getShoePhoto(shoeId);
  if (existingPhoto) {
    document.getElementById('shoePhotoImg').src = existingPhoto;
    document.getElementById('shoePhotoImg').style.display = 'block';
    document.getElementById('shoePhotoPlaceholder').style.display = 'none';
  } else {
    document.getElementById('shoePhotoImg').style.display = 'none';
    document.getElementById('shoePhotoPlaceholder').style.display = 'block';
  }
  window._shoePhotoData = existingPhoto;
  document.getElementById('shoeAIStatus').style.display = 'none';
  document.getElementById('addShoeModal').classList.add('open');
}

function saveShoe() {
  try {
    const name = document.getElementById('shoeNameInput').value.trim();
    if (!name) { showToast('⚠️ Enter a shoe name'); return; }
    const editId = document.getElementById('editShoeId').value;
    const shoes  = getShoes();
    const shoeId = editId || String(Date.now());

    // Build shoe record WITHOUT photo embedded — photos stored separately
    const shoeData = {
      id:          shoeId,
      name,
      brand:       document.getElementById('shoeBrandInput').value.trim(),
      startMiles:  parseFloat(document.getElementById('shoeStartMiles').value)||0,
      retireMiles: parseFloat(document.getElementById('shoeRetireMiles').value)||400,
      color:       document.getElementById('shoeColorInput').value.trim() || SHOE_COLORS[shoes.length%SHOE_COLORS.length],
      status:      document.getElementById('shoeStatusInput').value,
      hasPhoto:    !!window._shoePhotoData,
      addedDate:   editId ? (shoes.find(s=>s.id===editId)?.addedDate||todayKey()) : todayKey(),
    };

    // Save photo separately so a quota error there doesn't kill the shoe record
    if (window._shoePhotoData) {
      const photos = getStorage('shoePhotos', {});
      photos[shoeId] = window._shoePhotoData;
      _invalidateShoePhotoCache();
      const photoSaved = setStorage('shoePhotos', photos);
      if (!photoSaved) {
        shoeData.hasPhoto = false;
        showToast('⚠️ Photo too large to save — shoe saved without photo');
      }
    }

    if (editId) {
      const idx = shoes.findIndex(s => s.id === editId);
      if (idx !== -1) shoes[idx] = shoeData;
      else shoes.push(shoeData);
    } else {
      shoes.push(shoeData);
    }

    const saved = setStorage('shoeGarage', shoes);
    if (!saved) {
      showToast('⚠️ Storage full — could not save shoe. Try deleting old data.');
      return;
    }

    document.getElementById('addShoeModal').classList.remove('open');
    renderShoePage();
    showToast(editId ? `✅ ${name} updated!` : `👟 ${name} added to your garage!`);
  } catch(e) {
    console.error('saveShoe error:', e);
    showToast('⚠️ Error saving shoe: ' + e.message);
  }
}

async function handleShoePhoto(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    const dataUrl = e.target.result;
    window._shoePhotoData = dataUrl;
    document.getElementById('shoePhotoImg').src = dataUrl;
    document.getElementById('shoePhotoImg').style.display = 'block';
    document.getElementById('shoePhotoPlaceholder').style.display = 'none';
    const statusEl = document.getElementById('shoeAIStatus');
    statusEl.style.display = 'block';
    statusEl.style.color = 'var(--text2)';
    statusEl.textContent = '🤖 AI identifying your shoe…';
    try {
      const data = await callClaudeAPI({ model:'claude-haiku-4-5-20251001', max_tokens:300, messages:[{ role:'user', content:[
          { type:'image', source:{ type:'base64', media_type:file.type||'image/jpeg', data:dataUrl.split(',')[1] }},
          { type:'text', text:'Identify this running shoe. Reply ONLY with valid JSON, no markdown:\n{"brand":"Nike","model":"Pegasus 40","fullName":"Nike Pegasus 40","confidence":"high"}\nIf unknown, use "Unknown" for brand and model.' }
        ]}]});
      if (data.content) {
        const match = (data.content[0]?.text||'').match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          const fullName = parsed.fullName||`${parsed.brand} ${parsed.model}`;
          statusEl.innerHTML = `✅ Identified: <strong>${esc(fullName)}</strong>`;
          statusEl.style.color = 'var(--green)';
          if (!document.getElementById('shoeNameInput').value) document.getElementById('shoeNameInput').value = fullName;
          if (!document.getElementById('shoeBrandInput').value) document.getElementById('shoeBrandInput').value = parsed.brand||'';
          return;
        }
      }
      statusEl.textContent = '⚠️ Could not identify — enter details manually';
      statusEl.style.color = 'var(--amber)';
    } catch(e) { statusEl.textContent = '⚠️ AI unavailable — enter manually'; statusEl.style.color = 'var(--amber)'; }
  };
  reader.readAsDataURL(file);
}

// ── Update shoe reference photo from shoe detail ──────────────
async function updateShoePhoto(shoeId, input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    const dataUrl = e.target.result;
    // Resize to reduce storage footprint
    const resized = await resizeImage(dataUrl, 800);
    const photos = getStorage('shoePhotos', {});
    photos[shoeId] = resized;
    _invalidateShoePhotoCache();
    const saved = setStorage('shoePhotos', photos);
    if (!saved) { showToast('⚠️ Photo too large — try a smaller image'); return; }
    // Mark shoe as having photo
    const shoes = getShoes();
    const idx = shoes.findIndex(s => s.id === shoeId);
    if (idx !== -1) { shoes[idx].hasPhoto = true; setStorage('shoeGarage', shoes); }
    showToast('📸 Reference photo saved!');
    // Re-render detail in place
    if (_shoeDetailOpenId === shoeId) _renderShoeDetail(shoeId);
    renderShoePage();
  };
  reader.readAsDataURL(file);
}

// ── Resize image helper (returns base64 dataUrl) ─────────────
function resizeImage(dataUrl, maxSize) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const w = Math.round(img.width  * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.src = dataUrl;
  });
}

// ── AI shoe photo matching ────────────────────────────────────
// Called from the assign run modal — user takes/uploads a photo of
// their feet/shoes and we compare against all reference photos.
async function matchShoeFromPhoto(input) {
  const file = input.files[0];
  if (!file) return;

  const statusEl = document.getElementById('shoeMatchStatus');
  statusEl.style.display = 'block';
  statusEl.style.color   = 'var(--text2)';
  statusEl.textContent   = '🤖 Analysing photo…';

  const reader = new FileReader();
  reader.onload = async (e) => {
    const runPhotoB64 = e.target.result.split(',')[1];
    const runMediaType = file.type || 'image/jpeg';

    const shoes = getShoes().filter(s => s.status === 'active');
    const shoesWithPhotos = shoes.filter(s => s.hasPhoto && getShoePhoto(s.id));

    // Build the prompt
    // Strategy: send the run photo + embed each reference shoe photo inline
    // and ask Claude to rank by visual similarity
    let promptText = `A runner just took this photo of the shoes they are currently wearing after a run.
Compare it against the following reference shoe photos from their closet and identify which pair they are wearing.

Closet shoes:\n`;
    const refImages = [];
    shoesWithPhotos.forEach((shoe, i) => {
      const photoData = getShoePhoto(shoe.id);
      const b64 = photoData.split(',')[1];
      const mt  = 'image/jpeg';
      promptText += `${i+1}. ID: ${shoe.id} | Name: "${shoe.name}" | Brand: ${shoe.brand||'unknown'}\n`;
      refImages.push({ type:'image', source:{ type:'base64', media_type:mt, data:b64 }});
      refImages.push({ type:'text', text:`(Reference photo for shoe ${i+1}: ${shoe.name})`});
    });

    if (shoesWithPhotos.length === 0) {
      // No reference photos — fall back to plain identification
      promptText = `Identify the running shoes in this photo. Reply ONLY with JSON:\n{"brand":"Nike","model":"Pegasus 40","confidence":"high","notes":""}`;
    } else {
      promptText += `\nNow here is the photo of the shoes the runner just wore (the LAST image).\n\nReply ONLY with valid JSON, no markdown:\n{"matchedId":"<shoe_id or null>","matchedName":"<name or Unknown>","confidence":"high|medium|low","reasoning":"<1 sentence>"}\n\nIf none of the reference photos match well, set matchedId to null.`;
    }

    const contentArr = [
      ...refImages,
      { type:'image', source:{ type:'base64', media_type:runMediaType, data:runPhotoB64 }},
      { type:'text', text: promptText }
    ];

    try {
      const data = await callClaudeAPI({
        model: 'claude-opus-4-7',
        max_tokens: 400,
        messages:[{ role:'user', content: contentArr }]
      });

      if (!data.content) throw new Error('API error');
      const raw  = data.content?.[0]?.text || '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');
      const parsed = JSON.parse(jsonMatch[0]);

      // Highlight the matched shoe in the list
      if (parsed.matchedId) {
        const confColor = parsed.confidence === 'high' ? '#22c55e' : parsed.confidence === 'medium' ? '#f59e0b' : '#94a3b8';
        const confEmoji = parsed.confidence === 'high' ? '✅' : parsed.confidence === 'medium' ? '⚠️' : '❓';
        statusEl.style.color = confColor;
        statusEl.innerHTML   = `${confEmoji} <strong>${esc(parsed.matchedName)}</strong> — ${esc(parsed.confidence)} confidence<br><span style="font-size:10px;opacity:0.8">${esc(parsed.reasoning||'')}</span>`;
        // Visually highlight the matched button and auto-scroll to it
        document.querySelectorAll('.assign-shoe-btn').forEach(btn => {
          btn.style.border = '';
          btn.style.background = '';
        });
        // Find the button for this shoe and highlight it
        const btns = document.querySelectorAll('.assign-shoe-btn');
        btns.forEach(btn => {
          if (btn.getAttribute('onclick') && btn.getAttribute('onclick').includes(parsed.matchedId)) {
            btn.style.border = `2px solid ${confColor}`;
            btn.style.background = confColor === '#22c55e' ? 'rgba(34,197,94,0.08)' : 'rgba(245,158,11,0.08)';
            btn.scrollIntoView({ behavior:'smooth', block:'nearest' });
            // Add a "Best Match" badge
            if (!btn.querySelector('.match-badge')) {
              const badge = document.createElement('div');
              badge.className = 'match-badge';
              badge.style.cssText = `position:absolute;top:-8px;right:8px;background:${confColor};color:#000;font-size:9px;font-weight:800;padding:2px 7px;border-radius:8px;letter-spacing:0.5px`;
              badge.textContent  = `${confEmoji} ${parsed.confidence.toUpperCase()} MATCH`;
              btn.style.position = 'relative';
              btn.appendChild(badge);
            }
          }
        });
      } else {
        statusEl.style.color = 'var(--amber)';
        statusEl.textContent = `❓ Couldn't match — ${parsed.reasoning || 'please select manually'}`;
      }
    } catch(err) {
      statusEl.style.color  = 'var(--amber)';
      statusEl.textContent  = '⚠️ AI matching failed — please pick manually';
      console.error('matchShoeFromPhoto:', err);
    }
  };
  reader.readAsDataURL(file);
}

function promptShoeAssignment(runData) {
  const shoes = getShoes().filter(s => s.status==='active');
  if (!shoes.length) return;
  // Check by activityId OR by date — don't re-prompt if already assigned today
  const existing = getShoeRuns().find(r =>
    (r.activityId && runData.activityId && r.activityId === runData.activityId) ||
    (r.date === (runData.date || todayKey()))
  );
  if (existing) return;
  const modal = document.getElementById('assignRunModal');
  document.getElementById('assignRunData').value = JSON.stringify(runData);
  document.getElementById('assignRunDetails').textContent = `${runData.miles.toFixed(2)} mi · ${Math.round(runData.duration/60)}m · ${runData.date}`;
  // Reset match UI
  const matchStatus = document.getElementById('shoeMatchStatus');
  if (matchStatus) { matchStatus.style.display = 'none'; matchStatus.textContent = ''; }
  // Hide photo section if no shoes have reference photos
  const shoesWithPhotos = getShoes().filter(s => s.status==='active' && s.hasPhoto);
  const photoSection = document.getElementById('shoePhotoMatchSection');
  if (photoSection) photoSection.style.display = shoesWithPhotos.length > 0 ? 'block' : 'none';
  const _assignRuns = getShoeRuns(); // read once, reuse in map
  document.getElementById('assignShoeList').innerHTML = shoes.map(shoe => {
    const miles = shoeCurrentMiles(shoe.id, _assignRuns);
    const imgHtml = shoe.hasPhoto ? `<img src="${getShoePhoto(shoe.id)}" style="width:40px;height:40px;border-radius:10px;object-fit:cover;flex-shrink:0"/>` : `<div class="assign-shoe-avatar">👟</div>`;
    return `<button class="assign-shoe-btn" onclick="assignRunToShoe('${shoe.id}')">
      ${imgHtml}
      <div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:700;color:var(--text)">${esc(shoe.name)}</div><div style="font-size:11px;color:var(--text3);margin-top:2px">${esc(shoe.brand||'')} · ${miles.toFixed(1)} mi so far</div></div>
      <div style="font-size:12px;color:var(--text3);font-weight:600">${(shoe.retireMiles||400)-miles>0?((shoe.retireMiles||400)-miles).toFixed(0)+' mi left':'⚠️ Retire'}</div>
    </button>`;
  }).join('') + `<button class="assign-shoe-btn" onclick="assignRunToNewShoe()" style="border-style:dashed"><div class="assign-shoe-avatar" style="font-size:24px">+</div><div style="font-size:14px;font-weight:700;color:var(--text2)">Add a new pair first</div></button>`;
  modal.classList.add('open');
}

function assignRunToShoe(shoeId) {
  const runData = JSON.parse(document.getElementById('assignRunData').value||'{}');
  if (!runData.miles) return;
  const runs = getShoeRuns();
  runs.push({ id:String(Date.now()), shoeId, date:runData.date||todayKey(), miles:runData.miles, duration:runData.duration||0, calories:runData.calories||0, activityId:runData.activityId||null });
  setShoeRuns(runs);
  document.getElementById('assignRunModal').classList.remove('open');
  renderShoePage();
  const shoe = getShoes().find(s=>s.id===shoeId);
  const newTotal = shoeCurrentMiles(shoeId, runs);
  showToast(`👟 ${runData.miles.toFixed(2)} mi logged to ${shoe?.name||'shoe'}! (${newTotal.toFixed(1)} mi total)`);
  const retireMi = shoe?.retireMiles||400;
  if (newTotal >= retireMi*0.9 && newTotal < retireMi) setTimeout(()=>showToast(`⚠️ ${shoe?.name} is at ${Math.round(newTotal/retireMi*100)}% — retirement approaching!`), 2000);
  else if (newTotal >= retireMi) setTimeout(()=>showToast(`🚨 ${shoe?.name} has hit ${newTotal.toFixed(0)} mi — time to retire!`), 2000);
}

function assignRunToNewShoe() {
  document.getElementById('assignRunModal').classList.remove('open');
  const shoesBtn = document.querySelector('.tab-btn[onclick*="shoes"]');
  if (shoesBtn) switchTab('shoes', shoesBtn);
  setTimeout(()=>openAddShoeModal(), 300);
}

// Track which shoe detail is open for refreshing
let _shoeDetailOpenId = null;

function openShoeDetail(shoeId) {
  _shoeDetailOpenId = shoeId;
  _renderShoeDetail(shoeId);
  document.getElementById('shoeDetailModal').classList.add('open');
}

function _renderShoeDetail(shoeId) {
  const shoe      = getShoes().find(s => s.id === shoeId);
  if (!shoe) return;
  const allRuns   = getShoeRuns();
  const runs      = allRuns.filter(r => r.shoeId === shoeId).sort((a,b) => b.date.localeCompare(a.date));
  const miles     = shoeCurrentMiles(shoeId, allRuns);
  const retireMi  = shoe.retireMiles || 400;
  const pct       = Math.min(miles / retireMi, 1);
  const barColor  = pct > 0.9 ? '#ef4444' : pct > 0.7 ? '#f59e0b' : '#22c55e';
  const avgPace   = shoeAvgPace(shoeId, allRuns);
  const totalMins = runs.reduce((s,r) => s + (r.duration||0) / 60, 0);

  const photoSrc = getShoePhoto(shoeId);
  const imgHtml = photoSrc
    ? `<div style="position:relative;border-radius:14px;overflow:hidden;margin-bottom:10px">
        <img src="${photoSrc}" style="width:100%;max-height:180px;object-fit:cover;display:block"/>
       </div>
       <div style="display:flex;gap:8px;margin-bottom:14px">
         <label style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:9px;background:var(--surface2);border:1.5px solid var(--border);border-radius:12px;font-size:11px;font-weight:700;color:var(--text2);cursor:pointer">
           📷 Take Photo<input type="file" accept="image/*" capture="environment" style="display:none" onchange="updateShoePhoto('${shoeId}',this)"/>
         </label>
         <label style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:9px;background:var(--surface2);border:1.5px solid var(--border);border-radius:12px;font-size:11px;font-weight:700;color:var(--text2);cursor:pointer">
           🖼️ Choose Photo<input type="file" accept="image/*" style="display:none" onchange="updateShoePhoto('${shoeId}',this)"/>
         </label>
       </div>`
    : `<div style="display:flex;gap:8px;margin-bottom:14px">
         <label style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:16px;background:linear-gradient(135deg,#0f172a,#1e293b);border:1.5px dashed #334155;border-radius:14px;font-size:11px;font-weight:700;color:#475569;cursor:pointer">
           <span style="font-size:24px">📷</span>Take Photo<input type="file" accept="image/*" capture="environment" style="display:none" onchange="updateShoePhoto('${shoeId}',this)"/>
         </label>
         <label style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:16px;background:linear-gradient(135deg,#0f172a,#1e293b);border:1.5px dashed #334155;border-radius:14px;font-size:11px;font-weight:700;color:#475569;cursor:pointer">
           <span style="font-size:24px">🖼️</span>Choose Photo<input type="file" accept="image/*" style="display:none" onchange="updateShoePhoto('${shoeId}',this)"/>
         </label>
       </div>`;

  const runsHtml = !runs.length
    ? `<div style="text-align:center;color:var(--text3);padding:24px;font-size:13px">No runs logged yet</div>`
    : runs.map(r => {
        const pace    = (r.duration && r.miles) ? formatPace(r.duration / 60 / r.miles) : '';
        const durStr  = r.duration ? Math.round(r.duration / 60) + 'm' : '';
        const calStr  = r.calories ? r.calories + ' kcal' : '';
        const meta    = [durStr, calStr, pace ? pace + '/mi' : ''].filter(Boolean).join(' · ');
        // Full date display
        const d = new Date(r.date + 'T12:00:00');
        const dateStr = d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
        return `<div class="shoe-run-row" id="runrow-${r.id}" style="flex-direction:column;align-items:stretch;gap:0;padding:0">
          <!-- Main run row -->
          <div style="display:flex;align-items:center;gap:10px;padding:10px 0">
            <div style="min-width:76px">
              <div style="font-size:12px;font-weight:700;color:var(--text3)">${dateStr}</div>
            </div>
            <div class="shoe-run-info" style="flex:1">
              <div class="shoe-run-mi">${(r.miles||0).toFixed(2)} mi</div>
              ${meta ? `<div class="shoe-run-meta">${meta}</div>` : ''}
            </div>
            <button onclick="toggleRunEdit('${r.id}')" style="background:#0d1e3d;border:1px solid #1e3a5f;border-radius:8px;color:#60a5fa;font-size:11px;font-weight:700;padding:5px 10px;cursor:pointer;flex-shrink:0">✏️</button>
            <button onclick="deleteShoeRun('${r.id}','${shoeId}')" style="background:#2d0f0f;border:1px solid #7f1d1d;border-radius:8px;color:#f87171;font-size:11px;font-weight:700;padding:5px 10px;cursor:pointer;flex-shrink:0">🗑️</button>
          </div>
          <!-- Inline edit form (hidden by default) -->
          <div id="runedit-${r.id}" style="display:none;background:var(--surface2);border-radius:12px;padding:12px;margin-bottom:10px;border:1.5px solid var(--border)">
            <div style="font-size:11px;font-weight:700;color:var(--text2);letter-spacing:1px;text-transform:uppercase;margin-bottom:10px">Edit Run</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
              <div>
                <div style="font-size:10px;color:var(--text3);font-weight:700;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px">Date</div>
                <input type="date" id="re-date-${r.id}" value="${r.date}"
                  style="width:100%;padding:8px 10px;background:var(--surface);border:1.5px solid var(--border);border-radius:10px;color:var(--text);font-family:inherit;font-size:13px;font-weight:600"/>
              </div>
              <div>
                <div style="font-size:10px;color:var(--text3);font-weight:700;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px">Miles</div>
                <input type="number" step="0.01" id="re-miles-${r.id}" value="${(r.miles||0).toFixed(2)}"
                  style="width:100%;padding:8px 10px;background:var(--surface);border:1.5px solid var(--border);border-radius:10px;color:var(--text);font-family:inherit;font-size:13px;font-weight:700"/>
              </div>
              <div>
                <div style="font-size:10px;color:var(--text3);font-weight:700;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px">Duration (min)</div>
                <input type="number" step="1" id="re-dur-${r.id}" value="${r.duration ? Math.round(r.duration/60) : ''}" placeholder="—"
                  style="width:100%;padding:8px 10px;background:var(--surface);border:1.5px solid var(--border);border-radius:10px;color:var(--text);font-family:inherit;font-size:13px;font-weight:700"/>
              </div>
              <div>
                <div style="font-size:10px;color:var(--text3);font-weight:700;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px">Calories</div>
                <input type="number" step="1" id="re-cal-${r.id}" value="${r.calories || ''}" placeholder="—"
                  style="width:100%;padding:8px 10px;background:var(--surface);border:1.5px solid var(--border);border-radius:10px;color:var(--text);font-family:inherit;font-size:13px;font-weight:700"/>
              </div>
            </div>
            <div style="display:flex;gap:8px">
              <button onclick="saveRunEdit('${r.id}','${shoeId}')"
                style="flex:1;padding:9px;background:var(--green-soft);border:1.5px solid #166534;border-radius:10px;color:#22c55e;font-family:inherit;font-size:12px;font-weight:800;cursor:pointer">Save Changes</button>
              <button onclick="toggleRunEdit('${r.id}')"
                style="padding:9px 14px;background:var(--surface);border:1.5px solid var(--border);border-radius:10px;color:var(--text2);font-family:inherit;font-size:12px;font-weight:700;cursor:pointer">Cancel</button>
            </div>
          </div>
        </div>`;
      }).join('');

  document.getElementById('shoeDetailContent').innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:4px">
      <div>
        <div class="modal-title" style="margin-bottom:2px">${esc(shoe.name)}</div>
        <div style="font-size:12px;color:var(--text3);font-weight:600">${esc(shoe.brand||'')}${shoe.color?' · '+esc(shoe.color):''}</div>
      </div>
      <button onclick="editShoeMileage('${shoeId}',${miles.toFixed(2)})" style="background:#0d1e3d;border:1px solid #1e3a5f;border-radius:8px;color:#60a5fa;font-size:11px;font-weight:700;padding:5px 11px;cursor:pointer;flex-shrink:0;margin-top:4px">✏️ Adjust Miles</button>
    </div>
    <div style="margin-bottom:14px"></div>
    ${imgHtml}
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <div style="font-size:22px;font-weight:800;color:var(--text)">${miles.toFixed(1)} <span style="font-size:14px;font-weight:600;color:var(--text3)">mi total</span></div>
      <div style="font-size:12px;color:var(--text3);font-weight:600">${Math.round(pct*100)}% of ${retireMi} mi</div>
    </div>
    <div class="shoe-mileage-bar-track" style="margin-bottom:14px">
      <div class="shoe-mileage-bar-fill" style="width:${pct*100}%;background:${barColor}"></div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:20px">
      <div class="shoe-stat"><div class="shoe-stat-val">${runs.length}</div><div class="shoe-stat-lbl">Runs</div></div>
      <div class="shoe-stat"><div class="shoe-stat-val">${avgPace ? formatPace(avgPace) : '—'}</div><div class="shoe-stat-lbl">Avg Pace</div></div>
      <div class="shoe-stat"><div class="shoe-stat-val">${totalMins >= 60 ? Math.floor(totalMins/60)+'h '+Math.round(totalMins%60)+'m' : Math.round(totalMins)+'m'}</div><div class="shoe-stat-lbl">Time</div></div>
      <div class="shoe-stat"><div class="shoe-stat-val">${Math.max(0, retireMi - miles).toFixed(0)}</div><div class="shoe-stat-lbl">Mi Left</div></div>
    </div>
    <div style="font-size:11px;font-weight:700;color:var(--text2);letter-spacing:1px;text-transform:uppercase;margin-bottom:10px">
      Run History <span style="color:var(--text3);font-weight:600">(${runs.length})</span>
    </div>
    <div id="shoeRunList">${runsHtml}</div>`;
}

function toggleRunEdit(runId) {
  const el = document.getElementById(`runedit-${runId}`);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function saveRunEdit(runId, shoeId) {
  const dateVal  = document.getElementById(`re-date-${runId}`)?.value;
  const milesVal = parseFloat(document.getElementById(`re-miles-${runId}`)?.value);
  const durVal   = parseFloat(document.getElementById(`re-dur-${runId}`)?.value);
  const calVal   = parseInt(document.getElementById(`re-cal-${runId}`)?.value);

  if (!dateVal || isNaN(milesVal) || milesVal <= 0) {
    showToast('⚠️ Date and miles are required');
    return;
  }

  const runs = getShoeRuns();
  const run  = runs.find(r => r.id === runId);
  if (!run) return;

  run.date     = dateVal;
  run.miles    = Math.round(milesVal * 100) / 100;
  run.duration = !isNaN(durVal) && durVal > 0 ? durVal * 60 : (run.duration || 0);
  run.calories = !isNaN(calVal) && calVal > 0 ? calVal : (run.calories || 0);

  setShoeRuns(runs);
  renderShoePage();
  _renderShoeDetail(shoeId); // refresh detail in-place
  showToast('✅ Run updated');
}

function deleteShoeRun(runId, shoeId) {
  const runs = getShoeRuns();
  const run  = runs.find(r => r.id === runId);
  const mi   = run ? (run.miles||0).toFixed(2) : '';
  if (!confirm(`Delete this run (${mi} mi)?`)) return;
  setShoeRuns(runs.filter(r => r.id !== runId));
  renderShoePage();
  _renderShoeDetail(shoeId); // refresh detail in-place, keep modal open
  showToast('🗑️ Run deleted');
}

function deleteShoe(shoeId) {
  const shoes = getShoes();
  const runs  = getShoeRuns();
  const shoe  = shoes.find(s => s.id === shoeId);
  if (!shoe) return;
  const runCount = runs.filter(r => r.shoeId === shoeId).length;
  if (!confirm(`Delete "${shoe.name}"? This will also remove all ${runCount} runs logged to it.`)) return;
  setShoes(shoes.filter(s => s.id !== shoeId));
  setShoeRuns(runs.filter(r => r.shoeId !== shoeId));
  renderShoePage();
  showToast(`🗑️ ${shoe.name} deleted`);
}

function editShoeMileage(shoeId, currentMiles) {
  const input = prompt(
    `Current total mileage: ${parseFloat(currentMiles).toFixed(1)} mi\n\nEnter the correct total mileage:`,
    parseFloat(currentMiles).toFixed(1)
  );
  if (input === null) return; // cancelled
  const newTotal = parseFloat(input);
  if (isNaN(newTotal) || newTotal < 0) {
    alert('Please enter a valid number of miles (0 or more).');
    return;
  }
  const shoes = getShoes();
  const shoe  = shoes.find(s => s.id === shoeId);
  if (!shoe) return;
  // Compute how many miles came from runs + startMiles (excluding existing offset)
  const runMiles = getShoeRuns().filter(r => r.shoeId === shoeId).reduce((s,r) => s+(r.miles||0), 0);
  const baseMiles = runMiles + (shoe.startMiles || 0);
  shoe.mileageOffset = Math.round((newTotal - baseMiles) * 100) / 100;
  setShoes(shoes);
  document.getElementById('shoeDetailModal').classList.remove('open');
  renderShoePage();
  showToast(`✅ Mileage updated to ${newTotal.toFixed(1)} mi`);
}

function onStravaRunSynced(runData) {
  if (!getShoes().filter(s=>s.status==='active').length) return;
  const existing = getShoeRuns().find(r=>r.activityId && r.activityId===runData.activityId);
  if (existing) return;
  promptShoeAssignment(runData);
}

// ═══════════════════════════════════════════════════════
// ── HISTORY SUB-TABS ──────────────────────────────────
// ═══════════════════════════════════════════════════════

function switchHistoryTab(tab) {
  ['lift','blood','nutr','trends','whoop'].forEach(t => {
    const el = document.getElementById('historyTab-'+t);
    const btn = document.getElementById('htab-'+t);
    if (el) el.style.display = t === tab ? '' : 'none';
    if (btn) btn.classList.toggle('htab-active', t === tab);
  });
  if (tab === 'lift')   renderHistoryPage();
  if (tab === 'blood')  renderBloodWorkPage();
  if (tab === 'nutr')   renderNutritionReport(7);
  if (tab === 'trends') { renderTrendChart(); safeCall(renderInsights, 'renderInsights'); }
  if (tab === 'whoop')  renderWhoopDashboard();
}

// ═══════════════════════════════════════════════════════
// ── WHOOP INTEGRATION ──────────────────────────────────
// ═══════════════════════════════════════════════════════

// ── Storage helpers ──
function getWhoopData() { return getStorage('whoopData', null); }
function setWhoopData(d) { setStorage('whoopData', d); }

// ── ZIP Parser — reads WHOOP export ZIP client-side ──
async function handleWhoopUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const statusEl = document.getElementById('whoopUploadStatus');
  const progressEl = document.getElementById('whoopParseProgress');
  statusEl.textContent = 'Reading ZIP…';
  progressEl.style.display = 'block';
  progressEl.textContent = '⏳ Loading JSZip…';

  try {
    // Load JSZip dynamically
    if (!window.JSZip) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }

    progressEl.textContent = '📦 Extracting ZIP…';
    const arrayBuffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);

    // Find the CSVs — they may be nested in a folder
    const findFile = name => {
      const keys = Object.keys(zip.files);
      const key = keys.find(k => k.endsWith(name));
      return key ? zip.files[key] : null;
    };

    const cyclesFile   = findFile('physiological_cycles.csv');
    const sleepsFile   = findFile('sleeps.csv');
    const workoutsFile = findFile('workouts.csv');

    if (!cyclesFile || !sleepsFile || !workoutsFile) {
      progressEl.textContent = '❌ Missing CSVs. Expected: physiological_cycles.csv, sleeps.csv, workouts.csv';
      return;
    }

    progressEl.textContent = '📊 Parsing cycles…';
    const cyclesCSV   = await cyclesFile.async('text');
    const sleepsCSV   = await sleepsFile.async('text');
    const workoutsCSV = await workoutsFile.async('text');

    progressEl.textContent = '🔢 Processing data…';
    const data = parseWhoopCSVs(cyclesCSV, sleepsCSV, workoutsCSV);

    setWhoopData(data);
    progressEl.textContent = `✅ Imported ${data.cycles.length} days, ${data.sleeps.length} sleeps, ${data.workouts.length} workouts`;
    statusEl.textContent = `Last import: ${new Date().toLocaleDateString()}`;
    document.getElementById('whoopDropZone').style.borderColor = '#7c3aed';

    setTimeout(renderWhoopDashboard, 300);
  } catch(e) {
    progressEl.textContent = '❌ Error: ' + e.message;
    console.error('WHOOP upload error:', e);
  }
}

// ── Parse CSV text into array of objects ──
function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g,''));
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g,''));
    const obj = {};
    headers.forEach((h,i) => obj[h] = vals[i] || '');
    return obj;
  }).filter(r => r[headers[0]]);
}

// ── Parse and normalize all three CSVs ──
function parseWhoopCSVs(cyclesCSV, sleepsCSV, workoutsCSV) {
  const rawCycles   = parseCSV(cyclesCSV);
  const rawSleeps   = parseCSV(sleepsCSV);
  const rawWorkouts = parseCSV(workoutsCSV);

  const num = (v, fallback=null) => { const n = parseFloat(v); return isNaN(n) ? fallback : n; };
  const dateStr = v => v ? v.slice(0,10) : null;

  const cycles = rawCycles.map(r => ({
    date:        dateStr(r['Cycle start time']),
    recovery:    num(r['Recovery score %']),
    hrv:         num(r['Heart rate variability (ms)']),
    rhr:         num(r['Resting heart rate (bpm)']),
    skinTemp:    num(r['Skin temp (celsius)']),
    spo2:        num(r['Blood oxygen %']),
    strain:      num(r['Day Strain']),
    calories:    num(r['Energy burned (cal)']),
    sleepPerf:   num(r['Sleep performance %']),
    deepMin:     num(r['Deep (SWS) duration (min)']),
    remMin:      num(r['REM duration (min)']),
    lightMin:    num(r['Light sleep duration (min)']),
    asleepMin:   num(r['Asleep duration (min)']),
    awakeMin:    num(r['Awake duration (min)']),
    sleepDebt:   num(r['Sleep debt (min)']),
    respRate:    num(r['Respiratory rate (rpm)']),
    sleepConsistency: num(r['Sleep consistency %']),
  })).filter(r => r.date && r.recovery !== null);

  const sleeps = rawSleeps.filter(r => r['Nap']?.toLowerCase() !== 'true').map(r => ({
    date:      dateStr(r['Sleep onset']),
    onset:     r['Sleep onset'],
    wake:      r['Wake onset'],
    perf:      num(r['Sleep performance %']),
    asleepMin: num(r['Asleep duration (min)']),
    deepMin:   num(r['Deep (SWS) duration (min)']),
    remMin:    num(r['REM duration (min)']),
    lightMin:  num(r['Light sleep duration (min)']),
    debt:      num(r['Sleep debt (min)']),
    respRate:  num(r['Respiratory rate (rpm)']),
    efficiency: num(r['Sleep efficiency %']),
    consistency: num(r['Sleep consistency %']),
    isNap:     false,
  })).filter(r => r.date && r.asleepMin);

  const workouts = rawWorkouts.map(r => ({
    date:     dateStr(r['Workout start time']),
    activity: r['Activity name'],
    strain:   num(r['Activity Strain']),
    calories: num(r['Energy burned (cal)']),
    duration: num(r['Duration (min)']),
    maxHR:    num(r['Max HR (bpm)']),
    avgHR:    num(r['Average HR (bpm)']),
    z1: num(r['HR Zone 1 %']), z2: num(r['HR Zone 2 %']),
    z3: num(r['HR Zone 3 %']), z4: num(r['HR Zone 4 %']),
    z5: num(r['HR Zone 5 %']),
  })).filter(r => r.date && r.activity);

  return { cycles, sleeps, workouts, importedAt: Date.now() };
}

// ── Main render function ──
function renderWhoopDashboard() {
  const data = getWhoopData();
  const uploadCard = document.getElementById('whoopUploadCard');
  const dashboard  = document.getElementById('whoopDashboard');
  if (!dashboard) return;

  if (!data || !data.cycles?.length) {
    uploadCard.style.display = 'block';
    dashboard.style.display  = 'none';
    return;
  }

  uploadCard.style.display = 'block'; // keep upload available for re-import
  dashboard.style.display  = 'block';

  renderWhoopToday(data);
  renderWhoopSparklines(data);
  renderWhoopSleep(data);
  renderWhoopWorkouts(data);
}

// ── Helper: average ──
function wavg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function wrecoveryColor(r) {
  if (r >= 67) return { bg:'#052e1e', border:'#16a34a', text:'#22c55e' };
  if (r >= 34) return { bg:'#2d2005', border:'#ca8a04', text:'#eab308' };
  return { bg:'#2a0a0a', border:'#dc2626', text:'#ef4444' };
}
function wrecoveryEmoji(r) { return r>=67 ? '🟢' : r>=34 ? '🟡' : '🔴'; }

// ── Today's Status card ──
function renderWhoopToday(data) {
  const el = document.getElementById('whoopTodayCard');
  if (!el) return;
  const today = data.cycles[0]; // most recent
  const c = wrecoveryColor(today.recovery || 0);
  const rec = today.recovery || 0;
  const hrv = today.hrv || 0;
  const rhr = today.rhr || 0;
  const strain = today.strain || 0;
  const sleepDebt = today.sleepDebt || 0;
  const spo2 = today.spo2 || 0;

  // 30-day baselines
  const last30 = data.cycles.slice(0,30);
  const avgHRV = wavg(last30.map(r=>r.hrv).filter(Boolean));
  const avgRHR = wavg(last30.map(r=>r.rhr).filter(Boolean));

  el.innerHTML = `
    <div style="font-size:11px;font-weight:700;color:#a78bfa;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px">💍 Today's Recovery Status · ${today.date}</div>
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px">
      <div style="width:80px;height:80px;border-radius:50%;background:${c.bg};border:3px solid ${c.border};display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0">
        <div style="font-size:22px;font-weight:900;color:${c.text}">${rec}%</div>
        <div style="font-size:9px;color:${c.text};font-weight:700;text-transform:uppercase">Recovery</div>
      </div>
      <div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${wStatTile('HRV', hrv + 'ms', hrv >= avgHRV ? '↑' : '↓', hrv >= avgHRV ? '#22c55e' : '#f59e0b', `avg ${avgHRV.toFixed(0)}ms`)}
        ${wStatTile('RHR', rhr + ' bpm', rhr <= avgRHR ? '↓' : '↑', rhr <= avgRHR ? '#22c55e' : '#f59e0b', `avg ${avgRHR.toFixed(0)}bpm`)}
        ${wStatTile('Strain', strain.toFixed(1), '', '#3b82f6', 'day strain')}
        ${wStatTile('SpO2', spo2 ? spo2.toFixed(1)+'%' : '--', '', spo2>=95?'#22c55e':'#f59e0b', 'blood O₂')}
      </div>
    </div>
    ${sleepDebt > 0 ? `<div style="background:#1c1008;border:1px solid #78350f;border-radius:10px;padding:8px 12px;font-size:12px;color:#f59e0b;font-weight:600">⚠️ Sleep debt: ${(sleepDebt/60).toFixed(1)}h behind — prioritize sleep tonight</div>` : '<div style="background:#052e1e;border:1px solid #166534;border-radius:10px;padding:8px 12px;font-size:12px;color:#22c55e;font-weight:600">✅ No significant sleep debt</div>'}`;
}

function wStatTile(label, val, arrow, color, sub) {
  return `<div style="background:var(--surface2);border-radius:10px;padding:8px 10px">
    <div style="font-size:11px;color:var(--text3);font-weight:600;margin-bottom:2px">${label}</div>
    <div style="font-size:16px;font-weight:800;color:${color}">${arrow} ${val}</div>
    <div style="font-size:10px;color:var(--text3)">${sub}</div>
  </div>`;
}

// ── 7-day sparkline tiles ──
function renderWhoopSparklines(data) {
  const el = document.getElementById('whoopSparkRow');
  if (!el) return;
  const days = data.cycles.slice(0,14).reverse(); // oldest→newest for chart

  const metrics = [
    { key:'recovery', label:'Recovery', unit:'%', color:'#a78bfa' },
    { key:'hrv',      label:'HRV',      unit:'ms', color:'#22c55e' },
    { key:'strain',   label:'Strain',   unit:'',  color:'#3b82f6' },
    { key:'sleepPerf',label:'Sleep',    unit:'%', color:'#f59e0b' },
  ];

  el.innerHTML = metrics.map(m => {
    const vals = days.map(d => d[m.key] || 0);
    const max  = Math.max(...vals) || 1;
    const latest = data.cycles[0][m.key] || 0;
    const sparkBars = vals.map(v => {
      const h = Math.max(4, Math.round((v/max)*36));
      const fill = m.key==='recovery' ? wrecoveryColor(v).text : m.color;
      return `<div style="width:10px;height:${h}px;background:${fill};border-radius:2px;align-self:flex-end;opacity:0.85"></div>`;
    }).join('');
    return `<div class="card" style="padding:12px 14px">
      <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">${m.label} (14d)</div>
      <div style="font-size:20px;font-weight:900;color:${m.key==='recovery'?wrecoveryColor(latest).text:m.color};margin-bottom:8px">${typeof latest==='number'?latest.toFixed(m.key==='hrv'?0:1):latest}${m.unit}</div>
      <div style="display:flex;gap:3px;align-items:flex-end;height:40px">${sparkBars}</div>
    </div>`;
  }).join('');
}

// ── Sleep breakdown ──
function renderWhoopSleep(data) {
  const el = document.getElementById('whoopSleepCard');
  if (!el) return;
  const recent = data.sleeps.slice(0,30).filter(s=>s.asleepMin);
  if (!recent.length) { el.innerHTML='<div style="color:var(--text3);font-size:13px">No sleep data</div>'; return; }

  const avgAsleep = wavg(recent.map(s=>s.asleepMin));
  const avgDeep   = wavg(recent.map(s=>s.deepMin||0));
  const avgREM    = wavg(recent.map(s=>s.remMin||0));
  const avgLight  = wavg(recent.map(s=>s.lightMin||0));
  const avgPerf   = wavg(recent.map(s=>s.perf||0));
  const avgDebt   = wavg(recent.map(s=>s.debt||0));
  const avgResp   = wavg(recent.map(s=>s.respRate||0));

  // Recent 7 nights mini table
  const nights = data.sleeps.slice(0,7).map(s => {
    const emoji = s.perf>=85?'🟢':s.perf>=65?'🟡':'🔴';
    const hrs = s.asleepMin ? (s.asleepMin/60).toFixed(1) : '--';
    const deep = s.deepMin ? Math.round(s.deepMin) : '--';
    const rem  = s.remMin  ? Math.round(s.remMin)  : '--';
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">
      <span style="color:var(--text3);width:80px">${s.date}</span>
      <span>${emoji} ${s.perf||'--'}%</span>
      <span style="color:var(--text2)">${hrs}h</span>
      <span style="color:#3b82f6">💤${deep}m</span>
      <span style="color:#8b5cf6">🌙${rem}m</span>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div style="font-size:11px;font-weight:700;color:#f59e0b;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px">😴 Sleep Quality · 30-Day Average</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px">
      ${wBigStat((avgAsleep/60).toFixed(1)+'h', 'Avg Sleep', '#e2e8f0')}
      ${wBigStat(avgPerf.toFixed(0)+'%', 'Performance', avgPerf>=80?'#22c55e':avgPerf>=65?'#eab308':'#ef4444')}
      ${wBigStat((avgDebt/60).toFixed(1)+'h', 'Avg Debt', avgDebt<30?'#22c55e':avgDebt<60?'#eab308':'#ef4444')}
    </div>
    <div style="margin-bottom:14px">
      <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Sleep Architecture (avg)</div>
      <div style="display:flex;gap:4px;height:20px;border-radius:6px;overflow:hidden;margin-bottom:6px">
        ${wSleepBar(avgDeep,  avgAsleep, '#3b82f6', 'Deep')}
        ${wSleepBar(avgREM,   avgAsleep, '#8b5cf6', 'REM')}
        ${wSleepBar(avgLight, avgAsleep, '#1e3a5f', 'Light')}
      </div>
      <div style="display:flex;gap:14px;font-size:11px;font-weight:600">
        <span style="color:#3b82f6">💤 Deep ${avgDeep.toFixed(0)}m (${(100*avgDeep/avgAsleep).toFixed(0)}%)</span>
        <span style="color:#8b5cf6">🌙 REM ${avgREM.toFixed(0)}m (${(100*avgREM/avgAsleep).toFixed(0)}%)</span>
        <span style="color:#475569">Light ${avgLight.toFixed(0)}m</span>
      </div>
    </div>
    <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Last 7 Nights</div>
    ${nights}
    <div style="margin-top:10px;display:flex;gap:12px;font-size:11px;color:var(--text3)">
      <span>Resp: ${avgResp.toFixed(1)} rpm avg</span>
    </div>`;
}

function wBigStat(val, label, color) {
  return `<div style="text-align:center;background:var(--surface2);border-radius:12px;padding:10px 8px">
    <div style="font-size:20px;font-weight:900;color:${color}">${val}</div>
    <div style="font-size:10px;color:var(--text3);font-weight:600;margin-top:2px">${label}</div>
  </div>`;
}
function wSleepBar(val, total, color, label) {
  const pct = total>0 ? (val/total)*100 : 0;
  return `<div style="flex:${pct};background:${color};min-width:4px" title="${label}: ${val.toFixed(0)}min"></div>`;
}

// ── Workout breakdown ──
function renderWhoopWorkouts(data) {
  const el = document.getElementById('whoopWorkoutCard');
  if (!el) return;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-90);
  const cutoffStr = cutoff.toISOString().slice(0,10);
  const recent = data.workouts.filter(w=>w.date>=cutoffStr);
  if (!recent.length) { el.innerHTML='<div style="color:var(--text3);font-size:13px">No workout data</div>'; return; }

  // Group by activity
  const byType = {};
  recent.forEach(w => {
    if (!byType[w.activity]) byType[w.activity]={count:0,totalCal:0,totalDur:0,totalStrain:0};
    byType[w.activity].count++;
    byType[w.activity].totalCal += w.calories||0;
    byType[w.activity].totalDur += w.duration||0;
    byType[w.activity].totalStrain += w.strain||0;
  });
  const sorted = Object.entries(byType).sort((a,b)=>b[1].count-a[1].count);
  const totalStrain = wavg(recent.filter(w=>w.strain).map(w=>w.strain));
  const totalCal = recent.reduce((s,w)=>s+(w.calories||0),0);

  const actEmoji = {Running:'🏃',Cycling:'🚴',Weightlifting:'🏋️',Powerlifting:'🏋️',Softball:'⚾',Baseball:'⚾',Golf:'⛳',Tennis:'🎾',Swimming:'🏊',Activity:'💪'};

  el.innerHTML = `
    <div style="font-size:11px;font-weight:700;color:#3b82f6;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px">🏃 Workouts · Last 90 Days</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px">
      ${wBigStat(recent.length, 'Sessions', '#e2e8f0')}
      ${wBigStat(totalStrain.toFixed(1), 'Avg Strain', '#3b82f6')}
      ${wBigStat(Math.round(totalCal/1000)+'k', 'Total Cal', '#f59e0b')}
    </div>
    <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">By Activity</div>
    ${sorted.map(([act,s])=>`
      <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:12px">
        <span style="font-weight:700;color:var(--text)">${actEmoji[act]||'💪'} ${act}</span>
        <span style="color:var(--text3)">${s.count}x · ${(s.totalDur/s.count).toFixed(0)}min avg</span>
        <span style="color:#f59e0b;font-weight:700">${(s.totalCal/s.count).toFixed(0)} cal</span>
      </div>`).join('')}`;
}

// ── AI Analysis ──
async function runWhoopAI() {
  const data = getWhoopData();
  if (!data) { showToast('Upload WHOOP data first'); return; }

  const btn = document.querySelector('#whoopAICard button');
  const result = document.getElementById('whoopAIResult');
  btn.disabled = true; btn.textContent = '⏳ Analyzing…';
  result.innerHTML = '<div style="color:var(--text3);font-size:13px">Analyzing your WHOOP data…</div>';

  // Build context from last 30 days
  const last30 = data.cycles.slice(0,30);
  const last7  = data.cycles.slice(0,7);
  const mean   = arr => arr.length ? (arr.reduce((a,b)=>a+b,0)/arr.length) : 0;

  const avgRec = mean(last30.map(r=>r.recovery||0));
  const avgHRV = mean(last30.map(r=>r.hrv||0));
  const avgRHR = mean(last30.map(r=>r.rhr||0));
  const avgSleep = mean(data.sleeps.slice(0,30).map(s=>s.asleepMin||0));
  const avgDeep  = mean(data.sleeps.slice(0,30).map(s=>s.deepMin||0));
  const avgREM   = mean(data.sleeps.slice(0,30).map(s=>s.remMin||0));
  const sleepDebt = data.cycles[0]?.sleepDebt || 0;
  const recentStrain = mean(last7.filter(r=>r.strain).map(r=>r.strain));

  const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-30);
  const recentWorkouts = data.workouts.filter(w=>w.date>=cutoff.toISOString().slice(0,10));
  const wTypes = {};
  recentWorkouts.forEach(w=>{ wTypes[w.activity]=(wTypes[w.activity]||0)+1; });

  const last14Snapshot = last7.map(r=>
    `${r.date}: rec=${r.recovery}% HRV=${r.hrv}ms RHR=${r.rhr}bpm strain=${r.strain||'--'} sleep=${r.sleepPerf||'--'}%`
  ).join('\n');

  const prompt = `You are a recovery and performance coach analyzing Jeremy's WHOOP biometric data. Jeremy is 52, an avid runner training for Grandma's Marathon (June 2026), lifting weights, and trying to lose weight (goal: 163 lbs).

=== 30-DAY AVERAGES ===
Recovery score: ${avgRec.toFixed(1)}% (Green=67+, Yellow=34-66, Red=<34)
HRV: ${avgHRV.toFixed(1)}ms  
RHR: ${avgRHR.toFixed(1)} bpm
Sleep: ${(avgSleep/60).toFixed(1)}h avg, Deep SWS: ${avgDeep.toFixed(0)}min, REM: ${avgREM.toFixed(0)}min
Current sleep debt: ${(sleepDebt/60).toFixed(1)}h
7-day avg strain: ${recentStrain.toFixed(1)}/21

=== WORKOUT MIX (last 30d) ===
${Object.entries(wTypes).map(([k,v])=>`${k}: ${v}x`).join(', ')}

=== LAST 7 DAYS DAILY ===
${last14Snapshot}

=== GOALS ===
- Marathon training (June 2026)
- Weight loss to 163 lbs
- Optimize recovery between hard runs
- Manage stress

Please analyze and provide:
1. **Recovery Assessment** — what his scores mean for a 52-year-old athlete
2. **Sleep Quality** — SWS and REM are the key recovery stages, how is he doing?
3. **Training Load vs Recovery** — is he overreaching? What strain level should he target?
4. **Top 3 Actionable Recommendations** — specific things to change this week
5. **Marathon Readiness** — is his recovery trending the right direction for June?

Be direct, data-driven, and specific to his numbers. No fluff.`;

  try {
    const resp = await fetch('/api/claude', {
      method:'POST', headers:authHeaders(),
      body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:1000, messages:[{role:'user',content:prompt}] })
    });
    const d = await resp.json();
    if (d.error) throw new Error(d.error.message);
    const text = d.content?.[0]?.text || 'No response';
    result.innerHTML = formatAIResponse(text);
  } catch(e) {
    result.textContent = '❌ Error: ' + e.message;
  }
  btn.disabled = false; btn.textContent = 'Re-analyze';
}

// ── Add WHOOP context to AI Coach ──
function getWhoopContext() {
  const data = getWhoopData();
  if (!data?.cycles?.length) return '';
  const today = data.cycles[0];
  const last7  = data.cycles.slice(0,7);
  const mean   = arr => arr.length ? (arr.reduce((a,b)=>a+b,0)/arr.length) : 0;
  const avgHRV = mean(last7.map(r=>r.hrv||0));
  const avgRec = mean(last7.map(r=>r.recovery||0));
  return `\n=== WHOOP BIOMETRICS (latest) ===
Today: Recovery=${today.recovery}% HRV=${today.hrv}ms RHR=${today.rhr}bpm Strain=${today.strain||'--'} SpO2=${today.spo2||'--'}%
7-day avg: Recovery=${avgRec.toFixed(0)}% HRV=${avgHRV.toFixed(0)}ms
Sleep debt: ${today.sleepDebt ? (today.sleepDebt/60).toFixed(1)+'h' : 'unknown'}
Sleep last night: ${today.sleepPerf||'--'}% performance, ${today.deepMin||'--'}min deep, ${today.remMin||'--'}min REM`;
}


// ══════════════════════════════════════════════════════════════
// ── WHOOP DATE-INDEXED INTEGRATION ────────────────────────────
// ══════════════════════════════════════════════════════════════

// Build a date-keyed lookup index from WHOOP data for fast access
function buildWhoopIndex(data) {
  if (!data) return {};
  const idx = {};
  // Index cycles by date
  (data.cycles || []).forEach(c => {
    if (!c.date) return;
    if (!idx[c.date]) idx[c.date] = { recovery: null, hrv: null, rhr: null, strain: null, spo2: null, skinTemp: null, sleepPerf: null, deepMin: null, remMin: null, lightMin: null, asleepMin: null, sleepDebt: null, respRate: null, sleepConsistency: null };
    const d = idx[c.date];
    if (c.recovery != null) d.recovery = c.recovery;
    if (c.hrv != null) d.hrv = c.hrv;
    if (c.rhr != null) d.rhr = c.rhr;
    if (c.strain != null) d.strain = c.strain;
    if (c.spo2 != null) d.spo2 = c.spo2;
    if (c.skinTemp != null) d.skinTemp = c.skinTemp;
    if (c.sleepPerf != null) d.sleepPerf = c.sleepPerf;
    if (c.deepMin != null) d.deepMin = c.deepMin;
    if (c.remMin != null) d.remMin = c.remMin;
    if (c.lightMin != null) d.lightMin = c.lightMin;
    if (c.asleepMin != null) d.asleepMin = c.asleepMin;
    if (c.sleepDebt != null) d.sleepDebt = c.sleepDebt;
    if (c.respRate != null) d.respRate = c.respRate;
    if (c.sleepConsistency != null) d.sleepConsistency = c.sleepConsistency;
  });
  // Index workouts by date (array — multiple workouts per day)
  (data.workouts || []).forEach(w => {
    if (!w.date) return;
    if (!idx[w.date]) idx[w.date] = {};
    if (!idx[w.date].workouts) idx[w.date].workouts = [];
    idx[w.date].workouts.push(w);
  });
  return idx;
}

// Get cached index (rebuild on demand)
let _whoopIndex = null;
let _whoopIndexVersion = null;
function getWhoopIndex() {
  const data = getWhoopData();
  if (!data) return {};
  const version = data.importedAt;
  if (!_whoopIndex || _whoopIndexVersion !== version) {
    _whoopIndex = buildWhoopIndex(data);
    _whoopIndexVersion = version;
  }
  return _whoopIndex;
}

// Get WHOOP data for a specific date key (YYYY-MM-DD)
function getWhoopForDate(dateKey) {
  const idx = getWhoopIndex();
  return idx[dateKey] || null;
}

// Get WHOOP summary for date range — used in AI context
function getWhoopRangeSummary(days) {
  const data = getWhoopData();
  if (!data?.cycles?.length) return null;
  const idx = getWhoopIndex();
  const summaries = [];
  const today = nowEST();
  for (let i = 0; i < days; i++) {
    const d = nowEST();
    d.setDate(today.getDate() - i);
    const key = dateToKey(d);
    const w = idx[key];
    if (w && (w.recovery != null || w.hrv != null)) {
      const parts = [];
      if (w.recovery != null) parts.push(`rec=${w.recovery}%`);
      if (w.hrv != null) parts.push(`HRV=${w.hrv}ms`);
      if (w.rhr != null) parts.push(`RHR=${w.rhr}bpm`);
      if (w.strain != null) parts.push(`strain=${w.strain.toFixed(1)}`);
      if (w.sleepPerf != null) parts.push(`sleep=${w.sleepPerf}%`);
      if (w.deepMin != null) parts.push(`deep=${Math.round(w.deepMin)}m`);
      if (w.asleepMin != null) parts.push(`slept=${(w.asleepMin/60).toFixed(1)}h`);
      summaries.push(`${key}: ${parts.join(' ')}`);
    }
  }
  return summaries;
}

// ── Enhanced getAppContext to include WHOOP per-date data ──
// This replaces the simple getWhoopContext() call with rich per-day data
function getWhoopContextFull() {
  const data = getWhoopData();
  if (!data?.cycles?.length) return '';

  const today = data.cycles[0];
  const last30 = data.cycles.slice(0, 30);
  const wavg = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
  const avgHRV = wavg(last30.map(r=>r.hrv||0).filter(Boolean));
  const avgRHR = wavg(last30.map(r=>r.rhr||0).filter(Boolean));
  const avgRec = wavg(last30.map(r=>r.recovery||0).filter(Boolean));
  const avgSleep = wavg(last30.map(r=>r.asleepMin||0).filter(Boolean));
  const avgDeep = wavg(last30.map(r=>r.deepMin||0).filter(Boolean));
  const avgREM = wavg(last30.map(r=>r.remMin||0).filter(Boolean));

  const last30Days = getWhoopRangeSummary(30) || [];
  const daysSinceImport = today?.date
    ? Math.round((Date.now() - new Date(today.date).getTime()) / 86400000)
    : null;

  // Workout breakdown
  const cutoff30 = new Date(); cutoff30.setDate(cutoff30.getDate()-30);
  const cutoffStr = cutoff30.toISOString().slice(0,10);
  const recentWorkouts = data.workouts.filter(w=>w.date>=cutoffStr);
  const wTypes = {};
  recentWorkouts.forEach(w=>{ wTypes[w.activity]=(wTypes[w.activity]||0)+1; });

  return `
=== WHOOP BIOMETRICS (${data.cycles.length} days of data, imported ${daysSinceImport != null ? daysSinceImport+'d ago' : 'recently'}) ===
LATEST: Recovery=${today.recovery}% HRV=${today.hrv}ms RHR=${today.rhr}bpm Strain=${today.strain!=null?today.strain.toFixed(1):'--'} SpO2=${today.spo2||'--'}%
Sleep debt: ${today.sleepDebt!=null?(today.sleepDebt/60).toFixed(1)+'h':'unknown'} | Sleep: ${today.sleepPerf||'--'}% perf, ${today.deepMin?Math.round(today.deepMin):'--'}min deep, ${today.remMin?Math.round(today.remMin):'--'}min REM

30-DAY WHOOP AVERAGES:
Recovery: ${avgRec.toFixed(1)}% | HRV: ${avgHRV.toFixed(1)}ms | RHR: ${avgRHR.toFixed(1)}bpm
Sleep: ${(avgSleep/60).toFixed(1)}h avg | Deep SWS: ${avgDeep.toFixed(0)}min (${avgSleep>0?(100*avgDeep/avgSleep).toFixed(0):0}%) | REM: ${avgREM.toFixed(0)}min (${avgSleep>0?(100*avgREM/avgSleep).toFixed(0):0}%)
Workout mix (30d): ${Object.entries(wTypes).map(([k,v])=>k+':'+v+'x').join(', ')||'none'}

DAILY WHOOP LOG (last 30d) — use to correlate with food/weight/workouts:
${last30Days.slice(0,30).join('\n') || 'No data'}`;
}

// ── 30-Day WHOOP Reminder ──
function checkWhoopUpdateReminder() {
  const data = getWhoopData();
  const snoozeKey = 'whoopReminderSnooze';
  const snooze = getStorage(snoozeKey, null);
  if (snooze && new Date(snooze) > new Date()) return; // snoozed

  if (!data) {
    // Never imported — show once after a delay
    const firstOpen = getStorage('whoopReminderFirstOpen', null);
    if (!firstOpen) {
      setStorage('whoopReminderFirstOpen', new Date().toISOString());
      return; // First ever open — don't bug them immediately
    }
    const daysSinceFirst = (Date.now() - new Date(firstOpen).getTime()) / 86400000;
    if (daysSinceFirst > 3) {
      showWhoopReminder('never');
    }
    return;
  }

  // Imported — check age
  const importDate = data.importedAt ? new Date(data.importedAt) : null;
  if (!importDate) return;
  const daysSince = (Date.now() - importDate.getTime()) / 86400000;

  if (daysSince >= 30) {
    showWhoopReminder('stale', Math.round(daysSince));
  }
}

function showWhoopReminder(type, daysSince) {
  // Don't show if already visible
  if (document.getElementById('whoopReminderBanner')) return;

  const msg = type === 'never'
    ? '💍 Connect your WHOOP data for deeper health insights. Export from WHOOP app → History tab.'
    : `💍 Your WHOOP data is ${daysSince} days old. Export a fresh copy from WHOOP app for accurate AI analysis.`;

  const banner = document.createElement('div');
  banner.id = 'whoopReminderBanner';
  banner.style.cssText = 'position:fixed;bottom:70px;left:50%;transform:translateX(-50%);width:calc(100%-32px);max-width:480px;background:linear-gradient(135deg,#1e0a3c,#2d1556);border:1.5px solid #7c3aed;border-radius:16px;padding:12px 16px;z-index:9000;box-shadow:0 4px 24px rgba(124,58,237,0.35);display:flex;align-items:center;gap:12px;animation:slideUp 0.3s ease';
  banner.innerHTML = `
    <div style="flex:1;font-size:13px;color:#e2d9f3;font-weight:600;line-height:1.4">${msg}</div>
    <button onclick="switchTab('history');switchHistoryTab('whoop');dismissWhoopReminder()" style="background:#7c3aed;border:none;border-radius:10px;padding:7px 12px;color:#fff;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;font-family:inherit">Update</button>
    <button onclick="snoozeWhoopReminder()" style="background:transparent;border:1px solid #4c1d95;border-radius:10px;padding:7px 10px;color:#a78bfa;font-size:11px;cursor:pointer;font-family:inherit">Later</button>
    <button onclick="dismissWhoopReminder()" style="background:none;border:none;color:#6b7280;font-size:16px;cursor:pointer;line-height:1;padding:0 2px">×</button>`;

  document.body.appendChild(banner);
  setTimeout(() => {
    if (banner.parentNode) banner.style.opacity = '0';
    setTimeout(() => banner.remove(), 500);
  }, 12000);
}

function dismissWhoopReminder() {
  const b = document.getElementById('whoopReminderBanner');
  if (b) b.remove();
  // Mark as seen today
  setStorage('whoopReminderSnooze', new Date(Date.now() + 86400000).toISOString());
}

function snoozeWhoopReminder() {
  const b = document.getElementById('whoopReminderBanner');
  if (b) b.remove();
  // Snooze 7 days
  setStorage('whoopReminderSnooze', new Date(Date.now() + 7*86400000).toISOString());
}

// ── Add WHOOP metrics to Trends chart ──
// Extend existing setTrendMetric to support WHOOP metrics
const _origSetTrendMetric = setTrendMetric;
function setTrendMetric(metric, btn) {
  if (['recovery','hrv','rhr','strain','sleepPerf'].includes(metric)) {
    currentTrendMetric = metric;
    document.querySelectorAll('.chart-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderWhoopTrendChart(metric);
    return;
  }
  _origSetTrendMetric(metric, btn);
}

function renderWhoopTrendChart(metric) {
  const container = document.getElementById('monthChartContainer');
  const summaryRow = document.getElementById('trendSummaryRow');
  if (!container) return;

  const idx = getWhoopIndex();
  const today = nowEST();
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = nowEST();
    d.setDate(today.getDate() - i);
    const key = dateToKey(d);
    const w = idx[key];
    const val = w ? w[metric] : null;
    days.push({ key, label: d.getDate(), val: val != null ? parseFloat(val) : null });
  }

  const logged = days.filter(d => d.val !== null);
  if (!logged.length) {
    container.innerHTML = `<div class="empty-state" style="padding:30px 0;text-align:center">No WHOOP ${metric} data for last 30 days.<br><small style="color:var(--text3)">Upload WHOOP data in History → 💍 WHOOP</small></div>`;
    summaryRow.innerHTML = '';
    return;
  }

  const maxVal = Math.max(...logged.map(v=>v.val));
  const minVal = Math.min(...logged.map(v=>v.val));
  const avgVal = logged.reduce((s,v)=>s+v.val,0)/logged.length;
  const colors = { recovery:'#a78bfa', hrv:'#22c55e', rhr:'#ef4444', strain:'#3b82f6', sleepPerf:'#f59e0b' };
  const labels = { recovery:'Recovery %', hrv:'HRV (ms)', rhr:'RHR (bpm)', strain:'Day Strain', sleepPerf:'Sleep Perf %' };
  const color = colors[metric];

  const bars = days.map(d => {
    const hasVal = d.val !== null;
    const pct = hasVal ? Math.max(4, Math.round(((d.val - minVal*0.9) / ((maxVal*1.05) - minVal*0.9)) * 100)) : 2;
    const isToday = d.key === todayKey();
    const barColor = hasVal
      ? (metric==='recovery' ? wrecoveryColor(d.val).text : color)
      : 'var(--surface2)';
    const showLabel = d.label === 1 || d.label % 7 === 1;
    return `<div class="month-bar-wrap" title="${d.key}: ${d.val!=null?d.val.toFixed(1):'no data'}">
      <div class="month-bar" style="height:${pct}%;background:${barColor};${isToday?'outline:2px solid #3b82f6;border-radius:5px 5px 0 0':''}${!hasVal?';opacity:0.2':''}"></div>
      <div class="month-bar-lbl">${showLabel?d.label:''}</div>
    </div>`;
  }).join('');

  container.innerHTML = `<div class="month-bar-chart">${bars}</div>`;

  const trend30 = logged.length >= 7 ? (logged[logged.length-1].val - logged[0].val).toFixed(1) : null;
  const trendStr = trend30 === null ? '—' : (parseFloat(trend30)>0?'+':'')+trend30;
  const unit = metric==='hrv'?'ms':metric==='rhr'?'bpm':metric==='strain'?'':' %';
  const trendGood = (['recovery','hrv','sleepPerf'].includes(metric) && parseFloat(trendStr)>0) ||
                    (['rhr'].includes(metric) && parseFloat(trendStr)<0);

  summaryRow.innerHTML = `
    <div class="weekly-stat" style="border-color:${color}30">
      <div class="weekly-stat-val" style="color:${color}">${avgVal.toFixed(1)}${unit}</div>
      <div class="weekly-stat-lbl">30-Day Avg</div>
    </div>
    <div class="weekly-stat">
      <div class="weekly-stat-val">${maxVal.toFixed(1)}</div>
      <div class="weekly-stat-lbl">Peak</div>
    </div>
    <div class="weekly-stat">
      <div class="weekly-stat-val">${minVal.toFixed(1)}</div>
      <div class="weekly-stat-lbl">Low</div>
    </div>
    <div class="weekly-stat">
      <div class="weekly-stat-val" style="color:${trend30!==null?(trendGood?'var(--green)':'var(--red)'):'var(--text)'}">${trendStr}</div>
      <div class="weekly-stat-lbl">30d Trend</div>
    </div>`;
}


// ═══════════════════════════════════════════════════════
// ── BLOOD WORK ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════

let _bloodFileData = null; // { base64, mediaType, name }

function handleBloodDrop(e) {
  const file = e.dataTransfer.files[0];
  if (file) handleBloodFile(file);
}

async function handleBloodFile(file) {
  if (!file) return;
  const nameEl   = document.getElementById('bloodUploadName');
  const statusEl = document.getElementById('bloodUploadStatus');
  const btnEl    = document.getElementById('bloodAnalyzeBtn');
  nameEl.textContent = '📎 ' + file.name;
  statusEl.style.display = 'block';
  statusEl.style.color   = 'var(--text2)';
  statusEl.textContent   = '⏳ Reading file…';
  btnEl.style.display    = 'none';

  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

  if (isPdf) {
    // Extract text from PDF using PDF.js — avoids sending huge base64 through the proxy
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        if (typeof pdfjsLib === 'undefined') {
          // PDF.js not loaded yet — fallback to base64 document method
          const base64 = e.target.result.split(',')[1];
          _bloodFileData = { base64, mediaType: 'application/pdf', name: file.name, extractedText: null };
          statusEl.textContent = '';
          btnEl.style.display = 'block';
          btnEl.textContent   = '🤖 Analyze PDF with AI';
          return;
        }
        pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        const arrayBuffer = e.target.result;
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        let fullText = '';
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const tc   = await page.getTextContent();
          fullText  += tc.items.map(s => s.str).join(' ') + '\n';
        }
        _bloodFileData = { extractedText: fullText, mediaType: 'text/plain', name: file.name, base64: null };
        statusEl.textContent = '✅ ' + pdf.numPages + ' pages extracted — ready to analyze';
        btnEl.style.display = 'block';
        btnEl.textContent   = '🤖 Analyze PDF with AI';
      } catch(err) {
        console.error('PDF extract error:', err);
        statusEl.textContent = '❌ Could not read PDF. Try the paste text option below.';
        statusEl.style.color = '#ef4444';
      }
    };
    reader.readAsArrayBuffer(file);
  } else {
    // Image file — use base64 as before
    const reader = new FileReader();
    reader.onload = e => {
      const dataUrl = e.target.result;
      const mediaType = file.type || 'image/jpeg';
      _bloodFileData = { base64: dataUrl.split(',')[1], mediaType, name: file.name, extractedText: null };
      statusEl.textContent = '';
      btnEl.style.display  = 'block';
      btnEl.textContent    = '🤖 Analyze Image with AI';
    };
    reader.readAsDataURL(file);
  }
}

function getBloodResults() { return getStorage('bloodResults', []); }
function saveBloodResults(r) { setStorage('bloodResults', r); }

// ── BLOOD REFERENCE RANGES (5-tier: Optimal DX / Ways2Well compatible) ──
// Format: [optLo, optHi, stdLo, stdHi, unit, displayName, panel]
// optLo-optHi = optimal/functional range (green)
// stdLo-stdHi = standard/lab range (the wider acceptable range)
// Values outside std = alarm/out of range
const BLOOD_REFS = {
  // ── Blood Glucose ──────────────────────────────────
  'glucose':           [75, 86, 65, 99, 'mg/dL', 'Glucose Fasting', 'blood_glucose'],
  'hba1c':             [4.6, 5.3, 4.8, 5.6, '%', 'Hemoglobin A1C', 'blood_glucose'],
  'eag':               [85, 105, 82, 154, 'mg/dL', 'eAG', 'blood_glucose'],
  'insulin':           [2.6, 5.0, 2.6, 24.9, 'µIU/mL', 'Insulin - Fasting', 'blood_glucose'],

  // ── Renal ──────────────────────────────────────────
  'bun':               [10, 16, 6, 24, 'mg/dL', 'BUN', 'renal'],
  'creatinine':        [0.8, 1.1, 0.76, 1.27, 'mg/dL', 'Creatinine', 'renal'],
  'bun_creatinine_ratio':[10, 16, 9, 20, 'Ratio', 'BUN : Creatinine', 'renal'],
  'egfr':              [90, 120, 59, 160, 'mL/min', 'eGFR', 'renal'],

  // ── Prostate ───────────────────────────────────────
  'psa':               [0, 2.0, 0, 4.0, 'ng/mL', 'PSA - Total', 'prostate'],

  // ── Electrolytes ───────────────────────────────────
  'sodium':            [137, 142, 134, 144, 'mEq/L', 'Sodium', 'electrolytes'],
  'potassium':         [4.0, 5.0, 3.5, 5.2, 'mEq/L', 'Potassium', 'electrolytes'],
  'chloride':          [100, 106, 96, 106, 'mEq/L', 'Chloride', 'electrolytes'],
  'carbon_dioxide':    [25, 30, 20, 29, 'mEq/L', 'CO2', 'electrolytes'],

  // ── Proteins ───────────────────────────────────────
  'protein_total':     [6.9, 8.1, 6.0, 8.5, 'g/dL', 'Protein - Total', 'proteins'],
  'albumin':           [4.5, 5.0, 3.8, 4.9, 'g/dL', 'Albumin', 'proteins'],
  'globulin_total':    [2.4, 2.8, 1.5, 4.5, 'g/dL', 'Globulin - Total', 'proteins'],
  'albumin_globulin':  [1.4, 2.1, 1.2, 2.2, 'ratio', 'Albumin : Globulin', 'proteins'],

  // ── Minerals ───────────────────────────────────────
  'calcium':           [8.9, 9.5, 8.7, 10.2, 'mg/dL', 'Calcium', 'minerals'],
  'magnesium':         [2.2, 2.5, 1.6, 2.3, 'mg/dL', 'Magnesium - Serum', 'minerals'],

  // ── Liver and GB ───────────────────────────────────
  'alkaline_phosphatase':[45, 100, 39, 117, 'IU/L', 'Alk Phos', 'liver_gb'],
  'ast':               [10, 26, 0, 40, 'IU/L', 'AST', 'liver_gb'],
  'alt':               [10, 26, 0, 44, 'IU/L', 'ALT', 'liver_gb'],
  'bilirubin':         [0.5, 0.9, 0, 1.2, 'mg/dL', 'Bilirubin - Total', 'liver_gb'],
  'ggt':               [8, 61, 8, 61, 'U/L', 'GGT', 'liver_gb'],

  // ── Iron Markers ───────────────────────────────────
  'iron':              [85, 130, 38, 169, 'µg/dL', 'Iron - Serum', 'iron_markers'],
  'ferritin':          [45, 79, 30, 400, 'ng/mL', 'Ferritin', 'iron_markers'],
  'iron_tibc':         [250, 350, 250, 450, 'µg/dL', 'TIBC', 'iron_markers'],
  'uibc':              [130, 300, 111, 343, 'µg/dL', 'UIBC', 'iron_markers'],
  'transferrin_sat':   [24, 35, 15, 55, '%', '% Transferrin Saturation', 'iron_markers'],

  // ── Lipids ─────────────────────────────────────────
  'total_cholesterol': [160, 199, 100, 199, 'mg/dL', 'Cholesterol - Total', 'lipids'],
  'triglycerides':     [70, 80, 0, 149, 'mg/dL', 'Triglycerides', 'lipids'],
  'ldl':               [80, 99.99, 0, 99, 'mg/dL', 'LDL Cholesterol', 'lipids'],
  'hdl':               [55, 93, 39, 100, 'mg/dL', 'HDL Cholesterol', 'lipids'],
  'vldl':              [0, 15, 5, 40, 'mg/dL', 'VLDL Cholesterol', 'lipids'],
  'non_hdl':           [0, 130, 0, 130, 'mg/dL', 'Non-HDL Cholesterol', 'lipids'],
  't_chol_hdl_ratio':  [0, 3.0, 0, 4.4, 'Ratio', 'Cholesterol : HDL', 'lipids'],

  // ── Lipoproteins ───────────────────────────────────
  'lipoprotein_a':     [0, 18, 0, 74.99, 'nmol/L', 'Lipoprotein (a)', 'lipoproteins'],
  'apolipoprotein_b':  [52, 80, 0, 90, 'mg/dL', 'Apolipoprotein B', 'lipoproteins'],

  // ── Thyroid ────────────────────────────────────────
  'tsh':               [1.0, 2.0, 0.45, 4.5, 'mIU/L', 'TSH', 'thyroid'],
  't4_total':          [6.0, 11.9, 4.5, 12.0, 'µg/dL', 'T4 - Total', 'thyroid'],
  't4_free':           [1.0, 1.5, 0.82, 1.77, 'ng/dL', 'T4 - Free', 'thyroid'],
  'free_t3':           [3.0, 3.5, 2.0, 4.4, 'pg/mL', 'T3 - Free', 'thyroid'],
  't3_uptake':         [27, 35, 24, 39, '%', 'T3 Uptake', 'thyroid'],
  'free_thyroxine_index':[1.7, 4.6, 1.2, 4.9, 'Index', 'Free Thyroxine Index (T7)', 'thyroid'],
  'thyroglobulin_abs': [0, 1.0, 0, 1.0, 'IU/mL', 'Thyroglobulin Abs', 'thyroid'],
  'thyroglobulin':     [5.0, 14.0, 1.4, 29.2, 'ng/ml', 'Thyroglobulin', 'thyroid'],
  'free_t3_free_t4':   [2.4, 2.7, 2.2, 2.9, 'Ratio', 'Free T3 : Free T4', 'thyroid'],

  // ── Inflammation ───────────────────────────────────
  'crp':               [0, 0.55, 0, 3.0, 'mg/L', 'Hs CRP', 'inflammation'],

  // ── Vitamins ───────────────────────────────────────
  'vitamin_d':         [50, 90, 30, 100, 'ng/mL', 'Vitamin D (25-OH)', 'vitamins'],
  'vitamin_b12':       [545, 1100, 232, 1245, 'pg/mL', 'Vitamin B12', 'vitamins'],
  'folate':            [15, 27, 3, 27, 'ng/mL', 'Folate - Serum', 'vitamins'],

  // ── Hormones ───────────────────────────────────────
  'dhea_s':            [350, 530.5, 164.3, 530.5, 'µg/dL', 'DHEA-S', 'hormones'],
  'testosterone_total':[700, 1100, 264, 916, 'ng/dL', 'Testosterone Total', 'hormones'],
  'testosterone_free': [150, 224, 46, 224, 'pg/mL', 'Testosterone Free', 'hormones'],
  'testosterone_bio':  [375, 575, 110, 575, 'ng/dL', 'Testosterone Bioavailable', 'hormones'],
  'shbg':              [40, 46, 19.3, 76.4, 'nmol/L', 'Sex Hormone Binding Globulin', 'hormones'],
  'estradiol':         [24, 39, 7.6, 42.6, 'pg/mL', 'Estradiol', 'hormones'],
  'prolactin':         [2.0, 10.0, 2.0, 18.0, 'ng/mL', 'Prolactin', 'hormones'],
  'igf1':              [100, 170, 95, 290, 'ng/mL', 'IGF-1', 'hormones'],
  'cortisol':          [10, 15, 6.2, 19.4, 'µg/dL', 'Cortisol - Total/AM', 'hormones'],
  'pth':               [15, 32, 15, 65, 'pg/mL', 'Parathyroid Hormone - PTH', 'hormones'],

  // ── CBC ────────────────────────────────────────────
  'rbc':               [4.8, 5.5, 4.14, 5.8, 'M/cumm', 'RBC', 'cbc'],
  'hemoglobin':        [14.0, 15.0, 13.0, 17.7, 'g/dL', 'Hemoglobin', 'cbc'],
  'hematocrit':        [40, 48, 37.5, 51, '%', 'Hematocrit', 'cbc'],
  'mcv':               [82, 89.9, 79, 97, 'fL', 'MCV', 'cbc'],
  'mch':               [28, 31.9, 26.6, 33, 'pg', 'MCH', 'cbc'],
  'mchc':              [34, 36, 31.5, 35.7, 'g/dL', 'MCHC', 'cbc'],
  'platelets':         [190, 300, 150, 450, '10E3/uL', 'Platelets', 'cbc'],
  'rdw':               [11, 12.6, 11.6, 15.4, '%', 'RDW', 'cbc'],

  // ── WBCs ───────────────────────────────────────────
  'wbc':               [3.8, 6.0, 3.4, 10.8, 'k/cumm', 'Total WBCs', 'wbcs'],
  'neutrophils_pct':   [50, 60, 38, 74, '%', 'Neutrophils - %', 'wbcs'],
  'immature_grans_pct':[0, 0.5, 0, 1.0, '%', 'Immature Granulocytes - %', 'wbcs'],
  'lymphocytes_pct':   [30, 35, 14, 46, '%', 'Lymphocytes - %', 'wbcs'],
  'monocytes_pct':     [4, 7, 4, 13, '%', 'Monocytes - %', 'wbcs'],
  'eosinophils_pct':   [0, 3, 0, 3, '%', 'Eosinophils - %', 'wbcs'],
  'basophils_pct':     [0, 1, 0, 1, '%', 'Basophils - %', 'wbcs'],
  'neutrophils_abs':   [1.9, 4.2, 1.4, 7.0, 'k/cumm', 'Neutrophils - Absolute', 'wbcs'],
  'immature_grans_abs':[0, 0.03, 0, 0.1, 'k/cumm', 'Immature Granulocytes - Abs', 'wbcs'],
  'lymphocytes_abs':   [1.44, 2.54, 0.7, 3.1, 'k/cumm', 'Lymphocytes - Absolute', 'wbcs'],
  'monocytes_abs':     [0.2, 0.4, 0.1, 0.9, 'k/cumm', 'Monocytes - Absolute', 'wbcs'],
  'eosinophils_abs':   [0.03, 0.2, 0, 0.4, 'k/cumm', 'Eosinophils - Absolute', 'wbcs'],
  'basophils_abs':     [0, 0.1, 0, 0.2, 'k/cumm', 'Basophils - Absolute', 'wbcs'],

  // ── Legacy/extra keys ──────────────────────────────
  'uric_acid':         [3.4, 7.0, 3.4, 7.0, 'mg/dL', 'Uric Acid', 'renal'],
};






const KEY_ALIASES = {
  'blood_glucose':'glucose','fasting_glucose':'glucose','serum_glucose':'glucose',
  'hemoglobin_a1c':'hba1c','hb_a1c':'hba1c','a1c':'hba1c','glycated_hemoglobin':'hba1c',
  'blood_urea_nitrogen':'bun','urea_nitrogen':'bun','serum_creatinine':'creatinine',
  'estimated_gfr':'egfr','gfr':'egfr',
  'cholesterol_total':'total_cholesterol','total_chol':'total_cholesterol','cholesterol':'total_cholesterol',
  'ldl_cholesterol':'ldl','ldl_chol':'ldl','ldl_calculated':'ldl','ldl_c':'ldl',
  'ldl_chol_calc':'ldl','ldl_chol_calc_nih':'ldl','ldl_direct':'ldl',
  'hdl_cholesterol':'hdl','hdl_chol':'hdl','hdl_c':'hdl',
  'trig':'triglycerides','trigs':'triglycerides','tg':'triglycerides',
  'vldl_cholesterol':'vldl','vldl_chol':'vldl',
  'lp_a':'lipoprotein_a','lpa':'lipoprotein_a',
  'apo_b':'apolipoprotein_b','apob':'apolipoprotein_b',
  'non_hdl_cholesterol':'non_hdl','non_hdl_chol':'non_hdl',
  'tchol_hdl_ratio':'t_chol_hdl_ratio','chol_hdl_ratio':'t_chol_hdl_ratio',
  'testosterone':'testosterone_total','total_testosterone':'testosterone_total',
  'free_testosterone':'testosterone_free','testosterone_free_calc':'testosterone_free',
  'sex_hormone_binding_globulin':'shbg','sex_horm_binding_glob':'shbg',
  'estradiol_e2':'estradiol','e2':'estradiol',
  'cortisol_am':'cortisol','morning_cortisol':'cortisol',
  'thyroid_stimulating_hormone':'tsh','thyrotropin':'tsh',
  'free_t4':'t4_free','thyroxine_free':'t4_free','t4_free_direct':'t4_free',
  'free_thyroxine':'t4_free','thyroxine_t4_free':'t4_free','thyroxine_t4':'t4_free',
  't3_free':'free_t3','triiodothyronine_free':'free_t3','ft3':'free_t3',
  't3_uptake':'t3_uptake','resin_t3_uptake':'t3_uptake',
  'fasting_insulin':'insulin','serum_insulin':'insulin',
  'dhea_sulfate':'dhea_s','dheas':'dhea_s','dhea':'dhea_s',
  'prostate_specific_antigen':'psa','psa_total':'psa',
  'white_blood_cell':'wbc','white_blood_cells':'wbc','leukocytes':'wbc',
  'red_blood_cell':'rbc','red_blood_cells':'rbc','erythrocytes':'rbc',
  'hgb':'hemoglobin','hb':'hemoglobin','haemoglobin':'hemoglobin',
  'hct':'hematocrit','packed_cell_volume':'hematocrit',
  'platelet_count':'platelets','thrombocytes':'platelets','plt':'platelets',
  'mean_corpuscular_volume':'mcv','mean_corpuscular_hemoglobin_concentration':'mchc',
  'red_cell_distribution_width':'rdw','rdw_cv':'rdw',
  'lymphs_absolute':'lymphocytes_abs','lymphocytes_absolute':'lymphocytes_abs',
  'absolute_lymphocytes':'lymphocytes_abs','lymphs':'lymphocytes_pct',
  'lymphocytes':'lymphocytes_pct',
  'neutrophils_absolute':'neutrophils_abs','absolute_neutrophils':'neutrophils_abs',
  'neutrophils':'neutrophils_pct',
  'monocytes_absolute':'monocytes_abs','absolute_monocytes':'monocytes_abs',
  'monocytes':'monocytes_pct',
  'eos_absolute':'eosinophils_abs','eosinophils_absolute':'eosinophils_abs',
  'eosinophils':'eosinophils_pct',
  'baso_absolute':'basophils_abs','basophils_absolute':'basophils_abs',
  'eos':'eosinophils_pct','basos':'basophils_pct',
  'neuts':'neutrophils_pct','lymphs_pct':'lymphocytes_pct',
  'monos':'monocytes_pct','monos_abs':'monocytes_abs',
  'neuts_abs':'neutrophils_abs','eos_abs':'eosinophils_abs',
  'basos_abs':'basophils_abs',
  'basophils':'basophils_pct',
  'immature_granulocytes':'immature_grans_pct',
  'immature_grans_abs':'immature_grans_abs',
  'bun_creatinine':'bun_creatinine_ratio','bun_cr_ratio':'bun_creatinine_ratio',
  'chloride_serum':'chloride','serum_chloride':'chloride',
  'co2':'carbon_dioxide','carbon_dioxide_total':'carbon_dioxide',
  'bicarbonate':'carbon_dioxide',
  'total_protein':'protein_total','protein_serum':'protein_total',
  'globulin':'globulin_total','serum_globulin':'globulin_total',
  'vitamin_d_25_hydroxy':'vitamin_d','25_oh_vitamin_d':'vitamin_d','vit_d':'vitamin_d',
  'vitamin_b12_serum':'vitamin_b12','cobalamin':'vitamin_b12','b12':'vitamin_b12',
  'folic_acid':'folate','folate_serum':'folate',
  'c_reactive_protein':'crp','crp_cardiac':'crp','hs_crp':'crp',
  'high_sensitivity_crp':'crp','c_reactive_protein_cardiac':'crp',
  'serum_ferritin':'ferritin','ferritin_serum':'ferritin',
  'serum_iron':'iron','iron_serum':'iron',
  'tibc':'iron_tibc','total_iron_binding_capacity':'iron_tibc',
  'iron_sat':'transferrin_sat','iron_saturation':'transferrin_sat',
  'alanine_aminotransferase':'alt','alt_sgpt':'alt','sgpt':'alt',
  'aspartate_aminotransferase':'ast','ast_sgot':'ast','sgot':'ast',
  'alk_phos':'alkaline_phosphatase','alp':'alkaline_phosphatase',
  'gamma_glutamyl_transferase':'ggt','gamma_gt':'ggt',
  'bilirubin_total':'bilirubin','total_bilirubin':'bilirubin',
  'albumin_serum':'albumin','serum_albumin':'albumin',
  // New aliases for Ways2Well markers
  'estimated_average_glucose':'eag','estimated_avg_glucose':'eag',
  'ag_ratio':'albumin_globulin','albumin_globulin_ratio':'albumin_globulin',
  'a_g_ratio':'albumin_globulin','a_g':'albumin_globulin',
  'magnesium_serum':'magnesium','serum_magnesium':'magnesium',
  'unsaturated_iron_binding_capacity':'uibc',
  'transferrin_saturation':'transferrin_sat','percent_transferrin_saturation':'transferrin_sat',
  'iron_percent_saturation':'transferrin_sat',
  'cholesterol_hdl_ratio':'t_chol_hdl_ratio','total_cholesterol_hdl_ratio':'t_chol_hdl_ratio',
  'lp_a_nmol':'lipoprotein_a','lp_a_mass':'lipoprotein_a',
  't4_total':'t4_total','thyroxine_total':'t4_total','total_t4':'t4_total',
  'thyroglobulin_antibodies':'thyroglobulin_abs','tg_abs':'thyroglobulin_abs',
  'thyroglobulin_ab':'thyroglobulin_abs',
  'free_thyroxine_index':'free_thyroxine_index','t7':'free_thyroxine_index','fti':'free_thyroxine_index',
  'free_t3_t4_ratio':'free_t3_free_t4','t3_t4_ratio':'free_t3_free_t4',
  'igf_1':'igf1','insulin_like_growth_factor':'igf1','somatomedin_c':'igf1',
  'parathyroid_hormone':'pth','intact_pth':'pth','parathyroid':'pth',
  'bioavailable_testosterone':'testosterone_bio','testosterone_bioavailable':'testosterone_bio',
  'mch':'mch','mean_corpuscular_hemoglobin':'mch',
  'total_wbc':'wbc','total_wbcs':'wbc',
};

function normalizeBloodKey(key) {
  if (!key) return key;
  var k = key.toLowerCase().trim().replace(/[^a-z0-9_]/g, '_').replace(/__+/g, '_').replace(/^_|_$/g, '');
  return KEY_ALIASES[k] || k;
}

function normalizeBloodMarkers(markers) {
  if (!markers) return markers;
  var seen = {};
  return markers
    .map(function(m) {
      return {name:m.name, key:normalizeBloodKey(m.key), value:m.value, unit:m.unit, ref_low:m.ref_low, ref_high:m.ref_high, flag:m.flag};
    })
    .filter(function(m) {
      if (seen[m.key]) return false;
      seen[m.key] = true;
      return true;
    });
}


function seedBloodResults() {
  try {
    var existing = getStorage('bloodResults', []);
    if (Array.isArray(existing) && existing.length > 0) return; // Don't overwrite user data
    var seeded = [{"id": 1000000003, "date": "2025-04-21", "lab": "Labcorp", "uploadedAt": "2025-04-21T00:00:00.000Z", "markers": [{"name": "WBC", "key": "wbc", "value": 4.0, "unit": "x10E3/uL", "ref_low": 3.4, "ref_high": 10.8, "flag": null}, {"name": "RBC", "key": "rbc", "value": 4.18, "unit": "x10E6/uL", "ref_low": 4.14, "ref_high": 5.8, "flag": null}, {"name": "Hemoglobin", "key": "hemoglobin", "value": 13.1, "unit": "g/dL", "ref_low": 13.0, "ref_high": 17.7, "flag": null}, {"name": "Hematocrit", "key": "hematocrit", "value": 38.9, "unit": "%", "ref_low": 37.5, "ref_high": 51.0, "flag": null}, {"name": "MCV", "key": "mcv", "value": 93, "unit": "fL", "ref_low": 79, "ref_high": 97, "flag": null}, {"name": "MCH", "key": "mch", "value": 31.3, "unit": "pg", "ref_low": 26.6, "ref_high": 33.0, "flag": null}, {"name": "MCHC", "key": "mchc", "value": 33.7, "unit": "g/dL", "ref_low": 31.5, "ref_high": 35.7, "flag": null}, {"name": "RDW", "key": "rdw", "value": 12.4, "unit": "%", "ref_low": 11.6, "ref_high": 15.4, "flag": null}, {"name": "Platelets", "key": "platelets", "value": 261, "unit": "x10E3/uL", "ref_low": 150, "ref_high": 450, "flag": null}, {"name": "Neutrophils %", "key": "neutrophils_pct", "value": 35, "unit": "%", "ref_low": null, "ref_high": null, "flag": null}, {"name": "Lymphocytes %", "key": "lymphocytes_pct", "value": 47, "unit": "%", "ref_low": null, "ref_high": null, "flag": null}, {"name": "Monocytes %", "key": "monocytes_pct", "value": 12, "unit": "%", "ref_low": null, "ref_high": null, "flag": null}, {"name": "Eosinophils %", "key": "eosinophils_pct", "value": 5, "unit": "%", "ref_low": null, "ref_high": null, "flag": null}, {"name": "Basophils %", "key": "basophils_pct", "value": 1, "unit": "%", "ref_low": null, "ref_high": null, "flag": null}, {"name": "Neutrophils (Abs)", "key": "neutrophils_abs", "value": 1.4, "unit": "x10E3/uL", "ref_low": 1.4, "ref_high": 7.0, "flag": null}, {"name": "Lymphocytes (Abs)", "key": "lymphocytes_abs", "value": 1.9, "unit": "x10E3/uL", "ref_low": 0.7, "ref_high": 3.1, "flag": null}, {"name": "Monocytes (Abs)", "key": "monocytes_abs", "value": 0.5, "unit": "x10E3/uL", "ref_low": 0.1, "ref_high": 0.9, "flag": null}, {"name": "Eosinophils (Abs)", "key": "eosinophils_abs", "value": 0.2, "unit": "x10E3/uL", "ref_low": 0.0, "ref_high": 0.4, "flag": null}, {"name": "Basophils (Abs)", "key": "basophils_abs", "value": 0.0, "unit": "x10E3/uL", "ref_low": 0.0, "ref_high": 0.2, "flag": null}, {"name": "Immature Grans %", "key": "immature_grans_pct", "value": 0, "unit": "%", "ref_low": null, "ref_high": null, "flag": null}, {"name": "Immature Grans (Abs)", "key": "immature_grans_abs", "value": 0.0, "unit": "x10E3/uL", "ref_low": 0.0, "ref_high": 0.1, "flag": null}, {"name": "Glucose", "key": "glucose", "value": 94, "unit": "mg/dL", "ref_low": 70, "ref_high": 99, "flag": null}, {"name": "BUN", "key": "bun", "value": 22, "unit": "mg/dL", "ref_low": 6, "ref_high": 24, "flag": null}, {"name": "Creatinine", "key": "creatinine", "value": 1.24, "unit": "mg/dL", "ref_low": 0.76, "ref_high": 1.27, "flag": null}, {"name": "eGFR", "key": "egfr", "value": 71, "unit": "mL/min/1.73", "ref_low": 59, "ref_high": null, "flag": null}, {"name": "BUN/Creatinine Ratio", "key": "bun_creatinine_ratio", "value": 18, "unit": "", "ref_low": 9, "ref_high": 20, "flag": null}, {"name": "Sodium", "key": "sodium", "value": 141, "unit": "mmol/L", "ref_low": 134, "ref_high": 144, "flag": null}, {"name": "Potassium", "key": "potassium", "value": 5.1, "unit": "mmol/L", "ref_low": 3.5, "ref_high": 5.2, "flag": null}, {"name": "Chloride", "key": "chloride", "value": 104, "unit": "mmol/L", "ref_low": 96, "ref_high": 106, "flag": null}, {"name": "Carbon Dioxide", "key": "carbon_dioxide", "value": 27, "unit": "mmol/L", "ref_low": 20, "ref_high": 29, "flag": null}, {"name": "Calcium", "key": "calcium", "value": 9.9, "unit": "mg/dL", "ref_low": 8.7, "ref_high": 10.2, "flag": null}, {"name": "Total Protein", "key": "protein_total", "value": 6.8, "unit": "g/dL", "ref_low": 6.0, "ref_high": 8.5, "flag": null}, {"name": "Albumin", "key": "albumin", "value": 4.2, "unit": "g/dL", "ref_low": 4.1, "ref_high": 5.1, "flag": null}, {"name": "Globulin", "key": "globulin_total", "value": 2.6, "unit": "g/dL", "ref_low": 1.5, "ref_high": 4.5, "flag": null}, {"name": "Bilirubin", "key": "bilirubin", "value": 0.5, "unit": "mg/dL", "ref_low": 0.0, "ref_high": 1.2, "flag": null}, {"name": "Alkaline Phosphatase", "key": "alkaline_phosphatase", "value": 62, "unit": "IU/L", "ref_low": 44, "ref_high": 121, "flag": null}, {"name": "AST", "key": "ast", "value": 28, "unit": "IU/L", "ref_low": 0, "ref_high": 40, "flag": null}, {"name": "ALT", "key": "alt", "value": 24, "unit": "IU/L", "ref_low": 0, "ref_high": 44, "flag": null}, {"name": "Total Cholesterol", "key": "total_cholesterol", "value": 178, "unit": "mg/dL", "ref_low": 100, "ref_high": 199, "flag": null}, {"name": "Triglycerides", "key": "triglycerides", "value": 59, "unit": "mg/dL", "ref_low": 0, "ref_high": 149, "flag": null}, {"name": "HDL Cholesterol", "key": "hdl", "value": 73, "unit": "mg/dL", "ref_low": 39, "ref_high": null, "flag": null}, {"name": "VLDL Cholesterol", "key": "vldl", "value": 11, "unit": "mg/dL", "ref_low": 5, "ref_high": 40, "flag": null}, {"name": "LDL Cholesterol", "key": "ldl", "value": 94, "unit": "mg/dL", "ref_low": 0, "ref_high": 99, "flag": null}, {"name": "Chol/HDL Ratio", "key": "t_chol_hdl_ratio", "value": 2.4, "unit": "ratio", "ref_low": 0.0, "ref_high": 5.0, "flag": null}, {"name": "TSH", "key": "tsh", "value": 1.08, "unit": "uIU/mL", "ref_low": 0.45, "ref_high": 4.5, "flag": null}, {"name": "T3 Uptake", "key": "t3_uptake", "value": 27, "unit": "%", "ref_low": 24, "ref_high": 39, "flag": null}, {"name": "T4 Free Direct", "key": "t4_free", "value": 1.37, "unit": "ng/dL", "ref_low": 0.82, "ref_high": 1.77, "flag": null}, {"name": "Free T3", "key": "free_t3", "value": 3.1, "unit": "pg/mL", "ref_low": 2.0, "ref_high": 4.4, "flag": null}, {"name": "TIBC", "key": "iron_tibc", "value": 304, "unit": "ug/dL", "ref_low": 250, "ref_high": 450, "flag": null}, {"name": "Iron", "key": "iron", "value": 124, "unit": "ug/dL", "ref_low": 38, "ref_high": 169, "flag": null}, {"name": "Transferrin Sat", "key": "transferrin_sat", "value": 41, "unit": "%", "ref_low": 15, "ref_high": 55, "flag": null}, {"name": "Testosterone Total", "key": "testosterone_total", "value": 631, "unit": "ng/dL", "ref_low": 264, "ref_high": 916, "flag": null}, {"name": "SHBG", "key": "shbg", "value": 45.2, "unit": "nmol/L", "ref_low": 19.3, "ref_high": 76.4, "flag": null}, {"name": "Testosterone Free", "key": "testosterone_free", "value": 114.1, "unit": "pg/mL", "ref_low": 30.3, "ref_high": 183.2, "flag": null}, {"name": "DHEA-Sulfate", "key": "dhea_s", "value": 260.0, "unit": "ug/dL", "ref_low": 71.6, "ref_high": 375.4, "flag": null}, {"name": "Cortisol", "key": "cortisol", "value": 8.3, "unit": "ug/dL", "ref_low": 6.2, "ref_high": 19.4, "flag": null}, {"name": "Estradiol", "key": "estradiol", "value": 22.6, "unit": "pg/mL", "ref_low": 7.6, "ref_high": 42.6, "flag": null}, {"name": "Prolactin", "key": "prolactin", "value": 7.2, "unit": "ng/mL", "ref_low": 3.9, "ref_high": 22.7, "flag": null}, {"name": "IGF-1", "key": "igf1", "value": 176, "unit": "ng/mL", "ref_low": 81, "ref_high": 263, "flag": null}, {"name": "Vitamin B12", "key": "vitamin_b12", "value": 675, "unit": "pg/mL", "ref_low": 232, "ref_high": 1245, "flag": null}, {"name": "Folate", "key": "folate", "value": 20.0, "unit": "ng/mL", "ref_low": 3.0, "ref_high": null, "flag": null}, {"name": "PSA", "key": "psa", "value": 0.6, "unit": "ng/mL", "ref_low": 0.0, "ref_high": 4.0, "flag": null}, {"name": "HbA1c", "key": "hba1c", "value": 5.6, "unit": "%", "ref_low": 4.8, "ref_high": 5.6, "flag": null}, {"name": "Vitamin D", "key": "vitamin_d", "value": 60.4, "unit": "ng/mL", "ref_low": 30.0, "ref_high": 100.0, "flag": null}, {"name": "Lipoprotein (a)", "key": "lipoprotein_a", "value": 159.7, "unit": "nmol/L", "ref_low": null, "ref_high": 75.0, "flag": "H"}, {"name": "CRP Cardiac", "key": "crp", "value": 1.13, "unit": "mg/L", "ref_low": 0.0, "ref_high": 3.0, "flag": null}, {"name": "Magnesium", "key": "magnesium", "value": 2.0, "unit": "mg/dL", "ref_low": 1.6, "ref_high": 2.3, "flag": null}, {"name": "Insulin", "key": "insulin", "value": 2.4, "unit": "uIU/mL", "ref_low": 2.6, "ref_high": 24.9, "flag": "L"}, {"name": "Ferritin", "key": "ferritin", "value": 83, "unit": "ng/mL", "ref_low": 30, "ref_high": 400, "flag": null}, {"name": "Apolipoprotein B", "key": "apolipoprotein_b", "value": 71, "unit": "mg/dL", "ref_low": null, "ref_high": 90, "flag": null}, {"name": "Thyroglobulin Ab", "key": "thyroglobulin_ab", "value": 1.8, "unit": "IU/mL", "ref_low": 0.0, "ref_high": 0.9, "flag": "H"}, {"name": "Thyroglobulin", "key": "thyroglobulin", "value": 7.9, "unit": "ng/mL", "ref_low": 1.4, "ref_high": 29.2, "flag": null}, {"name": "PTH Intact", "key": "pth", "value": 33, "unit": "pg/mL", "ref_low": 15, "ref_high": 65, "flag": null}]}, {"id": 1000000002, "date": "2024-10-11", "lab": "Labcorp", "uploadedAt": "2024-10-11T00:00:00.000Z", "markers": [{"name": "WBC", "key": "wbc", "value": 4.4, "unit": "x10E3/uL", "ref_low": 3.4, "ref_high": 10.8, "flag": null}, {"name": "RBC", "key": "rbc", "value": 4.74, "unit": "x10E6/uL", "ref_low": 4.14, "ref_high": 5.8, "flag": null}, {"name": "Hemoglobin", "key": "hemoglobin", "value": 14.5, "unit": "g/dL", "ref_low": 13.0, "ref_high": 17.7, "flag": null}, {"name": "Hematocrit", "key": "hematocrit", "value": 44.5, "unit": "%", "ref_low": 37.5, "ref_high": 51.0, "flag": null}, {"name": "MCV", "key": "mcv", "value": 94, "unit": "fL", "ref_low": 79, "ref_high": 97, "flag": null}, {"name": "MCH", "key": "mch", "value": 30.6, "unit": "pg", "ref_low": 26.6, "ref_high": 33.0, "flag": null}, {"name": "MCHC", "key": "mchc", "value": 32.6, "unit": "g/dL", "ref_low": 31.5, "ref_high": 35.7, "flag": null}, {"name": "RDW", "key": "rdw", "value": 12.2, "unit": "%", "ref_low": 11.6, "ref_high": 15.4, "flag": null}, {"name": "Platelets", "key": "platelets", "value": 269, "unit": "x10E3/uL", "ref_low": 150, "ref_high": 450, "flag": null}, {"name": "Neutrophils %", "key": "neutrophils_pct", "value": 37, "unit": "%", "ref_low": null, "ref_high": null, "flag": null}, {"name": "Lymphocytes %", "key": "lymphocytes_pct", "value": 45, "unit": "%", "ref_low": null, "ref_high": null, "flag": null}, {"name": "Monocytes %", "key": "monocytes_pct", "value": 12, "unit": "%", "ref_low": null, "ref_high": null, "flag": null}, {"name": "Eosinophils %", "key": "eosinophils_pct", "value": 5, "unit": "%", "ref_low": null, "ref_high": null, "flag": null}, {"name": "Basophils %", "key": "basophils_pct", "value": 1, "unit": "%", "ref_low": null, "ref_high": null, "flag": null}, {"name": "Neutrophils (Abs)", "key": "neutrophils_abs", "value": 1.6, "unit": "x10E3/uL", "ref_low": 1.4, "ref_high": 7.0, "flag": null}, {"name": "Lymphocytes (Abs)", "key": "lymphocytes_abs", "value": 2.0, "unit": "x10E3/uL", "ref_low": 0.7, "ref_high": 3.1, "flag": null}, {"name": "Monocytes (Abs)", "key": "monocytes_abs", "value": 0.5, "unit": "x10E3/uL", "ref_low": 0.1, "ref_high": 0.9, "flag": null}, {"name": "Eosinophils (Abs)", "key": "eosinophils_abs", "value": 0.2, "unit": "x10E3/uL", "ref_low": 0.0, "ref_high": 0.4, "flag": null}, {"name": "Basophils (Abs)", "key": "basophils_abs", "value": 0.0, "unit": "x10E3/uL", "ref_low": 0.0, "ref_high": 0.2, "flag": null}, {"name": "Immature Grans %", "key": "immature_grans_pct", "value": 0, "unit": "%", "ref_low": null, "ref_high": null, "flag": null}, {"name": "Immature Grans (Abs)", "key": "immature_grans_abs", "value": 0.0, "unit": "x10E3/uL", "ref_low": 0.0, "ref_high": 0.1, "flag": null}, {"name": "Glucose", "key": "glucose", "value": 83, "unit": "mg/dL", "ref_low": 70, "ref_high": 99, "flag": null}, {"name": "BUN", "key": "bun", "value": 26, "unit": "mg/dL", "ref_low": 6, "ref_high": 24, "flag": "H"}, {"name": "Creatinine", "key": "creatinine", "value": 1.13, "unit": "mg/dL", "ref_low": 0.76, "ref_high": 1.27, "flag": null}, {"name": "eGFR", "key": "egfr", "value": 79, "unit": "mL/min/1.73", "ref_low": 59, "ref_high": null, "flag": null}, {"name": "BUN/Creatinine Ratio", "key": "bun_creatinine_ratio", "value": 23, "unit": "", "ref_low": 9, "ref_high": 20, "flag": "H"}, {"name": "Sodium", "key": "sodium", "value": 139, "unit": "mmol/L", "ref_low": 134, "ref_high": 144, "flag": null}, {"name": "Potassium", "key": "potassium", "value": 4.8, "unit": "mmol/L", "ref_low": 3.5, "ref_high": 5.2, "flag": null}, {"name": "Chloride", "key": "chloride", "value": 99, "unit": "mmol/L", "ref_low": 96, "ref_high": 106, "flag": null}, {"name": "Carbon Dioxide", "key": "carbon_dioxide", "value": 27, "unit": "mmol/L", "ref_low": 20, "ref_high": 29, "flag": null}, {"name": "Calcium", "key": "calcium", "value": 10.6, "unit": "mg/dL", "ref_low": 8.7, "ref_high": 10.2, "flag": "H"}, {"name": "Total Protein", "key": "protein_total", "value": 7.5, "unit": "g/dL", "ref_low": 6.0, "ref_high": 8.5, "flag": null}, {"name": "Albumin", "key": "albumin", "value": 4.7, "unit": "g/dL", "ref_low": 4.1, "ref_high": 5.1, "flag": null}, {"name": "Globulin", "key": "globulin_total", "value": 2.8, "unit": "g/dL", "ref_low": 1.5, "ref_high": 4.5, "flag": null}, {"name": "Bilirubin", "key": "bilirubin", "value": 0.4, "unit": "mg/dL", "ref_low": 0.0, "ref_high": 1.2, "flag": null}, {"name": "Alkaline Phosphatase", "key": "alkaline_phosphatase", "value": 57, "unit": "IU/L", "ref_low": 44, "ref_high": 121, "flag": null}, {"name": "AST", "key": "ast", "value": 22, "unit": "IU/L", "ref_low": 0, "ref_high": 40, "flag": null}, {"name": "ALT", "key": "alt", "value": 17, "unit": "IU/L", "ref_low": 0, "ref_high": 44, "flag": null}, {"name": "Total Cholesterol", "key": "total_cholesterol", "value": 243, "unit": "mg/dL", "ref_low": 100, "ref_high": 199, "flag": "H"}, {"name": "Triglycerides", "key": "triglycerides", "value": 76, "unit": "mg/dL", "ref_low": 0, "ref_high": 149, "flag": null}, {"name": "HDL Cholesterol", "key": "hdl", "value": 77, "unit": "mg/dL", "ref_low": 39, "ref_high": null, "flag": null}, {"name": "VLDL Cholesterol", "key": "vldl", "value": 13, "unit": "mg/dL", "ref_low": 5, "ref_high": 40, "flag": null}, {"name": "LDL Cholesterol", "key": "ldl", "value": 153, "unit": "mg/dL", "ref_low": 0, "ref_high": 99, "flag": "H"}, {"name": "Chol/HDL Ratio", "key": "t_chol_hdl_ratio", "value": 3.2, "unit": "ratio", "ref_low": 0.0, "ref_high": 5.0, "flag": null}, {"name": "TSH", "key": "tsh", "value": 1.64, "unit": "uIU/mL", "ref_low": 0.45, "ref_high": 4.5, "flag": null}, {"name": "T3 Uptake", "key": "t3_uptake", "value": 28, "unit": "%", "ref_low": 24, "ref_high": 39, "flag": null}, {"name": "T4 Free Direct", "key": "t4_free", "value": 1.68, "unit": "ng/dL", "ref_low": 0.82, "ref_high": 1.77, "flag": null}, {"name": "Free T3", "key": "free_t3", "value": 3.2, "unit": "pg/mL", "ref_low": 2.0, "ref_high": 4.4, "flag": null}, {"name": "TIBC", "key": "iron_tibc", "value": 336, "unit": "ug/dL", "ref_low": 250, "ref_high": 450, "flag": null}, {"name": "Iron", "key": "iron", "value": 103, "unit": "ug/dL", "ref_low": 38, "ref_high": 169, "flag": null}, {"name": "Transferrin Sat", "key": "transferrin_sat", "value": 31, "unit": "%", "ref_low": 15, "ref_high": 55, "flag": null}, {"name": "Testosterone Total", "key": "testosterone_total", "value": 614, "unit": "ng/dL", "ref_low": 264, "ref_high": 916, "flag": null}, {"name": "SHBG", "key": "shbg", "value": 45.0, "unit": "nmol/L", "ref_low": 19.3, "ref_high": 76.4, "flag": null}, {"name": "Testosterone Free", "key": "testosterone_free", "value": 104.9, "unit": "pg/mL", "ref_low": 30.3, "ref_high": 183.2, "flag": null}, {"name": "DHEA-Sulfate", "key": "dhea_s", "value": 111.0, "unit": "ug/dL", "ref_low": 71.6, "ref_high": 375.4, "flag": null}, {"name": "Cortisol", "key": "cortisol", "value": 16.0, "unit": "ug/dL", "ref_low": 6.2, "ref_high": 19.4, "flag": null}, {"name": "Estradiol", "key": "estradiol", "value": 9.7, "unit": "pg/mL", "ref_low": 7.6, "ref_high": 42.6, "flag": null}, {"name": "Vitamin B12", "key": "vitamin_b12", "value": 699, "unit": "pg/mL", "ref_low": 232, "ref_high": 1245, "flag": null}, {"name": "Folate", "key": "folate", "value": 10.2, "unit": "ng/mL", "ref_low": 3.0, "ref_high": null, "flag": null}, {"name": "PSA", "key": "psa", "value": 0.5, "unit": "ng/mL", "ref_low": 0.0, "ref_high": 4.0, "flag": null}, {"name": "HbA1c", "key": "hba1c", "value": 5.5, "unit": "%", "ref_low": 4.8, "ref_high": 5.6, "flag": null}, {"name": "Vitamin D", "key": "vitamin_d", "value": 44.8, "unit": "ng/mL", "ref_low": 30.0, "ref_high": 100.0, "flag": null}, {"name": "Lipoprotein (a)", "key": "lipoprotein_a", "value": 123.2, "unit": "nmol/L", "ref_low": null, "ref_high": 75.0, "flag": "H"}, {"name": "CRP Cardiac", "key": "crp", "value": 0.46, "unit": "mg/L", "ref_low": 0.0, "ref_high": 3.0, "flag": null}, {"name": "Magnesium", "key": "magnesium", "value": 2.1, "unit": "mg/dL", "ref_low": 1.6, "ref_high": 2.3, "flag": null}, {"name": "Insulin", "key": "insulin", "value": 2.1, "unit": "uIU/mL", "ref_low": 2.6, "ref_high": 24.9, "flag": "L"}, {"name": "Ferritin", "key": "ferritin", "value": 88, "unit": "ng/mL", "ref_low": 30, "ref_high": 400, "flag": null}, {"name": "Free T3", "key": "free_t3", "value": 3.2, "unit": "pg/mL", "ref_low": 2.0, "ref_high": 4.4, "flag": null}, {"name": "Apolipoprotein B", "key": "apolipoprotein_b", "value": 117, "unit": "mg/dL", "ref_low": null, "ref_high": 90, "flag": "H"}]}, {"id": 1000000001, "date": "2011-01-08", "lab": "Quest Diagnostics", "uploadedAt": "2011-01-08T00:00:00.000Z", "markers": [{"name": "Total Cholesterol", "key": "total_cholesterol", "value": 189, "unit": "mg/dL", "ref_low": 125, "ref_high": 200, "flag": null}, {"name": "HDL Cholesterol", "key": "hdl", "value": 68, "unit": "mg/dL", "ref_low": 40, "ref_high": null, "flag": null}, {"name": "Triglycerides", "key": "triglycerides", "value": 78, "unit": "mg/dL", "ref_low": null, "ref_high": 150, "flag": null}, {"name": "LDL Cholesterol", "key": "ldl", "value": 105, "unit": "mg/dL", "ref_low": null, "ref_high": 130, "flag": null}, {"name": "Chol/HDL Ratio", "key": "t_chol_hdl_ratio", "value": 2.8, "unit": "", "ref_low": null, "ref_high": 5.0, "flag": null}]}];
    saveBloodResults(seeded);
  } catch(e) {}
}

function migrateBloodKeys() {
  try {
    var results = getStorage('bloodResults', []);
    if (!Array.isArray(results) || !results.length) return;
    var changed = false;
    results = results.map(function(entry) {
      if (!entry || !entry.markers) return entry;
      var normalized = normalizeBloodMarkers(entry.markers);
      if (JSON.stringify(normalized) !== JSON.stringify(entry.markers)) changed = true;
      return Object.assign({}, entry, {markers: normalized});
    });
    if (changed) setStorage('bloodResults', results);
  } catch(e) {}
}

const PANEL_LABELS = {
  blood_glucose: '🩸 Blood Glucose',
  renal:         '🫘 Renal',
  prostate:      '🔬 Prostate',
  electrolytes:  '⚡ Electrolytes',
  proteins:      '🧬 Proteins',
  minerals:      '💎 Minerals',
  liver_gb:      '🫀 Liver & GB',
  iron_markers:  '🔴 Iron Markers',
  lipids:        '❤️ Lipids',
  lipoproteins:  '💔 Lipoproteins',
  thyroid:       '🦋 Thyroid',
  inflammation:  '🔥 Inflammation',
  vitamins:      '💊 Vitamins',
  hormones:      '⚡ Hormones',
  cbc:           '🩺 CBC',
  wbcs:          '🛡️ WBCs',
};

// Markers where LOWER is better (used for trend direction color)
const LOWER_BETTER = new Set(['ldl','triglycerides','total_cholesterol','glucose','crp','uric_acid',
  'hba1c','cortisol','insulin','lipoprotein_a','apolipoprotein_b','non_hdl','vldl','bun','psa',
  'eag','bun_creatinine_ratio','t_chol_hdl_ratio','ferritin','transferrin_sat']);

// Markers where HIGHER is better
const HIGHER_BETTER = new Set(['hdl','egfr','vitamin_d','vitamin_b12','testosterone_total',
  'testosterone_free','testosterone_bio','ferritin','rbc','hemoglobin','hematocrit','dhea_s','free_t3','folate',
  'albumin','protein_total']);

// 5-tier status: ok (optimal), above_opt, below_opt, high (out of standard), low (out of standard)
// Returns simplified: ok, warn, bad
function bloodStatus(key, value) {
  const ref = BLOOD_REFS[key];
  if (!ref) return 'ok';
  const [optLo, optHi, stdLo, stdHi] = ref;
  if (value < stdLo || value > stdHi) return 'bad';        // outside standard range
  if (value >= optLo && value <= optHi) return 'ok';         // optimal
  return 'warn';                                              // between standard & optimal
}

// Detailed 5-tier status for range bar coloring
function bloodStatus5(key, value) {
  const ref = BLOOD_REFS[key];
  if (!ref) return 'optimal';
  const [optLo, optHi, stdLo, stdHi] = ref;
  if (value < stdLo) return 'alarm_low';
  if (value > stdHi) return 'alarm_high';
  if (value < optLo) return 'below_optimal';
  if (value > optHi) return 'above_optimal';
  return 'optimal';
}



function buildBloodParsePrompt() {
  return [
    'You are a medical lab results parser. Extract ALL test results from the lab report.',
    'Output ONLY a single valid JSON object. No markdown, no code fences, no explanation, no text before or after.',
    'Numeric values must be numbers not strings.',
    'ref_low and ref_high must be numbers. If only one bound exists use null for the other.',
    'flag must be exactly H, L, or null (JSON null not the string null).',
    'key must be lowercase snake_case. Use EXACTLY these canonical keys (pick the closest match):',
    'glucose hba1c eag bun creatinine egfr bun_creatinine_ratio sodium potassium chloride carbon_dioxide calcium magnesium',
    'protein_total albumin globulin_total albumin_globulin',
    'total_cholesterol ldl hdl triglycerides vldl non_hdl t_chol_hdl_ratio lipoprotein_a apolipoprotein_b',
    'testosterone_total testosterone_free testosterone_bio shbg estradiol cortisol dhea_s psa igf1 insulin prolactin pth',
    'tsh t4_free t4_total free_t3 t3_uptake free_thyroxine_index thyroglobulin_abs thyroglobulin free_t3_free_t4',
    'wbc rbc hemoglobin hematocrit mcv mch mchc rdw platelets',
    'neutrophils_pct lymphocytes_pct monocytes_pct eosinophils_pct basophils_pct',
    'neutrophils_abs lymphocytes_abs monocytes_abs eosinophils_abs basophils_abs',
    'immature_grans_pct immature_grans_abs',
    'alt ast alkaline_phosphatase ggt bilirubin albumin protein_total globulin_total albumin_globulin',
    'crp ferritin iron iron_tibc uibc transferrin_sat vitamin_d vitamin_b12 folate',
    'OUTPUT FORMAT (return exactly this structure):',
    '{"test_date":"YYYY-MM-DD","lab_name":"string","markers":[{"name":"string","key":"canonical_key","value":0,"unit":"string","ref_low":0,"ref_high":0,"flag":null}]}',
    'Extract every single marker. Do not skip any. Do not add any text outside the JSON.',
  ].join(' ');
}

function _freeCacheSpace() {
  // Safe-to-drop caches, largest first — regenerated automatically
  ['trendsCache', 'bodyCompCache', 'favCache', 'trainingLoadCache', 'dailyQuote',
   'greetingCache', 'weeklyNarrative', 'brief_cache', 'tpToday'].forEach(k => {
    try { localStorage.removeItem(k); } catch(_) {}
  });
}

function _localStorageTopKeys(n) {
  try {
    const sizes = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      sizes.push([k, (localStorage.getItem(k) || '').length]);
    }
    sizes.sort((a, b) => b[1] - a[1]);
    const total = sizes.reduce((s, x) => s + x[1], 0);
    return { totalKB: Math.round(total / 1024), top: sizes.slice(0, n).map(([k, v]) => `${k}:${Math.round(v / 1024)}KB`) };
  } catch(_) { return null; }
}

async function saveBloodEntry(parsed) {
  const testDate = parsed.test_date || new Date().toISOString().slice(0,10);
  const results = getBloodResults();
  const newEntry = {
    id: Date.now(),
    date: testDate,
    lab: parsed.lab_name || 'Lab Results',
    markers: normalizeBloodMarkers(parsed.markers || []),
    uploadedAt: new Date().toISOString(),
  };
  results.unshift(newEntry);
  let ok = saveBloodResults(results);
  if (!ok) {
    // Device storage full — drop regenerable caches and retry
    _freeCacheSpace();
    ok = saveBloodResults(results);
  }
  if (!ok) {
    // Last resort: persist server-side directly so the record is never lost
    const usage = _localStorageTopKeys(6);
    reportClientError('blood_quota', new Error('localStorage quota exceeded'), usage || {});
    try {
      const res = await fetch('/api/log/blood', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ entries: [{ date: newEntry.date, entry_id: String(newEntry.id), payload: newEntry, updated_at: Date.now(), deleted: 0 }] })
      });
      const d = await res.json();
      if (d.ok && d.applied) throw new Error('Phone storage is full — the record was saved to the cloud and will appear after you free up space (Settings → sync)');
    } catch (e) { if (/saved to the cloud/.test(e.message)) throw e; }
    throw new Error('Phone storage is full and the cloud save failed — free up space and try again');
  }
  return newEntry;
}

function toggleBloodPaste() {
  const area = document.getElementById('bloodPasteArea');
  area.style.display = area.style.display === 'none' ? 'block' : 'none';
}

async function analyzeBloodPasteText() {
  const text = (document.getElementById('bloodPasteText')?.value || '').trim();
  if (!text) { showToast('Please paste your lab report text first'); return; }
  
  const status = document.getElementById('bloodUploadStatus');
  const btn = document.querySelector('[onclick="analyzeBloodPasteText()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Analyzing…'; }
  status.style.display = 'block';
  status.style.color = 'var(--text2)';
  status.textContent = 'AI is reading your pasted lab results…';

  try {
    const data = await callClaudeAPIAsync({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      messages: [{ role: 'user', content: buildBloodParsePrompt() + '\n\nLAB REPORT TEXT:\n' + text }]
    }, s => { status.textContent = `⏳ Analyzing on the server… ${s}s (safe to keep waiting)`; });
    if (data.error) throw new Error('API: ' + (data.error.message || JSON.stringify(data.error)));
    const rawText = data.content?.[0]?.text || '';
    // Sanitize common Claude JSON quirks before parsing
    let raw = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    // Remove any text before the first { or after the last }
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace > 0 || lastBrace < raw.length - 1) raw = raw.slice(firstBrace, lastBrace + 1);
    // Fix "null" string flags to JSON null
    raw = raw.replace(/"flag"\s*:\s*"null"/g, '"flag":null');
    // Fix truncated JSON by attempting to close unclosed arrays/objects
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch(jsonErr) {
      // Try to salvage truncated response by closing open structures
      let fixed = raw;
      const opens = (fixed.match(/\[/g)||[]).length - (fixed.match(/\]/g)||[]).length;
      const openBraces = (fixed.match(/\{/g)||[]).length - (fixed.match(/\}/g)||[]).length;
      // Remove trailing incomplete object (last comma + anything after)
      fixed = fixed.replace(/,\s*\{[^}]*$/, '');
      for (let i = 0; i < opens; i++) fixed += ']';
      for (let i = 0; i < openBraces; i++) fixed += '}';
      try {
        parsed = JSON.parse(fixed);
      } catch {
        throw new Error('JSON parse failed (pos ' + jsonErr.message + '). Got: ' + rawText.slice(0, 300));
      }
    }
    if (!parsed.markers?.length) throw new Error('No markers found in response');
    const newEntry = await saveBloodEntry(parsed);
    status.textContent = '✅ Imported ' + newEntry.markers.length + ' markers from ' + newEntry.date;
    document.getElementById('bloodPasteArea').style.display = 'none';
    document.getElementById('bloodPasteText').value = '';
    renderBloodWorkPage();
    generateBloodAIInsights(newEntry);
  } catch(e) {
    status.textContent = '❌ Could not parse. Check the pasted text and try again.';
    status.style.color = '#ef4444';
    if (btn) { btn.disabled = false; btn.textContent = '🤖 Analyze Pasted Text'; }
  }
}

async function analyzeBloodReport() {
  if (!_bloodFileData) return;
  const btn    = document.getElementById('bloodAnalyzeBtn');
  const status = document.getElementById('bloodUploadStatus');
  btn.disabled = true;
  status.style.display = 'block';
  status.style.color = 'var(--text2)';

  try {
    let msgContent;
    if (_bloodFileData.extractedText) {
      status.textContent = '⏳ Sending extracted text to Claude…';
      btn.textContent = '⏳ Analyzing…';
      msgContent = buildBloodParsePrompt() + `\n\nLAB REPORT TEXT:\n` + _bloodFileData.extractedText;
    } else if (_bloodFileData.base64 && _bloodFileData.mediaType === 'application/pdf') {
      status.textContent = '⏳ Sending PDF to Claude…';
      btn.textContent = '⏳ Analyzing…';
      msgContent = [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: _bloodFileData.base64 } },
        { type: 'text', text: buildBloodParsePrompt() }
      ];
    } else {
      status.textContent = '⏳ Sending image to Claude…';
      btn.textContent = '⏳ Analyzing…';
      msgContent = [
        { type: 'image', source: { type: 'base64', media_type: _bloodFileData.mediaType, data: _bloodFileData.base64 } },
        { type: 'text', text: buildBloodParsePrompt() }
      ];
    }

    const data = await callClaudeAPIAsync({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      messages: [{ role: 'user', content: msgContent }]
    }, s => { status.textContent = `⏳ Analyzing on the server… ${s}s (safe to keep waiting)`; });

    // Surface API-level errors
    if (data.error) throw new Error('API: ' + (data.error.message || JSON.stringify(data.error)));

    const rawText = data.content?.[0]?.text || '';
    if (!rawText) throw new Error('Empty response from Claude. Full response: ' + JSON.stringify(data));

    // Strip markdown fences robustly
    const raw = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch(jsonErr) {
      // Try to extract JSON object from response if Claude added extra text
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        throw new Error('JSON parse failed. Claude said: ' + rawText.slice(0, 200));
      }
    }

    if (!parsed.markers || !parsed.markers.length) throw new Error('No markers found in response');

    const newEntry = await saveBloodEntry(parsed);
    btn.style.display = 'none';
    document.getElementById('bloodUploadName').textContent = '';
    _bloodFileData = null;
    document.getElementById('bloodFileInput').value = '';
    status.textContent = '✅ Imported ' + newEntry.markers.length + ' markers from ' + newEntry.date;
    status.style.color = '#22c55e';
    renderBloodWorkPage();
    generateBloodAIInsights(newEntry);

  } catch(e) {
    console.error('Blood parse error:', e);
    reportClientError('blood_analyze', e, { fileType: _bloodFileData?.mediaType, hasText: !!_bloodFileData?.extractedText, textLen: (_bloodFileData?.extractedText || '').length, b64Len: (_bloodFileData?.base64 || '').length });
    btn.disabled = false;
    btn.textContent = '🤖 Analyze with AI';
    status.style.color = '#ef4444';
    const netFail = e instanceof TypeError || /failed to fetch|load failed/i.test(e.message || '');
    status.textContent = netFail
      ? '❌ Network error [build ' + BUILD_ID + '] — details reported, tap Analyze to retry'
      : '❌ ' + (e.message || 'Unknown error');
  }
}

// Fire-and-forget error telemetry so failures on the phone are debuggable
function reportClientError(kind, err, extra) {
  try {
    fetch('/api/debug/client', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({
        kind, build: BUILD_ID,
        message: String(err?.message || err).slice(0, 300),
        name: err?.name, stack: String(err?.stack || '').slice(0, 500),
        online: navigator.onLine, swController: !!navigator.serviceWorker?.controller,
        ua: navigator.userAgent.slice(0, 120), ...extra,
      })
    }).catch(() => {});
  } catch(_) {}
}

function renderBloodWorkPage() {
  const results = getBloodResults();
  const container = document.getElementById('bloodResultsList');
  if (!container) return;

  if (results.length === 0) {
    container.innerHTML = '<div class="empty-state">No blood work uploaded yet.<br>Upload your first lab report above.</div>';
    return;
  }

  const dateOptions = results.map((r,i) =>
    `<option value="${i}" ${i===0?'selected':''}>${r.date} — ${r.lab} (${r.markers.length} markers)</option>`
  ).join('');

  container.innerHTML = `
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <div class="card-label" style="color:#ef4444;margin:0;flex:1">📅 Lab Result</div>
        <div style="display:flex;gap:6px">
          <button id="bview-panels" class="bview-btn active" onclick="setBloodView('panels')">Panels</button>
          <button id="bview-trends" class="bview-btn" onclick="setBloodView('trends')">Trends</button>
          <button id="bview-table"  class="bview-btn" onclick="setBloodView('table')">Compare</button>
        </div>
      </div>
      <select id="bloodDateSelect" onchange="renderBloodPanels(parseInt(this.value))"
        style="width:100%;background:var(--surface2);border:1.5px solid var(--border);border-radius:10px;padding:10px;color:var(--text);font-size:13px;font-family:inherit">
        ${dateOptions}
      </select>
    </div>
    <div id="bloodSummaryBar"></div>
    <div id="bloodOOBStrip"></div>
    <div id="bloodPanelsContainer"></div>
    <div id="bloodTrendContainer" style="margin-top:4px"></div>
    <div id="bloodTableContainer" style="display:none"></div>
  `;

  window._bloodView = 'panels';
  renderBloodPanels(0);
}

function setBloodView(view) {
  window._bloodView = view;
  ['panels','trends','table'].forEach(v => {
    const btn = document.getElementById('bview-'+v);
    if (btn) btn.classList.toggle('active', v === view);
  });
  const idx = parseInt(document.getElementById('bloodDateSelect')?.value || '0');
  renderBloodPanels(idx);
}

function rangeBar(key, value) {
  const ref = BLOOD_REFS[key];
  if (!ref) return '';
  const [optLo, optHi, stdLo, stdHi] = ref;

  // Display range with padding beyond standard
  const stdRange = stdHi - stdLo || 1;
  const pad = stdRange * 0.15;
  const dispLo = Math.max(0, stdLo - pad);
  const dispHi = stdHi + pad;
  const dispRange = dispHi - dispLo || 1;

  const toPct = v => Math.max(0, Math.min(100, ((v - dispLo) / dispRange * 100)));

  // Zone positions
  const stdLoPct = toPct(stdLo);
  const optLoPct = toPct(optLo);
  const optHiPct = toPct(optHi);
  const stdHiPct = toPct(stdHi);

  // Dot position
  const clampedVal = Math.max(dispLo, Math.min(dispHi, value));
  const dotPct = toPct(clampedVal);
  const status = bloodStatus(key, value);
  const dotColor = {ok:'#22c55e',warn:'#f59e0b',bad:'#ef4444'}[status];

  // 5-zone gradient bar
  return `<div class="blood-range-bar">
    <div class="blood-range-zone" style="left:0;width:${stdLoPct}%;background:#ef4444;opacity:0.15;border-radius:3px 0 0 3px"></div>
    <div class="blood-range-zone" style="left:${stdLoPct}%;width:${Math.max(0,optLoPct-stdLoPct)}%;background:#f59e0b;opacity:0.2"></div>
    <div class="blood-range-zone" style="left:${optLoPct}%;width:${Math.max(0,optHiPct-optLoPct)}%;background:#22c55e;opacity:0.25"></div>
    <div class="blood-range-zone" style="left:${optHiPct}%;width:${Math.max(0,stdHiPct-optHiPct)}%;background:#f59e0b;opacity:0.2"></div>
    <div class="blood-range-zone" style="left:${stdHiPct}%;width:${100-stdHiPct}%;background:#ef4444;opacity:0.15;border-radius:0 3px 3px 0"></div>
    <div class="blood-range-dot" style="left:${dotPct}%;background:${dotColor}"></div>
  </div>`;
}

function trendBadge(key, hist, currentVal) {
  if (!hist || hist.length < 2) return '';
  const sorted = [...hist].sort((a,b) => a.date.localeCompare(b.date));
  const prev = sorted[sorted.length - 2].value;
  const pct = ((currentVal - prev) / prev * 100);
  if (Math.abs(pct) < 0.5) return '<span class="blood-marker-trend neut">→ stable</span>';
  const up = currentVal > prev;
  const lowerBetter = LOWER_BETTER.has(key);
  const higherBetter = HIGHER_BETTER.has(key);
  const good = lowerBetter ? !up : higherBetter ? up : null;
  const cls = good === true ? 'good' : good === false ? 'bad' : 'neut';
  const arrow = up ? '↑' : '↓';
  return `<span class="blood-marker-trend ${cls}">${arrow} ${Math.abs(pct).toFixed(1)}%</span>`;
}

function renderBloodPanels(idx) {
  const results = getBloodResults();
  const entry = results[idx];
  if (!entry) return;

  // Build history map
  const history = {};
  results.forEach(r => {
    r.markers.forEach(m => {
      if (!history[m.key]) history[m.key] = [];
      history[m.key].push({ date: r.date, value: m.value });
    });
  });

  const view = window._bloodView || 'panels';

  // ── SUMMARY BAR ─────────────────────────────────────
  const allStatuses5 = entry.markers.map(m => bloodStatus5(m.key, m.value));
  const alarmLow  = allStatuses5.filter(s => s === 'alarm_low').length;
  const belowOpt  = allStatuses5.filter(s => s === 'below_optimal').length;
  const optimal   = allStatuses5.filter(s => s === 'optimal').length;
  const aboveOpt  = allStatuses5.filter(s => s === 'above_optimal').length;
  const alarmHigh = allStatuses5.filter(s => s === 'alarm_high').length;
  const totalM    = entry.markers.length;
  const summaryEl = document.getElementById('bloodSummaryBar');
  if (summaryEl) summaryEl.innerHTML = `
    <div style="display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap;justify-content:center">
      <div class="blood-summary-tile" style="flex:1;min-width:55px;border:1.5px solid #ef444430">
        <div class="blood-summary-num" style="color:#ef4444;font-size:18px">${alarmLow}</div>
        <div class="blood-summary-lbl" style="font-size:8px">Low</div>
      </div>
      <div class="blood-summary-tile" style="flex:1;min-width:55px;border:1.5px solid #60a5fa30">
        <div class="blood-summary-num" style="color:#60a5fa;font-size:18px">${belowOpt}</div>
        <div class="blood-summary-lbl" style="font-size:8px">Below Opt</div>
      </div>
      <div class="blood-summary-tile" style="flex:1;min-width:55px;border:1.5px solid #22c55e30">
        <div class="blood-summary-num" style="color:#22c55e;font-size:18px">${optimal}</div>
        <div class="blood-summary-lbl" style="font-size:8px">Optimal</div>
      </div>
      <div class="blood-summary-tile" style="flex:1;min-width:55px;border:1.5px solid #f59e0b30">
        <div class="blood-summary-num" style="color:#f59e0b;font-size:18px">${aboveOpt}</div>
        <div class="blood-summary-lbl" style="font-size:8px">Above Opt</div>
      </div>
      <div class="blood-summary-tile" style="flex:1;min-width:55px;border:1.5px solid #ef444430">
        <div class="blood-summary-num" style="color:#ef4444;font-size:18px">${alarmHigh}</div>
        <div class="blood-summary-lbl" style="font-size:8px">High</div>
      </div>
      <div class="blood-summary-tile" style="flex:1;min-width:55px;border:1.5px solid var(--border)">
        <div class="blood-summary-num" style="color:var(--text);font-size:18px">${totalM}</div>
        <div class="blood-summary-lbl" style="font-size:8px">Total</div>
      </div>
    </div>`;

  // ── NEEDS ATTENTION (Collapsible) ────────────────────
  const oobEl = document.getElementById('bloodOOBStrip');
  const flagged = entry.markers.filter(m => {
    const s = bloodStatus(m.key, m.value);
    return s === 'bad' || s === 'warn';
  }).sort((a,b) => {
    const sa = bloodStatus(a.key, a.value), sb = bloodStatus(b.key, b.value);
    if (sa === 'bad' && sb !== 'bad') return -1;
    if (sb === 'bad' && sa !== 'bad') return 1;
    return 0;
  });

  if (oobEl && flagged.length > 0) {
    const attnCards = flagged.map(m => {
      const status = bloodStatus(m.key, m.value);
      const ref = BLOOD_REFS[m.key];
      const name = ref?.[5] || m.name;
      const unit = m.unit || ref?.[4] || '';
      const sevClass = status === 'bad' ? 'severity-bad' : 'severity-warn';
      const nameClass = status === 'bad' ? 'bad' : 'warn';
      const valClass = nameClass;
      const panelKey = ref ? ref[6] : 'other';
      const panelName = PANEL_LABELS[panelKey] || 'Other';
      const trend = trendBadge(m.key, history[m.key], m.value);
      const bar = ref ? rangeBar(m.key, m.value) : '';
      const optText = ref ? `Optimal: ${ref[0]}–${ref[1]}` : '';
      const stdText = ref ? `Standard: ${ref[2]}–${ref[3]}` : '';
      return `<div class="blood-attn-card ${sevClass}">
        <div class="blood-attn-top">
          <div>
            <div class="blood-attn-name ${nameClass}">${name}</div>
            <div class="blood-attn-panel-tag">${panelName.replace(/^.+\s/,'')}</div>
          </div>
          <div class="blood-attn-value-block">
            <div class="blood-attn-value ${valClass}">${m.value}</div>
            <div class="blood-attn-unit">${unit}</div>
            ${trend ? `<div style="margin-top:4px">${trend}</div>` : ''}
          </div>
        </div>
        ${bar}
        <div class="blood-attn-ref-row">
          ${optText ? `<span class="blood-attn-ref-tag opt">${optText}</span>` : ''}
          ${stdText ? `<span class="blood-attn-ref-tag std">${stdText}</span>` : ''}
        </div>
      </div>`;
    }).join('');

    oobEl.innerHTML = `
      <div class="blood-attn-header expanded" onclick="(function(el){var b=el.nextElementSibling;var open=b.style.display!=='none';b.style.display=open?'none':'';el.classList.toggle('expanded',!open);el.querySelector('.blood-attn-chevron').classList.toggle('collapsed',open)})(this)">
        <div class="blood-attn-header-left">
          <span class="blood-attn-count">${flagged.length}</span>
          <span class="blood-attn-title">Needs Attention</span>
        </div>
        <span class="blood-attn-chevron">▼</span>
      </div>
      <div class="blood-attn-body">${attnCards}</div>`;
  } else if (oobEl) {
    oobEl.innerHTML = `<div style="background:#0d2d1a;border:1px solid #22c55e30;border-radius:14px;padding:12px 16px;margin-bottom:12px;font-size:13px;font-weight:700;color:#22c55e;text-align:center">✅ All markers within optimal range</div>`;
  }

  // ── PANELS VIEW ──────────────────────────────────────
  const panelsEl  = document.getElementById('bloodPanelsContainer');
  const trendsEl  = document.getElementById('bloodTrendContainer');
  const tableEl   = document.getElementById('bloodTableContainer');

  panelsEl.style.display  = view === 'panels'  ? '' : 'none';
  trendsEl.style.display  = view === 'trends'  ? '' : 'none';
  tableEl.style.display   = view === 'table'   ? '' : 'none';

  if (view === 'panels') {
    const panels = {};
    entry.markers.forEach(m => {
      const ref = BLOOD_REFS[m.key];
      const panel = ref ? ref[6] : 'other';
      if (!panels[panel]) panels[panel] = [];
      panels[panel].push(m);
    });

    const panelOrder = ['blood_glucose','renal','prostate','electrolytes','proteins','minerals','liver_gb','iron_markers','lipids','lipoproteins','thyroid','inflammation','vitamins','hormones','cbc','wbcs','other'];
    panelsEl.innerHTML = panelOrder.filter(p => panels[p]).map(panel => {
      const markers = panels[panel];
      const bad  = markers.filter(m => bloodStatus(m.key, m.value) === 'bad').length;
      const warn = markers.filter(m => bloodStatus(m.key, m.value) === 'warn').length;
      const panelClass = bad > 0 ? 'blood-panel-card has-bad' : warn > 0 ? 'blood-panel-card has-warn' : 'blood-panel-card';
      const hasIssues = bad > 0 || warn > 0;
      const startOpen = hasIssues;

      const badgeClass = bad > 0 ? 'bad' : warn > 0 ? 'warn' : 'ok';
      const badgeText = bad > 0
        ? `${bad} out of range`
        : warn > 0
        ? `${warn} borderline`
        : '✓ All optimal';

      const rows = markers.map(m => {
        const ref = BLOOD_REFS[m.key];
        const status = bloodStatus(m.key, m.value);
        const name = ref?.[5] || m.name;
        const unit = m.unit || ref?.[4] || '';
        const trend = trendBadge(m.key, history[m.key], m.value);
        const bar = ref ? rangeBar(m.key, m.value) : '';
        const optText = ref ? `Optimal: ${ref[0]}–${ref[1]}` : '';
        const stdText = ref ? `Std: ${ref[2]}–${ref[3]}` : '';

        const status5 = bloodStatus5(m.key, m.value);
        const statusLabel = {optimal:'Optimal',below_optimal:'Below Opt',above_optimal:'Above Opt',alarm_low:'⬇ Low',alarm_high:'⬆ High'}[status5] || '';
        const statusColor = {optimal:'#22c55e',below_optimal:'#60a5fa',above_optimal:'#f59e0b',alarm_low:'#ef4444',alarm_high:'#ef4444'}[status5] || 'var(--text3)';
        return `<div class="blood-marker-row status-${status}">
          <div class="blood-marker-top">
            <div style="flex:1;min-width:0">
              <div class="blood-marker-name">${name}</div>
              <div style="font-size:10px;color:var(--text3);margin-top:1px">${ref ? (ref[4]||unit) : unit}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
              ${trend}
              <div style="text-align:right">
                <div class="blood-marker-val status-${status}">${m.value}</div>
                <div style="font-size:9px;font-weight:700;color:${statusColor};text-transform:uppercase;letter-spacing:0.5px">${statusLabel}</div>
              </div>
            </div>
          </div>
          ${bar}
          <div class="blood-marker-refs-row">
            <span class="bref-tag opt">Opt: ${ref ? ref[0]+'–'+ref[1] : '–'}</span>
            <span class="bref-tag std">Std: ${ref ? ref[2]+'–'+ref[3] : '–'}</span>
          </div>
        </div>`;
      }).join('');

      const panelId = 'bpanel_' + panel;
      return `<div class="${panelClass}">
        <div class="blood-panel-header" onclick="(function(el){var b=el.nextElementSibling;var open=b.style.display!=='none';b.style.display=open?'none':'';el.querySelector('.blood-panel-chevron').classList.toggle('collapsed',open)})(this)">
          <div class="blood-panel-header-left">
            <span class="blood-panel-title">${PANEL_LABELS[panel] || '🔬 Other'}</span>
            <span class="blood-panel-badge ${badgeClass}">${badgeText}</span>
          </div>
          <span class="blood-panel-chevron${startOpen ? '' : ' collapsed'}">▼</span>
        </div>
        <div class="blood-panel-body" style="${startOpen ? '' : 'display:none'}">
          ${rows}
        </div>
      </div>`;
    }).join('');
  }

  // ── TRENDS VIEW ──────────────────────────────────────
  if (view === 'trends') {
    const trendMarkers = Object.entries(history)
      .filter(([k, vals]) => vals.length >= 2)
      .sort((a, b) => {
        // Sort out-of-range first
        const aStatus = bloodStatus(a[0], a[1][a[1].length-1]?.value);
        const bStatus = bloodStatus(b[0], b[1][b[1].length-1]?.value);
        const rank = {bad:0,warn:1,ok:2};
        return (rank[aStatus]||2) - (rank[bStatus]||2);
      });

    if (trendMarkers.length === 0) {
      trendsEl.innerHTML = '<div class="empty-state">Upload at least 2 lab results to see trends</div>';
    } else {
      trendsEl.innerHTML = `<div class="card">
        <div class="card-label" style="color:#a78bfa">📈 Trends Across ${results.length} Lab Results</div>
        <div style="font-size:12px;color:var(--text2);margin-bottom:14px">Out-of-range markers shown first. Color = status at each draw.</div>
        ${trendMarkers.map(([key, vals]) => {
          const ref = BLOOD_REFS[key];
          const sorted = [...vals].sort((a,b) => a.date.localeCompare(b.date));
          const name = ref?.[5] || key;
          const unit = ref?.[4] || '';
          const refLo = ref?.[0], refHi = ref?.[1];
          const allVals = sorted.map(v => v.value);
          const minV = Math.min(...allVals, refLo || Infinity);
          const maxV = Math.max(...allVals, refHi || 0);
          const pad = (maxV - minV) * 0.2 || 1;
          const chartMin = Math.max(0, minV - pad);
          const chartMax = maxV + pad;
          const chartRange = chartMax - chartMin;
          const W = 100, H = 60;

          const toY = v => H - ((v - chartMin) / chartRange * (H - 12) + 6);
          const toX = i => sorted.length === 1 ? W/2 : (i / (sorted.length-1)) * W;

          // Reference band
          const refBand = (refLo !== undefined && refHi !== undefined)
            ? `<rect x="0" y="${toY(refHi).toFixed(1)}" width="${W}" height="${Math.max(0,(toY(refLo)-toY(refHi))).toFixed(1)}" fill="#22c55e15" rx="2"/>`
            : '';

          // Ref lines
          const refLines = [];
          if (refLo !== undefined) refLines.push(`<line x1="0" y1="${toY(refLo).toFixed(1)}" x2="${W}" y2="${toY(refLo).toFixed(1)}" stroke="#22c55e" stroke-width="0.8" stroke-dasharray="3,2" opacity="0.6"/>`);
          if (refHi !== undefined) refLines.push(`<line x1="0" y1="${toY(refHi).toFixed(1)}" x2="${W}" y2="${toY(refHi).toFixed(1)}" stroke="#22c55e" stroke-width="0.8" stroke-dasharray="3,2" opacity="0.6"/>`);

          // Polyline
          const points = sorted.map((v,i) => `${toX(i).toFixed(1)},${toY(v.value).toFixed(1)}`).join(' ');

          // Dots colored by status
          const dots = sorted.map((v,i) => {
            const s = bloodStatus(key, v.value);
            const col = {ok:'#22c55e',warn:'#f59e0b',bad:'#ef4444'}[s];
            return `<circle cx="${toX(i).toFixed(1)}" cy="${toY(v.value).toFixed(1)}" r="4" fill="${col}" stroke="var(--bg)" stroke-width="1.5"><title>${v.date}: ${v.value} ${unit}</title></circle>`;
          }).join('');

          const first = sorted[0].value, last = sorted[sorted.length-1].value;
          const chgPct = ((last - first) / first * 100).toFixed(1);
          const latestStatus = bloodStatus(key, last);
          const lbetter = LOWER_BETTER.has(key);
          const hbetter = HIGHER_BETTER.has(key);
          const improving = lbetter ? last < first : hbetter ? last > first : null;
          const deltaColor = improving === true ? '#22c55e' : improving === false ? '#ef4444' : '#94a3b8';
          const deltaLabel = parseFloat(chgPct) > 0 ? '+' + chgPct + '%' : chgPct + '%';

          const statusDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${{ok:'#22c55e',warn:'#f59e0b',bad:'#ef4444'}[latestStatus]};margin-right:4px;vertical-align:middle"></span>`;

          return `<div class="btchart-wrap">
            <div class="btchart-header">
              <div class="btchart-name">${statusDot}${name}</div>
              <div style="display:flex;align-items:center;gap:8px">
                <span style="font-size:11px;color:var(--text3)">${last} ${unit}</span>
                <span class="btchart-delta" style="background:${deltaColor}20;color:${deltaColor}">${deltaLabel} overall</span>
              </div>
            </div>
            <svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block;overflow:visible">
              ${refBand}
              ${refLines.join('')}
              <polyline points="${points}" fill="none" stroke="#475569" stroke-width="1.5" stroke-linejoin="round"/>
              ${dots}
            </svg>
            <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text3);margin-top:4px">
              <span>${sorted[0].date}</span>
              <span style="color:#22c55e;font-size:9px">▬ normal range</span>
              <span>${sorted[sorted.length-1].date}</span>
            </div>
          </div>`;
        }).join('')}
      </div>`;
    }
  }

  // ── COMPARE TABLE VIEW ───────────────────────────────
  if (view === 'table') {
    // Show all markers that appear in at least one result, in a comparison table
    const allKeys = [...new Set(results.flatMap(r => r.markers.map(m => m.key)))];
    const sortedKeys = allKeys.sort((a, b) => {
      // Out of range in latest result first
      const as = bloodStatus(a, entry.markers.find(m=>m.key===a)?.value ?? 0);
      const bs = bloodStatus(b, entry.markers.find(m=>m.key===b)?.value ?? 0);
      const rank = {bad:0,warn:1,ok:2};
      if ((rank[as]||3) !== (rank[bs]||3)) return (rank[as]||3) - (rank[bs]||3);
      // Then by panel
      const ap = BLOOD_REFS[a]?.[4] || 'z';
      const bp = BLOOD_REFS[b]?.[4] || 'z';
      return ap.localeCompare(bp);
    });

    const sortedResults = [...results].sort((a,b) => b.date.localeCompare(a.date));
    const dateHeaders = sortedResults.map(r =>
      `<th style="text-align:right;min-width:70px">${r.date.slice(5)}<br><span style="font-size:9px;font-weight:400">${r.date.slice(0,4)}</span></th>`
    ).join('');

    const rows = sortedKeys.map(key => {
      const ref = BLOOD_REFS[key];
      const name = ref?.[5] || key;
      const unit = ref?.[4] || '';
      const latestMarker = entry.markers.find(m => m.key === key);
      const latestStatus = latestMarker ? bloodStatus(key, latestMarker.value) : 'ok';
      const rowClass = latestStatus === 'bad' ? 'row-bad' : latestStatus === 'warn' ? 'row-warn' : '';
      const dotCol = {ok:'#22c55e',warn:'#f59e0b',bad:'#ef4444'}[latestStatus] || '#475569';

      const cells = sortedResults.map(r => {
        const m = r.markers.find(x => x.key === key);
        if (!m) return '<td style="text-align:right;color:var(--text3)">—</td>';
        const s = bloodStatus(key, m.value);
        const col = {ok:'#22c55e',warn:'#f59e0b',bad:'#ef4444'}[s];

        // Trend from previous result for this marker
        const mIdx = sortedResults.indexOf(r);
        let trendHtml = '';
        if (mIdx < sortedResults.length - 1) {
          const prevResult = sortedResults[mIdx + 1];
          const prevM = prevResult?.markers.find(x => x.key === key);
          if (prevM) {
            const diff = m.value - prevM.value;
            const pct = (diff / prevM.value * 100).toFixed(0);
            const lb = LOWER_BETTER.has(key);
            const hb = HIGHER_BETTER.has(key);
            const good = lb ? diff < 0 : hb ? diff > 0 : null;
            if (Math.abs(parseFloat(pct)) >= 1) {
              const arrColor = good === true ? '#22c55e' : good === false ? '#ef4444' : '#94a3b8';
              trendHtml = `<span style="font-size:9px;color:${arrColor}">${diff>0?'↑':'↓'}</span>`;
            }
          }
        }

        return `<td style="text-align:right"><span style="font-size:13px;font-weight:700;color:${col}">${m.value}</span>${trendHtml}</td>`;
      }).join('');

      const refText = ref ? `${ref[0]}–${ref[1]}` : '–';
      const stdText = ref ? `${ref[2]}–${ref[3]}` : '–';

      return `<tr class="${rowClass}">
        <td style="font-size:11px;font-weight:600;color:var(--text)">
          <span class="bcomp-dot" style="background:${dotCol}"></span>${name}
          <div style="font-size:9px;color:var(--text3);margin-top:1px;padding-left:12px">${unit}</div>
        </td>
        ${cells}
        <td style="text-align:center;font-size:10px;color:#22c55e;white-space:nowrap">${refText}</td>
        <td style="text-align:center;font-size:10px;color:var(--text3);white-space:nowrap">${stdText}</td>
      </tr>`;
    }).join('');

    tableEl.innerHTML = `<div class="card">
      <div class="card-label" style="color:#3b82f6">📊 Blood Test Comparative</div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:12px">Side-by-side results with optimal & standard ranges. Matches Ways2Well / Optimal DX report format.</div>
      <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
        <table class="bcomp-table">
          <thead><tr>
            <th>Marker</th>
            ${dateHeaders}
            <th style="text-align:center;color:#22c55e;font-size:10px">Optimal</th>
            <th style="text-align:center;color:var(--text3);font-size:10px">Standard</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }

  // Show insights panel
  const insightsEl = document.getElementById('bloodAIInsights');
  if (insightsEl) insightsEl.style.display = 'block';
}

// ── AI Response Formatter ────────────────────────────────────
function formatAIResponse(text, opts) {
  opts = opts || {};
  // Parse sections separated by ## headings or numbered headings like "1)"
  // Returns rich themed HTML
  const lines = text.split('\n');
  let html = '';
  let inList = false;

  const sectionColors = [
    { bg: '#0d1f3c', border: '#1e3a5f', icon_color: '#60a5fa' },  // blue
    { bg: '#0d2d1a', border: '#14532d', icon_color: '#22c55e' },  // green
    { bg: '#2d1b00', border: '#78350f', icon_color: '#f59e0b' },  // amber
    { bg: '#1a0d2d', border: '#4c1d95', icon_color: '#a78bfa' },  // purple
    { bg: '#2d0d0d', border: '#7f1d1d', icon_color: '#f87171' },  // red
  ];
  let sectionIdx = 0;

  function closeList() {
    if (inList) { html += '</div>'; inList = false; }
  }

  function openList() {
    if (!inList) { html += '<div style="display:flex;flex-direction:column;gap:5px;margin-top:6px">'; inList = true; }
  }

  // Classify each line
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) { closeList(); continue; }

    // ## Heading or numbered section like "1) Title" or "**1. Title**"
    const headingMatch = line.match(/^#{1,3}\s+(.+)/)
      || line.match(/^\*\*(\d+[\.\)]\s*.+?)\*\*\s*$/)
      || line.match(/^(\d+[\.\)]\s+[A-Z].{3,}?)$/);

    if (headingMatch) {
      closeList();
      const c = sectionColors[sectionIdx % sectionColors.length];
      sectionIdx++;
      const title = headingMatch[1].replace(/\*\*/g, '').trim();
      // Pick icon based on keywords
      let icon = '📋';
      const tl = title.toLowerCase();
      if (tl.includes('finding') || tl.includes('import') || tl.includes('key') || tl.includes('concern') || tl.includes('flag')) icon = '⚠️';
      else if (tl.includes('well') || tl.includes('good') || tl.includes('positive') || tl.includes('strength')) icon = '✅';
      else if (tl.includes('action') || tl.includes('change') || tl.includes('improve') || tl.includes('recommend') || tl.includes('nutrition')) icon = '🎯';
      else if (tl.includes('monitor') || tl.includes('watch') || tl.includes('next') || tl.includes('follow')) icon = '👁️';
      else if (tl.includes('blood') || tl.includes('lab') || tl.includes('marker')) icon = '🩸';
      else if (tl.includes('correlat') || tl.includes('diet') || tl.includes('food')) icon = '🔗';
      else if (tl.includes('summary')) icon = '📊';
      html += `<div style="background:${c.bg};border:1px solid ${c.border};border-radius:12px;padding:12px 14px;margin-bottom:10px">
        <div style="font-size:12px;font-weight:700;color:${c.icon_color};letter-spacing:0.5px;margin-bottom:8px;display:flex;align-items:center;gap:6px">
          <span>${icon}</span><span>${esc(title)}</span>
        </div>
        <div class="_ai-section-body" style="font-size:13px;color:#cbd5e1;line-height:1.65">`;
      continue;
    }

    // Close open section if we hit a blank after content
    // Bullet point: -, *, •
    const bulletMatch = line.match(/^[-*•]\s+(.+)/);
    if (bulletMatch) {
      openList();
      const btext = bulletMatch[1].replace(/\*\*(.*?)\*\*/g, '<strong style="color:#f1f5f9">$1</strong>');
      html += `<div style="display:flex;gap:8px;align-items:flex-start">
        <span style="color:#475569;flex-shrink:0;margin-top:2px">▸</span>
        <span>${btext}</span>
      </div>`;
      continue;
    }

    // Bold label: **label:** text
    const boldLabelMatch = line.match(/^\*\*(.+?)\*\*[:\s]+(.+)/);
    if (boldLabelMatch) {
      closeList();
      html += `<div style="margin-bottom:6px">
        <span style="font-weight:700;color:#f1f5f9">${boldLabelMatch[1]}:</span>
        <span style="color:#94a3b8"> ${boldLabelMatch[2].replace(/\*\*(.*?)\*\*/g,'<strong style="color:#f1f5f9">$1</strong>')}</span>
      </div>`;
      continue;
    }

    // Regular paragraph text
    closeList();
    const ptext = line.replace(/\*\*(.*?)\*\*/g, '<strong style="color:#f1f5f9">$1</strong>');
    html += `<div style="margin-bottom:5px;color:#94a3b8">${ptext}</div>`;
  }

  closeList();

  // Close any unclosed section divs (count open vs close)
  const openSections = (html.match(/<div class="_ai-section-body"/g) || []).length;
  const closeSections = 0; // we never explicitly closed them
  // Close all open sections
  for (let i = 0; i < openSections; i++) {
    html += '</div></div>';
  }

  // If no sections were found, just render as plain styled text
  if (openSections === 0) {
    const plain = text
      .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#f1f5f9">$1</strong>')
      .replace(/^[-*•]\s+(.+)/gm, '<div style="display:flex;gap:8px;margin-bottom:4px"><span style="color:#475569">▸</span><span>$1</span></div>')
      .split('\n').filter(Boolean)
      .map(l => `<div style="margin-bottom:6px">${l}</div>`).join('');
    return `<div style="font-size:13px;color:#94a3b8;line-height:1.65">${plain}</div>`;
  }

  return html;
}

async function generateBloodAIInsights(entry) {
  const insightsEl = document.getElementById('bloodAIInsights');
  const insightsText = document.getElementById('bloodAIInsightsText');
  if (!insightsEl || !insightsText) return;
  insightsEl.style.display = 'block';
  insightsText.innerHTML = '<div style="color:var(--text3)">⏳ Generating health insights…</div>';

  // Gather out of range / borderline markers
  const flagged = entry.markers.filter(m => {
    const s = bloodStatus(m.key, m.value);
    return s === 'bad' || s === 'warn';
  });

  // Get recent nutrition averages for correlation
  const nutritionSummary = getNutritionSummaryText(30);

  const markerLines = entry.markers.map(m => {
    const ref = BLOOD_REFS[m.key];
    const status = ref ? bloodStatus(m.key, m.value) : 'ok';
    const mname = ref ? ref[5] : m.name;
    const flag = status !== 'ok' ? ' (' + status.toUpperCase() + ')' : '';
    return mname + ': ' + m.value + ' ' + (m.unit || '') + flag;
  }).join('\n');
  const prompt = [
    'You are a health coach analyzing blood work results for Jeremy, a 52-year-old male who lifts 3x/week and runs regularly. He tracks macros at 2,200 kcal/day with 190g protein.',
    'Lab results from ' + entry.date + ':',
    markerLines,
    'Recent 30-day nutrition averages:',
    nutritionSummary,
    'Provide a concise actionable health analysis: 1) Most important findings, 2) What is going well, 3) Specific nutrition/lifestyle changes for flagged markers, 4) What to monitor at next draw.',
    'Keep it practical. No disclaimers needed.'
  ].join('\n\n');

  try {
    const data = await callClaudeAPI({
      model: 'claude-opus-4-7',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = data.content?.[0]?.text || 'Could not generate insights.';
    insightsText.innerHTML = formatAIResponse(text);
  } catch(e) {
    insightsText.textContent = 'Could not connect to AI. Check your network.';
  }
}

async function analyzeBloodWithNutrition() {
  const insightsText = document.getElementById('bloodAIInsightsText');
  if (!insightsText) return;
  insightsText.innerHTML = '<div style="color:var(--text3)">⏳ Correlating blood work with nutrition history…</div>';

  const results = getBloodResults();
  if (results.length === 0) return;

  const nutritionSummary = getNutritionSummaryText(90);
  const bloodSummary = results.map(r => {
    const flagged = r.markers.filter(m => bloodStatus(m.key, m.value) !== 'ok')
      .map(m => (BLOOD_REFS[m.key] ? BLOOD_REFS[m.key][3] : m.name) + ' ' + m.value)
      .join(', ');
    return r.date + ': ' + (flagged || 'All normal');
  }).join('\n');

  const prompt = [
    "Analyze the relationship between Jeremy's nutrition and his blood work results.",
    'Blood work history:\n' + bloodSummary,
    '90-day nutrition data:\n' + nutritionSummary,
    'Identify specific correlations between his diet and blood markers. For each flagged marker, explain which foods/nutrients are likely contributing and give concrete dietary changes. Focus on actionable insights for a 52-year-old male athlete.'
  ].join('\n\n');

  try {
    const data = await callClaudeAPI({
      model: 'claude-opus-4-7',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = data.content?.[0]?.text || 'Could not generate analysis.';
    insightsText.innerHTML = formatAIResponse(text);
  } catch(e) {
    insightsText.textContent = 'AI unavailable. Try again.';
  }
}

// ═══════════════════════════════════════════════════════
// ── EXTENDED NUTRITION TRACKING ────────────────────────
// ═══════════════════════════════════════════════════════

// Full USDA nutrient ID → key mapping
const MICRO_NUTRIENT_IDS = {
  // Vitamins
  1106: 'vitA',       // Vitamin A RAE (mcg)
  1162: 'vitC',       // Vitamin C (mg)
  1114: 'vitD',       // Vitamin D (mcg)
  1109: 'vitE',       // Vitamin E (mg)
  1185: 'vitK',       // Vitamin K (mcg)
  1165: 'vitB1',      // Thiamine B1 (mg)
  1166: 'vitB2',      // Riboflavin B2 (mg)
  1167: 'vitB3',      // Niacin B3 (mg)
  1170: 'vitB5',      // Pantothenic acid B5 (mg)
  1175: 'vitB6',      // Vitamin B6 (mg)
  1177: 'folate',     // Folate (mcg)
  1178: 'vitB12',     // Vitamin B12 (mcg)
  // Minerals
  1087: 'calcium',    // (mg)
  1090: 'magnesium',  // (mg)
  1092: 'phosphorus', // (mg)
  1093: 'sodium',     // (mg)
  1095: 'zinc',       // (mg)
  1098: 'copper',     // (mg)
  1101: 'manganese',  // (mg)
  1103: 'selenium',   // (mcg)
  1089: 'iron',       // (mg)
  1091: 'potassium',  // (mg)
  // Other
  1079: 'fiber',      // Total dietary fiber (g)
  1085: 'sugar',      // Total sugars (g)
  1292: 'omega3',     // ALA omega-3 (g)
  1316: 'epa',        // EPA (g)
  1320: 'dpa',        // DPA (g)
  1322: 'dha',        // DHA (g)
  1253: 'cholesterol',// (mg)
  1258: 'saturatedFat', // (g)
  1292: 'omega3',     // Polyunsaturated (includes omega-3)
  1257: 'transFat',   // (g)
};

// Recommended Daily Values for display
const MICRO_RDV = {
  vitA: [900, 'mcg', 'Vitamin A'],
  vitC: [90, 'mg', 'Vitamin C'],
  vitD: [20, 'mcg', 'Vitamin D'],
  vitE: [15, 'mg', 'Vitamin E'],
  vitK: [120, 'mcg', 'Vitamin K'],
  vitB1: [1.2, 'mg', 'Vitamin B1 (Thiamine)'],
  vitB2: [1.3, 'mg', 'Vitamin B2 (Riboflavin)'],
  vitB3: [16, 'mg', 'Vitamin B3 (Niacin)'],
  vitB5: [5, 'mg', 'Vitamin B5'],
  vitB6: [1.7, 'mg', 'Vitamin B6'],
  folate: [400, 'mcg', 'Folate'],
  vitB12: [2.4, 'mcg', 'Vitamin B12'],
  calcium: [1000, 'mg', 'Calcium'],
  magnesium: [420, 'mg', 'Magnesium'],
  phosphorus: [700, 'mg', 'Phosphorus'],
  sodium: [2300, 'mg', 'Sodium'],
  zinc: [11, 'mg', 'Zinc'],
  copper: [0.9, 'mg', 'Copper'],
  manganese: [2.3, 'mg', 'Manganese'],
  selenium: [55, 'mcg', 'Selenium'],
  iron: [8, 'mg', 'Iron'],
  potassium: [3400, 'mg', 'Potassium'],
  fiber: [38, 'g', 'Dietary Fiber'],
  sugar: [50, 'g', 'Added Sugars'],
  omega3: [1.6, 'g', 'Omega-3 (ALA)'],
  epa: [0.5, 'g', 'EPA'],
  dha: [0.5, 'g', 'DHA'],
  cholesterol: [300, 'mg', 'Cholesterol'],
  saturatedFat: [20, 'g', 'Saturated Fat'],
};

// Get nutrition summary text for AI prompts
function getNutritionSummaryText(days) {
  const entries = getRecentMicronutrientAverages(days);
  if (Object.keys(entries).length === 0) return 'No detailed nutrition data available yet.';
  return Object.entries(MICRO_RDV).map(([key, [rdv, unit, name]]) => {
    const avg = entries[key] || 0;
    const pct = Math.round(avg / rdv * 100);
    return `${name}: ${avg.toFixed(1)} ${unit}/day (${pct}% of RDV)`;
  }).join('\n');
}

function getRecentMicronutrientAverages(days) {
  const foodEntries = getStorage('foodEntries', {});
  const totals = {};
  const counts = {};
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffKey = cutoff.toISOString().slice(0,10);

  Object.entries(foodEntries).forEach(([dateKey, entries]) => {
    if (dateKey < cutoffKey) return;
    entries.forEach(e => {
      if (!e.micros) return;
      Object.entries(e.micros).forEach(([k, v]) => {
        totals[k] = (totals[k] || 0) + v;
        counts[k] = (counts[k] || 0) + 1;
      });
    });
  });

  const daysWithData = new Set(
    Object.keys(foodEntries).filter(k => k >= cutoffKey)
  ).size || 1;

  const avgs = {};
  Object.keys(totals).forEach(k => { avgs[k] = totals[k] / daysWithData; });
  return avgs;
}

function renderNutritionReport(days) {
  // Update active button
  [7, 30, 90].forEach(d => {
    const btn = document.getElementById('nrBtn'+d);
    if (btn) btn.classList.toggle('nr-btn-active', d === days);
  });

  const avgs = getRecentMicronutrientAverages(days);
  const grid = document.getElementById('nutritionReportGrid');
  const details = document.getElementById('nutritionReportDetails');
  if (!grid) return;

  const hasData = Object.keys(avgs).length > 0;
  if (!hasData) {
    grid.innerHTML = '<div style="font-size:13px;color:var(--text2);text-align:center;padding:20px">No micronutrient data yet.<br><br>Micronutrients are captured when you scan barcodes or search the USDA database. Log a few foods to see your report.</div>';
    if (details) details.innerHTML = '';
    return;
  }

  // Category groupings
  const categories = {
    '💊 Vitamins': ['vitA','vitC','vitD','vitE','vitK','vitB1','vitB2','vitB3','vitB5','vitB6','folate','vitB12'],
    '⚡ Minerals': ['calcium','magnesium','iron','potassium','sodium','zinc','phosphorus','copper','manganese','selenium'],
    '🫀 Heart Health': ['fiber','cholesterol','saturatedFat','omega3','epa','dha','sugar'],
  };

  grid.innerHTML = Object.entries(categories).map(([catName, keys]) => {
    const bars = keys.filter(k => avgs[k] !== undefined).map(k => {
      const [rdv, unit, name] = MICRO_RDV[k] || [1, '', k];
      const avg = avgs[k] || 0;
      const pct = Math.min(150, Math.round(avg / rdv * 100));
      const overRdv = pct > 100;
      // Color: green 80-120%, yellow <50% or >130%, red <20%
      const color = pct >= 80 && pct <= 120 ? '#22c55e'
                  : pct >= 50 && pct <= 130  ? '#f59e0b'
                  : '#ef4444';
      return `<div class="nutr-bar-wrap">
        <div class="nutr-bar-label">
          <span style="color:var(--text2);font-size:12px">${name}</span>
          <span style="color:${color};font-weight:600;font-size:12px">${avg.toFixed(1)} ${unit} <span style="color:var(--text3);font-weight:400">(${pct}%)</span></span>
        </div>
        <div class="nutr-bar-track">
          <div class="nutr-bar-fill" style="width:${Math.min(100,pct)}%;background:${color}"></div>
        </div>
      </div>`;
    });

    if (bars.length === 0) return '';
    return `<div style="margin-bottom:18px">
      <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:10px">${catName}</div>
      ${bars.join('')}
    </div>`;
  }).join('');

  // Summary stats
  const tracked = Object.keys(avgs).length;
  const optimal = Object.keys(MICRO_RDV).filter(k => {
    const pct = avgs[k] ? avgs[k] / MICRO_RDV[k][0] * 100 : 0;
    return pct >= 80 && pct <= 120;
  }).length;
  const low = Object.keys(MICRO_RDV).filter(k => {
    const pct = avgs[k] ? avgs[k] / MICRO_RDV[k][0] * 100 : 0;
    return pct < 50 && pct > 0;
  });

  if (details) {
    details.innerHTML = `<div class="card">
      <div class="card-label" style="color:#3b82f6">📊 ${days}-Day Summary</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px;text-align:center">
        <div style="background:var(--surface2);border-radius:12px;padding:12px">
          <div style="font-size:22px;font-weight:800;color:#22c55e">${optimal}</div>
          <div style="font-size:10px;color:var(--text3)">Optimal</div>
        </div>
        <div style="background:var(--surface2);border-radius:12px;padding:12px">
          <div style="font-size:22px;font-weight:800;color:#f59e0b">${low.length}</div>
          <div style="font-size:10px;color:var(--text3)">Low</div>
        </div>
        <div style="background:var(--surface2);border-radius:12px;padding:12px">
          <div style="font-size:22px;font-weight:800;color:var(--text2)">${tracked}</div>
          <div style="font-size:10px;color:var(--text3)">Tracked</div>
        </div>
      </div>
      ${low.length > 0 ? `<div style="background:#1c0e00;border:1px solid #92400e;border-radius:12px;padding:12px">
        <div style="font-size:11px;font-weight:700;color:#f59e0b;margin-bottom:6px">⚠️ Consistently Low</div>
        <div style="font-size:12px;color:var(--text2);line-height:1.7">${low.map(k=>MICRO_RDV[k][2]).join(' · ')}</div>
      </div>` : '<div style="background:#0d2d1a;border:1px solid #166534;border-radius:12px;padding:12px;font-size:12px;color:#4ade80;font-weight:600">✅ All tracked nutrients look solid over this period</div>'}
    </div>`;
  }
}

// ═══════════════════════════════════════════════════════
// ── EXTENDED USDA NUTRIENT PARSING ─────────────────────
// ═══════════════════════════════════════════════════════

// Extract micronutrients from a USDA food item's nutrient list
function parseMicronutrients(foodNutrients, scale) {
  const micros = {};
  (foodNutrients || []).forEach(n => {
    const id = n.nutrientId || n.nutrientNumber;
    const key = MICRO_NUTRIENT_IDS[parseInt(id)] || MICRO_NUTRIENT_IDS[String(id)];
    if (key && n.value != null) {
      micros[key] = Math.round((n.value * scale) * 1000) / 1000;
    }
  });
  return micros;
}


// ── Init ──
// Each call is isolated so one failure can't white-screen the app
function safeCall(fn, label) {
  try { fn(); } catch(e) { console.error('[safeCall] ' + (label||fn.name||'?') + ':', e); }
}

// Prune old localStorage data to prevent quota exhaustion
function pruneOldData() {
  const KEEP_DAYS = 90;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
  const cutoffKey = cutoff.toISOString().slice(0, 10);

  // Prune per-date food entry keys (foodEntries_YYYY-MM-DD)
  const foodEntries = getStorage('foodEntries', {});
  let pruned = 0;
  Object.keys(foodEntries).forEach(date => {
    if (date < cutoffKey && date.match(/^\d{4}-\d{2}-\d{2}$/)) {
      delete foodEntries[date];
      localStorage.removeItem('foodEntries_' + date);
      pruned++;
    }
  });
  if (pruned > 0) {
    setStorage('foodEntries', foodEntries);
    console.log(`[prune] Removed ${pruned} food entry days older than ${KEEP_DAYS} days`);
  }

  // Cap barcode cache to 500 entries
  const cache = getStorage('barcodeCache', {});
  const cacheKeys = Object.keys(cache);
  if (cacheKeys.length > 500) {
    cacheKeys.slice(0, cacheKeys.length - 500).forEach(k => delete cache[k]);
    setStorage('barcodeCache', cache);
    console.log(`[prune] Trimmed barcode cache to 500 entries`);
  }
}

function _initApp() {
  console.log('[init] _initApp started, readyState:', document.readyState);
  safeCall(pruneOldData, 'pruneOldData');
  safeCall(syncAllLogs, 'syncAllLogs');
  safeCall(initPWA, 'initPWA');
  safeCall(checkTPLifecycle, 'checkTPLifecycle');
  safeCall(renderReadinessCard, 'renderReadinessCard');
  // Feature-flag gating (items 2–5)
  try {
    if (!FLAGS.voiceLog) document.getElementById('voiceLogBtn').style.display = 'none';
    if (!FLAGS.photoLog) document.getElementById('photoLogBtn').style.display = 'none';
  } catch(_) {}
  safeCall(migrateShoePhotos, 'migrateShoePhotos');
  safeCall(migrateBloodKeys, 'migrateBloodKeys');

  // Migrate burnLog: old entries stored gross Strava calories; correct to net (×0.75)
  // Run once, marked with _netMigrated flag
  try {
    const burnLog = getStorage('burnLog', {});
    if (!burnLog._netMigrated) {
      Object.keys(burnLog).forEach(k => {
        if (k !== '_netMigrated' && typeof burnLog[k] === 'number') {
          // Only migrate entries that look like gross calories (>400 suggests unreduced)
          if (burnLog[k] > 400) burnLog[k] = Math.round(burnLog[k] * 0.75);
        }
      });
      burnLog._netMigrated = true;
      setStorage('burnLog', burnLog);
    }
  } catch(e) {}

  safeCall(renderWeekStrip, 'renderWeekStrip');

  // Restore today's calorie burn adjustment on reload
  try {
    const burnLog = getStorage('burnLog', {});
    const burn = burnLog[todayKey()];
    if (burn > 0) {
      const base = getStorage('adaptiveMacros', null) || getStorage('userMacros', null) || MACROS;
      const extraCals  = Math.round(burn * 0.6);
      const extraCarbs = Math.round(extraCals * 0.65 / 4);
      const adjusted = { calories: base.calories + extraCals, carbs: base.carbs + extraCarbs, protein: base.protein, fat: base.fat };
      setStorage('garminAdjustedMacros', adjusted);
      setTimeout(() => {
        const banner = document.getElementById('garminMacroBanner');
        const text   = document.getElementById('garminMacroText');
        if (banner && text) {
          banner.style.display = 'flex';
          text.textContent = `🟠 Run detected! +${extraCals} kcal → ${adjusted.calories} kcal target, ${adjusted.carbs}g carbs`;
        }
      }, 100);
    }
  } catch(e) {}

  // Sync macroLog from foodEntries for today to ensure rings are accurate
  try {
    const todayEntries = getFoodEntries(todayKey());
    if (todayEntries && todayEntries.length > 0) {
      const totals = todayEntries.reduce((acc, e) => ({
        calories: acc.calories + (e.calories || 0),
        protein:  acc.protein  + (e.protein  || 0),
        carbs:    acc.carbs    + (e.carbs    || 0),
        fat:      acc.fat      + (e.fat      || 0),
      }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
      const macroLog = getStorage('macroLog', {});
      macroLog[todayKey()] = totals;
      setStorage('macroLog', macroLog);
    }
  } catch(e) { console.warn('macroLog sync failed:', e); }

  safeCall(renderRings, 'renderRings');
  safeCall(renderQuickRecs, 'renderQuickRecs');
  safeCall(updateMacroTargetsRow, 'updateMacroTargetsRow');
  safeCall(renderUsualFoods, 'renderUsualFoods');
  safeCall(renderFoodLog, 'renderFoodLog');
  safeCall(renderWeightTrend, 'renderWeightTrend');
  safeCall(checkCopyYesterday, 'checkCopyYesterday');
  safeCall(checkAdaptiveMacros, 'checkAdaptiveMacros');
  safeCall(renderProgramPage, 'renderProgramPage');
  safeCall(renderEventList, 'renderEventList');
  safeCall(renderEventCountdowns, 'renderEventCountdowns');

  // Pre-seed events if none exist yet
  try {
    if (!getEvents().length) {
      saveEvents([
        { id: Date.now(), name: "Grandma's Marathon", date: "2026-06-20", type: "race" },
        { id: Date.now() + 1, name: "Weight Goal", date: "2026-03-23", type: "weight", weightTarget: 163 }
      ]);
      safeCall(renderEventList, 'renderEventList');
      safeCall(renderEventCountdowns, 'renderEventCountdowns');
    }
  } catch(e) {}

  safeCall(updateTPSettingsUI, 'updateTPSettingsUI');
  safeCall(renderWeeklyBalance, 'renderWeeklyBalance');
  safeCall(renderStreakCard, 'renderStreakCard');
  safeCall(renderProteinPace, 'renderProteinPace');
  safeCall(renderWorkoutNutritionBanner, 'renderWorkoutNutritionBanner');
  setTimeout(() => safeCall(seedBloodResults, 'seedBloodResults'), 500);
  setTimeout(() => safeCall(checkWhoopUpdateReminder, 'whoopReminder'), 3000);

  // Clear cached quote if it was stored while API was broken, or is flagged for retry
  const _qc = getStorage('dailyQuote', null);
  if (_qc && (!_qc._apiFetched || _qc.date === 'retry')) localStorage.removeItem('dailyQuote');

  safeCall(initGreetingTile, 'initGreetingTile');
  safeCall(initNewFeatures, 'initNewFeatures');
  // Safety net: ensure check-in modal shows even if initNewFeatures partially failed
  setTimeout(() => { try { maybeShowWelcomeModal(); } catch(e) { console.error('[checkin] safety net error:', e); } }, 600);
  // Last-resort guard at 3 seconds
  setTimeout(() => { try { _checkinGuard(); } catch(e) {} }, 3000);
  safeCall(renderRecipeList, 'renderRecipeList');
  safeCall(updateHeaderDate, 'updateHeaderDate');
  safeCall(updateDateNavBar, 'updateDateNavBar');
  safeCall(scheduleMidnightRefresh, 'scheduleMidnightRefresh');
  setTimeout(renderShoePage, 0);

  // Safety net: re-render critical above-fold elements after paint.
  // Only rings and macros need this — other renders are stable after init.
  requestAnimationFrame(() => {
    safeCall(renderRings, 'renderRings-paint');
    safeCall(updateMacroTargetsRow, 'updateMacroTargetsRow-paint');
  });
}

// Ensure init runs after DOM is fully ready — uses auth flow instead of direct init
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkAuth);
} else {
  checkAuth();
}

// Mobile resume fix — when app comes back from background, check if day changed or run needs sync
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const cached = getStorage('dailyQuote', null);
    if (!cached || cached.date !== todayKey()) {
      updateHeaderDate();
      renderWeekStrip();
      renderRings();
      renderFoodLog();
      renderWeightTrend();
      renderWeeklyBalance();
      checkCopyYesterday();
      initGreetingTile();
    }
    // Show daily check-in if not done yet today (handles mobile resume / tab switch)
    _checkinGuardFired = false; // reset guard so it can fire again if needed
    try { maybeShowWelcomeModal(); } catch(e) {}
    // Re-check TrainingPeaks on resume — catches runs finished while app was in background
    try {
      const tpConn = getStorage('tpConnected', null);
      if (tpConn) {
        const sc = getStorage('tpToday', null);
        const age = sc ? Date.now() - sc.fetched : Infinity;
        const stale = !sc || (sc.distance > 0 ? age > 30*60*1000 : age > 5*60*1000);
        if (stale) fetchTPToday();
      }
    } catch(e) {}
    // Log sync on resume: retry anything dirty, or refresh if it's been a while
    try {
      const dirty = SYNC_TABLES.some(t => getStorage('_syncDirty_' + t, 0));
      const lastOk = getStorage('_syncLastOk', 0);
      if (dirty || Date.now() - lastOk > 5 * 60 * 1000) syncAllLogs();
      const fc = getStorage('favCache', null);
      if (FLAGS.quickAdd && (!fc || Date.now() - fc.fetched > 24 * 3600 * 1000)) renderFavChips(true);
      const rt = getStorage('readinessToday', null);
      if (FLAGS.readiness && (!rt || rt.date !== todayKey() || Date.now() - (rt.fetched || 0) > 30 * 60 * 1000)) renderReadinessCard();
    } catch(e) {}
  }
});

// Auto-select current time slot in manual picker on load
(function() {
  const currentSlot = getTimeSlot();
  const btn = document.querySelector(`#manualTimeSlotPicker .ts-btn[data-slot="${currentSlot}"]`);
  if (btn) { btn.classList.add('active'); selectedTimeSlot = currentSlot; }
})();


// Auto-load activity data if TrainingPeaks is connected
(function() {
  // One-time cleanup of the retired Strava and Garmin integrations' storage
  ['stravaToken','stravaToday','stravaAutoAdjust','stravaAdjustedMacros',
   'garminToken','garminCreds','garminReqToken','garminToday','garminAutoAdjust'].forEach(k => localStorage.removeItem(k));
  const tpConn = getStorage('tpConnected', null);

  function shouldUseCached(cached) {
    if (!cached) return false;
    const age = Date.now() - cached.fetched;
    // If cache has a real run (distance > 0), trust it for 30 min
    if (cached.distance > 0) return age < 30 * 60 * 1000;
    // If cache has NO run yet, only trust it for 5 min — run may not have uploaded yet
    return age < 5 * 60 * 1000;
  }

  if (tpConn) {
    document.getElementById('garminCard').style.display = 'block';
    const cached = getStorage('tpToday', null);
    if (shouldUseCached(cached)) {
      renderGarminCard(cached.calories, cached.distance, cached.duration, cached.distance > 0 ? 1 : 0);
      if (getStorage('tpAutoAdjust', true)) adjustMacrosForBurn(Math.round((cached.calories || 0) * 0.75));
    } else {
      fetchTPToday();
    }
  }
})();

// ═══════════════════════════════════════════════════════
// ── RETROACTIVE MICRO ENRICHMENT ───────────────────────
// ═══════════════════════════════════════════════════════

async function startRetroEnrichment() {
  const btn = document.getElementById('enrichBtn');
  const statusEl = document.getElementById('enrichStatus');
  const progressEl = document.getElementById('enrichProgress');
  const bar = document.getElementById('enrichProgressBar');
  const progressText = document.getElementById('enrichProgressText');

  btn.disabled = true;
  btn.textContent = '⏳ Scanning food history…';
  statusEl.style.display = 'block';
  progressEl.style.display = 'block';

  // 1. Collect ALL food entries across all dates
  const foodEntries = getStorage('foodEntries', {});
  const allDates = Object.keys(foodEntries);

  if (!allDates.length) {
    statusEl.textContent = '⚠️ No food history found.';
    btn.disabled = false;
    btn.textContent = '🔄 Enrich All Past Meals with Micronutrients';
    return;
  }

  // 2. Build unique food name list (skip already-enriched entries)
  const uniqueFoods = new Map(); // name.toLowerCase() → { name, dates: [{date, idx}] }
  let totalEntries = 0, alreadyHave = 0;

  allDates.forEach(date => {
    (foodEntries[date] || []).forEach((entry, idx) => {
      totalEntries++;
      if (entry.micros && Object.keys(entry.micros).length > 0) { alreadyHave++; return; }
      const key = (entry.name || '').toLowerCase().trim();
      if (!key) return;
      if (!uniqueFoods.has(key)) uniqueFoods.set(key, { name: entry.name, refs: [] });
      uniqueFoods.get(key).refs.push({ date, idx });
    });
  });

  const needsEnrich = [...uniqueFoods.values()];
  statusEl.textContent = `Found ${totalEntries} entries · ${alreadyHave} already have micros · ${needsEnrich.length} unique foods to look up`;

  if (!needsEnrich.length) {
    statusEl.innerHTML = '✅ All entries already have micronutrient data!';
    progressEl.style.display = 'none';
    btn.disabled = false;
    btn.textContent = '✅ Already Complete';
    renderNutritionReport(7);
    return;
  }

  // 3. Look up each unique food — USDA first, AI fallback
  // Process in small batches with delay to avoid rate limiting
  const BATCH_SIZE = 3;
  const BATCH_DELAY_MS = 500; // pause between batches to respect rate limits
  const MAX_LOOKUPS = 150; // cap total API calls per enrichment run
  if (needsEnrich.length > MAX_LOOKUPS) {
    needsEnrich.length = MAX_LOOKUPS;
    statusEl.textContent += ` (capped at ${MAX_LOOKUPS} per run)`;
  }
  let processed = 0, usdaHits = 0, aiHits = 0, missed = 0;
  const microCache = new Map(); // food key → micros object (normalized per 100 cal proxy)

  const setProgress = (pct, msg) => {
    bar.style.width = pct + '%';
    progressText.textContent = msg;
  };

  for (let i = 0; i < needsEnrich.length; i += BATCH_SIZE) {
    const batch = needsEnrich.slice(i, i + BATCH_SIZE);
    setProgress(Math.round(i / needsEnrich.length * 80), `Looking up ${i+1}–${Math.min(i+BATCH_SIZE, needsEnrich.length)} of ${needsEnrich.length} foods…`);

    // Parallel USDA lookups for the batch
    await Promise.all(batch.map(async food => {
      const key = food.name.toLowerCase().trim();
      try {
        // Try Foundation + SR Legacy first
        const url = `/api/usda/search?query=${encodeURIComponent(food.name)}&dataType=Foundation,SR%20Legacy,Branded&pageSize=3`;
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        const f = (data.foods || [])[0];
        if (!f) return;

        // Scale to 100g for storage (entries will scale by their own calories)
        // Actually: store absolute micros for a standard reference serving
        // We'll scale to match the entry's calorie count later
        let servingG = parseFloat(f.servingSize) || 100;
        const sUnit = (f.servingSizeUnit || 'g').toLowerCase();
        if (sUnit === 'oz') servingG *= 28.3495;
        const scale100 = 100 / (servingG || 100);
        const micros100 = parseMicronutrients(f.foodNutrients, scale100); // normalized to 100g

        const cal100 = (() => {
          const n = (f.foodNutrients || []).find(x => x.nutrientId === 1008 || x.nutrientId === 208);
          return (n?.value || 0);
        })();

        microCache.set(key, { micros100, cal100: cal100 || 200, source: 'usda', fdcName: f.description });
        usdaHits++;
      } catch(e) { /* will fall through to AI */ }
    }));

    processed += batch.length;
    // Delay between batches to respect rate limits
    if (i + BATCH_SIZE < needsEnrich.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // 4. AI fallback for any still missing — batch them together
  const needsAI = needsEnrich.filter(f => !microCache.has(f.name.toLowerCase().trim()));
  if (needsAI.length > 0) {
    setProgress(82, `AI estimating ${needsAI.length} foods not found in USDA…`);

    // Send in groups of 10 to AI
    for (let i = 0; i < needsAI.length; i += 10) {
      const group = needsAI.slice(i, i + 10);
      const prompt = 'Estimate micronutrients per 100g for these foods. Return ONLY JSON: ' +
        '{"foods":[{"name":"string","cal100":0,"micros":{"vitA":0,"vitC":0,"vitD":0,"vitE":0,"vitK":0,' +
        '"vitB1":0,"vitB2":0,"vitB3":0,"vitB6":0,"vitB12":0,"folate":0,' +
        '"calcium":0,"magnesium":0,"iron":0,"potassium":0,"zinc":0,"selenium":0,' +
        '"fiber":0,"sodium":0,"omega3":0,"cholesterol":0,"saturatedFat":0}}]}. ' +
        'Foods: ' + group.map(f => f.name).join(', ');
      try {
        const data = await callClaudeAPI({
          model: 'claude-haiku-4-5-20251001', max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }]
        });
        const raw = (data.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
        (parsed.foods || []).forEach((f, idx) => {
          if (group[idx]) {
            const key = group[idx].name.toLowerCase().trim();
            microCache.set(key, {
              micros100: f.micros || {},
              cal100: f.cal100 || 200,
              source: 'ai'
            });
            aiHits++;
          }
        });
      } catch(e) { console.warn('AI batch failed:', e); }
    }
  }

  // 5. Write micros back to all matching entries
  setProgress(90, 'Writing micronutrients back to food history…');

  let enriched = 0;
  allDates.forEach(date => {
    let changed = false;
    (foodEntries[date] || []).forEach(entry => {
      if (entry.micros && Object.keys(entry.micros).length > 0) return; // skip already done
      const key = (entry.name || '').toLowerCase().trim();
      const cached = microCache.get(key);
      if (!cached) { missed++; return; }

      // Scale micros from per-100g to this entry's calorie equivalent
      // Use calorie ratio as proxy for serving size
      const entryCals = entry.calories || 200;
      const scaleFactor = cached.cal100 > 0 ? entryCals / cached.cal100 : 1;
      const scaledMicros = {};
      Object.entries(cached.micros100 || {}).forEach(([k, v]) => {
        scaledMicros[k] = Math.round(v * scaleFactor * 1000) / 1000;
      });

      if (Object.keys(scaledMicros).length > 0) {
        entry.micros = scaledMicros;
        entry.microSource = cached.source;
        enriched++;
        changed = true;
      }
    });
    if (changed) setStorage('foodEntries_' + date, foodEntries[date]);
  });

  // Also save back to main foodEntries object
  setStorage('foodEntries', foodEntries);

  setProgress(100, 'Done!');
  missed = needsEnrich.length - usdaHits - aiHits;
  statusEl.innerHTML = `✅ Enriched <strong>${enriched}</strong> entries — ` +
    `<span style="color:#22c55e">${usdaHits} USDA</span> · ` +
    `<span style="color:#a78bfa">${aiHits} AI estimated</span>` +
    (missed > 0 ? ` · <span style="color:#ef4444">${missed} not found</span>` : '');

  btn.disabled = false;
  btn.textContent = '✅ Enrichment Complete — Run Again?';

  // Refresh the nutrition report
  setTimeout(() => renderNutritionReport(30), 500);
}

// ═══════════════════════════════════════════════════════
// ── MEAL ANALYZER ──────────────────────────────────────
// ═══════════════════════════════════════════════════════

let _mealAnalysisData = null;

async function analyzeMealDescription() {
  const desc = (document.getElementById('mealDescInput')?.value || '').trim();
  if (!desc) { showToast('Describe your meal first'); return; }

  const btn = document.getElementById('mealAnalyzeBtn');
  const resultEl = document.getElementById('mealAnalysisResult');
  btn.disabled = true;
  btn.textContent = '⏳ Breaking down meal…';
  resultEl.style.display = 'none';

  // Step 1: Ask Claude to decompose into USDA-searchable ingredients
  const decompPrompt = 'Decompose this meal into individual ingredients for USDA database lookup. ' +
    'Return ONLY JSON: {"meal_name":"string","total_calories_estimate":0,' +
    '"ingredients":[{"name":"USDA-searchable name e.g. chicken breast cooked","grams":0,"serving_desc":"e.g. 6 oz"}]}. ' +
    'Use standard USDA food names. Be specific (cooked vs raw, method). Meal: ' + desc;

  try {
    const decompData = await callClaudeAPI({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [{ role: 'user', content: decompPrompt }]
    });

    const decompRaw = (decompData.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
    const decomp = JSON.parse(decompRaw.match(/\{[\s\S]*\}/)?.[0] || '{}');
    const ingredients = decomp.ingredients || [];

    if (!ingredients.length) throw new Error('No ingredients parsed');

    btn.textContent = `⏳ Looking up ${ingredients.length} ingredients in USDA…`;

    // Step 2: Search USDA for each ingredient
    const lookupResults = await Promise.all(
      ingredients.map(async ing => {
        try {
          // SR Legacy first for best micros
          const url = `/api/usda/search?query=${encodeURIComponent(ing.name)}&dataType=Foundation,SR%20Legacy&pageSize=3`;
          const res = await fetch(url);
          if (!res.ok) return { ing, product: null, found: false };
          const data = await res.json();
          const f = (data.foods || [])[0];
          if (!f) return { ing, product: null, found: false };
          // Scale to the ingredient's gram weight
          const scaleG = ing.grams > 0 ? ing.grams / 100 : 1;
          const p = usdaFoodToProduct(f);
          // Rescale everything to actual gram weight
          const resScaled = {
            ...p,
            calories: Math.round(p.calories * scaleG),
            protein:  Math.round(p.protein  * scaleG * 10) / 10,
            carbs:    Math.round(p.carbs    * scaleG * 10) / 10,
            fat:      Math.round(p.fat      * scaleG * 10) / 10,
            micros:   Object.fromEntries(Object.entries(p.micros || {}).map(([k,v]) => [k, Math.round(v * scaleG * 1000)/1000])),
          };
          return { ing, product: resScaled, found: true };
        } catch(e) {
          return { ing, product: null, found: false };
        }
      })
    );

    // Step 3: For not-found ingredients, use AI estimation
    const notFound = lookupResults.filter(r => !r.found);
    if (notFound.length > 0) {
      const estimatePrompt = 'Estimate nutrition for these ingredients (per specified gram amounts). ' +
        'Return ONLY JSON: {"estimates":[{"name":"string","calories":0,"protein":0,"carbs":0,"fat":0,' +
        '"micros":{"vitC":0,"vitD":0,"calcium":0,"magnesium":0,"iron":0,"potassium":0,"zinc":0,"fiber":0}}]}. ' +
        'Ingredients: ' + notFound.map(r => r.ing.name + ' ' + r.ing.grams + 'g').join(', ');
      try {
        const estData = await callClaudeAPI({
          model: 'claude-sonnet-4-6', max_tokens: 800,
          messages: [{ role: 'user', content: estimatePrompt }]
        });
        const estRaw = (estData.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
        const estimates = JSON.parse(estRaw.match(/\{[\s\S]*\}/)?.[0] || '{}').estimates || [];
        estimates.forEach((est, i) => {
          if (notFound[i]) {
            notFound[i].product = { ...est, source: 'ai', microQuality: 'estimated' };
            notFound[i].found = true;
          }
        });
      } catch(e) { /* best effort */ }
    }

    // Step 4: Sum everything up
    const totals = { calories: 0, protein: 0, carbs: 0, fat: 0, micros: {} };
    lookupResults.forEach(r => {
      if (!r.product) return;
      totals.calories += r.product.calories || 0;
      totals.protein  += r.product.protein  || 0;
      totals.carbs    += r.product.carbs    || 0;
      totals.fat      += r.product.fat      || 0;
      Object.entries(r.product.micros || {}).forEach(([k, v]) => {
        totals.micros[k] = (totals.micros[k] || 0) + v;
      });
    });

    _mealAnalysisData = {
      name: decomp.meal_name || desc.slice(0, 40),
      ingredients: lookupResults,
      totals,
      icon: '🍽️'
    };

    // Render the breakdown
    const foundCount = lookupResults.filter(r => r.found).length;
    const microCount = Object.keys(totals.micros).length;
    resultEl.innerHTML = `
      <div style="background:var(--surface2);border-radius:14px;padding:14px;margin-bottom:12px">
        <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:10px">${_mealAnalysisData.name}</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:10px">
          <div style="text-align:center"><div style="font-size:18px;font-weight:800;color:#f59e0b">${Math.round(totals.calories)}</div><div style="font-size:10px;color:var(--text3)">kcal</div></div>
          <div style="text-align:center"><div style="font-size:18px;font-weight:800;color:#22c55e">${totals.protein.toFixed(1)}g</div><div style="font-size:10px;color:var(--text3)">protein</div></div>
          <div style="text-align:center"><div style="font-size:18px;font-weight:800;color:#3b82f6">${totals.carbs.toFixed(1)}g</div><div style="font-size:10px;color:var(--text3)">carbs</div></div>
          <div style="text-align:center"><div style="font-size:18px;font-weight:800;color:#ef4444">${totals.fat.toFixed(1)}g</div><div style="font-size:10px;color:var(--text3)">fat</div></div>
        </div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:10px">${foundCount}/${ingredients.length} ingredients found · ${microCount} micronutrients captured</div>
        ${lookupResults.map(r => `
          <div class="meal-ingredient-row">
            <span class="meal-ingredient-status">${r.found ? (r.product?.source === 'ai' ? '🔵' : '✅') : '❌'}</span>
            <div style="flex:1">
              <div style="font-weight:600;color:var(--text)">${r.ing.serving_desc || r.ing.name}</div>
              <div style="color:var(--text3);font-size:11px">${r.found ? (r.product?.name || r.ing.name) + ' · ' + (r.product?.calories || 0) + ' kcal' : 'Not found — excluded'}</div>
            </div>
          </div>`).join('')}
      </div>
      <button onclick="logMealToday()" style="width:100%;background:#22c55e;border:none;border-radius:12px;padding:13px;color:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">✓ Log This Meal</button>
    `;
    resultEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = '🔄 Re-analyze';

  } catch(e) {
    console.error('Meal analysis error:', e);
    btn.disabled = false;
    btn.textContent = '🤖 Analyze Meal + Get Micros';
    showToast('❌ Could not analyze meal. Be more specific about ingredients and amounts.');
  }
}

function logMealToday() {
  if (!_mealAnalysisData) return;
  const { name, totals, icon } = _mealAnalysisData;
  addFoodEntry({
    name,
    calories: Math.round(totals.calories),
    protein:  Math.round(totals.protein  * 10) / 10,
    carbs:    Math.round(totals.carbs    * 10) / 10,
    fat:      Math.round(totals.fat      * 10) / 10,
    micros:   Object.keys(totals.micros).length ? totals.micros : undefined,
    icon: icon || '🍽️',
  });
  closeAISearch();
  showToast('✅ Meal logged with ' + Object.keys(totals.micros || {}).length + ' micronutrients!');
  _mealAnalysisData = null;
}

// ═══════════════════════════════════════════════════════
// ── SUPPLEMENT LOGGER ──────────────────────────────────
// ═══════════════════════════════════════════════════════

const SUPPLEMENT_PRESETS = [
  { name: 'Vitamin D3 2000 IU',  icon: '☀️', calories: 0, protein: 0, carbs: 0, fat: 0, micros: { vitD: 50 } },
  { name: 'Vitamin D3 5000 IU',  icon: '☀️', calories: 0, protein: 0, carbs: 0, fat: 0, micros: { vitD: 125 } },
  { name: 'Magnesium 400mg',      icon: '💊', calories: 0, protein: 0, carbs: 0, fat: 0, micros: { magnesium: 400 } },
  { name: 'Magnesium Glycinate 200mg', icon: '💊', calories: 0, protein: 0, carbs: 0, fat: 0, micros: { magnesium: 200 } },
  { name: 'Zinc 15mg',            icon: '💊', calories: 0, protein: 0, carbs: 0, fat: 0, micros: { zinc: 15 } },
  { name: 'Zinc 30mg',            icon: '💊', calories: 0, protein: 0, carbs: 0, fat: 0, micros: { zinc: 30 } },
  { name: 'Fish Oil 1g (1000mg)', icon: '🐟', calories: 9, protein: 0, carbs: 0, fat: 1, micros: { omega3: 0.3, epa: 0.18, dha: 0.12 } },
  { name: 'Fish Oil 2g (2000mg)', icon: '🐟', calories: 18, protein: 0, carbs: 0, fat: 2, micros: { omega3: 0.6, epa: 0.36, dha: 0.24 } },
  { name: 'Omega-3 Triple Strength', icon: '🐟', calories: 25, protein: 0, carbs: 0, fat: 3, micros: { omega3: 2.4, epa: 1.0, dha: 0.8 } },
  { name: 'Vitamin C 500mg',      icon: '🍊', calories: 0, protein: 0, carbs: 0, fat: 0, micros: { vitC: 500 } },
  { name: 'Vitamin C 1000mg',     icon: '🍊', calories: 0, protein: 0, carbs: 0, fat: 0, micros: { vitC: 1000 } },
  { name: 'Vitamin K2 100mcg',    icon: '💊', calories: 0, protein: 0, carbs: 0, fat: 0, micros: { vitK: 100 } },
  { name: 'Vitamin B12 1000mcg',  icon: '💊', calories: 0, protein: 0, carbs: 0, fat: 0, micros: { vitB12: 1000 } },
  { name: 'Folate 400mcg',        icon: '💊', calories: 0, protein: 0, carbs: 0, fat: 0, micros: { folate: 400 } },
  { name: 'Iron 18mg',            icon: '🔴', calories: 0, protein: 0, carbs: 0, fat: 0, micros: { iron: 18 } },
  { name: 'Calcium 500mg',        icon: '🦴', calories: 0, protein: 0, carbs: 0, fat: 0, micros: { calcium: 500 } },
  { name: 'Potassium 99mg',       icon: '🍌', calories: 0, protein: 0, carbs: 0, fat: 0, micros: { potassium: 99 } },
  { name: "Multivitamin (Men's)", icon: '💊', calories: 10, protein: 0, carbs: 2, fat: 0,
    micros: { vitA: 900, vitC: 90, vitD: 25, vitE: 15, vitK: 75, vitB1: 1.5, vitB2: 1.7, vitB3: 20, vitB6: 2, vitB12: 6, folate: 400, calcium: 200, magnesium: 100, zinc: 11, iron: 18, selenium: 55 } },
  { name: 'NMN 500mg',            icon: '⚡', calories: 0, protein: 0, carbs: 0, fat: 0, micros: {} },
  { name: 'Creatine 5g',          icon: '💪', calories: 0, protein: 0, carbs: 0, fat: 0, micros: {} },
  { name: 'Collagen Peptides 10g', icon: '💪', calories: 38, protein: 9, carbs: 0, fat: 0, micros: {} },
];

let _customSuppNutrients = [];

function renderSuppPresets() {
  const el = document.getElementById('suppPresetList');
  if (!el) return;
  el.innerHTML = SUPPLEMENT_PRESETS.map((s, i) => {
    const microSummary = Object.entries(s.micros || {}).slice(0, 3)
      .map(([k, v]) => (MICRO_RDV[k]?.[2] || k) + ' ' + v + (MICRO_RDV[k]?.[1] || ''))
      .join(' · ') || 'Tracked for compliance';
    return `<div class="supp-preset-row">
      <div class="supp-preset-info">
        <div class="supp-preset-name">${s.icon} ${s.name}</div>
        <div class="supp-preset-detail">${microSummary}</div>
      </div>
      <button class="supp-log-btn" onclick="logPresetSupplement(${i})">Log</button>
    </div>`;
  }).join('');

  // Custom supplement nutrient fields
  _customSuppNutrients = [];
  renderCustomSuppNutrients();
}

function renderCustomSuppNutrients() {
  const el = document.getElementById('suppCustomNutrients');
  if (!el) return;
  const commonNutrients = Object.entries(MICRO_RDV).map(([k, [,unit,name]]) => `<option value="${k}">${name} (${unit})</option>`).join('');
  el.innerHTML = _customSuppNutrients.map((n, i) => `
    <div style="display:flex;gap:4px;align-items:center">
      <select onchange="_customSuppNutrients[${i}].key=this.value" style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:6px;color:var(--text);font-size:11px;font-family:inherit">
        ${commonNutrients}
      </select>
      <input type="number" placeholder="mg" style="width:60px;padding:6px;font-size:11px" value="${n.value||''}" onchange="_customSuppNutrients[${i}].value=parseFloat(this.value)||0">
      <button onclick="_customSuppNutrients.splice(${i},1);renderCustomSuppNutrients()" style="background:none;border:none;color:#ef4444;font-size:16px;cursor:pointer;padding:0 4px">×</button>
    </div>
  `).join('');
}

function addCustomSuppNutrient() {
  _customSuppNutrients.push({ key: 'vitD', value: 0 });
  renderCustomSuppNutrients();
}

function logPresetSupplement(idx) {
  const s = SUPPLEMENT_PRESETS[idx];
  addFoodEntry({
    name: s.name,
    calories: s.calories || 0,
    protein:  s.protein  || 0,
    carbs:    s.carbs    || 0,
    fat:      s.fat      || 0,
    micros:   Object.keys(s.micros || {}).length ? s.micros : undefined,
    icon: s.icon || '💊',
  });
  showToast('✅ ' + s.name + ' logged!');
}

function logCustomSupplement() {
  const name = (document.getElementById('suppCustomName')?.value || '').trim();
  if (!name) { showToast('Enter a supplement name'); return; }
  const micros = {};
  _customSuppNutrients.forEach(n => { if (n.key && n.value > 0) micros[n.key] = n.value; });
  addFoodEntry({
    name, calories: 0, protein: 0, carbs: 0, fat: 0,
    micros: Object.keys(micros).length ? micros : undefined,
    icon: '💊',
  });
  document.getElementById('suppCustomName').value = '';
  _customSuppNutrients = [];
  renderCustomSuppNutrients();
  showToast('✅ ' + name + ' logged!');
}

// ── One-time seed: Labcorp Oct 2024 results ──
(function seedLabcorpOct2024() {
  try {
    const existing = getStorage('bloodResults', []);
    if (existing.some(r => r.date === '2024-10-11')) return;
    const entry = {
      id: 1728691200000,
      date: '2024-10-11',
      lab: 'Labcorp',
      markers: [
        {name:'WBC',key:'wbc',value:4.4,unit:'x10E3/uL',ref_low:3.4,ref_high:10.8,flag:null},
        {name:'RBC',key:'rbc',value:4.74,unit:'x10E6/uL',ref_low:4.14,ref_high:5.80,flag:null},
        {name:'Hemoglobin',key:'hemoglobin',value:14.5,unit:'g/dL',ref_low:13.0,ref_high:17.7,flag:null},
        {name:'Hematocrit',key:'hematocrit',value:44.5,unit:'%',ref_low:37.5,ref_high:51.0,flag:null},
        {name:'Platelets',key:'platelets',value:269,unit:'x10E3/uL',ref_low:150,ref_high:450,flag:null},
        {name:'Glucose',key:'glucose',value:83,unit:'mg/dL',ref_low:70,ref_high:99,flag:null},
        {name:'BUN',key:'bun',value:26,unit:'mg/dL',ref_low:6,ref_high:24,flag:'H'},
        {name:'Creatinine',key:'creatinine',value:1.13,unit:'mg/dL',ref_low:0.76,ref_high:1.27,flag:null},
        {name:'eGFR',key:'egfr',value:79,unit:'mL/min/1.73',ref_low:59,ref_high:999,flag:null},
        {name:'Sodium',key:'sodium',value:139,unit:'mmol/L',ref_low:134,ref_high:144,flag:null},
        {name:'Potassium',key:'potassium',value:4.8,unit:'mmol/L',ref_low:3.5,ref_high:5.2,flag:null},
        {name:'Calcium',key:'calcium',value:10.6,unit:'mg/dL',ref_low:8.7,ref_high:10.2,flag:'H'},
        {name:'ALT',key:'alt',value:17,unit:'IU/L',ref_low:0,ref_high:44,flag:null},
        {name:'AST',key:'ast',value:22,unit:'IU/L',ref_low:0,ref_high:40,flag:null},
        {name:'Alkaline Phosphatase',key:'alkaline_phosphatase',value:57,unit:'IU/L',ref_low:44,ref_high:121,flag:null},
        {name:'Total Cholesterol',key:'total_cholesterol',value:243,unit:'mg/dL',ref_low:0,ref_high:199,flag:'H'},
        {name:'LDL',key:'ldl',value:153,unit:'mg/dL',ref_low:0,ref_high:99,flag:'H'},
        {name:'HDL',key:'hdl',value:77,unit:'mg/dL',ref_low:40,ref_high:999,flag:null},
        {name:'Triglycerides',key:'triglycerides',value:76,unit:'mg/dL',ref_low:0,ref_high:149,flag:null},
        {name:'Lipoprotein(a)',key:'lipoprotein_a',value:123.2,unit:'nmol/L',ref_low:0,ref_high:75,flag:'H'},
        {name:'Apolipoprotein B',key:'apolipoprotein_b',value:117,unit:'mg/dL',ref_low:0,ref_high:90,flag:'H'},
        {name:'Testosterone',key:'testosterone_total',value:614,unit:'ng/dL',ref_low:264,ref_high:916,flag:null},
        {name:'Free Testosterone',key:'testosterone_free',value:104.9,unit:'pg/mL',ref_low:30.3,ref_high:183.2,flag:null},
        {name:'TSH',key:'tsh',value:1.64,unit:'uIU/mL',ref_low:0.45,ref_high:4.5,flag:null},
        {name:'Free T4',key:'t4_free',value:1.68,unit:'ng/dL',ref_low:0.82,ref_high:1.77,flag:null},
        {name:'Free T3',key:'free_t3',value:3.2,unit:'pg/mL',ref_low:2.0,ref_high:4.4,flag:null},
        {name:'DHEA-Sulfate',key:'dhea_s',value:111,unit:'ug/dL',ref_low:71.6,ref_high:375.4,flag:null},
        {name:'Cortisol',key:'cortisol',value:16.0,unit:'ug/dL',ref_low:6.2,ref_high:19.4,flag:null},
        {name:'Insulin',key:'insulin',value:2.1,unit:'uIU/mL',ref_low:2.6,ref_high:24.9,flag:'L'},
        {name:'Estradiol',key:'estradiol',value:9.7,unit:'pg/mL',ref_low:7.6,ref_high:42.6,flag:null},
        {name:'Vitamin D',key:'vitamin_d',value:44.8,unit:'ng/mL',ref_low:30,ref_high:100,flag:null},
        {name:'Vitamin B12',key:'vitamin_b12',value:699,unit:'pg/mL',ref_low:232,ref_high:1245,flag:null},
        {name:'Folate',key:'folate',value:10.2,unit:'ng/mL',ref_low:3.0,ref_high:20,flag:null},
        {name:'Ferritin',key:'ferritin',value:88,unit:'ng/mL',ref_low:30,ref_high:400,flag:null},
        {name:'Iron',key:'iron',value:103,unit:'ug/dL',ref_low:38,ref_high:169,flag:null},
        {name:'CRP Cardiac',key:'crp',value:0.46,unit:'mg/L',ref_low:0,ref_high:3.0,flag:null},
        {name:'HbA1c',key:'hba1c',value:5.5,unit:'%',ref_low:4.8,ref_high:5.6,flag:null},
        {name:'PSA',key:'psa',value:0.5,unit:'ng/mL',ref_low:0,ref_high:4.0,flag:null},
        {name:'Magnesium',key:'magnesium',value:2.1,unit:'mg/dL',ref_low:1.6,ref_high:2.3,flag:null},
      ],
      uploadedAt: new Date().toISOString(),
    };
    const all = getStorage('bloodResults', []);
    all.unshift(entry);
    setStorage('bloodResults', all);
    console.log('✅ Seeded Labcorp Oct 2024 (39 markers)');
  } catch(e) { console.warn('Seed failed:', e); }
})();



// ── Claude AI Chat ──
const CLAUDE_HISTORY_MAX = 20; // keep last 20 messages (10 exchanges)
let claudeHistory = [];

function getAppContext() {
  const todayK = todayKey();
  const userMacros = getStorage('userMacros', MACROS);
  const tdee = getStorage('userTDEE', TDEE);

  // Today's food - use foodEntries (correct storage key)
  const allFoodEntries = getStorage('foodEntries', {});
  const macroLog = getStorage('macroLog', {});
  const entries = allFoodEntries[todayK] || [];
  const todayMacros = macroLog[todayK] || {};
  const totals = Object.keys(todayMacros).length ? todayMacros : entries.reduce((a, e) => ({
    calories: a.calories + (e.calories||0),
    protein: a.protein + (e.protein||0),
    carbs: a.carbs + (e.carbs||0),
    fat: a.fat + (e.fat||0)
  }), {calories:0, protein:0, carbs:0, fat:0});

  // Full food history - last 30 days using correct storage key
  const foodHistory = [];
  for (let i = 1; i <= 30; i++) {
    const d = nowEST();
    d.setDate(d.getDate() - i);
    const dk = dateToKey(d);
    const dayEntries = allFoodEntries[dk];
    if (dayEntries && dayEntries.length > 0) {
      const dt = macroLog[dk] || dayEntries.reduce((a, e) => ({
        calories: a.calories + (e.calories||0),
        protein: a.protein + (e.protein||0),
        carbs: a.carbs + (e.carbs||0),
        fat: a.fat + (e.fat||0)
      }), {calories:0, protein:0, carbs:0, fat:0});
      const foods = dayEntries.map(e => e.name).filter(Boolean).join(', ');
      foodHistory.push(`${dk}: ${Math.round(dt.calories)}cal P:${Math.round(dt.protein)}g C:${Math.round(dt.carbs)}g F:${Math.round(dt.fat)}g | ${foods}`);
    }
  }

  // Full weight log
  const weightHistory = getWeightEntries().map(w => `${w.date}: ${w.weight} lbs`);

  // All runs
  const shoeRuns = getStorage('shoeRuns', []);
  const allRuns = shoeRuns.map(r => `${r.date}: ${r.miles} mi${r.shoe ? ' ('+r.shoe+')' : ''}`);

  // All workouts
  const workouts = getStorage('workoutHistory', []);
  const allWorkouts = workouts.map(w => `${w.date}: ${w.name||'workout'}${w.exercises ? ' - '+w.exercises.map(e=>e.name).join(', ') : ''}`);

  // Lift PRs
  const prs = getStorage('liftPRs', {});
  const prList = Object.entries(prs).map(([k,v]) => `${k}: ${v.weight||v}lbs x${v.reps||1} (1RM: ${v.est1rm||v.weight||v}lbs)`);

  // Shoes
  const shoes = getStorage('shoeGarage', []);
  const shoeList = shoes.map(s => `${s.name}: ${s.miles||0} mi used`);

  // Saved foods (frequent foods)
  const savedFoods = getStorage('savedFoods', []);
  const topFoods = savedFoods.slice(0, 20).map(f => `${f.name} (${f.calories}cal, P:${f.protein}g)`);

  // Claude memory - things learned over time
  const memory = getStorage('claudeMemory', []);

  // Calorie burn log
  const burnLog = getStorage('burnLog', {});
  const recentBurns = Object.entries(burnLog).slice(-7).map(([d,b]) => `${d}: -${b}cal burned`);

  return `You are Jeremy's personal AI fitness coach with FULL access to his health data. You know everything about his nutrition, workouts, and progress. Be specific, data-driven, and proactive.

=== JEREMY'S PROFILE ===
Age: 52 | Goal: 170 → 163 lbs in 30 days
Daily targets: ${userMacros.calories} cal | ${userMacros.protein}g protein | ${userMacros.carbs}g carbs | ${userMacros.fat}g fat
TDEE: ${tdee} cal/day

=== TODAY (${todayK}) ===
Calories: ${Math.round(totals.calories)} / ${userMacros.calories} (${Math.round(userMacros.calories - totals.calories)} remaining)
Protein: ${Math.round(totals.protein)}g / ${userMacros.protein}g | Carbs: ${Math.round(totals.carbs)}g | Fat: ${Math.round(totals.fat)}g
Foods: ${entries.map(e => e.name).join(', ') || 'none logged yet'}

=== FOOD HISTORY (last 30 days) ===
${foodHistory.length ? foodHistory.join('\n') : 'No history'}

=== WEIGHT HISTORY (all entries) ===
${weightHistory.length ? weightHistory.join('\n') : 'No entries'}

=== ALL RUNS ===
${allRuns.length ? allRuns.slice(-30).join('\n') : 'No runs logged'}

=== ALL WORKOUTS ===
${allWorkouts.length ? allWorkouts.slice(-30).join('\n') : 'No workouts logged'}

=== LIFT PRs ===
${prList.length ? prList.join(' | ') : 'None recorded'}

=== SHOES ===
${shoeList.length ? shoeList.join(' | ') : 'None'}

=== CALORIE BURNS (recent) ===
${recentBurns.length ? recentBurns.join('\n') : 'None'}

=== FREQUENT FOODS ===
${topFoods.length ? topFoods.join(', ') : 'None saved'}

=== MEMORY (learned preferences) ===
${memory.length ? memory.join('\n') : 'Nothing stored yet'}

=== APP USAGE PATTERNS ===
${getUsageSummary()}

${getWhoopContextFull()}

You can remember things by saying "REMEMBER: [fact]" in your response and it will be saved for future conversations.
Be concise, data-driven, and proactive. Reference specific numbers from Jeremy's actual data.`;
}

// ── Events & Countdowns ──
function getEvents() { return getStorage('userEvents', []); }
function saveEvents(events) { setStorage('userEvents', events); }

let _eventType = 'race';
function setEventType(type) {
  _eventType = type;
  document.getElementById('evtTypeRace').style.background = type === 'race' ? '#3b82f6' : 'var(--surface2)';
  document.getElementById('evtTypeRace').style.color = type === 'race' ? '#fff' : 'var(--text2)';
  document.getElementById('evtTypeRace').style.borderColor = type === 'race' ? '#3b82f6' : 'var(--border)';
  document.getElementById('evtTypeWeight').style.background = type === 'weight' ? '#22c55e' : 'var(--surface2)';
  document.getElementById('evtTypeWeight').style.color = type === 'weight' ? '#fff' : 'var(--text2)';
  document.getElementById('evtTypeWeight').style.borderColor = type === 'weight' ? '#22c55e' : 'var(--border)';
  document.getElementById('eventWeightRow').style.display = type === 'weight' ? 'block' : 'none';
  document.getElementById('eventNameInput').placeholder = type === 'weight' ? 'e.g. Race Weight, Summer Goal' : 'e.g. Grandma\'s Marathon';
}

function openAddEventModal() {
  _eventType = 'race';
  setEventType('race');
  document.getElementById('eventEditId').value = '';
  document.getElementById('eventNameInput').value = '';
  document.getElementById('eventDateInput').value = '';
  document.getElementById('eventWeightTarget').value = '';
  document.getElementById('addEventModalTitle').textContent = '🏁 Add Event / Goal';
  document.getElementById('saveEventBtn').textContent = 'Save';
  document.getElementById('evtTypeRow').style.display = 'flex';
  document.getElementById('addEventModal').classList.add('open');
}

function openEditEventModal(id) {
  const event = getEvents().find(e => e.id === id);
  if (!event) return;
  _eventType = event.type || 'race';
  setEventType(_eventType);
  document.getElementById('eventEditId').value = id;
  document.getElementById('eventNameInput').value = event.name;
  document.getElementById('eventDateInput').value = event.date;
  document.getElementById('eventWeightTarget').value = event.weightTarget || '';
  document.getElementById('addEventModalTitle').textContent = '✏️ Edit Event';
  document.getElementById('saveEventBtn').textContent = 'Update';
  document.getElementById('evtTypeRow').style.display = 'none';
  document.getElementById('addEventModal').classList.add('open');
}

function saveEvent() {
  const name = document.getElementById('eventNameInput').value.trim();
  const date = document.getElementById('eventDateInput').value;
  if (!name || !date) return;
  const editId = document.getElementById('eventEditId').value;
  let events = getEvents();

  if (editId) {
    // Edit existing
    events = events.map(e => {
      if (e.id !== parseInt(editId) && e.id !== editId) return e;
      const updated = { ...e, name, date };
      if (e.type === 'weight') {
        const target = parseFloat(document.getElementById('eventWeightTarget').value);
        if (target) updated.weightTarget = target;
      }
      return updated;
    });
  } else {
    // Add new
    const event = { id: Date.now(), name, date, type: _eventType };
    if (_eventType === 'weight') {
      const target = parseFloat(document.getElementById('eventWeightTarget').value);
      if (target) event.weightTarget = target;
    }
    events.push(event);
    events.sort((a, b) => a.date.localeCompare(b.date));
  }

  saveEvents(events);
  document.getElementById('addEventModal').classList.remove('open');
  renderEventCountdowns();
  renderEventList();
}

function deleteEvent(id) {
  const events = getEvents().filter(e => e.id !== id);
  saveEvents(events);
  renderEventCountdowns();
  renderEventList();
}

function daysUntil(dateStr) {
  const today = nowEST();
  today.setHours(0,0,0,0);
  const target = new Date(dateStr + 'T00:00:00');
  return Math.ceil((target - today) / 86400000);
}

function renderEventCountdowns() {
  const container = document.getElementById('eventCountdowns');
  if (!container) return;
  const events = getEvents().filter(e => daysUntil(e.date) >= 0);
  const currentWeight = getLatestWeight();

  if (!events.length) { container.innerHTML = ''; return; }

  // Build items for each event
  const items = events.map(e => {
    const days = daysUntil(e.date);
    const urgent = days <= 7;
    const soon = days <= 30;
    const isWeight = e.type === 'weight';
    const color = isWeight ? '#22c55e' : urgent ? '#ef4444' : soon ? '#f59e0b' : '#3b82f6';
    const emoji = isWeight ? '⚖️' : urgent ? '🚨' : soon ? '⚡' : '🏁';
    const dateStr = new Date(e.date + 'T00:00:00').toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'});

    if (isWeight && e.weightTarget) {
      const goals = getStorage('userGoals', {});
      const target = goals.goal || e.weightTarget;
      const goalDate = goals.goalDate || e.date;
      const byDate = new Date(goalDate + 'T00:00:00').toLocaleDateString('en-US', {month:'short', day:'numeric'});
      const daysToGoal = Math.max(0, Math.round((new Date(goalDate + 'T12:00:00') - new Date(todayKey() + 'T12:00:00')) / 86400000));
      const diff = currentWeight ? +(currentWeight - target).toFixed(1) : null;
      const color2 = '#22c55e';
      return `<div style="flex:1;text-align:center;padding:0 8px">
        <div style="font-size:10px;font-weight:700;color:${color2};letter-spacing:1px;text-transform:uppercase;margin-bottom:4px">${emoji} ${esc(e.name)}</div>
        <div style="font-size:26px;font-weight:900;color:${color2};letter-spacing:-1px">${target}<span style="font-size:12px;font-weight:600;color:var(--text2)">lbs</span></div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">by ${byDate}</div>
        <div style="font-size:11px;color:${color2};font-weight:700;margin-top:2px">${diff !== null ? (diff <= 0 ? '✅ Achieved!' : diff + ' lbs to go') : daysToGoal + ' days left'}</div>
      </div>`;
    } else {
      return `<div style="flex:1;text-align:center;padding:0 8px">
        <div style="font-size:10px;font-weight:700;color:${color};letter-spacing:1px;text-transform:uppercase;margin-bottom:4px">${emoji} ${esc(e.name)}</div>
        <div style="font-size:26px;font-weight:900;color:var(--text);letter-spacing:-1px">${days}<span style="font-size:12px;font-weight:600;color:var(--text2)"> days</span></div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">to go</div>
        <div style="font-size:10px;color:var(--text3);margin-top:1px">${dateStr}</div>
      </div>`;
    }
  });

  // Render all in one card with dividers
  const divider = `<div style="width:1px;background:var(--border);margin:4px 0"></div>`;
  container.innerHTML = `<div class="card" style="padding:14px 18px;margin-bottom:14px">
    <div style="display:flex;align-items:center;justify-content:space-around">
      ${items.join(divider)}
    </div>
  </div>`;
}

function renderEventList() {
  const container = document.getElementById('eventList');
  if (!container) return;
  const events = getEvents();
  if (!events.length) {
    container.innerHTML = '<div style="font-size:13px;color:var(--text3);text-align:center;padding:12px">No events added yet</div>';
    return;
  }
  const currentWeight = getLatestWeight();

  container.innerHTML = events.map(e => {
    const days = daysUntil(e.date);
    const past = days < 0;
    const isWeight = e.type === 'weight';
    const color = past ? '#64748b' : isWeight ? '#22c55e' : days <= 7 ? '#ef4444' : days <= 30 ? '#f59e0b' : '#3b82f6';
    const emoji = isWeight ? '⚖️' : '🏁';
    let sub = past ? 'Completed' : days + ' days away';
    if (isWeight && e.weightTarget && currentWeight && !past) {
      const diff = (currentWeight - e.weightTarget).toFixed(1);
      sub += ` · Target: ${e.weightTarget}lbs (${diff > 0 ? diff + ' to lose' : 'achieved!'})`;
    }
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-size:14px;font-weight:700;color:var(--text)">${emoji} ${esc(e.name)}</div>
        <div style="font-size:11px;color:${color};font-weight:600;margin-top:2px">${sub} · ${new Date(e.date + 'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</div>
      </div>
      <div style="display:flex;gap:4px">
        <button onclick="openEditEventModal(${e.id})" style="background:none;border:none;color:#60a5fa;font-size:18px;cursor:pointer;padding:4px 8px">✏️</button>
        <button onclick="deleteEvent(${e.id})" style="background:none;border:none;color:#ef4444;font-size:18px;cursor:pointer;padding:4px 8px">🗑</button>
      </div>
    </div>`;
  }).join('');
}

// ── End Events ──

// ── Interaction Tracker ──
function logInteraction(type, detail) {
  try {
    const log = getStorage('interactionLog', []);
    const now = nowEST();
    log.push({ type, detail, date: dateToKey(now), hour: now.getHours(), ts: Date.now() });
    if (log.length > 500) log.splice(0, log.length - 500);
    setStorage('interactionLog', log);
  } catch(e) {}
}

function getUsageSummary() {
  const log = getStorage('interactionLog', []);
  if (!log.length) return 'No interaction data yet — use the app more and check back!';

  const tabCounts = {}, hourCounts = {}, featureCounts = {}, dailyActivity = {};
  log.forEach(e => {
    if (e.type === 'tab_visit') tabCounts[e.detail] = (tabCounts[e.detail]||0) + 1;
    if (e.hour !== undefined) {
      const label = e.hour < 6 ? 'night(early)' : e.hour < 12 ? 'morning' : e.hour < 17 ? 'afternoon' : e.hour < 21 ? 'evening' : 'night';
      hourCounts[label] = (hourCounts[label]||0) + 1;
    }
    if (e.date) dailyActivity[e.date] = (dailyActivity[e.date]||0) + 1;
    if (e.type !== 'tab_visit') featureCounts[e.type] = (featureCounts[e.type]||0) + 1;
  });

  const totalDays = Object.keys(dailyActivity).length;
  const avgPerDay = totalDays ? (log.length / totalDays).toFixed(1) : 0;
  const topTabs = Object.entries(tabCounts).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}(${v}x)`).join(', ');
  const leastTabs = Object.entries(tabCounts).sort((a,b)=>a[1]-b[1]).slice(0,3).map(([k,v])=>`${k}(${v}x)`).join(', ');
  const topHours = Object.entries(hourCounts).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}(${v}x)`).join(', ');
  const topFeatures = Object.entries(featureCounts).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([k,v])=>`${k}(${v}x)`).join(', ');

  return `USAGE DATA (${log.length} interactions, ${totalDays} days tracked, avg ${avgPerDay}/day)
Most visited tabs: ${topTabs || 'none yet'}
Least visited tabs: ${leastTabs || 'none yet'}
Most active time: ${topHours || 'none yet'}
Features used: ${topFeatures || 'none yet'}`;
}

function triggerAppImprovement() {
  const summary = getUsageSummary();
  const prompt = `Analyze how I actually use this app and suggest specific improvements.

${summary}

App tabs: Today, Recipes, Trends, Shoes, Workout, Program, History, AI.
Features: food logging, barcode scanning, macro tracking, weight logging, shoe mileage, workout logging, lift PRs, recipe builder, run tracking, TrainingPeaks integration, AI coaching, event countdowns.

Please analyze:
1. Which features I use most vs least — should underused ones be removed, simplified, or made more prominent?
2. What patterns do you see in when/how I use the app?
3. What features might be missing based on my behavior?
4. Specific UI improvements for my top 3 most-used areas.

Be direct and specific. Reference my actual usage numbers.`;
  claudeQuickPrompt(prompt);
}
// ── End Interaction Tracker ──

function processClaudeMemory(response) {
  const memoryMatches = response.match(/REMEMBER:\s*(.+)/gi);
  if (memoryMatches) {
    const memory = getStorage('claudeMemory', []);
    memoryMatches.forEach(m => {
      const fact = m.replace(/REMEMBER:\s*/i, '').trim();
      if (!memory.includes(fact)) {
        memory.push(fact);
        if (memory.length > 50) memory.shift(); // keep last 50
      }
    });
    setStorage('claudeMemory', memory);
  }
}

// Voice dictation for Claude input
let _voiceRecognition = null;
let _voiceActive = false;

function toggleVoiceDictation() {
  const btn = document.getElementById('claudeVoiceBtn');
  const input = document.getElementById('claudeInput');

  if (_voiceActive) {
    _voiceRecognition?.stop();
    return;
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    alert('Voice dictation not supported in this browser.');
    return;
  }

  _voiceRecognition = new SR();
  _voiceRecognition.lang = 'en-US';
  _voiceRecognition.continuous = false;
  _voiceRecognition.interimResults = true;

  _voiceRecognition.onstart = () => {
    _voiceActive = true;
    btn.style.background = '#ef4444';
    btn.textContent = '🔴';
  };

  _voiceRecognition.onresult = (e) => {
    const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
    input.value = transcript;
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  };

  _voiceRecognition.onend = () => {
    _voiceActive = false;
    btn.style.background = '#1e3a5f';
    btn.textContent = '🎤';
    // Auto-send if we got something
    if (input.value.trim()) sendClaudeMessage();
  };

  _voiceRecognition.onerror = () => {
    _voiceActive = false;
    btn.style.background = '#1e3a5f';
    btn.textContent = '🎤';
  };

  _voiceRecognition.start();
}

function claudeQuickPrompt(text) {
  document.getElementById('claudeInput').value = text;
  sendClaudeMessage();
}

async function sendClaudeMessage() {
  const input = document.getElementById('claudeInput');
  const msg = input.value.trim();
  if (!msg) return;

  input.value = '';
  input.style.height = 'auto';

  // Add user message
  appendClaudeMessage('user', msg);
  claudeHistory.push({ role: 'user', content: msg });

  // Show typing indicator
  const typingId = 'typing_' + Date.now();
  appendClaudeMessage('typing', '...', typingId);

  document.getElementById('claudeSendBtn').disabled = true;

  try {
    const resp = await fetch('/api/claude', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        max_tokens: 1024,
        system: getAppContext(),
        messages: claudeHistory
      })
    });

    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    const reply = data.content?.[0]?.text || 'Sorry, I had trouble responding.';

    // Remove typing indicator
    document.getElementById(typingId)?.remove();

    claudeHistory.push({ role: 'assistant', content: reply });
    // Cap history to prevent unbounded token growth
    if (claudeHistory.length > CLAUDE_HISTORY_MAX) {
      claudeHistory = claudeHistory.slice(-CLAUDE_HISTORY_MAX);
    }
    processClaudeMemory(reply);
    const displayReply = reply.replace(/REMEMBER:\s*.+/gi, '').trim();
    appendClaudeMessage('assistant', displayReply);

  } catch(e) {
    document.getElementById(typingId)?.remove();
    appendClaudeMessage('assistant', '❌ Error: ' + (e.message || 'Unknown error'));
  }

  document.getElementById('claudeSendBtn').disabled = false;
  document.getElementById('claudeInput').focus();
}

function appendClaudeMessage(role, text, id) {
  const container = document.getElementById('claudeChatMessages');
  const div = document.createElement('div');
  if (id) div.id = id;

  const isUser   = role === 'user';
  const isTyping = role === 'typing';

  div.style.cssText = `display:flex;justify-content:${isUser ? 'flex-end' : 'flex-start'};align-items:flex-end;gap:8px;`;

  if (!isUser && !isTyping) {
    // Coach avatar initials bubble
    const av = document.createElement('div');
    av.style.cssText = 'width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#1d4ed8,#7c3aed);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;flex-shrink:0;margin-bottom:2px;letter-spacing:-0.5px';
    av.textContent = 'JC';
    div.appendChild(av);
  }

  const bubble = document.createElement('div');

  if (isTyping) {
    bubble.style.cssText = 'padding:12px 16px;border-radius:18px 18px 18px 4px;background:#111827;color:#475569;font-size:13px;font-style:italic;border:1px solid #1e293b';
    bubble.innerHTML = '<span style="letter-spacing:2px">● ● ●</span>';
  } else if (isUser) {
    bubble.style.cssText = 'max-width:80%;padding:11px 15px;border-radius:18px 18px 4px 18px;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;font-size:14px;line-height:1.5';
    bubble.textContent = text;
  } else {
    // AI response - check if it has structure worth formatting
    bubble.style.cssText = 'max-width:88%;font-size:13px;line-height:1.6;';
    const hasStructure = (text.match(/^#{1,3}\s/m) || text.match(/^\d+[\.\)]\s/m) || text.match(/\*\*.+\*\*/)) && text.length > 200;
    if (hasStructure) {
      bubble.innerHTML = formatAIResponse(text);
    } else {
      // Simple response - styled bubble
      const inner = document.createElement('div');
      inner.style.cssText = 'padding:11px 15px;border-radius:18px 18px 18px 4px;background:#111827;color:#e2e8f0;border:1px solid #1e293b';
      inner.innerHTML = esc(text).replace(/\*\*(.*?)\*\*/g, '<strong style="color:#fff">$1</strong>').replace(/\n/g, '<br>');
      bubble.appendChild(inner);
    }
  }

  div.appendChild(bubble);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}



// (Legacy water tracking code removed — active implementation below in FEATURE 1)


// ══════════════════════════════════════════════════════
// FEATURE 2: SLEEP PANEL FROM WHOOP
// ══════════════════════════════════════════════════════

function renderSleepCard() {
  const el = document.getElementById('sleepCard');
  if (!el) return;

  const whoopIdx = getWhoopIndex ? getWhoopIndex() : {};
  const today = todayKey();
  // Also check yesterday since sleep logged for previous night
  const yest = (() => { const d = nowEST(); d.setDate(d.getDate()-1); return dateToKey(d); })();
  const w = whoopIdx[today] || whoopIdx[yest] || null;

  if (!w || (!w.total_sleep_time && !w.sleep_performance_percentage)) {
    el.innerHTML = `
      <div class="card-label" style="color:#6366f1;margin-bottom:8px">😴 Sleep</div>
      <div style="text-align:center;padding:12px;color:var(--text2);font-size:12px">
        Connect WHOOP to see sleep data<br>
        <span style="font-size:11px;opacity:0.6">Settings → WHOOP Integration</span>
      </div>`;
    return;
  }

  const totalMin  = Math.round((w.total_sleep_time || 0) / 60);
  const lightMin  = Math.round((w.light_sleep_time || 0) / 60);
  const deepMin   = Math.round((w.slow_wave_sleep_time || w.deep_sleep_time || 0) / 60);
  const remMin    = Math.round((w.rem_sleep_time || 0) / 60);
  const score     = Math.round(w.sleep_performance_percentage || 0);
  const totalHrs  = (totalMin / 60).toFixed(1);
  const debtMin   = Math.max(0, 480 - totalMin); // 8hr = 480 min target
  const debtHrs   = (debtMin / 60).toFixed(1);

  const scoreColor = score >= 85 ? '#16a34a' : score >= 70 ? '#d97706' : '#dc2626';
  const scoreLabel = score >= 85 ? 'Great' : score >= 70 ? 'Fair' : 'Poor';

  const stageBar = (label, min, color) => {
    const pct = totalMin > 0 ? Math.round((min/totalMin)*100) : 0;
    return `
      <div style="margin-bottom:4px">
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text2);margin-bottom:2px">
          <span>${label}</span><span>${Math.floor(min/60)}h ${min%60}m (${pct}%)</span>
        </div>
        <div style="background:#1e293b;border-radius:4px;height:6px;overflow:hidden">
          <div style="background:${color};height:100%;width:${pct}%;border-radius:4px;transition:width 0.5s"></div>
        </div>
      </div>`;
  };

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div class="card-label" style="color:#6366f1;margin-bottom:0">😴 Sleep</div>
      <div style="font-size:11px;font-weight:700;color:${scoreColor};background:${scoreColor}22;padding:3px 10px;border-radius:20px">${scoreLabel} · ${score}%</div>
    </div>
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px">
      <div style="text-align:center;flex-shrink:0">
        <div style="font-size:28px;font-weight:800;color:#6366f1">${totalHrs}</div>
        <div style="font-size:10px;color:var(--text2);font-weight:600">hrs slept</div>
      </div>
      <div style="flex:1">
        ${stageBar('🌊 Deep', deepMin, '#6366f1')}
        ${stageBar('💤 REM', remMin, '#8b5cf6')}
        ${stageBar('💫 Light', lightMin, '#a78bfa')}
      </div>
    </div>
    ${debtMin > 0
      ? `<div style="background:#1e293b;border-radius:10px;padding:8px 12px;font-size:11px;color:#f59e0b;font-weight:600">
          ⚠️ Sleep debt: ${debtHrs}h vs 8hr target
        </div>`
      : `<div style="background:#0a2a1a;border-radius:10px;padding:8px 12px;font-size:11px;color:#16a34a;font-weight:600">
          ✅ Full night's rest achieved
        </div>`
    }`;
}


// (Legacy BP and body comp code removed — active implementations below in FEATURES 4-5)


// ══════════════════════════════════════════════════════
// FEATURE 5: MOOD & ENERGY (legacy stubs removed — see FEATURE 3)
// ══════════════════════════════════════════════════════


// ══════════════════════════════════════════════════════
// FEATURE 6: DAILY AI BRIEF (removed — replaced by AI email triage in greeting tile)
// ══════════════════════════════════════════════════════
function loadDailyBrief() {}
function refreshDailyBrief() {}
function renderDailyBrief() {}
function renderBriefHTML() {}
function generateDailyBrief() {}
function regenerateDailyBrief() {}


// ══════════════════════════════════════════════════════
// FEATURE 7: WEEKLY AI HEALTH NARRATIVE
// ══════════════════════════════════════════════════════

function getWeekStart(date) {
  const d = date || nowEST();
  const day = d.getDay(); // 0=Sun
  const diff = d.getDate() - day;
  const sun = new Date(d);
  sun.setDate(diff);
  return dateToKey(sun);
}

async function generateWeeklyNarrative() {
  const el = document.getElementById('weeklyNarrativeContent');
  if (!el) return;

  const weekStart = getWeekStart();
  const cached = getStorage('weeklyNarrative', null);
  if (cached && cached.weekStart === weekStart) {
    el.innerHTML = formatNarrative(cached);
    return;
  }

  el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text2);font-size:13px">🤖 Generating weekly narrative…</div>';

  // Gather last 7 days of data
  const macroLog   = getStorage('macroLog', {});
  const burnLog    = getStorage('burnLog', {});
  const weightLog  = getStorage('weightLog', {});
  const moodLog    = getStorage('moodLog', {});
  const whoopIdx   = getWhoopIndex ? getWhoopIndex() : {};
  const userMacros = getStorage('userMacros', null);

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = nowEST();
    d.setDate(d.getDate() - i);
    const key = dateToKey(d);
    days.push({
      key,
      cals:     macroLog[key]?.calories || 0,
      protein:  macroLog[key]?.protein  || 0,
      burn:     burnLog[key]            || 0,
      weight:   weightLog[key]          || null,
      mood:     moodLog[key]?.mood      || null,
      energy:   moodLog[key]?.energy    || null,
      sleep:    whoopIdx[key] ? Math.round((whoopIdx[key].total_sleep_time||0)/3600*10)/10 : null,
      recovery: whoopIdx[key]?.recovery_score || null,
    });
  }

  const logged = days.filter(d => d.cals > 0);
  const avgCals   = logged.length ? Math.round(logged.reduce((s,d)=>s+d.cals,0)/logged.length) : 0;
  const avgProt   = logged.length ? Math.round(logged.reduce((s,d)=>s+d.protein,0)/logged.length) : 0;
  const totalMiles = +(days.reduce((s,d)=>s+(d.burn/80),0).toFixed(1)); // rough miles from burn
  const weights   = days.filter(d=>d.weight).map(d=>d.weight);
  const wtChange  = weights.length >= 2 ? (weights[weights.length-1] - weights[0]).toFixed(1) : null;
  const avgSleep  = days.filter(d=>d.sleep).length ? (days.filter(d=>d.sleep).reduce((s,d)=>s+d.sleep,0)/days.filter(d=>d.sleep).length).toFixed(1) : null;
  const avgMood   = days.filter(d=>d.mood).length ? (days.filter(d=>d.mood).reduce((s,d)=>s+d.mood,0)/days.filter(d=>d.mood).length).toFixed(1) : null;
  const target    = userMacros?.calories || 2000;

  try {
    const resp = await callClaudeAPI({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content:
        `Write a weekly health summary for Jeremy (age 52, training for Grandma's Marathon June 20 2026).

Data for the past 7 days:
- Avg calories: ${avgCals} (target: ${target})
- Avg protein: ${avgProt}g/day
- Days logged: ${logged.length}/7
- Est. total miles run: ${totalMiles}
- Weight change: ${wtChange !== null ? wtChange + ' lbs' : 'not enough data'}
- Avg sleep: ${avgSleep ? avgSleep + ' hrs' : 'no data'}
- Avg mood: ${avgMood ? avgMood + '/5' : 'no data'}

Write exactly 3 short sections labeled:
✅ What Went Well
⚠️ Areas to Improve  
🎯 This Week's Focus

Keep each section to 2-3 sentences. Be specific and coach-like. Total under 150 words.` }]
    });
    const text = resp.content?.find(b=>b.type==='text')?.text || '';
    const narrative = { weekStart, text, generatedAt: todayKey(), stats: { avgCals, avgProt, totalMiles, wtChange, avgSleep, avgMood, logged: logged.length } };
    setStorage('weeklyNarrative', narrative);
    el.innerHTML = formatNarrative(narrative);
  } catch(e) {
    el.innerHTML = '<div style="color:var(--red);font-size:12px;text-align:center;padding:12px">Could not generate narrative. Try again later.</div>';
  }
}

function formatNarrative(n) {
  if (!n || !n.text) return '';
  const lines = n.text.split('\n').filter(l=>l.trim());
  let html = `<div style="font-size:11px;color:var(--text2);margin-bottom:10px;text-align:right">Week of ${n.weekStart} · ${n.stats?.logged||0}/7 days logged</div>`;
  lines.forEach(line => {
    const isHeader = line.startsWith('✅') || line.startsWith('⚠️') || line.startsWith('🎯');
    html += isHeader
      ? `<div style="font-size:13px;font-weight:700;color:var(--text);margin-top:12px;margin-bottom:4px">${line}</div>`
      : `<div style="font-size:12px;color:var(--text2);line-height:1.6;margin-bottom:4px">${line}</div>`;
  });
  html += `<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
    ${n.stats?.avgCals ? `<span style="background:var(--surface2);border-radius:8px;padding:4px 10px;font-size:10px;font-weight:700;color:var(--text2)">${n.stats.avgCals} kcal avg</span>` : ''}
    ${n.stats?.totalMiles ? `<span style="background:var(--surface2);border-radius:8px;padding:4px 10px;font-size:10px;font-weight:700;color:var(--text2)">${n.stats.totalMiles} mi</span>` : ''}
    ${n.stats?.avgSleep ? `<span style="background:var(--surface2);border-radius:8px;padding:4px 10px;font-size:10px;font-weight:700;color:var(--text2)">${n.stats.avgSleep}h sleep avg</span>` : ''}
    ${n.stats?.wtChange !== null && n.stats?.wtChange !== undefined ? `<span style="background:var(--surface2);border-radius:8px;padding:4px 10px;font-size:10px;font-weight:700;color:var(--text2)">${n.stats.wtChange > 0 ? '+' : ''}${n.stats.wtChange} lbs</span>` : ''}
  </div>`;
  return html;
}


// ══════════════════════════════════════════════════════
// FEATURE 8: SUPPLEMENT DAILY LOG
// ══════════════════════════════════════════════════════

const DEFAULT_SUPPS = [
  { name: 'Vitamin D3', dose: '5000 IU', emoji: '☀️' },
  { name: 'Fish Oil / Omega-3', dose: '2g EPA/DHA', emoji: '🐟' },
  { name: 'Magnesium Glycinate', dose: '400mg', emoji: '💊' },
  { name: 'Zinc', dose: '25mg', emoji: '⚗️' },
  { name: 'Creatine', dose: '5g', emoji: '💪' },
];

function getSuppList() {
  return getStorage('suppList', DEFAULT_SUPPS);
}

function getSuppLog() {
  return getStorage('suppLog', {});
}

function toggleSupp(name) {
  const log = getSuppLog();
  const today = todayKey();
  if (!log[today]) log[today] = [];
  const idx = log[today].indexOf(name);
  if (idx >= 0) log[today].splice(idx, 1);
  else log[today].push(name);
  setStorage('suppLog', log);
  renderSuppLog();
}

function getSuppStreak(name) {
  const log = getSuppLog();
  let streak = 0;
  const d = nowEST();
  d.setDate(d.getDate() - 1); // start from yesterday
  for (let i = 0; i < 60; i++) {
    const key = dateToKey(d);
    if (log[key] && log[key].includes(name)) streak++;
    else break;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function renderSuppLog() {
  const el = document.getElementById('suppLogList');
  if (!el) return;
  const supps = getSuppList();
  const log = getSuppLog();
  const today = todayKey();
  const taken = log[today] || [];

  el.innerHTML = supps.map(s => {
    const isTaken = taken.includes(s.name);
    const streak = getSuppStreak(s.name);
    return `
      <div onclick="toggleSupp('${s.name.replace(/'/g,"\'")}') "
        style="display:flex;align-items:center;gap:12px;padding:10px 12px;
          background:${isTaken ? '#0a2a1a' : 'var(--surface2)'};
          border:1.5px solid ${isTaken ? '#16a34a' : 'var(--border)'};
          border-radius:12px;margin-bottom:6px;cursor:pointer;transition:all 0.2s">
        <div style="font-size:22px">${isTaken ? '✅' : '⬜'}</div>
        <div style="font-size:18px">${s.emoji}</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:700;color:${isTaken ? '#16a34a' : 'var(--text)'}">${s.name}</div>
          <div style="font-size:11px;color:var(--text2)">${s.dose}</div>
        </div>
        ${streak > 0 ? `<div style="font-size:10px;font-weight:700;color:#f59e0b;background:#f59e0b22;padding:3px 8px;border-radius:8px">🔥 ${streak}d</div>` : ''}
      </div>`;
  }).join('');

  // Summary
  const summaryEl = document.getElementById('suppSummary');
  if (summaryEl) {
    summaryEl.textContent = taken.length === supps.length
      ? '✅ All supplements taken today!'
      : `${taken.length}/${supps.length} taken today`;
    summaryEl.style.color = taken.length === supps.length ? '#16a34a' : 'var(--text2)';
  }
}

// Add supp to custom list
function addCustomSupp() {
  const name = document.getElementById('customSuppName')?.value?.trim();
  const dose = document.getElementById('customSuppDose')?.value?.trim();
  if (!name) return;
  const list = getSuppList();
  if (list.find(s => s.name === name)) { showToast('Already in list'); return; }
  list.push({ name, dose: dose || '', emoji: '💊' });
  setStorage('suppList', list);
  document.getElementById('customSuppName').value = '';
  if (document.getElementById('customSuppDose')) document.getElementById('customSuppDose').value = '';
  renderSuppLog();
  showToast(`✅ Added ${name}`);
}



// ════════════════════════════════════════════════════════════════
// FEATURE 1: WATER TRACKING
// ════════════════════════════════════════════════════════════════
function getWaterLog() { return getStorage('waterLog', {}); }
function saveWaterLog(log) { setStorage('waterLog', log); }

function getWaterGoal() { return parseInt(getStorage('waterGoalOz', 100)); }

function getTodayWaterOz() {
  const log = getWaterLog();
  const key = dateToKey(nowEST());
  return log[key] || 0;
}

function addWater(oz) {
  const log = getWaterLog();
  const key = dateToKey(nowEST());
  log[key] = (log[key] || 0) + oz;
  saveWaterLog(log);
  // Track individual entries with timestamps
  const entries = getStorage('waterEntries', {});
  if (!entries[key]) entries[key] = [];
  entries[key].push({ oz, time: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) });
  setStorage('waterEntries', entries);
  renderWater();
}

function openWaterCustom() {
  document.getElementById('waterCustomOz').value = '';
  document.getElementById('waterCustomModal').classList.add('open');
}

function addWaterCustom() {
  const oz = parseInt(document.getElementById('waterCustomOz').value);
  if (oz > 0) { addWater(oz); }
  document.getElementById('waterCustomModal').classList.remove('open');
}

function resetWater() {
  const log = getWaterLog();
  const key = dateToKey(nowEST());
  log[key] = 0;
  saveWaterLog(log);
  const entries = getStorage('waterEntries', {});
  delete entries[key];
  setStorage('waterEntries', entries);
  renderWater();
}

function saveWaterGoal() {
  const oz = parseInt(document.getElementById('waterGoalInput').value);
  if (oz > 0) { setStorage('waterGoalOz', oz); }
  document.getElementById('waterGoalModal').classList.remove('open');
  renderWater();
}

function renderWater() {
  const oz = getTodayWaterOz();
  const goal = getWaterGoal();
  const pct = Math.min(100, Math.round((oz / goal) * 100));

  const display = document.getElementById('waterOzDisplay');
  const bar = document.getElementById('waterProgressBar');
  const goalLbl = document.getElementById('waterGoalLabel');
  const canvas = document.getElementById('waterRingCanvas');
  if (!display) return;

  display.textContent = oz;
  if (bar) bar.style.width = pct + '%';
  if (goalLbl) goalLbl.textContent = `Goal: ${goal} oz  ·  ${pct}%`;
  if (goalLbl) goalLbl.onclick = () => {
    document.getElementById('waterGoalInput').value = goal;
    document.getElementById('waterGoalModal').classList.add('open');
  };
  if (goalLbl) goalLbl.style.cursor = 'pointer';

  // Draw ring
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const cx = 32, cy = 32, r = 27;
    ctx.clearRect(0, 0, 64, 64);
    // Background track
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2);
    ctx.strokeStyle = '#1e3a5f'; ctx.lineWidth = 6; ctx.stroke();
    // Progress arc
    if (pct > 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI/2, -Math.PI/2 + (pct/100)*Math.PI*2);
      ctx.strokeStyle = pct >= 100 ? '#22c55e' : '#38bdf8';
      ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.stroke();
    }
  }

  // Render entry log
  const entryLog = document.getElementById('waterEntryLog');
  if (entryLog) {
    const key = dateToKey(nowEST());
    const entries = (getStorage('waterEntries', {}))[key] || [];
    if (entries.length === 0) {
      entryLog.innerHTML = '';
    } else {
      entryLog.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:6px;padding-top:6px;border-top:1px solid var(--border)">
        ${entries.map(e => `<div style="display:flex;align-items:center;gap:4px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:3px 8px">
          <span style="font-size:11px;font-weight:700;color:#0d9488">${e.oz} oz</span>
          <span style="font-size:9px;color:var(--text3)">${e.time}</span>
        </div>`).join('')}
      </div>`;
    }
  }
}

// ════════════════════════════════════════════════════════════════
// FEATURE 2: SLEEP PANEL (from WHOOP data)
// ════════════════════════════════════════════════════════════════
function renderSleepPanel() {
  const card = document.getElementById('sleepCard');
  if (!card) return;
  const whoopData = getWhoopData();
  if (!whoopData || !whoopData.sleeps || whoopData.sleeps.length === 0) {
    card.style.display = 'none';
    return;
  }
  // Get most recent sleep record
  const sleeps = [...whoopData.sleeps].sort((a, b) => new Date(b.date || b.end) - new Date(a.date || a.end));
  const s = sleeps[0];
  if (!s) { card.style.display = 'none'; return; }

  card.style.display = 'block';

  const fmtHr = mins => {
    if (!mins && mins !== 0) return '—';
    const h = Math.floor(mins / 60), m = Math.round(mins % 60);
    return h > 0 ? `${h}h${m > 0 ? ' '+m+'m' : ''}` : `${m}m`;
  };

  const totalMins = s.total_in_bed_time_milli ? s.total_in_bed_time_milli/60000 : (s.sleep_duration || s.total || 0);
  const deepMins  = s.slow_wave_sleep_duration_milli ? s.slow_wave_sleep_duration_milli/60000 : (s.deep || 0);
  const remMins   = s.rem_sleep_duration_milli ? s.rem_sleep_duration_milli/60000 : (s.rem || 0);
  const debtMins  = s.sleep_debt ? s.sleep_debt * 60 : (s.debt_mins || 0);
  const score     = s.sleep_performance_percentage ? Math.round(s.sleep_performance_percentage) : (s.score || null);

  document.getElementById('sleepTotal').textContent = fmtHr(totalMins);
  document.getElementById('sleepDeep').textContent  = fmtHr(deepMins);
  document.getElementById('sleepREM').textContent   = fmtHr(remMins);
  document.getElementById('sleepDebt').textContent  = debtMins > 0 ? fmtHr(debtMins) : '✓ None';

  const badge = document.getElementById('sleepScoreBadge');
  if (badge && score !== null) {
    badge.textContent = `Score: ${score}%`;
    badge.style.color = score >= 85 ? '#4ade80' : score >= 70 ? '#f59e0b' : '#f87171';
  }

  const debtFill = document.getElementById('sleepDebtFill');
  const debtLabel = document.getElementById('sleepDebtLabel');
  if (debtFill && debtMins > 0) {
    debtFill.style.width = Math.min(100, Math.round((debtMins / 120) * 100)) + '%';
    if (debtLabel) debtLabel.textContent = `${fmtHr(debtMins)} sleep debt`;
  } else if (debtLabel) {
    debtLabel.textContent = 'No sleep debt — great!';
  }
}

// ════════════════════════════════════════════════════════════════
// FEATURE 3: MOOD / ENERGY TRACKER
// ════════════════════════════════════════════════════════════════
function getMoodLog() { return getStorage('moodLog', {}); }
function saveMoodLog(log) { setStorage('moodLog', log); }

// ══════════════════════════════════════════════════════
// DAILY WELCOME MODAL
// ══════════════════════════════════════════════════════
const ENERGY_EMOJIS_MAP = ['😴','😕','😐','🙂','💪'];
const MOOD_EMOJIS_MAP   = ['😣','😞','😐','😊','😄'];

let _wmState = { energy: null, mood: null };

function showWelcomeModal() {
  console.log('[checkin] showWelcomeModal called');
  const overlay = document.getElementById('welcomeOverlay');
  if (!overlay) { console.warn('[checkin] welcomeOverlay element not found!'); return; }

  // Set greeting
  const hr = new Date().getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  const name = (_currentUser && _currentUser.name) ? _currentUser.name.split(' ')[0] : 'Jeremy';
  const greetEl = document.getElementById('wmGreeting');
  const dateEl  = document.getElementById('wmDate');
  if (greetEl) greetEl.textContent = greet + ', ' + name + ' 👋';
  if (dateEl)  dateEl.textContent  = new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});

  // Weight comes from the Garmin scale now — show it read-only (1.5B)
  safeCall(fillWelcomeWellnessContext, 'fillWelcomeWellnessContext');

  // Reset state
  _wmState = { energy: null, mood: null };
  ['wmEnergyBtns','wmMoodBtns'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.querySelectorAll('.mood-btn').forEach(b => b.classList.remove('active'));
  });

  // Enable submit button fresh
  const btn = document.getElementById('wmSubmitBtn');
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }

  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  console.log('[checkin] modal opened, overlay.classList:', overlay.className);
}

function closeWelcomeModal() {
  console.log('[checkin] closeWelcomeModal called');
  const overlay = document.getElementById('welcomeOverlay');
  if (overlay) overlay.classList.remove('open');
  document.body.style.overflow = '';
}

function wmSetMood(type, val) {
  _wmState[type] = val;
  const containerId = type === 'energy' ? 'wmEnergyBtns' : 'wmMoodBtns';
  const container = document.getElementById(containerId);
  if (container) {
    container.querySelectorAll('.mood-btn').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.val) === val);
    });
  }
  // Enable submit once both are set (or at least one — be lenient)
  const btn = document.getElementById('wmSubmitBtn');
  if (btn) {
    const ready = _wmState.energy !== null || _wmState.mood !== null;
    btn.disabled = !ready;
    btn.style.opacity = ready ? '1' : '0.5';
  }
}

function submitWelcomeCheckin() {
  const key = dateToKey(nowEST());

  // Save mood/energy
  if (_wmState.energy !== null || _wmState.mood !== null) {
    const log = getMoodLog();
    if (!log[key]) log[key] = {};
    if (_wmState.energy !== null) log[key].energy = _wmState.energy;
    if (_wmState.mood   !== null) log[key].mood   = _wmState.mood;
    saveMoodLog(log);
  }

  // Weight now arrives from the Garmin scale via wellness (Tier 1.5B).
  // Notes ride along with the check-in sync.
  const notesEl = document.getElementById('wmNotes');
  if (notesEl && notesEl.value.trim()) {
    const log = getMoodLog();
    if (!log[key]) log[key] = {};
    log[key].notes = notesEl.value.trim().slice(0, 500);
    saveMoodLog(log);
    notesEl.value = '';
  }

  // Mark today as checked in
  setStorage('lastCheckinDate', key);

  closeWelcomeModal();
  updateCheckinSummaryCard();
  renderWeightTrend && renderWeightTrend();
  scheduleCheckinSync && scheduleCheckinSync(500);
}

// Sync check-in data (mood, energy, weight) to D1 via the /api/checkin endpoint
function scheduleCheckinSync(delay) {
  setTimeout(async () => {
    try {
      const key = dateToKey(nowEST());
      const mood = getMoodLog()[key] || {};
      const wLog = getStorage('weightLog', {});
      const foodEntries = getStorage('foodEntries', {})[key] || [];
      const totals = foodEntries.reduce((acc, e) => ({
        cal: acc.cal + (e.calories || 0), p: acc.p + (e.protein || 0),
        c: acc.c + (e.carbs || 0), f: acc.f + (e.fat || 0)
      }), { cal: 0, p: 0, c: 0, f: 0 });
      const waterLog = getStorage('waterLog', {});

      await fetch('/api/checkin', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          date: key,
          energy: mood.energy || null,
          mood: mood.mood || null,
          // weight/sleep/steps come from the wellness ingest now (1.5B)
          water_oz: waterLog[key] || null,
          calories_consumed: totals.cal || null,
          protein_g: totals.p || null,
          carbs_g: totals.c || null,
          fat_g: totals.f || null,
          notes: mood.notes || null,
        })
      });
    } catch(e) { console.warn('Checkin sync failed:', e); }
  }, delay || 0);
}

function skipWelcomeCheckin() {
  // Don't mark as checked in — modal will reappear next time the app opens
  // until the user actually submits a mood/energy selection
  closeWelcomeModal();
}

function reopenCheckin() {
  // Allow editing — clear the date lock and show modal with existing values
  const key = dateToKey(nowEST());
  const log = getMoodLog();
  const today = log[key] || {};
  _wmState = { energy: today.energy || null, mood: today.mood || null };
  showWelcomeModal();
  // Re-highlight existing selections
  if (_wmState.energy) wmSetMood('energy', _wmState.energy);
  if (_wmState.mood)   wmSetMood('mood',   _wmState.mood);
}

function updateCheckinSummaryCard() {
  const card = document.getElementById('moodCard');
  if (!card) return;
  const key = dateToKey(nowEST());
  const log = getMoodLog();
  const today = log[key] || {};

  if (today.energy || today.mood) {
    const eEmoji = today.energy ? ENERGY_EMOJIS_MAP[today.energy-1] : '⚡';
    const mEmoji = today.mood   ? MOOD_EMOJIS_MAP[today.mood-1]     : '😐';
    const summaryEl = document.getElementById('moodSummaryText');
    const energyEl  = document.getElementById('moodSummaryEnergy');
    if (summaryEl) summaryEl.textContent = `Energy ${eEmoji} ${today.energy || '–'}/5 · Mood ${mEmoji} ${today.mood || '–'}/5`;
    if (energyEl)  energyEl.textContent  = eEmoji;
    card.style.display = 'block';
  } else {
    // Skipped — show minimal card
    const summaryEl = document.getElementById('moodSummaryText');
    if (summaryEl) summaryEl.textContent = 'Skipped today';
    const energyEl = document.getElementById('moodSummaryEnergy');
    if (energyEl) energyEl.textContent = '💜';
    card.style.display = 'block';
  }
}

async function fillWelcomeWellnessContext() {
  const el = document.getElementById('wmWellnessContext');
  if (!el || !FLAGS.wellness) return;
  try {
    const res = await fetch('/api/wellness/latest', { headers: authHeaders() });
    const d = await res.json();
    if (!d.ok) return;
    const L = d.latest || {};
    const bits = [];
    if (L.weight_lbs) bits.push(`⚖️ ${L.weight_lbs.value} lbs`);
    if (L.sleep_total_hrs) bits.push(`😴 ${L.sleep_total_hrs.value.toFixed(1)}h sleep`);
    if (L.hrv_ms) bits.push(`🫀 HRV ${Math.round(L.hrv_ms.value)}`);
    if (L.body_battery_wake) bits.push(`🔋 ${Math.round(L.body_battery_wake.value)}`);
    if (bits.length) {
      el.innerHTML = '<b style="color:var(--text)">From Garmin:</b> ' + bits.join(' · ');
      el.style.display = 'block';
    }
  } catch(_) {}
}

function maybeShowWelcomeModal() {
  const key = dateToKey(nowEST());
  const lastCheckin = getStorage('lastCheckinDate', null);
  console.log('[checkin] maybeShowWelcomeModal: today=' + key + ', lastCheckin=' + lastCheckin);
  if (lastCheckin === key) {
    // Already done today — just show the summary card
    console.log('[checkin] already checked in today, showing summary card');
    updateCheckinSummaryCard();
    return;
  }
  // First visit of the day — show modal
  console.log('[checkin] first visit today, showing welcome modal');
  showWelcomeModal();
}


function setMood(type, val) {
  const key = dateToKey(nowEST());
  const log = getMoodLog();
  if (!log[key]) log[key] = {};
  log[key][type] = val;
  saveMoodLog(log);
  renderMoodBtns();

  const msg = document.getElementById('moodSavedMsg');
  if (msg) {
    msg.style.display = 'block';
    setTimeout(() => msg.style.display = 'none', 1500);
  }
}

function renderMoodBtns() {
  const key = dateToKey(nowEST());
  const log = getMoodLog();
  const today = log[key] || {};
  ['energy', 'mood'].forEach(type => {
    const container = document.getElementById(type + 'Btns');
    if (!container) return;
    container.querySelectorAll('.mood-btn').forEach(btn => {
      const v = parseInt(btn.dataset.val);
      btn.classList.toggle('active', today[type] === v);
    });
  });
}

// ════════════════════════════════════════════════════════════════
// FEATURE 4: BLOOD PRESSURE LOG
// ════════════════════════════════════════════════════════════════
function getBPLog() { return getStorage('bloodPressureLog', []); }
function saveBPLog(log) { setStorage('bloodPressureLog', log); }

function saveBloodPressure() {
  const sys = parseInt(document.getElementById('bpSystolic').value);
  const dia = parseInt(document.getElementById('bpDiastolic').value);
  if (!sys || !dia || sys < 50 || sys > 250 || dia < 30 || dia > 150) {
    alert('Please enter valid blood pressure values (e.g. 120/80)');
    return;
  }
  const log = getBPLog();
  log.unshift({ sys, dia, date: nowEST().toISOString(), ts: Date.now() });
  if (log.length > 90) log.splice(90);
  saveBPLog(log);
  document.getElementById('bpSystolic').value = '';
  document.getElementById('bpDiastolic').value = '';
  renderBPPanel();
}

function getBPCategory(sys, dia) {
  if (sys < 120 && dia < 80) return { label: 'Normal', cls: 'bp-normal' };
  if (sys < 130 && dia < 80) return { label: 'Elevated', cls: 'bp-elevated' };
  return { label: 'High', cls: 'bp-high' };
}

function renderBPPanel() {
  const log = getBPLog();
  const latest = document.getElementById('bpLatest');
  const hist   = document.getElementById('bpHistory');
  if (!latest) return;

  if (log.length === 0) {
    latest.textContent = 'No readings logged yet.';
    if (hist) hist.style.display = 'none';
    return;
  }
  const recent = log[0];
  const cat = getBPCategory(recent.sys, recent.dia);
  const d = new Date(recent.date);
  const dateStr = d.toLocaleDateString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
  latest.innerHTML = `<span style="font-size:22px;font-weight:800;color:var(--text)">${recent.sys}/${recent.dia}</span> <span style="font-size:12px;color:var(--text3)">mmHg</span> &nbsp;<span class="bp-cat ${cat.cls}">${cat.label}</span> <span style="font-size:11px;color:var(--text3);margin-left:6px">${dateStr}</span>`;

  if (hist && log.length > 1) {
    hist.style.display = 'block';
    hist.innerHTML = log.slice(1, 8).map(r => {
      const c = getBPCategory(r.sys, r.dia);
      const rd = new Date(r.date).toLocaleDateString('en-US', { month:'short', day:'numeric' });
      return `<div class="bp-row"><span class="bp-val">${r.sys}/${r.dia}</span><span class="bp-cat ${c.cls}">${c.label}</span><span style="margin-left:auto;font-size:11px;color:var(--text3)">${rd}</span></div>`;
    }).join('');
  }
}

// ════════════════════════════════════════════════════════════════
// FEATURE 5: BODY COMPOSITION LOG
// ════════════════════════════════════════════════════════════════
function getBodyCompLog() { return getStorage('bodyCompLog', []); }

function saveBodyComp() {
  const fat    = parseFloat(document.getElementById('bodyFatPct').value);
  const muscle = parseFloat(document.getElementById('muscleMass').value);
  const waist  = parseFloat(document.getElementById('waistIn').value);
  const source = document.getElementById('bodyCompSource').value;

  if (!fat && !muscle && !waist) {
    alert('Enter at least one measurement.');
    return;
  }
  const log = getBodyCompLog();
  const entry = { date: nowEST().toISOString(), ts: Date.now(), source };
  if (!isNaN(fat))    entry.fat    = fat;
  if (!isNaN(muscle)) entry.muscle = muscle;
  if (!isNaN(waist))  entry.waist  = waist;
  log.unshift(entry);
  if (log.length > 60) log.splice(60);
  setStorage('bodyCompLog', log);
  ['bodyFatPct','muscleMass','waistIn'].forEach(id => { document.getElementById(id).value = ''; });
  renderBodyCompPanel();
}

function renderBodyCompPanel() {
  const log = getBodyCompLog();
  const el = document.getElementById('bodyCompLatest');
  if (!el) return;
  if (log.length === 0) { el.textContent = 'No measurements logged yet.'; return; }
  const r = log[0];
  const parts = [];
  if (r.fat    != null) parts.push(`<span style="color:#fb923c;font-weight:700">${r.fat}%</span> body fat`);
  if (r.muscle != null) parts.push(`<span style="color:#4ade80;font-weight:700">${r.muscle} lbs</span> muscle`);
  if (r.waist  != null) parts.push(`<span style="color:#60a5fa;font-weight:700">${r.waist}"</span> waist`);
  const d = new Date(r.date).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
  const src = { dexa:'DEXA', scale:'Smart Scale', calipers:'Calipers', visual:'Visual Est.' }[r.source] || r.source;
  el.innerHTML = parts.join(' · ') + `<span style="color:var(--text3);font-size:11px;margin-left:8px">${src} · ${d}</span>`;
}





// ════════════════════════════════════════════════════════════════
// FEATURE 7b: WEEKLY AI NARRATIVE
// ════════════════════════════════════════════════════════════════
async function generateWeeklyNarrative() {
  const card = document.getElementById('weeklyNarrativeCard');
  const el   = document.getElementById('weeklyNarrativeText');
  if (!card || !el) return;

  card.style.display = 'block';
  el.textContent = 'Generating your weekly summary…';

  // Gather last 7 days of data
  const today = nowEST();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const k = dateToKey(d);
    const entries = (getStorage('macroLog', {}))[k] || [];
    const totalCals = entries.reduce((s,e) => s + (e.calories||0), 0);
    const weight = (getStorage('weightLog', {}))[k];
    const water  = (getStorage('waterLog', {}))[k] || 0;
    const mood   = (getMoodLog())[k] || {};
    days.push({ date: k, calories: totalCals, weight, water, energy: mood.energy, mood: mood.mood });
  }

  const avgCals = Math.round(days.filter(d=>d.calories>0).reduce((s,d)=>s+d.calories,0) / (days.filter(d=>d.calories>0).length || 1));
  const weights = days.filter(d=>d.weight).map(d=>d.weight);
  const weightChange = weights.length >= 2 ? (weights[weights.length-1] - weights[0]).toFixed(1) : null;
  const avgWater = Math.round(days.filter(d=>d.water>0).reduce((s,d)=>s+d.water,0) / (days.filter(d=>d.water>0).length || 1));

  const prompt = `You are Jeremy's personal health AI. Write a 3-4 sentence weekly narrative summary. Be specific about the data. Be encouraging but honest about gaps.

Week data (last 7 days):
${JSON.stringify(days, null, 2)}
- Avg calories logged: ${avgCals} kcal/day
- Weight change: ${weightChange !== null ? weightChange + ' lbs' : 'insufficient data'}
- Avg water: ${avgWater} oz/day
- Goal calories: 1500/day, protein: 165g/day

Write a coach-style narrative. Reference actual numbers. Point out 1 win and 1 area to improve. Max 80 words.`;

  try {
    const resp = await callClaudeAPI({ model:'claude-sonnet-4-6', max_tokens:200, messages:[{role:'user',content:prompt}] });
    el.textContent = resp?.content?.[0]?.text || 'Keep logging consistently for better insights!';
  } catch(e) {
    el.textContent = 'Unable to generate summary right now. Keep up the great work!';
  }
}

// ════════════════════════════════════════════════════════════════
// INIT: Call all render functions on app startup
// ════════════════════════════════════════════════════════════════
function initNewFeatures() {
  console.log('[init] initNewFeatures started');
  // Schedule the welcome check-in FIRST so it's not blocked by render errors
  setTimeout(maybeShowWelcomeModal, 400);

  renderWater();
  renderSleepPanel();
  renderBPPanel();
  renderBodyCompPanel();
  renderSuppLog();
}

// Aggressive fallback: if the app has been visible for 3 seconds and
// the check-in hasn't been done, force-show the modal.
// This catches edge cases where the normal init path silently fails.
let _checkinGuardFired = false;
function _checkinGuard() {
  if (_checkinGuardFired) return;
  const key = dateToKey(nowEST());
  const lastCheckin = getStorage('lastCheckinDate', null);
  const overlay = document.getElementById('welcomeOverlay');
  if (lastCheckin !== key && overlay && !overlay.classList.contains('open')) {
    console.log('[checkin] guard triggered — forcing modal open');
    showWelcomeModal();
  }
  _checkinGuardFired = true;
}



// ══════════════════════════════════════════════════════
// FEATURE: Meal Suggestions
// ══════════════════════════════════════════════════════
async function getMealSuggestions() {
  const el = document.getElementById('mealSuggestionsOutput');
  if (!el) return;
  el.innerHTML = '<span style="color:#f59e0b">🤖 Generating suggestions…</span>';

  const goals = getStorage('userGoals', {});
  const today = todayKey();
  const log = getStorage('foodEntries', {})[today] || [];
  const eaten = log.reduce((a,e) => ({
    cal: a.cal + (e.calories||0),
    p: a.p + (e.protein||0),
    c: a.c + (e.carbs||0),
    f: a.f + (e.fat||0)
  }), {cal:0,p:0,c:0,f:0});

  const target = getStorage('userMacros', {calories:2200, protein:185, carbs:200, fat:65});
  const remaining = {
    cal: Math.max(0, target.calories - eaten.cal),
    p: Math.max(0, target.protein - eaten.p),
    c: Math.max(0, target.carbs - eaten.c),
    f: Math.max(0, target.fat - eaten.f),
  };

  try {
    const resp = await callClaudeAPI({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Suggest 3 specific meals or snacks for the rest of today for a 52yo male marathon runner trying to lose weight.\n\nRemaining macros needed:\n- Calories: ${Math.round(remaining.cal)} kcal\n- Protein: ${Math.round(remaining.p)}g\n- Carbs: ${Math.round(remaining.c)}g\n- Fat: ${Math.round(remaining.f)}g\n\nFormat as a short bulleted list. Each suggestion should be a real food with approx macros. Be practical and specific.`
      }]
    });
    const text = resp?.content?.[0]?.text || 'Try: Greek yogurt + berries (20g protein), chicken + rice bowl (40g protein), protein shake.';
    el.innerHTML = text.replace(/\n/g, '<br>').replace(/^[•\-\*] /gm, '→ ');
  } catch(e) {
    el.innerHTML = '→ Greek yogurt + berries (150 cal, 20g protein)<br>→ Chicken rice bowl (450 cal, 40g protein)<br>→ Casein protein shake before bed (130 cal, 25g protein)';
  }
}

// ══════════════════════════════════════════════════════
// FEATURE: Micronutrient Renderer
// ══════════════════════════════════════════════════════
function renderMicronutrients() {
  const el = document.getElementById('micronutrientDisplay');
  if (!el) return;

  const today = todayKey();
  const entries = (getStorage('foodEntries', {})[today] || []);

  // Aggregate key micros from entries (USDA data includes these)
  const totals = { fiber:0, sugar:0, sodium:0, potassium:0, vitC:0, iron:0, calcium:0, vitD:0 };
  const labels = { fiber:'Fiber',sugar:'Sugar',sodium:'Sodium',potassium:'Potassium',vitC:'Vit C',iron:'Iron',calcium:'Calcium',vitD:'Vit D' };
  const units  = { fiber:'g',sugar:'g',sodium:'mg',potassium:'mg',vitC:'mg',iron:'mg',calcium:'mg',vitD:'µg' };
  const goals  = { fiber:25,sugar:50,sodium:2300,potassium:3500,vitC:90,iron:8,calcium:1000,vitD:20 };
  const colors = { fiber:'#22c55e',sugar:'#f59e0b',sodium:'#ef4444',potassium:'#3b82f6',vitC:'#f97316',iron:'#a78bfa',calcium:'#06b6d4',vitD:'#fbbf24' };

  entries.forEach(e => {
    Object.keys(totals).forEach(k => {
      if (e[k]) totals[k] += parseFloat(e[k]) || 0;
    });
  });

  const rows = Object.keys(totals).map(k => {
    const pct = Math.min(100, Math.round((totals[k] / goals[k]) * 100));
    const val = totals[k] >= 10 ? Math.round(totals[k]) : totals[k].toFixed(1);
    return `<div style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;margin-bottom:3px">
        <span style="font-size:11px;font-weight:600;color:var(--text2)">${labels[k]}</span>
        <span style="font-size:11px;color:${colors[k]};font-weight:700">${val}${units[k]} <span style="color:var(--text3);font-weight:500">/ ${goals[k]}${units[k]}</span></span>
      </div>
      <div style="background:var(--surface2);border-radius:4px;height:5px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${colors[k]};border-radius:4px;transition:width 0.3s"></div>
      </div>
    </div>`;
  }).join('');

  el.innerHTML = rows || '<div style="font-size:12px;color:var(--text3)">Log foods to see micronutrient breakdown</div>';
}

// Add mood button CSS if not already present
(function addMoodBtnCSS() {
  if (document.getElementById('moodBtnStyle')) return;
  const s = document.createElement('style');
  s.id = 'moodBtnStyle';
  s.textContent = `.mood-btn { background:var(--surface2);border:1.5px solid var(--border);border-radius:10px;font-size:18px;min-width:0;flex:1;height:36px;cursor:pointer;transition:all 0.2s;opacity:0.45;display:flex;align-items:center;justify-content:center;padding:0;box-sizing:border-box; } .mood-btn:hover { transform:scale(1.15);opacity:0.8; }`;
  document.head.appendChild(s);
})();


