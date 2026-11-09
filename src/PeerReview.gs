// PeerReview.gs — Peer review: opening/closing, assignment, submission, unlock and instructor ratings.
// All .gs files share one global scope in Apps Script.

// These helpers are the single source of truth for "which reviews does this student owe,
// and have they done them". They're used to hand out assignments, to validate review
// submissions, and to decide (server-side) whether received feedback is unlocked.

const DEFAULT_REVIEWS_PER_STUDENT = 1;

/** Reviews each student must complete in this session */
function requiredReviews_(session) {
  return Math.max(1, parseInt(session && session.peer_required_reviews, 10) || DEFAULT_REVIEWS_PER_STUDENT);
}

/** Visible (not hidden) responses in a session, in sheet order: [{response_id, author, text, math, sketch}] */
function visibleResponses_(session_id) {
  const { header: hdr, rows } = readTable(getResponsesSheet());
  const idx = (name)=>{ const i = hdr.indexOf(name); if (i===-1) throw new Error(`Missing ${name} in Responses.`); return i; };
  const sCol = idx('session_id'), hidCol = idx('is_hidden'), uidCol = idx('reviewer_token'),
        idCol = idx('response_id'), txtECol = idx('response_text_edited'), txtOCol = idx('response_text_original'),
        cCol = hdr.indexOf('response_content');
  return rows
    .filter(r => sameId_(r[sCol], session_id) && String(r[hidCol] || 'FALSE').toLowerCase() !== 'true')
    .map(r => {
      const parts = responseParts_(r[txtECol], r[txtOCol], cCol >= 0 ? r[cCol] : '');
      return { response_id: String(r[idCol] || ''), author: String(r[uidCol] || '').trim(), text: parts.text, math: parts.math, sketch: parts.sketch };
    });
}

/** All response_ids assigned to this reviewer in this session, in assignment order */
function assignedIds_(session_id, reviewer_token) {
  const { header: aHdr, rows: aRows } = readTable(getPeerAssignmentsSheet());
  const aIdx = (name)=>{ const i=aHdr.indexOf(name); if (i===-1) throw new Error(`Missing ${name} in PeerAssignments.`); return i; };
  const aSCol = aIdx('session_id'), aUCol = aIdx('reviewer_token'), aRidCol = aIdx('response_id');
  const token = String(reviewer_token || '').trim();
  return aRows
    .filter(r => sameId_(r[aSCol], session_id) && String(r[aUCol]).trim() === token)
    .map(r => String(r[aRidCol]));
}

/** Assignment stats for a session: how many reviewers each response_id has (counts), and
 *  which students have already been given assignments (reviewers). */
function assignmentStats_(session_id) {
  const { header: aHdr, rows: aRows } = readTable(getPeerAssignmentsSheet());
  const aSCol = aHdr.indexOf('session_id'), aRidCol = aHdr.indexOf('response_id'), aUCol = aHdr.indexOf('reviewer_token');
  const counts = new Map(), reviewers = new Set();
  if (aSCol === -1 || aRidCol === -1) return { counts, reviewers };
  aRows.forEach(r => {
    if (!sameId_(r[aSCol], session_id)) return;
    const id = String(r[aRidCol]);
    counts.set(id, (counts.get(id) || 0) + 1);
    if (aUCol !== -1) reviewers.add(String(r[aUCol]).trim());
  });
  return { counts, reviewers };
}

/** response_ids this reviewer has already reviewed in this session (ignoring hidden reviews) */
function reviewedIds_(session_id, reviewer_token) {
  const { header: hdr, rows } = readTable(getPeerFeedbackSheet());
  const sCol = hdr.indexOf('session_id'), rCol = hdr.indexOf('response_id'),
        uCol = hdr.indexOf('reviewer_token'), hCol = hdr.indexOf('is_hidden');
  if ([sCol, rCol, uCol].some(i => i === -1)) throw new Error('Missing columns in PeerFeedback.');
  const token = String(reviewer_token || '').trim();
  return new Set(rows
    .filter(r => sameId_(r[sCol], session_id) && String(r[uCol]).trim() === token &&
                 (hCol === -1 || String(r[hCol] || 'FALSE').toLowerCase() !== 'true'))
    .map(r => String(r[rCol])));
}

/**
 * A reviewer's progress: the responses they currently owe a review for (assigned, still
 * visible, capped at the required number) and whether they have reviewed all of them.
 * Responses the instructor hid after assignment no longer count.
 */
function reviewProgress_(session_id, reviewer_token, visible) {
  const session = getSession(session_id);
  const n = requiredReviews_(session);
  const visibleIds = new Set((visible || visibleResponses_(session_id)).map(v => v.response_id));
  const assigned = assignedIds_(session_id, reviewer_token).filter(id => visibleIds.has(id)).slice(0, n);
  const completed = reviewedIds_(session_id, reviewer_token);
  const allDone = assigned.length > 0 && assigned.every(id => completed.has(id));
  return { session, required: n, assigned, completed, allDone };
}

/** Change the peer review deadline. Pass '' for no deadline. */
function apiSetPeerDeadline(token, session_id, peer_until_iso) {
  const instructor_id = requireInstructor_(token);
  const until = parseDeadline_(peer_until_iso);
  if (until && until <= new Date()) throw new Error('The review deadline must be in the future.');
  const { sh, base } = findOwnedSessionRow_(instructor_id, session_id);
  const col = ensureHeaderColumn_(sh, 'peer_until');
  sh.getRange(base, col).setValue(until || '');
  invalidateStudentView_(instructor_id);
  return { ok:true, peer_until: until ? until.toISOString() : '' };
}

/** Close peer review submissions now. Received reviews stay viewable. */
function apiCloseReviews(token, session_id) {
  const instructor_id = requireInstructor_(token);
  const { sh, base } = findOwnedSessionRow_(instructor_id, session_id);
  const col = ensureHeaderColumn_(sh, 'peer_until');
  const now = new Date();
  sh.getRange(base, col).setValue(now);
  invalidateStudentView_(instructor_id);
  return { ok:true, peer_until: now.toISOString() };
}

/** List feedback submitted by a reviewer (to gray out completed) */
function apiListFeedbackByReviewer(session_id, reviewer_id){
  const sh = getPeerFeedbackSheet();
  const { header: hdr, rows } = readTable(sh);
  const sCol = hdr.indexOf('session_id');
  const rCol = hdr.indexOf('response_id');
  const uCol = hdr.indexOf('reviewer_token');
  const hCol = hdr.indexOf('is_hidden');
  if ([sCol,rCol,uCol,hCol].some(i=>i===-1)) throw new Error('Missing columns in PeerFeedback.');
  const targetS = String(session_id).trim().toLowerCase();
  const targetU = String(reviewer_id||'').trim();
  const done = rows
    .filter(r => String(r[sCol]).trim().toLowerCase() === targetS &&
                 String(r[uCol]).trim() === String(reviewer_id) &&
                 String(r[hCol]||'FALSE').toLowerCase() !== 'true')
    .map(r => String(r[rCol]||''));
  return { ok:true, completed: done };
}

/*********************************
 * OPEN peer review (instructor) *
 *********************************/
function apiStartPeerReview(token, session_id, reviews_per_student, peer_until_iso) {
  const instructor_id = requireInstructor_(token);
  if (!session_id) throw new Error('Missing session.');
  const peerUntil = parseDeadline_(peer_until_iso); // null = no deadline
  if (peerUntil && peerUntil <= new Date()) throw new Error('The review deadline must be in the future.');

  const sh = getSheetByName(SHEET_SESSIONS);
  ensureHeaderColumn_(sh, 'peer_until');
  const { header: hdr, rows } = readTable(sh);

  const idCol   = hdr.indexOf('session_id');
  const instCol = hdr.indexOf('instructor_id');
  if (idCol === -1 || instCol === -1) throw new Error('Missing session_id or instructor_id in Sessions.');

  const rowIdx = rows.findIndex(r =>
    String(r[idCol]).trim().toLowerCase() === String(session_id).trim().toLowerCase() &&
    String(r[instCol]).trim() === String(instructor_id)
  );
  if (rowIdx === -1) throw new Error('Session not found for instructor.');
  if (!getSessionSettings_(getSession(session_id, instructor_id)).peer_review) {
    throw new Error('Peer review is not enabled for this session. Start it as a "Peer review" activity.');
  }

  const base = 2 + rowIdx;
  const openedAt = new Date();
  const k  = Math.max(1, parseInt(reviews_per_student,10) || DEFAULT_REVIEWS_PER_STUDENT);

  // Only set columns if they exist
  setIfExists(sh, base, hdr, 'phase', 'review');
  setIfExists(sh, base, hdr, 'peer_open', 'TRUE');
  setIfExists(sh, base, hdr, 'peer_opened_at', openedAt);
  setIfExists(sh, base, hdr, 'peer_required_reviews', k);
  setIfExists(sh, base, hdr, 'peer_until', peerUntil || '');

  // Only one peer review open per instructor: close any others left open from earlier sessions
  const openCol = hdr.indexOf('peer_open');
  if (openCol >= 0) {
    rows.forEach((r, i) => {
      if (i === rowIdx) return;
      if (String(r[instCol]).trim() !== String(instructor_id)) return;
      if (String(r[openCol]).toLowerCase() !== 'true') return;
      sh.getRange(2 + i, openCol + 1).setValue('FALSE');
    });
  }

  invalidateStudentView_(instructor_id);
  return {
    ok:true, session_id, phase:'review', peer_open:true, reviews_per_student: k,
    opened_at: openedAt.toISOString(), peer_until: peerUntil ? peerUntil.toISOString() : ''
  };
}

/** Assign peer responses for a reviewer to review (never their own; hidden responses excluded).
 *  The number is the session's peer_required_reviews; it can't be chosen by the client.
 *  Existing assignments are kept; if one was hidden by the instructor, a replacement is
 *  assigned while reviews are still open. Returns { ok, assigned: [response_id] }.
 */
function apiAssignPeerTargets(session_id, reviewer_token) {
  const token = String(reviewer_token || '').trim();
  if (!session_id || !token) return { ok:true, assigned: [] };

  const visible = visibleResponses_(session_id);
  // Only students who submitted a (visible) response take part
  if (!visible.some(v => v.author === token)) return { ok:true, assigned: [] };

  // Read-check-append runs under the lock so two tabs/refreshes from the same student
  // can't both append a fresh set, and concurrent appends can't overwrite each other's rows.
  const shA = getPeerAssignmentsSheet();
  return withScriptLock_(() => {
    const progress = reviewProgress_(session_id, token, visible);
    const n = progress.required;
    const assigned = progress.assigned;
    if (assigned.length >= n) return { ok:true, assigned };
    // After the review deadline, show existing assignments but don't hand out new ones
    if (!areReviewsOpen_(progress.session)) return { ok:true, assigned };

    // Pool: other students' visible responses not already assigned to this reviewer
    // (including assignments that were later hidden, so they never come back)
    const everAssigned = new Set(assignedIds_(session_id, token));
    const pool = visible.filter(v => v.author !== token && !everAssigned.has(v.response_id));
    // Balance the load:
    //  1. prefer responses with the fewest reviewers so far, so every response gets
    //     reviewed before any gets a second reviewer;
    //  2. among those, prefer responses whose authors haven't fetched their assignments
    //     yet. Assignment is first-come-first-served, and a student can't review their own
    //     response, so if the last student to arrive found only their own response
    //     unreviewed it would stay unreviewed. Covering not-yet-arrived authors first
    //     avoids that.
    // Shuffle first so remaining ties are broken randomly (Array.prototype.sort is stable in V8).
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const { counts: load, reviewers: arrived } = assignmentStats_(session_id);
    pool.sort((a, b) =>
      ((load.get(a.response_id) || 0) - (load.get(b.response_id) || 0)) ||
      ((arrived.has(a.author) ? 1 : 0) - (arrived.has(b.author) ? 1 : 0)));
    const take = pool.slice(0, n - assigned.length).map(v => v.response_id);

    // Persist newly assigned, honouring the sheet's header order
    if (take.length) {
      const { header: aHdr } = readTable(shA);
      const now = new Date();
      const rowsToAppend = take.map(id => aHdr.map(h => {
        switch (h) {
          case 'session_id':     return session_id;
          case 'reviewer_token': return token;
          case 'response_id':    return id;
          case 'assigned_at':    return now;
          default:               return '';
        }
      }));
      shA.getRange(shA.getLastRow() + 1, 1, rowsToAppend.length, aHdr.length).setValues(rowsToAppend);
    }
    return { ok:true, assigned: assigned.concat(take) };
  });
}

/** Submit peer feedback (free form)
 *  Allowed while peer review is open and before its deadline (see areReviewsOpen_).
 */
function apiSubmitPeerFeedback(session_id, response_id, reviewer_token, feedback_text){
  const session = getSession(session_id);
  if (!session) throw new Error('Session not found.');

  // Allowed while peer review is open and before its deadline (even after the session ends)
  if (!areReviewsOpen_(session)) throw new Error('Peer review is closed, so new reviews can no longer be submitted.');

  const settings = getSettings();
  const text = String(feedback_text||'').trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 10) throw new Error('Please write at least 10 words.');
  if (settings.max_words && words.length > settings.max_words){
    throw new Error(`Please keep to ${settings.max_words} words.`);
  }

  const profList = getProfanityList();
  const hasProf = hasProfanity(text, profList);
  // Same handling as responses: mask (default), block, or flag for the instructor
  let outText = text;
  let profanity_flag = 'NONE';
  const action = (settings.profanity_action || 'mask').toLowerCase();
  if (hasProf) {
    if (action === 'block') {
      throw new Error('Your feedback contains disallowed terms.');
    } else if (action === 'mask') {
      outText = maskProfanity(text, profList);
      profanity_flag = 'MASKED';
    } else {
      profanity_flag = 'FLAGGED';
    }
  }

  const sh = getPeerFeedbackSheet();
  const { header: hdr } = readTable(sh);
  const idx = (name)=>{ const i=hdr.indexOf(name); if (i===-1) throw new Error(`Missing column ${name} in PeerFeedback.`); return i; };

  const token = String(reviewer_token || '').trim();
  const rid = String(response_id || '').trim();
  if (!token || !rid) throw new Error('Missing reviewer or response.');

  // Validate and append under the lock, so a double-click can't store the same review twice
  // and feedback IDs stay unique
  return withScriptLock_(() => {
    const progress = reviewProgress_(session_id, token);
    if (!progress.assigned.includes(rid)) {
      throw new Error('You can only review responses assigned to you.');
    }
    if (progress.completed.has(rid)) {
      throw new Error('You have already reviewed this response.');
    }

    const last = sh.getLastRow();
    let nextId = 1;
    if (last >= 2){
      const ids = sh.getRange(2, idx('feedback_id')+1, last-1, 1).getValues().flat().map(Number).filter(n=>!isNaN(n));
      nextId = (ids.length ? Math.max(...ids) : 0) + 1;
    }

    const row = hdr.map(h => {
      switch(h){
        case 'feedback_id':  return nextId;
        case 'session_id':   return session_id;
        case 'response_id':  return rid;
        case 'reviewer_token':  return token;
        case 'feedback_text':return outText;
        case 'profanity_flag': return profanity_flag;
        case 'timestamp':    return new Date();
        case 'is_hidden':    return 'FALSE';
        default:             return '';
      }
    });
    sh.appendRow(row);
    return { ok:true, feedback_id: nextId };
  });
}

/**
 * apiListFeedbackSummary(instructor_id, session_id)
 * Returns {ok:true, byResponse: { [response_id]: {count, items:[{id,text,timestamp,quality}]} } }
 * Only includes items where is_hidden is not TRUE, and session_id matches.
 */
function apiListFeedbackSummary(token, session_id) {
  // Auth errors are thrown (not returned) so the dashboard's failure handler sees them
  requireSessionOwner_(requireInstructor_(token), session_id);
  try {
    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName('PeerFeedback');
    if (!sh) return { ok: false, error: 'PeerFeedback sheet not found' };

    // Make sure the quality column exists (create if missing)
    const qualityColIdx = ensureHeaderColumn_(sh, 'review_quality');

    const all = readSheetObjects_(sh);

    // Filter: match session_id, not hidden
    const rows = all.filter(r =>
      sameId_(r.session_id, session_id) &&
      String(r.is_hidden || '').toLowerCase() !== 'true'
    );

    // Build byResponse mapping
    const byResponse = {};
    rows.forEach(r => {
      const rid = String(r.response_id || '').trim();
      if (!rid) return;

      if (!byResponse[rid]) byResponse[rid] = { count: 0, items: [] };

      const ts = r.timestamp instanceof Date ? r.timestamp : (r.timestamp ? new Date(r.timestamp) : null);
      const iso = ts && !isNaN(ts.getTime()) ? ts.toISOString() : '';

      const item = {
        id: String(r.feedback_id || ''),            // if blank, client will fall back to timestamp
        text: String(r.feedback_text || ''),
        timestamp: iso,
        quality: String(r.review_quality || ''),    // may be blank initially
        flagged: String(r.profanity_flag || '').toUpperCase() === 'FLAGGED'
      };

      byResponse[rid].items.push(item);
    });

    // Add counts
    Object.keys(byResponse).forEach(rid => {
      byResponse[rid].count = byResponse[rid].items.length;
    });

    return { ok: true, byResponse: byResponse };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

  /**
   * apiUpdateFeedbackQuality(instructor_id, session_id, response_id, feedback_key, quality)
   * Upserts the review_quality for a single review in PeerFeedback.
   * feedback_key can be:
   *   - feedback_id (preferred), or
   *   - timestamp (ISO) if you don’t have feedback_id on the client.
   */
  function apiUpdateFeedbackQuality(token, session_id, response_id, feedback_key, quality) {
    // Auth errors are thrown (not returned) so the dashboard's failure handler sees them
    requireSessionOwner_(requireInstructor_(token), session_id);
    try {
      const ss = SpreadsheetApp.getActive();
      const sh = ss.getSheetByName('PeerFeedback');
      if (!sh) return { ok: false, error: 'PeerFeedback sheet not found' };

      // Ensure the review_quality column exists
      const reviewQualityCol = ensureHeaderColumn_(sh, 'review_quality');

      // Build header index map for quick lookup
      const headerRow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
      const colIndex = (name) => headerRow.indexOf(name) + 1; // 1-based (0 if not found)

      const cFeedbackId = colIndex('feedback_id');
      const cSessionId  = colIndex('session_id');
      const cResponseId = colIndex('response_id');
      const cTimestamp  = colIndex('timestamp');

      if (!cSessionId || !cResponseId) {
        return { ok: false, error: 'PeerFeedback sheet missing required columns: session_id/response_id' };
      }

      const lastRow = sh.getLastRow();
      if (lastRow < 2) return { ok: false, error: 'No rows in PeerFeedback' };

      const rng = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn());
      const vals = rng.getValues();

      let targetRow = -1; // absolute row number (1-based)

      // Helper to match timestamp key
      const matchesTimestamp = (cellValue, key) => {
        try {
          const a = (cellValue instanceof Date) ? cellValue : (cellValue ? new Date(cellValue) : null);
          const b = key ? new Date(key) : null;
          if (!a || !b || isNaN(a.getTime()) || isNaN(b.getTime())) return false;
          return a.getTime() === b.getTime();
        } catch (_) { return false; }
      };

      // Iterate and find a matching row
      for (let i = 0; i < vals.length; i++) {
        const row = vals[i];

        const sessionOk  = sameId_(row[cSessionId - 1], session_id);
        const responseOk = String(row[cResponseId - 1]).trim() === String(response_id).trim();
        if (!sessionOk || !responseOk) continue;

        let keyOk = false;

        // First try: feedback_id == feedback_key (only if feedback_id column exists and key looks like id)
        if (cFeedbackId && feedback_key != null && feedback_key !== '') {
          const idOk = String(row[cFeedbackId - 1]).trim() === String(feedback_key).trim();
          if (idOk) keyOk = true;
        }

        // Fallback: timestamp == feedback_key (if no match by feedback_id)
        if (!keyOk && cTimestamp && feedback_key) {
          if (matchesTimestamp(row[cTimestamp - 1], feedback_key)) {
            keyOk = true;
          }
        }

        if (keyOk) {
          targetRow = i + 2; // +2 (range starts at row 2)
          break;
        }
      }

      if (targetRow === -1) {
        return { ok: false, error: 'Feedback row not found for the provided key' };
      }

      // Write quality
      sh.getRange(targetRow, reviewQualityCol).setValue(String(quality || ''));

      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

/**
 * Feedback received on this student's own responses. Locked (empty) until they have
 * completed all their assigned reviews; this is enforced here, not just in the page.
 * Hidden responses and hidden reviews are excluded.
 */
function apiGetMyFeedback(session_id, reviewer_token) {
  const token = String(reviewer_token || '').trim();
  const locked = { ok:true, locked:true, feedback: [] };
  if (!session_id || !token) return locked;

  const visible = visibleResponses_(session_id);
  if (!reviewProgress_(session_id, token, visible).allDone) return locked;

  // This student's own visible responses
  const mine = new Map(visible.filter(v => v.author === token).map(v => [v.response_id, v]));

  const { header: fHdr, rows: fRows } = readTable(getPeerFeedbackSheet());
  const fIdx = (name)=>{ const i = fHdr.indexOf(name); if (i===-1) throw new Error(`Missing ${name} in PeerFeedback.`); return i; };
  const sCol = fIdx('session_id'), rCol = fIdx('response_id'), tCol = fIdx('feedback_text'),
        tsCol = fIdx('timestamp'), hCol = fHdr.indexOf('is_hidden');

  const feedback = fRows
    .filter(r => sameId_(r[sCol], session_id) && mine.has(String(r[rCol])) &&
                 (hCol === -1 || String(r[hCol] || 'FALSE').toLowerCase() !== 'true'))
    .map(r => ({
      response_id: String(r[rCol]),
      response_text: mine.get(String(r[rCol])).text,
      response_math: mine.get(String(r[rCol])).math,
      response_sketch: mine.get(String(r[rCol])).sketch,
      feedback: String(r[tCol] || ''),
      timestamp: String(r[tsCol] || '')
    }));
  return { ok:true, locked:false, feedback };
}
