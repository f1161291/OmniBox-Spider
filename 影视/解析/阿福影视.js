/**
 * @name 阿福影视
 * @version 1.0.0
 * @description OmniBox Spider for afuys.com
 */

const OmniBox = (function(){try{return require('omnibox_sdk');}catch(_){return {log(l,m){console.log(`[${l}] ${m}`);}};}})();
const runner = (function(){try{return require('spider_runner');}catch(_){return {run(){}};}})();

const SITE = "https://www.afuys.com";

function log(level,msg){OmniBox.log(level,`[afuys][${level}] ${msg}`);}

async function fetchHtml(url){
  log("info","fetch: "+url);
  const res = await OmniBox.request(url,{headers:{"User-Agent":"Mozilla/5.0","Referer":SITE}});
  return res.body || "";
}

function extractPlayerData(html){
  const idx=html.indexOf("player_data=");
  if(idx<0) return null;
  const start=html.indexOf("{",idx);
  if(start<0) return null;
  let depth=0,end=-1;
  for(let i=start;i<html.length;i++){
    const c=html[i];
    if(c==="{") depth++;
    else if(c==="}"){depth--;if(depth===0){end=i;break;}}
  }
  if(end<0) return null;
  return html.slice(start,end+1);
}

function parseCards(html){
  const cards=[];
  const re=/<a[^>]+href="\/html\/(\d+)\.html"[^>]*title="([^"]+)"[^>]*data-original="([^"]+)"/g;
  let m;
  while((m=re.exec(html))){
    cards.push({vod_id:m[1],vod_name:m[2],vod_pic:m[3],vod_remarks:""});
  }
  if(cards.length===0){
    const re2=/<a[^>]+href="\/html\/(\d+)\.html"[^>]*>[\s\S]*?<img[^>]+data-original="([^"]+)"[^>]*alt="([^"]*)"/g;
    while((m=re2.exec(html))) cards.push({vod_id:m[1],vod_name:m[3]||"未知",vod_pic:m[2],vod_remarks:""});
  }
  if(cards.length===0){
    const re3=/<a[^>]+href="\/html\/(\d+)\.html"[^>]*>([^<]+)<\/a>/g;
    while((m=re3.exec(html))) cards.push({vod_id:m[1],vod_name:m[2].trim(),vod_pic:"",vod_remarks:""});
  }
  return cards;
}

async function home(params,context){
  log("info","home params="+JSON.stringify(params||{}));
  const html=await fetchHtml(SITE+"/");
  const cards=parseCards(html);
  log("info","home cards="+cards.length);
  const classes=[
    {type_id:"1",type_name:"电影"},
    {type_id:"2",type_name:"电视剧"},
    {type_id:"3",type_name:"动漫"},
    {type_id:"4",type_name:"综艺"}
  ];
  return {class:classes,list:cards};
}

async function category(params,context){
  const tid=params.categoryId||params.tid||"1";
  const pg=params.page||1;
  let url=SITE+"/sort/"+tid+".html";
  if(pg>1) url=SITE+"/sort/"+tid+"-"+pg+".html";
  const html=await fetchHtml(url);
  const cards=parseCards(html);
  log("info","category cards="+cards.length);
  return {page:pg,pagecount:9999,total:cards.length*9999,list:cards};
}

async function detail(params,context){
  const id=params.videoId||params.id;
  log("info","detail id="+id);
  const html=await fetchHtml(SITE+"/html/"+id+".html");
  const titleM=html.match(/<title>《([^》]+)》/)||html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const title=titleM?titleM[1].trim():"未知";
  const picM=html.match(/data-original="([^"]+)"/);
  const pic=picM?picM[1]:"";
  const actorM=html.match(/演员：<\/span>([^<]+)/)||html.match(/"vod_actor":"([^"]+)"/);
  const actor=actorM?actorM[1].trim():"";
  const descM=html.match(/剧情介绍：<\/span>([^<]+)/)||html.match(/"description":"([^"]+)"/);
  const desc=descM?descM[1].trim():"";
  // lines: /yun/{id}-{line}-{ep}.html
  const linesMap={};
  const re=/\/yun\/(\d+)-(\d+)-(\d+)\.html/g;
  let m;
  while((m=re.exec(html))){
    const line=m[2];
    if(!linesMap[line]) linesMap[line]=new Set();
    linesMap[line].add(m[3]);
  }
  const vod_play_sources=[];
  for(const line in linesMap){
    const eps=[...linesMap[line]].sort((a,b)=>parseInt(a)-parseInt(b));
    vod_play_sources.push({name:"线路"+line, episodes:eps.map(e=>({name:"第"+e+"集",playId:id+"-"+line+"-"+e}))});
  }
  if(vod_play_sources.length===0){
    vod_play_sources.push({name:"默认",episodes:[{name:"播放",playId:id+"-1-1"}]});
  }
  log("info","detail lines="+vod_play_sources.length);
  return {list:[{vod_id:id,vod_name:title,vod_pic:pic,vod_actor:actor,vod_content:desc,vod_play_sources}]};
}

async function search(params,context){
  const wd=params.keyword||params.wd||"";
  const pg=params.page||1;
  const url=SITE+"/sou/"+encodeURIComponent(wd)+"-------------.html";
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
  const line=parts[1]||"1";
  const ep=parts[2]||"1";
  const url=SITE+"/yun/"+id+"-"+line+"-"+ep+".html";
  const html=await fetchHtml(url);
  // extract url from player_data JSON
  const pdStr=extractPlayerData(html);
  if(pdStr){
    try{
      const j=JSON.parse(pdStr);
      if(j && j.url){
        const playUrl=String(j.url).replace(/\\\//g,"/");
        return {urls:[{name:j.from||"播放",url:playUrl}],flag:j.from||"线路"+line,header:{"Referer":SITE,"User-Agent":"Mozilla/5.0"},parse:0};
      }
    }catch(e){/* ignore */}
  }
  const m=html.match(/"url"\s*:\s*"([^"]+\.m3u8[^"]*)"/);
  if(m){
    let playUrl=m[1].replace(/\\\//g,"/");
    return {urls:[{name:"播放",url:playUrl}],flag:"线路"+line,header:{"Referer":SITE,"User-Agent":"Mozilla/5.0"},parse:0};
  }
  return {urls:[{name:"播放",url}],flag:"线路"+line,header:{"Referer":SITE,"User-Agent":"Mozilla/5.0"},parse:1};
}

module.exports={home,category,detail,search,play};
runner.run(module.exports);
