import sanitizeHtml from 'sanitize-html';
import { decodeHTML } from 'entities';
import { cleanRichText, escapeHTML } from './content.mjs';

export const campaignPlainText = html => decodeHTML(sanitizeHtml(String(html || '').replace(/<\/(?:p|div|h[23]|li|tr)>|<br\s*\/?>/gi, ' '), { allowedTags: [], allowedAttributes: {} })).replace(/\s+/g, ' ').trim();
export function mergeCampaignContent(objective, description, reference) {
  const pieces = [], seen = new Map();
  for (const [value, rich] of [[objective, false], [description, true], [reference, false]]) {
    const key = rich ? campaignPlainText(value) : String(value || '').replace(/\s+/g, ' ').trim();
    if (!key && !String(value || '').includes('<img')) continue;
    const content = rich ? cleanRichText(value, { campaignAssets: true }) : `<p>${escapeHTML(value).replace(/\n/g, '<br>')}</p>`;
    if (key && seen.has(key)) {
      if (rich) pieces[seen.get(key)] = content;
      continue;
    }
    if (key) seen.set(key, pieces.length);
    pieces.push(content);
  }
  return pieces.join('');
}

// Old fields stay intact; the per-record marker prevents duplicate merges on restart.
export function migrateCampaignsV2(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [table, columns] of Object.entries({
      security_campaigns: { lead_owner: "TEXT NOT NULL DEFAULT ''", collaborators_json: "TEXT NOT NULL DEFAULT '[]'", scope_details: "TEXT NOT NULL DEFAULT '[]'", search_text: "TEXT NOT NULL DEFAULT ''", content_version: 'INTEGER NOT NULL DEFAULT 1', deleted: 'INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))', deleted_at: 'TEXT', deleted_by: 'INTEGER REFERENCES users(id)', legacy_stage: 'TEXT' },
      security_campaign_tasks: { collaborators_json: "TEXT NOT NULL DEFAULT '[]'", priority: "TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('high','medium','low'))" },
      security_campaign_updates: { body_html: "TEXT NOT NULL DEFAULT ''" },
    })) {
      const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
      for (const [column, type] of Object.entries(columns)) if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    for (const row of db.prepare('SELECT * FROM security_campaigns WHERE content_version<2').all()) {
      const owners = JSON.parse(row.security_owners), scopes = JSON.parse(row.scopes);
      const description = mergeCampaignContent(row.objective, row.description_html, row.reference_text);
      db.prepare(`UPDATE security_campaigns SET lead_owner=?,collaborators_json=?,scope_details=?,description_html=?,search_text=?,content_version=2 WHERE id=?`)
        .run(owners.length === 1 ? owners[0] : '', JSON.stringify(owners.length > 1 ? owners : []),
          JSON.stringify(scopes.map(name => ({ type: 'legacy', name, note: '' }))), description, campaignPlainText(description), row.id);
    }
    for (const row of db.prepare("SELECT id,collaborators FROM security_campaign_tasks WHERE collaborators_json='[]' AND collaborators<>''").all()) {
      db.prepare('UPDATE security_campaign_tasks SET collaborators_json=? WHERE id=?').run(JSON.stringify(row.collaborators.split(/[\n,，、;；]+/).map(v => v.trim()).filter(Boolean)), row.id);
    }
    // Preserve the original classification once, including across repeated upgrades.
    db.exec("UPDATE security_campaigns SET legacy_stage=stage,stage='incidents' WHERE legacy_stage IS NULL");
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
