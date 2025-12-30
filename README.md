# Accessibility Statement Dashboard

A specialized tool for managing and deploying accessibility statements across multiple WordPress sites. This dashboard automates the process of creating, publishing, and verifying accessibility statement pages.

## Features

- **Single Site Check**: Add/verify accessibility statement for a single URL
- **Bulk Processing**: Process multiple sites from a Google Sheet
- **Bulk Check Only**: Quickly verify which sites already have accessibility statements
- **Automated Login**: Handles WordPress authentication automatically
- **HTML Generation**: Generates standardized accessibility statement content
- **Manual Intervention**: Pauses for manual review and edits when needed
- **Result Logging**: Tracks results back to Google Sheets

## Setup

1. Install dependencies:
   ```bash
   npm install
   cd client && npm install
   cd ../server && npm install
   ```

2. Configure environment variables in `server/.env`:
   ```
   CREDENTIALS_PATH=./credentials.json
   ACCESSIBILITY_STATEMENT_SHEET_ID=your_sheet_id
   ADA_DUPLICATE_SHEET_ID=your_duplicate_sheet_id
   ```

3. Add Google Sheets credentials to `server/credentials.json`

## Running

1. Start the server:
   ```bash
   node server/index.js
   ```

2. Start the client (in a new terminal):
   ```bash
   cd client
   npm start
   ```

3. Access the dashboard at http://localhost:3000
