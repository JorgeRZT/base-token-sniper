# Token Sniper (Base)

**At the start of every session, read `docs/STATE.md` first** to know where the project stands and what the next steps are, then read `docs/FINDINGS.md` (data and conclusions of every analysis so far), then briefly tell the user where we are. Keep `docs/STATE.md` updated whenever something significant changes, and add new analysis results to `docs/FINDINGS.md` (keep the most revealing numbers there: `data/` is git-ignored).

- Overview, setup and cron: `README.md`. Design: `docs/ARCHITECTURE.md`. Scoring rules: `docs/FILTERS.md`. Analysis results: `docs/FINDINGS.md`. Analysis tool: `node scripts/analyze.js`.
- Code, docs and comments are written in English; talk to the user in Spanish.
- Never read or print `.env` (secrets). `data/` holds runtime output (git-ignored); the user will share `data/new-tokens.jsonl` and `data/outcomes.jsonl` after the 24 h run.
- Run scripts from the project root (`dotenv` loads `.env` from the working directory).
