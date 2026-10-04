# NWIS Project Status

## What This Project Is

NWIS is a Nearby Wells Intelligence System prototype for Oil India PS121. It demonstrates how active drilling data can be combined with historical offset-well knowledge to support faster risk awareness, evidence lookup, and proactive drilling decisions.

The project is currently a full-stack synthetic prototype: frontend dashboard, backend APIs, authentication, seeded database, and lightweight ML-style engines.

## What Has Been Built

### Frontend

- React + Vite dashboard.
- Sidebar routes:
  - Overview
  - Well Explorer
  - Risk Analysis
  - Historical Events
  - Documents
  - Settings
- Login screen connected to backend authentication.
- JWT session stored in browser local storage.
- Top bar shows backend API status, logged-in user, role, and logout.
- Interactive Leaflet map showing active and offset wells.
- Recharts visualizations for depth correlation and telemetry.
- Search/filter UI for historical events and documents.
- Deterministic assistant panel for demo questions.

### Backend

- Express API server.
- SQLite database via `better-sqlite3`.
- Synthetic seed data for:
  - users
  - wells
  - drilling events
  - documents
  - telemetry
  - risk training samples
  - casing, cementing, mud program details
  - OCR/NLP extracted fields
- Auth system:
  - register
  - login
  - JWT verification
  - role checks
- Demo users:
  - `engineer@nwis.demo / demo1234`
  - `admin@nwis.demo / admin1234`

### APIs

- Health: `/api/health`
- Auth: `/api/auth/login`, `/api/auth/register`, `/api/auth/me`
- Data: `/api/wells`, `/api/events`, `/api/documents`, `/api/telemetry`
- Search: `/api/search`
- ML: `/api/ml/risk`, `/api/ml/similarity`, `/api/ml/clusters`, `/api/ml/architecture`
- Alerts: `/api/alerts/current`, `/api/alerts/evaluate`
- Recommendations: `/api/recommendations`

### ML / Analytics Prototype

- Logistic-regression-style supervised risk scorer.
- K-means-style unsupervised offset-well clustering.
- Similarity ranking for nearby wells.
- Evidence-backed recommendation output.
- Risk categories:
  - Stuck Pipe
  - Lost Circulation
  - Kick
  - Formation Instability

## How To Run

Open two terminals in the project folder:

```powershell
cd "C:\Users\kabir\OneDrive\Desktop\PS_121\PS121"
npm run api
```

```powershell
cd "C:\Users\kabir\OneDrive\Desktop\PS_121\PS121"
npm run dev
```

Open the frontend URL, usually:

```text
http://localhost:5173
```

The backend runs at:

```text
http://localhost:4000
```

## Current Prototype Limits

- All data is synthetic.
- ML models are simple deterministic demo engines, not trained production models.
- OCR/NLP output is seeded mock data.
- Frontend still uses many local static datasets; only auth/API status is currently wired into the UI.
- No real eRTMAC integration yet.
- No real PDF upload or OCR pipeline yet.
- No production security hardening.

## What Needs To Be Done Next

1. Wire frontend pages fully to backend APIs instead of local `src/data` files.
2. Add backend-driven risk cards and alert banners.
3. Add document upload and OCR/NLP extraction workflow.
4. Add database persistence by setting `NWIS_DB_PATH=./nwis.sqlite`.
5. Add admin UI for inserting/editing wells, events, and documents.
6. Improve ML explanation panels so judges can see model inputs and evidence.
7. Add a final architecture diagram slide/page.
8. Prepare a clean demo script:
   - login
   - show active well
   - show nearby wells
   - simulate depth
   - open risk alert
   - view historical evidence
   - show ML API output

## Presentation Message

NWIS is not just a dashboard. It is a prototype institutional-memory system for drilling engineers. It shows how live drilling context can be combined with offset-well history, document intelligence, similarity ranking, risk prediction, and evidence-backed recommendations to support proactive decisions alongside eRTMAC.
