// Balanced assignment and the "flag" profanity mode for peer reviews.

function classOf(n, k) {
  setSheets({
    Sessions: [['session_id', 'instructor_id', 'phase', 'is_open', 'is_active', 'active_until', 'peer_open', 'peer_opened_at', 'peer_required_reviews', 'peer_until'],
               ['s1', 'i1', 'review', 'TRUE', 'TRUE', H(1), 'TRUE', H(0), k, '']],
    Responses: [['response_id', 'session_id', 'reviewer_token', 'timestamp', 'response_text_original', 'response_text_edited', 'is_hidden'],
                ...Array.from({ length: n }, (_, i) => [i + 1, 's1', 'u' + (i + 1), H(-1), 'answer ' + (i + 1), '', 'FALSE'])],
    PeerAssignments: [['session_id', 'reviewer_token', 'response_id', 'assigned_at']],
    PeerFeedback: [['feedback_id', 'session_id', 'response_id', 'reviewer_token', 'feedback_text', 'timestamp', 'is_hidden', 'profanity_flag']],
    Settings: [['key', 'value']],
    ProfanityList: [['badword']],
  });
  for (let i = 1; i <= n; i++) apiAssignPeerTargets('s1', 'u' + i);
  const c = {}; for (let i = 1; i <= n; i++) c[i] = 0;
  sheetObjects('PeerAssignments').forEach(r => c[r.response_id]++);
  return Object.values(c);
}
for (const [n, k] of [[30, 1], [30, 2], [30, 3]]) {
  let allReviewed = 0, worst = 0;
  for (let t = 0; t < 100; t++) {
    const v = classOf(n, k);
    if (Math.min(...v) >= 1) allReviewed++;
    worst = Math.max(worst, Math.max(...v) - Math.min(...v));
  }
  eq(`${n} students x ${k}: every response reviewed (100 runs)`, allReviewed, 100);
  eq(`${n} students x ${k}: load spread <= 2`, worst <= 2, true);
}

const TEN = 'this is a perfectly reasonable piece of feedback with enough words';
classOf(8, 2);
sheetRows('Settings').push(['profanity_action', 'flag']);
const mine = apiAssignPeerTargets('s1', 'u1').assigned;
apiSubmitPeerFeedback('s1', mine[0], 'u1', TEN + ' badword');
apiSubmitPeerFeedback('s1', mine[1], 'u1', TEN);
const fb = sheetObjects('PeerFeedback');
eq('flag mode: text kept, row flagged', [fb[0].feedback_text.includes('badword'), fb[0].profanity_flag], [true, 'FLAGGED']);
eq('clean review: NONE', fb[1].profanity_flag, 'NONE');

// Small classes are where the "last student" edge case bites hardest
for (const n of [3, 5, 8]) {
  let allReviewed = 0;
  for (let t = 0; t < 100; t++) { if (Math.min(...classOf(n, 1)) >= 1) allReviewed++; }
  eq(`${n} students x 1: every response reviewed (100 runs)`, allReviewed, 100);
}
