# MeetBrief AI

MeetBrief AI is an intelligent meeting minutes and follow-up Q&A assistant built with React, Vite, Express, TypeScript, and MongoDB.

## Prerequisites

- **Node.js**: >= 26.0.0
- **MongoDB**: Community Server running locally on default port `27017`
- **npm**: >= 10.0.0

## Repository Structure

```
meetbrief-ai/
├── docs/                # Architecture, API specifications, and prompts
├── server/              # Express + TypeScript backend (ESM, strict)
│   ├── src/             # Application source code
│   │   ├── config/      # Environment variable validation with zod
│   │   ├── app.ts       # Express app configuration, middleware, routes
│   │   └── index.ts     # MongoDB connection and server startup
│   ├── tests/           # Integration and unit tests (vitest, supertest)
│   ├── .env.example     # Template for server environment variables
│   └── tsconfig.json    # TypeScript compiler configuration
├── client/              # React + TypeScript frontend (Vite)
│   ├── src/             # React application source code
│   ├── vite.config.ts   # Vite configuration with /api dev proxy
│   └── tsconfig.json    # TypeScript configuration
└── .gitignore           # Git ignore rules for node_modules, .env, dist, uploads
```

## Setup Instructions

### 1. Configure Server Environment

Copy the example environment file in `server/`:

```bash
cd server
cp .env.example .env
```

Populate `.env` with your settings (never commit `.env`):

```ini
PORT=5000
MONGODB_URI=mongodb://127.0.0.1:27017/meetbrief
GEMINI_API_KEY=<your_api_key>
GEMINI_MODEL=gemini-2.5-flash
CLIENT_ORIGIN=http://localhost:5173
MAX_TEXT_CHARS=200000
MAX_AUDIO_MB=25
MAX_DOC_MB=10
```

### 2. Install Dependencies

Install server dependencies:
```bash
cd server
npm install
```

Install client dependencies:
```bash
cd client
npm install
```

## Running the Application

### Start Backend Development Server

```bash
cd server
npm run dev
```
The server will connect to MongoDB and listen on `http://localhost:5000`.

### Start Frontend Development Server

```bash
cd client
npm run dev
```
The client will start on `http://localhost:5173` with proxy forwarding `/api` requests to `http://localhost:5000`.

## Limitations

PDF text extraction runs synchronously; a generated 300-page, text-heavy PDF (1,582,268 bytes and 1,396,439 extracted characters) took 577 ms and 553 ms across two local runs, delaying a zero-delay timer by 577 ms and 553 ms respectively.

## Testing and Verification

### Server Checks
```bash
cd server
npm run typecheck   # Typecheck without emit
npm test            # Run Vitest test suite
npm run build       # Compile TypeScript
```

Verify backend health check endpoint:
```bash
curl http://localhost:5000/api/health
# Response: {"data":{"ok":true}}
```

### Client Checks
```bash
cd client
npm run typecheck   # Typecheck without emit
npm test            # Run Vitest test suite
npm run build       # Build production bundle
```
