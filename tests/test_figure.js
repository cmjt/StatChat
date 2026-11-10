// Drawing on a figure: the instructor gives an image address; students annotate on it.

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
const FIG = 'https://example.org/figs/histogram.png';
const start = (sid, url, type) => apiStartSession(tok, sid, 60, { submission_type: type || 'sketch', background: 'image', background_url: url });
const send = (sid, sketch) => apiSubmitResponse(sid, { sketch, reviewer_token: 'stu' });
const content = () => JSON.parse(sheetObjects('Responses').slice(-1)[0].response_content);
const line = [0, 10, 10, 5, 5];

// --- Addresses ---
eq('plain https kept', normalizeImageUrl_(FIG), FIG);
eq('Drive file link converted', normalizeImageUrl_('https://drive.google.com/file/d/1AbC_d-9/view?usp=sharing'), 'https://drive.google.com/thumbnail?id=1AbC_d-9&sz=w1600');
eq('Drive open?id= link converted', normalizeImageUrl_('https://drive.google.com/open?id=XyZ'), 'https://drive.google.com/thumbnail?id=XyZ&sz=w1600');
eq('http refused', normalizeImageUrl_('http://example.org/a.png'), '');
eq('javascript: refused', normalizeImageUrl_('javascript:alert(1)'), '');
eq('quotes refused', normalizeImageUrl_('https://example.org/a.png"onload="x'), '');
eq('too long refused', normalizeImageUrl_('https://e.org/' + 'a'.repeat(2000)), '');

// --- Settings ---
let r = start('f1', FIG);
eq('figure background stored', [r.settings.background, r.settings.background_url], ['image', FIG]);
eq('column added', sheetRows('Sessions')[0].includes('sketch_image_url'), true);
eq('student view carries the address', apiGetStudentView('i1').settings.background_url, FIG);
throws('figure without an address refused', () => start('f2', ''), /Enter the address/);
throws('figure with a bad address refused', () => start('f2', 'ftp://x/y.png'), /https/);
r = apiStartSession(tok, 'f3', 60, { submission_type: 'sketch', background: 'grid', background_url: FIG });
eq('address ignored for other backgrounds', [r.settings.background, r.settings.background_url], ['grid', '']);
eq('stored figure with no usable address falls back to blank', getSessionSettings_({ sketch_background: 'image', sketch_image_url: 'nope' }).background, 'blank');

// --- Drawings get the session's figure, never the student's ---
send('f1', { v: 1, bg: 'image', img: 'https://evil.example/x.png', s: [line] });
eq('drawing stored with the session figure', [content().sketch.bg, content().sketch.img], ['image', FIG]);
send('f3', { v: 1, bg: 'image', img: FIG, s: [line] });
eq('figure claimed in a non-figure session: blank, no address', [content().sketch.bg, content().sketch.img], ['blank', undefined]);
start('f1', 'https://example.org/figs/v2.png');
eq('earlier drawings keep the figure they were made on', apiListResponsesByInstructor(tok, 'f1')[0].sketch.img, FIG);

// --- Combined with other parts ---
start('f4', FIG, 'text_sketch');
apiSubmitResponse('f4', { response_text_original: 'peak here', sketch: { v: 1, bg: 'image', s: [line] }, reviewer_token: 's2' });
eq('text and annotated figure together', [content().text, content().sketch.img], ['peak here', FIG]);
