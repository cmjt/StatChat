# StatChat

A Google Apps Script web app for in-class responses. Students submit short
anonymous answers that the instructor can view, tag and display on a board,
then (optionally) review each other's answers.

- Student page: `<web app URL>?page=student&inst=<instructor_id>`
- Instructor dashboard: `<web app URL>?page=dashboard`

## Session lifecycle

Writing and peer review have separate time limits. Writing ends with the
session. Peer review can carry on after the session until its own deadline.

1. **Open**: the instructor logs in on the dashboard with a session ID. This
   creates the session (or reopens an existing one) with writing open for
   60 minutes. Students can only submit responses while writing is open.
   - If the session is still active, or has peer review open (e.g. the
     instructor is back the next day to read reviews), its current phase is kept.
   - Otherwise a reused session ID is reset to **writing**.
   - **+30 min** extends writing, or reopens it if it was stopped or has expired.
2. **Peer review**: *Peer review* switches the session to the **review** phase
   (`peer_open = TRUE`). Writing is disabled and each student who submitted is
   assigned *Reviews per student* peer responses. Opening peer review closes
   any other peer review the same instructor still has open.
   - **Reviews close** (optional) sets a deadline (`peer_until`). Students can
     submit reviews until then, even after the session has ended. Leave it blank
     for no deadline. Changing it while peer review is open saves immediately.
   - **Close reviews** stops accepting reviews now.
   - After the deadline, the review is read-only. Students who completed all
     their assigned reviews can still read the feedback they received, and the
     dashboard still shows every review on each card.
3. **Back to writing**: ends peer review entirely (`peer_open = FALSE`) and
   reopens writing. Students can no longer see that session's reviews.
4. **Stop session**: closes writing now. Peer review, if open, continues until
   its deadline.

Peer review rules, all enforced on the server:

- Each student is assigned *Reviews per student* (default 1) responses from
  other students. They are never assigned their own, and never one the
  instructor has hidden.
- A student can only review responses assigned to them, once each. Reviews
  need at least 10 words.
- If the instructor hides a response after it was assigned, it stops counting
  towards the student's required reviews. While reviews are open, a
  replacement is assigned.
- Received feedback is only released once a student has reviewed all their
  assigned responses. Hidden reviews and hidden responses are never shown.

What students see at the instructor's link:

1. The instructor's session with writing open, in its current phase; otherwise
2. the instructor's most recently opened peer review, open or read-only;
   otherwise
3. "No active session".

The student page checks the session state once, when it loads. Students need to
reload the page to see a phase change.

The dashboard's **Show last N mins** filter applies to response cards, not to
reviews. When looking at a session after class, set it to `0` to show every
card.

## Instructor authentication

- Logging in on the dashboard returns a random token, stored server-side in
  `CacheService`. Every instructor action (starting sessions, peer review,
  listing/editing/hiding responses, rating reviews) must present that token. The
  instructor ID is taken from the token, so knowing an instructor's ID (which is
  in every student link) isn't enough to act as them.
- Tokens last 6 hours from the last dashboard action. When a token expires,
  reload the dashboard and log in again.
- After 5 failed logins for an instructor ID, logins for that ID are refused for
  15 minutes.
- **Hashing passwords:** passwords can be plaintext or salted SHA-256 hashes
  (`sha256$<salt>$<hash>`). To convert existing plaintext passwords, open the
  Apps Script editor, select `hashInstructorPasswords` in the function dropdown
  and click **Run**. It's safe to re-run. To add an instructor later, type their
  password in plaintext and run it again.
- Any top-level function in `Code.gs` whose name doesn't end in `_` can be
  called from the browser via `google.script.run`. Keep internal helpers named
  with a trailing `_`, and make every instructor-only function start with
  `requireInstructor_(token)`.

## Required Google Sheets

All sheets need a header row in row 1 (except `ProfanityList`), and column
names must match exactly. Column order doesn't matter, and extra columns are
ignored.

### Sessions
Stores session state and peer-review configuration.

Required columns:

- session_id
- instructor_id
- is_open
- is_active
- active_until

Recommended columns (features that use them are skipped if they're missing):

- phase — `writing` or `review`
- created_at
- archived
- peer_open
- peer_opened_at — needed for students to see a peer review after the session ends
- peer_required_reviews
- peer_until — review deadline (added automatically when peer review is opened)
- peer_window_mins
- history_window_mins

---

### Responses
Stores student submissions.

Required columns:

- response_id
- session_id
- reviewer_token
- timestamp
- response_text_original
- response_text_edited — instructor edits / masked text; shown instead of the original when set
- is_hidden

Recommended columns:

- confidence — 1–5, blank if not given
- tags — instructor Performance/Reason tags (comma-separated)
- pos_x, pos_y — card positions on the dashboard board
- order_weight
- is_pinned
- profanity_flag — `NONE`, `MASKED` or `FLAGGED`
- phase_at_submit

---

### PeerAssignments
Stores peer-review allocations.

Columns:

- session_id
- reviewer_token
- response_id
- assigned_at

---

### PeerFeedback
Stores submitted peer reviews.

Columns:

- feedback_id
- session_id
- response_id
- reviewer_token
- feedback_text
- timestamp
- is_hidden
- review_quality — added automatically if missing

---

### Instructors
Stores instructor login credentials.

Columns:

- instructor_id
- password — plaintext or a salted hash (see [Instructor authentication](#instructor-authentication))
- display_name (optional)

---

### ProfanityList
Words that are masked (or blocked/flagged) in student responses and peer feedback.

- One term per row in column A, **starting in row 1, with no header row**.
  Anything in row 1 is treated as a term.

---

### Settings
Optional key/value settings, but **the sheet itself must exist**. Row 1 is a
header (e.g. `key`, `value`), and settings go in columns A and B from row 2.

| key | default | meaning |
|---|---|---|
| max_words | 200 | Maximum words in a response or peer review |
| min_chars | 0 | Minimum characters in a response |
| profanity_action | mask | `mask` (replace with emoji), `flag` (store but mark) or `block` (reject) |

---

### Notes

- `session_id` links all activity to a specific teaching session.
- `reviewer_token` is an anonymous student identifier generated by the
  application and stored in the student's browser.
- Responses, peer reviews, and assignments are all tied to a session through
  `session_id`.
- Peer review assignments are generated on demand when students enter review mode.
- Writes that allocate IDs (responses, peer feedback) and peer assignments run
  under a script lock, so simultaneous submissions can't collide.
