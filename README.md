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

Run the tests with `npm test` (Node's built-in test runner; no dependencies).

## Workflow
1. Upload a JPG/PNG/WebP/PDF (up to 10MB).
2. Gemini identifies invoice fields and item rows. Empty/uncertain values require human correction.
3. Carefully check and edit values and mark the approval checkbox.
4. Download CSV immediately for free, or follow `n8n/WORKFLOW.md` to configure n8n and Google Sheets.
5. Use **Invoice history** to download a CSV of all invoices, the selected invoices, or a single invoice. Every line item is a row.

## Invoice history
- Stored in a local JSON file, `data/invoices.json` by default (set `BILL_AI_HISTORY_FILE` to change it). `data/` is git-ignored; back the file up if the history matters.
- An invoice is added when the dashboard's status lookup reports a saved, non-duplicate invoice from n8n, or when you approve it with **Send to n8n**. The approved version is kept even if n8n is not configured or unreachable.
- After an upload, the dashboard re-checks the submission automatically: at most 20 checks over 7 minutes (intervals grow from 2 s to 30 s, since slow n8n runs have taken about 6 minutes), stopping as soon as the invoice is found or marked duplicate. The progress text shows the time elapsed and the next check. If processing takes longer, it shows **Still processing** and keeps the submission ID ready for **Restore invoice**. Reloading the page makes one status check and does not resume the automatic checks.
- You can select several invoices at once (up to 10). Each is uploaded separately with its own submission ID and status row; one failure does not affect the others.
- If Gemini fails (for example 503 "unavailable" or a connection error), n8n records an **Extraction Failed** marker and the dashboard shows that instead of waiting. Temporary failures are sent again automatically after 30 s and 2 min (new submission ID each time); other failures show **Retry**. This needs the n8n changes described in PROJECT_STATUS.md, section 6.
- There is one record per submission ID. Re-approving or re-checking an invoice updates its record instead of adding another; an approved version is never replaced by a later status lookup. Approvals without a submission ID are matched by supplier and invoice number.
- **Download CSV** in the review step does not add to history. Invoices processed in n8n but never opened in this dashboard do not appear; history is not synced from Google Sheets.
- History CSVs use the same columns as the single-invoice CSV, with the same formula-injection escaping. There is no delete, edit, search or paging in the history panel.

## CSV format (custom columns)
- Open **CSV format** in the Invoice history card to choose, order and rename columns. A preview shows the first rows exactly as they will be exported. The format applies to every CSV download: the review step, a single invoice, selected invoices and all invoices. Each line item is still one row.
- Save the format as a named preset, then reuse, update, rename or delete it. Presets are stored in this browser's localStorage only; they are not shared between browsers or users.
- **Default format** is the original 13-column CSV and is unchanged. An optional **Line number** column is also available.
- Column names are escaped like cell values, so a name such as `=SUM()` is exported as text.

## Boundaries
- Prototype only; do not use it for accounting or GST filing without further verification.
- Uploaded files are not stored on the local server; invoice details are stored in the local history file described above. The uploaded bill **is sent through n8n to Google's Gemini API** for extraction, and approved information is sent to n8n only when requested. Check data-use terms of the chosen API tier before real customer data.
- Duplicate bills are detected by the n8n workflow, and the dashboard shows a warning without creating a duplicate record.
- No logins or multi-user separation: anyone who can reach the local server can see and export the whole history. No database, background tasks or live WhatsApp integration.
- Validation warns about missing fields and arithmetic differences, including a printed subtotal or GST that does not match the line items; such bills show **Needs Review · Flagged** for a person to check. It is not full tax compliance validation.
- Requires a functioning internet connection for Gemini / Google Sheets.
- API keys must remain on the server side in `.env`.
