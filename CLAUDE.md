# Token Sniper (Base)

**At the start of every session, read `docs/STATE.md` first** to know where the project stands and what the next steps are, then briefly tell the user where we are. Keep `docs/STATE.md` updated whenever something significant changes.

- Overview, setup and cron: `README.md`. Design: `docs/ARCHITECTURE.md`. Scoring rules: `docs/FILTERS.md`.
- Code, docs and comments are written in English; talk to the user in Spanish.
- Never read or print `.env` (secrets). `data/` holds runtime output (git-ignored); the user will share `data/new-tokens.jsonl` and `data/outcomes.jsonl` after the 24 h run.
- Run scripts from the project root (`dotenv` loads `.env` from the working directory).
