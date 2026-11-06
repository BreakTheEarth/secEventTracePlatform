# Security and deployment

This beta provides a single administrator workspace. Responsible-owner fields are business metadata, not access control. It does not implement employee accounts, tenant isolation, SSO, per-record authorization or automated notifications.

Before exposing the service:

- Change the development administrator password in `.env`.
- Serve through HTTPS and set `COOKIE_SECURE=true`.
- Restrict filesystem access to the data directory and backups.
- Keep the database and `reporting-api.key` together when backing up.
- Give each inbound integration its own API key and revoke unused keys.

Uploads are authenticated and restricted by file type and size. They are not antivirus-scanned. Treat all evidence as untrusted content.

Deleting a campaign or task retains evidence and audit history; deleting a platform file does not erase backup copies. Stop the service before making a filesystem backup, or use a SQLite-aware online backup process.

Do not post credentials, sensitive event content or exploit material in a public issue. If the repository offers a private vulnerability-reporting channel, use it; otherwise ask the maintainer for a private contact without including the sensitive details.
