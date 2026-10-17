# Learn to DJ

A teaching wizard that takes a learner from no DJ skills to mixing real tracks on a simulated two-deck setup, one or two concepts at a time. DJ terms follow industry usage (manufacturer manuals, DJ schools), not internal coinages.

## Teaching

**Learner**:
The person being taught. The first learner is the project owner; the design must generalize to others.
_Avoid_: User, student, player

**Lesson**:
A fixed, hand-authored unit that teaches one or two concepts, unlocks the controls they need, and ends in a check.
_Avoid_: Level, module, step

**Lesson catalogue**:
The complete set of Lessons and the prerequisites between them. Fixed content; never generated at runtime.
_Avoid_: Course, content library

**Curriculum**:
The ordered selection of Lessons from the Lesson catalogue chosen for one Learner, built from their Skill profile and revised as it changes.
_Avoid_: Path, plan, syllabus

**Placement**:
The hands-on assessment at the start that measures what a Learner can already do, so the Curriculum skips what they've mastered. Never self-reported.
_Avoid_: Onboarding quiz, self-assessment

**Check**:
A deterministic measurement of a Learner's attempt at the end of a Lesson (or within Placement), producing pass/fail plus the measured values.
_Avoid_: Test, quiz, grade

**Skill profile**:
The running record of what a Learner has demonstrated, updated by every Check.
_Avoid_: Level, score, progress

**Coach**:
The runtime language model that reads Skill profiles and Check measurements to build the Curriculum and give personalised feedback. It never grades and never hears audio.
_Avoid_: AI, tutor, assistant
