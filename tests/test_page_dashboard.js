// @page dashboard
// The activity chosen at login drives what the dashboard shows.

setSheets({
  Instructors: [['instructor_id', 'password'], ['i1', 'pw1']],
  Sessions: [['session_id', 'instructor_id', 'phase', 'is_open', 'is_active', 'active_until', 'created_at', 'peer_open', 'peer_opened_at', 'peer_required_reviews']],
  Responses: [['response_id', 'session_id', 'reviewer_token', 'timestamp', 'response_text_original', 'response_text_edited', 'is_hidden']],
  PeerAssignments: [['session_id', 'reviewer_token', 'response_id', 'assigned_at']],
  PeerFeedback: [['feedback_id', 'session_id', 'response_id', 'reviewer_token', 'feedback_text', 'timestamp', 'is_hidden']],
  Settings: [['key', 'value']],
  ProfanityList: [['badword']],
});
// The login questions: what students submit (checkboxes), peer review and background
let chosen = { peerReview: 'false', sketchBackground: 'blank' };
document.querySelector = sel => {
  const m = /^input\[name="(\w+)"\]:checked$/.exec(sel);
  return m && chosen[m[1]] !== undefined ? { value: chosen[m[1]] } : null;
};
function tick(type) {   // type: parts joined by '_', e.g. 'text_math'
  const parts = String(type || '').split('_');
  el('partText').checked = parts.includes('text'); el('partMath').checked = parts.includes('math'); el('partSketch').checked = parts.includes('sketch');
}
function login(sessionId, preset, type, background) {
  chosen = { peerReview: preset === 'peer' ? 'true' : 'false', sketchBackground: background || 'blank' };
  tick(type || 'text');
  el('inst').value = 'i1'; el('instPw').value = 'pw1'; el('newSessionId').value = sessionId; el('sessionDuration').value = '45';
  handleLoginAndStart();
}

login('quiz1', 'respond');
eq('quick response: dashboard shown', el('dashView').style.display, 'block');
eq('quick response: label', el('activityLabel').textContent, 'Quick response');
eq('quick response: peer controls hidden', el('peerControls').style.display, 'none');
eq('writing duration from login (45 min)', Math.round((new Date(SESSION_STATE.active_until) - Date.now()) / 60000), 45);

login('essay1', 'peer');
eq('peer review: label', el('activityLabel').textContent, 'Peer review');
eq('peer review: controls shown', el('peerControls').style.display, '');

// Mid-review, logging in again with a different activity keeps the review and says so
el('peerK').value = '1';
openPeerReview();
login('essay1', 'respond');
eq('mid-review: settings kept and explained', el('activityLabel').textContent.startsWith('Peer review (kept:'), true);
eq('mid-review: controls still shown', el('peerControls').style.display, '');

// Math: label, equations on cards, and correcting them
login('maths1', 'respond', 'math');
eq('math: label', el('activityLabel').textContent, 'Quick response · math');
eq('math: peer controls hidden', el('peerControls').style.display, 'none');
__SERVER.apiSubmitResponse('maths1', { math: ['\\bar{x}=4.2', 's^2=1.1'], reviewer_token: 's1' });
__SERVER.apiSubmitResponse('maths1', { math: ['x=1'], reviewer_token: 's2' });
loadResponses();
eq('math: cards get equations', RESPONSES.map(r => [r.math, r.corrected]), [[['\\bar{x}=4.2', 's^2=1.1'], false], [['x=1'], false]]);
const slotOf = i => el('listView').children[i].querySelector('.mathSlot');
eq('math: equations shown on cards (source without KaTeX), no text box', [slotOf(0).innerHTML.includes('\\bar{x}=4.2'), el('listView').children[0].innerHTML.includes('contenteditable')], [true, false]);
eq('math: click to correct', [slotOf(0).className, typeof slotOf(0).onclick], ['mathSlot mathView', 'function']);

// Click: editor loads (MathLive), one field per line holding the equations
slotOf(0).onclick();
eq('editing: waits for the editor', slotOf(0).innerHTML.includes('Loading the equation editor'), true);
mathLiveLoaded(true);
const rid0 = RESPONSES[0].response_id;
let draft = MATH_EDITS[rid0];
eq('editing: one math-field per line', [draft.fields.map(f => f.tagName), draft.fields.map(f => f.value)], [['MATH-FIELD', 'MATH-FIELD'], ['\\bar{x}=4.2', 's^2=1.1']]);

// A refresh mid-edit keeps the change in progress
draft.fields[1].value = 's^2=1.21';
loadResponses();
eq('refresh keeps the edit in progress', MATH_EDITS[rid0].fields.map(f => f.value), ['\\bar{x}=4.2', 's^2=1.21']);

// Save: the correction replaces the equations and is marked
saveMathEdit(slotOf(0), RESPONSES[0], new FakeEl('status'));
eq('saved: card shows the correction, marked', [RESPONSES[0].math, RESPONSES[0].corrected, MATH_EDITS[rid0], slotOf(0).innerHTML.includes('Corrected')],
   [['\\bar{x}=4.2', 's^2=1.21'], true, undefined, true]);
loadResponses();
eq('saved: survives a refresh', [RESPONSES[0].math, RESPONSES[0].corrected], [['\\bar{x}=4.2', 's^2=1.21'], true]);

// Cancel discards; an empty correction isn't saved
slotOf(0).onclick();
MATH_EDITS[rid0].fields[0].value = 'oops';
const status = new FakeEl('status');
MATH_EDITS[rid0].fields.forEach(f => { f.value = ' '; });
saveMathEdit(slotOf(0), RESPONSES[0], status);
eq('empty correction not saved', [/at least one equation/.test(status.textContent), RESPONSES[0].math.length], [true, 2]);
delete MATH_EDITS[rid0]; renderMathSlot(slotOf(0), RESPONSES[0]);
eq('cancel: back to the saved correction', slotOf(0).className, 'mathSlot mathView');

// Revert to the student's answer
window.confirm = () => true; globalThis.confirm = () => true;
revertMathEdit(slotOf(0), RESPONSES[0], new FakeEl('status'));
eq('revert: student\'s answer again, not marked', [RESPONSES[0].math, RESPONSES[0].corrected], [['\\bar{x}=4.2', 's^2=1.1'], false]);

login('maths2', 'peer', 'math');
eq('math with peer review: label', el('activityLabel').textContent, 'Peer review · math');

tick('sketch'); updateLoginOptions();
chosen.submissionType = 'sketch'; updateLoginOptions();
eq('drawing chosen: background question shown', el('backgroundPicker').style.display, '');
tick('math'); updateLoginOptions();
eq('math chosen: background question hidden', el('backgroundPicker').style.display, 'none');
login('draw1', 'respond', 'sketch', 'axes');
eq('drawing: label and background', [el('activityLabel').textContent, SESSION_STATE.settings.background], ['Quick response · drawing', 'axes']);
__SERVER.apiSubmitResponse('draw1', { sketch: { v: 1, bg: 'axes', s: [[0, 10, 10, 50, 50], [2, 300, 200]] }, reviewer_token: 's1' });
loadResponses();
const card = (el('listView').children.find(c => c.innerHTML.includes('sketchBlock')) || { innerHTML: '' }).innerHTML;
eq('drawing card: drawing with both strokes, no text box', [(card.match(/<path d="M/g) || []).length >= 2, card.includes('sketchSvg'), card.includes('contenteditable')], [true, true, false]);
const key = /openSketchModal\('(\w+)'\)/.exec(card)[1];
openSketchModal(key);
eq('click to enlarge: shown large', [el('sketchModal').style.display, el('sketchModal').innerHTML.includes('sketchSvg')], ['flex', true]);
closeSketchModal();
eq('close', el('sketchModal').style.display, 'none');
login('both1', 'respond', 'math_sketch', 'grid');
__SERVER.apiSubmitResponse('both1', { math: ['x=1'], sketch: { v: 1, bg: 'grid', s: [[1, 5, 5, 1, 1]] }, reviewer_token: 's1' });
loadResponses();
const both = RESPONSES.find(r => r.math.length && r.sketch);
eq('math & drawing card: equations to correct, and the drawing', [!!both, el('listView').children.some(c => c.innerHTML.includes('mathSlot') && c.innerHTML.includes('sketchBlock'))], [true, true]);

// Combinations: background question follows the Drawing box; nothing ticked is refused
tick('text_sketch'); updateLoginOptions();
eq('text & drawing: background question shown', el('backgroundPicker').style.display, '');
login('combo1', 'respond', 'text_math_sketch');
eq('all three: label', el('activityLabel').textContent, 'Quick response · text, math & drawing');
el('startMsg').textContent = '';
tick(''); handleLoginAndStart();
eq('nothing ticked: asked to tick one', el('startMsg').textContent, 'Tick at least one thing for students to submit.');

// Figure: the address box appears for Figure, is previewed, and is needed to start
tick('sketch'); chosen.sketchBackground = 'image'; updateLoginOptions();
eq('figure chosen: address box shown', el('figureRow').style.display, '');
chosen.sketchBackground = 'grid'; updateLoginOptions();
eq('grid chosen: address box hidden', el('figureRow').style.display, 'none');
el('sketchImageUrl').value = 'https://drive.google.com/file/d/ABC123/view'; chosen.sketchBackground = 'image'; updateLoginOptions();
eq('Drive link previewed as a direct image', el('figurePreview').src, 'https://drive.google.com/thumbnail?id=ABC123&sz=w1600');
el('sketchImageUrl').value = 'http://insecure.example/a.png'; previewFigure();
eq('http: explained, no preview', [el('figureMsg').textContent, el('figurePreview').style.display], ['Use a web link starting with https://.', 'none']);
el('startMsg').textContent = '';
login('fig1', 'respond', 'sketch', 'image');
eq('bad address: login stops with a reason', el('startMsg').textContent, 'The figure address must be a web link starting with https://.');
el('sketchImageUrl').value = 'https://example.org/f.png';
login('fig1', 'respond', 'sketch', 'image');
eq('good address: session uses the figure', [SESSION_STATE.settings.background, SESSION_STATE.settings.background_url], ['image', 'https://example.org/f.png']);

// Uploaded figure (pasted screenshot) at login: saved to Drive, then the session uses it
const SHOT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
setLoginFigure(SHOT);
eq('pasted image previewed', [el('figurePreview').src, el('loginFigureClear').style.display], [SHOT, '']);
el('sketchImageUrl').value = 'https://example.org/ignored.png';
login('shot1', 'respond', 'text_sketch', 'image');
const shotFig = SESSION_STATE.settings.background_figure;
eq('session uses the uploaded figure, not the link', [SESSION_STATE.settings.background, !!shotFig, SESSION_STATE.settings.background_url], ['image', true, '']);
eq('dashboard already has the image (no refetch needed)', SKETCH_FIGURES[shotFig].data, SHOT);
eq('figure button shown for drawing activities', el('figureBtn').style.display, '');
clearLoginFigure();
eq('removing the pasted image', [LOGIN_FIGURE, el('loginFigureClear').style.display], ['', 'none']);

// Live: paste a new screenshot into the panel and show it to students
toggleFigurePanel(true);
eq('panel shows the current figure', el('figureCurrent').innerHTML.includes('data-fig="' + shotFig + '"'), true);
setLiveFigure({ data: SHOT });
eq('ready to show', el('liveFigureShow').disabled, false);
showLiveFigure();
const liveFig = SESSION_STATE.settings.background_figure;
eq('new figure live for students', [!!liveFig, liveFig !== shotFig, __SERVER.apiGetSessionState(AUTH_TOKEN, 'shot1').settings.background_figure === liveFig], [true, true, true]);
eq('confirmation shown', el('liveFigureMsg').textContent.startsWith('Shown to students'), true);
clearSessionFigure();
eq('blank page', SESSION_STATE.settings.background, 'blank');
el('liveFigureUrl').value = 'https://example.org/live.png'; liveFigureUrlChanged();
eq('link in the panel previews', el('liveFigurePreview').src, 'https://example.org/live.png');
login('txtonly', 'respond', 'text');
eq('no figure button without drawing', el('figureBtn').style.display, 'none');
