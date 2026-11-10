// Any combination of text, math and drawing: settings, labels, and what students may submit.

setSheets({
  Instructors: [['instructor_id', 'password'], ['i1', 'pw1']],
  Sessions: [['session_id', 'instructor_id', 'phase', 'is_open', 'is_active', 'active_until', 'created_at', 'peer_open', 'peer_opened_at', 'peer_required_reviews']],
  Responses: [['response_id', 'session_id', 'reviewer_token', 'timestamp', 'response_text_original', 'response_text_edited', 'is_hidden', 'profanity_flag']],
  PeerAssignments: [['session_id', 'reviewer_token', 'response_id', 'assigned_at']],
  PeerFeedback: [['feedback_id', 'session_id', 'response_id', 'reviewer_token', 'feedback_text', 'timestamp', 'is_hidden']],
  Settings: [['key', 'value']],
  ProfanityList: [['badword']],
});
const tok = apiInstructorLogin('i1', 'pw1').token;
const start = (sid, type, peer) => apiStartSession(tok, sid, 60, { submission_type: type, peer_review: !!peer });
const send = (sid, payload) => apiSubmitResponse(sid, Object.assign({ reviewer_token: 'stu' }, payload));
const lastRow = () => sheetObjects('Responses').slice(-1)[0];
const drawing = { v: 1, bg: 'blank', s: [[0, 10, 10, 5, 5]] };

// --- Types and labels ---
eq('stored in a fixed order', ['math_text', 'sketch_text', 'sketch_math_text', 'text,math'].map(normalizeSubmissionType_),
   ['text_math', 'text_sketch', 'text_math_sketch', 'text_math']);
eq('an array of parts works too', normalizeSubmissionType_(['sketch', 'text']), 'text_sketch');
eq('old types unchanged', ['text', 'math', 'sketch', 'math_sketch'].map(normalizeSubmissionType_), ['text', 'math', 'sketch', 'math_sketch']);
eq('unknown part is invalid', normalizeSubmissionType_('text_karaoke'), '');
eq('labels', [['text', false], ['text_math', false], ['text_sketch', true], ['text_math_sketch', false]].map(([t, p]) => activityLabel_(t, p)),
   ['Quick response', 'Quick response · text & math', 'Peer review · text & drawing', 'Quick response · text, math & drawing']);
let r = start('all', 'sketch_math_text');
eq('session stores the ordered type', [r.settings.submission_type, r.settings.label], ['text_math_sketch', 'Quick response · text, math & drawing']);
eq('student view carries it', apiGetStudentView('i1').settings.submission_type, 'text_math_sketch');
throws('unknown part rejected at login', () => start('x', 'text_karaoke'), /Unknown submission type/);
eq('legacy math & drawing session still reads the same', getSessionSettings_({ submission_type: 'math_sketch', peer_review: 'FALSE' }).label, 'Quick response · math & drawing');

// --- Submitting: any of the chosen parts, at least one ---
start('tm', 'text_math');
eq('text & math: text alone', send('tm', { response_text_original: 'about four' }).ok, true);
eq('text alone stored like a text answer', [lastRow().response_text_original, lastRow().response_content || ''], ['about four', '']);
eq('text & math: equations alone', send('tm', { math: ['x = 4'] }).ok, true);
eq('text & math: both', send('tm', { response_text_original: 'the mean is', math: ['\\bar{x} = 4'] }).ok, true);
eq('both stored together', [JSON.parse(lastRow().response_content), lastRow().response_text_original],
   [{ text: 'the mean is', math: ['\\bar{x} = 4'] }, 'the mean is\n$$\\bar{x} = 4$$']);
throws('text & math: nothing', () => send('tm', {}), /Please add text or an equation/);
throws('text & math: drawing refused', () => send('tm', { response_text_original: 'hi there', sketch: drawing }), /doesn't take a drawing/);

start('all2', 'text_math_sketch');
eq('all three together', send('all2', { response_text_original: 'see sketch', math: ['y = 2x'], sketch: drawing }).ok, true);
eq('all three stored', Object.keys(JSON.parse(lastRow().response_content)), ['text', 'math', 'sketch']);
eq('drawing alone', send('all2', { sketch: drawing }).ok, true);
throws('all three: nothing', () => send('all2', { response_text_original: '  ', math: [''] }), /Please add text, an equation or a drawing/);

// --- Text rules still apply to the text part ---
start('ts', 'text_sketch');
send('ts', { response_text_original: 'a badword here', sketch: drawing });
const masked = lastRow().response_text_edited;
eq('text part masked, drawing kept', [lastRow().profanity_flag, /^a .+ here$/.test(masked) && !masked.includes('badword'), !!JSON.parse(lastRow().response_content).sketch], ['MASKED', true, true]);

// --- Reading back: dashboard, peer review ---
const list = apiListResponsesByInstructor(tok, 'ts');
eq('dashboard shows the masked text and the drawing', [list[0].text, !!list[0].sketch], [masked, true]);
const tmList = apiListResponsesByInstructor(tok, 'tm');
eq('dashboard: text and equations together', [tmList[2].text, tmList[2].math], ['the mean is', ['\\bar{x} = 4']]);
const pr = apiGetResponseText('tm', tmList[2].response_id);
eq('peer review: text and equations together', [pr.text, pr.math], ['the mean is', ['\\bar{x} = 4']]);
apiUpdateResponse(tok, tmList[2].response_id, { math_edited: ['\\bar{x} = 4.0'] });
eq('correcting equations keeps the text', apiGetResponseText('tm', tmList[2].response_id).text, 'the mean is');
