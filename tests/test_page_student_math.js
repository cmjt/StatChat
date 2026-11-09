// @page student
// Text & math on the student page: the equations section, the editor, and submitting.

setSheets({
  Instructors: [['instructor_id', 'password'], ['i1', 'pw1']],
  Sessions: [['session_id', 'instructor_id', 'phase', 'is_open', 'is_active', 'active_until', 'created_at', 'peer_open', 'peer_opened_at', 'peer_required_reviews']],
  Responses: [['response_id', 'session_id', 'reviewer_token', 'timestamp', 'response_text_original', 'response_text_edited', 'is_hidden']],
  PeerAssignments: [['session_id', 'reviewer_token', 'response_id', 'assigned_at']],
  PeerFeedback: [['feedback_id', 'session_id', 'response_id', 'reviewer_token', 'feedback_text', 'timestamp', 'is_hidden']],
  Settings: [['key', 'value']],
  ProfanityList: [['badword']],
});
const tok = __SERVER.apiInstructorLogin('i1', 'pw1').token;
const shown = () => el('mathSection').style.display === 'block';
const stored = () => sheetObjects('Responses').map(r => r.response_content ? JSON.parse(r.response_content) : r.response_text_original);

// Text activity: text box, no equation lines, MathLive not downloaded
// Later sessions get longer durations: the student sees the live session that ends last
__SERVER.apiStartSession(tok, 'txt', 60, { submission_type: 'text', peer_review: false });
init();
eq('text activity: text box, no equation lines', [el('textSection').style.display, shown()], ['block', false]);
eq('text activity: MathLive not loaded', document.head.children.length, 0);

// Switch to Math: the text box is replaced by equation lines, and MathLive starts loading
el('responseText').value = 'half-typed text';
__SERVER.apiStartSession(tok, 'maths', 61, { submission_type: 'math', peer_review: false });
pollView();
eq('math activity: equation lines instead of text box', [shown(), el('textSection').style.display, el('activityLabel').textContent], [true, 'none', 'Quick response · math']);
const script = document.head.children[0];
eq('MathLive script requested', [script && script.tagName, /mathlive@[\d.]+\/dist\/mathlive\.min\.js$/.test(script && script.src)], ['SCRIPT', true]);
eq('while loading: help text, no lines yet', [el('mathHelp').textContent, MATH_FIELDS.length, el('addMathBtn').disabled], ['Loading the equation editor…', 0, true]);

// MathLive loads: one math-field line, keyboard kept inside the page
mathLiveLoaded(true);
eq('loaded: one math-field line', MATH_FIELDS.map(e => e.field.tagName), ['MATH-FIELD']);
eq('keyboard policy sandboxed (Apps Script iframe)', MATH_FIELDS[0].field.attrs['math-virtual-keyboard-policy'], 'sandboxed');
eq('lines enabled while writing is open', [MATH_FIELDS[0].field.disabled, el('addMathBtn').disabled], [false, false]);
mathLiveLoaded(false);
eq('a late timeout does not swap the editor', [MATHLIVE_STATE, MATH_EDITOR], ['ready', 'mathlive']);

// Two lines, then submit: equations only (the hidden text box is not sent)
addMathLine();
MATH_FIELDS[0].field.value = '\\bar{x} = 4.2';
MATH_FIELDS[1].field.value = 's = 1.3';
submitResponse();
eq('submitted equations only', stored(), [{ math: ['\\bar{x} = 4.2', 's = 1.3'] }]);
eq('cleared after submit: one empty line', [MATH_FIELDS.length, MATH_FIELDS[0].field.value], [1, '']);
eq('status says submitted', el('status').textContent, 'Submitted. Thank you!');

// Removing a line; nothing typed
MATH_FIELDS[0].field.value = 'x = 1';
addMathLine(); MATH_FIELDS[1].field.value = 'y = 2';
removeMathLine(MATH_FIELDS[1]);
submitResponse();
eq('removed line not sent', stored()[1], { math: ['x = 1'] });
removeMathLine(MATH_FIELDS[0]);
eq('removing the last line leaves an empty one', MATH_FIELDS.length, 1);
submitResponse();
eq('nothing typed: asked for an equation', [el('status').textContent, stored().length], ['Please add an equation.', 2]);

// Too many lines is capped in the page
for (let i = 0; i < 12; i++) addMathLine();
eq('at most 10 lines', MATH_FIELDS.length, 10);

// A server error keeps the student's work (no fall back to the text-only API)
MATH_FIELDS[0].field.value = 'z'.repeat(1001);
submitResponse();
eq('server error shown, work kept, nothing stored', [/too long/.test(el('status').textContent), MATH_FIELDS[0].field.value.length, stored().length], [true, 1001, 2]);

// Stopping the session ends the activity for students: section hidden, lines disabled
__SERVER.apiStopSession(tok, 'maths');
pollView();
eq('session stopped: section hidden, lines disabled', [shown(), MATH_FIELDS[0].field.disabled, el('addMathBtn').disabled], [false, true, true]);
__SERVER.apiStartSession(tok, 'maths', 62, { submission_type: 'text', peer_review: false });
pollView();
eq('back to text: text box back with its draft, equations kept', [el('textSection').style.display, el('responseText').value, shown(), MATH_FIELDS[0].field.value.length], ['block', 'half-typed text', false, 1001]);
