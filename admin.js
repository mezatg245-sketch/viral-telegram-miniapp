const cfg=window.APP_CONFIG;
const keyInput=document.getElementById("key");
const login=document.getElementById("login"),dash=document.getElementById("dash");
let current={};
document.getElementById("loginBtn").onclick=load;
async function load(){
  const key=keyInput.value.trim(); if(!key)return;
  try{
    const r=await fetch(`${cfg.API_BASE}/api/admin/summary`,{headers:{Authorization:`Bearer ${key}`}});
    const d=await r.json(); if(!r.ok)throw new Error(d.error||"Denied");
    current=d; login.classList.add("hidden");dash.classList.remove("hidden");paint();
  }catch(e){alert(e.message)}
}
function paint(){
  document.getElementById("users").textContent=current.users;
  document.getElementById("views").textContent=current.views;
  document.getElementById("ads").textContent=current.ad_completes;
  calc();
  document.getElementById("top").innerHTML=`<table><tr><th>Video</th><th>Views</th></tr>${(current.top||[]).map(v=>`<tr><td>${esc(v.caption||"Untitled")}</td><td>${v.views}</td></tr>`).join("")}</table>`;
}
function calc(){
 const cpm=Number(document.getElementById("cpm").value)||0;
 const impressions=Number(current.ad_completes)||0;
 document.getElementById("revenue").textContent=`$${((impressions/1000)*cpm).toFixed(2)}`;
}
document.getElementById("recalc").onclick=calc;
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
