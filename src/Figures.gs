// Figures.gs — Uploaded figures (e.g. screenshots) for students to draw on.
// All .gs files share one global scope in Apps Script.
//
// Instructors upload an image from the dashboard (pasted or chosen; the browser shrinks it
// first). It's saved as a private file in the deploying account's Drive, in
//   StatChat figures/<instructor_id>/
// and identified by its Drive file ID. Students never get a Drive link: pages fetch the
// image through apiGetFigure, which only serves files inside the StatChat figures folder.

const FIGURE_ROOT_NAME = 'StatChat figures';
const FIGURE_ROOT_PROP = 'FIGURE_FOLDER_ID';
const FIGURE_MAX_BYTES = 1500000;                 // after the browser has shrunk it
const FIGURE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const FIGURE_ID_RE = /^[\w-]{10,200}$/;
const FIGURE_CACHE_SECS = 6 * 60 * 60;            // CacheService's maximum
const FIGURE_CACHE_CHUNK = 90000;                 // CacheService values must be under 100 KB

/** True if id looks like a figure ID (a Drive file ID) */
function isFigureId_(id) { return FIGURE_ID_RE.test(String(id || '')); }

/** The top-level StatChat figures folder, created on first use */
function figureRootFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(FIGURE_ROOT_PROP);
  if (id) {
    try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {}
  }
  return withScriptLock_(() => {
    const again = props.getProperty(FIGURE_ROOT_PROP);
    if (again && again !== id) return DriveApp.getFolderById(again);
    const f = DriveApp.createFolder(FIGURE_ROOT_NAME);
    props.setProperty(FIGURE_ROOT_PROP, f.getId());
    return f;
  });
}

/** This instructor's figures folder, created on first use */
function instructorFigureFolder_(instructor_id) {
  const root = figureRootFolder_();
  const name = String(instructor_id).trim();
  return withScriptLock_(() => {
    const it = root.getFoldersByName(name);
    return it.hasNext() ? it.next() : root.createFolder(name);
  });
}

/** The instructor folder a figure is in, or '' if the file isn't a StatChat figure */
function figureOwner_(file) {
  const rootId = PropertiesService.getScriptProperties().getProperty(FIGURE_ROOT_PROP);
  if (!rootId || file.isTrashed()) return '';
  const parents = file.getParents();
  while (parents.hasNext()) {
    const folder = parents.next();
    const up = folder.getParents();
    while (up.hasNext()) if (up.next().getId() === rootId) return folder.getName();
  }
  return '';
}

/** Throw unless figure_id is one of this instructor's figures */
function requireOwnFigure_(instructor_id, figure_id) {
  let file = null;
  try { if (isFigureId_(figure_id)) file = DriveApp.getFileById(figure_id); } catch (e) {}
  if (!file || figureOwner_(file) !== String(instructor_id).trim()) throw new Error('Figure not found. Please add it again.');
}

function cacheFigure_(figure_id, dataUrl) {
  const cache = CacheService.getScriptCache();
  const n = Math.ceil(dataUrl.length / FIGURE_CACHE_CHUNK);
  for (let i = 0; i < n; i++) {
    cache.put(`fig_${figure_id}_${i}`, dataUrl.slice(i * FIGURE_CACHE_CHUNK, (i + 1) * FIGURE_CACHE_CHUNK), FIGURE_CACHE_SECS);
  }
  cache.put(`fig_${figure_id}_n`, String(n), FIGURE_CACHE_SECS);   // written last: marks it complete
}
function cachedFigure_(figure_id) {
  const cache = CacheService.getScriptCache();
  const n = parseInt(cache.get(`fig_${figure_id}_n`), 10);
  if (!n) return '';
  let out = '';
  for (let i = 0; i < n; i++) {
    const part = cache.get(`fig_${figure_id}_${i}`);
    if (part === null) return '';
    out += part;
  }
  return out;
}

/** Save an uploaded figure. dataUrl is 'data:image/png|jpeg|webp;base64,...'.
 *  Returns { ok, figure_id }. */
function apiUploadFigure(token, dataUrl) {
  const instructor_id = requireInstructor_(token);
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('That file isn\'t a PNG, JPEG or WebP image.');
  const bytes = Utilities.base64Decode(m[2]);
  if (bytes.length > FIGURE_MAX_BYTES) throw new Error('That image is too large. Try a smaller screenshot.');
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HHmmss');
  const blob = Utilities.newBlob(bytes, m[1], `figure ${stamp}.${FIGURE_TYPES[m[1]]}`);
  const file = instructorFigureFolder_(instructor_id).createFile(blob);
  const figure_id = file.getId();
  cacheFigure_(figure_id, 'data:' + m[1] + ';base64,' + m[2]);
  return { ok: true, figure_id };
}

/** A figure's image as a data URL, for any page showing a drawing made on it.
 *  Returns { ok, figure_id, data } or { ok: false, error }. */
function apiGetFigure(figure_id) {
  const id = String(figure_id || '');
  if (!isFigureId_(id)) return { ok: false, error: 'Figure not found.' };
  const hit = cachedFigure_(id);
  if (hit) return { ok: true, figure_id: id, data: hit };
  let file = null;
  try { file = DriveApp.getFileById(id); } catch (e) {}
  if (!file || !figureOwner_(file)) return { ok: false, error: 'Figure not found.' };
  const blob = file.getBlob();
  const type = blob.getContentType();
  if (!FIGURE_TYPES[type]) return { ok: false, error: 'Figure not found.' };
  const data = 'data:' + type + ';base64,' + Utilities.base64Encode(blob.getBytes());
  cacheFigure_(id, data);
  return { ok: true, figure_id: id, data };
}

/** Change what students draw on during a session. figure is { figure_id } (an uploaded
 *  figure), { url } (a link), or null to go back to a blank page. Returns { ok, settings }. */
function apiSetSessionFigure(token, session_id, figure) {
  const instructor_id = requireInstructor_(token);
  const session = requireSessionOwner_(instructor_id, session_id);
  const kind = submissionKind_(getSessionSettings_(session).submission_type);
  if (!kind || !kind.sketch) throw new Error('This activity doesn\'t include drawing.');
  let bg = 'blank', url = '', fig = '';
  if (figure && figure.figure_id) {
    requireOwnFigure_(instructor_id, figure.figure_id);
    bg = 'image'; fig = String(figure.figure_id);
  } else if (figure && figure.url !== undefined) {
    url = normalizeImageUrl_(figure.url);
    if (!url) throw new Error('The figure address must be a web link starting with https://.');
    bg = 'image';
  }
  const sh = getSheetByName(SHEET_SESSIONS);
  ['sketch_background', 'sketch_image_url', 'sketch_figure_id'].forEach(c => ensureHeaderColumn_(sh, c));
  const { header: hdr, rows } = readTable(sh);
  const idCol = hdr.indexOf('session_id'), instCol = hdr.indexOf('instructor_id');
  const i = rows.findIndex(r => sameId_(r[idCol], session_id) && String(r[instCol]).trim() === instructor_id);
  setIfExists(sh, 2 + i, hdr, 'sketch_background', bg);
  setIfExists(sh, 2 + i, hdr, 'sketch_image_url', url);
  setIfExists(sh, 2 + i, hdr, 'sketch_figure_id', fig);
  invalidateStudentView_(instructor_id);
  return { ok: true, settings: getSessionSettings_(getSession(session_id, instructor_id)) };
}

/** Run once from the Apps Script editor (select it, then Run) after deploying figure
 *  uploads, to approve Drive access for the web app. Creates the StatChat figures folder. */
function authorizeFigureStorage() {
  figureRootFolder_();
  return 'OK';
}
