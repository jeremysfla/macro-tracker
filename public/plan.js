// Goal plan — the daily calorie target worked backward from a goal weight and date.
// The server (/api/garmin/plan) does the maths from Garmin burn and recent weigh-ins;
// this file applies the result to the existing targets and explains it on the home screen.
// Uses globals from app.js: authHeaders, getStorage, setStorage, todayKey, esc,
// adjustMacrosForBurn, updateMacroTargetsRow, reportClientError.

function goalPlanActive() {
  const p = getStorage('goalPlan', null);
  return !!(p && p.active && p.date === todayKey());
}

function _planDate(d) {
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function renderGoalPlanBanner() {
  const el = document.getElementById('goalPlanBanner');
  if (!el) return;
  const p = getStorage('goalPlan', null);
  if (!p || !p.active || p.date !== todayKey()) { el.style.display = 'none'; return; }
  const n = (v) => Number(v).toLocaleString();
  const lines = [];

  if (p.to_lose <= 0) {
    lines.push(`You are at or under ${p.goal_weight} lb — eating at maintenance, ${n(p.macros.calories)} a day.`);
  } else if (p.days_left <= 0) {
    lines.push(`The goal date has passed with ${p.to_lose} lb to go. Set a new date in Settings.`);
  } else {
    lines.push(`Now ${p.trend_weight} lb · ${p.to_lose} lb to go · ${p.days_left} days left`);
    lines.push(`You burn about ${n(p.base_burn)} a day before workouts. Eating ${n(p.macros.calories)} is a ${n(p.deficit)} deficit, about ${p.lbs_per_week} lb a week.`);
    if (p.on_track) {
      lines.push(`On pace for ${p.goal_weight} lb by ${_planDate(p.goal_date)}.`);
    } else {
      const when = p.projected_goal_date ? ` and ${p.goal_weight} lb around ${_planDate(p.projected_goal_date)}` : '';
      lines.push(`This is the fastest safe pace: about ${p.projected_weight} lb on ${_planDate(p.goal_date)}${when}. Hitting the date exactly would need a ${n(p.needed_deficit)} deficit.`);
    }
  }
  if (p.exercise_net_today > 0) lines.push(`Today's workout adds ${n(p.exercise_net_today)} → target ${n(p.target_today)}.`);
  if (p.weight_stale || p.weigh_ins < 3) lines.push('Weigh in a few mornings this week — the plan sharpens with each one.');
  if (!p.burn_from_garmin) lines.push('Using an estimated burn until Garmin has a few days of data.');

  el.innerHTML = `<div class="plan-head">🎯 ${esc(String(p.goal_weight))} lb by ${esc(_planDate(p.goal_date))}</div>`
    + lines.map(l => `<div class="plan-line">${esc(l)}</div>`).join('');
  el.style.display = 'block';
}

async function refreshGoalPlan() {
  let p;
  try {
    const res = await fetch('/api/garmin/plan?date=' + todayKey(), { headers: authHeaders() });
    p = await res.json();
    if (!res.ok || !p.ok) return;
  } catch (e) { return; }               // offline: keep whatever plan is stored
  setStorage('goalPlan', p);
  if (p.active) {
    setStorage('userMacros', p.macros);
    setStorage('userTDEE', p.base_burn);
    const goals = getStorage('userGoals', {});
    Object.assign(goals, { weight: p.trend_weight, goal: p.goal_weight, goalDate: p.goal_date });
    setStorage('userGoals', goals);
    try { localStorage.removeItem('adaptiveMacros'); } catch (_) {}
    try {
      adjustMacrosForBurn(p.exercise_net_today || 0);   // re-renders the rings from the new base
      updateMacroTargetsRow();
    } catch (e) { reportClientError('goal_plan_apply', e, {}); }
  }
  renderGoalPlanBanner();
}

document.addEventListener('DOMContentLoaded', () => {
  renderGoalPlanBanner();
  setTimeout(refreshGoalPlan, 2000);    // after sign-in and the first render settle
});
