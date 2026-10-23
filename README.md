# Billflow — Bill AI Agent (Local Demo)

A working proof-of-concept for **bill upload → Gemini extraction → review/edit → approved CSV download or local n8n webhook → Google Sheets**.

## Requirements
- Linux, Node.js 20+ (Node 22+ recommended)
- Gemini API key with quota and access to a vision/PDF-capable Gemini model
- (Optional) Docker + local n8n + Google Sheets credentials

## Start
```bash
cp .env.example .env
# Edit .env and set GEMINI_API_KEY (do not post your key in chat)
node server/index.js
```
Open `http://localhost:3000`.

## Workflow
1. Upload a JPG/PNG/WebP/PDF (up to 10MB).
2. Gemini identifies invoice fields and item rows. Empty/uncertain values require human correction.
3. Carefully check and edit values and mark the approval checkbox.
4. Download CSV immediately for free, or follow `n8n/WORKFLOW.md` to configure n8n and Google Sheets.

## Boundaries
- Prototype only; do not use it for accounting or GST filing without further verification.
- No data stored on our local server; the uploaded bill **is sent to Google's Gemini API** for extraction and approved information is sent to n8n only when requested. Check data-use terms of the chosen API tier before real customer data.
- No logins, history, duplicate tracking, background tasks or live WhatsApp integration.
- Validation warns about missing fields and arithmetic differences; it is not full tax compliance validation.
- Requires a functioning internet connection for Gemini / Google Sheets.
- API keys must remain on the server side in `.env`.
