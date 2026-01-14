# Frontend (static)

This is a **frontend-only** prototype: chat + admin dashboard are pure HTML/CSS/JS.

## Run locally

Because the app fetches `./data/data.json`, it must be served over HTTP (not `file://`) to avoid CORS errors.

From the repo root:

```bash
python -m http.server 8000
```

Then open:
- Chat: `http://localhost:8000/frontend/index.html`
- Admin login: `http://localhost:8000/frontend/admin/login.html`

## Modes

The chat UI supports:

- **Local mode**: answers in-browser using rules + retrieval against `frontend/data/data.json` (copied from `backend/data/data.json`)
- **API mode**: sends messages to the Flask backend (`POST /chat`)

API mode defaults to `http://127.0.0.1:5000/chat` (see `../docs/API.md`).

## Admin credentials (demo)

- Username: `admin`
- Password: `admin123`

Note: This is **not secure** (credentials live in frontend code). For real security, move auth to the backend.


