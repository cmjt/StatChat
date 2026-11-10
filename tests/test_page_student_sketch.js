// @page student
// Drawing activities on the student page: the pad, its tools, and submitting. Also the shared
// drawing functions in sketch.html (encoding, simplifying, SVG).

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
const shown = id => el(id).style.display === 'block';
const stored = () => sheetObjects('Responses').map(r => JSON.parse(r.response_content || '{}'));
// Draw a stroke through canvas points, as the pointer handlers would
function draw(points) { sketchStart(points[0]); points.slice(1).forEach(sketchMove); sketchEnd(); }

// --- Shared drawing functions ---
const st = { c: 1, pts: [[10, 20], [13, 24], [20, 20]] };
eq('encode: colour, first point, then steps', encodeStroke(st), [1, 10, 20, 3, 4, 7, -4]);
eq('decode reverses encode', decodeStroke(encodeStroke(st)), st);
eq('simplify drops points on a straight run', simplifyPoints([[0, 0], [1, 0], [2, 0], [3, 0], [3, 5]], 1), [[0, 0], [3, 0], [3, 5]]);
eq('finishStroke clamps to the canvas, rounds, drops repeats', finishStroke(0, [[-5, 10.4], [-3, 10.2], [700, 450]]).pts, [[0, 10], [600, 400]]);
eq('a single point is a dot', strokePathD([[5, 5]]), 'M5 5l0.01 0');
const svg = sketchSVG({ v: 1, bg: 'axes', s: [[0, 1, 1, 2, 2], [2, 9, 9]] });
eq('SVG: one path per stroke plus background, colours from the palette', [(svg.match(/<path /g) || []).length, svg.includes('#dc2626'), svg.startsWith('<svg')], [5, true, true]);
eq('SVG: unknown background drawn blank', sketchSVG({ bg: '"><script>', s: [] }).includes('script'), false);
eq('SVG: hostile numbers become 0', sketchSVG({ s: [['x', '"/><script>', 1]] }).includes('script'), false);
eq('sketchBlockHTML: nothing for no drawing', sketchBlockHTML({ s: [] }, 'k'), '');

// --- Drawing activity ---
__SERVER.apiStartSession(tok, 'draw1', 60, { submission_type: 'sketch', peer_review: false, background: 'grid' });
init();
eq('drawing activity: pad shown, no text box or equations', [shown('sketchSection'), el('textSection').style.display, shown('mathSection')], [true, 'none', false]);
eq('label', el('activityLabel').textContent, 'Quick response · drawing');
eq('pad uses the chosen background', [SKETCH_BG, SKETCH_PAD.bg.innerHTML.includes('#e5e7eb')], ['grid', true]);
eq('MathLive not loaded for drawing only', document.head.children.length, 0);
eq('pad enabled while writing is open', SKETCH_ENABLED, true);

// Draw, erase, undo, clear
draw([[100, 100], [150, 120], [200, 100]]);
setSketchTool('pen', 2);
draw([[300, 300], [320, 320]]);
eq('two strokes drawn, in their colours', SKETCH_STROKES.map(s => s.c), [0, 2]);
eq('strokes shown on the pad', (SKETCH_PAD.strokes.innerHTML.match(/<path /g) || []).length, 2);
setSketchTool('eraser');
draw([[310, 310], [311, 311]]);
eq('eraser removes the line it touches', SKETCH_STROKES.map(s => s.c), [0]);
undoSketch();
eq('undo brings the erased line back', SKETCH_STROKES.map(s => s.c), [0, 2]);
clearSketch();
eq('clear empties the pad', SKETCH_STROKES.length, 0);
undoSketch();
eq('undo after clear restores the drawing', SKETCH_STROKES.length, 2);
undoSketch();
eq('undo removes the last line drawn', SKETCH_STROKES.map(s => s.c), [0]);

// Submit
setSketchTool('pen', 1);
draw([[10, 10], [10, 11], [10, 12], [10, 300]]);
submitResponse();
const saved = stored()[0].sketch;
eq('submitted the drawing with its background', [saved.bg, saved.s.length], ['grid', 2]);
eq('straight line stored as just its ends', saved.s[1], [1, 10, 10, 0, 290]);
eq('pad cleared after submit, undo starts afresh', [SKETCH_STROKES.length, SKETCH_HISTORY.length, el('status').textContent], [0, 0, 'Submitted. Thank you!']);
submitResponse();
eq('nothing drawn: asked to draw', [el('status').textContent, stored().length], ['Please draw something.', 1]);

// Size limit: warned while drawing, blocked at submit
for (let k = 0; k < 400; k++) { const pts = []; for (let i = 0; i < 15; i++) pts.push([i % 2 ? 50 : 550, 20 + i * 25]); draw(pts); }
eq('too detailed: warning shown', /too detailed/.test(el('sketchSize').textContent), true);
submitResponse();
eq('too detailed: not sent', [/too detailed/.test(el('status').textContent), stored().length], [true, 1]);
clearSketch();

// Background changes follow the instructor; strokes are kept
draw([[5, 5], [50, 50]]);
__SERVER.apiStartSession(tok, 'draw1', 60, { submission_type: 'sketch', peer_review: false, background: 'axes' });
pollView();
eq('background updated, drawing kept', [SKETCH_BG, SKETCH_STROKES.length], ['axes', 1]);

// Math & drawing: equation lines and the pad together
__SERVER.apiStartSession(tok, 'both1', 61, { submission_type: 'math_sketch', peer_review: false });
pollView();
eq('math & drawing: both shown', [shown('mathSection'), shown('sketchSection'), el('textSection').style.display], [true, true, 'none']);
mathLiveLoaded(false);   // plain LaTeX boxes
MATH_FIELDS[0].field.value = 'x = 2';
submitResponse();
eq('equations and drawing sent together', stored()[1], { math: ['x = 2'], sketch: { v: 1, bg: 'blank', s: [[1, 5, 5, 45, 45]] } });   // blue pen still selected
eq('both cleared', [MATH_FIELDS[0].field.value, SKETCH_STROKES.length], ['', 0]);
MATH_FIELDS[0].field.value = 'y = 3';
submitResponse();
eq('equations alone are fine too', stored()[2], { math: ['y = 3'] });

// Session stopped: pad hidden and disabled
__SERVER.apiStopSession(tok, 'both1');
__SERVER.apiStopSession(tok, 'draw1');
pollView();
eq('stopped: pad hidden and disabled', [shown('sketchSection'), SKETCH_ENABLED], [false, false]);

// Text, math & drawing: all three shown; any of them can be sent, together or alone
__SERVER.apiStartSession(tok, 'all1', 63, { submission_type: 'text_math_sketch', peer_review: false });
pollView();
eq('all three shown', [el('textSection').style.display, shown('mathSection'), shown('sketchSection')], ['block', true, true]);
submitResponse();
eq('nothing entered: says what can be added', el('status').textContent, 'Please add text, an equation or a drawing.');
el('responseText').value = 'my answer';
MATH_FIELDS[0].field.value = 'z = 1';
draw([[5, 5], [50, 50]]);
submitResponse();
eq('all three sent together', stored().slice(-1)[0], { text: 'my answer', math: ['z = 1'], sketch: { v: 1, bg: 'blank', s: [[1, 5, 5, 45, 45]] } });
eq('all three cleared', [el('responseText').value, MATH_FIELDS[0].field.value, SKETCH_STROKES.length], ['', '', 0]);
el('responseText').value = 'just words';
submitResponse();
eq('text alone is fine', sheetObjects('Responses').slice(-1)[0].response_text_original, 'just words');

// Drawing on a figure: the pad shows it under the strokes; the server adds its address
const FIG = 'https://example.org/figs/scatter.png';
__SERVER.apiStartSession(tok, 'fig1', 64, { submission_type: 'sketch', peer_review: false, background: 'image', background_url: FIG });
pollView();
eq('figure on the pad', [SKETCH_BG, SKETCH_PAD.bg.innerHTML.includes('<image href="' + FIG + '"')], ['image', true]);
draw([[100, 100], [140, 120]]);
submitResponse();
eq('saved with the figure', [stored().slice(-1)[0].sketch.bg, stored().slice(-1)[0].sketch.img], ['image', FIG]);
eq('card/enlarged SVG shows the figure under the strokes', /<image href="[^"]+scatter\.png"[^>]*>.*<path d="M100/.test(sketchSVG(stored().slice(-1)[0].sketch)), true);
__SERVER.apiStartSession(tok, 'fig1', 64, { submission_type: 'sketch', peer_review: false, background: 'image', background_url: 'https://example.org/figs/other.png' });
pollView();
eq('new figure picked up without a reload', SKETCH_PAD.bg.innerHTML.includes('other.png'), true);
eq('SVG: unsafe figure address not drawn', sketchSVG({ bg: 'image', img: 'javascript:alert(1)', s: [] }).includes('<image'), false);
eq('SVG: & in an address is escaped', sketchSVG({ bg: 'image', img: 'https://e.org/a.png?x=1&y=2', s: [] }).includes('x=1&amp;y=2'), true);
