/**
 * @name 小蜜蜂影院
 * @version 1.1.2
 * @description OmniBox Spider for xmfyy.com
 * @downloadURL https://raw.githubusercontent.com/Silent1566/OmniBox-Spider/main/影视/采集/xmfyy.js
 */

const OmniBox = (function(){try{return require('omnibox_sdk');}catch(_){return {log(l,m){console.log(`[${l}] ${m}`);}};}})();
const runner = (function(){try{return require('spider_runner');}catch(_){return {run(){}};}})();

const SITE = "https://www.xmfyy.com";

function log(level,msg){OmniBox.log(level,`[xmfyy][${level}] ${msg}`);}

async function fetchHtml(url){
  log("info","fetch: "+url);
  const res = await OmniBox.request(url,{headers:{"User-Agent":"Mozilla/5.0","Referer":SITE}});
  return res.body || "";
}

function parseCards(html){
  const cards=[];
  const re=/<a[^>]+href="\/detail\/(\d+)\.html"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"[^>]*alt="([^"]*)"/g;
  let m;
  while((m=re.exec(html))){
    cards.push({vod_id:m[1],vod_name:(m[3]||"未知").replace(/封面图片/g,"").trim(),vod_pic:m[2],vod_remarks:""});
  }
  if(cards.length===0){
    const re2=/<a[^>]+href="\/detail\/(\d+)\.html"[^>]*>\s*<img[^>]+src="([^"]+)"[^>]*>\s*([^<]+)/g;
    while((m=re2.exec(html))) cards.push({vod_id:m[1],vod_name:m[3].trim().replace(/封面图片/g,"").trim(),vod_pic:m[2],vod_remarks:""});
  }
  return cards;
}

async function home(params,context){
  log("info","home params="+JSON.stringify(params||{}));
  try{
    const html=await fetchHtml(SITE+"/");
    const cards=parseCards(html);
    log("info","home cards="+cards.length);
    const classes=[
      {type_id:"1",type_name:"电视剧"},
      {type_id:"2",type_name:"电影"},
      {type_id:"3",type_name:"动漫"},
      {type_id:"4",type_name:"综艺"}
    ];
    return {class:classes, list:Array.isArray(cards)?cards:[]};
  }catch(e){
    log("error","home err "+e);
    return {class:[
      {type_id:"1",type_name:"电视剧"},
      {type_id:"2",type_name:"电影"},
      {type_id:"3",type_name:"动漫"},
      {type_id:"4",type_name:"综艺"}
    ], list:[]};
  }
}

async function category(params,context){
  const tid=params.categoryId||params.tid||"1";
  const pg=params.page||1;
  const map={"1":"dianshiju","2":"dianying","3":"dongman","4":"zongyi"};
  let url=SITE+"/type/"+(map[tid]||"dianshiju")+".html";
  if(pg>1) url=SITE+"/type/"+(map[tid]||"dianshiju")+"-"+pg+".html";
  const html=await fetchHtml(url);
  const cards=parseCards(html);
  log("info","category cards="+cards.length);
  return {page:pg,pagecount:9999,total:cards.length*9999,list:cards};
}

async function detail(params,context){
  const id=params.videoId||params.id;
  log("info","detail id="+id);
  const html=await fetchHtml(SITE+"/detail/"+id+".html");
  const titleM=html.match(/<h1[^>]*>([^<]+)<\/h1>/)||html.match(/《([^》]+)》/);
  let title=titleM?titleM[1].trim():"未知";
  title=title.replace(/封面图片/g,"").trim();
  const picM=html.match(/<img[^>]+class="[^"]*poster[^"]*"[^>]+src="([^"]+)"/)||html.match(/<img[^>]+src="([^"]+)"[^>]*alt="[^"]*封面/)||html.match(/poster[^>]*src="([^"]+)"/)||html.match(/<img[^>]+src="([^"]+)"[^>]*width="200"/);
  const pic=picM?picM[1]:"";
  const actorM=html.match(/"actor"\s*:\s*"([^"]+)"/)||html.match(/主演[：:]\s*([^\n<]+)/);
  let actor="";
  if(actorM) actor=actorM[1].replace(/vodInfo\.[^"]+|&nbsp;/g,"").trim();
  if(!actor){
    const a2=html.match(/>主演[：:]\s*([^<]+)/);
    if(a2) actor=a2[1].trim();
  }
  const descM=html.match(/"description"\s*:\s*"([^"]+)"/);
  let desc="";
  if(descM) desc=descM[1].replace(/\\n/g,"").trim();
  if(!desc){
    const d2=html.match(/剧情简介[\s\S]*?>([\s\S]{20,200}?)<\/p>|剧情简介[\s\S]*?>([\s\S]{20,200}?)<\/div>/);
    if(d2) desc=(d2[1]||d2[2]||"").replace(/<[^>]+>/g,"").trim();
  }
  const linesMap={};
  const re=/\/vodplay\/(\d+)-([a-z0-9]+)-(\d+)\.html/g;
  let m;
  while((m=re.exec(html))){
    const line=m[2];
    if(!linesMap[line]) linesMap[line]=new Set();
    linesMap[line].add(m[3]);
  }
  const vod_play_sources=[];
  const froms=[];
  const urls=[];
  for(const line in linesMap){
    const eps=[...linesMap[line]].sort((a,b)=>parseInt(a)-parseInt(b));
    vod_play_sources.push({name:line, episodes:eps.map(e=>({name:"第"+e+"集",playId:id+"-"+line+"-"+e}))});
    froms.push(line);
    urls.push(eps.map(e=>id+"-"+line+"-"+e).join("#"));
  }
  if(vod_play_sources.length===0){
    vod_play_sources.push({name:"默认",episodes:[{name:"播放",playId:id+"-qq-1"}]});
    froms.push("默认"); urls.push(id+"-qq-1");
  }
  log("info","detail lines="+vod_play_sources.length);
  return {list:[{vod_id:id,vod_name:title,vod_pic:pic,vod_actor:actor,vod_content:desc,vod_play_sources}]};
}

async function search(params,context){
  const wd=params.keyword||params.wd||"";
  const pg=params.page||1;
  let url=SITE+"/search?wd="+encodeURIComponent(wd);
  if(pg>1) url=SITE+"/search/page/"+pg+"/wd/"+encodeURIComponent(wd)+".html";
  const html=await fetchHtml(url);
  const cards=parseCards(html);
  log("info","search cards="+cards.length);
  return {list:cards,page:pg,pagecount:9999,total:cards.length*9999};
}

async function play(params,context){
  const playId=params.playId||params.id;
  log("info","play playId="+playId);
  const parts=String(playId).split("-");
  const id=parts[0];
  const line=parts[1]||"qq";
  const ep=parts[2]||"1";
  const referer=id?SITE+"/detail/"+id+".html":SITE;
  try{
    const apiUrl=SITE+"/api/play-url?vodId="+encodeURIComponent(id)+"&playFrom="+encodeURIComponent(line)+"&index="+encodeURIComponent(ep);
    const res=await OmniBox.request(apiUrl,{
      headers:{
        "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        "Referer":SITE+"/vodplay/"+id+"-"+line+"-"+ep+".html",
        "Accept":"*/*",
        "X-Requested-With":"XMLHttpRequest"
      }
    });
    const body=res.body||"";
    try{
      const j=JSON.parse(body);
      if(j && j.url){
        return {urls:[{name:line,url:j.url}],flag:line,header:{"Referer":SITE,"User-Agent":"Mozilla/5.0"},parse:0};
      }
    }catch(_){}
    // try regex
    const m=body.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i)||body.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
    if(m){
      return {urls:[{name:line,url:m[0]}],flag:line,header:{"Referer":SITE,"User-Agent":"Mozilla/5.0"},parse:0};
    }
  }catch(e){log("error","play err "+e);}
  const url=SITE+"/vodplay/"+id+"-"+line+"-"+ep+".html";
  return {urls:[{name:"播放",url}],flag:line,header:{"Referer":referer,"User-Agent":"Mozilla/5.0"},parse:1};
}

module.exports={home,category,detail,search,play};
runner.run(module.exports);
