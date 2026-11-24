// Body progress photos — History → Body tab.
// Photos are stored in the cloud (never in localStorage). Each photo gets an AI
// body-fat estimate; any two can be compared with a before/after slider that
// auto-aligns them from on-device pose landmarks, and analysed by the AI coach.
// Uses globals from app.js: authHeaders, showToast, dateToKey, nowEST, esc, reportClientError.

const BODY_MAX_EDGE = 1280;
const BODY_THUMB_EDGE = 360;
const BODY_FRAME_ASPECT = 4 / 3;        // frame height / width
const BODY_MAX_ROTATION = 12 * Math.PI / 180;
const BODY_POSES = [['front', 'Front'], ['side', 'Side'], ['back', 'Back']];
const BODY_CHANGE_ICON = { improved: '✅', similar: '➖', regressed: '⚠️', unclear: '❔' };

const _body = {
  photos: [], analysis: null, loaded: false,
  pose: 'front', addPose: 'front',
  fromId: null, toId: null,
  mode: 'slider', split: 50,
  adjusting: false, draft: null,       // draft = unsaved manual alignment for the AFTER photo
  urls: new Map(),                     // "id" / "id:t" → object URL
  uploading: null, pollTimer: null, detailId: null,
};
let _bodyPoseLandmarker = null;

function _bodyFmtDate(d) {
  const dt = new Date(d + 'T12:00:00');
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function _bodyPhoto(id) { return _body.photos.find(p => p.id === id) || null; }
function _bodyVisible() {
  const el = document.getElementById('historyTab-body');
  return !!el && el.style.display !== 'none' && !!el.offsetParent;
}

// ── Data ────────────────────────────────────────────────────────────────
async function _bodyApi(path, payload) {
  const res = await fetch('/api/body/' + path, payload === undefined
    ? { headers: authHeaders() }
    : { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.ok) throw new Error(d.error || ('request failed: ' + res.status));
  return d;
}

async function _bodyImgUrl(id, thumb) {
  const key = thumb ? id + ':t' : id;
  if (_body.urls.has(key)) return _body.urls.get(key);
  const res = await fetch('/api/body/img?id=' + encodeURIComponent(id) + (thumb ? '&t=1' : ''), { headers: authHeaders() });
  if (!res.ok) throw new Error('image failed to load');
  const url = URL.createObjectURL(await res.blob());
  _body.urls.set(key, url);
  return url;
}

async function _bodyLoad() {
  const d = await _bodyApi('photos');
  _body.photos = d.photos || [];
  _body.analysis = d.analysis || null;
  _body.loaded = true;
}

function _bodySchedulePoll() {
  clearTimeout(_body.pollTimer);
  const waiting = _body.photos.some(p => p.est_status === 'pending') || _body.analysis?.status === 'running';
  if (!waiting) return;
  _body.pollTimer = setTimeout(async () => {
    if (!_bodyVisible()) return;       // resumes when the tab is opened again
    try { await _bodyLoad(); _bodyRender(); } catch (_) { _bodySchedulePoll(); }
  }, 4000);
}

// ── Page ────────────────────────────────────────────────────────────────
async function renderBodyPage() {
  const root = document.getElementById('bodyRoot');
  if (!root) return;
  if (!_body.loaded) root.innerHTML = '<div class="card" style="text-align:center;color:var(--text2);font-size:13px">Loading your photos…</div>';
  try {
    await _bodyLoad();
  } catch (e) {
    root.innerHTML = `<div class="card" style="color:var(--text2);font-size:13px">Could not load your photos — ${esc(e.message)}.
      <button class="body-link" onclick="renderBodyPage()">Try again</button></div>`;
    return;
  }
  _bodyRender();
}

function _bodyPosePhotos() { return _body.photos.filter(p => p.pose === _body.pose); }

// Keep the compared pair valid for the selected pose; default is oldest → newest
function _bodyNormalizePair() {
  const counts = Object.fromEntries(BODY_POSES.map(([k]) => [k, _body.photos.filter(p => p.pose === k).length]));
  if (!counts[_body.pose]) _body.pose = (BODY_POSES.find(([k]) => counts[k]) || ['front'])[0];
  const list = _bodyPosePhotos();
  if (!list.some(p => p.id === _body.fromId)) _body.fromId = list[0]?.id || null;
  if (!list.some(p => p.id === _body.toId)) _body.toId = list.length > 1 ? list[list.length - 1].id : null;
  if (_body.fromId === _body.toId) _body.toId = null;
  return counts;
}

function _bodyRender() {
  const root = document.getElementById('bodyRoot');
  if (!root) return;
  const counts = _bodyNormalizePair();
  root.innerHTML = _bodyAddCardHtml() + _bodyCompareCardHtml(counts) + _bodyAnalysisCardHtml() + _bodyTimelineHtml();
  _bodyMountCompare();
  _bodyMountThumbs();
  _bodySchedulePoll();
  renderBodyHomeCard();
}

// ── Home-screen quick capture ───────────────────────────────────────────
function renderBodyHomeCard() {
  const el = document.getElementById('bodyHomeCard');
  if (!el) return;
  if (!_body.loaded && !_body.homeLoading) {
    _body.homeLoading = true;
    _bodyLoad().then(renderBodyHomeCard).catch(() => {}).finally(() => { _body.homeLoading = false; });
  }
  const last = _body.photos[_body.photos.length - 1];
  const lastLine = !_body.loaded ? ''
    : last ? `Last photo ${esc(_bodyFmtDate(last.date))}${last.est_bf_pct != null ? ' · ' + last.est_bf_pct + '% AI body fat' : (last.est_status === 'pending' ? ' · estimating…' : '')}`
    : 'No photos yet — take your first one.';
  el.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
      <div class="body-title">📸 Body photo</div>
      <button class="body-link" style="padding:0" onclick="switchTab('history');switchHistoryTab('body')">View progress ›</button>
    </div>
    <div class="body-sub">${lastLine}</div>
    <div class="body-chips" style="margin:10px 0">
      ${BODY_POSES.map(([k, label]) => `<button class="body-chip${_body.addPose === k ? ' on' : ''}" onclick="bodySetAddPose('${k}')">${label}</button>`).join('')}
    </div>
    ${_body.uploading
      ? `<div class="body-busy"><span class="body-spin"></span>${esc(_body.uploading)}</div>`
      : `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <button class="btn-scan" onclick="document.getElementById('bodyHomeCamInput').click()">📷 Camera</button>
          <button class="btn-scan" onclick="document.getElementById('bodyHomeGalInput').click()">🖼️ Gallery</button>
        </div>`}
    <input type="file" id="bodyHomeCamInput" accept="image/*" capture="user" style="display:none" onchange="bodyHandleFile(this)">
    <input type="file" id="bodyHomeGalInput" accept="image/*" style="display:none" onchange="bodyHandleFile(this)">`;
}

// ── Add photo ───────────────────────────────────────────────────────────
function _bodyAddCardHtml() {
  const today = dateToKey(nowEST());
  const busy = _body.uploading;
  return `<div class="card" style="margin-bottom:14px">
    <div class="body-title">📸 Progress photo</div>
    <div class="body-sub">Same spot, same light, same distance — torso visible, arms relaxed. Photos are stored privately in your cloud account, not on this phone.</div>
    <div class="body-chips" style="margin:12px 0 10px">
      ${BODY_POSES.map(([k, label]) => `<button class="body-chip${_body.addPose === k ? ' on' : ''}" onclick="bodySetAddPose('${k}')">${label}</button>`).join('')}
      <input type="date" id="bodyAddDate" value="${_body.addDate || today}" max="${today}" class="body-date" aria-label="Photo date" onchange="_body.addDate = this.value">
    </div>
    ${busy
      ? `<div class="body-busy"><span class="body-spin"></span>${esc(busy)}</div>`
      : `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <button class="btn-scan" onclick="document.getElementById('bodyCamInput').click()">📷 Camera</button>
          <button class="btn-scan" onclick="document.getElementById('bodyGalInput').click()">🖼️ Gallery</button>
        </div>`}
    <input type="file" id="bodyCamInput" accept="image/*" capture="user" style="display:none" onchange="bodyHandleFile(this)">
    <input type="file" id="bodyGalInput" accept="image/*" style="display:none" onchange="bodyHandleFile(this)">
  </div>`;
}

function bodySetAddPose(pose) { _body.addPose = pose; _bodyRender(); }

async function _bodyDecode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (_) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('could not read that image')); img.src = url; });
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
}

function _bodyDrawScaled(src, maxEdge) {
  const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight;
  const k = Math.min(1, maxEdge / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * k); c.height = Math.round(sh * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

const _bodyB64 = (canvas, q) => canvas.toDataURL('image/jpeg', q).split(',')[1];

// On-device pose detection (MediaPipe, self-hosted). Returns the handful of
// landmarks alignment needs, normalized to the image, or null if unavailable.
async function _bodyDetectLandmarks(canvas) {
  const work = (async () => {
    if (!_bodyPoseLandmarker) {
      const vision = await import('/vendor/mediapipe/vision_bundle.mjs');
      const fileset = await vision.FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
      _bodyPoseLandmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: '/vendor/mediapipe/pose_landmarker_lite.task', delegate: 'CPU' },
        runningMode: 'IMAGE', numPoses: 1,
      });
    }
    const lm = _bodyPoseLandmarker.detect(canvas)?.landmarks?.[0];
    if (!lm || lm.length < 29) return null;
    const pt = (i) => [Math.round(lm[i].x * 10000) / 10000, Math.round(lm[i].y * 10000) / 10000];
    const vis = Math.min(...[11, 12, 23, 24].map(i => lm[i].visibility ?? 1));
    return { nose: pt(0), ls: pt(11), rs: pt(12), lh: pt(23), rh: pt(24), la: pt(27), ra: pt(28), vis: Math.round(vis * 100) / 100 };
  })();
  const timeout = new Promise(res => setTimeout(() => res(null), 25000));
  try { return await Promise.race([work, timeout]); }
  catch (e) { reportClientError('body_pose', e, {}); return null; }
}

async function bodyHandleFile(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file || _body.uploading) return;
  const date = document.getElementById('bodyAddDate')?.value || dateToKey(nowEST());
  const pose = _body.addPose;
  const setBusy = (msg) => { _body.uploading = msg; _bodyRender(); };
  try {
    setBusy('Preparing photo…');
    const src = await _bodyDecode(file);
    const canvas = _bodyDrawScaled(src, BODY_MAX_EDGE);
    let image = _bodyB64(canvas, 0.84);
    if (image.length > 2600000) image = _bodyB64(canvas, 0.7);
    const thumb = _bodyB64(_bodyDrawScaled(canvas, BODY_THUMB_EDGE), 0.72);

    setBusy('Finding your pose for alignment…');
    const landmarks = await _bodyDetectLandmarks(canvas);

    setBusy('Uploading…');
    const d = await _bodyApi('photo', { image, thumb, date, pose, width: canvas.width, height: canvas.height, landmarks });
    _body.pose = pose;
    _body.toId = null;                 // re-default the pair so the new photo shows as "after"
    _body.fromId = null;
    await _bodyLoad();
    showToast(landmarks ? '📸 Photo saved — estimating body fat…' : '📸 Photo saved (pose not detected — use Adjust to line it up)');
    if (d.id) _body.detailId = null;
  } catch (e) {
    reportClientError('body_upload', e, { sizeKB: Math.round((file.size || 0) / 1024) });
    showToast('⚠️ Photo not saved — ' + e.message);
  } finally {
    _body.uploading = null;
    _bodyRender();
  }
}

// ── Compare (before / after slider) ─────────────────────────────────────
function _bodyBfText(p) {
  if (p.est_status === 'pending') return 'estimating…';
  if (p.est_bf_pct != null) return p.est_bf_pct + '%';
  return '—';
}

function _bodyStatCol(label, p) {
  return `<div class="body-stat">
    <div class="body-stat-label">${label} · ${esc(_bodyFmtDate(p.date))}</div>
    <div class="body-stat-val">${esc(_bodyBfText(p))} <span>AI body fat</span></div>
    <div class="body-stat-meta">${p.weight_lbs ? esc(p.weight_lbs + ' lbs') : 'no weight logged'}${p.scale_bf_pct ? ' · scale ' + esc(String(p.scale_bf_pct)) + '%' : ''}</div>
  </div>`;
}

function _bodyCompareCardHtml(counts) {
  if (!_body.photos.length) {
    return `<div class="card" style="margin-bottom:14px;text-align:center">
      <div style="font-size:36px;margin-bottom:6px">🪞</div>
      <div class="body-title">No photos yet</div>
      <div class="body-sub">Add your first photo above. After a second one you get a before/after slider and an AI progress analysis.</div>
    </div>`;
  }
  const list = _bodyPosePhotos();
  const from = _bodyPhoto(_body.fromId), to = _bodyPhoto(_body.toId);
  const poseChips = BODY_POSES.filter(([k]) => counts[k]).map(([k, label]) =>
    `<button class="body-chip${_body.pose === k ? ' on' : ''}" onclick="bodySetPose('${k}')">${label} · ${counts[k]}</button>`).join('');
  const options = (sel) => list.map(p => `<option value="${p.id}"${p.id === sel ? ' selected' : ''}>${esc(_bodyFmtDate(p.date))}</option>`).join('');

  if (!from || !to) {
    return `<div class="card" style="margin-bottom:14px">
      <div class="body-title">Before / after</div>
      <div class="body-chips" style="margin:10px 0">${poseChips}</div>
      <div class="body-sub">You have one ${esc(_body.pose)} photo. Add another ${esc(_body.pose)} photo on a later date to compare them here.</div>
    </div>`;
  }

  const delta = (from.est_bf_pct != null && to.est_bf_pct != null) ? Math.round((to.est_bf_pct - from.est_bf_pct) * 10) / 10 : null;
  const wDelta = (from.weight_lbs && to.weight_lbs) ? Math.round((to.weight_lbs - from.weight_lbs) * 10) / 10 : null;
  const sign = (n) => (n > 0 ? '+' : '') + n;
  const deltaBits = [
    delta != null ? `<b>${sign(delta)} pts</b> body fat (AI)` : null,
    wDelta != null ? `<b>${sign(wDelta)} lbs</b>` : null,
  ].filter(Boolean).join(' · ');
  const a = _body.draft || to.align || { zoom: 1, dx: 0, dy: 0 };

  return `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
      <div class="body-title">Before / after</div>
      <div class="body-seg">
        <button class="${_body.mode === 'slider' ? 'on' : ''}" onclick="bodySetMode('slider')">Slider</button>
        <button class="${_body.mode === 'fade' ? 'on' : ''}" onclick="bodySetMode('fade')">Fade</button>
      </div>
    </div>
    <div class="body-chips" style="margin:10px 0">${poseChips}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      <label class="body-select"><span>Before</span><select onchange="bodySetPair('from', this.value)">${options(from.id)}</select></label>
      <label class="body-select"><span>After</span><select onchange="bodySetPair('to', this.value)">${options(to.id)}</select></label>
    </div>
    <div id="bodyFrame" class="body-frame">
      <img id="bodyImgAfter" class="body-layer" alt="After photo" draggable="false">
      <div id="bodyBeforeWrap" class="body-before"><img id="bodyImgBefore" class="body-layer" alt="Before photo" draggable="false"></div>
      <div id="bodyHandle" class="body-handle"><div class="body-knob">⇆</div></div>
      <div class="body-tag" style="left:8px">BEFORE</div>
      <div class="body-tag" style="right:8px">AFTER</div>
      <div id="bodyFrameMsg" class="body-frame-msg">Loading photos…</div>
    </div>
    <input id="bodySplit" type="range" min="0" max="100" value="${_body.split}" class="body-range" style="margin-top:10px" aria-label="Before and after slider" oninput="bodySetSplit(this.value)">
    <div id="bodyAlignNote" class="body-sub" style="margin-top:6px"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
      ${_bodyStatCol('Before', from)}${_bodyStatCol('After', to)}
    </div>
    ${deltaBits ? `<div class="body-delta">${deltaBits}</div>` : ''}
    <button class="body-link" style="margin-top:10px" onclick="bodyToggleAdjust()">${_body.adjusting ? 'Close alignment' : '🎯 Adjust alignment'}</button>
    ${_body.adjusting ? `<div class="body-adjust">
      <div class="body-sub" style="margin-bottom:8px">Moves the AFTER photo. Fade mode makes it easiest to line up shoulders and hips.</div>
      <label>Zoom <input type="range" class="body-range" min="0.6" max="1.8" step="0.01" value="${a.zoom}" oninput="bodyAdjust('zoom', this.value)"></label>
      <label>Left / right <input type="range" class="body-range" min="-40" max="40" step="0.25" value="${a.dx}" oninput="bodyAdjust('dx', this.value)"></label>
      <label>Up / down <input type="range" class="body-range" min="-40" max="40" step="0.25" value="${a.dy}" oninput="bodyAdjust('dy', this.value)"></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
        <button class="btn-scan" onclick="bodyResetAlign()">Reset</button>
        <button class="btn-scan" onclick="bodySaveAlign()">Save alignment</button>
      </div>
    </div>` : ''}
    <div class="body-sub" style="margin-top:10px">AI body fat is a visual estimate, typically within 3–5 points. Use the trend, not a single number.</div>
  </div>`;
}

function bodySetPose(pose) { _body.pose = pose; _body.fromId = _body.toId = null; _body.draft = null; _bodyRender(); }
function bodySetMode(mode) { _body.mode = mode; _bodyRender(); }
function bodySetPair(side, id) {
  if (side === 'from') _body.fromId = id; else _body.toId = id;
  if (_body.fromId === _body.toId) { showToast('Pick two different photos'); }
  _body.draft = null;
  _bodyRender();
}
function bodyToggleAdjust() {
  _body.adjusting = !_body.adjusting;
  if (!_body.adjusting) _body.draft = null;
  else if (_body.mode !== 'fade') _body.mode = 'fade';
  _bodyRender();
}

// Image-normalized point → frame px for a photo shown "cover"-fitted and centered
function _bodyCoverFit(p, W, H) {
  const ar = (p.width && p.height) ? p.width / p.height : 3 / 4;
  const baseH = W / ar;
  const c = Math.max(1, H / baseH);
  return { ar, baseH, c, tx: (W - W * c) / 2, ty: (H - baseH * c) / 2 };
}

function _bodyTorso(p) {
  const l = p.landmarks;
  if (!l || !l.ls || !l.rs || !l.lh || !l.rh || (l.vis != null && l.vis < 0.4)) return null;
  const s = [(l.ls[0] + l.rs[0]) / 2, (l.ls[1] + l.rs[1]) / 2];
  const h = [(l.lh[0] + l.rh[0]) / 2, (l.lh[1] + l.rh[1]) / 2];
  if (Math.hypot(h[0] - s[0], h[1] - s[1]) < 0.05) return null;
  return { s, h };
}

// CSS transforms (origin 0 0) for both layers. The BEFORE photo is shown as
// shot; the AFTER photo is scaled, shifted and slightly rotated so its
// shoulder and hip midpoints land on the BEFORE photo's.
function _bodyTransforms(from, to, W, H) {
  const fitA = _bodyCoverFit(from, W, H);
  const before = `translate(${fitA.tx}px, ${fitA.ty}px) scale(${fitA.c})`;
  const fitB = _bodyCoverFit(to, W, H);
  let k = fitB.c, tx = fitB.tx, ty = fitB.ty, rot = 0, auto = false;

  const ta = _bodyTorso(from), tb = _bodyTorso(to);
  if (ta && tb) {
    const toFrame = (pt) => [fitA.tx + pt[0] * W * fitA.c, fitA.ty + pt[1] * fitA.baseH * fitA.c];
    const Sr = toFrame(ta.s), Hr = toFrame(ta.h);
    const Sa = [tb.s[0] * W, tb.s[1] * fitB.baseH], Ha = [tb.h[0] * W, tb.h[1] * fitB.baseH];
    const vr = [Hr[0] - Sr[0], Hr[1] - Sr[1]], va = [Ha[0] - Sa[0], Ha[1] - Sa[1]];
    k = Math.hypot(vr[0], vr[1]) / Math.hypot(va[0], va[1]);
    rot = Math.atan2(vr[1], vr[0]) - Math.atan2(va[1], va[0]);
    if (Math.abs(rot) > BODY_MAX_ROTATION) rot = 0;     // a big angle means a bad detection, not a tilt
    const cos = Math.cos(rot), sin = Math.sin(rot);
    tx = Sr[0] - k * (cos * Sa[0] - sin * Sa[1]);
    ty = Sr[1] - k * (sin * Sa[0] + cos * Sa[1]);
    auto = true;
  }
  const m = _body.draft || to.align || { zoom: 1, dx: 0, dy: 0 };
  const after = `translate(${W / 2}px, ${H / 2}px) scale(${m.zoom}) translate(${-W / 2}px, ${-H / 2}px) `
    + `translate(${m.dx / 100 * W}px, ${m.dy / 100 * W}px) translate(${tx}px, ${ty}px) rotate(${rot}rad) scale(${k})`;
  return { before, after, auto, manual: !!(m.zoom !== 1 || m.dx || m.dy) };
}

function _bodyApplyLayout() {
  const frame = document.getElementById('bodyFrame');
  const from = _bodyPhoto(_body.fromId), to = _bodyPhoto(_body.toId);
  if (!frame || !from || !to) return;
  const W = frame.clientWidth, H = W * BODY_FRAME_ASPECT;
  frame.style.height = H + 'px';
  const t = _bodyTransforms(from, to, W, H);
  const imgB = document.getElementById('bodyImgBefore'), imgA = document.getElementById('bodyImgAfter');
  imgB.style.width = imgA.style.width = W + 'px';
  imgB.style.transform = t.before;
  imgA.style.transform = t.after;

  const wrap = document.getElementById('bodyBeforeWrap'), handle = document.getElementById('bodyHandle');
  if (_body.mode === 'fade') {
    wrap.style.clipPath = 'none';
    wrap.style.opacity = String(1 - _body.split / 100);
    handle.style.display = 'none';
  } else {
    wrap.style.opacity = '1';
    wrap.style.clipPath = `inset(0 ${100 - _body.split}% 0 0)`;
    handle.style.display = '';
    handle.style.left = _body.split + '%';
  }
  const note = document.getElementById('bodyAlignNote');
  if (note) {
    note.textContent = t.auto
      ? (t.manual ? 'Auto-aligned on shoulders and hips, plus your adjustment.' : 'Auto-aligned on shoulders and hips.')
      : (t.manual ? 'Aligned with your adjustment.' : 'Could not detect the pose in one of these photos — use Adjust alignment to line them up.');
  }
}

function bodySetSplit(v) {
  _body.split = Math.min(100, Math.max(0, Number(v)));
  const range = document.getElementById('bodySplit');
  if (range && Number(range.value) !== _body.split) range.value = _body.split;
  _bodyApplyLayout();
}

function _bodyMountCompare() {
  const frame = document.getElementById('bodyFrame');
  if (!frame) return;
  const from = _bodyPhoto(_body.fromId), to = _bodyPhoto(_body.toId);
  _bodyApplyLayout();
  const msg = document.getElementById('bodyFrameMsg');
  Promise.all([_bodyImgUrl(from.id), _bodyImgUrl(to.id)]).then(([a, b]) => {
    const imgB = document.getElementById('bodyImgBefore'), imgA = document.getElementById('bodyImgAfter');
    if (!imgB || !imgA || _body.fromId !== from.id || _body.toId !== to.id) return;
    imgB.src = a; imgA.src = b;
    if (msg) msg.style.display = 'none';
  }).catch(e => { if (msg) msg.textContent = 'Could not load the photos — ' + e.message; });

  // Drag anywhere on the frame; vertical drags still scroll the page (touch-action: pan-y)
  let dragging = false;
  const move = (ev) => {
    const r = frame.getBoundingClientRect();
    bodySetSplit((ev.clientX - r.left) / r.width * 100);
  };
  frame.onpointerdown = (ev) => { dragging = true; frame.setPointerCapture(ev.pointerId); move(ev); };
  frame.onpointermove = (ev) => { if (dragging) move(ev); };
  frame.onpointerup = frame.onpointercancel = () => { dragging = false; };
}

function bodyAdjust(field, value) {
  const to = _bodyPhoto(_body.toId);
  if (!to) return;
  if (!_body.draft) _body.draft = { zoom: 1, dx: 0, dy: 0, ...(to.align || {}) };
  _body.draft[field] = Number(value);
  _bodyApplyLayout();
}

function bodyResetAlign() { _body.draft = { zoom: 1, dx: 0, dy: 0 }; _bodyRender(); }

async function bodySaveAlign() {
  const to = _bodyPhoto(_body.toId);
  if (!to) return;
  const align = _body.draft || to.align || { zoom: 1, dx: 0, dy: 0 };
  try {
    await _bodyApi('update', { id: to.id, align });
    to.align = align;
    _body.draft = null;
    _body.adjusting = false;
    showToast('🎯 Alignment saved');
  } catch (e) { showToast('⚠️ Not saved — ' + e.message); }
  _bodyRender();
}

// ── AI progress analysis ────────────────────────────────────────────────
function _bodyAnalysisCardHtml() {
  const from = _bodyPhoto(_body.fromId), to = _bodyPhoto(_body.toId);
  if (!from || !to) return '';
  // An analysis whose photos were since deleted has nothing left to describe
  const stored = _body.analysis;
  const an = (stored && _bodyPhoto(stored.from_id) && _bodyPhoto(stored.to_id)) ? stored : null;
  const head = `<div class="body-title">🧠 Progress analysis</div>`;
  const button = (label) => `<button class="btn-scan" style="width:100%;margin-top:12px" onclick="bodyAnalyze()">${label}</button>`;

  if (an?.status === 'running') {
    return `<div class="card" style="margin-bottom:14px">${head}
      <div class="body-busy" style="margin-top:10px"><span class="body-spin"></span>Comparing your photos — this takes about a minute. You can leave this screen.</div></div>`;
  }
  let bodyHtml = `<div class="body-sub">Your AI coach compares the two photos above with your weight and body-fat numbers.</div>`;
  if (an?.status === 'error') bodyHtml = `<div class="body-sub" style="color:var(--amber)">The last analysis failed — ${esc(an.error || 'unknown error')}.</div>`;
  if (an?.status === 'done' && an.result) {
    const r = an.result;
    const af = _bodyPhoto(an.from_id), at = _bodyPhoto(an.to_id);
    const pairLabel = (af && at) ? `${_bodyFmtDate(af.date)} → ${_bodyFmtDate(at.date)}` : 'earlier photos';
    const stale = an.from_id !== from.id || an.to_id !== to.id;
    bodyHtml = `<div class="body-sub">${esc(pairLabel)}${stale ? ' · not the pair selected above' : ''}</div>
      <div class="body-headline">${esc(r.headline || '')}</div>
      <div class="body-text">${esc(r.summary || '')}</div>
      ${r.est_bf_change_pct != null ? `<div class="body-delta" style="margin-top:10px"><b>${r.est_bf_change_pct > 0 ? '+' : ''}${esc(String(r.est_bf_change_pct))} pts</b> estimated body-fat change</div>` : ''}
      <div class="body-changes">${(r.changes || []).map(c => `<div class="body-change">
        <div class="body-change-icon">${BODY_CHANGE_ICON[c.change] || '❔'}</div>
        <div><div class="body-change-area">${esc(c.area || '')} <span>${esc(c.change || '')}</span></div><div class="body-text">${esc(c.observation || '')}</div></div>
      </div>`).join('')}</div>
      ${(r.next_steps || []).length ? `<div class="body-section">Next steps</div><ul class="body-list">${r.next_steps.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
      <div class="body-section">Photo comparability: ${esc(r.comparability || '')}</div>
      <div class="body-text">${esc(r.comparability_note || '')}</div>`;
  }
  const stalePair = an?.status === 'done' && (an.from_id !== from.id || an.to_id !== to.id);
  const label = an?.status === 'done' ? (stalePair ? 'Analyze the selected pair' : 'Run analysis again') : 'Analyze my progress';
  return `<div class="card" style="margin-bottom:14px">${head}${bodyHtml}${button(label)}</div>`;
}

async function bodyAnalyze() {
  if (!_body.fromId || !_body.toId) return;
  try {
    const d = await _bodyApi('analyze', { from_id: _body.fromId, to_id: _body.toId });
    _body.analysis = { id: d.id, from_id: _body.fromId, to_id: _body.toId, status: 'running', created_at: Date.now(), result: null };
  } catch (e) {
    reportClientError('body_analyze', e, {});
    showToast('⚠️ Could not start the analysis — ' + e.message);
  }
  _bodyRender();
}

// ── Timeline + photo detail ─────────────────────────────────────────────
function _bodyTimelineHtml() {
  if (!_body.photos.length) return '';
  const newestFirst = [..._body.photos].reverse();
  return `<div class="card" style="margin-bottom:14px">
    <div class="body-title">All photos · ${_body.photos.length}</div>
    <div class="body-grid">${newestFirst.map(p => `<button class="body-thumb" onclick="bodyOpenDetail('${p.id}')" aria-label="Photo from ${esc(_bodyFmtDate(p.date))}">
      <img data-body-thumb="${p.id}" alt="">
      <span class="body-thumb-bf">${p.est_status === 'pending' ? '…' : (p.est_bf_pct != null ? p.est_bf_pct + '%' : '—')}</span>
      <span class="body-thumb-date">${esc(new Date(p.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))} · ${esc(p.pose)}</span>
    </button>`).join('')}</div>
  </div>${_body.detailId ? _bodyDetailHtml(_bodyPhoto(_body.detailId)) : ''}`;
}

function _bodyMountThumbs() {
  document.querySelectorAll('[data-body-thumb]').forEach(img => {
    _bodyImgUrl(img.getAttribute('data-body-thumb'), true).then(u => { img.src = u; }).catch(() => {});
  });
  const full = document.getElementById('bodyDetailImg');
  if (full && _body.detailId) _bodyImgUrl(_body.detailId).then(u => { full.src = u; }).catch(() => {});
}

function _bodyDetailHtml(p) {
  if (!p) return '';
  const e = p.est || {};
  let estHtml;
  if (p.est_status === 'pending') estHtml = `<div class="body-busy"><span class="body-spin"></span>Estimating body fat…</div>`;
  else if (p.est_status === 'error' || e.error) estHtml = `<div class="body-sub" style="color:var(--amber)">Estimate failed — ${esc(e.error || 'unknown error')}.</div>
    <button class="btn-scan" style="width:100%;margin-top:8px" onclick="bodyRetryEstimate('${p.id}')">Retry estimate</button>`;
  else if (p.est_bf_pct == null) estHtml = `<div class="body-sub">${esc(e.notes || 'This photo could not support an estimate.')}</div>
    <button class="btn-scan" style="width:100%;margin-top:8px" onclick="bodyRetryEstimate('${p.id}')">Retry estimate</button>`;
  else estHtml = `<div class="body-stat-val" style="font-size:26px">${p.est_bf_pct}% <span>AI body fat</span></div>
    <div class="body-sub">Range ${esc(String(e.range_low ?? '?'))}–${esc(String(e.range_high ?? '?'))}% · ${esc(e.confidence || 'low')} confidence${p.scale_bf_pct ? ' · scale reads ' + esc(String(p.scale_bf_pct)) + '%' : ''}</div>
    <div class="body-text" style="margin-top:8px"><b>${esc(e.muscle_definition || '')}</b></div>
    <div class="body-text">${esc(e.notes || '')}</div>
    ${e.photo_tips ? `<div class="body-sub" style="margin-top:8px">💡 ${esc(e.photo_tips)}</div>` : ''}`;
  return `<div class="body-sheet-bg" onclick="if(event.target===this)bodyCloseDetail()">
    <div class="body-sheet">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div class="body-title">${esc(_bodyFmtDate(p.date))}${p.weight_lbs ? ' · ' + esc(String(p.weight_lbs)) + ' lbs' : ''}</div>
        <button class="body-link" onclick="bodyCloseDetail()">Close</button>
      </div>
      <img id="bodyDetailImg" alt="Progress photo" style="width:100%;border-radius:14px;background:var(--surface2);min-height:200px">
      <div style="margin-top:12px">${estHtml}</div>
      <div class="body-chips" style="margin-top:14px">
        ${BODY_POSES.map(([k, label]) => `<button class="body-chip${p.pose === k ? ' on' : ''}" onclick="bodySetPhotoPose('${p.id}','${k}')">${label}</button>`).join('')}
      </div>
      <button class="body-link" style="color:var(--red);margin-top:14px" onclick="bodyDeletePhoto('${p.id}')">Delete this photo</button>
    </div>
  </div>`;
}

function bodyOpenDetail(id) { _body.detailId = id; _bodyRender(); }
function bodyCloseDetail() { _body.detailId = null; _bodyRender(); }

async function bodyRetryEstimate(id) {
  try {
    await _bodyApi('estimate', { id });
    const p = _bodyPhoto(id);
    if (p) { p.est_status = 'pending'; p.est = null; }
  } catch (e) { showToast('⚠️ ' + e.message); }
  _bodyRender();
}

async function bodySetPhotoPose(id, pose) {
  try {
    await _bodyApi('update', { id, pose });
    const p = _bodyPhoto(id);
    if (p) p.pose = pose;
  } catch (e) { showToast('⚠️ ' + e.message); }
  _bodyRender();
}

async function bodyDeletePhoto(id) {
  if (!confirm('Delete this photo permanently? This cannot be undone.')) return;
  try {
    await _bodyApi('delete', { id });
    for (const key of [id, id + ':t']) {
      if (_body.urls.has(key)) { URL.revokeObjectURL(_body.urls.get(key)); _body.urls.delete(key); }
    }
    _body.photos = _body.photos.filter(p => p.id !== id);
    _body.detailId = null;
    showToast('Photo deleted');
  } catch (e) { showToast('⚠️ Not deleted — ' + e.message); }
  _bodyRender();
}

window.addEventListener('resize', () => { if (_bodyVisible()) _bodyApplyLayout(); });
// The home card needs a session; app.js re-renders it on every Today visit too
document.addEventListener('DOMContentLoaded', () => setTimeout(renderBodyHomeCard, 1500));
