// 通知許可
if ("Notification" in window && Notification.permission === "default") {
  Notification.requestPermission();
}

let notifiedQuakeKeys = [];
let notifiedEEWKey = "";

// 補助関数
function depthToText(depth) { if(depth==null||depth<0)return "不明"; if(depth===0)return "ごく浅い"; return depth+"km"; }
function scaleToText(scale){ const map={10:'1',20:'2',30:'3',40:'4',45:'5-',50:'5+',55:'6-',60:'6+',70:'7'}; return map[scale]||'不明'; }
function scaleClass(scale){ return `scale-${scale.replace('+','plus').replace('-','minus')}`; }

// ---------------------
// 地震情報取得
// ---------------------
async function fetchLatestEarthquakesWithNotify(){
  const url="https://api.p2pquake.net/v2/history?codes=551&limit=5";
  const container=document.getElementById("quakeList");
  container.innerHTML="読み込み中...";
  try{
    const res=await fetch(url);
    const data=await res.json();
    if(!data||data.length===0){ container.innerHTML="地震情報なし"; return; }

    container.innerHTML="";
    data.slice(0,5).forEach(item=>{
      const eq=item.earthquake;
      const h=eq.hypocenter;
      const place=h.name||"(発生地点不明)";
      const maxScale=scaleToText(eq.maxScale);
      const magnitude=(h.magnitude!=null&&h.magnitude>=0)?h.magnitude.toFixed(1):"不明";
      const depth=depthToText(h.depth);
      const timeStr=new Date(eq.time).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"});
      const tsunamiMsg = (eq.domesticTsunami==="Warning"||eq.domesticTsunami==="Watch") ? "津波に関する情報を発表しています。" : "この地震による津波の心配はありません。";

      const quakeDiv=document.createElement("div");
      quakeDiv.className=`quake ${scaleClass(maxScale)}`;
      quakeDiv.innerHTML=`<div class="quake-icon"><i class="fa-solid fa-earthquake"></i></div>
        <div class="quake-info">
          <div class="time">${timeStr}</div>
          <div class="place">${place}</div>
          <div class="quake-maxscale">最大震度: ${maxScale}</div>
          <div class="quake-magnitude">M: ${magnitude}</div>
          <div class="quake-depth">深さ: ${depth}</div>
          <div class="quake-tsunami">${tsunamiMsg}</div>
        </div>`;
      container.appendChild(quakeDiv);

      const key=`${item.id}_${item.issue?.type}`;
      if(!notifiedQuakeKeys.includes(key)&&Notification.permission==="granted"){
        new Notification("地震発生",{body:`${place} 最大震度:${maxScale} M${magnitude}`});
        notifiedQuakeKeys.push(key);
        if(notifiedQuakeKeys.length>5) notifiedQuakeKeys.shift();
      }
    });
  }catch(e){ container.innerHTML="地震情報取得エラー: "+e.message; }
}

// ---------------------
// EEW取得
// ---------------------
async function fetchLatestEEWWithNotify(){
  const url="https://api.wolfx.jp/jma_eew.json";
  const container=document.getElementById("eewList");
  container.innerHTML="読み込み中...";
  try{
    const res=await fetch(url);
    const data=await res.json();
    if(!data||Object.keys(data).length===0){ container.innerHTML="EEW情報なし"; return; }
    if(data.isTraining){ container.innerHTML="訓練報のため表示しません"; return; }
    if(data.isCancel){ container.innerHTML="このEEWはキャンセルされました"; return; }

    const isFinal=data.isFinal;
    const serialText=isFinal?"最終報":`第${data.Serial}報`;
    const originDate=data.OriginTime?new Date(data.OriginTime):null;
    const originStr=originDate?originDate.toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"}):"発生時刻不明";
    const hypocenter=data.Hypocenter??"震源地不明";
    const magnitude=data.Magunitude??"不明";
    const depth=data.Depth??"不明";
    const maxInt=data.MaxIntensity??"不明";

    let html=`<div class="quake ${scaleClass(maxInt)}">
      <div class="quake-icon"><i class="fa-solid fa-bolt"></i></div>
      <div class="quake-info">
        <div class="time">発生時刻: ${originStr} (${serialText})</div>
        <div class="place">${hypocenter} で地震が発生した模様です。</div>
        <div class="quake-maxscale">推定最大震度: ${maxInt}</div>
        <div class="quake-magnitude">マグニチュード: ${magnitude}</div>
        <div class="quake-depth">震源の深さ: ${depth} km</div>`;
    if(data.WarnArea&&data.WarnArea.length>0){
      const chiikiList=data.WarnArea.map(a=>a.Chiiki??a.chiiki).join("、");
      html+=`<div>対象地域: ${chiikiList}</div>`;
    }
    html+=`<div>今後の情報に注意してください。</div></div></div>`;
    container.innerHTML=html;

    const key=`${data.EventID}_${data.Serial}`;
    if(key!==notifiedEEWKey&&Notification.permission==="granted"){
      new Notification("緊急地震速報(EEW)",{body:`${hypocenter} 最大震度:${maxInt} M${magnitude}`});
      notifiedEEWKey=key;
    }

  }catch(e){ container.innerHTML="EEWデータ取得エラー: "+e.message; }
}

// 初回取得＆30秒自動更新
fetchLatestEarthquakesWithNotify();
fetchLatestEEWWithNotify();
setInterval(()=>{
  fetchLatestEarthquakesWithNotify();
  fetchLatestEEWWithNotify();
},30000);
