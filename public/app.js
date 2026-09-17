const cfg = window.APP_CONFIG;
const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const state = {
  user: null,
  videos: [],
  unlocked: new Set(),
  adController: null,
  lang: localStorage.getItem("vl_lang") || "en",
  theme: localStorage.getItem("vl_theme") || (tg?.colorScheme === "light" ? "light" : "dark")
};

const $ = id => document.getElementById(id);
const api = (path, options={}) => fetch(`${cfg.API_BASE}${path}`, {
  ...options,
  headers: {"Content-Type":"application/json", ...(options.headers||{})}
}).then(async r => {
  const data = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
});

const copy = {
  en: {
    hero:"Your next obsession is one tap away.",
    sub:"Watch the drop, react, and discover the next one.",
    live:"LIVE FEED", fresh:"Fresh drops", drops:"drops", views:"views",
    locked:"Unlock this viral drop", watch:"Watch 2 short ads to unlock", ad:"Ad",
    blocker:"Ad blocker detected", blockerText:"Please allow ads for this Mini App. Ads keep the feed free.",
    no:"New drops are loading", noText:"Come back soon for the next viral video.",
    infoTitle:"About ViralLoop", info:"ViralLoop is a Telegram Mini App for short-form video. Rewarded ads are shown before content is unlocked. Ad availability varies by country and provider.",
    adFailed:"The ad could not be loaded. Please disable your blocker or try again."
  },
  am:{
    hero:"ቀጣዩ የሚያስደስትዎ ቪዲዮ አንድ መንካት ብቻ ይርቃል።",
    sub:"ቪዲዮውን ይመልከቱ፣ ምላሽ ይስጡ፣ ቀጣዩንም ያግኙ።",
    live:"ቀጥታ ምግብ", fresh:"አዳዲስ ቪዲዮዎች", drops:"ቪዲዮ", views:"እይታ",
    locked:"ይህን ቪዲዮ ይክፈቱ", watch:"ለመክፈት 2 አጭር ማስታወቂያዎችን ይመልከቱ", ad:"ማስታወቂያ",
    blocker:"የማስታወቂያ እገዳ ተገኝቷል", blockerText:"ማስታወቂያዎችን ለዚህ Mini App ይፍቀዱ።",
    no:"አዳዲስ ቪዲዮዎች እየመጡ ነው", noText:"በቅርቡ ተመልሰው ይምጡ።",
    infoTitle:"ስለ ViralLoop", info:"ViralLoop በTelegram ውስጥ የሚሰራ አጭር ቪዲዮ Mini App ነው። ይዘቱ ከመከፈቱ በፊት የrewarded ማስታወቂያ ይታያል።",
    adFailed:"ማስታወቂያው ሊጫን አልቻለም። የad blocker ካለ ያጥፉና እንደገና ይሞክሩ።"
  }
};

function t(k){return copy[state.lang][k] || copy.en[k] || k}

function applyTheme(){
  document.body.classList.toggle("light", state.theme==="light");
  $("themeBtn").textContent = state.theme==="light" ? "☀" : "☾";
  localStorage.setItem("vl_theme", state.theme);
}
function applyLang(){
  $("heroTitle").textContent=t("hero");$("heroSub").textContent=t("sub");
  $("liveText").textContent=t("live");$("adblockTitle").textContent=t("blocker");
  $("adblockText").textContent=t("blockerText");$("langBtn").textContent=state.lang==="en"?"አማ":"EN";
  document.querySelector(".feed-head h2").textContent=t("fresh");
  document.documentElement.lang=state.lang==="am"?"am":"en";
  render();
  localStorage.setItem("vl_lang",state.lang);
}
$("themeBtn").onclick=()=>{state.theme=state.theme==="light"?"dark":"light";applyTheme()};
$("langBtn").onclick=()=>{state.lang=state.lang==="en"?"am":"en";applyLang()};
$("refreshBtn").onclick=loadFeed;

function detectAdBlock(){
  const bait=document.createElement("div");
  bait.className="adsbox ad adsbygoogle";
  bait.style.cssText="position:absolute;left:-9999px;width:1px;height:1px;";
  bait.innerHTML="&nbsp;";
  document.body.appendChild(bait);
  setTimeout(()=>{
    const blocked = bait.offsetHeight===0 || getComputedStyle(bait).display==="none";
    bait.remove();
    $("adblockBox").classList.toggle("hidden", !blocked);
  },250);
}

async function initAdController(){
  try{
    if(window.Adsgram && cfg.ADS_GRAM_BLOCK_ID && cfg.ADS_GRAM_BLOCK_ID !== "YOUR_ADSGRAM_BLOCK_ID"){
      state.adController=window.Adsgram.init({blockId:cfg.ADS_GRAM_BLOCK_ID});
    }
  }catch(e){ console.warn("AdsGram init failed",e); }
}

async function playRewardedAd(){
  if(!state.adController){
    throw new Error("AdsGram is not configured");
  }
  const result=await state.adController.show();
  if(!result?.done) throw new Error("Ad not completed");
  return true;
}

async function unlockVideo(videoId, card){
  const btn=card.querySelector(".unlock-btn");
  const progress=card.querySelectorAll(".ad-dot");
  let completed=0;
  btn.disabled=true;

  try{
    for(let i=0;i<cfg.AD_GATES;i++){
      btn.textContent=`${t("ad")} ${i+1}/${cfg.AD_GATES}…`;
      await playRewardedAd();
      completed++;
      if(progress[i]) progress[i].classList.add("done");
      await api("/api/event",{
        method:"POST",
        headers:{"X-Telegram-Init-Data":tg?.initData||""},
        body:JSON.stringify({type:"ad_complete", video_id:videoId, provider:"adsgram"})
      });
    }

    const unlockedData=await api(`/api/videos/${videoId}/unlock`,{method:"POST"});
    const item=state.videos.find(x=>x.id===videoId);
    if(item) item.url=unlockedData.url;
    state.unlocked.add(videoId);
    render();
    showToast("✓ Unlocked");
  }catch(e){
    console.warn(e);
    showToast(t("adFailed"));
    btn.disabled=false;
    btn.textContent=t("watch");
  }
}

function render(){
  $("videoCount").textContent=state.videos.length;
  $("viewCount").textContent=Intl.NumberFormat().format(state.videos.reduce((a,v)=>a+(v.views||0),0));
  const feed=$("feed");
  if(!state.videos.length){feed.innerHTML="";$("empty").classList.remove("hidden");return}
  $("empty").classList.add("hidden");

  feed.innerHTML=state.videos.map((v,i)=>{
    const unlocked=state.unlocked.has(v.id);
    const caption=v.caption || "Viral drop";
    return `<article class="video-card" data-id="${v.id}" style="animation-delay:${i*55}ms">
      <div class="video-wrap">
        <video ${unlocked?"controls":"":""} preload="metadata" playsinline ${unlocked?`src="${escapeAttr(v.url||"")}"`:""}></video>
        ${!unlocked?`<div class="lock-layer">
          <div class="lock-card">
            <div class="lock-icon">✦</div>
            <h3>${t("locked")}</h3>
            <p>${t("watch")}</p>
            <div class="ad-progress"><span class="ad-dot"></span><span class="ad-dot"></span></div>
            <button class="unlock-btn">${t("watch")}</button>
          </div>
        </div>`:""}
      </div>
      <div class="card-body">
        <div class="caption">${escapeHtml(caption)}</div>
        <div class="meta"><span>● ${timeAgo(v.created_at)}</span><span>◉ ${Intl.NumberFormat().format(v.views||0)} ${t("views")}</span></div>
        <div class="reaction-row">
          <button class="reaction" data-reaction="🔥">🔥</button>
          <button class="reaction" data-reaction="😂">😂</button>
          <button class="reaction" data-reaction="❤️">❤️</button>
        </div>
        ${cfg.SECOND_AD_URL?`<div class="second-ad">${t("ad")} · <a href="${escapeAttr(cfg.SECOND_AD_URL)}" target="_blank" rel="noopener">Sponsored</a></div>`:""}
      </div>
    </article>`
  }).join("");

  feed.querySelectorAll(".unlock-btn").forEach(btn=>{
    btn.onclick=()=>unlockVideo(Number(btn.closest(".video-card").dataset.id),btn.closest(".video-card"));
  });
  feed.querySelectorAll("video").forEach(video=>{
    video.addEventListener("play", async ()=>{
      const id=Number(video.closest(".video-card").dataset.id);
      await api("/api/event",{
        method:"POST",
        headers:{"X-Telegram-Init-Data":tg?.initData||""},
        body:JSON.stringify({type:"view",video_id:id})
      }).catch(()=>{});
    },{once:true});
  });
  feed.querySelectorAll(".reaction").forEach(btn=>{
    btn.onclick=async()=>{
      btn.animate([{transform:"scale(1)"},{transform:"scale(1.25)"},{transform:"scale(1)"}],{duration:260});
      await api("/api/event",{
      method:"POST",
      headers:{"X-Telegram-Init-Data":tg?.initData||""},
      body:JSON.stringify({type:"reaction",video_id:Number(btn.closest(".video-card").dataset.id),value:btn.dataset.reaction})
    }).catch(()=>{});
    };
  });
}

async function loadFeed(){
  try{
    const data=await api("/api/feed");
    state.videos=data.videos||[];
    render();
  }catch(e){
    console.error(e); showToast("Feed unavailable");
  }
}

function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function escapeAttr(s){return escapeHtml(s)}
function timeAgo(ts){
  const sec=Math.max(1,Math.floor(Date.now()/1000-ts));
  if(sec<60)return `${sec}s`; if(sec<3600)return `${Math.floor(sec/60)}m`;
  if(sec<86400)return `${Math.floor(sec/3600)}h`; return `${Math.floor(sec/86400)}d`;
}
function showToast(text){const el=$("toast");el.textContent=text;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),2600)}

$("infoBtn").onclick=()=>{
  $("modalContent").innerHTML=`<h3>${t("infoTitle")}</h3><p>${t("info")}</p><p>Ad providers can have country-specific availability. Actual publisher revenue should be checked in the provider's dashboard.</p>`;
  $("modal").classList.remove("hidden");
};
$("closeModal").onclick=()=>$("modal").classList.add("hidden");
$("modal").onclick=e=>{if(e.target.id==="modal")$("modal").classList.add("hidden")};

async function boot(){
  applyTheme(); applyLang(); detectAdBlock(); await initAdController();
  try{
    const initData=tg?.initData||"";
    const data=await api("/api/session",{method:"POST",body:JSON.stringify({initData})});
    state.user=data.user;
  }catch(e){console.warn("session",e)}
  await loadFeed();
}
boot();
