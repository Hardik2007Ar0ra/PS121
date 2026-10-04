# NWIS — Implementation Plan

**Project:** Nearby Wells Intelligence System (SIH 2026 · PS 121 · Oil India Limited)
**Plan date:** 2026-10-04
**Baseline examined:** commit `674951b` (`PS121/` working tree, incl. uncommitted `server/`)

---

## Part 1 — Current Architecture (as verified)

### 1.1 Repository shape

```
PS_121/                              ← outer git repo, 1 commit, 0 tracked files
└── PS121/                           ← nested git repo → github.com/Hardik2007Ar0ra/PS121
    ├── index.html                   324 B    single-line HTML shell
    ├── vite.config.js               React plugin + /api proxy → http://localhost:4000
    ├── tailwind.config.js           configured, but effectively unused
    ├── postcss.config.js
    ├── package.json                 name "nwis-frontend"; also carries express/better-sqlite3/jwt/bcrypt
    ├── README.md                    191 lines — accurate and honest prototype documentation
    ├── PROJECT_STATUS.md            129 lines — honest limits + "next steps" list
    ├── dist/                        committed build output (stale, hashed assets churn every build)
    ├── node_modules/                COMMITTED TO GIT (~23 MB pack, ~1,200 tracked paths)
    ├── src/
    │   ├── main.jsx                 createRoot + BrowserRouter + leaflet.css
    │   ├── App.jsx                  30,226 chars / 30 lines — 21 components, minified single-line style
    │   ├── style.css                19,544 chars — hand-written design system, dark graphite + plum + amber
    │   └── data/                    wells, events, risks, documents, telemetry — 5 static JS arrays
    └── server/
        ├── index.js                 Express 5, 19 routes, JSON limit 1 MB, CORS reflects any origin
        ├── db.js                    better-sqlite3, 6 tables, seeds itself FROM src/data/*
        ├── auth.js                  bcrypt + JWT, roles engineer/admin/viewer
        └── ml.js                    hand-tuned logistic scores, hand-rolled K-means, similarity ranking
```

### 1.2 Runtime data flow (verified)

```
                 ┌──────────────── src/data/*.js  (static JS arrays) ───────────────┐
                 │                                                                    │
                 │  import                                                           │  import
                 ▼                                                                    ▼
        ┌──────────────────┐                                              ┌──────────────────┐
        │  React SPA       │  fetch()                                    │  Express API     │
        │  (Vite :5173)    │ ────────────────────────────────▶           │  (Node :4000)    │
        │                  │   /api/health                                │                  │
        │  App.jsx         │   /api/auth/login                           │  better-sqlite3  │
        │  21 components   │   /api/auth/me                              │  (in-memory)     │
        │                  │   ◀── that's ALL ──                          │  hand-tuned ML   │
        └──────────────────┘                                              └──────────────────┘
             reads src/data/* for: wells, events, risks, documents,
             telemetry, depth-correlation chart, nearby-well ranking,
             risk cards, evidence lists, assistant answers
```

**Backend verified working** (`GET /api/health` → `ok: true`, all 5 seeded wells, similarity ranking, risk predictions, alerts all return 200).

### 1.3 What genuinely works today

| Area | Reality check |
|---|---|
| Visual design | Strong. Cohesive dark graphite/plum/amber theme, responsive at 1150 px / 760 px breakpoints. This is the strongest asset in the repo. |
| Leaflet map | Renders 5 wells + 5 km circle over OpenStreetMap, custom divIcon markers, popups. |
| Charts | Depth-correlation line chart with risk-zone reference area + bit-depth marker; Recharts telemetry area chart with 30/15/5 min ranges. |
| Routing / shell | 6 routes, sidebar, topbar, active-well status block, modals. |
| Auth | Working end-to-end: register/login/JWT/`/me`, role middleware, localStorage session, login screen. |
| Backend API | 19 routes, 6 tables, deterministic seed, `/api/health` and all reads return 200. |
| Honest framing | README + PROJECT_STATUS correctly state the data is synthetic and the scores are not validated. Keep this discipline. |

### 1.4 The five structural problems

1. **The UI is not connected to the backend.** `App.jsx` calls exactly three endpoints (`/api/health`, `/api/auth/login`, `/api/auth/me`). Every well, event, document, risk score, telemetry point and chart on screen comes from `src/data/*.js`. **0% of the ML/alerts/search backend is visible in the product.**
2. **The backend is not independent of the frontend.** `server/db.js` imports `src/data/wells.js`, `events.js`, `documents.js`, `telemetry.js`; `server/index.js` imports `src/data/risks.js`. The "database" is a re-import of the same five arrays the UI reads.
3. **The "ML" is not machine learning.** `ml.js` uses 4 hard-coded coefficient sets. The `risk_training_samples` table (33 seeded rows/well) is written at seed time and then **only ever `COUNT(*)`-ed** (`ml.js:278`) — it is never trained on or read for inference. There is no training code, no loss function, no evaluation metric.
4. **Data contracts are broken across the boundary.** API returns `distance_km` / `current_depth_m` / `total_depth_m`; `App.jsx` reads `w.distance` / `w.depth` / `w.td`. Wiring the UI to the API as-is silently yields `undefined`.
5. **The schema is a demo schema, not a drilling data model.** `casing_program`, `cementing_practice`, `mud_program` are free-text blobs on `wells`. There is no formation table, no formation tops, no trajectory/survey table, no reservoir table, no casing/cementing/mud tables, no fishing/NPT taxonomy. The PS lists 9 data sources; **2 are represented (WCR, DDR) and 7 are absent.**

---

## Part 2 — Requirement Gap Matrix

Legend: ✅ done · 🟡 partial · 🔴 absent

| # | PS requirement | Today | Gap to close |
|---|---|---|---|
| i | Display nearby wells on a geospatial map relative to the active well | 🟡 Leaflet map, 5 hard-coded markers, hard-coded centre `23.8100, 86.4400` | `distance_km` is a **stored column**, not computed from `lat`/`lng`. The Settings radius slider is local React state and never re-queries anything. No way to choose a different active well as the map origin. No formation/fault layers. No vertical section view. |
| ii | Instant access to historical drilling experiences and events from offset wells | 🟡 Static 10-row event register, client-side filters | 10 events total. Client-side `LIKE` filtering. No cross-well correlation view, no event provenance, no lesson-learned object. |
| iii | Correlate drilling parameters, reservoir characteristics, mud losses, kicks, stuck pipe, casing programs, cementing practices, formation risks across wells | 🔴 Depth chart only | No normalized casing/cementing/mud schema. No multi-well parameter overlay. No reservoir/geology model. Formation is a free-text string. |
| iv | Proactive alerts as current operations approach comparable depths/formations | 🟡 `/api/alerts/current` works server-side | Not rendered anywhere in the UI. Threshold hard-coded `40` in two places. No look-ahead logic, no lifecycle, no dedupe, no notification channel, no audit trail. |
| O-i | AI / NLP / OCR auto-extraction from reports | 🔴 | `nlp_entities_json` is produced by a **regex over mock strings at seed time**. No PDF parsing, no OCR, no upload, no extraction pipeline, no review queue. |
| O-ii | Interactive map with user-defined radius | 🟡 | Radius is cosmetic. Needs `ST_DWithin` / haversine query driven by UI. |
| O-iii | Searchable knowledge repository of events, lessons learned, mitigations | 🟡 `GET /api/search` (SQL `LIKE`) | No full-text index, no vector/semantic search, no hybrid ranking, no `lessons_learned` entity. |
| O-iv | Correlate geological / drilling / reservoir data by depth + formation | 🔴 | Needs formation tops + depth-reference normalisation (MD/TVD/KB) + correlation engine. |
| O-v | Predictive models: mud loss, stuck pipe, **overpressure**, **torque spikes**, **cementing issues** | 🟡 4 categories | Present: Stuck Pipe, Lost Circulation, Kick, Formation Instability. **Absent: overpressure as its own model, torque/drag spike detection, cementing risk.** All weights hand-tuned. No training, no metrics. |
| O-vi | Real-time alerts and recommendations | 🟡 | No streaming ingest, no WebSocket/SSE, no persistence, no acknowledgement workflow. Telemetry = 31 static rows with no `well_id`. |
| O-vii | Dashboard for field **and** office personnel | 🟡 One desktop layout | No rig-floor mode (large touch targets, high contrast, glove-friendly, offline), no office analytics mode, no shift handover export, no PWA. |
| D-i…D-ix | 9 OIL data sources | 🔴 2 of 9 | WCR + DDR as 5 mock PDFs. Missing: drilling & mud-logging DB, historical parameters, reservoir/geological data, eRTMAC stream, trajectory/survey, casing/cementing/mud programs, full event taxonomy (mud loss, kick, stuck pipe, fishing, NPT). |

### Cross-cutting technical debt

- **Repo hygiene:** `node_modules/` and `dist/` are committed; no `.gitignore` anywhere; outer repo tracks zero files; two nested git repos.
- **Dead dependencies:** Tailwind + PostCSS + Autoprefixer configured but ~0 utilities used (all styling is hand-written CSS).
- **No tests, no linter, no formatter, no CI, no Docker, no `.env.example`.**
- **`src/App.jsx` is one 30 KB line-per-component file** — 21 components, no API client layer, no loading/error/empty states, no code splitting.
- **Security:** default `JWT_SECRET` fallback; `cors({origin: true})` reflects any origin; **open `/api/auth/register` accepts `role` from the request body → self-service admin escalation**; no rate limiting; no refresh/revocation; all read endpoints public; no input-validation library; `express.json` capped at 1 MB so no file upload is possible.
- **No provenance, versioning, or human-in-the-loop** on any extracted fact.
- **No model evaluation, no model card, no feedback loop** (active-well outcomes never become labels).
- **Offline reality:** OSM tiles need internet; a rig site may not have it.

---

## Part 3 — Target Architecture

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ CLIENTS                                                                       │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ Rig-Floor PWA  │  │ Office Web App │  │ Admin Console│  │ Shift Handover│ │
│  │ (offline-first)│  │ (analytics)    │  │ (ingest/review)│ │ (PDF export)  │ │
│  └────────┬───────┘  └────────┬───────┘  └──────┬───────┘  └───────┬───────┘ │
└───────────┼───────────────────┼─────────────────┼──────────────────┼─────────┘
            │  REST + WebSocket/SSE (JWT, RBAC)   │                  │
┌───────────▼───────────────────▼─────────────────▼──────────────────▼─────────┐
│ API LAYER — Node / Express (or FastAPI)                                       │
│  routes/{auth,wells,geo,events,formations,correlation,documents,ingest,      │
│          search,rag,alerts,rules,telemetry,ml,admin,audit}                    │
│  middleware: authz · validation(zod) · rate-limit · helmet · audit · error    │
└───┬────────────┬─────────────┬──────────────┬──────────────┬─────────────────┘
    │            │             │              │              │
┌───▼──────┐ ┌───▼────────┐ ┌──▼───────────┐ ┌▼─────────────┐ ┌▼───────────────┐
│ INGEST   │ │ EXTRACTION │ │  KNOWLEDGE   │ │   ANALYTICS  │ │  RAG / LLM     │
│ SERVICE  │ │  PIPELINE  │ │  & SEARCH    │ │  & MODELS    │ │  (pluggable,   │
│ eRTMAC   │ │ pdf text   │ │ Postgres FTS │ │ feature store│ │   on-prem)     │
│ REST/    │ │ + Tesseract│ │ + pgvector   │ │ + offline    │ │                 │
│ MQTT/    │ │ OCR → NLP  │ │ hybrid RRF   │ │   training   │ │                 │
│ file drop│ │ → entities │ │ → RAG        │ │   (sklearn)  │ │                 │
└───┬──────┘ └───┬────────┘ └──┬───────────┘ └┬─────────────┘ └┬────────────────┘
    │            │             │              │
┌───▼────────────▼─────────────▼──────────────▼───────────────────────────────┐
│ DATA PLANE                                                                  │
│  PostgreSQL 16 + PostGIS (wells geometry, ST_DWithin)                        │
│              + pgvector (embeddings)  + pg_trgm/tsvector (lexical search)    │
│  Object storage for source PDFs + rendered page images                       │
│  Versioned feature store + model registry (every model version traceable)    │
│  Audit log of every extraction, alert, acknowledgement and override          │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Migration strategy — do not rewrite, replace seams.**
1. Introduce a **repository layer** (`server/repositories/*`) so the current `db.js` SQL becomes one adapter among two.
2. Ship the Postgres+PostGIS+pgvector adapter as the target; keep the existing SQLite adapter behind the same interface so the zero-dependency demo (`npm install && npm run api`) keeps working without Docker.
3. Move seeds out of the request path entirely: `server/seeds/` + `npm run seed`, and **delete the `server/ → src/data/` import coupling** by moving the synthetic corpus to `server/seeds/synthetic/`.

---

## Part 4 — Work Plan

Each phase lists goal → tasks → files → done-when. Phases 0–2 are prerequisites for everything else.

---

### Phase 0 — Foundation & Repository Hygiene  *(3–4 days)*

**Goal:** make the codebase safe to build on. Nothing else can proceed cleanly without this.

| # | Task | Detail |
|---|---|---|
| 0.1 | Resolve repo topology | Decide: single repo (flatten `PS121/` into `PS_121/`) or keep nested. **Remove `node_modules/` and `dist/` from git history-tracked state**, add a real `.gitignore` (`node_modules`, `dist`, `.env`, `*.sqlite*`, `storage/`, `uploads/`). |
| 0.2 | Add project config files | `.env.example` (`PORT`, `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CORS_ORIGIN`, `OCR_MIN_CONFIDENCE`, `LLM_PROVIDER`, `LLM_MODEL`, `ERTTMAC_*`), `.editorconfig`, ESLint + Prettier, `.nvmrc`. |
| 0.3 | Decompose the frontend | Split `src/App.jsx` into `src/pages/{Overview,WellExplorer,RiskAnalysis,Events,Documents,Settings,Login}.jsx`, `src/components/{shell,map,charts,panels,modals,forms}/*`, `src/state/AppContext.jsx`, `src/hooks/*`, `src/lib/{format,geo,depth}.js`. Preserve the current visual output **pixel-for-pixel** — this is a pure refactor, verified by screenshot before/after. |
| 0.4 | Introduce the API client | `src/api/client.js` (fetch wrapper: base URL, JWT injection, refresh, 401 handling, error normalisation), `src/api/{wells,events,documents,telemetry,alerts,ml,auth}.js`. |
| 0.5 | **Fix the field-name contract** | Either rename API fields to `distance` / `depth` / `td`, or add `server/serializers/well.js` producing a stable DTO. **Never let the UI read two naming conventions.** Record the contract in `docs/API.md`. |
| 0.6 | Move synthetic data out of `src/` | Create `server/seeds/synthetic/{wells,events,documents,telemetry,risks}.js`. Delete the 5 `server/ → src/data/` imports. Frontend must never import seed data directly. |
| 0.7 | Add a test harness | Vitest (unit) + Supertest (API) + Playwright (one smoke journey). Seed fixtures under `tests/fixtures/`. |
| 0.8 | Docker + Compose | `Dockerfile.api`, `Dockerfile.web`, `docker-compose.yml` (postgres+postgis+pgvector, api, web/nginx, optional redis for job queue). |
| 0.9 | CI | GitHub Actions: install → lint → test → build. Fails the build on lint/test errors. |
| 0.10 | Delete dead deps | Remove Tailwind + PostCSS + Autoprefixer (or commit to using them). Add `multer`, `zod`, `helmet`, `express-rate-limit`, `compression`, `pino`. |

**Done when:** `git status` is clean, `node_modules` is untracked, `npm run lint && npm test && npm run build` pass in CI, `src/App.jsx` no longer exists, and no file under `server/` imports from `src/`.

---

### Phase 1 — Real Data Model  *(5–7 days)*

**Goal:** a schema that can actually hold the 9 OIL data sources. This unlocks O-iii, O-iv, and half of O-v.

**New / rewritten tables** (Postgres target; SQLite adapter mirrors the subset the demo needs):

| Table | Purpose | Key columns |
|---|---|---|
| `fields` | Field / block / operating area | `id, name, basin, operator` |
| `wells` (rewrite) | Well header + **computed** geo | `id, well_name (unique), field_id, uwi, spud_date, status, well_type, kb_depth_m, td_md_m, td_tvd_m, geometry Geometry(Point,4326)` + `GiST` index |
| `well_sections` | Casing programme, normalised | `id, well_id, section_no, hole_size_in, casing_size_in, shoe_md_m, shoe_tvd_m, grouted_md_m, cement_slurry_type, cement_volume_bbl, top_out_md_m, design_ecd_ppg, source_doc_id` |
| `cementing_jobs` | Cementing practice | `id, well_id, section_id, job_date, displacement_efficiency_pct, squeeze_required, u_tubing_bbl, remarks, source_doc_id` |
| `mud_programs` | Mud programme | `id, well_id, interval_from_md_m, interval_to_md_m, system, type (WBM/OBM/PBM), density_ppg, funnel_viscosity_s, ph, lcm_type, lcm_ration, source_doc_id` |
| `formations` | Stratigraphic master | `id, name, field_id, age, lithology, top_tvd_m_default` |
| `formation_tops` | Per-well formation tops | `well_id, formation_id, top_md_m, top_tvd_m, tvd_ss_m, confidence, method (marker/GR/LWD/manual), source_doc_id` ← **the key table for O-iv** |
| `trajectory_surveys` | Directional survey | `well_id, md_m, inclination_deg, azimuth_deg, tvd_m, north_m, east_m, atge_deg` |
| `reservoirs` / `reservoir_properties` | Reservoir data | `reservoir_id, fluid_type, pressure_psi, temperature_c, permeability_md, porosity_pct, producer` |
| `formations_reservoirs` | Formation ↔ reservoir link | `formation_id, reservoir_id` |
| `operational_events` (extend) | Full event taxonomy | + `category` (ENUM: `MUD_LOSS, KICK, STUCK_PIPE, TORQUE_SPIKE, HOLE_INSTABILITY, CEMENTING_ISSUE, FISHING, NPT, TRIPPING, OTHER`), `subtype`, `start_md_m`, `end_md_m`, `severity (1–5)`, `volume_loss_bbl`, `npt_hours`, `root_cause`, `action_taken`, `action_outcome`, `detected_by (human/model)`, `provenance_id` |
| `event_provenance` | **Traceability** | `id, source_type (document/telemetry/manual), document_id, page_no, bbox_json, char_start, char_end, ocr_confidence, extractor_version, reviewed_by, reviewed_at` |
| `lessons_learned` | **Explicit lessons object (O-iii)** | `id, well_id, event_id, challenge, root_cause, action_taken, effectiveness (worked/partly/failed), transferable (bool), tags[], author, source_doc_id, created_at` |
| `documents` (rewrite) | Corpus | `id, filename, doc_type (WCR/DDR/MUD_LOG/CEMENTING/TRAJECTORY/OTHER), well_id, filed_date, page_count, sha256, storage_path, ocr_status, ocr_confidence, processed_at` |
| `document_pages` | Per-page artefacts | `document_id, page_no, text, image_path, ocr_confidence, ocr_engine` |
| `document_chunks` | Retrieval units | `document_id, page_no, chunk_no, text, embedding vector(768), token_count` |
| `telemetry_samples` (rewrite) | **Per-well** surface data | `well_id, ts, depth_md_m, torque_knm, rop_mhr, spp_psi, flow_out_lpm, pit_volume_m3, mud_weight_ppg, ecd_ppg, wob_ton, rpm, hook_load_ton, bit_depth_m, gas_ratio_ppm, flow_bit_ms` + index `(well_id, ts)` |
| `trajectory_features` | Derived downhole signals | `well_id, depth_md_m, d_exponent, lithology_index, shale_flag, overbalance_flag` ← needed for overpressure model |
| `risk_training_samples` (extend) | Real labelled rows | + `label_source (extracted/derived/labeler)`, `split_group (well_id)`, `feature_version` |
| `alerts` | Alert lifecycle | `id, well_id, risk_type, severity, trigger_depth_md_m, window_from_md_m, window_to_md_m, score, model_version, status (OPEN/ACK/CLOSED), created_at, acked_by, acked_at, closed_at, resolution_note` |
| `alert_rules` | Configurable thresholds | `id, field_id, risk_type, formation_id, look_ahead_m, trigger_score, severity, enabled, updated_by` |
| `audit_log` | Everything | `id, actor_id, action, entity, entity_id, before_json, after_json, ts, ip` |

**Tasks**
- 0.4 Write `docs/DATA_MODEL.md` with the full ER diagram (Mermaid) and a **depth-reference policy**: all MD/TVD/TVDSS values carry an explicit `depth_reference` and KB elevation; never compare raw MDs across wells without a documented correlation.
- 0.5 Build a **migration runner** (`server/db/migrations/NNN_name.sql` + `npm run migrate`), replacing `CREATE TABLE IF NOT EXISTS` string blobs.
- 0.6 Build a **realistic synthetic corpus generator** (`server/seeds/generator/`), not hand-typed arrays: generate 40–60 wells across 2–3 fields, formation tops with correlated stratigraphy, per-well casing/cementing/mud programmes, 500–2,000 events across the full taxonomy, and 20–30 realistic multi-page documents with deliberately messy text (comma decimals, "9 5/8", spelled-out severities, scanned-page blocks) so the extraction pipeline has something true to chew on.
- 0.7 Generate telemetry from a mechanistic simulator (see Phase 4), ~50 depth-indexed samples/well + a live replay trace.
- 0.8 Add PostGIS radius query `POST /api/geo/nearby-wells {lat,lng,radiusKm,filters}` → `ST_DWithin(wells.geometry, point, r)` returning computed `distance_km`.

**Done when:** a fresh `npm run migrate && npm run seed` builds the full schema, 40+ wells and 500+ events exist, and a 3 km radius query around a chosen point returns only genuinely-close wells with server-computed distances.

---

### Phase 2 — Document Ingestion, OCR & NLP Extraction  *(8–12 days)* — **the PS headline**

**Goal:** replace the seeded mock `nlp_entities_json` with a real, provenance-carrying extraction pipeline.

**Architecture**
```
upload (multer, disk) → documents + document_pages rows
   → job queue (in-process worker; Redis/BullMQ if available)
   → TEXT EXTRACTION
        PDF text layer via pdfjs-dist (fast path)
        else per-page rasterise → Tesseract.js OCR (eng + hi/as if needed)
   → PREPROCESSING
        de-hyphenation, ligature repair, OCR-artefact cleanup
        unit & number normalisation ("2,880 m", "2880M", "9 5/8" → 2880.0 m / 9.625 in)
   → SECTION SEGMENTation  (WCR/DDR standard headings)
   → ENTITY EXTRACTION  (controlled vocabulary + gazetteer)
   → RELATION EXTRACTION (event ↔ depth ↔ well ↔ action)
   → confidence scoring + PROVENANCE (doc, page, bbox, char offsets)
   → HUMAN REVIEW QUEUE  (low-confidence items only)
   → write to operational_events / formation_tops / mud_programs / lessons_learned
```

**The drilling ontology** (`server/nlp/ontology/`) — this is the substance, not a wrapper around an LLM:
- **Entity types:** `WELL`, `DEPTH (MD/TVD)`, `FORMATION`, `EVENT`, `SEVERITY`, `NPT_DURATION`, `MUD_DENSITY`, `ECD`, `TORQUE`, `ROP`, `SPP`, `WOB`, `FLOW_OUT`, `PIT_VOLUME`, `GAS_RATIO`, `CASING_SIZE`, `CASING_DEPTH`, `CEMENT_VOLUME`, `MUD_SYSTEM`, `ADDITIVE/LCM`, `BIT_TYPE`, `BHA`, `ACTION`, `CAUSE`, `OUTCOME`
- **Event lexicon** mapping free text → the `category` ENUM, e.g. `loss of mud / mud loss / losses observed / annular pressure drop` → `MUD_LOSS`; `pack-off / differential sticking / stuck pipe / freeze pipe` → `STUCK_PIPE`; `overpressure / influx / flow check positive / kick` → `KICK`
- **Cue-phrase patterns** for relation extraction: `"at X m"`, `"between X and Y m"`, `"while drilling"`, `"mud weight increased to"`, `"LCM pill pumped"`, `"reamed back to"`, `"NPT of X hours"`
- **Severity normalisation:** `minor/slight` → 1, `moderate` → 3, `severe/major/significant` → 5
- **Well-name resolution:** fuzzy match OCR'd well names against the `wells` master (handles `A-17`, `A17`, `A 17`, `A-l7`)

**LLM usage — constrained and optional.** Implement a `NarrativeExtractor` interface with two implementations:
1. `RuleExtractor` (default, zero external dependency, fully deterministic, offline) — lexicon + patterns above.
2. `LlmExtractor` (enabled via `LLM_PROVIDER=ollama|openai-compatible`) — used **only** for narrative summarisation, lesson phrasing and the RAG answer layer, always constrained to a JSON schema, always **grounded on retrieved chunks with citations**, and always degrading gracefully to `RuleExtractor` when unavailable. OIL's data-residency constraints make a local model (Ollama) the sane default.

**New endpoints**
```
POST   /api/documents/upload            multipart, multi-file      → job ids
GET    /api/documents                   filters: well, type, status, q, year
GET    /api/documents/:id               metadata + pages
GET    /api/documents/:id/pages/:n      text + page image
GET    /api/documents/:id/extractions   all extracted facts + confidence + provenance
POST   /api/extractions/:id/review      accept / correct / reject  (human-in-the-loop)
GET    /api/review-queue                low-confidence items, ranked by impact
POST   /api/review-queue/:id/accept     bulk accept
```

**Quality gates (must be measurable, because judges will ask):**
- Report **precision / recall / F1 per entity type** on a hand-labelled gold set of ~20 documents (`tests/fixtures/gold/`).
- Report **event-extraction precision** — the number that matters.
- Report **OCR character error rate** on the scanned-page subset.
- Every extracted fact is traceable to `document → page → bbox`. Nothing enters the knowledge base without provenance.

**Done when:** a real PDF is uploaded, its text is extracted (OCR if scanned), ≥90% of its events land in `operational_events` with correct well/depth/severity, every one carries provenance, low-confidence items appear in the review queue, and measured F1 is printed by `npm run eval:nlp`.

---

### Phase 3 — Geospatial, Correlation & Knowledge Search  *(6–8 days)*

**Goal:** finish PS requirement (i) and (ii) properly, plus O-iii and O-iv.

**3a — Map (O-ii)**
- Active-well origin is selectable: pick a well, click the map, or type lat/lng. Radius slider (0.5–50 km) drives a real server query.
- Layers: offset wells (radius + distance rings), **formation tops as coloured depth contours**, faults/fracture lines from geology data, active well trajectory polyline, section line A–A′.
- Marker symbology by risk level and by similarity rank; click-through to well dossier.
- **Vertical section view (A–A′):** project offset wells onto a section along the active well's azimuth, plot formation tops per well, and overlay offset events on the depth axis. This is the single most useful view for a drilling engineer and is currently missing entirely.
- Offline tile fallback: bundle a low-zoom raster tile pack or degrade to an offline base layer with a clear notice.

**3b — Depth & formation correlation engine (O-iv)**
- `server/correlation/`: given the active well + depth interval, return
  - offset events in `[d-Δ, d+Δ]` grouped by formation, ranked by composite weight = f(spatial distance, formation match, depth offset after TVD correction, trajectory similarity, severity)
  - per-offset casing-point comparison table (shoe depths vs active plan)
  - mud-programme diff (density, LCM type/ration) across offsets in the same formation
  - cementing-practice comparison for the relevant section
  - reservoir properties for the target formation across offsets
- Formation matching via correlated `formation_tops` with GR/lithology similarity — not string equality. `Formation X (upper member)` must match `Formation X` when the tops agree.

**3c — Knowledge repository & hybrid search (O-iii)**
- Lexical: Postgres `tsvector` + GIN over event narratives, mitigations, lessons, document chunks; `pg_trgm` for fuzzy well names.
- Semantic: `pgvector` embeddings (768-dim) over `document_chunks` + event narratives.
- Hybrid: Reciprocal Rank Fusion of BM25 + ANN vector search, re-ranked by spatial + formation + depth filters.
- Faceted filters: well, formation, depth band, event category, severity, date range, document type.
- Result rendering: **answer + citation card** (well, document, page, extracted snippet) — never a bare score.

```
POST /api/search            {q, filters, mode: lexical|semantic|hybrid}
GET  /api/search/facets     available filter values
GET  /api/wells/:id/dossier full well dossier: header, sections, mud, cementing, trajectory,
                            events, lessons, documents, alerts
POST /api/correlation/look-ahead   {wellId, depthMd, lookAheadM}
GET  /api/correlation/section/:wellId?azimuth=&halfWidthM=
GET  /api/formations        + /api/formations/:id/tops
```

**Done when:** moving the radius slider re-queries and re-draws the map from the server; a section view renders offset formation tops and events; typing "stuck pipe in Formation X above 3000 m" returns ranked, cited results in <1 s.

---

### Phase 4 — Real ML & Predictive Analytics  *(10–14 days)* — **the PS headline**

**Goal:** turn hand-tuned coefficients into trained, evaluated, versioned models covering **all five** named risks.

**4a — Feature store** (`ml/features/`)
Build a `FeatureStore` that emits one row per `(well_id, depth_md_m)` from telemetry + offset history + geology:

| Group | Features |
|---|---|
| Depth / stratigraphy | `depth_md`, `depth_tvd`, `formation_id`, `distance_to_formation_top_m`, `distance_to_next_formation_top_m`, `depth_rank_within_well` |
| Geomechanics | `pore_pressure_estimate_ppg` (from d-exponent), `fracture_gradient_estimate`, `mud_weight_ppg`, `underbalance_margin_ppg`, `overbalance_ratio`, `shale_flag`, `imbalance_flag` |
| Hydraulics / dynamics | `torque_knm` (+ 5-sample rolling mean/std), `drag_knm`, `torque_and_drag_index`, `rop_mhr`, `spp_psi`, `flow_out_lpm`, `pit_volume_delta_m3`, `ecd_ppg`, `hole_cleaning_index`, `flow_bit_ms` |
| Mechanics | `wob_ton`, `rop_woi`, `neutron–gamma-drilling_perturbed` |
| Offset context | `offset_event_density_±50m`, `nearest_offset_event_md`, `nearest_offset_severity`, `n_high_severity_offsets_±100m`, `mean_offset_npt_hours` |
| Similarity | `composite_similarity`, `rank`, `is_directly_comparable` |
| Time-series anomaly | `torque_zscore_vs_offset`, `spp_residual`, `flow_out_residual` |

All features are **normalised inside the pipeline** with parameters persisted per feature-set version — no hand-coded `clamp(x/8)` heuristics.

**4b — Models** (Python 3 + scikit-learn, offline training, exported to JSON, served by Node — reproducible, inspectable, no extra runtime)

| Model | Target | Algorithm | Notes |
|---|---|---|---|
| **M1 Stuck pipe** | binary, next 100 m | Gradient boosting + logistic baseline | Features: torque/drag index, cuttings/cleaning, imbalance, offset SP density. Report PR-AUC + recall at fixed precision. |
| **M2 Mud loss / lost circulation** | loss rate (bbl/min) regression + severity class | GBM regressor + isotonic calibrator | Features: ECD vs frac gradient, formation top proximity, offset loss density, LCM ration, trip state. |
| **M3 Kick / overpressure** | overpressure-zone probability + pore-pressure estimate | GBM classifier + gradient booster for pore pressure | Features: d-exponent, `shale_flag`, gas ratio, flow-out, offset kick density. **Delivers the PS "overpressure zones" requirement as a first-class model.** |
| **M4 Torque & drag spike** | anomaly detection on torque/drag | Isolation Forest + rolling robust z-score residual | Unsupervised — works even where labels are scarce. **Delivers the PS "torque spikes" requirement.** |
| **M5 Cementing risk** | job success probability | Logistic regression (small n, needs interpretability) | Features: shoe depth vs offset success, displacement efficiency, annular capacity vs volume, wait-on-cement, mud condition. **Delivers the PS "cementing issues" requirement.** |
| **M6 Hole / formation instability** | binary | GBM | Retains the existing category. |
| **M7 Well similarity** | similarity ranking | Weighted feature distance → learned weights, or a learned metric | Replaces the arbitrary `/2.2` normalisation with fitted + cross-validated weights. |

**4c — Training discipline (this is what separates a real model from a demo)**
- **Group split by well**, never random row split — otherwise the model memorises wells and the reported metrics are fiction.
- Time-aware split where relevant (train on older wells, validate on newer).
- Imbalance handling: class weights, not resampling.
- **Metrics per model**: PR-AUC, ROC-AUC, precision/recall/F1 at the operating threshold, Brier score + reliability curve (calibration matters for alerting), and confusion matrix at the chosen threshold.
- Threshold selection is a **business decision** — miss a kick is far worse than a false alarm — so make it configurable and justify it.
- Every model writes a **model card**: training data vintage, row counts, feature list, metrics, known failure modes, intended use, and the explicit "decision-support only, engineer review required" statement.
- Retraining is a **job**, versioned, with the previous model retained for rollback and A/B comparison.

```
ml/
  train.py  evaluate.py  model_card.py  requirements.txt
  data/  features.py  models/m1_stuck.py … models/m7_similarity.py
  artifacts/  →  m1_stuck.json (coefficients, normaliser, metrics, card, version, trained_at)
npm run ml:train   →  trains all models, writes artifacts + model cards, prints a metrics table
npm run ml:eval    →  group-CV report per model
```

**4d — Serving**
- `server/ml/` loads the artifacts, exposes `predict(wellId, depth, liveTelemetry)` → per-risk probability, calibrated level, top feature contributions, contributing offset wells, and the exact evidence rows.
- `/api/models` returns model cards; `/api/ml/explain` returns per-prediction contributions (this becomes a UI panel).

**Done when:** `npm run ml:eval` prints a metrics table with group-CV numbers; each of the 5 PS-named risks has a model and a card; no feature is a hand-tuned `clamp` of a raw reading; the inference path loads a versioned artifact rather than hard-coded weights.

---

### Phase 5 — eRTMAC Integration & Real-Time Pipeline  *(6–9 days)*

**Goal:** PS requirement (vi) and data source (vii) — a live operational feed.

**Ingest contract**
```
POST /api/ingest/telemetry      batch of samples (array, ≤5k), idempotent on (well_id, ts)
                                → {accepted, duplicates, rejected, gaps[]}
WS   /api/stream/telemetry      server → clients, JWT-authenticated, per-well subscription
WS   /api/stream/alerts
```
Plus an **adapter layer** so real feeds can be added without touching the API:
```
server/ingest/adapters/
  rest.js            (already covered above)
  mqtt.js            (MQTT subscribe → normalise → same pipeline)
  opcua.js           (OPC-UA subscription, if the rig network exposes it)
  fileReplayer.js    (replay a recorded WITSML/LAS/CSV trace — the demo path)
  simulator.js       (mechanistic real-time simulator)
```
Normalise everything to the canonical `telemetry_samples` shape. Support **WITSML** and **LAS** import as the industry-standard interchange formats — likely how OIL's existing systems will hand data over.

**Operational features**
- **Live context card:** current depth, formation, ROP, WOB, RPM, torque, drag, SPP, flow-out, pit volume, ECD, gas ratio, bit depth — with a normal/abnormal indicator per channel.
- **Look-ahead projection:** current ROP → estimated time to each upcoming risk boundary, so alerts say "*1,140 m ahead · ~14 h at current ROP*", not just a depth.
- **Gap/latency detection:** if no sample arrives in N seconds, show a stale-data banner and suppress alerts (never alert on stale data).
- **Ring buffer + backfill:** live window in memory, downsampled history in Postgres, so the rig-floor page stays fast.

**Done when:** with the simulator running, depth advances on the dashboard, alerts fire as the bit crosses an offset risk depth, latency and staleness are visible, and the demo works fully offline via `fileReplayer`.

---

### Phase 6 — Alerts, Recommendations & Explainability  *(5–7 days)*

**Goal:** turn scores into trustworthy, actionable, auditable alerts (PS iv + O-vi).

- **Rule engine** over `alert_rules`: per field / formation / risk type, configurable `look_ahead_m`, `trigger_score`, severity mapping, cooldown and dedupe key (`well+risk+window`).
- **Lifecycle:** `OPEN → ACKNOWLEDGED → CLOSED`, with mandatory resolution note, plus snooze. Full `audit_log`.
- **Every alert carries, in one view:**
  1. what the risk is and where (`from–to` m, metres and hours ahead)
  2. the calibrated score and level
  3. the top contributing features with values and direction
  4. the **contributing offset wells and historical events** with links to source documents and pages
  5. recommended actions, each tagged as `Evidence-based` / `Standard practice`, with the source that supports it
  6. the model's version and its known limitations
  7. an explicit **"Requires engineer review"** gate and an acknowledge-with-note action
- **Delivery:** in-app alert centre + top-bar banner + optional email/webhook. Every delivery logged.
- **Escalation:** sustained high-level alert escalates per rule; unacknowledged critical alerts raise.
- **Outcome capture:** when the active well passes through or clears a window, capture what actually happened → this becomes the **feedback label** that makes Phase 4's retraining honest, and powers a "was this alert useful?" precision dashboard.

```
GET  /api/alerts              filters: status, well, risk, severity, window
POST /api/alerts/evaluate     {wellId, depthMd, formation, telemetry}
POST /api/alerts/:id/ack      {note}
POST /api/alerts/:id/close    {outcome, actualEventType?, resolutionNote}
GET  /api/alerts/:id/explain  full evidence + feature contributions
GET  /api/alerts/effectiveness  precision/recall of past alerts vs outcomes
POST /api/alert-rules         CRUD (admin)
```

**Done when:** a demo can walk through *bit approaching 2,870 m → alert fires → engineer opens it → sees Well D's High Torque event with the WCR page → acknowledges with a note → alert state and audit log update live.*

---

### Phase 7 — Search, RAG & the Assistant  *(4–6 days)*

**Goal:** turn the assistant from hard-coded strings into a cited, grounded knowledge interface.

- Retrieval: hybrid (BM25 + pgvector) → RRF → filter by spatial radius / formation / depth band → rerank.
- Answer generation: pluggable LLM (default local Ollama) with a strict prompt: answer **only** from retrieved chunks, cite `[well · doc · page]` inline, say "insufficient evidence in the corpus" when not supported, and never emit an operational instruction that is not attached to a cited precedent.
- Fallback: deterministic extractive summariser (top evidence records) when no LLM is configured — the demo must never break.
- Guardrails: output is decision-support only; the disclaimer is rendered in the UI, not just in a README.
- Suggested-question generation derived from the **actual** current state (current depth, active risks, top offsets) rather than a fixed list.
- **Caching** on (question, context-hash) with a visible "based on N retrieved records" indicator.

```
POST /api/rag/answer   {question, wellId, depthMd, filters}
GET  /api/rag/suggestions
GET  /api/lessons-learned   filters + submit/correct/endorse
```

**Done when:** asking *"what did we do about mud loss in Formation X in offset wells?"* returns a cited, page-level answer, and asking something absent from the corpus correctly says so instead of hallucinating.

---

### Phase 8 — Frontend Rebuild & UX  *(10–14 days, parallelisable from Phase 1)*

Keep the existing visual language — it is genuinely good. Rebuild the substance.

**8a — Two purpose-built modes**
- **Rig-Floor mode:** huge touch targets, high contrast, glove-friendly, 3–4 things only — live depth, current alert, top look-ahead risk, one-tap evidence. Works offline (service worker + cached tiles + last-known state). Tablet-first, portrait and landscape.
- **Office mode:** dense analytics — cross-well comparison, section correlation, trend analysis, model performance, corpus management.

**8b — Pages**
| Route | Purpose |
|---|---|
| `/login` | existing, hardened |
| `/live` | **Rig-floor mode** (default when on-site) |
| `/` | Office overview: active well, top alerts, look-ahead, ranked offsets |
| `/map` | Full map with layers, radius, section line |
| `/section/:wellId` | **Vertical section A–A′** correlation view |
| `/wells`, `/wells/:id` | Explorer + full well dossier (sections, mud, cementing, trajectory, events, lessons, documents) |
| `/correlation` | Cross-well parameter overlay + casing/cementing/mud comparison tables |
| `/risk` | Risk analysis, per-model, with explanations |
| `/alerts` | Alert centre + lifecycle + effectiveness dashboard |
| `/events` | Event register, faceted search, map + depth views |
| `/documents` | Corpus browser, page viewer, extraction results |
| `/review` | **Human-in-the-loop extraction review queue** |
| `/knowledge` | Lessons-learned repository |
| `/models` | Model cards, metrics, feature list, limitations |
| `/admin` | Ingest, wells CRUD, event entry, alert rules, users, audit log |
| `/settings` | Radius, thresholds, units, density, notification prefs |

**8c — Frontend engineering**
- `src/api/*` typed client; TanStack Query for caching/refetch/invalidation; Zustand (or context+reducer) for cross-page state.
- Loading skeletons, error boundaries, empty states, toasts, optimistic updates with rollback.
- Route-level `React.lazy` code splitting; the initial bundle should not ship the chart library for the login screen.
- Design system extracted from `style.css` into tokens + primitives; `data-testid` on critical paths for E2E.
- Units toggle actually implemented (m↔ft, psi↔bar, SG↔ppg, kN·m↔lb·ft).
- Accessibility: keyboard nav, focus states, ARIA on charts/tables, colour-blind-safe severity encoding (never colour alone).
- PWA: manifest, service worker, offline tile fallback, installable.
- PDF shift-handover / daily summary export.

**Done when:** no page imports `src/data/*`; every number on screen comes from the API; the rig-floor page works with the network cable pulled.

---

### Phase 9 — Productionisation  *(6–8 days, continuous)*

**Security** (fix the real bugs found today)
- **Block role escalation** — `POST /api/auth/register` currently accepts `role` from the request body, letting anyone self-register as `admin`. Ignore client-supplied roles; default to `viewer`; admin assigns roles.
- Require `JWT_SECRET` at startup — **fail fast** rather than silently using `replace-this-demo-secret-before-production`.
- `CORS_ORIGIN` explicit allowlist, not `origin: true`.
- Rate-limit `/api/auth/*`; account lockout; JWT refresh tokens with rotation + revocation (denylist); shorter access-token TTL.
- Authorise **all** read endpoints by role; row-level scoping by field for non-admin users.
- `helmet`, `compression`, request size limits, `zod` validation on every input, `multer` limits (type, size, count), filename sanitisation, and content scanning on upload.
- Secrets only via env/secret manager; never logged; log redaction.

**Data & operations**
- Migration runner + rollback path; seed separated from boot; automated backups; documented restore.
- Structured logs (`pino`) with request IDs; expanded `/api/health` (DB, queue, OCR engine, model artifacts, feed status); basic metrics endpoint.
- Graceful shutdown; job retries with dead-letter; ingestion idempotency.

**Delivery**
- Multi-stage Dockerfiles, non-root user, `docker-compose` for local and a deploy manifest for the target environment.
- CI: lint → typecheck → unit → integration → build → E2E → image scan.
- Restore-from-backup runbook; DR check.

---

### Phase 10 — Documentation, Traceability & Demo  *(3–4 days)*

- `docs/ARCHITECTURE.md` — component, data-flow and deployment diagrams (Mermaid) + the eRTMAC integration diagram.
- `docs/DATA_MODEL.md` — ER diagram, depth-reference policy, controlled vocabularies.
- `docs/ML_MODEL_CARD.md` — one card per model, metrics, limitations, intended use.
- `docs/API.md` — OpenAPI 3 spec generated from the routes.
- `docs/RUNBOOK.md` — operate, back up, restore, rotate secrets, retrain.
- `docs/USER_GUIDE_RIG.md` and `docs/USER_GUIDE_OFFICE.md`.
- **`docs/TRACEABILITY.md` — the highest-value document for judging:** every PS clause (i–iv, O-i–vii, D-i–ix) → the screen that demonstrates it → the endpoint → the table → the test that proves it → the metric. Nothing claimed that isn't demonstrated.
- Rewrite `README.md` and `PROJECT_STATUS.md` truthfully, replacing "what needs to be done next" with "what is done, what is stubbed, what is out of scope".
- `docs/DEMO_SCRIPT.md` — the 8-minute walkthrough in `PROJECT_STATUS.md`, extended with the narrative: *ingest a document → extracted event appears in the register → same event raises an alert as the bit approaches → engineer sees the source page → acknowledges → the outcome is captured for retraining.* That closed loop is the story.
- A one-command `npm run demo` that boots DB + API + seeded corpus + simulated feed.

---

## Part 5 — Sequencing, Priority & Effort

### Dependency graph

```
Phase 0 Foundation ──┬──▶ Phase 1 Data Model ──┬──▶ Phase 2 OCR/NLP ──▶ Phase 7 RAG
                     │                         ├──▶ Phase 3 Geo/Correlation/Search
                     │                         ├──▶ Phase 4 ML Models ──▶ Phase 6 Alerts
                     │                         └──▶ Phase 5 eRTMAC ────┘
                     └──▶ Phase 8 Frontend (starts after 0; consumes 1,3,4,5,6,7)
                                        Phase 9 Productionisation (continuous)
                                        Phase 10 Docs & Demo (continuous)
```

### Critical path
`Phase 0 → Phase 1 → Phase 2 (OCR/NLP) → Phase 4 (ML) → Phase 6 (Alerts)` — this is the PS's intellectual core and it is sequential. Everything else can run in parallel.

### Effort summary

| Phase | Scope | Est. days | Can parallelise |
|---|---|---|---|
| 0 | Foundation & hygiene | 3–4 | — |
| 1 | Data model & corpus generator | 5–7 | with 0 (late) |
| 2 | Ingestion, OCR, NLP extraction | 8–12 | needs 1 |
| 3 | Geospatial, correlation, hybrid search | 6–8 | needs 1 |
| 4 | Real ML, 7 models, evaluation | 10–14 | needs 1; 2 improves labels |
| 5 | eRTMAC ingest & live pipeline | 6–9 | needs 1 |
| 6 | Alerts, explainability, lifecycle | 5–7 | needs 4 |
| 7 | RAG & assistant | 4–6 | needs 2, 3 |
| 8 | Frontend rebuild (8a–8c) | 10–14 | alongside 3–6 |
| 9 | Security, Docker, CI, observability | 6–8 | continuous |
| 10 | Docs, traceability, demo | 3–4 | continuous |
| | **Total** | **≈ 66–93 days** | |

### Two-track priority

Because this is a problem-statement submission with a judging demo, sequence it as:

**Track A — Demo-critical (≈ 6–8 weeks, 1–2 people)**
`0 → 1 → 3 → 4 (M1, M2, M3 only) → 6 → 7 → 8a/8b(Overview, Map, Section, Risk, Alerts, Events, Documents, Models) → 10`

**Track B — Production-critical (follow-on, 3–5 weeks)**
`2 (full OCR/NLP) · 4 (M4–M7 + retraining loop) · 5 (real eRTMAC/WITSML) · 8 (rig-floor PWA) · 9`

If only Track A is achievable, the *must-not-skip* items are: real trained models with printed metrics (otherwise it is not ML), server-driven map radius (otherwise requirement i is not met), the alerts-with-evidence walkthrough (otherwise requirement iv is not met), and the traceability document.

---

## Part 6 — Risks & Decisions Needed from OIL

| # | Risk / Question | Impact | Mitigation / Proposed default |
|---|---|---|---|
| R1 | **Data access.** Are real WCRs/DDRs/trajectories obtainable, and under what clearance? | Blocks Phases 2, 4, 5 entirely | Start with the synthetic generator; architect the loader so real data drops in unchanged. Raise an early data-request to OIL. |
| R2 | **eRTMAC integration.** Protocol and access path (REST? MQTT? OPC-UA? WITSML flat file? polling?) and read-only permission | Blocks Phase 5 | Build the adapter interface + `fileReplayer` now; the simulator is a first-class demo citizen, clearly labelled. |
| R3 | **LLM hosting.** Data-residency policy may forbid external APIs | Affects Phases 2 and 7 | Default to **local Ollama**; make the LLM optional; ensure the deterministic path is fully functional on its own. Never make an LLM load-bearing for correctness. |
| R4 | **Scanned vs digital reports.** Share of paper-only documents drives OCR budget | Phase 2 sizing | Tesseract.js handles both; budget 3–5 s/page for OCR and parallelise. If OCR quality is poor on OIL's scans, escalate to a self-hosted Tesseract/PaddleOCR service. |
| R5 | **Depth-reference consistency** across wells (KB elevation, MD vs TVD) | Silent, high-impact correlation errors | Enforce explicit `depth_reference` on every depth column from Phase 1; refuse comparisons without it; document the policy. |
| R6 | **Alert trust.** Engineers will ignore alerts if precision is poor | Kills the product | Ship precision/recall from day one, make thresholds configurable, show the evidence, start in an advisory-only mode, and publish an alert-effectiveness dashboard. |
| R7 | **Alerting vs safety.** NWIS must never issue autonomous operational direction | Reputational / safety | Hard-code the "decision-support only, engineer review required" gate in the API response *and* the UI; every recommendation is tagged `Evidence-based` or `Standard practice`; no write path to any control system. |
| R8 | **OCR/NLP accuracy on free-text drilling prose** | Phase 2 quality gate | Controlled vocabulary + cue-phrase patterns first, LLM second, human review for the tail. Report per-entity F1 honestly. |
| R9 | **Field connectivity.** Rig sites may have no reliable internet | Map and PWA | Offline-first PWA, cached tiles, `fileReplayer`, LAN deployment. |
| R10 | **Scope.** Nine data sources plus five ML models plus a PWA is a lot | Delivery | Two-track priority above; sequence strictly along the critical path. |

---

## Part 7 — Immediate Next 10 Tasks

| # | Task | Output | Est. |
|---|---|---|---|
| 1 | Add `.gitignore`, untrack `node_modules/` + `dist/`, add `.env.example` | Clean repo | 0.5 d |
| 2 | Decide nested-vs-flat repo and consolidate | Single source of truth | 0.5 d |
| 3 | Decompose `src/App.jsx` into pages/components/hooks (visual parity) | Maintainable frontend | 2 d |
| 4 | Build `src/api/client.js` + wire `GET /api/wells` into Well Explorer | First real UI↔API seam | 1 d |
| 5 | Add a serialiser so API and UI share one field contract | No more `undefined` | 0.5 d |
| 6 | Move synthetic data to `server/seeds/`; delete `server/ → src/data/` imports | Decoupled tiers | 0.5 d |
| 7 | Add Vitest + Supertest + Playwright smoke test, ESLint, CI | Safety net | 1.5 d |
| 8 | Write `docs/ARCHITECTURE.md` + `docs/DATA_MODEL.md` | Shared understanding | 1 d |
| 9 | Add the 5 missing tables (`formation_tops`, `lessons_learned`, `event_provenance`, `alerts`, `trajectory_surveys`) with migrations | Unblocks correlation + knowledge + alerts | 2 d |
| 10 | Replace `rankOffsetWells`' arbitrary `/2.2` with fitted, cross-validated similarity weights; add `ml/` skeleton with `train.py` + `model_card.py` and one real model (M1 Stuck Pipe) | Proves the ML path is genuine | 3 d |

---

## Appendix A — Verified API surface today

```
GET  /api/health                     public, returns ok + component list
POST /api/auth/register              public  ⚠ accepts client-supplied role
POST /api/auth/login                 public
GET  /api/auth/me                    JWT
GET  /api/wells?radiusKm=            public  ⚠ filters stored distance_km
GET  /api/wells/:id                  public
GET  /api/events?…7 filters          public  ⚠ SQL LIKE only
GET  /api/documents?well&q           public  ⚠ SQL LIKE only
GET  /api/telemetry?range=           public  ⚠ not scoped by well
GET  /api/risks                      public  ⚠ static src/data/risks.js
GET  /api/ml/architecture            public
GET  /api/ml/similarity              public  ⚠ hand-tuned weights
GET  /api/ml/clusters                public  ⚠ k-means over 5 points
GET  /api/ml/risk?depth=&formation=  public  ⚠ hand-tuned weights
POST /api/alerts/evaluate            public  ⚠ hard-coded threshold 40
GET  /api/alerts/current             public  ⚠ hard-coded threshold 40
GET  /api/recommendations            public
GET  /api/search?q=                  public  ⚠ SQL LIKE only
POST /api/admin/events               JWT + admin  ⚠ only write endpoint in the API
```

## Appendix B — Dead / unused code identified

| Item | Evidence | Action |
|---|---|---|
| `risk_training_samples` table | Written by `db.js:323`, read only by `SELECT COUNT(*)` at `ml.js:278` | Make it real training data, or delete it |
| `clusterWells` endpoint | k-means over 5 wells, k=3 | Keep but only meaningful post-Phase 1 corpus growth; otherwise cut |
| Tailwind / PostCSS / Autoprefixer | ~0 utility classes used; all styling is hand-written CSS | Remove |
| `similarity` column on `wells` | Hard-coded seed values (100/92/87/71/62); conflicts with computed `model_similarity` (67/…) | Replace with the fitted model output (Phase 4 M7) |
| `setAssistant` in `Overview` | Destructured but never used | Remove |
| `distance_km` column | Stored, but derivable from `lat`/`lng` | Compute; use PostGIS |
| `pore_pressure_gradient` / `fracture_gradient` | Seeded as `0.61 + index * 0.015` — an artefact of row order | Derive from real formation tops |
| `parameters_json` on events | Synthetic values from the array index | Populate from extracted telemetry/DDR context |
| `npt_hours` | Derived from severity + index | Extract from the source document |