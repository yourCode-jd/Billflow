# n8n setup (local)

1. Start local n8n, e.g. with Docker: `docker run --rm -it --name bill-agent-n8n -p 5678:5678 -v n8n_data:/home/node/.n8n docker.n8n.io/n8nio/n8n`. Create the owner account at `http://localhost:5678`; don't expose this port to the internet.
2. Create workflow: **Webhook** (POST, path `approved-bill`, Respond **Immediately**) → **Code** node → **Google Sheets: Append Row**.
   - In the Webhook node, choose **Authentication: Header Auth** and create a Header Auth credential: name `x-bill-agent-secret`, value equal to the private `N8N_SHARED_SECRET` in the app's `.env`. If you leave `N8N_SHARED_SECRET` blank for a short-lived local test, select **None** instead. Do not put the secret in the workflow's Code node or a sheet.
3. Webhook's live URL, once workflow activated: `http://localhost:5678/webhook/approved-bill`. Put it in `.env` as `N8N_WEBHOOK_URL`. For test workflow in editor use `/webhook-test/approved-bill` and **Listen for test event**.
4. Code node set to *Run once for all items*. Paste:

```javascript
const invoice = $input.first().json.body.invoice;
if (!invoice || !Array.isArray(invoice.items)) throw new Error('Invalid invoice payload');
return (invoice.items.length ? invoice.items : [{}]).map(item => ({json: {
  supplier: invoice.supplier || '',
  invoice_number: invoice.invoice_number || '',
  date: invoice.date || '',
  currency: invoice.currency ?? '',
  description: item.description || '',
  quantity: item.quantity ?? '',
  unit_price: item.unit_price ?? '',
  amount: item.amount ?? '',
  subtotal: invoice.subtotal ?? '',
  discount: invoice.discount ?? '',
  tax: invoice.tax ?? '',
  round_off: invoice.round_off ?? '',
  total: invoice.total ?? ''
}}));
```

5. Create a Google Sheet with headers `supplier, invoice_number, date, currency, description, quantity, unit_price, amount, subtotal, discount, tax, round_off, total`. In Google Cloud, enable both **Google Sheets API** and **Google Drive API**, configure the OAuth consent screen, then create a **Web application** OAuth client. In its authorized redirect URIs, paste the redirect URL displayed by n8n (normally `http://localhost:5678/rest/oauth2-credential/callback`). In n8n create Google Sheets OAuth2 credentials, enter the client ID and client secret there, sign in, and save. Configure **Append Row** and map header names to Code node fields.
6. Test with a *fake sample bill* first, and confirm each item appears as one sheet row.

**Security:** This is a localhost-only demo, not internet-safe. The Webhook Header Auth credential above validates the optional shared secret before the workflow runs. Use a long random value, keep it only in `.env` and n8n Credentials, and rotate it if exposed. If you expose n8n publicly, add authentication, request validation, rate limiting, duplicate prevention, and a private network/TLS setup before going live. n8n URLs/headers are not substitutes for login or business authorization.
