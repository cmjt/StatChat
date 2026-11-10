// Responses.gs — Student submissions and instructor moderation of responses.
// All .gs files share one global scope in Apps Script.

function nextResponseId(sh) {
  const { colIndex } = getHeaderMap(sh);
  const idCol = colIndex('response_id');
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 1;
  const ids = sh.getRange(2, idCol, lastRow - 1, 1).getValues().flat();
  const nums = ids.map(v => Number(v)).filter(n => !isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return max + 1;
}

function writeResponse_(payload) {
  const sh = getResponsesSheet();
  const { header } = getHeaderMap(sh);
  // ID allocation + append must be atomic, otherwise simultaneous submissions share an ID
  return withScriptLock_(() => {
    const id = nextResponseId(sh);
    const now = new Date();
    const row = header.map(h => {
      switch (h) {
        case 'response_id': return id;
        case 'timestamp':   return now;
        default:            return payload[h] !== undefined ? payload[h] : '';
      }
    });
    sh.appendRow(row);
    return id;
  });
}

// Responses with equations and/or a drawing are kept as JSON in the response_content column:
//   {"text": "...", "math": ["\\bar{x} = 4.2", ...], "math_edited": [...], "sketch": {...}}
// text is the student's written part, when the activity takes text too (a masked or edited
// version goes in response_text_edited, as for text-only answers).
// math is what the student submitted and never changes; math_edited is the instructor's
// correction, shown instead of it everywhere (like response_text_edited for text).
// response_text_original also gets a readable copy of the submission ($$...$$ per line).
//
// A drawing ("sketch") is pen strokes on a SKETCH_W x SKETCH_H canvas, in whole units:
//   {"v": 1, "bg": "axes", "s": [[colour, x0, y0, dx1, dy1, dx2, dy2, ...], ...]}
// A drawing on a figure has "bg": "image" and "img": the figure's address.
// Each stroke is a colour index then its first point, then each next point as a step from
// the previous one, which keeps drawings small enough for a Sheets cell (50,000 characters).
const MATH_MAX_LINES = 10;
const MATH_MAX_LINE_CHARS = 1000;
const SKETCH_W = 600, SKETCH_H = 400, SKETCH_COLOURS = 3;
const SKETCH_MAX_CHARS = 30000;    // the student page warns well before this
const SKETCH_MAX_STROKES = 600;
const SKETCH_MAX_POINTS = 12000;
const CONTENT_MAX_CHARS = 49000;   // whole response_content cell, under Sheets' 50,000 limit

/** Trimmed, non-blank equation lines, or throws if there are too many or one is too long */
function cleanMathLines_(lines) {
  const math = (Array.isArray(lines) ? lines : []).map(l => String(l == null ? '' : l).trim()).filter(Boolean);
  if (math.length > MATH_MAX_LINES) throw new Error(`Please use at most ${MATH_MAX_LINES} equation lines.`);
  if (math.some(l => l.length > MATH_MAX_LINE_CHARS)) throw new Error('One of the equations is too long.');
  return math;
}

/** A drawing checked and rebuilt from numbers only, or null if there's nothing drawn.
 *  Throws if it's malformed or too detailed. A drawing on a figure gets the figure's address
 *  from the activity's settings (never from the student), so it always shows the right one. */
function cleanSketch_(sketch, activity) {
  if (sketch === undefined || sketch === null || sketch === '') return null;
  const bad = () => new Error('The drawing could not be read. Please try again.');
  const big = () => new Error('Your drawing is too detailed to save. Try fewer or simpler lines.');
  if (typeof sketch !== 'object' || !Array.isArray(sketch.s)) throw bad();
  if (!sketch.s.length) return null;
  if (sketch.s.length > SKETCH_MAX_STROKES) throw big();
  const M = 20;  // strokes may run slightly off the edge
  let points = 0;
  const strokes = sketch.s.map(a => {
    if (!Array.isArray(a) || a.length < 3 || a.length % 2 === 0) throw bad();
    const n = a.map(Number);
    if (n.some(v => !Number.isInteger(v))) throw bad();
    if (n[0] < 0 || n[0] >= SKETCH_COLOURS) throw bad();
    let x = n[1], y = n[2];
    const inside = () => x >= -M && x <= SKETCH_W + M && y >= -M && y <= SKETCH_H + M;
    if (!inside()) throw bad();
    for (let i = 3; i < n.length; i += 2) {
      x += n[i]; y += n[i + 1];
      if (!inside()) throw bad();
    }
    points += (n.length - 1) / 2;
    return n;
  });
  if (points > SKETCH_MAX_POINTS) throw big();
  const out = { v: 1, bg: SKETCH_BACKGROUNDS.indexOf(sketch.bg) >= 0 ? sketch.bg : 'blank', s: strokes };
  if (out.bg === 'image') {
    if (activity && activity.background === 'image' && activity.background_url) out.img = activity.background_url;
    else out.bg = 'blank';
  }
  if (JSON.stringify(out).length > SKETCH_MAX_CHARS) throw big();
  return out;
}

function parseContent_(content) {
  if (!content) return null;
  try { const c = JSON.parse(String(content)); return (c && typeof c === 'object') ? c : null; } catch (e) { return null; }
}

/** The parts of a response to show: { text, math: [latex...], corrected, sketch }. Takes raw
 *  cell values. corrected is true when the instructor has edited the equations; sketch is
 *  the drawing or null. */
function responseParts_(edited, original, content) {
  const c = parseContent_(content);
  if (c) {
    const corrected = Array.isArray(c.math_edited);
    const math = (corrected ? c.math_edited : (Array.isArray(c.math) ? c.math : [])).map(String);
    const sketch = (c.sketch && Array.isArray(c.sketch.s)) ? c.sketch : null;
    return { text: String(edited || '') || String(c.text || ''), math, corrected, sketch };
  }
  return { text: String(edited || '') || String(original || ''), math: [], corrected: false, sketch: null };
}

/** Student submission: disabled during review. payload: { response_text_original, math:
 *  [latex...], sketch: {...}, reviewer_token, confidence }, with only the parts this activity
 *  allows. Students submit at least one of them. */
function apiSubmitResponse(session_id, payload) {
  payload = payload || {};
  const session = getSession(session_id);
  if (!session) throw new Error('Session not found.');
  if (!isSessionActive(session)) throw new Error('This session has ended, so new responses are closed.');

  const phase = getPhaseForSession(session); // writing | review
  if (phase === 'review') throw new Error('Writing is disabled during peer review.');
  const activity = getSessionSettings_(session);
  const kind = submissionKind_(activity.submission_type);
  if (!kind) {
    throw new Error('This activity expects a different kind of submission. Please reload the page.');
  }
  const settings = getSettings();
  const profList = getProfanityList();
  const action = (settings.profanity_action || 'mask').toLowerCase();
  const text = String(payload.response_text_original || '').trim();
  const math = cleanMathLines_(payload.math);
  const sketch = cleanSketch_(payload.sketch, activity);

  const rowPayload = {
    session_id,
    reviewer_token: String(payload.reviewer_token || ''),
    is_hidden: 'FALSE',
    is_pinned: 'FALSE',
    order_weight: '',
    confidence: Number(payload.confidence || '') || '',
    tags: '',
    phase_at_submit: phase  // stamp phase at submit time
  };

  // Only the parts this activity allows
  const reload = ' Please reload the page.';
  if (text && !kind.text) throw new Error('This activity doesn\'t take text.' + reload);
  if (math.length && !kind.math) throw new Error('This activity doesn\'t take equations.' + reload);
  if (sketch && !kind.sketch) throw new Error('This activity doesn\'t take a drawing.' + reload);
  if (!text && !math.length && !sketch) throw new Error(emptyAnswerMessage_(kind));
  const words = text.split(/\s+/).filter(Boolean);
  if (settings.max_words && words.length > settings.max_words) {
    throw new Error(`Please keep to ${settings.max_words} words.`);
  }
  if (!sketch && (text + math.join('')).length < settings.min_chars) throw new Error('Response too short.');

  // Text: a listed term is masked, flagged or blocked (profanity_action)
  let maskedText = '';
  let flag = 'NONE';
  if (text && hasProfanity(text, profList)) {
    if (action === 'block') throw new Error('Your response contains disallowed terms.');
    if (action === 'mask') { maskedText = maskProfanity(text, profList); flag = 'MASKED'; }
    else flag = 'FLAGGED';
  }
  // Equations can't be masked without breaking them: a listed term is blocked or flagged.
  // Drawings can't be checked.
  if (math.length && hasProfanity(math.join(' '), profList)) {
    if (action === 'block') throw new Error('Your response contains disallowed terms.');
    flag = 'FLAGGED';
  }
  rowPayload.profanity_flag = flag;
  rowPayload.response_text_edited = maskedText;

  if (!math.length && !sketch) {
    // Text only: stored as text activities always have been
    rowPayload.response_text_original = text;
    return { ok: true, response_id: writeResponse_(rowPayload) };
  }

  // Equations and/or a drawing (maybe with text) go in response_content
  const readable = [];
  if (text) readable.push(text);
  math.forEach(l => readable.push('$$' + l + '$$'));
  if (sketch) readable.push(`[drawing: ${sketch.s.length} line${sketch.s.length === 1 ? '' : 's'}]`);
  rowPayload.response_text_original = readable.join('\n');
  const content = {};
  if (text) content.text = text;
  if (math.length) content.math = math;
  if (sketch) content.sketch = sketch;
  rowPayload.response_content = JSON.stringify(content);
  if (rowPayload.response_content.length > CONTENT_MAX_CHARS) throw new Error('Your answer is too large to save. Try a simpler drawing.');
  ensureHeaderColumn_(getResponsesSheet(), 'response_content');
  return { ok: true, response_id: writeResponse_(rowPayload) };
}

/** What to say when a student submits nothing, e.g. "Please add text, an equation or a drawing." */
function emptyAnswerMessage_(kind) {
  if (kind.text && !kind.math && !kind.sketch) return 'Please enter a response.';
  if (!kind.text && !kind.math) return 'Please draw something.';
  const opts = [];
  if (kind.text) opts.push('text');
  if (kind.math) opts.push('an equation');
  if (kind.sketch) opts.push('a drawing');
  return 'Please add ' + (opts.length > 1 ? opts.slice(0, -1).join(', ') + ' or ' + opts[opts.length - 1] : opts[0]) + '.';
}

/** Legacy student API (fallback used by student.html when apiSubmitResponse fails).
 *  Delegates to apiSubmitResponse so validation, profanity handling and locking stay
 *  identical, but returns {ok:false, error} instead of throwing. */
function submitResponse(response_text, reviewer_token, class_access_code_unused, session_id, instructor_id_unused, confidence) {
  try {
    return apiSubmitResponse(session_id, {
      response_text_original: response_text,
      reviewer_token: reviewer_token,
      confidence: confidence
    });
  } catch (e) {
    return { ok:false, error: String(e && e.message ? e.message : e) };
  }
}

/** List responses by instructor + session (for dashboard) */
function apiListResponsesByInstructor(token, session_id) {
  return listResponsesForInstructor_(requireInstructor_(token), session_id);
}

function listResponsesForInstructor_(instructor_id, session_id) {
  requireSessionOwner_(instructor_id, session_id);
  const sh = getResponsesSheet();
  const values = sh.getDataRange().getValues();
  if (!values || values.length < 2) return [];
  const header = values[0];
  const rows = values.slice(1);
  const idx = name => header.indexOf(name);

  return rows
    .filter(r => String(r[idx('session_id')]).trim().toLowerCase() === String(session_id).trim().toLowerCase())
    .map(r => {
      const parts = responseParts_(r[idx('response_text_edited')], r[idx('response_text_original')],
                                   idx('response_content') >= 0 ? r[idx('response_content')] : '');
      return {
      response_id: String(r[idx('response_id')] || ''),
      text: parts.text,   // the text part to show (instructor edit, else what the student wrote)
      math: parts.math,   // equations (LaTeX) to show, math activities only
      corrected: parts.corrected,  // the instructor has edited the equations
      sketch: parts.sketch,        // the drawing, drawing activities only (or null)
      response_text_original: String(r[idx('response_text_original')] || ''),
      response_text_edited: String(r[idx('response_text_edited')] || ''),
      timestamp: String(r[idx('timestamp')] || ''),
      is_hidden: String(r[idx('is_hidden')] || 'FALSE'),
      is_pinned: String(r[idx('is_pinned')] || 'FALSE'),
      order_weight: Number(r[idx('order_weight')] || 0),
      confidence: Number(r[idx('confidence')] || ''),
      tags: String(r[idx('tags')] || ''),
      profanity_flag: idx('profanity_flag') >= 0 ? String(r[idx('profanity_flag')] || '') : '',
      pos_x: Number(r[idx('pos_x')] || 0),
      pos_y: Number(r[idx('pos_y')] || 0),
      phase_at_submit: idx('phase_at_submit') >= 0 ? String(r[idx('phase_at_submit')] || '') : ''
      };
    });
}

/** Update response fields (validate ownership via session mapping) */
function apiUpdateResponse(token, response_id, patch) {
  const instructor_id = requireInstructor_(token);
  patch = patch || {};
  const sh = getResponsesSheet();
  const values = sh.getDataRange().getValues();
  if (!values || values.length < 2) throw new Error('No responses.');
  const header = values[0];
  const rows = values.slice(1);

  const idCol = header.indexOf('response_id');
  const sessCol = header.indexOf('session_id');
  if (idCol === -1 || sessCol === -1) throw new Error('Missing response_id or session_id columns.');

  const rIndex = rows.findIndex(r => String(r[idCol]) === String(response_id));
  if (rIndex === -1) throw new Error('Response not found');
  const row = rows[rIndex];
  const sessId = row[sessCol];

  const session = getSession(sessId, instructor_id);
  if (!session) {
    throw new Error('Not authorized to modify this response.');
  }

  // Correcting a math response: patch.math_edited is the corrected equations, or null to go
  // back to the student's own. The submission itself (math) is never changed.
  let result = { ok: true };
  if ('math_edited' in patch) {
    const cCol = header.indexOf('response_content');
    const content = cCol >= 0 ? parseContent_(row[cCol]) : null;
    if (!content || !Array.isArray(content.math)) throw new Error('This response has no equations to edit.');
    if (patch.math_edited === null) {
      delete content.math_edited;
    } else {
      const lines = cleanMathLines_(patch.math_edited);
      if (!lines.length) throw new Error('An answer needs at least one equation. To remove it, hide the card instead.');
      if (JSON.stringify(lines) === JSON.stringify(content.math)) delete content.math_edited;  // back to the original
      else content.math_edited = lines;
    }
    const json = JSON.stringify(content);
    if (json.length > CONTENT_MAX_CHARS) throw new Error('This answer is too large to save with these equations. Try fewer or shorter lines.');
    sh.getRange(2 + rIndex, cCol + 1).setValue(json);
    const parts = responseParts_('', '', JSON.stringify(content));
    result = { ok: true, math: parts.math, corrected: parts.corrected };
  }

  const allowed = ['response_text_edited', 'is_pinned', 'is_hidden', 'order_weight', 'tags', 'pos_x', 'pos_y'];
  allowed.forEach(k => {
    if (k in patch) {
      const col = header.indexOf(k);
      if (col >= 0) sh.getRange(2 + rIndex, col + 1).setValue(patch[k]);
    }
  });

  return result;
}

/** Gate: has this reviewer submitted at least one response in this session? (non-hidden only) */
function apiHasSubmitted(session_id, reviewer_token){
  const sh = getResponsesSheet();
  const { header: hdr, rows } = readTable(sh);
  const sCol = hdr.indexOf('session_id');
  const uCol = hdr.indexOf('reviewer_token');
  const hidCol = hdr.indexOf('is_hidden');
  if (sCol === -1 || uCol === -1) throw new Error('Missing session_id or reviewer_token columns in Responses.');
  const targetS = String(session_id).trim().toLowerCase();
  const targetU = String(reviewer_token).trim();
  const has = rows.some(r =>
    String(r[sCol]).trim().toLowerCase() === targetS &&
    String(r[uCol]).trim() === targetU &&
    String(r[hidCol]||'FALSE').toLowerCase() !== 'true'
  );
  return { ok:true, has };
}

/** Return the visible text for a specific response (edited -> original), or error if hidden/missing */
function apiGetResponseText(session_id, response_id) {
  if (!session_id || !response_id) return { ok:false, error:'Missing session_id or response_id' };

  const shR = getResponsesSheet();
  const { header: hdr, rows } = readTable(shR);
  const idx = (name)=>{ const i = hdr.indexOf(name); if (i === -1) throw new Error(`Missing ${name} in Responses.`); return i; };
  const sCol = idx('session_id'),
        idCol = idx('response_id'),
        hidCol = idx('is_hidden'),
        txtECol = idx('response_text_edited'),
        txtOCol = idx('response_text_original');

  const targetS = String(session_id).trim().toLowerCase();
  const row = rows.find(r =>
    String(r[sCol]).trim().toLowerCase() === targetS &&
    String(r[idCol]).trim() === String(response_id).trim()
  );
  if (!row) return { ok:false, error:'Response not found' };
  if (String(row[hidCol]||'FALSE').toLowerCase() === 'true') return { ok:false, error:'Response is hidden' };

  const cCol = hdr.indexOf('response_content');
  const parts = responseParts_(row[txtECol], row[txtOCol], cCol >= 0 ? row[cCol] : '');
  return { ok:true, response_id: String(response_id), text: parts.text, math: parts.math, sketch: parts.sketch };
}
