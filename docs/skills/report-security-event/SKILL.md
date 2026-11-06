---
name: report-security-event
description: Submit one verified text event to a self-hosted Trace beta instance.
---

# Report a security event

Get the instance URL and a dedicated API key from its administrator. The administrator must enable the inbound API in Operations Configuration. Keep the key private.

```http
POST /api/v1/events
Authorization: Bearer <private-api-key>
Content-Type: application/json
Idempotency-Key: stable-id-for-this-event
```

```json
{
  "event_type": "HIDS",
  "discovered_at": "2026-11-06T10:00:00+08:00",
  "security_risk": true,
  "security_incident": true,
  "security_violation": false,
  "security_red_line": false,
  "severity": null,
  "security_owners": ["admin"],
  "incident_owners": ["owner@example.com"],
  "description_text": "Verified observation and response actions."
}
```

Valid current types: DLP, EDR, HIDS, REG, FB, RASP, WAF, SAST, DAST, MAIL, TI. All are manual record categories.

Make all four decisions explicit. An incident requires a risk, a violation requires an incident, and a red-line event requires a violation. Only red-line events require P0–P4; all others use null or omit severity.

Owner arrays each require 1–20 values. Use `admin` or valid email addresses, at most 254 characters each. `description_text` is required, nonempty, at most 256 KiB. It is text, not HTML. Timezone-less timestamps mean Asia/Shanghai.

Only the fields in the example are accepted. Do not submit binary data, attachment IDs, external log fields or campaign links. Do not invent facts or responsible people.

The first submission returns 201. An identical retry with the same idempotency key returns 200 and `replayed:true`; changed content with the same key returns 409. Retry network failures only with unchanged content and the original key. Keys are globally scoped to the instance. Deleting a record also deletes its replay entry in this beta.

401 means the key is invalid; 403 means reporting is disabled. Ask the instance administrator to fix configuration. Never send a key in a URL, event body or public issue.
