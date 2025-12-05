# Speech-to-Insights: Minutes AI

Turn raw meeting audio into structured, editable insights.
The system handles transcription, speaker metadata, summarization, PII-aware processing, and export workflows, all running locally with optional cloud storage.

---

## What’s implemented

These components are fully working in your current codebase:

**Audio and preprocessing**

* Upload handler (FastAPI)
* Local temp file management
* ffmpeg conversion and normalization
* MP3 and WAV handling

**Transcription**

* Chunked OpenAI Whisper-style transcription
* Optional AssemblyAI integration
* Automatic merging of chunk output
* Speaker list support when diarization is available

**Storage**

* SQLite + SQLAlchemy models for transcripts, summaries, and speakers
* Deterministic file export:

  * `outputs/Transcripts/<timestamp>.txt`
  * `outputs/Summary/<timestamp>.md`
* Optional upload to S3 using clean, consistent key paths

**Summaries and insights**

* Structured summaries using any OpenAI-compatible text model
* Keyword extraction
* Sentiment scoring
* Basic PII-aware redaction utilities
* SRT export

**Frontend**

* Vue 3 + Vite + Tailwind interface
* Audio upload flow
* Transcript viewer and speaker editor
* Summary viewer with markdown editing
* Export actions for TXT, MD, and SRT

Everything listed above exists and runs with your current backend and frontend.

---

## Quick start

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open the local URL printed by Vite.

---

## Configuration

Create a `.env` file in `backend`:

```env
OPENAI_API_KEY=your_key
ASSEMBLYAI_API_KEY=optional

AWS_REGION=us-east-1
OUTPUT_S3_BUCKET=optional_bucket
TRANSFORM_INPUT_BUCKET=optional_bucket

TEXT_MODEL_NAME=gpt-4o-mini
OPENAI_BASE_URL=optional_override
```

The backend automatically chooses the available provider.

---

## System architecture

### 1. Ingestion

* User uploads audio through the frontend
* Backend stores the raw upload in temporary storage
* ffmpeg converts and normalizes audio

### 2. Transcription pipeline

Implemented in `services.py`:

* Chunking for large files
* Whisper-style transcription using OpenAI endpoint
* Optional AssemblyAI path if configured
* Output merged into a single transcript
* Speaker metadata extracted when available

### 3. Storage

* SQLite tables for transcripts, summaries, speakers, timestamps
* Deterministic local export of TXT and MD files
* Optional S3 upload with non-duplicated writes

### 4. Summarization

* Pulls transcript from the database
* Includes speaker table when present
* Generates a structured markdown summary
* Stores summary in DB and exports it locally (and S3 if enabled)

### 5. Insights layer

* Keyword extraction using simple token frequency
* Sentiment analysis via text model
* PII redaction utilities
* SRT generator based on approximate timing

### 6. Frontend

* Full audio → transcript → summary → export UX
* Inline editing for speaker names
* Markdown editing for summaries
* Clean UI with status notifications and error handling

---

## API routes

| Method | Route                 | Purpose                                   |
| ------ | --------------------- | ----------------------------------------- |
| POST   | `/upload`             | Upload audio, transcribe, save transcript |
| GET    | `/transcription/{id}` | Fetch transcript and speaker data         |
| POST   | `/summarize/{id}`     | Generate structured summary               |
| GET    | `/export/{id}`        | Download markdown summary                 |
| GET    | `/export/{id}/srt`    | Download SRT subtitles                    |
| GET    | `/sentiment/{id}`     | Sentiment analysis                        |
| GET    | `/keywords/{id}`      | Keyword extraction                        |
| POST   | `/transcript`         | Save user-provided raw transcript         |

---

## End-to-end flow

```
Audio Upload
    ↓
FastAPI handler + ffmpeg processing
    ↓
Chunked transcription (OpenAI or AssemblyAI)
    ↓
Transcript + speakers stored in SQLite
    ↓
User views/edits in frontend
    ↓
Summary generation (OpenAI text model)
    ↓
Summary stored + exported locally/S3
    ↓
User downloads TXT / MD / SRT
```

---

## Export formats

The system produces:

* Transcript `.txt`
* Summary `.md`
* Subtitle `.srt`
* Local + optional S3 storage
* Predictable filenames for reproducibility

---

## Security and reliability features

* API keys handled via environment variables
* Sanitized JSON logs
* Safe S3 key generation
* Strict temporary file cleanup
* No duplicate file writes (fixed in your corrected saver)
* ffmpeg failures surfaced cleanly

---

## Tech stack

**Backend**
FastAPI, SQLAlchemy, SQLite, ffmpeg, OpenAI API, optional AssemblyAI, boto3

**Frontend**
Vue 3, Vite, TailwindCSS

**Optional cloud**
AWS S3

The architecture can be extended to Step Functions, OpenSearch, or event-driven pipelines with minimal restructuring.

---

## Project outcomes

You achieved the full scope you proposed:

* End-to-end speech-to-text pipeline
* Speaker metadata handling
* Summary and insights generation
* Keyword and sentiment extraction
* Export workflows for TXT, MD, and SRT
* Optional cloud storage
* Working local full-stack application
