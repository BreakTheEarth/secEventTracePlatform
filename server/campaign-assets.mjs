import express from 'express';
import { mkdirSync, writeFileSync, unlinkSync, existsSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { campaignPlainText } from './campaign-migration.mjs';

// Evidence belongs to an already-saved campaign/task; uploads cannot cross-link event assets.
export function createCampaignAssets({ app, db, dataDirectory, getCampaign, getTask, updateCampaign, reject }) {
  db.exec(`CREATE TABLE IF NOT EXISTS security_campaign_assets (
    id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES security_campaigns(id),
    task_id INTEGER REFERENCES security_campaign_tasks(id), filename TEXT NOT NULL, mime TEXT NOT NULL,
    bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, storage_key TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS campaign_assets_parent ON security_campaign_assets(campaign_id,task_id);`);
  const directory=join(dataDirectory,'integrations','campaign-assets');
  const parent=(id,taskId)=>{
    const campaign=getCampaign(id); if(!campaign)reject('专项不存在。',404);
    const task=taskId?getTask(taskId):null;
    if(taskId&&(!task||task.campaign_id!==id))reject('子任务不属于该专项。',404);
    return {campaign,task};
  };
  const touch=(id,taskId)=>{
    const timestamp=new Date().toISOString();
    db.prepare('UPDATE security_campaigns SET version=version+1,updated_at=? WHERE id=?').run(timestamp,id);
    if(taskId)db.prepare('UPDATE security_campaign_tasks SET version=version+1,updated_at=? WHERE id=?').run(timestamp,taskId);
  };
  app.get('/api/campaigns/:id/assets',(req,res)=>{
    const id=Number(req.params.id);parent(id,null);
    res.json({assets:db.prepare('SELECT id,campaign_id,task_id,filename,mime,bytes,deleted,created_at FROM security_campaign_assets WHERE campaign_id=? AND (task_id IS NULL OR EXISTS(SELECT 1 FROM security_campaign_tasks t WHERE t.id=task_id AND t.removed=0)) ORDER BY id DESC').all(id)});
  });
  app.post('/api/campaigns/:id/assets',express.raw({type:'application/octet-stream',limit:'21mb'}),(req,res)=>{
    const id=Number(req.params.id),taskId=req.get('X-Task-Id')?Number(req.get('X-Task-Id')):null;
    if(taskId!==null&&(!Number.isSafeInteger(taskId)||taskId<1))reject('子任务编号无效。');
    const {campaign,task}=parent(id,taskId);
    if(req.get('X-Campaign-Version')&&Number(req.get('X-Campaign-Version'))!==campaign.version)reject('记录已被更新，请刷新后重新编辑。',409);
    if(task&&req.get('X-Task-Version')&&Number(req.get('X-Task-Version'))!==task.version)reject('执行专项已被更新，请刷新后重新编辑。',409);
    if(campaign.status!=='tracking'||(task&&task.status!=='tracking'))reject('已完结记录请先重新打开，再添加附件。',409);
    const buffer=req.body;if(!Buffer.isBuffer(buffer)||!buffer.length)reject('文件不能为空。');
    if(buffer.length>20*1024*1024)reject('单个附件不能超过 20 MB。',413);
    let filename;try{filename=basename(decodeURIComponent(req.get('X-File-Name')||'')).replace(/[\x00-\x1f\x7f]/g,'_').slice(0,200);}catch{reject('文件名无效。');}
    const ext=filename.split('.').pop().toLowerCase();
    const starts=signature=>buffer.subarray(0,signature.length).equals(signature);
    let mime='';
    if(ext==='png'&&starts(Buffer.from([137,80,78,71,13,10,26,10])))mime='image/png';
    if(['jpg','jpeg'].includes(ext)&&starts(Buffer.from([255,216,255])))mime='image/jpeg';
    if(ext==='gif'&&['GIF87a','GIF89a'].includes(buffer.subarray(0,6).toString()))mime='image/gif';
    if(ext==='webp'&&starts(Buffer.from('RIFF'))&&buffer.subarray(8,12).toString()==='WEBP')mime='image/webp';
    if(ext==='pdf'&&starts(Buffer.from('%PDF-')))mime='application/pdf';
    if(ext==='zip'&&starts(Buffer.from('PK')))mime='application/zip';
    if(ext==='doc'&&starts(Buffer.from([208,207,17,224,161,177,26,225])))mime='application/msword';
    if(ext==='docx'&&starts(Buffer.from('PK')))mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if(ext==='txt'){try{const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);if(!text.includes('\0'))mime='text/plain';}catch{ /* Reject non-text input. */ }}
    if(!mime)reject('仅支持真实的 PNG/JPG/GIF/WEBP、PDF、ZIP、DOC/DOCX 或 UTF-8 TXT 文件。');
    const key=`${randomBytes(24).toString('hex')}.${ext}`,path=join(directory,key);
    mkdirSync(directory,{recursive:true,mode:0o700});writeFileSync(path,buffer,{mode:0o600,flag:'wx'});
    db.exec('BEGIN IMMEDIATE');
    try{
      const result=db.prepare(`INSERT INTO security_campaign_assets (campaign_id,task_id,filename,mime,bytes,sha256,storage_key,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id,taskId,filename,mime,buffer.length,createHash('sha256').update(buffer).digest('hex'),key,req.user.id,new Date().toISOString());
      updateCampaign(id,req.user.id,'asset_added',`添加附件：${filename}`,taskId);touch(id,taskId);db.exec('COMMIT');
      const assetId=Number(result.lastInsertRowid);
      res.status(201).json({id:assetId,filename,mime,kind:mime.startsWith('image/')?'image':'file',url:`/api/campaign-assets/${assetId}/download`,campaign_version:getCampaign(id).version,task_version:taskId?getTask(taskId).version:null});
    }catch(error){db.exec('ROLLBACK');unlinkSync(path);throw error;}
  });
  app.get('/api/campaign-assets/:id/download',(req,res)=>{
    const asset=db.prepare('SELECT * FROM security_campaign_assets WHERE id=? AND deleted=0').get(Number(req.params.id));
    if(!asset||!existsSync(join(directory,asset.storage_key)))reject('附件已删除或不存在。',404);
    parent(asset.campaign_id,asset.task_id);
    res.set('X-Content-Type-Options','nosniff');res.set('Cache-Control','no-store');res.set('Content-Security-Policy',"default-src 'none'; sandbox");
    if(asset.mime.startsWith('image/')){
      res.type(asset.mime);res.set('Content-Disposition','inline');
      res.sendFile(join(directory,asset.storage_key));
    }else res.download(join(directory,asset.storage_key),asset.filename);
  });
  app.delete('/api/campaign-assets/:id',(req,res)=>{
    const asset=db.prepare('SELECT * FROM security_campaign_assets WHERE id=? AND deleted=0').get(Number(req.params.id));
    if(!asset)reject('附件已删除或不存在。',404);
    parent(asset.campaign_id,asset.task_id);
    // Keep deleted metadata and audit evidence; backups are deliberately not modified.
    const path=join(directory,asset.storage_key),temporary=`${path}.${randomBytes(8).toString('hex')}.deleting`;let moved=false;
    db.exec('BEGIN IMMEDIATE');
    try{
      if(existsSync(path)){renameSync(path,temporary);moved=true;}
      db.prepare('UPDATE security_campaign_assets SET deleted=1 WHERE id=?').run(asset.id);
      const replaceReference=html=>String(html||'')
        .replace(new RegExp(`<img\\b[^>]*src="/api/campaign-assets/${asset.id}/download"[^>]*>`, 'gi'),'<span>已删除平台文件</span>')
        .replace(new RegExp(`<a\\b[^>]*href="/api/campaign-assets/${asset.id}/download"[^>]*>[\\s\\S]*?</a>`, 'gi'),'<span>已删除平台文件</span>');
      const campaign=getCampaign(asset.campaign_id),description=replaceReference(campaign.description_html);
      db.prepare('UPDATE security_campaigns SET description_html=?,search_text=? WHERE id=?').run(description,campaignPlainText(description),asset.campaign_id);
      if(asset.task_id){
        const task=db.prepare('SELECT description_html FROM security_campaign_tasks WHERE id=?').get(asset.task_id);
        db.prepare('UPDATE security_campaign_tasks SET description_html=? WHERE id=?').run(replaceReference(task.description_html),asset.task_id);
      }
      for(const update of db.prepare("SELECT id,body_html FROM security_campaign_updates WHERE campaign_id=? AND body_html<>''").all(asset.campaign_id)){
        const html=replaceReference(update.body_html);
        if(html!==update.body_html)db.prepare('UPDATE security_campaign_updates SET body_html=?,body=? WHERE id=?').run(html,campaignPlainText(html),update.id);
      }
      updateCampaign(asset.campaign_id,req.user.id,'asset_deleted',`已删除平台附件：${asset.filename}（服务器备份不自动清除）`,asset.task_id);
      touch(asset.campaign_id,asset.task_id);db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');if(moved)renameSync(temporary,path);throw error;}
    if(moved)unlinkSync(temporary);
    res.json({ok:true});
  });
}
