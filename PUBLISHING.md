# Publishing Random Note Filters

Workshop-only notes; this file does not travel to the public repo.

| Requirement | Where |
|---|---|
| `id` and `name` free | `node research/namecheck.mjs "Random Note Filters" random-note-filters` |
| `minAppVersion` | 0.16.0 (`node research/minapp.js random-note-filters`; `getLeaf('tab')`) |
| Review lint | `npm run lint` clean, `"types": []` |
| Every command has an `icon` | mobile toolbar shows "?" otherwise |
| Tested in real Obsidian | `bash tools/obsidian-e2e/all.sh --only random-note-filters` |

## Steps

1. Create `perezamadorluisenrique-gif/random-note-filters` (GitHub MCP `create_repository` works from a session), save it to the project's repo list (`add_repo` with `save_to_project: true`; otherwise the download checkers get 403 for it), and copy this folder in without `PUBLISHING.md`.
2. Actions → Release → Run workflow, tag `0.1.0`: builds a **draft**.
3. Enrique publishes the draft, **then** submits at community.obsidian.md.
