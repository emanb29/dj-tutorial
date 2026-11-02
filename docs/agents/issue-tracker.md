# Issue tracker: Linear

Issues and specs for this repo live in Linear:

- **Team:** Emanb29 (key `ISS`)
- **Project:** DJ Tutorial, https://linear.app/emanb29/project/dj-tutorial-643b7d40d305

Use the `linear-server` MCP tools for every operation. Always pass `team: "Emanb29"` and `project: "DJ Tutorial"` when creating issues, so they don't land outside the project. Issue identifiers look like `ISS-123`.

## Conventions

- **Create an issue:** `save_issue` with `team`, `project`, `title` and a Markdown `description`. Don't pass `id` when creating.
- **Read an issue:** `get_issue` with the identifier, then `list_comments` for its conversation history.
- **List issues:** `list_issues` with `project: "DJ Tutorial"`, filtered by `label` or `state` as needed.
- **Comment on an issue:** `save_comment` with the issue identifier and a Markdown body.
- **Apply or remove labels:** `save_issue` with `id` plus `addLabels` / `removeLabels`. Never use `labels` for this, because it replaces the whole label set. If a label doesn't exist yet, create it on the team with `create_issue_label`.
- **Close:** add a comment explaining why, then `save_issue` with `state: "Done"`. Use `state: "Canceled"` for wontfix.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(This repo has no external contributors. `/triage` reads this flag.)_

## When a skill says "publish to the issue tracker"

Create a Linear issue in the DJ Tutorial project.

## When a skill says "fetch the relevant ticket"

Call `get_issue` on the identifier (e.g. `ISS-12`), then `list_comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is one parent issue, and each **child** ticket is a sub-issue of it.

- **Map:** an issue labelled `wayfinder:map` whose description holds the Notes / Decisions-so-far / Fog body.
- **Child ticket:** `save_issue` with `parentId: <map identifier>` and the label `wayfinder:<type>` (`research`, `prototype`, `grilling` or `task`).
- **Blocking:** Linear's native relations. Set them with `save_issue` using `blockedBy: [...]` (append-only; remove with `removeBlockedBy`). A ticket is unblocked when every blocker is in a completed or canceled state.
- **Frontier query:** `list_issues` with `parentId: <map>` and `state` not completed. Drop any ticket that has an open blocker or an assignee. The first remaining ticket in map order wins.
- **Claim:** `save_issue` with `id` and `assignee: "me"`, and `state: "In Progress"`. This must be the session's first write.
- **Resolve:** `save_comment` with the answer, then `save_issue` with `state: "Done"`. Finally, append a context pointer (a one-line gist plus the issue link) to Decisions-so-far on the map, using `save_issue` with `patch`.
