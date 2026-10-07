// Extract the inner PFS of a PS4 PKG from a decrypted outer PFS image (PkgTool pkg_extractouterpfs).
// usage: node pfsx.js outer.dat destDir [pathFilterSubstring] [--list]
const fs=require('fs'),path=require('path'),zlib=require('zlib');
const [outerF,dest,filter]=process.argv.slice(2);const LIST=process.argv.includes('--list');
const ofd=fs.openSync(outerF,'r');const OB=0x10000;
const rdo=(pos,len)=>{const b=Buffer.alloc(len);let n=0;while(n<len){const r=fs.readSync(ofd,b,n,len-n,pos+n);if(r<=0)throw new Error('short read');n+=r}return b};
// ---- outer: find the big compressed inode (pfs_image.dat), map its blocks
const osb=rdo(0,0x60);const signed=(osb.readUInt16LE(0x1c)&1)!==0;const OIS=signed?0x2c8:0xa8;const oPtr=signed?36:4,oOff=signed?32:0;
const ninodes=Number(osb.readBigUInt64LE(0x30));const itab=rdo(OB,ninodes*OIS);
let img=null;for(let i=0;i<ninodes;i++){const o=i*OIS;const sz=Number(itab.readBigUInt64LE(o+8));if(!img||sz>img.size)img={o,size:sz,csize:Number(itab.readBigUInt64LE(o+0x10)),blocks:itab.readUInt32LE(o+0x60)}}
function mapBlocks(ino,tab,ptr,off,blockSize,rdBlock,count){const res=[];const base=ino+0x64;for(let k=0;k<12&&res.length<count;k++)res.push(tab.readUInt32LE(base+k*ptr+off));
 const per=Math.floor(blockSize/ptr);const walk=(blk,depth)=>{if(res.length>=count||blk===0)return;const b=rdBlock(blk);for(let i=0;i<per&&res.length<count;i++){const e=b.readUInt32LE(i*ptr+off);if(depth===0)res.push(e);else walk(e,depth-1)}};
 for(let lvl=0;lvl<5&&res.length<count;lvl++)walk(tab.readUInt32LE(base+12*ptr+lvl*ptr+off),lvl);return res}
const oblk=mapBlocks(img.o,itab,oPtr,oOff,OB,b=>rdo(b*OB,OB),img.blocks);
const imgRead=(pos,len)=>{const out=Buffer.alloc(len);let done=0;while(done<len){const bi=Math.floor((pos+done)/OB),bo=(pos+done)%OB;const n=Math.min(OB-bo,len-done);fs.readSync(ofd,out,done,n,oblk[bi]*OB+bo);done+=n}return out};
// ---- PFSC random access reader
function pfscReader(read,total){const h=read(0,0x30);if(h.toString('latin1',0,4)!=='PFSC')return null;const bs=Number(h.readBigUInt64LE(0x10)),tOff=Number(h.readBigUInt64LE(0x18)),dlen=Number(h.readBigUInt64LE(0x28));
 const n=Math.ceil(dlen/bs);const tb=read(tOff,(n+1)*8);const cache=new Map();
 const block=i=>{if(cache.has(i))return cache.get(i);const a=Number(tb.readBigUInt64LE(i*8)),b=Number(tb.readBigUInt64LE(i*8+8));let d;
  if(b===a)d=Buffer.alloc(bs);else{const c=read(a,b-a);d=(b-a)===bs?c:zlib.inflateSync(c,{finishFlush:zlib.constants.Z_SYNC_FLUSH});if(d.length<bs){const t=Buffer.alloc(bs);d.copy(t);d=t}}
  if(cache.size>64)cache.delete(cache.keys().next().value);cache.set(i,d);return d};
 return {size:dlen,read:(pos,len)=>{const out=Buffer.alloc(len);let done=0;while(done<len){const bi=Math.floor((pos+done)/bs),bo=(pos+done)%bs;const n=Math.min(bs-bo,len-done);block(bi).copy(out,done,bo,bo+n);done+=n}return out}}}
const inner=pfscReader(imgRead,img.size)||{size:img.size,read:imgRead};
// ---- inner PFS
const isb=inner.read(0,0x60);const IB=isb.readInt32LE(0x20);const imode=isb.readUInt16LE(0x1c);const i64=(imode&2)!==0,isig=(imode&1)!==0;
const IIS=isig?(i64?0x310:0x2c8):(i64?0x100:0xa8);const iptr=isig?(i64?40:36):(i64?8:4),ioff=isig?32:0;
const icount=Number(isb.readBigUInt64LE(0x30)),superroot=Number(isb.readBigUInt64LE(0x48));
const inodesPerBlock=Math.floor(IB/IIS);
const inode=n=>{const blk=1+Math.floor(n/inodesPerBlock),o=(n%inodesPerBlock)*IIS;return inner.read(blk*IB+o,IIS)};
const rdi=b=>inner.read(b*IB,IB);
const ptrRead=(b,o)=>i64?Number(b.readBigUInt64LE(o)):b.readUInt32LE(o);
function fileBlocks(ib){const nb=ib.readUInt32LE(0x60);const res=[];const base=0x64;if(nb>1&&ptrRead(ib,base+iptr+ioff)===(i64?0xffffffffffffffff:0xffffffff)){const s=ptrRead(ib,base+ioff);for(let k=0;k<nb;k++)res.push(s+k);return res}for(let k=0;k<12&&res.length<nb;k++)res.push(ptrRead(ib,base+k*iptr+ioff));
 const per=Math.floor(IB/iptr);const walk=(blk,depth)=>{if(res.length>=nb||blk===0)return;const b=rdi(blk);for(let i=0;i<per&&res.length<nb;i++){const e=ptrRead(b,i*iptr+ioff);if(depth===0)res.push(e);else walk(e,depth-1)}};
 for(let l=0;l<5&&res.length<nb;l++)walk(ptrRead(ib,base+12*iptr+l*iptr+ioff),l);return res}
function readFileRaw(ib){const blocks=fileBlocks(ib);const csz=Number(ib.readBigUInt64LE(0x10));
 return (pos,len)=>{const out=Buffer.alloc(len);let done=0;while(done<len){const bi=Math.floor((pos+done)/IB),bo=(pos+done)%IB;const n=Math.min(IB-bo,len-done);inner.read(blocks[bi]*IB+bo,n).copy(out,done);done+=n}return out}}
function dirEntries(ib){const size=Number(ib.readBigUInt64LE(8));const rd=readFileRaw(ib);const ents=[];const blocks=Math.ceil(size/IB);
 for(let b=0;b<blocks;b++){const buf=rd(b*IB,Math.min(IB,size-b*IB));let p=0;while(p+16<=buf.length){const ino=buf.readInt32LE(p),type=buf.readInt32LE(p+4),nl=buf.readInt32LE(p+8),es=buf.readInt32LE(p+12);if(es<=0)break;
  if(ino>0||type>0)ents.push({ino,type,name:buf.toString('utf8',p+16,p+16+nl)});p+=es}}return ents}
let files=0,bytes=0,stats={pfsc:0};
function walkDir(ino,rel){for(const e of dirEntries(inode(ino))){if(e.name==='.'||e.name==='..'||e.type===4||e.type===5)continue;const p=rel?rel+'/'+e.name:e.name;
 if(e.type===3){walkDir(e.ino,p)}else if(e.type===2){if(filter&&!p.includes(filter))continue;const ib=inode(e.ino);const size=Number(ib.readBigUInt64LE(8)),csize=Number(ib.readBigUInt64LE(0x10)),flags=ib.readUInt32LE(4);
  if(LIST){console.log(p,size,csize,flags.toString(16));continue}
  const raw=readFileRaw(ib);let src={read:raw,size};if((flags&1)&&csize!==size){const r=pfscReader(raw,csize);if(r){src=r;stats.pfsc++}}
  const outP=path.join(dest,p);fs.mkdirSync(path.dirname(outP),{recursive:true});const fd=fs.openSync(outP,'w');const CH=8*1024*1024;
  for(let pos=0;pos<size;pos+=CH){const n=Math.min(CH,size-pos);fs.writeSync(fd,src.read(pos,n),0,n,pos)}fs.closeSync(fd);files++;bytes+=size;if(files%100===0)console.log(files,'files',(bytes/1e9).toFixed(1),'GB')}}}
// superroot: find 'uroot'
const sr=dirEntries(inode(superroot));const ur=sr.find(e=>e.name==='uroot');console.log('inner block',IB,'mode',imode.toString(16),'inodes',icount,'superroot',sr.map(e=>e.name).join(','));
walkDir(ur.ino,'');console.log('done files',files,'bytes',bytes,stats);
