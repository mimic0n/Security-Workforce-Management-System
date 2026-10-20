# SWMS — Security Workforce Management System

> **LIFE-SAFETY DISCLAIMER:**
> SWMS is an academic thesis project and a simulation-only decision support layer designed for AEON Mall Thanh Khê, Floor 1. It is never deployed to a real production site. Real fire alarm, evacuation, and life safety procedures (PCCC) operate completely independently of this software. SWMS must never be relied upon for life safety, fire fighting, or emergency evacuation in real life.

## Overview
SWMS addresses security workforce understaffing by calculating dynamic headcounts, enforcing Zero-Vacancy on Tier 1 posts, auto-dispatching replacements with concurrency locking, and verifying guard presence via GPS and QR challenges.

## Tech Stack
- Monorepo (npm workspaces)
- NestJS (modular monolith)
- PostgreSQL 16 (`btree_gist` extension, transactional advisory locks)
- TypeScript strict, Vitest, Socket.IO, pg-boss

## Getting Started
```bash
docker compose up -d
npm install
npm run db:migrate
npm run db:seed
npm test
```
