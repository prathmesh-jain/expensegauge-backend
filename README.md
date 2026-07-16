# ExpenseGauge Backend

ExpenseGauge is a personal finance backend built with **Node.js, Express and MongoDB**. It powers the ExpenseGauge mobile app by handling authentication, expense tracking, account management, analytics, PDF report generation, admin-managed users, and application update checks.

The project started as a finance tracker, but grew around a few engineering problems that mobile apps commonly face: **keeping balances consistent, supporting offline usage, preventing duplicate requests, and keeping authentication secure**.

---

# Table of Contents

- Overview
- Architecture
- Tech Stack
- Project Structure
- Getting Started
- Environment Variables
- Authentication
- API Modules
- Engineering Highlights
- Scripts

---

# Overview

The backend exposes a REST API built on **Express 5** and **MongoDB (Mongoose)**.

It supports two user models:

- Regular users managing their own finances
- Admins who can create and manage subordinate users and assign balances

Main capabilities include:

- Email/password authentication and Google OAuth
- Refresh token rotation
- Multi-account bookkeeping
- Running balance (`afterBalance`) stored per transaction
- Offline-first synchronization using client-generated IDs
- Monthly statistics and analytics
- Server-generated PDF reports emailed through Brevo
- Mobile app update checking (OTA / APK / Play Store)

---

# Architecture

```text
Mobile App
      │
      ▼
 Express API
 ├── Routes
 ├── Controllers
 ├── Models
 └── Utilities
      │
      ▼
 MongoDB
```

Project follows a simple layered architecture.

- **Routes** only map endpoints.
- **Controllers** contain business logic.
- **Models** define schemas and indexes.
- **Utilities** contain reusable helpers like balance calculation, caching and email sending.

---

# Tech Stack

| Area | Technology |
|------|------------|
| Runtime | Node.js (ESM) |
| Framework | Express 5 |
| Database | MongoDB + Mongoose |
| Authentication | JWT, bcrypt, Google OAuth |
| Email | Brevo |
| PDF | PDFKit |
| Environment | dotenv |
| Development | Nodemon |

---

# Project Structure

```text
backend/
├── controllers/
├── routes/
├── models/
├── utils/
├── config/
├── assets/
└── app.js
```

The codebase keeps routing thin while placing validation and business logic inside controllers.

---

# Getting Started

```bash
git clone <repo>

cd backend
npm install

cp .env.example .env

npm start
```

Default server:

```
http://localhost:8000
```

---

# Environment Variables

```env
MONGO_URL=
ACCESS_SECRET=
REFRESH_SECRET=
GOOGLE_CLIENT_ID=
BREVO_API_KEY=
PORT=8000
```

---

# Authentication

- JWT access tokens
- Refresh tokens with rotation
- Google OAuth login
- Password reset using OTP
- User and Admin roles

Every protected route validates the access token before executing business logic.

---

# API Modules

| Module | Responsibilities |
|--------|------------------|
| User | Signup, Login, Google OAuth, Profile, Password Reset |
| Expense | Expense CRUD, Reports, Statistics |
| Account | Multi-account management |
| Admin | Managed users, Balance assignment |
| Update | Mobile application update checks |

---

# Engineering Highlights

These are the parts of the project that required the most design work.

## Transactional balance updates

Financial operations are executed inside MongoDB transactions so expense records, account balances and running balances are updated together.

## Offline-first synchronization

Each expense can include a client-generated `clientId`. Combined with a unique database index, duplicate requests are ignored safely, allowing queued mobile requests to retry without creating duplicate expenses.

## Running balance timeline

Each transaction stores its resulting balance (`afterBalance`). The mobile app can immediately render balance history without recalculating every previous transaction.

## Multi-account bookkeeping

Users can manage multiple funding sources while always keeping a guaranteed Primary Account. If an offline request references a deleted account, the backend automatically falls back to the Primary Account instead of failing the sync.

## Cached analytics

Monthly statistics and analytical reports are cached per user and invalidated only when financial data changes.

## PDF reports

Reports are generated completely on the server and emailed to users, avoiding client-side rendering while keeping formatting consistent across devices.

## Role-based access

Regular users only access their own data, while admins can manage assigned users and perform administrative operations.

---

# Scripts

| Script | Description |
|--------|-------------|
| npm start | Start development server with Nodemon |
| npm test | Placeholder |

---

# Future Improvements

- Unit and integration tests
- Docker support
- Redis for distributed caching
- OpenAPI documentation
- Background job queue
- CI/CD pipeline

---

Made by **Prathmesh Jain**
