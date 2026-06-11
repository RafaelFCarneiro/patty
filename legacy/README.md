# FinTrack

Personal finance manager — React + NestJS + MongoDB clone of Mobills.

## Prerequisites

- Node.js 20+
- Docker + Docker Compose

## Quick start

```bash
# 1. Start infrastructure
docker compose up -d

# 2. Start backend
cd backend
npm install
npm run start:dev

# 3. Start frontend (new terminal)
cd frontend
npm install
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001/api
- Mongo Express (DB UI): http://localhost:8081 (admin / fintrack123)

## Stack

| Layer     | Tech                          |
|-----------|-------------------------------|
| Frontend  | React + Vite + TypeScript     |
| Styling   | Tailwind CSS (dark mode)      |
| Charts    | Recharts                      |
| Data      | TanStack Query + Axios        |
| FP utils  | Ramda                         |
| Backend   | NestJS                        |
| Database  | MongoDB (Mongoose)            |
| Infra     | Docker Compose                |

## Sections

- Dashboard — summary cards, charts, mini calendar
- Contas — bank accounts CRUD
- Transações — full transaction list with filters
- Cartões de crédito — credit card management
- Planejamento — monthly budget tracking
- Relatórios — pie/bar/line charts by category and month
- Objetivos — financial goals with progress
- Categorias — income/expense categories with subcategories
- Tags — custom transaction tags
- Calendário — monthly calendar view with daily totals
- Meu Desempenho — savings rate & performance metrics
- Importar/Exportar — CSV export, file import
- Configurações — app preferences
