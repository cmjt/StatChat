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
let tok = apiInstructorLogin('i1', 'pw1').token;
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
throws('figure without an address refused', () => start('f2', ''), /Add a figure/);
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

// --- Uploaded figures (screenshots), stored in Drive ---
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const up = apiUploadFigure(tok, PNG);
eq('upload returns a figure id', [up.ok, isFigureId_(up.figure_id)], [true, true]);
const file = DriveApp.getFileById(up.figure_id);
const folder = file.getParents().next();
eq('saved in StatChat figures/<instructor>', [folder.getName(), folder.getParents().next().getName()], ['i1', 'StatChat figures']);
eq('second upload reuses the folders', DriveApp.getFileById(apiUploadFigure(tok, PNG).figure_id).getParents().next().getId(), folder.getId());
throws('upload needs a login', () => apiUploadFigure('bogus', PNG), /expired/);
throws('only images accepted', () => apiUploadFigure(tok, 'data:text/html;base64,PGI+aGk8L2I+'), /PNG, JPEG or WebP/);
throws('too large refused', () => apiUploadFigure(tok, 'data:image/png;base64,' + 'A'.repeat(2100000)), /too large/);

__cache.clear();
eq('students fetch it from Drive (cache empty)', apiGetFigure(up.figure_id), { ok: true, figure_id: up.figure_id, data: PNG });
eq('then from the cache', cachedFigure_(up.figure_id), PNG);
const stranger = DriveApp.createFolder('Private').createFile(Utilities.newBlob([1, 2, 3], 'image/png', 'secret.png'));
eq('files outside StatChat figures are never served', apiGetFigure(stranger.getId()).ok, false);
eq('nonsense id refused', apiGetFigure('../../etc').ok, false);

// Start a session on an uploaded figure; drawings record its id
tok = apiInstructorLogin('i1', 'pw1').token;   // the cache clear above ended the login
r = apiStartSession(tok, 'u1', 60, { submission_type: 'text_sketch', background: 'image', background_figure: up.figure_id });
eq('session on an uploaded figure', [r.settings.background, r.settings.background_figure, r.settings.background_url], ['image', up.figure_id, '']);
eq('students see the figure id', apiGetStudentView('i1').settings.background_figure, up.figure_id);
send('u1', { v: 1, bg: 'image', s: [line] });
eq('drawing records the uploaded figure', [content().sketch.bg, content().sketch.fig, content().sketch.img], ['image', up.figure_id, undefined]);

// Another instructor can't use (or see) i1's figures
sheetRows('Instructors').push(['i2', 'pw2']);
const tok2 = apiInstructorLogin('i2', 'pw2').token;
throws("another instructor's figure refused at start", () => apiStartSession(tok2, 'z1', 60, { submission_type: 'sketch', background: 'image', background_figure: up.figure_id }), /Figure not found/);
apiStartSession(tok2, 'z1', 60, { submission_type: 'sketch' });
throws("another instructor's figure refused live", () => apiSetSessionFigure(tok2, 'z1', { figure_id: up.figure_id }), /Figure not found/);
throws("can't change another instructor's session", () => apiSetSessionFigure(tok2, 'u1', null), /not owned/);

// Changing the figure during the session
const up2 = apiUploadFigure(tok, PNG);
r = apiSetSessionFigure(tok, 'u1', { figure_id: up2.figure_id });
eq('live change to a new screenshot', [r.settings.background, r.settings.background_figure], ['image', up2.figure_id]);
eq('students pick it up at once (cache cleared)', apiGetStudentView('i1').settings.background_figure, up2.figure_id);
eq('earlier drawing keeps its figure', apiListResponsesByInstructor(tok, 'u1')[0].sketch.fig, up.figure_id);
r = apiSetSessionFigure(tok, 'u1', { url: FIG });
eq('live change to a link', [r.settings.background, r.settings.background_url, r.settings.background_figure], ['image', FIG, '']);
r = apiSetSessionFigure(tok, 'u1', null);
eq('back to a blank page', [r.settings.background, r.settings.background_url, r.settings.background_figure], ['blank', '', '']);
throws('bad link refused live', () => apiSetSessionFigure(tok, 'u1', { url: 'http://x.org/a.png' }), /https/);
apiStartSession(tok, 't9', 60, { submission_type: 'text' });
throws('no figures for activities without drawing', () => apiSetSessionFigure(tok, 't9', { figure_id: up.figure_id }), /doesn't include drawing/);
