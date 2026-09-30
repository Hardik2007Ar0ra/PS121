# NWIS — Nearby Wells Intelligence System

NWIS is a frontend-only prototype for exploring synthetic drilling and offset-well data. It is designed as an operational-style dashboard for the SIH 2026 Problem Statement 121 demo. The interface uses a dark graphite and muted plum palette with warm amber accents; blue is not used as the dominant color.

> **Prototype notice:** All wells, coordinates, drilling telemetry, events, similarity scores, risk scores, and extracted document text in this project are synthetic. Risk and similarity values are deterministic demonstration heuristics, not validated predictions. The app has no backend, database, authentication, real machine-learning or OCR system, or operational drilling controls. Engineer review is required for any operational decision.

## What the app includes

- **Overview (`/`)** — active well metrics, interactive offset-well map, upcoming risk context, depth correlation, synthetic telemetry charts, ranked offset wells, and a deterministic local assistant.
- **Well Explorer (`/wells`)** — select the active or an offset well to inspect its synthetic metadata, events, and depth profile.
- **Risk Analysis (`/risk`)** — Stuck Pipe, Lost Circulation, Kick, and Formation Instability cards with prototype scores, intervals, telemetry context, historical evidence, and informational mitigation context.
- **Historical Events (`/events`)** — searchable event register with filters for well, event, formation, severity, and depth range.
- **Documents (`/documents`)** — synthetic document repository with indexed metadata and evidence modals containing mock extracted text.
- **Settings (`/settings`)** — adjust the offset search radius and alert threshold, switch units, toggle the alert banner, and set/reset the demo depth.
- **Demo simulation** — advance the active depth through 2,850 → 2,875 → 2,900 → 2,925 m. The displayed depth, risk messaging, chart marker, and related metrics update with the selected depth.
- **Responsive layout** — sidebar navigation and dashboard cards adapt for smaller screens.

## Technology and tools

| Technology | Use |
| --- | --- |
| React | UI components and shared application state |
| JSX / JavaScript (ES modules) | Application code; this project does not use TypeScript |
| Vite | Local development server and production bundling |
| React Router | Client-side routes |
| Recharts | Depth correlation and synthetic telemetry charts |
| Leaflet + React-Leaflet | Interactive map, markers, popups, and 5 km radius |
| OpenStreetMap | Map tile layer and attribution |
| Lucide React | Interface icons |
| Tailwind CSS + PostCSS + Autoprefixer | CSS tooling; the dashboard's visual styling is primarily in `src/style.css` |

The map uses OpenStreetMap's public tile service and therefore needs an internet connection for map tiles. No application API key is used. Fonts are loaded from Google Fonts when available; system sans-serif fallbacks are provided.

## Requirements

- Node.js 18 or newer
- npm
- Internet access for OpenStreetMap tiles (and optional Google Fonts)

## Run locally

From the project root:

```bash
npm install
npm run dev
```

Vite prints a local URL in the terminal, usually `http://localhost:5173`. Open that URL in a browser.

## Available scripts

```bash
npm run dev      # Start the Vite development server
npm run build    # Create a production build in dist/
npm run preview  # Serve the production build locally
```

## Project layout

```text
.
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
└── src/
    ├── main.jsx             # React entry point and global styles
    ├── App.jsx              # Routes, shared state, pages, and reusable UI
    ├── style.css            # Theme, layout, responsive rules, and component styles
    └── data/
        ├── wells.js         # Synthetic active and offset well records
        ├── events.js        # Synthetic historical event register
        ├── telemetry.js    # Deterministic synthetic chart data
        ├── risks.js         # Prototype risk categories and evidence summaries
        └── documents.js    # Synthetic repository metadata and extracted text
```

## Data and behavior

Mock records are plain JavaScript exports under `src/data/`. Telemetry is generated deterministically from fixed formulas, so charts do not change randomly between renders. The local assistant selects a predefined response and source labels; it does not call an LLM or remote service.

Shared React state in `src/App.jsx` keeps the current simulation depth, selected well, and open detail modal available across the interface. Event filters and telemetry chart controls use local component state. The demo reset returns the depth to 2,850 m.

To connect a future backend, replace or wrap the modules in `src/data/` with a data service and retain the existing UI-facing record shapes where possible. Risk scores, similarity scores, and sample document extracts should not be treated as production logic.

## Build and deploy

Create and locally preview the production bundle:

```bash
npm run build
npm run preview
```

The generated static site is in `dist/` and can be hosted by any static web host. Configure the host to serve `index.html` for client-side routes so direct navigation to paths such as `/risk` continues to work.

## Current prototype boundaries

- No backend, database, sign-in, API credentials, real telemetry stream, OCR pipeline, or machine-learning inference.
- Map markers and well records use demonstration coordinates and content.
- Risk and similarity scores are illustrative prototype values and are not scientifically validated.
- OpenStreetMap tiles need network access; the map itself does not ship offline tiles.
- This prototype provides informational historical context only and does not issue autonomous drilling instructions.
