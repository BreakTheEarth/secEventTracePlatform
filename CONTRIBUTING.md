# Contributing

1. Install Node.js >=22.13 and run `npm ci`.
2. Use `npm run dev` with your own local `.env`. Never commit real event data.
3. Keep shared validation consistent across forms, XLSX imports and APIs.
4. Preserve the distinction between campaign date ranges and optional task deadlines.
5. Add regression coverage for changed business behavior using temporary databases.
6. Run `npm test`, `npm run build`, and `npm run check:release`.

Use example.com addresses in examples. Keep `data/`, `.env`, attachments, logs and screenshots out of commits. Files in `.env.example` contain development defaults only.

For a proposed change, describe the user-visible behavior, test results and migration implications. Avoid adding vendor-specific integration credentials or endpoints.
