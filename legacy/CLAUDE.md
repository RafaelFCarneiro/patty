# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

FinTrack is a personal finance manager (Mobills-inspired) with a React frontend and NestJS backend backed by MongoDB.

## Development setup

```bash
# Start MongoDB + Mongo Express (required first)
docker compose up -d

# Backend (port 3001)
cd backend && npm install && npm run start:dev

# Frontend (port 5173, new terminal)
cd frontend && npm install && npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001/api
- Mongo Express UI: http://localhost:8081 (admin / fintrack123)

## Commands

### Frontend (`cd frontend`)
```bash
npm run dev        # dev server
npm run build      # tsc + vite build
npm run lint       # eslint
```

### Backend (`cd backend`)
```bash
npm run start:dev  # watch mode
npm run build      # nest build
npm run lint       # eslint --fix
npm test           # jest (unit, *.spec.ts in src/)
npm run test:e2e   # jest with test/jest-e2e.json
npm run test:cov   # coverage
npm run format     # prettier
```

To run a single backend test file:
```bash
cd backend && npx jest src/accounts/accounts.service.spec.ts
```

## Architecture

### Backend (NestJS + Mongoose)

Each domain follows a strict module pattern at `backend/src/<domain>/`:
- `<domain>.module.ts` — imports schema, exports service
- `<domain>.controller.ts` — REST routes under `/api/<domain>`
- `<domain>.service.ts` — business logic, Mongoose queries
- `schemas/<entity>.schema.ts` — Mongoose `@Schema` class
- `dto/create-<entity>.dto.ts` and `update-<entity>.dto.ts`

Domains: `accounts`, `transactions`, `categories`, `tags`, `credit-cards`, `budgets`, `goals`, `dashboard`, `reports`.

MongoDB connection is hardcoded in `app.module.ts`: `mongodb://localhost:27017/fintrack`.

The `dashboard` and `reports` modules are read-only aggregation services — they have no schemas of their own and query across other collections.

### Frontend (React + Vite + TanStack Query)

Path alias `@` maps to `frontend/src/`.

Key layers:
- `src/api/` — one file per domain, each exports typed fetch functions using the shared axios `client.ts` (`baseURL: http://localhost:3001/api`). Ramda's `R.prop('data')` is used uniformly to unwrap axios responses.
- `src/pages/` — one component per route, directly consumes `useQuery`/`useMutation` from `@tanstack/react-query`.
- `src/components/ui/` — shared primitives: `Button`, `Input`, `Select`, `Modal`, `Badge`, `SummaryCard`, `EmptyState`, `PageHeader`.
- `src/components/layout/` — `Layout` (sidebar + `<Outlet>`), `Sidebar`, `MonthPicker`.
- `src/hooks/useMonth.ts` — shared month/year state with `prev`/`next` navigation; most pages accept `{ month, year }` from this hook.
- `src/lib/utils.ts` — `cn()` (clsx + tailwind-merge), `formatBRL()`, `MONTH_NAMES`, `pieColor()`.

The app runs in forced dark mode (`<div className="dark">`). Tailwind dark-mode classes are always active.

QueryClient is configured globally in `App.tsx` with `staleTime: 30_000` and `retry: 1`.

### Data model conventions

- MongoDB `_id` (ObjectId string) is used as the primary key everywhere.
- Transactions reference `categoryId`, `accountId`, `creditCardId`, and `tags[]` as ObjectId refs — the backend populates these on reads.
- Amounts are stored as plain numbers (BRL cents are **not** used; values are full reais).
- Month/year filtering is done via query params (`?month=5&year=2026`) throughout the API.
