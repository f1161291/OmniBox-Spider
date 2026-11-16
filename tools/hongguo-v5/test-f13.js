// JS 移植 Kotlin Signer.hashF13 (mobileV5=true)，用官方 signing-v5-f13.json 对拍
const fs=require('fs');
const HT=fs.readFileSync('hashtable.txt','utf8').split(',').map(x=>parseInt(x,16)|0);
const u32=x=>x>>>0;
const rol=(x,n)=>u32((x<<(n&31))|(x>>>(32-(n&31))));
const ror=(x,n)=>u32((x>>>(n&31))|(x<<(32-(n&31))));
const le32=(x)=>{const b=Buffer.alloc(4);b.writeUInt32LE(u32(x));return b;};
const be32=(x)=>{const b=Buffer.alloc(4);b.writeUInt32BE(u32(x));return b;};
function getIv(initial,data){let v=u32(initial);for(let i=0;i<data.length;i++){
  if((i&1)===0) v=u32((v>>>4)^v^(v<<6)^data[i]);
  else v=u32(~((v>>>7)^v^(data[i]|(v<<12))));
}return v;}
function sumMd5(data){let check=0x20220420;for(let i=0;i<12;i++){
  const temp=(u32(check>>>((i&1)===0?3:5))^check)>>>0;
  check=(i&1)===0 ? u32(data[i]^((check<<7)>>>0)) : u32(~(data[i]|(u32(check<<11))));
  check=u32(check^temp);
}return check|0;}
const xor=(a,b)=>{const n=Math.min(a.length,b.length),o=Buffer.alloc(n);for(let i=0;i<n;i++)o[i]=a[i]^b[i];return o;};

function hashF13V5(query,body,ts){
  // v5 要求 iv&15 === 12
  const iv=getIv(getIv(getIv(0x20230928,query),body),le32(ts));
  if((iv&15)!==12) throw new Error(`branch ${iv&15} != 12`);
  const ivV1=0x9d4a97c2|0;
  const count=u32(ivV1+ts);
  const tt=HT.map(x=>ror(x,(count+1)&255));
  const shift=(count+2)&7;
  const pad=Buffer.from([0xfa,0x45,0x61,0xd7].map(x=>((x|(x<<8))>>>shift)&255));
  const data=Buffer.concat([query,body,le32(ts),pad,Buffer.from('00000000000001a0','hex')]);
  const di=[];for(let i=0;i<data.length;i+=4)di.push(data.readInt32BE(i));
  for(let i=0;i<112;i++){
    const x=di[i+1],y=di[i+14];
    di.push(u32(di[i]+di[i+9]+(rol(x,14)^rol(x,25)^(x>>>3))+(rol(y,13)^rol(y,15)^(y>>>10)))|0);
  }
  const initial=[0x7aba4fc8,0x67166507,0x6403fa00,0x340f512f,984304912,3005047866|0,2874125293|0,2152413264|0].map(x=>ror(x,count));
  const chosen=[96,1,3,4,0,6,5,2,0,7,7];
  const d=initial.slice();
  for(let i=0;i<chosen[0];i++){
    const base=u32(ivV1+i)&0xffffffff;
    const n1=((d[chosen[3]]^d[chosen[4]])&d[chosen[1]])^d[chosen[3]];
    const n2=rol(d[chosen[1]],26)^rol(d[chosen[1]],21)^rol(d[chosen[1]],7);
    const n4=u32(di[base&127]+n1+n2+tt[base&63]+d[chosen[5]]);
    const n5=rol(d[chosen[2]],30)^rol(d[chosen[2]],19)^rol(d[chosen[2]],10);
    const n6=(d[chosen[2]]&d[chosen[6]])|((d[chosen[2]]|d[chosen[6]])&d[chosen[7]]);
    const old=d[chosen[9]];
    d.unshift(d.pop());
    d[chosen[10]]=u32(n5+n6+n4)|0;
    d[chosen[8]]=u32(old+n4)|0;
  }
  const ret=Buffer.concat([0,1,2,3,4,5,6,7].map(i=>be32(u32(d[i]+initial[i]))));
  const folded=xor(ret.subarray(0,16),ret.subarray(16,32));
  return Buffer.concat([folded,le32(u32(sumMd5(folded)|0x20))]);
}

// 对拍 32 个官方测试向量
const vectors=JSON.parse(fs.readFileSync('signing-v5-f13.json','utf8'));
let pass=0,fail=0;
for(const v of vectors){
  try{
    const got=hashF13V5(Buffer.from(v.query,'hex'),Buffer.from(v.body,'hex'),v.ts);
    const hex=got.subarray(0,16).toString('hex');
    if(hex===v.digest)pass++;
    else{fail++;if(fail<=3)console.log('FAIL ts=',v.ts,'got=',hex,'want=',v.digest);}
  }catch(e){fail++;if(fail<=3)console.log('ERR ts=',v.ts,e.message);}
}
console.log(`对拍结果: pass=${pass} fail=${fail} / ${vectors.length}`);
