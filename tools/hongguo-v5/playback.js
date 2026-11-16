const fs=require('fs'),crypto=require('crypto'),https=require('https'),zlib=require('zlib');
const B=require('./sign.js');
const {hashF13V5,AesV3V5,sm3,getIv,le32,be32,u32,rol,ror,xor,md5,MAGIC,LICENSE,SIGNKEY}=B;
const randBytes=n=>crypto.randomBytes(n);
// protobuf writer (from script)
const varint=value=>{let n=BigInt(value);const a=[];while(n>127n){a.push(Number((n&127n)|128n));n>>=7n;}a.push(Number(n));return Buffer.from(a);};
const sint=value=>{let n=BigInt(String(value));if(n<0n)n=(n<<1n)^-1n;else n=n<<1n;return n;};
function field(no,value,kind){if(value==null||value===''||value===false||value===0||(Buffer.isBuffer(value)&&!value.length))return Buffer.alloc(0);if(kind==='sint')return Buffer.concat([varint(BigInt(no<<3)),varint(sint(String(value)))]);if(kind==='float'){const w=Buffer.alloc(4);w.writeFloatLE(Number(value));return Buffer.concat([varint(BigInt((no<<3)|5)),w]);}let wire=Buffer.isBuffer(value)?value:Buffer.from(String(value));return Buffer.concat([varint(BigInt((no<<3)|2)),varint(wire.length),wire]);}
const proto=fields=>Buffer.concat(fields.map(([n,v,k])=>field(n,v,k)));
// xmxor (from script)
const rol8=(x,n)=>((x<<(n&7))|(x>>>(8-(n&7))))&255;
function xmxorTwo(data,key){const o=Buffer.alloc(data.length);for(let i=0;i<data.length;i++){const p=(i*4)&28,d0=key[p],d1=key[p+1];let d2=(rol8(data[i],4)+d0)&255;d2=(~d2)^d1;d2=rol8(d2&255,3);d2=((d2+d1)&255)^d0;o[data.length-1-i]=(~d2)&255;}return o;}
function xmxor(data,key){const v=xmxorTwo(data,key),last=v[v.length-1]^v[v.length-2],d0=v[0];v[0]=((~last)+v[0])&255;v[1]=((v[0]^v[v.length-1]^254)+v[1])&255;v[2]=(v[2]+((last-d0)^rol8(v[1],3)^2))&255;for(let i=0;i<v.length-4;i++)v[i+3]=((~(rol8(v[i+2],3)^v[i+1]^(i+3)))+v[i+3])&255;v[v.length-1]^=v[v.length-2];let s=0;for(let i=1;i<v.length;i++)s+=v[i];v[0]=((v[0]^v[1])+s)&255;return v;}

const processNonce=randBytes(18).toString('base64url');
const processStarted=Date.now();
const rand32=()=>randBytes(4).readUInt32LE(0);
const i64le=(buf,at)=>buf.readBigInt64LE(at);
const le64=x=>{const b=Buffer.alloc(8);let n=BigInt(x)&((1n<<64n)-1n);b.writeBigUInt64LE(n);return b;};

function medusaV5(url,body,ts,who){
 const query=sm3(Buffer.from(url.split('?')[1]||'','utf8'));
 const f13=hashF13V5(query,body?md5(body):Buffer.alloc(16),ts);
 const flags=Buffer.alloc(8),version=who.version_name;
 const deviceInfo=proto([[1,1,'sint'],[2,2,'sint'],[3,'8662'],[4,who.device_id],[5,processNonce],[6,'!noperm!'],[12,'Asia/Shanghai,8'],[13,'zh_CN'],[22,who.os_version],[25,processStarted,'sint'],[30,who.device_type],[31,'HONOR'],[32,who.device_type],[34,'HONOR']]);
 const env=proto([[6,'v04.10.03.04-bugfix'],[8,who.channel],[12,deviceInfo],[14,version]]);
 const message=proto([
  [1,MAGIC],[2,5,'sint'],[3,u32(rand32()),'sint'],[4,'8662'],[5,who.device_id],[6,LICENSE],[7,version],[8,'v04.10.03-ml-android'],[9,0x040a0300,'sint'],[10,flags],[12,ts,'sint'],[13,f13],[14,query.subarray(0,6)],
  [15,proto([[1,1,'sint'],[2,1,'sint'],[3,1,'sint'],[5,1,'sint']])],
  [17,ts,'sint'],[20,'none'],[21,377,'sint'],[23,env],
  [24,'{"cmr":16777216,"cmr2":16777216,"un_h":11,"vpn":0,"kd":0,"dyn":"","do":1,"tk":true}'],
 ]);
 const nonce=rand32(),key=SIGNKEY;
 const hash=sm3(Buffer.concat([key,le32(nonce),key]));
 const high=(nonce>>>16)&255;
 const seed=le32(u32(~(((high<<11)|(nonce>>>24))^(high>>>5)^high)));
 let transformed=Buffer.concat([flags,xmxor(message,hash)]).reverse();
 for(let i=0;i<transformed.length;i++)transformed[i]=(transformed[i]^seed[(~i)&3])&255;
 const check=(0x18000001|((query[0]&63)<<14)|((f13[0]&63)<<8))>>>0;
 const packed=Buffer.concat([Buffer.from([0xca]),le32(rand32()),le32(check),transformed,Buffer.from([(nonce>>>16)&255,(nonce>>>24)&255])]);
 const enc=new AesV3V5(md5(key.subarray(0,16)),ts).encrypt(packed,md5(key.subarray(16,32)));
 const prefix=Buffer.concat([le32(5),MAGIC]);const tsb=le32(ts);for(let i=0;i<prefix.length;i++)prefix[i]^=tsb[i&3];
 return Buffer.concat([prefix,Buffer.from([nonce&255,(nonce>>>8)&255,0,1]),enc]).toString('base64');
}
function helios(ts){
 const random=rand32();
 const ascii=Buffer.from(md5(Buffer.concat([le32(random),Buffer.from('8662')])).toString('hex'),'ascii');
 const words=[];for(let i=0;i<4;i++)words.push(ascii.readBigInt64LE(i*8));
 const M=(x,n)=>BigInt.asUintN(64,(x>>BigInt(n))|(x<<BigInt(64-n)));
 const table=[words[0]];let b0=words[1],b8=words[2],rest=words.slice(3);
 for(let i=0;i<34;i++){let x8=BigInt.asUintN(64,M(b8,8)+b0)^BigInt(i);rest.push(x8);x8^=M(b0,61);table.push(x8);b0=x8;b8=rest.shift();}
 const text=Buffer.from(`${ts}-${LICENSE}-8662`),pad=16-text.length%16;
 const data=Buffer.concat([text,Buffer.alloc(pad,pad)]);
 let output=le32(random);
 for(let at=0;at<data.length;at+=16){let a=data.readBigInt64LE(at),b=data.readBigInt64LE(at+8);for(let i=0;i<34;i++){b=BigInt.asUintN(64,table[i]^(a+M(b,8)));a=b^M(a,61);}output=Buffer.concat([output,le64(a),le64(b)]);}
 return output.toString('base64');
}
function branch(query,body,ts){const iv=getIv(getIv(getIv(0x20230928,sm3(Buffer.from(query,'utf8'))),body?md5(body):Buffer.alloc(16)),le32(ts));return (iv&15)===12?0:1;}
const pythonUrlEncode=v=>Object.entries(v).map(([k,x])=>encodeURIComponent(k)+'='+encodeURIComponent(String(x==null?'':x)).replace(/%2A/gi,'*').replace(/[!'()]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())).join('&');
function signPlayback(base,values,body,now){
 const ts=Math.floor(now/1000);
 for(let off=0;off<1024;off++){
  const ticket=now+off,q=pythonUrlEncode({...values,_rticket:String(ticket)});
  if(branch(q,body,ts)!==0)continue;
  const url=`${base}?${q}`,headers={
   'x-ss-req-ticket':String(ticket),'sdk-version':'2','x-xs-from-web':'0','x-khronos':String(ts),
   'x-helios':helios(ts),'x-medusa':medusaV5(url,body,ts,values),
  };
  if(body){headers['Content-Type']='application/json; charset=utf-8';headers['x-ss-stub']=md5(body).toString('hex').toUpperCase();}
  return {url,headers,body};
 }
 throw new Error('no valid ticket');
}
module.exports={signPlayback,medusaV5,helios,branch,hashF13V5,pythonUrlEncode};
