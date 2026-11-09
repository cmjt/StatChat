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

// Math responses (math activities): up to MATH_MAX_LINES equations of LaTeX, at most
// MATH_MAX_LINE_CHARS each, kept as JSON in the response_content column:
//   {"math": ["\\bar{x} = 4.2", ...], "math_edited": [...]}
// math is what the student submitted and never changes; math_edited is the instructor's
// correction, shown instead of it everywhere (like response_text_edited for text).
// response_text_original also gets a readable copy of the submission ($$...$$ per line).
// Rows from before math activities were maths-only may also have "text".
const MATH_MAX_LINES = 10;
const MATH_MAX_LINE_CHARS = 1000;

/** Trimmed, non-blank equation lines, or throws if there are too many or one is too long */
function cleanMathLines_(lines) {
  const math = (Array.isArray(lines) ? lines : []).map(l => String(l == null ? '' : l).trim()).filter(Boolean);
  if (math.length > MATH_MAX_LINES) throw new Error(`Please use at most ${MATH_MAX_LINES} equation lines.`);
  if (math.some(l => l.length > MATH_MAX_LINE_CHARS)) throw new Error('One of the equations is too long.');
  return math;
}

function parseContent_(content) {
  if (!content) return null;
  try { const c = JSON.parse(String(content)); return (c && typeof c === 'object') ? c : null; } catch (e) { return null; }
}

/** The parts of a response to show: { text, math: [latex...], corrected }. Takes raw cell values.
 *  corrected is true when the instructor has edited the equations. */
function responseParts_(edited, original, content) {
  const c = parseContent_(content);
  if (c) {
    const corrected = Array.isArray(c.math_edited);
    const math = (corrected ? c.math_edited : (Array.isArray(c.math) ? c.math : [])).map(String);
    return { text: String(edited || '') || String(c.text || ''), math, corrected };
  }
  return { text: String(edited || '') || String(original || ''), math: [], corrected: false };
}

/** Student submission: disabled during review. payload: { response_text_original,
 *  reviewer_token, confidence } for text activities, or { math: [latex...], reviewer_token,
 *  confidence } for math activities (equations only, no text). */
function apiSubmitResponse(session_id, payload) {
  payload = payload || {};
  const session = getSession(session_id);
  if (!session) throw new Error('Session not found.');
  if (!isSessionActive(session)) throw new Error('This session has ended, so new responses are closed.');

  const phase = getPhaseForSession(session); // writing | review
  if (phase === 'review') throw new Error('Writing is disabled during peer review.');
  const type = getSessionSettings_(session).submission_type;
  if (type !== 'text' && type !== 'math') {
    throw new Error('This activity expects a different kind of submission. Please reload the page.');
  }
  const settings = getSettings();
  const profList = getProfanityList();
  const action = (settings.profanity_action || 'mask').toLowerCase();
  const text = String(payload.response_text_original || '').trim();
  const math = cleanMathLines_(payload.math);

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

  if (type === 'math') {
    if (text) throw new Error('This activity takes equations only. Please reload the page.');
    if (!math.length) throw new Error('Please add an equation.');
    if (math.join('').length < settings.min_chars) throw new Error('Response too short.');
    // Equations can't be masked without breaking them: a listed term is blocked or flagged
    const prof = hasProfanity(math.join(' '), profList);
    if (prof && action === 'block') throw new Error('Your response contains disallowed terms.');
    rowPayload.profanity_flag = prof ? 'FLAGGED' : 'NONE';
    rowPayload.response_text_original = math.map(l => '$$' + l + '$$').join('\n');
    rowPayload.response_text_edited = '';
    ensureHeaderColumn_(getResponsesSheet(), 'response_content');
    rowPayload.response_content = JSON.stringify({ math });
    return { ok: true, response_id: writeResponse_(rowPayload) };
  }

  // Text activity
  if (math.length) throw new Error('This activity takes text only. Please reload the page.');
  const words = text.split(/\s+/).filter(Boolean);
  if (!text) throw new Error('Please enter a response.');
  if (settings.max_words && words.length > settings.max_words) {
    throw new Error(`Please keep to ${settings.max_words} words.`);
  }
  if (text.length < settings.min_chars) {
    throw new Error('Response too short.');
  }

  // Profanity handling
  let response_text_masked = text;
  let profanity_flag = 'NONE';
  if (hasProfanity(text, profList)) {
    if (action === 'block') {
      throw new Error('Your response contains disallowed terms.');
    } else if (action === 'mask') {
      response_text_masked = maskProfanity(text, profList);
      profanity_flag = 'MASKED';
    } else {
      profanity_flag = 'FLAGGED';
    }
  }
  rowPayload.response_text_original = text;
  rowPayload.response_text_edited = (profanity_flag === 'MASKED') ? response_text_masked : '';
  rowPayload.profanity_flag = profanity_flag;
  return { ok: true, response_id: writeResponse_(rowPayload) };
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
    sh.getRange(2 + rIndex, cCol + 1).setValue(JSON.stringify(content));
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
  return { ok:true, response_id: String(response_id), text: parts.text, math: parts.math };
}
