// Text & math activities: choosing them at login, storing equations, and showing them back.

function freshSheets(settings) {
  setSheets({
    Instructors: [['instructor_id', 'password'], ['i1', 'pw1']],
    Sessions: [['session_id', 'instructor_id', 'phase', 'is_open', 'is_active', 'active_until', 'created_at', 'peer_open', 'peer_opened_at', 'peer_required_reviews']],
    // Deliberately without response_content: it must be added automatically
    Responses: [['response_id', 'session_id', 'reviewer_token', 'timestamp', 'response_text_original', 'response_text_edited', 'is_hidden', 'profanity_flag']],
    PeerAssignments: [['session_id', 'reviewer_token', 'response_id', 'assigned_at']],
    PeerFeedback: [['feedback_id', 'session_id', 'response_id', 'reviewer_token', 'feedback_text', 'timestamp', 'is_hidden']],
    Settings: [['key', 'value']].concat(settings || []),
    ProfanityList: [['badword']],
  });
  __cache.clear();
  return apiInstructorLogin('i1', 'pw1').token;
}
const submit = (sid, text, math, who) => apiSubmitResponse(sid, { response_text_original: text, math, reviewer_token: who || 'stu' });
const lastRow = () => sheetObjects('Responses').slice(-1)[0];

// --- Choosing the activity: two settings ---
let tok = freshSheets();
let r = apiStartSession(tok, 'm1', 60, { submission_type: 'math', peer_review: false });
eq('math, no peer review', [r.settings.submission_type, r.settings.peer_review, r.settings.label], ['math', false, 'Quick response · math']);
eq('student view carries the type', apiGetStudentView('i1').settings.submission_type, 'math');
r = apiStartSession(tok, 'm2', 60, { submission_type: 'math', peer_review: true });
eq('math with peer review', [r.settings.peer_review, r.settings.preset, r.settings.label], [true, 'peer', 'Peer review · math']);
r = apiStartSession(tok, 't1', 60, { submission_type: 'text', peer_review: false });
eq('text as two settings = Quick response', [r.settings.preset, r.settings.label], ['respond', 'Quick response']);
eq('older preset names still accepted', apiStartSession(tok, 't2', 60, 'peer').settings.label, 'Peer review');
throws('unknown submission type rejected', () => apiStartSession(tok, 'x', 60, { submission_type: 'karaoke' }), /Unknown submission type/);

// --- Submitting: equations only ---
eq('equations accepted', submit('m1', '', ['\\bar{x} = 4.2', '  ', 's^2 = 1.1']).ok, true);
eq('response_content column added', sheetRows('Responses')[0].includes('response_content'), true);
let row = lastRow();
eq('equations stored as JSON (blank lines dropped)', JSON.parse(row.response_content), { math: ['\\bar{x} = 4.2', 's^2 = 1.1'] });
eq('readable copy in response_text_original', row.response_text_original, '$$\\bar{x} = 4.2$$\n$$s^2 = 1.1$$');
throws('text refused in a math activity', () => submit('m1', 'some words', ['x = 1']), /not text/);
throws('no equations rejected', () => submit('m1', '', ['', ' ']), /add an equation/);
throws('more than 10 lines rejected', () => submit('m1', '', Array(11).fill('x')), /at most 10/);
throws('very long equation rejected', () => submit('m1', '', ['x'.repeat(1001)]), /too long/);
throws('equations refused in a text activity', () => submit('t1', 'hi', ['x=1']), /text only/);
eq('text activity unchanged: no response_content', [submit('t1', 'plain answer').ok, lastRow().response_content], [true, '']);

// --- Profanity: equations are flagged (masking would break them), or blocked ---
eq('listed term in an equation is flagged', [submit('m1', '', ['\\text{badword}']).ok, lastRow().profanity_flag], [true, 'FLAGGED']);
tok = freshSheets([['profanity_action', 'block']]);
apiStartSession(tok, 'm1', 60, { submission_type: 'math', peer_review: false });
throws('block setting rejects a listed term in an equation', () => submit('m1', '', ['\\text{badword}']), /disallowed/);

// --- Instructor corrections ---
tok = freshSheets();
apiStartSession(tok, 'm1', 60, { submission_type: 'math', peer_review: true });
const id1 = submit('m1', '', ['a^2+b^2=c^3'], 'alice').response_id;
const id2 = submit('m1', '', ['E=mc^2'], 'bob').response_id;
let list = apiListResponsesByInstructor(tok, 'm1');
eq('dashboard list: equations, not corrected', list.map(x => [x.text, x.math, x.corrected]), [['', ['a^2+b^2=c^3'], false], ['', ['E=mc^2'], false]]);

let res = apiUpdateResponse(tok, id1, { math_edited: ['a^2+b^2=c^2', '  '] });
eq('correction saved and returned', [res.math, res.corrected], [['a^2+b^2=c^2'], true]);
eq('correction shown on the dashboard', [apiListResponsesByInstructor(tok, 'm1')[0].math, apiListResponsesByInstructor(tok, 'm1')[0].corrected], [['a^2+b^2=c^2'], true]);
row = sheetObjects('Responses')[0];
eq('student\'s submission kept alongside the correction', JSON.parse(row.response_content), { math: ['a^2+b^2=c^3'], math_edited: ['a^2+b^2=c^2'] });
eq('readable original copy unchanged', row.response_text_original, '$$a^2+b^2=c^3$$');
eq('peer review sees the correction', apiGetResponseText('m1', id1).math, ['a^2+b^2=c^2']);
throws('empty correction refused', () => apiUpdateResponse(tok, id1, { math_edited: [' '] }), /at least one equation/);
throws('too many lines refused', () => apiUpdateResponse(tok, id1, { math_edited: Array(11).fill('x') }), /at most 10/);
throws('text responses have no equations to edit', () => {
  apiStartSession(tok, 't9', 60, 'respond'); const tid = submit('t9', 'words').response_id;
  apiUpdateResponse(tok, tid, { math_edited: ['x'] });
}, /no equations/);
const otherTok = (sheetRows('Instructors').push(['i2', 'pw2']), apiInstructorLogin('i2', 'pw2').token);
throws('another instructor cannot correct it', () => apiUpdateResponse(otherTok, id1, { math_edited: ['x'] }), /Not authorized/);

res = apiUpdateResponse(tok, id1, { math_edited: null });
eq('revert: student\'s answer shown again', [res.math, res.corrected], [['a^2+b^2=c^3'], false]);
eq('revert removes the correction from the sheet', JSON.parse(sheetObjects('Responses')[0].response_content), { math: ['a^2+b^2=c^3'] });
res = apiUpdateResponse(tok, id2, { math_edited: ['E=mc^2'] });
eq('saving the original unchanged is not a correction', res.corrected, false);

// Peer review round trip: feedback received shows the student's (corrected) equations
apiUpdateResponse(tok, id2, { math_edited: ['E=mc^{2}'] });
apiStartPeerReview(tok, 'm1', 1, '');
const fb = 'This is clear and well set out, nice use of the formula here.';
apiAssignPeerTargets('m1', 'alice'); apiAssignPeerTargets('m1', 'bob');
apiSubmitPeerFeedback('m1', String(id2), 'alice', fb);
apiSubmitPeerFeedback('m1', String(id1), 'bob', fb);
const mine = apiGetMyFeedback('m1', 'bob');
eq('feedback received includes own (corrected) equations', [mine.locked, mine.feedback[0].response_math], [false, ['E=mc^{2}']]);

// Rows from earlier versions read as before
eq('text rows: no equations', responseParts_('', 'just text', ''), { text: 'just text', math: [], corrected: false, sketch: null });
eq('bad JSON falls back to text', responseParts_('', 'orig', '{oops'), { text: 'orig', math: [], corrected: false, sketch: null });
eq('earlier text + math rows keep their text', responseParts_('', 'x', '{"text":"hello","math":["x=1"]}'), { text: 'hello', math: ['x=1'], corrected: false, sketch: null });
