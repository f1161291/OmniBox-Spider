const fs=require('fs');
const SBOX=Buffer.from(fs.readFileSync('v5sbox.txt','utf8').trim(),'hex');
const u32=x=>x>>>0;
const xor=(a,b)=>{const o=Buffer.alloc(Math.min(a.length,b.length));for(let i=0;i<o.length;i++)o[i]=a[i]^b[i];return o;};
const le32=x=>{const b=Buffer.alloc(4);b.writeUInt32LE(u32(x));return b;};

class AesV3V5{
 constructor(key,ts){
  this.word=ts&3;
  this.box=SBOX.subarray(this.word*256,(this.word+1)*256);
  this.con=[[2,0,3,1],[1,3,2,0],[3,2,1,0],[2,3,1,0]][this.word];
  this.order=[[0,9,14,15,4,13,2,7,8,1,6,3,12,5,10,11],[0,9,14,11,4,13,2,3,8,1,6,15,12,5,10,7],[0,9,14,3,4,13,2,15,8,1,6,11,12,5,10,7],[0,9,14,15,4,13,2,3,8,1,6,11,12,5,10,7]][this.word];
  const initial=[0xbbb5de72,0xd4638d5b,0x92a5f73b,0x89f8a1c9][this.word]|0;
  const mk=Buffer.alloc(48);
  for(let i=0;i<16;i++)mk[i]=(((initial>>>((i&3)*8))&255)^key[i])&255;
  let rounds=8;
  for(let i=4;i<12;i++){
   const idx=4*(i-1);let [a,b,c,d]=[mk[idx],mk[idx+1],mk[idx+2],mk[idx+3]];
   if((i&3)===0){const t=((initial>>>(rounds&24))^this.box[b])&255;b=this.box[c];c=this.box[d];d=this.box[a];a=t;}
   rounds+=2;
   mk[idx+4]=(a^mk[idx-12])&255;mk[idx+5]=(b^mk[idx-11])&255;mk[idx+6]=(c^mk[idx-10])&255;mk[idx+7]=(d^mk[idx-9])&255;
  }
  this.keys=[];for(let i=0;i<12;i++)this.keys.push(mk.subarray(i*4,i*4+4));
 }
 block(value){
  const rows=[];for(let i=0;i<4;i++){const r=[];for(let j=0;j<4;j++)r.push(value[i*4+j]);rows.push(r);}
  const addCon=(off)=>{for(let i=0;i<4;i++)for(let j=0;j<4;j++)rows[i][j]^=this.keys[off+i][this.con[j]];};
  addCon(0);
  for(let r=1;r<3;r++){
   for(let i=0;i<4;i++)for(let j=0;j<4;j++)rows[i][j]=this.box[rows[i][j]];
   const before=rows.map(x=>x.slice());for(let i=0;i<4;i++)rows[i]=before[this.con[i]].slice();
   const flat=rows.flat();for(let i=0;i<16;i++)rows[(i/4)|0][i%4]=flat[this.order[i]];
   if(r===1){
    for(let i=0;i<4;i++){const old=rows[i].slice();rows[i]=this.con.map(x=>old[x]);}
    const xt=x=>((x<<1)^((x&128)?0x1b:0))&255;
    for(let i=0;i<4;i++){
     const t=rows[0][i]^rows[1][i]^rows[2][i]^rows[3][i],u=rows[0][i];
     rows[0][i]^=t^xt(rows[0][i]^rows[1][i]);rows[1][i]^=t^xt(rows[1][i]^rows[2][i]);
     rows[2][i]^=t^xt(rows[2][i]^rows[3][i]);rows[3][i]^=t^xt(rows[3][i]^u);
    }
   }
   addCon(r*4);
  }
  for(let i=0;i<4;i++)for(let j=0;j<4;j++)rows[i][j]^=this.keys[4+i][j];
  return Buffer.from(rows.flat());
 }
 encrypt(source,iv){
  const wire=[6,5,3,4,2,7,1,0],compact=[1,7,3,6,2,0,4,5];
  const plain=Buffer.alloc(32);
  for(let i=0;i<31;i++)for(let j=0;j<8;j++)plain[i]|=((source[i*8+j]>>wire[j])&1)<<compact[j];
  plain[31]=1;
  const first=this.block(xor(plain.subarray(0,16),iv));
  const key=Buffer.concat([first,this.block(xor(plain.subarray(16,32),first))]);
  const out=Buffer.from(source);
  for(let i=0;i<31;i++)for(let j=0;j<8;j++){
   const at=i*8+j;
   out[at]=((out[at]&~(1<<wire[j]))|(((key[i]>>compact[j])&1)<<wire[j]))&255;
  }
  return Buffer.concat([Buffer.from([key[key.length-1]]),out]);
 }
}

// 用 carrier 向量对拍
const vec=JSON.parse(fs.readFileSync('signing-v5-carrier.json','utf8'));
let pass=0,fail=0;
for(const v of vec){
 try{
  const a=new AesV3V5(Buffer.from(v.key,'hex'),v.ts);
  const got=a.encrypt(Buffer.from(v.source,'hex'),Buffer.from(v.iv,'hex')).toString('hex');
  if(got===v.encrypted)pass++;
  else{fail++;console.log('FAIL ts',v.ts,'\n got ',got,'\n want',v.encrypted);}
 }catch(e){fail++;console.log('ERR',e.message);}
}
console.log(`AesV3-V5 对拍: pass=${pass} fail=${fail} / ${vec.length}`);
