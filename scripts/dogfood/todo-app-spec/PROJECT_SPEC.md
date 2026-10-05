# TODO App Project

Build a small, accessible TODO web app that works locally in a browser without a
server or external dependencies.

## Required behavior

- Show a clear app title, an input, and an add button.
- Add non-empty tasks; trim surrounding whitespace and reject blank input.
- Mark tasks complete and allow them to be marked active again.
- Delete individual tasks.
- Persist task text and completion state across reloads using browser storage.
- Show useful empty-state and validation feedback.
- Support keyboard submission and visible focus states.
- Keep the layout usable on narrow mobile screens and desktop.

## Constraints

- Use plain HTML, CSS, and browser JavaScript; no build step or dependencies.
- Keep the browser entry point at root-level `index.html`, `styles.css`, and `app.js`; any JavaScript modules must also be root-level and imported by `app.js`.
- `index.html` must load the root-level `app.js` entry point.
- Keep implementation focused on the behaviors above.
- Add automated tests for task behavior and persistence where practical.
- Run the configured `unit` verification check before considering work complete.
