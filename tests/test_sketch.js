// Drawing activities on the server: settings, checking and storing drawings, reading them back.

function freshSheets() {
  setSheets({
    Instructors: [['instructor_id', 'password'], ['i1', 'pw1']],
    Sessions: [['session_id', 'instructor_id', 'phase', 'is_open', 'is_active', 'active_until', 'created_at', 'peer_open', 'peer_opened_at', 'peer_required_reviews']],
    Responses: [['response_id', 'session_id', 'reviewer_token', 'timestamp', 'response_text_original', 'response_text_edited', 'is_hidden', 'profanity_flag']],
    PeerAssignments: [['session_id', 'reviewer_token', 'response_id', 'assigned_at']],
    PeerFeedback: [['feedback_id', 'session_id', 'response_id', 'reviewer_token', 'feedback_text', 'timestamp', 'is_hidden']],
    Settings: [['key', 'value']],
    ProfanityList: [['badword']],
  });
  __cache.clear();
  return apiInstructorLogin('i1', 'pw1').token;
}
const line = [0, 10, 10, 5, 5, 5, 5];           // black stroke (10,10) -> (15,15) -> (20,20)
const drawing = (s, bg) => ({ v: 1, bg: bg || 'axes', s });
const send = (sid, payload, who) => apiSubmitResponse(sid, Object.assign({ reviewer_token: who || 'stu' }, payload));
const lastRow = () => sheetObjects('Responses').slice(-1)[0];

// --- Settings ---
let tok = freshSheets();
let r = apiStartSession(tok, 'd1', 60, { submission_type: 'sketch', peer_review: false, background: 'axes' });
eq('drawing activity', [r.settings.submission_type, r.settings.label, r.settings.background], ['sketch', 'Quick response · drawing', 'axes']);
eq('background column added', sheetRows('Sessions')[0].includes('sketch_background'), true);
eq('student view carries the background', apiGetStudentView('i1').settings.background, 'axes');
r = apiStartSession(tok, 'd2', 61, { submission_type: 'math_sketch', peer_review: true });
eq('math & drawing, background defaults to blank', [r.settings.label, r.settings.background], ['Peer review · math & drawing', 'blank']);
throws('unknown background rejected', () => apiStartSession(tok, 'd3', 60, { submission_type: 'sketch', background: 'tartan' }), /background/);
eq('mid-review: background kept with the other settings', (() => {
  apiStartPeerReview(tok, 'd2', 1, '');
  return apiStartSession(tok, 'd2', 61, { submission_type: 'sketch', background: 'grid' }).settings.background;
})(), 'blank');

// --- Submitting drawings ---
eq('drawing accepted', send('d1', { sketch: drawing([line, [2, 100, 100]]) }).ok, true);
let row = lastRow();
eq('stored as JSON', JSON.parse(row.response_content), { sketch: { v: 1, bg: 'axes', s: [line, [2, 100, 100]] } });
eq('readable note in response_text_original', row.response_text_original, '[drawing: 2 lines]');
eq('extra fields dropped, numbers kept', (send('d1', { sketch: { v: 9, bg: 'axes', s: [['0', '1', '2']], evil: '<script>' } }), JSON.parse(lastRow().response_content).sketch), { v: 1, bg: 'axes', s: [[0, 1, 2]] });
eq('unknown background stored as blank', (send('d1', { sketch: drawing([line], 'nope') }), JSON.parse(lastRow().response_content).sketch.bg), 'blank');
throws('empty drawing: asked to draw', () => send('d1', { sketch: drawing([]) }), /draw something/);
throws('nothing at all: asked to draw', () => send('d1', {}), /draw something/);
throws('not a drawing', () => send('d1', { sketch: 'scribble' }), /could not be read/);
throws('even-length stroke rejected', () => send('d1', { sketch: drawing([[0, 1, 2, 3]]) }), /could not be read/);
throws('non-integer rejected', () => send('d1', { sketch: drawing([[0, 1.5, 2]]) }), /could not be read/);
throws('bad colour rejected', () => send('d1', { sketch: drawing([[7, 1, 2]]) }), /could not be read/);
throws('point far off the canvas rejected', () => send('d1', { sketch: drawing([[0, 10, 10, 900, 0]]) }), /could not be read/);
throws('too many strokes rejected', () => send('d1', { sketch: drawing(Array(601).fill([0, 1, 1])) }), /too detailed/);
const long = [0, 0, 0]; for (let i = 0; i < 12001; i++) long.push(i % 2 ? 0 : 0, 0);
throws('too many points rejected', () => send('d1', { sketch: drawing([long]) }), /too detailed/);
const wiggly = []; for (let k = 0; k < 400; k++) { const st = [1, 300, 200]; for (let i = 0; i < 14; i++) st.push(i % 2 ? -150 : 150, i % 2 ? 99 : -99); wiggly.push(st); }
throws('too many characters rejected', () => send('d1', { sketch: drawing(wiggly) }), /too detailed/);
throws('equations refused in a drawing activity', () => send('d1', { math: ['x=1'] }), /doesn't take equations/);
throws('text refused in a drawing activity', () => send('d1', { response_text_original: 'hi', sketch: drawing([line]) }), /doesn't take text/);
apiStartSession(tok, 'm1', 62, { submission_type: 'math' });
throws('drawing refused in a math activity', () => send('m1', { math: ['x=1'], sketch: drawing([line]) }), /doesn't take a drawing/);
apiStartSession(tok, 't1', 63, 'respond');
throws('drawing refused in a text activity', () => send('t1', { response_text_original: 'hi', sketch: drawing([line]) }), /doesn't take a drawing/);

// --- Math & drawing: either or both ---
tok = freshSheets();
apiStartSession(tok, 'b1', 60, { submission_type: 'math_sketch', peer_review: true, background: 'grid' });
eq('equations only', [send('b1', { math: ['x=1'] }, 'alice').ok, JSON.parse(lastRow().response_content)], [true, { math: ['x=1'] }]);
eq('drawing only', [send('b1', { sketch: drawing([line], 'grid') }, 'bob').ok, Object.keys(JSON.parse(lastRow().response_content))], [true, ['sketch']]);
eq('both', [send('b1', { math: ['y=2'], sketch: drawing([line], 'grid') }, 'cara').ok, lastRow().response_text_original], [true, '$$y=2$$\n[drawing: 1 line]']);
throws('neither', () => send('b1', { math: [' '] }), /equation or a drawing/);

// --- Reading back ---
const list = apiListResponsesByInstructor(tok, 'b1');
eq('dashboard list carries drawings', list.map(x => [x.math, x.sketch && x.sketch.s.length]), [[['x=1'], null], [[], 1], [['y=2'], 1]]);
const id3 = list[2].response_id;
eq('correcting equations keeps the drawing', (apiUpdateResponse(tok, id3, { math_edited: ['y=3'] }), JSON.parse(lastRow().response_content).sketch.s), [line]);
eq('peer review text includes the drawing', apiGetResponseText('b1', id3).sketch.s, [line]);
throws('drawing-only answers have no equations to correct', () => apiUpdateResponse(tok, list[1].response_id, { math_edited: ['x'] }), /no equations/);
apiStartPeerReview(tok, 'b1', 1, '');
const fb = 'Clear drawing and the working is easy to follow, nicely done.';
['alice', 'bob', 'cara'].forEach(w => apiAssignPeerTargets('b1', w).assigned.forEach(id => apiSubmitPeerFeedback('b1', id, w, fb)));
const mine = apiGetMyFeedback('b1', 'bob');
eq('feedback received includes own drawing', [mine.locked, mine.feedback.length > 0 && mine.feedback[0].response_sketch.s], [false, [line]]);
