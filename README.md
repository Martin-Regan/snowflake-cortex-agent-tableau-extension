# F1 Tableau Cortex Extension

A Tableau Dashboard Extension that connects a dashboard to a Snowflake Cortex Agent. Users can ask Formula 1 questions in natural language, receive an AI response, and have the dashboard filtered automatically.

This repository contains the Tableau extension web app, the `.trex` manifest, and a small local Python proxy for calling the Cortex Agent REST API without exposing Snowflake credentials in browser-side JavaScript.

## How It Works

```text
Tableau dashboard
  -> embedded Tableau Extension
  -> local Python proxy
  -> Snowflake Cortex Agent REST API
  -> answer + Tableau filter JSON
  -> Tableau Extensions API applies filters to the dashboard
```

The Cortex Agent acts as the reasoning layer. It interprets the user's question and returns structured filter instructions. The Tableau Extension applies those filters with the Tableau Extensions API.

## Repository Structure

```text
f1-tableau-cortex-extension/
├─ README.md
├─ .gitignore
├─ .env.example
├─ extension/
│  ├─ index.html
│  ├─ styles.css
│  ├─ app.js
│  └─ tableau-cortex-filter.trex
├─ proxy/
│  └─ proxy_server.py
└─ docs/
   └─ architecture.md
```

## Local Configuration

Copy `.env.example` to `.env`:

```powershell
Copy-Item .env.example .env
```

Then edit `.env` with your own Snowflake details:

```text
SNOWFLAKE_ACCOUNT_URL=https://your-account.region.cloud.snowflakecomputing.com
SNOWFLAKE_PAT=your_personal_access_token
SNOWFLAKE_DATABASE=YOUR_DATABASE_NAME
SNOWFLAKE_SCHEMA=YOUR_SCHEMA_NAME
SNOWFLAKE_AGENT=YOUR_CORTEX_AGENT_NAME
TABLEAU_AGENT_PROXY_PORT=8766
```

The Cortex Agent endpoint is built from those values:

```text
{SNOWFLAKE_ACCOUNT_URL}/api/v2/databases/{SNOWFLAKE_DATABASE}/schemas/{SNOWFLAKE_SCHEMA}/agents/{SNOWFLAKE_AGENT}:run
```

## Security Note

Never commit Snowflake Personal Access Tokens, OAuth tokens, passwords, or real account URLs to GitHub.

This project keeps secrets in `.env`, which is ignored by Git. The browser extension calls the local proxy, and the proxy adds the Snowflake authorization token server-side. Do not put a Snowflake PAT in `app.js`, `index.html`, the `.trex` manifest, or any file served to the browser.

## Run Locally

Start the Tableau extension file server from the repository root:

```powershell
python -m http.server 8765
```

In another terminal, start the Cortex Agent proxy from the repository root:

```powershell
python .\proxy\proxy_server.py
```

The extension web app is served from:

```text
http://localhost:8765/extension/index.html
```

The proxy listens at:

```text
http://localhost:8766/tableau-agent-filter
```

## Load In Tableau

1. Open the Tableau dashboard.
2. Drag an `Extension` object onto the dashboard.
3. Select `extension/tableau-cortex-filter.trex`.
4. Use the `F1 AI Assistant` panel to ask a question.

Example question:

```text
Which drivers have won the most races for Ferrari? Show me the top 5.
```

## Expected Agent Response

The proxy asks the Cortex Agent to return JSON with an answer and one or more dashboard filters:

```json
{
  "answer": "The top Ferrari race winners are Michael Schumacher, Niki Lauda, Sebastian Vettel, Alberto Ascari, and Felipe Massa.",
  "filters": [
    {
      "fieldName": "driver_name",
      "values": ["Michael Schumacher", "Niki Lauda", "Sebastian Vettel", "Alberto Ascari", "Felipe Massa"]
    },
    {
      "fieldName": "constructor_name",
      "values": ["Ferrari"]
    }
  ]
}
```

The extension applies each returned filter to every compatible worksheet. Worksheets that do not contain a field are skipped.

## Notes For Adapting This Project

- The Tableau field names in the agent response must match the field names in your workbook.
- `extension/app.js` calls `http://localhost:8766/tableau-agent-filter`.
- For Tableau Server or Tableau Cloud, configure network-enabled extensions and safe-listing according to your Tableau site requirements.
- This public repo is not runnable until you provide your own Snowflake account URL, Cortex Agent object names, and PAT in a local `.env` file.
