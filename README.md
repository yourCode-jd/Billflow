# Billflow — Bill AI Agent (Local Demo)

A working proof-of-concept for **bill upload → n8n (Gemini extraction, validation, duplicate check) → Google Sheets → dashboard status, review/edit and CSV download**.

## Requirements
- Linux, Node.js 20+ (Node 22+ recommended)
- The n8n Cloud upload and submission-status workflows (they hold the Gemini and Google Sheets credentials; Billflow needs no Gemini key)

## Start
```bash
cp .env.example .env
# Edit .env and set N8N_WEBHOOK_URL (the n8n upload webhook) and BILL_AI_WEBHOOK_SECRET (do not post secrets in chat)
node server/index.js
```
Open `http://localhost:3000`.

Run the tests with `npm test` (Node's built-in test runner; no dependencies).

## Workflow
1. Upload a JPG/PNG/WebP/PDF (up to 10MB).
2. n8n sends it to Gemini, which identifies invoice fields and item rows, and writes the result to Google Sheets. The dashboard checks the status and shows the result for review. Empty/uncertain values require human correction.
3. Carefully check and edit values (including GSTIN and payment mode) and mark the approval checkbox. Any edit clears the checkbox.
4. Download CSV. **Send to n8n** is not supported with the current n8n Cloud setup: approvals are saved to invoice history only (see Boundaries).
5. Use **Invoice history** to download a CSV of all invoices, the selected invoices, or a single invoice. Every line item is a row.

## Invoice history
- Stored in a local JSON file, `data/invoices.json` by default (set `BILL_AI_HISTORY_FILE` to change it). `data/` is git-ignored; back the file up if the history matters.
- An invoice is added when the dashboard's status lookup reports a saved, non-duplicate invoice from n8n, or when you approve it with **Send to n8n**. The approved version is kept even if n8n is not configured or unreachable.
- After an upload, the dashboard re-checks the submission automatically: at most 20 checks over 7 minutes (intervals grow from 2 s to 30 s, since slow n8n runs have taken about 6 minutes), stopping as soon as the invoice is found or marked duplicate. The progress text shows the time elapsed and the next check. If processing takes longer, it shows **Still processing** and keeps the submission ID ready for **Restore invoice**. Reloading the page makes one status check and does not resume the automatic checks.
- You can select several invoices at once (up to 10). Each is uploaded separately with its own submission ID and status row; one failure does not affect the others. Starting a new batch clears the previous batch's rows (those submissions are still checked and recorded in history).
- If Gemini fails (for example 503 "unavailable", 429 "too many requests" or a connection error), n8n records an **Extraction Failed** marker and the dashboard shows that instead of waiting. Temporary failures are sent again automatically after 30 s and 2 min (at most 2 retries, new submission ID each time); other failures show **Retry**. The n8n side of this is live (PROJECT_STATUS.md, section 6). A failure in a later n8n step (for example a photo that is not an invoice) is not reported and ends on **Still processing**.
- There is one record per submission ID. Re-approving or re-checking an invoice updates its record instead of adding another; an approved version is never replaced by a later status lookup. Approvals without a submission ID are matched by supplier and invoice number.
- **Download CSV** in the review step does not add to history. Invoices processed in n8n but never opened in this dashboard do not appear; history is not synced from Google Sheets.
- History CSVs use the same columns as the single-invoice CSV, with the same formula-injection escaping. There is no delete, edit, search or paging in the history panel.

## CSV format (custom columns)
- Open **CSV format** in the Invoice history card to choose, order and rename columns. A preview shows the first rows exactly as they will be exported. The format applies to every CSV download: the review step, a single invoice, selected invoices and all invoices. Each line item is still one row.
- Save the format as a named preset, then reuse, update, rename or delete it. Presets are stored in this browser's localStorage only; they are not shared between browsers or users.
- **Default format** is the original 13-column CSV and is unchanged. Optional **Line number**, **GSTIN** and **Payment mode** columns are also available.
- Column names are escaped like cell values, so a name such as `=SUM()` is exported as text.

## Boundaries
- Prototype only; do not use it for accounting or GST filing without further verification.
- **Send to n8n is not supported** in the current setup. `N8N_WEBHOOK_URL` must be the n8n Cloud upload webhook, but approvals may only be forwarded to a localhost URL, so every approval is refused ("Remote webhook blocked in demo"). The approved invoice is kept in local history; nothing reaches n8n or Google Sheets.
- Uploaded files are not stored on the local server; invoice details are stored in the local history file described above. The uploaded bill **is sent through n8n to Google's Gemini API** for extraction. Check data-use terms of the chosen API tier before real customer data.
- Duplicate bills are detected by the n8n workflow, and the dashboard shows a warning without creating a duplicate record.
- No logins or multi-user separation: anyone who can reach the local server can see and export the whole history. No database, background tasks or live WhatsApp integration.
- Validation warns about missing fields and arithmetic differences, including a printed subtotal or GST that does not match the line items; such bills show **Needs Review · Flagged** for a person to check. It is not full tax compliance validation.
- Requires a functioning internet connection for Gemini / Google Sheets.
- API keys must remain on the server side in `.env`.
