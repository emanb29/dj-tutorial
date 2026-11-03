# DJ Tutorial

A teaching wizard that takes a learner from no DJ skills to mixing real tracks on a simulated two-deck setup, one or two concepts at a time. DJ terms follow industry usage (manufacturer manuals, DJ schools), not internal coinages.

## Teaching

**Learner**:
The person being taught. The first learner is the maintainer (`docs/maintainer-profile.md`); the design must generalize to others.
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

**Passed**:
A skill whose Check the Learner has met at least once. Passing unlocks the Lessons that depend on it.
_Avoid_: Completed, learned, mastered

**Retained**:
A passed skill the Learner met again cold, at least a day later, without the Lesson's explanation. The course is done only when the final mix's skills are retained.
_Avoid_: Mastered, locked in

**Warm-up**:
A short drill at the start of a session on skills that are due for a retention re-pass, drawn from the Lesson catalogue.
_Avoid_: Review, revision, quiz

**Bonus exercise**:
An optional drill the Coach offers while a skill isn't due yet, such as interleaved practice or extra work on a weak criterion. It never gates progress.
_Avoid_: Homework, extra credit

**Outside practice**:
A mix the Learner recorded in other DJ software from their own tracks, uploaded as one audio file and checked from the sound alone (transitions, phrasing, drift, levels, clipping, dead air, bass clash). The record keeps a summary; it never gates progress or counts as a Lesson pass.
_Avoid_: Homework, upload, external mix

**Review**:
An earlier Lesson the Coach suggests repeating after repeated failures. The Learner may decline it.
_Avoid_: Remedial lesson, retry

**Mission**:
The Learner's own statement of why they want to DJ. The Coach uses it to choose tracks and order optional Lessons.
_Avoid_: Goal, motivation

**Reference card**:
A printable one-page summary unlocked by passing a Lesson, e.g. the controller map or a transition recipe.
_Avoid_: Cheat sheet, handout

**Coach**:
The runtime language model that reads Skill profiles and Check measurements to build the Curriculum and give personalised feedback. It never grades and never hears audio.
_Avoid_: AI, tutor, assistant

## Sets

**Mix Editor**:
The screen where a Learner plans a set ahead of time: the tracks in order and each transition between them, written in musical terms (beats, phrases, fader and EQ moves) rather than controller terms. A plan can be rendered to one audio file, or practised live with grading. The controller moves each transition needs are derived from the plan, and the Mix Editor warns, without blocking, when a transition is hard to perform live.
_Avoid_: Mix planner, playlist editor, sequencer

**Transition recipe**:
A named, ready-made set of lanes for a transition: long blend, bass swap, filter sweep, echo out, cut on the 1, loop to extend, tempo ride. The same idea as the Reference card's transition recipe, but editable.
_Avoid_: Preset, template

**Execution plan**:
The controller moves a planned transition needs, derived from its lanes: which DDJ-FLX4 control, which hand, when, and how precisely, plus where each control starts. Derived every time, never stored.
_Avoid_: Script, macro

**Complexity rating**:
How hard a planned transition is to perform live, 1 to 5, computed from its Execution plan, with a reason for each thing that makes it hard. It is per Learner (a control whose Lesson isn't Passed counts), and it warns but never blocks.
_Avoid_: Difficulty level, score
