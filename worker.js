/**
 * ViralLoop Worker
 *
 * Secrets:
 *   BOT_TOKEN
 *   ADMIN_KEY
 *   ADMIN_TELEGRAM_IDS (comma-separated)
 *
 * Vars:
 *   CHANNEL_ID
 *   PUBLIC_API_BASE
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    };
    if (request.method === "OPTIONS") return new Response("", {headers:cors});

    try {
      if (url.pathname === "/telegram/webhook" && request.method === "POST") {
        const update = await request.json();
        await handleTelegramUpdate(update, env);
        return json({ok:true}, cors);
      }

      if (url.pathname === "/api/feed" && request.method === "GET") {
        const {results=[]}=await env.DB.prepare(
          `SELECT id, caption, duration, created_at, views FROM videos ORDER BY created_at DESC LIMIT 30`
        ).all();
        const videos=results.map(v=>({...v,url:null}));
        return json({videos},cors);
      }

      if (url.pathname === "/api/session" && request.method === "POST") {
        const body=await request.json();
        const user=await validateTelegramInitData(body.initData||"",env);
        if(!user) return json({user:null},cors);
        const now=Math.floor(Date.now()/1000);
        await env.DB.prepare(
          `INSERT INTO users(telegram_id,username,first_name,created_at,last_seen)
           VALUES(?,?,?,?,?)
           ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_seen=excluded.last_seen`
        ).bind(String(user.id),user.username||"",user.first_name||"",now,now).run();
        return json({user:{id:user.id,username:user.username,first_name:user.first_name}},cors);
      }

      if (url.pathname.startsWith("/api/videos/") && url.pathname.endsWith("/unlock") && request.method==="POST") {
        const id=Number(url.pathname.split("/")[3]);
        const row=await env.DB.prepare(`SELECT id,file_id FROM videos WHERE id=?`).bind(id).first();
        if(!row)return json({error:"Not found"},cors,404);
        const fileUrl=await telegramFileUrl(row.file_id,env.BOT_TOKEN);
        return json({url:fileUrl},cors);
      }

      if (url.pathname === "/api/event" && request.method==="POST") {
        const body=await request.json();
        const initData=request.headers.get("X-Telegram-Init-Data")||"";
        const user=await validateTelegramInitData(initData,env);
        // For demo simplicity, accept anonymous event if initData is unavailable.
        // Production: require valid Telegram initData here.
        const tid=String(user?.id||"anonymous");
        await env.DB.prepare(
          `INSERT INTO events(telegram_id,video_id,event_type,provider,value,created_at) VALUES(?,?,?,?,?,?)`
        ).bind(tid,body.video_id||null,body.type||"unknown",body.provider||null,Number(body.value)||0,Math.floor(Date.now()/1000)).run();
        if(body.type==="view" && body.video_id){
          await env.DB.prepare(`UPDATE videos SET views=views+1 WHERE id=?`).bind(body.video_id).run();
        }
        return json({ok:true},cors);
      }

      if (url.pathname === "/api/admin/summary" && request.method==="GET") {
        const auth=(request.headers.get("Authorization")||"").replace("Bearer ","");
        if(auth!==env.ADMIN_KEY)return json({error:"Unauthorized"},cors,401);
        const users=(await env.DB.prepare(`SELECT COUNT(*) c FROM users`).first()).c;
        const views=(await env.DB.prepare(`SELECT COALESCE(SUM(views),0) c FROM videos`).first()).c;
        const ads=(await env.DB.prepare(`SELECT COUNT(*) c FROM events WHERE event_type='ad_complete'`).first()).c;
        const {results:top=[]}=await env.DB.prepare(`SELECT caption,views FROM videos ORDER BY views DESC LIMIT 10`).all();
        return json({users,views,ad_completes:ads,top},cors);
      }

      return new Response("ViralLoop API", {status:200,headers:cors});
    } catch (e) {
      console.error(e);
      return json({error:"Server error"},cors,500);
    }
  }
};

async function handleTelegramUpdate(update,env){
  const msg=update.channel_post || update.message;
  if(!msg || !msg.chat) return;
  if(String(env.CHANNEL_ID) && String(msg.chat.id)!==String(env.CHANNEL_ID)) return;

  const video=msg.video || msg.document;
  if(!video) return;

  const fileId=video.file_id;
  const caption=msg.caption || "";
  const duration=video.duration || 0;
  const now=Math.floor(Date.now()/1000);

  await env.DB.prepare(
    `INSERT OR IGNORE INTO videos(telegram_chat_id,telegram_message_id,file_id,file_unique_id,caption,duration,created_at,views)
     VALUES(?,?,?,?,?,?,?,0)`
  ).bind(String(msg.chat.id),msg.message_id,fileId,video.file_unique_id||"",caption,duration,now).run();
}

async function telegramFileUrl(fileId,token){
  const r=await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const j=await r.json();
  if(!j.ok) throw new Error("Telegram file unavailable");
  return `https://api.telegram.org/file/bot${token}/${j.result.file_path}`;
}

async function validateTelegramInitData(initData,env){
  if(!initData || !env.BOT_TOKEN)return null;
  const params=new URLSearchParams(initData);
  const hash=params.get("hash");
  if(!hash)return null;
  params.delete("hash");
  const dataCheck=[...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join("\n");
  const secret=await hmacKey("WebAppData",env.BOT_TOKEN);
  const signature=await crypto.subtle.sign("HMAC",secret,new TextEncoder().encode(dataCheck));
  const expected=hex(signature);
  if(!timingSafeEqual(expected,hash))return null;
  const authDate=Number(params.get("auth_date")||0);
  if(!authDate || Math.floor(Date.now()/1000)-authDate>86400)return null;
  try{return JSON.parse(params.get("user")||"null")}catch{return null}
}

async function hmacKey(key,data){
  return crypto.subtle.importKey("raw",new TextEncoder().encode(key),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
}
function hex(buf){return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join("")}
function timingSafeEqual(a,b){
  if(a.length!==b.length)return false;
  let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0;
}
function json(data,headers={},status=200){
  return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json",...headers}});
}
