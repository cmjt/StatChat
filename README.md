# StatChat

A Google Apps Script web app for in-class responses. Students submit short
anonymous answers that the instructor can view, tag and display on a board,
then (optionally) review each other's answers.

- Student page: `<web app URL>?page=student&inst=<instructor_id>`
- Instructor dashboard: `<web app URL>?page=dashboard`

## Activities

When opening a session, the instructor answers two questions:

| Question | Choices |
|---|---|
| **Students submit** | **Text**: short written answers or poll replies. **Math**: typed equations. **Drawing**: a sketch drawn with a finger, stylus or mouse. **Math & drawing**: equations and/or a drawing |
| **Draw on** (drawing types only) | **Blank**, **Grid** or **Axes** |
| **Peer review** | **Off**: responses are shown live as cards and charts, and peer review controls are hidden. **On**: after writing, students review classmates' answers when the instructor opens the review |

The activity is named from the answers, e.g. *Quick response*, *Peer review ·
math* or *Quick response · drawing*. Math and drawing activities have no text
box.

Each session stores the answers in Sessions columns `submission_type` (`text`,
`math`, `sketch` or `math_sketch`), `peer_review` (`TRUE`/`FALSE`) and
`sketch_background` (`blank`, `grid` or `axes`), all added automatically. The
server enforces them: peer review can't be opened when it's off, and each
activity accepts only its own kind of answer. Logging in again with different answers changes
them, except while the session is in peer review. Sessions created before
activities existed behave as text with peer review, as they did before.

### Math activities

Students' text box is replaced by **equation lines**: one equation per line, up
to 10, which they can add or remove (for example, one step of working per line).

- **Equation editor:** [MathLive](https://cortexjs.io/mathlive/). Students type
  maths directly (`/` for a fraction, `^` for a power) or use its on-screen
  maths keyboard, which opens when they tap a line on a phone or tablet. It's
  only downloaded when a math activity starts. If it can't load, students get
  plain boxes to type LaTeX into.
- **Display:** equations are shown with [KaTeX](https://katex.org/) on the
  dashboard cards and in peer review. If KaTeX can't load, the LaTeX source is
  shown instead.
- **Correcting answers:** click a card's equations on the dashboard to edit
  them in the same editor, then **Save**. As with text edits, the correction is
  shown instead of the student's answer everywhere (the board, peer review, and
  the feedback the student receives), and the card gets a **✎ Corrected**
  badge. The student's own submission is kept: **Revert to student's answer**
  brings it back. To remove an answer, hide the card.
- **Storage:** equations are stored as LaTeX in the `response_content` column
  of Responses (added automatically), as JSON:
  `{"math": ["\\bar{x} = 4.2", ...], "math_edited": [...]}`. `math` is what
  the student submitted and never changes; `math_edited` is your correction, if
  any. `response_text_original` also gets a readable copy of the submission,
  with each equation as `$$...$$`.
- **Poll view:** math answers are tallied by their last line (the final
  answer), ignoring spaces. Drawings aren't tallied.
- **Profanity:** equations can't be masked without breaking them, so a listed
  term inside one is blocked (with `profanity_action` = `block`) or otherwise
  flagged.

### Drawing activities

Students get a **drawing pad** on the background you chose (blank, grid, or
first-quadrant axes for sketching distributions, scatterplots and curves).

- **Tools:** black, blue and red pens, an eraser that removes whole lines,
  Undo, and Clear (which Undo can bring back). It works with a finger, stylus
  or mouse. Once a stylus is used, touches are ignored, so a palm resting on a
  tablet doesn't draw.
- **In class:** drawings appear on the dashboard cards straight away, like
  written answers. Click a drawing to enlarge it, e.g. for the projector (Esc or
  ✕ closes it). Students see drawings the same way in peer review.
- **Math & drawing:** students get both the equation lines and the pad, and
  can submit either or both. You can correct the equations as usual; drawings
  can't be edited, but you can hide the card.
- **Storage:** a drawing is stored as pen strokes, not an image, in the
  `sketch` field of `response_content`:
  `{"v": 1, "bg": "axes", "s": [[colour, x0, y0, dx1, dy1, ...], ...]}` on a
  600 × 400 canvas. Each stroke is simplified as it's drawn, so a typical
  sketch takes a few hundred to a few thousand characters. The limit is 30,000
  characters (a Sheets cell holds 50,000); students are warned at 70% and can't
  submit past 100%. `response_text_original` gets a note such as
  `[drawing: 3 lines]`.
- **Drawings can't be checked for profanity.** Hide anything inappropriate.

**Students' pages update themselves.** They re-check every 20–30 seconds
(randomised so a class's requests are spread out), pause while the tab is
hidden, and check at once when the tab is shown again. When the instructor
starts or stops an activity, switches activity, opens or closes peer review, or
returns to writing, students see it within about half a minute, with a short
message saying what changed. Anything half-typed is kept. The server caches
what students see for 10 seconds per instructor, and every instructor action
clears that cache straight away.

## Project layout

```
src/                  Everything deployed to Apps Script (clasp's rootDir)
  Config.gs           Sheet names, locking, sheet/table helpers, settings
  Auth.gs             Instructor login tokens, password hashing
  Sessions.gs         Session lifecycle, activity presets, what students/dashboard see
  Responses.gs        Student submissions, instructor moderation
  PeerReview.gs       Peer review: assignment, submission, unlock, ratings
  Profanity.gs        Profanity list, masking, detection
  Web.gs              doGet/doPost and include() for HTML partials
  student.html        Student page: markup, pulls in the partials below
  student_styles.html / student_core.html / student_math.html / student_sketch.html / student_peer.html
  dashboard.html      Instructor dashboard: markup, pulls in the partials below
  dashboard_styles.html / dashboard_core.html / dashboard_peer.html
  math_render.html    Shows equations (KaTeX) and loads the equation editor (MathLive); used by both pages
  sketch.html         Drawings: stroke format, SVG display, enlarged view; used by both pages
tests/                Local tests (not deployed)
```

All `.gs` files share one global scope. Any top-level function whose name
doesn't end in `_` can be called from the browser, so keep helpers private with
a trailing `_`.

## Deploying with clasp

[clasp](https://github.com/google/clasp) syncs `src/` with the Apps Script
project, so there's no copying and pasting in the editor.

One-time setup:

1. Install Node.js, then `npm install -g @google/clasp`.
2. `clasp login`. This opens a browser to authorise your Google account.
3. Enable the Apps Script API at <https://script.google.com/home/usersettings>.
4. Copy `.clasp.json.example` to `.clasp.json` and paste in your script ID
   (Apps Script editor → Project Settings → Script ID). `.clasp.json` is
   git-ignored, so you can point it at a test copy of the project.
5. Get the project's manifest so your deployment settings are kept: in the
   editor, Project Settings → tick "Show appsscript.json manifest file". Copy
   `appsscript.json` from the editor into `src/appsscript.json` and commit it.

Each release:

```bash
python3 tests/run.py          # all tests must pass
clasp push                    # replaces the project's files with src/
clasp deploy -i <deploymentId> -d "what changed"
```

Use `clasp deployments` to find the ID of your existing web app deployment.
Redeploying to the same ID keeps the web app URL that students use.
`clasp push` deletes files that aren't in `src/`, which removes the old single
`Code` file on the first push.

## Running the tests

```bash
python3 tests/run.py
```

This needs Node.js or GNOME's `gjs`, but no Google account. It runs:

- **A syntax check** of every `.gs` file and page script, plus all `.gs` files
  together, so a name defined twice across files is caught.
- **Server tests** (`tests/test_*.js`) against fake Sheets/Cache/Lock services
  (`tests/harness.js`).
- **Page tests** (files starting `// @page student` or `// @page dashboard`).
  These run the real page scripts in a small fake browser
  (`tests/page_harness.js`), with `google.script.run` calling the real server
  code. `test_page_student.js` plays a whole class: the instructor starts,
  stops and switches activities, and the student page is checked after each
  poll.

## Session lifecycle

Writing and peer review have separate time limits. Writing ends with the
session. Peer review can carry on after the session until its own deadline.

1. **Open**: the instructor logs in on the dashboard with a session ID. This
   creates the session (or reopens an existing one) with writing open for
   *Writing open for* minutes (default 60, set on the login screen). Students
   can only submit responses while writing is open.
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
  instructor has hidden. Any visible response in the session can be assigned.
  Assignment is balanced: responses with the fewest reviewers are picked first,
  so every response gets a reviewer before any gets a second.
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

The student page updates itself within about half a minute of any instructor
change (see [Activities](#activities)).

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
- Any top-level function in `src/*.gs` whose name doesn't end in `_` can be
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
- submission_type — `text`, `math`, `sketch` or `math_sketch` (added automatically; see [Activities](#activities))
- peer_review — `TRUE`/`FALSE` (added automatically)
- sketch_background — `blank`, `grid` or `axes` (added automatically)

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
- response_content — equations, your corrections, and drawings, as JSON (added automatically; see [Math activities](#math-activities) and [Drawing activities](#drawing-activities))

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
- profanity_flag (optional) — `NONE`, `MASKED` or `FLAGGED`

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
| profanity_action | mask | `mask` (replace with emoji), `flag` (keep the text but show a ⚠ Flagged badge on the dashboard) or `block` (reject). Applies to responses and peer reviews |

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
