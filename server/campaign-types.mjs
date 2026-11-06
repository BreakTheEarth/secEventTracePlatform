export function createCampaignTypes({app,db,reject,updateCampaign}) {
  const existed=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='security_campaign_types'").get());
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS security_campaign_types (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS security_campaign_type_updates (
      id INTEGER PRIMARY KEY, type_id INTEGER NOT NULL REFERENCES security_campaign_types(id),
      user_id INTEGER NOT NULL REFERENCES users(id), old_name TEXT, new_name TEXT NOT NULL, created_at TEXT NOT NULL
    );`);
    if(!db.prepare('PRAGMA table_info(security_campaign_types)').all().some(c=>c.name==='deleted'))db.exec('ALTER TABLE security_campaign_types ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))');
    if(!db.prepare('PRAGMA table_info(security_campaigns)').all().some(c=>c.name==='type_id'))db.exec('ALTER TABLE security_campaigns ADD COLUMN type_id INTEGER REFERENCES security_campaign_types(id)');
    const stamp=new Date().toISOString();
    const insert=db.prepare('INSERT OR IGNORE INTO security_campaign_types(name,created_at,updated_at) VALUES(?,?,?)');
    if(!existed)for(const name of ['漏洞修复','入侵应急','监管检查'])insert.run(name,stamp,stamp);
    for(const row of db.prepare("SELECT DISTINCT type FROM security_campaigns WHERE type<>'待定' AND type_id IS NULL").all())insert.run(row.type,stamp,stamp);
    db.exec("UPDATE security_campaigns SET type_id=(SELECT id FROM security_campaign_types WHERE name=type AND deleted=0) WHERE type_id IS NULL AND type<>'待定'");
    db.exec('COMMIT');
  } catch(error) {db.exec('ROLLBACK');throw error;}
  const list=()=>db.prepare('SELECT id,name,version,(SELECT count(*) FROM security_campaigns c WHERE c.type_id=t.id) AS usage_count FROM security_campaign_types t WHERE deleted=0 ORDER BY id').all();
  const nameOf=value=>{
    if(typeof value!=='string'||!value.trim()||value.trim().length>40)reject('标签名称必填且不能超过40字。');
    if(value.trim()==='待定')reject('“待定”为历史未分类状态，请使用其他标签名称。');
    return value.trim();
  };
  app.post('/api/campaign-types',(req,res)=>{
    const name=nameOf(req.body?.name);
    const previous=db.prepare('SELECT * FROM security_campaign_types WHERE name=?').get(name);
    if(previous&&!previous.deleted)reject('标签名称已存在。',409);
    if(list().length>=100)reject('专项类型最多100项。');
    const stamp=new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      let id,version=1;
      if(previous){id=previous.id;version=previous.version+1;db.prepare('UPDATE security_campaign_types SET deleted=0,version=version+1,updated_at=? WHERE id=?').run(stamp,id);}
      else id=Number(db.prepare('INSERT INTO security_campaign_types(name,created_at,updated_at) VALUES(?,?,?)').run(name,stamp,stamp).lastInsertRowid);
      db.prepare('INSERT INTO security_campaign_type_updates(type_id,user_id,new_name,created_at) VALUES(?,?,?,?)').run(id,req.user.id,name,stamp);
      db.exec('COMMIT');res.status(201).json({type:{id,name,version},types:list()});
    } catch(error) {db.exec('ROLLBACK');throw error;}
  });
  app.put('/api/campaign-types/:id',(req,res)=>{
    const row=db.prepare('SELECT * FROM security_campaign_types WHERE id=? AND deleted=0').get(Number(req.params.id));
    if(!row)reject('标签不存在。',404);
    if(req.body?.version!==row.version)reject('标签已更新，请刷新后重试。',409);
    const name=nameOf(req.body?.name);
    if(db.prepare('SELECT id FROM security_campaign_types WHERE name=? AND id<>?').get(name,row.id))reject('标签名称已存在。',409);
    if(name===row.name)return res.json({type:row,types:list()});
    const stamp=new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE security_campaign_types SET name=?,version=version+1,updated_at=? WHERE id=?').run(name,stamp,row.id);
      const campaigns=db.prepare('SELECT id,version FROM security_campaigns WHERE type_id=?').all(row.id);
      for(const campaign of campaigns) {
        db.prepare('UPDATE security_campaigns SET type=?,version=version+1,updated_at=? WHERE id=?').run(name,stamp,campaign.id);
        updateCampaign(campaign.id,req.user.id,'type_renamed',`专项类型标签重命名：${row.name} → ${name}`);
      }
      db.prepare('INSERT INTO security_campaign_type_updates(type_id,user_id,old_name,new_name,created_at) VALUES(?,?,?,?,?)').run(row.id,req.user.id,row.name,name,stamp);
      db.exec('COMMIT');res.json({type:{id:row.id,name,version:row.version+1},types:list(),campaign_versions:campaigns.map(c=>({id:c.id,before:c.version,after:c.version+1}))});
    } catch(error) {db.exec('ROLLBACK');throw error;}
  });
  app.delete('/api/campaign-types/:id',(req,res)=>{
    const row=db.prepare('SELECT * FROM security_campaign_types WHERE id=? AND deleted=0').get(Number(req.params.id));
    if(!row)reject('标签不存在或已删除。',404);
    if(req.body?.version!==row.version)reject('标签已更新，请刷新后重试。',409);
    const stamp=new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const campaigns=db.prepare('SELECT id,version FROM security_campaigns WHERE type_id=?').all(row.id);
      if(req.body?.usage_count!==campaigns.length)reject('标签引用数量已变化，请刷新标签后重新确认。',409);
      for(const campaign of campaigns){
        db.prepare("UPDATE security_campaigns SET type='待定',type_id=NULL,version=version+1,updated_at=? WHERE id=?").run(stamp,campaign.id);
        updateCampaign(campaign.id,req.user.id,'type_deleted',`删除专项类型标签：${row.name}；类型改为待定`);
      }
      db.prepare('UPDATE security_campaign_types SET deleted=1,version=version+1,updated_at=? WHERE id=?').run(stamp,row.id);
      db.prepare('INSERT INTO security_campaign_type_updates(type_id,user_id,old_name,new_name,created_at) VALUES(?,?,?,?,?)').run(row.id,req.user.id,row.name,'[已删除]',stamp);
      db.exec('COMMIT');res.json({types:list(),campaign_versions:campaigns.map(c=>({id:c.id,before:c.version,after:c.version+1})),affected:campaigns.length});
    }catch(error){db.exec('ROLLBACK');throw error;}
  });
  return {list,resolve(body,previous) {
    if(body.type_id!==undefined&&body.type_id!==null) {
      if(!Number.isSafeInteger(body.type_id))reject('专项类型无效。');
      const type=db.prepare('SELECT * FROM security_campaign_types WHERE id=? AND deleted=0').get(body.type_id);
      if(!type)reject('专项类型不存在，请刷新后选择。',409);
      if(body.type!==undefined&&body.type!==type.name)reject('专项类型名称已更新，请刷新后选择。',409);
      return type;
    }
    const value=body.type===undefined?(previous?.type||'待定'):body.type;
    if(value==null||value===''||value==='待定')return {id:null,name:'待定'};
    const name=nameOf(value);
    let type=db.prepare('SELECT id,name,deleted FROM security_campaign_types WHERE name=?').get(name);
    if(type?.deleted)reject('专项类型已删除，请刷新后重新选择。',409);
    if(!type) {
      if(list().length>=100)reject('专项类型最多100项。');
      const stamp=new Date().toISOString();
      type={id:Number(db.prepare('INSERT INTO security_campaign_types(name,created_at,updated_at) VALUES(?,?,?)').run(name,stamp,stamp).lastInsertRowid),name};
    }
    return type;
  }};
}
