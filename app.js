/* ============================================================
   CHIEF'S EXECUTION ASSISTANT — v2
   New in this version:
     · Study Workspace (independent subjects / chapters, live sessions,
       quick-log, auto-advancing chapter status from real minutes)
     · Scroll restore across renders (Tasks page no longer jumps to top)
     · Calendar side drawer with click-to-add
     · Data file auto-save (File System Access API, IndexedDB-backed handle)
   ============================================================ */

/* ------------------------------------------------------------
   0. UTILITIES
   ------------------------------------------------------------ */
   const $  = (s,r=document)=>r.querySelector(s);
   const $$ = (s,r=document)=>[...r.querySelectorAll(s)];
   const uid = ()=>Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4);
   const pad = n=>String(n).padStart(2,'0');
   const esc = s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
   
   function dstr(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());}
   function parseD(s){const [y,m,d]=String(s).split('-').map(Number);return new Date(y,(m||1)-1,d||1);}
   function todayStr(){return dstr(new Date());}
   function daysBetween(a,b){return Math.round((parseD(b)-parseD(a))/86400000);}
   function t2m(t){const [h,m]=String(t||'00:00').split(':').map(Number);return (h||0)*60+(m||0);}
   function m2t(m){m=((Math.round(m)%1440)+1440)%1440;return pad(Math.floor(m/60))+':'+pad(m%60);}
   function fmtDur(min){
     min=Math.round(min||0);
     const h=Math.floor(min/60), m=min%60;
     return h? (h+'h'+(m?' '+m+'m':'')) : (m+'m');
   }
   function fmtDate(s){const d=parseD(s);return d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric'});}
   function nowMin(){const d=new Date();return d.getHours()*60+d.getMinutes();}
   function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
   function relDate(days){const d=new Date();d.setDate(d.getDate()+days);return dstr(d);}
   
   function toast(msg){
     const el=document.createElement('div');
     el.className='toast'; el.textContent=msg;
     $('#toasts').appendChild(el);
     setTimeout(()=>{el.style.transition='.4s';el.style.opacity='0';el.style.transform='translateX(40px)';
       setTimeout(()=>el.remove(),400);},2600);
   }
   
   /* ------------------------------------------------------------
      1. INDEXEDDB (to persist the file handle across sessions)
      ------------------------------------------------------------ */
   function idbOpen(){
     return new Promise((res,rej)=>{
       const r=indexedDB.open('cea_fs',1);
       r.onupgradeneeded=()=>r.result.createObjectStore('kv');
       r.onsuccess=()=>res(r.result);
       r.onerror=()=>rej(r.error);
     });
   }
   async function idbSet(k,v){
     const db=await idbOpen();
     return new Promise((res,rej)=>{
       const tx=db.transaction('kv','readwrite');
       tx.objectStore('kv').put(v,k);
       tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error);
     });
   }
   async function idbGet(k){
     const db=await idbOpen();
     return new Promise((res,rej)=>{
       const tx=db.transaction('kv','readonly');
       const r=tx.objectStore('kv').get(k);
       r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);
     });
   }
   async function idbDel(k){
     const db=await idbOpen();
     return new Promise((res,rej)=>{
       const tx=db.transaction('kv','readwrite');
       tx.objectStore('kv').delete(k);
       tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error);
     });
   }
   
   /* ------------------------------------------------------------
      2. FILE SYNC (auto-save to a JSON file on disk)
      ------------------------------------------------------------ */
   const FileSync = {
     handle:null,
     connected:false,
     saving:false,
     lastSave:null,
     supported: typeof window!=='undefined' && 'showSaveFilePicker' in window,
   
     async init(){
       try{
         const h=await idbGet('dataFileHandle');
         if(h){
           this.handle=h;
           const perm=await h.queryPermission({mode:'readwrite'});
           if(perm==='granted'){
             this.connected=true;
             await this.loadFromFile();
           }
         }
       }catch(e){ console.warn('FileSync init failed', e); }
       this.updateUI();
     },
   
     async connect(){
       if(!this.supported){
         toast('Browser does not support file sync — use Export JSON');
         return;
       }
       try{
         const handle=await window.showSaveFilePicker({
           suggestedName:'chief-execution-data.json',
           types:[{description:'JSON',accept:{'application/json':['.json']}}]
         });
         this.handle=handle;
         this.connected=true;
         await idbSet('dataFileHandle',handle);
         await this.save();
         toast('Data file connected · auto-save ON');
         this.updateUI();
       }catch(e){
         if(e && e.name!=='AbortError') toast('Connection failed');
       }
     },
   
     async reconnect(){
       if(!this.handle) return this.connect();
       try{
         const perm=await this.handle.requestPermission({mode:'readwrite'});
         if(perm==='granted'){
           this.connected=true;
           await this.loadFromFile();
           toast('Reconnected · auto-save ON');
         } else toast('Permission denied');
       }catch(e){ toast('Reconnect failed'); }
       this.updateUI();
     },
   
     async save(){
       if(!this.handle || !this.connected || this.saving) return;
       this.saving=true;
       try{
         const w=await this.handle.createWritable();
         DB.savedAt=new Date().toISOString();
         await w.write(JSON.stringify(DB,null,2));
         await w.close();
         this.lastSave=new Date();
         this.updateUI();
       }catch(e){
         console.warn('File save failed', e);
         toast('File save failed');
       } finally { this.saving=false; }
     },
   
     async loadFromFile(){
       try{
         const file=await this.handle.getFile();
         const txt=await file.text();
         if(!txt.trim()) return;
         const data=JSON.parse(txt);
         if(data && data.settings){
           DB=data;
           migrate();
           try{ localStorage.setItem(DB_KEY, JSON.stringify(DB)); }catch(e){}
           render();
           toast('Loaded data from file');
         }
       }catch(e){ console.warn('Load from file failed', e); }
     },
   
     async disconnect(){
       this.handle=null; this.connected=false;
       try{ await idbDel('dataFileHandle'); }catch(e){}
       toast('Data file disconnected');
       this.updateUI();
     },
   
     updateUI(){
       const p=$('#filePill'); if(!p) return;
       const t=$('#filePillText');
       if(this.connected){
         p.classList.add('on');
         t.textContent='DATA FILE · AUTO-SAVE';
       } else if(this.handle){
         p.classList.remove('on');
         t.textContent='DATA FILE · RECONNECT';
       } else {
         p.classList.remove('on');
         t.textContent='DATA FILE · LOCAL ONLY';
       }
       // also refresh any settings page view
       const settingsView=$('#view');
       if(settingsView && settingsView.dataset.view==='settings') render();
     }
   };
   
   /* ------------------------------------------------------------
      3. DATABASE
      ------------------------------------------------------------ */
   const DB_KEY='cea_db_v1';
   let DB=null;
   
   function futureDate(month,day){
     const now=new Date();
     const today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
     let d=new Date(now.getFullYear(),month-1,day);
     if(d<today) d=new Date(now.getFullYear()+1,month-1,day);
     return dstr(d);
   }
   
   /* ------------------------------------------------------------
      4. SEED
      ------------------------------------------------------------ */
   const SUBJECT_COLORS=['#d4af37','#6fb7e0','#7fe0a0','#b48ce0','#e6b95c','#e07a6a','#e8a0c0','#7fe0d4'];
   
   function seed(){
     const now=todayStr();
   
     const settings={
       user:'Chief',
       wake:'06:00', sleep:'23:00',
       bufferMinutes:10,
       focusDuration:40, breakDuration:10,
       maxStudyMinutesPerDay:300,
       exerciseTarget:30, englishTarget:15, projectTime:30, recreationAllowance:60,
       examModeThreshold:10,
       distractions:'Tablet · Instagram · YouTube · Gaming · PC'
     };
   
     const commitments=[
       {id:uid(),title:'Morning Routine & Prep',type:'routine', start:'06:00',end:'07:30',days:[0,1,2,3,4,5,6]},
       {id:uid(),title:'School',                type:'school', start:'07:30',end:'13:30',days:[1,2,3,4,5,6]},
       {id:uid(),title:'Lunch',                 type:'meal',   start:'14:15',end:'14:40',days:[0,1,2,3,4,5,6]},
       {id:uid(),title:'Chemistry Coaching',    type:'coaching',start:'15:30',end:'17:00',days:[1,2,4,6]},
       {id:uid(),title:'Physics Coaching',      type:'coaching',start:'17:30',end:'19:00',days:[1,3,5]},
       {id:uid(),title:'Dinner',                type:'meal',   start:'19:00',end:'19:30',days:[0,1,2,3,4,5,6]},
     ];
   
     const ch=(name,status='NOT_STARTED')=>({id:uid(),name,status,
       est:{learn:45,practice:40,numericals:45,revision:20,test:30}});
   
     const exams=[
       {id:uid(),subject:'Physics',title:'Physics — Board Exam',date:futureDate(9,18),
        start:'09:00',end:'12:00',importance:'HIGH',
        chapters:['Electric Charges and Fields','Electric Potential','Capacitance','Current Electricity',
          'Magnetic Effects of Current','Magnetism','Electromagnetic Induction','Alternating Current']
          .map((c,i)=>ch(c, i<2?'PRACTICE': i<4?'LEARNING':'NOT_STARTED'))},
       {id:uid(),subject:'Biology',title:'Biology — Board Exam',date:futureDate(9,21),
        start:'09:00',end:'12:00',importance:'HIGH',
        chapters:['Reproduction in Flowering Plants','Human Reproduction','Reproductive Health',
          'Principles of Inheritance and Variation','Molecular Basis of Inheritance','Evolution',
          'Human Health and Disease','Microbes in Human Welfare']
          .map((c,i)=>ch(c, i<1?'PRACTICE': i<3?'LEARNING':'NOT_STARTED'))},
       {id:uid(),subject:'Chemistry',title:'Chemistry — Board Exam',date:futureDate(9,24),
        start:'09:00',end:'12:00',importance:'HIGH',
        chapters:['Solutions','Electrochemistry','Chemical Kinetics','Coordination Compounds',
          'Haloalkanes and Haloarenes','Alcohols, Phenols and Ethers']
          .map((c,i)=>ch(c, i<2?'LEARNING':'NOT_STARTED'))},
       {id:uid(),subject:'Chemistry',title:'Chemistry Test — Coordination Compounds',date:futureDate(9,20),
        start:'10:00',end:'11:30',importance:'MEDIUM',
        chapters:[ch('Coordination Compounds','LEARNING')]},
     ];
   
     const T=(title,cat,subject,priority,est,deadline,opts={})=>({
       id:uid(),title,category:cat,subject,priority,estimatedMinutes:est,
       actualMinutes:0,deadline,status:'TODO',
       difficulty:opts.difficulty||'MEDIUM',
       notes:opts.notes||'',
       objective:opts.objective||'',
       subtasks:opts.subtasks||[],
       chapterId:opts.chapterId||null,
       createdAt:now, completedAt:null
     });
   
     const tasks=[
       T("Physics — Electric Potential: point charge + 5 numericals",'ACADEMICS','Physics',1,45,now,
         {objective:"Understand electric potential due to a point charge and solve 5 problems.",
          subtasks:[
           {id:uid(),title:"Derive V = kQ/r",done:false,duration:12},
           {id:uid(),title:"Potential due to system of charges",done:false,duration:13},
           {id:uid(),title:"Solve 5 numericals",done:false,duration:20}]}),
       T("Physics — Current Electricity: Drift velocity & Ohm's law",'ACADEMICS','Physics',1,45,relDate(1),
         {objective:"Learn drift velocity, mobility and Ohm's law with 8 problems.",
          subtasks:[
           {id:uid(),title:"Drift velocity derivation",done:false,duration:15},
           {id:uid(),title:"Ohm's law + resistivity",done:false,duration:15},
           {id:uid(),title:"8 numerical problems",done:false,duration:15}]}),
       T("Chemistry — Coordination Compounds: nomenclature + isomers",'ACADEMICS','Chemistry',1,40,relDate(1),
         {objective:"Master IUPAC naming and isomerism in coordination compounds."}),
       T("Biology — Human Reproduction: diagrams practice",'ACADEMICS','Biology',2,40,relDate(2),
         {objective:"Draw and label 6 key diagrams from memory."}),
       T("Biology Practical File — Experiment 3 & 4",'FILES','Biology',2,50,relDate(2),
         {objective:"Complete Experiment 3 and 4 write-ups with diagrams.",
          subtasks:[
           {id:uid(),title:"Experiment 3 write-up",done:false,duration:25},
           {id:uid(),title:"Experiment 4 write-up",done:false,duration:25}]}),
       T("Physics Notebook — pending classwork",'FILES','Physics',3,35,relDate(3),
         {objective:"Copy pending notes and solved examples."}),
       T("English Speaking — 15 min fluency drill",'SKILLS','English',3,15,now,
         {objective:"Speak aloud for 15 minutes on a chosen topic."}),
       T("Exercise — 30 min session",'HEALTH','Physical',3,30,now,
         {objective:"Complete 30 minutes of physical activity."}),
       T("FRIDAY Project — Runtime controller milestone",'PROJECT','FRIDAY',4,40,relDate(5),
         {objective:"Implement the runtime controller module."}),
       T("Chemistry Notebook — pending classwork",'FILES','Chemistry',3,35,relDate(4)),
       T("Recreation — controlled gaming block",'RECREATION','Personal',4,60,now,
         {objective:"Enjoy a bounded recreation block."}),
       T("Revision — Physics Capacitance quick pass",'ACADEMICS','Physics',2,30,relDate(2),
         {objective:"Rapid revision of capacitance formulas and 5 problems."}),
     ];
   
     const habits=[
       {id:uid(),title:'English Speaking',minutes:15,days:[0,1,2,3,4,5,6],streak:0,lastDone:null,examSafe:true},
       {id:uid(),title:'Exercise',minutes:30,days:[0,1,2,3,4,5,6],streak:0,lastDone:null,examSafe:true},
       {id:uid(),title:'Reading',minutes:20,days:[0,1,2,3,4,5,6],streak:0,lastDone:null,examSafe:false},
       {id:uid(),title:'FRIDAY Development',minutes:30,days:[5],streak:0,lastDone:null,examSafe:false},
     ];
   
     const files=[
       {id:uid(),subject:'Physics',type:'Notebook',deadline:relDate(3),remaining:'12 pages',estimatedMinutes:70,priority:3,status:'PENDING',sessions:['Pages 1–4','Pages 5–8','Pages 9–12']},
       {id:uid(),subject:'Chemistry',type:'Notebook',deadline:relDate(4),remaining:'9 pages',estimatedMinutes:55,priority:3,status:'PENDING',sessions:['Pages 1–5','Pages 6–9']},
       {id:uid(),subject:'Biology',type:'Practical File',deadline:relDate(2),remaining:'Exp 3 & 4',estimatedMinutes:50,priority:2,status:'PENDING',sessions:['Experiment 3','Experiment 4','Diagrams']},
       {id:uid(),subject:'Physics',type:'Practical File',deadline:relDate(6),remaining:'3 experiments',estimatedMinutes:90,priority:3,status:'PENDING',sessions:['Experiment 1','Experiment 2','Experiment 3']},
     ];
   
     const projects=[
       {id:uid(),title:'FRIDAY',description:'Personal intelligence system project.',
        milestones:[{id:uid(),title:'Intelligence System',tasks:[
          {id:uid(),title:'Implement runtime controller',done:false,duration:40},
          {id:uid(),title:'Wire event bus',done:false,duration:30},
        ]}]}
     ];
   
     /* --- NEW: independent study workspace --- */
     const subjects=[
       {id:uid(),name:'Physics',color:'#d4af37',createdAt:now,chapters:[
         mkChapter('Electric Charges and Fields'),
         mkChapter('Electric Potential'),
         mkChapter('Capacitance'),
         mkChapter('Current Electricity'),
       ]},
       {id:uid(),name:'Chemistry',color:'#6fb7e0',createdAt:now,chapters:[
         mkChapter('Solutions'),
         mkChapter('Electrochemistry'),
         mkChapter('Coordination Compounds'),
       ]},
       {id:uid(),name:'Biology',color:'#7fe0a0',createdAt:now,chapters:[
         mkChapter('Reproduction in Flowering Plants'),
         mkChapter('Human Reproduction'),
         mkChapter('Molecular Basis of Inheritance'),
       ]},
     ];
   
     return {
       version:2, settings, commitments, tasks, exams, habits, files, projects,
       subjects,
       schedule:null, focusSessions:[], reviews:[], log:[],
       savedAt:null
     };
   }
   
   function mkChapter(name){
     return {
       id:uid(), name,
       manualStatus:null,
       totalMinutes:0,
       sessions:[],
       lastStudied:null,
       createdAt:todayStr()
     };
   }
   
   /* ------------------------------------------------------------
      5. LOAD / SAVE / MIGRATE
      ------------------------------------------------------------ */
   function migrate(){
     if(!DB) return;
     if(!DB.subjects) DB.subjects=[];
     DB.subjects.forEach(s=>{
       if(!s.color) s.color=SUBJECT_COLORS[Math.floor(Math.random()*SUBJECT_COLORS.length)];
       if(!s.chapters) s.chapters=[];
       s.chapters.forEach(c=>{
         if(!c.sessions) c.sessions=[];
         if(typeof c.totalMinutes!=='number') c.totalMinutes=0;
         if(c.manualStatus===undefined) c.manualStatus=null;
         if(!c.createdAt) c.createdAt=todayStr();
       });
     });
     DB.tasks.forEach(t=>{ if(t.chapterId===undefined) t.chapterId=null; });
     DB.version=2;
   }
   
   function loadDB(){
     try{
       const raw=localStorage.getItem(DB_KEY);
       if(raw){ const p=JSON.parse(raw); if(p && p.settings){ DB=p; migrate(); return DB; } }
     }catch(e){ console.warn('DB load failed', e); }
     DB=seed();
     try{ localStorage.setItem(DB_KEY, JSON.stringify(DB)); }catch(e){}
     return DB;
   }
   
   /* Debounced write: localStorage immediately, file after 700ms */
   let _saveTimer=null;
   function saveDB(){
     try{ localStorage.setItem(DB_KEY, JSON.stringify(DB)); }catch(e){}
     clearTimeout(_saveTimer);
     _saveTimer=setTimeout(()=>FileSync.save(), 700);
   }
   
   /* ------------------------------------------------------------
      6. CHAPTER HELPERS (NEW)
      ------------------------------------------------------------ */
   const CHAPTER_STATUSES=['NOT_STARTED','STARTED','LEARNING','PRACTICE','REVISION','TESTED','MASTERED'];
   
   function computeChapterStatus(ch){
     if(ch.manualStatus) return ch.manualStatus;
     const m=ch.totalMinutes||0;
     if(m===0)   return 'NOT_STARTED';
     if(m<30)    return 'STARTED';
     if(m<90)    return 'LEARNING';
     if(m<150)   return 'PRACTICE';
     if(m<240)   return 'REVISION';
     return 'TESTED';
   }
   function statusPct(s){
     return {NOT_STARTED:2,STARTED:15,LEARNING:35,PRACTICE:55,REVISION:75,TESTED:92,MASTERED:100}[s]||0;
   }
   function findChapterRef(id){
     for(const s of (DB.subjects||[])){
       const c=s.chapters.find(x=>x.id===id);
       if(c) return {chapter:c, subject:s};
     }
     return null;
   }
   function logChapterSession(chapterId, minutes, opts={}){
     const ref=findChapterRef(chapterId);
     if(!ref) return false;
     const {chapter:ch}=ref;
     ch.sessions=ch.sessions||[];
     ch.sessions.push({
       id:uid(),
       start:opts.start||new Date().toISOString(),
       end:opts.end||new Date().toISOString(),
       minutes,
       taskId:opts.taskId||null,
       note:opts.note||''
     });
     ch.totalMinutes=(ch.totalMinutes||0)+minutes;
     ch.lastStudied=todayStr();
     return true;
   }
   
   /* ------------------------------------------------------------
      7. PRIORITY ENGINE
      ------------------------------------------------------------ */
   function nearestExam(subject){
     if(!subject) return null;
     const s=String(subject).toLowerCase();
     const list=DB.exams.filter(e=>{
       const es=e.subject.toLowerCase();
       return es===s || s.includes(es) || es.includes(s);
     });
     if(!list.length) return null;
     return list.slice().sort((a,b)=>parseD(a.date)-parseD(b.date))[0];
   }
   function examModeActive(){
     const th=DB.settings.examModeThreshold||10;
     const soon=DB.exams.map(e=>daysBetween(todayStr(),e.date)).filter(d=>d>=0).sort((a,b)=>a-b)[0];
     return soon!==undefined && soon<=th;
   }
   function nextExam(){
     return DB.exams.slice().filter(e=>daysBetween(todayStr(),e.date)>=0)
       .sort((a,b)=>parseD(a.date)-parseD(b.date))[0]||null;
   }
   function taskScore(t){
     const base={1:40,2:28,3:16,4:6};
     let s=base[t.priority]??12;
     if(t.deadline){
       const d=daysBetween(todayStr(),t.deadline);
       if(d<0) s+=60; else if(d===0) s+=50; else if(d===1) s+=38;
       else if(d<=3) s+=26; else if(d<=7) s+=16; else if(d<=14) s+=8; else s+=2;
     }
     const ex=nearestExam(t.subject);
     if(ex){
       const d=daysBetween(todayStr(),ex.date);
       if(d>=0){
         if(d<=2) s+=45; else if(d<=5) s+=32; else if(d<=10) s+=18; else if(d<=20) s+=8;
       }
     }
     const cat=t.category;
     if(cat==='ACADEMICS') s+=8;
     if(cat==='FILES') s+=5;
     if(cat==='HEALTH') s+=3;
     if(cat==='PROJECT') s-=6;
     if(cat==='RECREATION') s-=16;
     if(t.estimatedMinutes<=25) s+=5;
     if(t.status==='IN_PROGRESS') s+=6;
     if(examModeActive() && cat==='RECREATION') s-=20;
     if(examModeActive() && cat==='PROJECT') s-=10;
     return s;
   }
   function scoreToLevel(sc){
     if(sc>=95) return 'P0';
     if(sc>=78) return 'P1';
     if(sc>=58) return 'P2';
     if(sc>=35) return 'P3';
     return 'P4';
   }
   function rankedTasks(){
     const open=DB.tasks.filter(t=>!['COMPLETED','SKIPPED'].includes(t.status));
     const scored=open.map(t=>({task:t,score:taskScore(t)}));
     scored.sort((a,b)=>b.score-a.score);
     let p0=0;
     scored.forEach(s=>{
       let lv=scoreToLevel(s.score);
       if(lv==='P0'){ p0++; if(p0>3) lv='P1'; }
       s.level=lv;
     });
     return scored;
   }
   function levelOfTask(id){
     const r=rankedTasks().find(x=>x.task.id===id);
     return r? r.level : 'P4';
   }
   
   /* ------------------------------------------------------------
      8. SCHEDULER
      ------------------------------------------------------------ */
   function commitmentsFor(weekday){
     return DB.commitments.filter(c=>c.days.includes(weekday))
       .map(c=>({...c,s:t2m(c.start),e:t2m(c.end)}))
       .sort((a,b)=>a.s-b.s);
   }
   function mergeIntervals(list){
     const out=[];
     list.slice().sort((a,b)=>a.s-b.s).forEach(iv=>{
       if(out.length && iv.s<=out[out.length-1].e){
         out[out.length-1].e=Math.max(out[out.length-1].e,iv.e);
       } else out.push({...iv});
     });
     return out;
   }
   function complement(start,end,busy){
     const out=[]; let cur=start;
     busy.forEach(b=>{
       if(b.s>cur) out.push({s:cur,e:b.s});
       cur=Math.max(cur,b.e);
     });
     if(cur<end) out.push({s:cur,e:end});
     return out.filter(iv=>iv.e-iv.s>=15);
   }
   function buildDayPlan(dateStr,opts={}){
     const S=DB.settings;
     const dayStart=t2m(S.wake), dayEnd=t2m(S.sleep);
     const wd=parseD(dateStr).getDay();
     const rawBusy=commitmentsFor(wd);
     const blocks=rawBusy.map(b=>({type:b.type,title:b.title,start:b.s,end:b.e,fixed:true}));
     const trans=Math.max(0,S.bufferMinutes|0);
     const padded=mergeIntervals(rawBusy.map(b=>({s:b.s-trans,e:b.e+trans})));
     let free=complement(dayStart,dayEnd,padded);
     if(opts.fromMin!==undefined){
       free=free.map(iv=>({s:Math.max(iv.s,opts.fromMin),e:iv.e})).filter(iv=>iv.e-iv.s>=15);
     }
     const ranked=rankedTasks();
     const queue=ranked.map(r=>({task:r.task,level:r.level,score:r.score}));
     const maxStudy=Math.max(60,(S.maxStudyMinutesPerDay||300)-(opts.lostMinutes||0));
     const focusLen=S.focusDuration||40;
     const breakLen=S.breakDuration||10;
     let placed=0;
     const studyBlocks=[];
     for(const iv of free){
       let cursor=iv.s; let guard=0;
       while(queue.length && cursor<iv.e && placed<maxStudy && guard++<80){
         const item=queue[0];
         const total=item.task.estimatedMinutes||40;
         const rem=(item._rem!==undefined)? item._rem : total;
         const avail=iv.e-cursor;
         if(avail<12) break;
         const len=Math.min(rem,focusLen,avail);
         if(len<12) break;
         studyBlocks.push({
           type:'task', taskId:item.task.id, title:item.task.title,
           subject:item.task.subject, category:item.task.category,
           level:item.level, start:cursor, end:cursor+len, part: rem<total
         });
         cursor+=len; placed+=len;
         const left=rem-len;
         if(left<=0) queue.shift(); else item._rem=left;
         if(queue.length && placed<maxStudy && cursor+breakLen<=iv.e){
           studyBlocks.push({type:'break',title:'Break',start:cursor,end:cursor+breakLen});
           cursor+=breakLen;
         }
       }
     }
     const all=blocks.concat(studyBlocks).sort((a,b)=>a.start-b.start);
     return {date:dateStr,blocks:all,generatedAt:Date.now(),lostMinutes:opts.lostMinutes||0};
   }
   function getSchedule(){
     if(!DB.schedule || DB.schedule.date!==todayStr()){
       DB.schedule=buildDayPlan(todayStr());
       saveDB();
     }
     return DB.schedule;
   }
   function regenerate(lostMinutes,fromNow){
     DB.schedule=buildDayPlan(todayStr(),{
       lostMinutes:lostMinutes||0,
       fromMin: fromNow? nowMin() : undefined
     });
     saveDB();
   }
   function blockStatus(b){
     if(b.fixed) return 'fixed';
     if(b.type==='break') return 'break';
     const t=b.taskId? DB.tasks.find(x=>x.id===b.taskId):null;
     if(t){
       if(t.status==='COMPLETED') return 'completed';
       if(t.status==='SKIPPED')   return 'skipped';
       if(t.status==='DEFERRED'||t.status==='RESCHEDULED') return 'skipped';
     }
     const n=nowMin();
     if(n>=b.start && n<b.end) return 'active';
     if(n>=b.end) return 'missed';
     return 'upcoming';
   }
   function currentBlock(){
     const sch=getSchedule(); const n=nowMin();
     return sch.blocks.find(b=>b.type==='task' && n>=b.start && n<b.end) || null;
   }
   function nextBlock(){
     const sch=getSchedule(); const n=nowMin();
     return sch.blocks.find(b=>b.type==='task' && b.start>=n) || null;
   }
   function openTasks(){ return DB.tasks.filter(t=>!['COMPLETED','SKIPPED'].includes(t.status)); }
   
   /* ------------------------------------------------------------
      9. STATS
      ------------------------------------------------------------ */
   function todayStats(){
     const sch=getSchedule();
     const taskBlocks=sch.blocks.filter(b=>b.type==='task');
     const unique=new Set(taskBlocks.map(b=>b.taskId));
     const plannedTasks=unique.size;
     const plannedMin=taskBlocks.reduce((a,b)=>a+(b.end-b.start),0);
     let completed=0, actualMin=0;
     unique.forEach(id=>{
       const t=DB.tasks.find(x=>x.id===id);
       if(t && t.status==='COMPLETED'){ completed++; actualMin+=(t.actualMinutes||0); }
     });
     const fs=DB.focusSessions.filter(f=>f.date===todayStr());
     const focusMin=fs.reduce((a,f)=>a+f.minutes,0);
     const exec = plannedMin>0 ? Math.round(clamp((Math.max(actualMin,focusMin)/plannedMin)*100,0,140)) : 0;
     return {
       plannedTasks, completed, remaining:Math.max(0,plannedTasks-completed),
       plannedMin, actualMin:Math.max(actualMin,focusMin), focusMin,
       execution: Math.min(exec,100)
     };
   }
   function subjectTotals(){
     return (DB.subjects||[]).map(s=>{
       const total=s.chapters.reduce((a,c)=>a+(c.totalMinutes||0),0);
       const advanced=s.chapters.filter(c=>['PRACTICE','REVISION','TESTED','MASTERED'].includes(computeChapterStatus(c))).length;
       const last=s.chapters.reduce((a,c)=>c.lastStudied && (!a||c.lastStudied>a)?c.lastStudied:a,null);
       return {subject:s, total, advanced, chapterCount:s.chapters.length, last};
     });
   }
   
   /* ------------------------------------------------------------
      10. FOCUS TIMER (with chapter support)
      ------------------------------------------------------------ */
   const Timer={
     running:false, remaining:0, total:0,
     taskId:null, chapterId:null,
     startedAt:null, tick:null, launch:false,
   
     setTask(taskId,minutes){
       this.stopSilently();
       this.taskId=taskId; this.chapterId=null;
       const t=DB.tasks.find(x=>x.id===taskId);
       const mins=minutes|| (t? Math.min(t.estimatedMinutes||40,DB.settings.focusDuration||40):40);
       this.total=mins*60; this.remaining=this.total; this.startedAt=null; this.launch=false;
       this.render();
     },
     setChapter(chapterId,minutes){
       this.stopSilently();
       this.taskId=null; this.chapterId=chapterId;
       const mins=minutes|| (DB.settings.focusDuration||40);
       this.total=mins*60; this.remaining=this.total; this.startedAt=null; this.launch=false;
       this.render();
     },
     start(){
       if(this.running) return;
       if(!this.taskId && !this.chapterId){ toast('Select a task or chapter first'); return; }
       this.running=true;
       this.startedAt=this.startedAt||new Date().toISOString();
       if(this.taskId){
         const t=DB.tasks.find(x=>x.id===this.taskId);
         if(t && t.status==='TODO'){ t.status='IN_PROGRESS'; saveDB(); }
       }
       this.tick=setInterval(()=>{
         this.remaining--;
         if(this.remaining<=0){ this.remaining=0; this.complete(); return; }
         this.render();
       },1000);
       this.render(); renderFocusPill();
     },
     pause(){
       if(!this.running) return;
       this.running=false; clearInterval(this.tick); this.tick=null;
       this.render(); renderFocusPill();
     },
     stopSilently(){ this.running=false; clearInterval(this.tick); this.tick=null; },
     reset(){
       this.stopSilently();
       this.taskId=null; this.chapterId=null;
       this.remaining=0; this.total=0;
       this.startedAt=null; this.launch=false;
       this.render(); renderFocusPill();
     },
     elapsedSec(){ return this.total-this.remaining; },
     commit(){
       const secs=this.elapsedSec();
       if(secs<60) return 0;
       const minutes=Math.round(secs/60);
       const endISO=new Date().toISOString();
   
       let subjectLbl='—';
   
       if(this.chapterId){
         const ref=findChapterRef(this.chapterId);
         if(ref){
           subjectLbl=ref.subject.name+' · '+ref.chapter.name;
           logChapterSession(this.chapterId, minutes, {start:this.startedAt, end:endISO});
         }
       } else if(this.taskId){
         const t=DB.tasks.find(x=>x.id===this.taskId);
         if(t){
           t.actualMinutes=(t.actualMinutes||0)+minutes;
           subjectLbl=t.subject||t.category;
           if(t.chapterId){
             logChapterSession(t.chapterId, minutes, {start:this.startedAt, end:endISO, taskId:t.id});
           }
         }
       }
   
       DB.focusSessions.push({
         id:uid(),
         taskId:this.taskId,
         chapterId:this.chapterId,
         subject:subjectLbl,
         date:todayStr(),
         start:this.startedAt||endISO,
         end:endISO,
         minutes,
         mode:this.launch?'launch':'focus'
       });
       saveDB();
       return minutes;
     },
     complete(){
       const mins=this.commit();
       this.pause();
       if(this.taskId && this.remaining<=0){
         const t=DB.tasks.find(x=>x.id===this.taskId);
         if(t){ t.status='COMPLETED'; t.completedAt=new Date().toISOString(); saveDB(); }
         toast('Task completed');
       } else if(this.chapterId && this.remaining<=0){
         toast('Session complete · '+mins+' min logged');
       } else {
         toast('Session logged · '+mins+' min');
       }
       this.reset();
       render();
     },
     render(){
       const mm=Math.floor(this.remaining/60), ss=this.remaining%60;
       const el=$('#execTimer'); if(el) el.textContent=pad(mm)+':'+pad(ss);
       const bar=$('#execBar');
       if(bar) bar.style.width=(this.total? ((this.total-this.remaining)/this.total*100):0)+'%';
       const tag=$('#execTag');
       const task=$('#execTask'), obj=$('#execObj');
   
       if(this.chapterId){
         const ref=findChapterRef(this.chapterId);
         if(tag) tag.textContent=this.launch? '5-MINUTE LAUNCH · JUST START' : 'STUDY SESSION';
         if(task) task.textContent = ref? (ref.subject.name+' — '+ref.chapter.name) : 'Study Session';
         if(obj) obj.textContent = ref? ('Accumulated: '+(ref.chapter.totalMinutes||0)+' min · Status: '+computeChapterStatus(ref.chapter)) : '';
       } else {
         const t=DB.tasks.find(x=>x.id===this.taskId);
         if(tag) tag.textContent=this.launch? '5-MINUTE LAUNCH · JUST START' : 'EXECUTION MODE';
         if(task) task.textContent = t? t.title : 'No task selected';
         if(obj) obj.textContent = t? (t.objective || t.notes || 'Complete this task with full focus.') : 'Select a task or chapter to begin.';
       }
     }
   };
   function renderFocusPill(){
     const p=$('#focusPill'), t=$('#focusPillText');
     if(!p) return;
     if(Timer.running){
       p.classList.add('on');
       if(Timer.chapterId){
         const ref=findChapterRef(Timer.chapterId);
         t.textContent='STUDY · '+(ref?ref.chapter.name.slice(0,20):'—')+' · '+pad(Math.floor(Timer.remaining/60))+':'+pad(Timer.remaining%60);
       } else {
         const task=DB.tasks.find(x=>x.id===Timer.taskId);
         t.textContent='FOCUS · '+(task?task.subject:'—')+' · '+pad(Math.floor(Timer.remaining/60))+':'+pad(Timer.remaining%60);
       }
     } else { p.classList.remove('on'); t.textContent='NO ACTIVE SESSION'; }
   }
   
   /* ------------------------------------------------------------
      11. NAVIGATION + SHELL
      ------------------------------------------------------------ */
   const NAV=[
     ['dashboard','Dashboard','◈'],
     ['today','Today','▤'],
     ['tasks','Tasks','✓'],
     ['exams','Exams','✦'],
     ['study','Study','◎'],
     ['calendar','Calendar','▦'],
     ['projects','Projects','▣'],
     ['files','Files','▥'],
     ['habits','Habits','◍'],
     ['analytics','Analytics','◐'],
     ['settings','Settings','⚙'],
   ];
   let VIEW='dashboard';
   let STUDY_OPEN={};
   
   function renderNav(){
     const nav=$('#nav'); if(!nav) return;
     nav.innerHTML=NAV.map(([id,label,icon])=>`
       <button class="nav-item ${VIEW===id?'active':''}" data-act="nav" data-id="${id}">
         <span class="ni">${icon}</span><span>${label}</span>
       </button>`).join('');
   }
   function renderExamPill(){
     const p=$('#examPill'), t=$('#examPillText');
     if(!p) return;
     const on=examModeActive();
     p.classList.toggle('on',on);
     const nx=nextExam();
     t.textContent = on
       ? 'EXAM MODE · '+(nx? nx.subject.toUpperCase()+' IN '+daysBetween(todayStr(),nx.date)+'D':'ON')
       : 'EXAM MODE · OFF';
   }
   function renderClock(){
     const d=new Date();
     $('#topDate').textContent=d.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).toUpperCase();
     $('#topTime').innerHTML=pad(d.getHours())+':'+pad(d.getMinutes())+'<span class="sec">:'+pad(d.getSeconds())+'</span>';
   }
   
   /* ------------------------------------------------------------
      12. VIEWS
      ------------------------------------------------------------ */
   const CAT_COLOR={
     ACADEMICS:'gold', FILES:'info', SKILLS:'violet', HEALTH:'good',
     PROJECT:'violet', PERSONAL:'', RECREATION:'warn', OTHER:''
   };
   function catTag(c){ return `<span class="tag ${CAT_COLOR[c]||''}">${esc(c)}</span>`; }
   
   /* ---------- DASHBOARD ---------- */
   function viewDashboard(){
     const sch=getSchedule();
     const st=todayStats();
     const nx=nextExam();
     const ranked=rankedTasks();
     const cb=currentBlock();
     const curTask = cb? DB.tasks.find(t=>t.id===cb.taskId) : null;
     const nb = nextBlock();
     const nbTask = nb? DB.tasks.find(t=>t.id===nb.taskId) : null;
   
     const primary = nx
       ? `Prepare for ${nx.subject} examination on ${parseD(nx.date).toLocaleDateString('en-GB',{day:'numeric',month:'long'})}`
       : 'Maintain execution consistency across all subjects';
   
     const topPriorities=ranked.slice(0,6);
   
     return `
     <div class="section-head">
       <div>
         <div class="section-title">Chief's Execution Dashboard</div>
         <div class="small muted mt8">${new Date().getHours()<12?'Good morning':new Date().getHours()<17?'Good afternoon':'Good evening'}, ${esc(DB.settings.user)}.</div>
       </div>
       <div class="flex gap8 wrap">
         <button class="btn" data-act="regen">⟳ Regenerate Day</button>
         <button class="btn ghost" data-act="whatnow">⚡ What Should I Do Now?</button>
       </div>
     </div>
   
     <div class="grid g2" style="margin-bottom:16px;">
       <div class="card">
         <div class="card-title">Today's Primary Mission</div>
         <div style="font-size:17px;font-weight:700;color:var(--gold-2);line-height:1.4;">${esc(primary)}</div>
         ${nx?`<div class="mt16 flex gap8 wrap">
           <span class="tag gold">NEXT EXAM · ${esc(nx.subject.toUpperCase())}</span>
           <span class="tag ${daysBetween(todayStr(),nx.date)<=3?'bad':'warn'}">${daysBetween(todayStr(),nx.date)} DAYS</span>
           <span class="tag">${fmtDate(nx.date)}</span>
         </div>`:''}
       </div>
       <div class="card">
         <div class="card-title">Execution Score</div>
         <div class="flex between center" style="align-items:flex-end;">
           <div>
             <div class="stat" style="border:none;padding:0;background:none;">
               <div class="lbl">Planned vs Actual</div>
               <div class="val">${st.execution}%</div>
             </div>
           </div>
           <div style="text-align:right;">
             <div class="small muted">Planned study</div>
             <div class="mono" style="color:var(--gold-2);font-size:15px;">${fmtDur(st.plannedMin)}</div>
             <div class="small muted mt8">Actual study</div>
             <div class="mono" style="color:var(--good);font-size:15px;">${fmtDur(st.actualMin)}</div>
           </div>
         </div>
         <div class="bar"><i style="width:${st.execution}%"></i></div>
         <div class="small muted mt8">A measurement of plan vs execution — not a moral score.</div>
       </div>
     </div>
   
     <div class="grid g4" style="margin-bottom:16px;">
       <div class="stat"><div class="lbl">Planned Tasks</div><div class="val">${st.plannedTasks}</div><div class="sub">scheduled today</div></div>
       <div class="stat"><div class="lbl">Completed</div><div class="val" style="color:var(--good)">${st.completed}</div><div class="sub">tasks finished</div></div>
       <div class="stat"><div class="lbl">Remaining</div><div class="val" style="color:var(--warn)">${st.remaining}</div><div class="sub">still in play</div></div>
       <div class="stat"><div class="lbl">Focus Logged</div><div class="val" style="color:var(--info)">${fmtDur(st.focusMin)}</div><div class="sub">timer sessions</div></div>
     </div>
   
     <div class="grid g2">
       <div class="card">
         <div class="card-title">Current Task</div>
         ${curTask?`
           <div style="font-size:15px;font-weight:700;color:var(--gold-2);">${esc(curTask.title)}</div>
           <div class="t-meta mt8">
             ${catTag(curTask.category)}
             <span class="pri ${levelOfTask(curTask.id)}">${levelOfTask(curTask.id)}</span>
             <span>${esc(curTask.subject||'')}</span>
             <span>Est ${fmtDur(curTask.estimatedMinutes)}</span>
             <span>Actual ${fmtDur(curTask.actualMinutes||0)}</span>
           </div>
           <div class="bar"><i style="width:${Math.min(100,Math.round(((curTask.actualMinutes||0)/(curTask.estimatedMinutes||1))*100))}%"></i></div>
           <div class="flex gap8 wrap mt16">
             <button class="btn primary" data-act="start-task" data-id="${curTask.id}">▶ Start</button>
             <button class="btn" data-act="pause-task">⏸ Pause</button>
             <button class="btn" data-act="complete-task" data-id="${curTask.id}">✓ Complete</button>
             <button class="btn ghost" data-act="skip-task" data-id="${curTask.id}">Skip</button>
             <button class="btn ghost" data-act="resched-task" data-id="${curTask.id}">Reschedule</button>
           </div>
         `: (nbTask?`
           <div class="small muted">Nothing active right now. Next up at <span class="mono" style="color:var(--gold-2)">${m2t(nb.start)}</span></div>
           <div style="font-size:15px;font-weight:700;color:var(--gold-2);margin-top:9px;">${esc(nbTask.title)}</div>
           <div class="t-meta mt8">
             ${catTag(nbTask.category)}
             <span class="pri ${levelOfTask(nbTask.id)}">${levelOfTask(nbTask.id)}</span>
             <span>${fmtDur(nb.end-nb.start)}</span>
           </div>
           <div class="flex gap8 wrap mt16">
             <button class="btn primary" data-act="start-task" data-id="${nbTask.id}">▶ Start Early</button>
             <button class="btn ghost" data-act="whatnow">⚡ What Now?</button>
           </div>
         `:`<div class="empty">No active or upcoming task blocks. Regenerate the day or add tasks.</div>`)}
       </div>
   
       <div class="card">
         <div class="card-title">Today's Priorities</div>
         ${topPriorities.length? topPriorities.map(r=>`
           <div class="flex between center" style="padding:8px 0;border-bottom:1px solid rgba(212,175,55,.08);">
             <div style="min-width:0;flex:1;">
               <div style="font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(r.task.title)}</div>
               <div class="small muted" style="margin-top:3px;">${esc(r.task.subject||r.task.category)} · ${fmtDur(r.task.estimatedMinutes)}${r.task.deadline?' · due '+fmtDate(r.task.deadline).slice(0,12):''}</div>
             </div>
             <span class="pri ${r.level}" style="margin-left:10px;">${r.level}</span>
           </div>`).join('') : `<div class="empty">No open tasks</div>`}
       </div>
     </div>
   
     <div class="section-head"><div class="section-title">Today's Timeline</div>
       <button class="btn ghost sm" data-act="nav" data-id="today">Open Today →</button></div>
     <div class="card">${timelineHTML(sch.blocks.slice(0,14))}</div>
     `;
   }
   
   function timelineHTML(blocks){
     if(!blocks.length) return `<div class="empty">No blocks scheduled. Generate the day from the Today page.</div>`;
     const typeLabel={school:'SCHOOL',coaching:'COACHING',meal:'MEAL',routine:'ROUTINE',break:'BREAK',task:'TASK'};
     return `<div class="tl">${blocks.map(b=>{
       const st=blockStatus(b);
       const label=typeLabel[b.type]||'BLOCK';
       const t=b.taskId? DB.tasks.find(x=>x.id===b.taskId):null;
       const meta=[];
       if(b.type==='task'){
         if(b.level) meta.push(`<span class="pri ${b.level}">${b.level}</span>`);
         if(b.subject) meta.push(`<span>${esc(b.subject)}</span>`);
         meta.push(`<span>${fmtDur(b.end-b.start)}</span>`);
         if(t) meta.push(`<span class="muted">${esc(t.status)}</span>`);
         if(b.part) meta.push(`<span class="tag">PART</span>`);
         if(t && st!=='completed') meta.push(`<button class="btn sm" data-act="start-task" data-id="${b.taskId}">▶</button>`);
       } else meta.push(`<span class="tag info">${label}</span>`);
       return `<div class="tl-item st-${st}">
         <div class="tl-time">${m2t(b.start)}<span>${m2t(b.end)}</span></div>
         <div>
           <div class="tl-title">${esc(b.title||'—')}</div>
           <div class="tl-meta">${meta.join('')}</div>
         </div>
       </div>`;
     }).join('')}</div>`;
   }
   
   /* ---------- TODAY ---------- */
   function viewToday(){
     const sch=getSchedule();
     const st=todayStats();
     const lost=sch.lostMinutes||0;
     const done=sch.blocks.filter(b=>b.type==='task' && blockStatus(b)==='completed').length;
     const total=sch.blocks.filter(b=>b.type==='task').length;
   
     return `
     <div class="section-head">
       <div><div class="section-title">Today · ${fmtDate(todayStr())}</div>
         <div class="small muted mt8">${total} task blocks · ${fmtDur(st.plannedMin)} planned study</div></div>
       <div class="flex gap8 wrap">
         <button class="btn" data-act="regen">⟳ Regenerate</button>
         <button class="btn ghost" data-act="wasted">⏱ I lost time</button>
         <button class="btn ghost" data-act="nav" data-id="dashboard">← Dashboard</button>
       </div>
     </div>
   
     <div class="grid g4" style="margin-bottom:18px;">
       <div class="stat"><div class="lbl">Execution</div><div class="val">${st.execution}%</div><div class="bar"><i style="width:${st.execution}%"></i></div></div>
       <div class="stat"><div class="lbl">Blocks Done</div><div class="val" style="color:var(--good)">${done}/${total}</div><div class="sub">task blocks</div></div>
       <div class="stat"><div class="lbl">Study Planned</div><div class="val">${fmtDur(st.plannedMin)}</div><div class="sub">across the day</div></div>
       <div class="stat"><div class="lbl">Time Lost</div><div class="val" style="color:${lost?'var(--bad)':'var(--muted-2)'}">${fmtDur(lost)}</div><div class="sub">reported today</div></div>
     </div>
   
     <div class="card">
       <div class="card-title">Full Day Timeline</div>
       ${timelineHTML(sch.blocks)}
     </div>
     `;
   }
   
   /* ---------- TASKS ---------- */
   let TASK_FILTER='ALL';
   function viewTasks(){
     const ranked=rankedTasks();
     const lvlMap={}; ranked.forEach(r=>lvlMap[r.task.id]=r.level);
     let list=DB.tasks.slice();
     if(TASK_FILTER!=='ALL') list=list.filter(t=>t.category===TASK_FILTER);
     list.sort((a,b)=>taskScore(b)-taskScore(a));
   
     const cats=['ALL','ACADEMICS','FILES','SKILLS','HEALTH','PROJECT','PERSONAL','RECREATION','OTHER'];
   
     return `
     <div class="section-head">
       <div class="section-title">Task Management</div>
       <button class="btn primary" data-act="new-task">+ New Task</button>
     </div>
   
     <div class="flex gap8 wrap" style="margin-bottom:16px;">
       ${cats.map(c=>`<button class="btn ${TASK_FILTER===c?'primary':'ghost'} sm" data-act="filter" data-id="${c}">${c}</button>`).join('')}
     </div>
   
     <div class="grid g2">
       <div class="card">
         <div class="card-title">Open Tasks · ${list.filter(t=>!['COMPLETED','SKIPPED'].includes(t.status)).length}</div>
         ${list.filter(t=>!['COMPLETED','SKIPPED'].includes(t.status)).map(t=>taskHTML(t,lvlMap[t.id])).join('') || `<div class="empty">No open tasks in this category</div>`}
       </div>
       <div class="card">
         <div class="card-title">Completed / Closed</div>
         ${list.filter(t=>['COMPLETED','SKIPPED'].includes(t.status)).map(t=>taskHTML(t,'P4')).join('') || `<div class="empty">Nothing closed yet</div>`}
       </div>
     </div>
     `;
   }
   
   function taskHTML(t,level){
     const done=t.status==='COMPLETED';
     const subDone=(t.subtasks||[]).filter(s=>s.done).length;
     const subTotal=(t.subtasks||[]).length;
     const linked= t.chapterId ? findChapterRef(t.chapterId) : null;
   
     return `
     <div class="task ${done?'done':''}">
       <div class="chk" data-act="toggle-task" data-id="${t.id}">${done?'✓':''}</div>
       <div style="flex:1;min-width:0;">
         <div class="t-name">${esc(t.title)}</div>
         <div class="t-meta">
           <span class="pri ${level||'P4'}">${level||'P4'}</span>
           ${catTag(t.category)}
           ${t.subject?`<span>${esc(t.subject)}</span>`:''}
           <span>${fmtDur(t.estimatedMinutes)}</span>
           ${t.deadline?`<span>due ${fmtDate(t.deadline)}</span>`:''}
           ${subTotal?`<span>${subDone}/${subTotal} steps</span>`:''}
           ${linked?`<span class="tag violet">◎ ${esc(linked.chapter.name.slice(0,18))}</span>`:''}
           <span class="tag">${esc(t.status)}</span>
         </div>
         ${t.objective?`<div class="small muted" style="margin-top:7px;">◎ ${esc(t.objective)}</div>`:''}
         ${subTotal?`<div class="subs">${t.subtasks.map(s=>`
           <div class="sub ${s.done?'on':''}">
             <div class="sbox" data-act="toggle-sub" data-id="${t.id}" data-sub="${s.id}">${s.done?'✓':''}</div>
             <span>${esc(s.title)}${s.duration?` · ${s.duration}m`:''}</span>
           </div>`).join('')}</div>`:''}
         <div class="flex gap8 wrap" style="margin-top:11px;">
           <button class="btn sm" data-act="start-task" data-id="${t.id}">▶ Start</button>
           <button class="btn sm ghost" data-act="edit-task" data-id="${t.id}">Edit</button>
           <button class="btn sm ghost" data-act="add-sub" data-id="${t.id}">+ Step</button>
           <button class="btn sm danger" data-act="del-task" data-id="${t.id}">Delete</button>
         </div>
       </div>
     </div>`;
   }
   
   /* ---------- STUDY (WORKSPACE) ---------- */
   function viewStudy(){
     const subs=DB.subjects||[];
     const totals=subjectTotals();
     const grand=subs.reduce((a,s)=>a+s.chapters.reduce((x,c)=>x+(c.totalMinutes||0),0),0);
   
     return `
     <div class="section-head">
       <div>
         <div class="section-title">Study Workspace</div>
         <div class="small muted mt8">Independent subjects · time flows in from sessions AND scheduled tasks</div>
       </div>
       <div class="flex gap8 wrap">
         <button class="btn primary" data-act="new-subject">+ Add Subject</button>
         <button class="btn ghost" data-act="import-exam-chapters">⇣ Import from Exams</button>
       </div>
     </div>
   
     <div class="grid g3" style="margin-bottom:18px;">
       <div class="stat"><div class="lbl">Total Study Time</div><div class="val">${fmtDur(grand)}</div><div class="sub">across all chapters</div></div>
       <div class="stat"><div class="lbl">Subjects</div><div class="val">${subs.length}</div><div class="sub">tracked</div></div>
       <div class="stat"><div class="lbl">Chapters</div><div class="val">${subs.reduce((a,s)=>a+s.chapters.length,0)}</div><div class="sub">total</div></div>
     </div>
   
     ${subs.length? subs.map(s=>renderSubject(s)).join('') : `<div class="empty">No subjects yet. Add one to begin tracking.</div>`}
     `;
   }
   
   function renderSubject(s){
     const open=!!STUDY_OPEN[s.id];
     const total=s.chapters.reduce((a,c)=>a+(c.totalMinutes||0),0);
     const done=s.chapters.filter(c=>['TESTED','MASTERED'].includes(computeChapterStatus(c))).length;
     const last=s.chapters.reduce((a,c)=>c.lastStudied && (!a||c.lastStudied>a)?c.lastStudied:a,null);
     const lastLbl=last? (()=>{const d=daysBetween(last,todayStr()); return d===0?'today':d===1?'yesterday':d+'d ago';})() : 'never';
   
     return `
     <div class="subject ${open?'open':''}">
       <div class="subject-head" data-act="toggle-subject" data-id="${s.id}">
         <span class="subject-color" style="background:${s.color||'var(--gold)'};color:${s.color||'var(--gold)'}"></span>
         <div style="flex:1;min-width:0;">
           <div class="subject-name">${esc(s.name)}</div>
           <div class="subject-sub">${fmtDur(total)} · ${done}/${s.chapters.length} mastered · last ${lastLbl}</div>
         </div>
         <span class="subject-chev">▸</span>
       </div>
       ${open?`
         <div class="subject-body">
           ${s.chapters.length? s.chapters.map(c=>renderChapter(c)).join('') : `<div class="empty">No chapters yet</div>`}
           <div class="flex gap8 wrap" style="margin-top:12px;">
             <button class="btn sm" data-act="new-chapter" data-id="${s.id}">+ Add Chapter</button>
             <button class="btn sm ghost" data-act="edit-subject" data-id="${s.id}">Rename</button>
             <button class="btn sm danger" data-act="del-subject" data-id="${s.id}">Delete Subject</button>
           </div>
         </div>`:''}
     </div>`;
   }
   
   function renderChapter(c){
     const status=computeChapterStatus(c);
     const isManual=!!c.manualStatus;
     const last=c.lastStudied ? daysBetween(c.lastStudied,todayStr()) : null;
     const lastLbl = last===null?'never': last===0?'today': last===1?'yesterday': last+'d ago';
     const sessCount=(c.sessions||[]).length;
   
     return `
     <div class="chapter-row">
       <div style="min-width:0;">
         <div class="chapter-name">${esc(c.name)}</div>
         <div class="chapter-meta">
           <span class="tag gold">${status.replace('_',' ')}${isManual?' · PINNED':''}</span>
           <span>${fmtDur(c.totalMinutes||0)}</span>
           <span>last: ${lastLbl}</span>
           <span>${sessCount} session${sessCount===1?'':'s'}</span>
         </div>
         <div class="bar" style="margin-top:8px;max-width:280px;">
           <i style="width:${statusPct(status)}%"></i>
         </div>
       </div>
       <div class="chapter-actions">
         <button class="btn sm primary" data-act="chapter-start" data-id="${c.id}">▶ Start</button>
         <button class="btn sm" data-act="chapter-log" data-id="${c.id}">✎ Log</button>
         <select class="tag-select" data-act="chapter-manual" data-id="${c.id}">
           <option value="">Auto</option>
           ${CHAPTER_STATUSES.map(x=>`<option value="${x}" ${c.manualStatus===x?'selected':''}>${x.replace('_',' ')}</option>`).join('')}
         </select>
         <button class="btn sm ghost" data-act="chapter-history" data-id="${c.id}">☰</button>
         <button class="btn sm danger" data-act="del-chapter" data-id="${c.id}">×</button>
       </div>
     </div>`;
   }
   
   /* ---------- EXAMS ---------- */
   function viewExams(){
     const exams=DB.exams.slice().sort((a,b)=>parseD(a.date)-parseD(b.date));
     return `
     <div class="section-head">
       <div class="section-title">Exam Command</div>
       <button class="btn primary" data-act="new-exam">+ Add Exam</button>
     </div>
     <div class="grid g2">
       ${exams.map(e=>{
         const d=daysBetween(todayStr(),e.date);
         const total=e.chapters.length;
         const mastered=e.chapters.filter(c=>['TESTED','MASTERED','REVISION'].includes(c.status)).length;
         const pct=total? Math.round(mastered/total*100):0;
         return `
         <div class="card">
           <div class="flex between center wrap gap8">
             <div>
               <div style="font-size:16px;font-weight:800;color:var(--gold-2);letter-spacing:.04em;">${esc(e.subject.toUpperCase())}</div>
               <div class="small muted mt8">${esc(e.title)}</div>
             </div>
             <div style="text-align:right;">
               <div class="mono" style="font-size:26px;font-weight:700;color:${d<=3?'var(--bad)':d<=10?'var(--warn)':'var(--gold-2)'}">${d<0?'—':d}</div>
               <div class="small muted">days left</div>
             </div>
           </div>
           <div class="t-meta mt8">
             <span class="tag gold">${fmtDate(e.date)}</span>
             <span class="tag">${e.start}–${e.end}</span>
             <span class="tag ${e.importance==='HIGH'?'bad':'warn'}">${e.importance}</span>
           </div>
           <div class="bar"><i style="width:${pct}%"></i></div>
           <div class="small muted mt8">${mastered}/${total} chapters at revision level or beyond · ${pct}%</div>
           <div class="hr"></div>
           <div style="max-height:230px;overflow-y:auto;">
             ${e.chapters.map(c=>`
               <div class="chap">
                 <div style="flex:1;font-size:11.5px;color:var(--text);">${esc(c.name)}</div>
                 <select data-act="chap-status" data-id="${e.id}" data-chap="${c.id}">
                   ${CHAPTER_STATUSES.map(s=>`<option value="${s}" ${c.status===s?'selected':''}>${s.replace('_',' ')}</option>`).join('')}
                 </select>
               </div>`).join('')}
           </div>
           <div class="flex gap8 wrap mt16">
             <button class="btn sm" data-act="gen-study" data-id="${e.id}">⚙ Generate Study Tasks</button>
             <button class="btn sm danger" data-act="del-exam" data-id="${e.id}">Delete</button>
           </div>
         </div>`;
       }).join('')}
     </div>`;
   }
   
   /* ---------- CALENDAR ---------- */
   let CAL_MONTH=new Date().getMonth(), CAL_YEAR=new Date().getFullYear();
   function viewCalendar(){
     const first=new Date(CAL_YEAR,CAL_MONTH,1);
     const startDay=first.getDay();
     const daysInMonth=new Date(CAL_YEAR,CAL_MONTH+1,0).getDate();
     const cells=[];
     for(let i=0;i<startDay;i++) cells.push(null);
     for(let d=1;d<=daysInMonth;d++) cells.push(d);
     while(cells.length%7!==0) cells.push(null);
   
     const eventsFor=(ds)=>{
       const ev=[];
       DB.exams.forEach(e=>{ if(e.date===ds) ev.push({t:'EXAM '+e.subject,c:'bad'}); });
       DB.tasks.forEach(t=>{ if(t.deadline===ds && !['COMPLETED','SKIPPED'].includes(t.status)) ev.push({t:t.title,c:'gold'}); });
       DB.files.forEach(f=>{ if(f.deadline===ds) ev.push({t:f.subject+' '+f.type,c:'info'}); });
       return ev;
     };
   
     const monthName=first.toLocaleDateString('en-GB',{month:'long',year:'numeric'}).toUpperCase();
   
     return `
     <div class="section-head">
       <div class="section-title">Calendar</div>
       <div class="flex gap8 center">
         <button class="btn ghost sm" data-act="cal-prev">←</button>
         <div class="mono" style="color:var(--gold-2);font-weight:700;letter-spacing:.1em;min-width:180px;text-align:center;">${monthName}</div>
         <button class="btn ghost sm" data-act="cal-next">→</button>
         <button class="btn ghost sm" data-act="cal-today">Today</button>
       </div>
     </div>
     <div class="card">
       <div class="small muted" style="margin-bottom:12px;">Click any date to view details and quickly add tasks, exams or deadlines.</div>
       <div class="cal">
         ${['SUN','MON','TUE','WED','THU','FRI','SAT'].map(d=>`<div class="cal-h">${d}</div>`).join('')}
         ${cells.map(d=>{
           if(!d) return `<div class="cal-d out"></div>`;
           const ds=`${CAL_YEAR}-${pad(CAL_MONTH+1)}-${pad(d)}`;
           const isToday=ds===todayStr();
           const ev=eventsFor(ds);
           return `<div class="cal-d ${isToday?'today':''}" data-act="cal-day" data-id="${ds}">
             <div class="dn">${d}</div>
             ${ev.slice(0,3).map(e=>`<div class="cal-ev tag ${e.c}" style="display:block;margin-top:3px;font-size:8px;">${esc(e.t.slice(0,18))}</div>`).join('')}
           </div>`;
         }).join('')}
       </div>
     </div>`;
   }
   
   /* ---------- PROJECTS ---------- */
   function viewProjects(){
     return `
     <div class="section-head">
       <div class="section-title">Personal Projects</div>
       <button class="btn primary" data-act="new-project">+ New Project</button>
     </div>
     <div class="grid g2">
       ${DB.projects.map(p=>`
         <div class="card">
           <div style="font-size:16px;font-weight:800;color:var(--gold-2);">${esc(p.title)}</div>
           <div class="small muted mt8">${esc(p.description||'')}</div>
           <div class="hr"></div>
           ${p.milestones.map(m=>`
             <div style="margin-bottom:14px;">
               <div class="flex between center">
                 <div class="small" style="color:var(--gold-2);font-weight:700;letter-spacing:.1em;">◆ ${esc(m.title)}</div>
               </div>
               <div class="subs" style="margin-top:8px;">
                 ${m.tasks.map(t=>`
                   <div class="sub ${t.done?'on':''}">
                     <div class="sbox" data-act="toggle-project-task" data-id="${p.id}" data-ms="${m.id}" data-task="${t.id}">${t.done?'✓':''}</div>
                     <span>${esc(t.title)}${t.duration?` · ${t.duration}m`:''}</span>
                   </div>
                 `).join('')}
               </div>
             </div>
           `).join('')}
           <button class="btn sm danger" data-act="del-project" data-id="${p.id}">Delete Project</button>
         </div>
       `).join('') || `<div class="empty">No projects yet</div>`}
     </div>`;
   }
   
   /* ---------- FILES ---------- */
   function viewFiles(){
     return `
     <div class="section-head">
       <div class="section-title">Files & Classwork</div>
       <button class="btn primary" data-act="new-file">+ Add File Work</button>
     </div>
     <div class="grid g2">
       ${DB.files.map(f=>{
         const d=daysBetween(todayStr(),f.deadline);
         return `
         <div class="card">
           <div class="flex between center wrap gap8">
             <div>
               <div style="font-size:14px;font-weight:700;color:var(--gold-2);">${esc(f.subject)} — ${esc(f.type)}</div>
               <div class="small muted mt8">${esc(f.remaining)} remaining</div>
             </div>
             <span class="tag ${d<=2?'bad':'warn'}">${d} days</span>
           </div>
           <div class="t-meta mt8">
             <span class="tag gold">DUE ${fmtDate(f.deadline)}</span>
             <span class="tag">Est ${fmtDur(f.estimatedMinutes)}</span>
             <span class="pri P${f.priority}">P${f.priority}</span>
             <span class="tag">${esc(f.status)}</span>
           </div>
           <div class="hr"></div>
           <div class="small muted" style="margin-bottom:8px;">Suggested sessions:</div>
           ${f.sessions.map(s=>`<div class="sub" style="padding:5px 0;">◦ ${esc(s)}</div>`).join('')}
           <div class="flex gap8 wrap mt16">
             <button class="btn sm" data-act="file-session" data-id="${f.id}">▶ Schedule Session</button>
             <button class="btn sm danger" data-act="del-file" data-id="${f.id}">Delete</button>
           </div>
         </div>`;
       }).join('') || `<div class="empty">No files tracked</div>`}
     </div>`;
   }
   
   /* ---------- HABITS ---------- */
   function viewHabits(){
     const examMode=examModeActive();
     return `
     <div class="section-head">
       <div class="section-title">Habits & Development</div>
       <button class="btn primary" data-act="new-habit">+ New Habit</button>
     </div>
     ${examMode?`<div class="card mb8" style="border-color:rgba(224,122,106,.4);">
       <div class="tag bad" style="margin-bottom:8px;">⚡ EXAM MODE ACTIVE</div>
       <div class="small muted">Optional habits are reduced. Exercise and English are preserved at minimum.</div>
     </div>`:''}
     <div class="grid g3">
       ${DB.habits.map(h=>`
         <div class="card">
           <div style="font-size:14px;font-weight:700;color:var(--gold-2);">${esc(h.title)}</div>
           <div class="t-meta mt8">
             <span class="tag">${h.minutes} MIN</span>
             <span class="tag info">${h.days.length} DAYS/WK</span>
             ${h.examSafe?'<span class="tag good">EXAM-SAFE</span>':'<span class="tag warn">OPTIONAL</span>'}
           </div>
           <div class="mini-bar"><i style="width:${Math.min(100,(h.streak||0)*10)}%"></i></div>
           <div class="small muted mt8">Streak: ${h.streak||0} days</div>
           <div class="flex gap8 wrap mt16">
             <button class="btn sm" data-act="habit-log" data-id="${h.id}">✓ Log Today</button>
             <button class="btn sm danger" data-act="del-habit" data-id="${h.id}">Delete</button>
           </div>
         </div>
       `).join('') || `<div class="empty">No habits tracked</div>`}
     </div>`;
   }
   
   /* ---------- ANALYTICS ---------- */
   function viewAnalytics(){
     const last7=[];
     for(let i=6;i>=0;i--){
       const d=new Date(); d.setDate(d.getDate()-i);
       const ds=dstr(d);
       const fs=DB.focusSessions.filter(f=>f.date===ds);
       const min=fs.reduce((a,f)=>a+f.minutes,0);
       last7.push({date:ds,label:d.toLocaleDateString('en-GB',{weekday:'short'}),minutes:min});
     }
     const maxMin=Math.max(...last7.map(x=>x.minutes),60);
     const totalMin=last7.reduce((a,x)=>a+x.minutes,0);
   
     const subjectMap={};
     DB.focusSessions.forEach(f=>{ subjectMap[f.subject]=(subjectMap[f.subject]||0)+f.minutes; });
     const subjects=Object.entries(subjectMap).sort((a,b)=>b[1]-a[1]);
   
     const completionRate=(()=>{
       const total=DB.tasks.length;
       const done=DB.tasks.filter(t=>t.status==='COMPLETED').length;
       return total? Math.round(done/total*100):0;
     })();
   
     const ws=subjectTotals();
   
     return `
     <div class="section-head"><div class="section-title">Analytics</div>
       <button class="btn ghost" data-act="export">⤓ Export JSON</button></div>
   
     <div class="grid g4" style="margin-bottom:16px;">
       <div class="stat"><div class="lbl">7-Day Focus</div><div class="val">${fmtDur(totalMin)}</div><div class="sub">logged sessions</div></div>
       <div class="stat"><div class="lbl">Completion Rate</div><div class="val">${completionRate}%</div><div class="sub">of all tasks</div></div>
       <div class="stat"><div class="lbl">Total Sessions</div><div class="val">${DB.focusSessions.length}</div><div class="sub">all-time</div></div>
       <div class="stat"><div class="lbl">Open Tasks</div><div class="val">${openTasks().length}</div><div class="sub">currently active</div></div>
     </div>
   
     <div class="grid g2">
       <div class="card">
         <div class="card-title">Daily Study Time</div>
         <div class="flex" style="align-items:flex-end;gap:10px;height:160px;padding:10px 0;">
           ${last7.map(d=>`
             <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;">
               <div class="mono small" style="color:var(--gold-2);font-size:10px;">${d.minutes||''}</div>
               <div style="width:100%;height:${Math.max(4,(d.minutes/maxMin)*120)}px;border-radius:6px 6px 0 0;background:linear-gradient(180deg,var(--gold-2),var(--gold-3));box-shadow:0 0 16px -4px var(--gold-glow);transition:.4s;"></div>
               <div class="small muted">${d.label}</div>
             </div>
           `).join('')}
         </div>
       </div>
   
       <div class="card">
         <div class="card-title">Subject-wise Focus</div>
         ${subjects.length? subjects.slice(0,8).map(([s,m])=>{
           const pct=Math.round(m/Math.max(1,subjects[0][1])*100);
           return `<div style="margin-bottom:11px;">
             <div class="flex between"><span style="font-size:12px;">${esc(s)}</span><span class="mono small" style="color:var(--gold-2);">${fmtDur(m)}</span></div>
             <div class="bar"><i style="width:${pct}%"></i></div>
           </div>`;
         }).join('') : `<div class="empty">No sessions logged yet</div>`}
       </div>
     </div>
   
     <div class="section-head"><div class="section-title">Study Ledger</div></div>
     <div class="card">
       ${ws.length? ws.map(w=>`
         <div style="margin-bottom:14px;">
           <div class="flex between center">
             <div><span class="color-dot" style="background:${w.subject.color}"></span><b style="font-size:12.5px;letter-spacing:.1em;">${esc(w.subject.name.toUpperCase())}</b></div>
             <span class="mono small" style="color:var(--gold-2);">${fmtDur(w.total)}</span>
           </div>
           <div class="small muted" style="margin-top:4px;">${w.advanced}/${w.chapterCount} chapters at PRACTICE or beyond</div>
           <div class="bar"><i style="width:${w.chapterCount?Math.round(w.advanced/w.chapterCount*100):0}%"></i></div>
         </div>
       `).join('') : `<div class="empty">Add subjects in the Study page to see the ledger.</div>`}
     </div>
     `;
   }
   
   /* ---------- SETTINGS ---------- */
   function viewSettings(){
     const s=DB.settings;
     return `
     <div class="section-head"><div class="section-title">Settings</div>
       <button class="btn primary" data-act="save-settings">Save Settings</button></div>
   
     <div class="card" style="margin-bottom:16px;">
       <div class="card-title">Data File (Auto-Save)</div>
       <div class="sync-block">
         <div class="sync-status">
           <span class="sync-indicator ${FileSync.connected?'on':(FileSync.handle?'warn':'')}"></span>
           <div class="sync-meta">
             ${FileSync.connected
               ? `<b>AUTO-SAVE ON</b> · every change is written to your data file<br>Last sync: ${FileSync.lastSave?FileSync.lastSave.toLocaleTimeString():'—'}`
               : FileSync.handle
                 ? `<b>PERMISSION NEEDED</b> · browser needs a click to re-authorise the file`
                 : (FileSync.supported
                     ? `<b>LOCAL ONLY</b> · everything is saved in this browser<br>Connect a JSON file to keep records on disk automatically.`
                     : `<b>BROWSER UNSUPPORTED</b> · this browser cannot write files directly — use Export JSON.`)}
           </div>
         </div>
         <div class="flex gap8 wrap">
           ${FileSync.connected
             ? `<button class="btn" data-act="fs-save">💾 Save Now</button>
                <button class="btn ghost" data-act="fs-disconnect">Disconnect</button>`
             : FileSync.handle
               ? `<button class="btn primary" data-act="fs-reconnect">Reconnect File</button>
                  <button class="btn ghost" data-act="fs-disconnect">Forget</button>`
               : `<button class="btn primary" data-act="fs-connect">🔗 Connect Data File</button>`}
         </div>
       </div>
       <div class="small muted mt16">When connected, your data lives in a real JSON file you own. Every save writes to it automatically (debounced ~0.7s). Nothing leaves your machine.</div>
     </div>
   
     <div class="grid g2">
       <div class="card">
         <div class="card-title">Schedule & Rhythm</div>
         <div class="row">
           <div class="field"><label>Display Name</label><input id="set-user" value="${esc(s.user)}" /></div>
           <div class="field"><label>Exam Mode Threshold (days)</label><input id="set-examth" type="number" value="${s.examModeThreshold}" /></div>
         </div>
         <div class="row">
           <div class="field"><label>Wake Time</label><input id="set-wake" type="time" value="${s.wake}" /></div>
           <div class="field"><label>Sleep Time</label><input id="set-sleep" type="time" value="${s.sleep}" /></div>
         </div>
         <div class="row">
           <div class="field"><label>Buffer / Transition (min)</label><input id="set-buffer" type="number" value="${s.bufferMinutes}" /></div>
           <div class="field"><label>Max Study / Day (min)</label><input id="set-maxstudy" type="number" value="${s.maxStudyMinutesPerDay}" /></div>
         </div>
       </div>
   
       <div class="card">
         <div class="card-title">Focus & Development</div>
         <div class="row">
           <div class="field"><label>Focus Duration (min)</label><input id="set-focus" type="number" value="${s.focusDuration}" /></div>
           <div class="field"><label>Break Duration (min)</label><input id="set-break" type="number" value="${s.breakDuration}" /></div>
         </div>
         <div class="row">
           <div class="field"><label>Exercise Target (min)</label><input id="set-exercise" type="number" value="${s.exerciseTarget}" /></div>
           <div class="field"><label>English Practice (min)</label><input id="set-english" type="number" value="${s.englishTarget}" /></div>
         </div>
         <div class="row">
           <div class="field"><label>Project Time (min)</label><input id="set-project" type="number" value="${s.projectTime}" /></div>
           <div class="field"><label>Recreation Allowance (min)</label><input id="set-recreation" type="number" value="${s.recreationAllowance}" /></div>
         </div>
         <div class="field"><label>Known Distractions</label><input id="set-distractions" value="${esc(s.distractions)}" /></div>
       </div>
     </div>
   
     <div class="section-head"><div class="section-title">Fixed Commitments</div>
       <button class="btn" data-act="new-commitment">+ Add Commitment</button></div>
     <div class="card">
       <div class="small muted" style="margin-bottom:10px;">The scheduler will never place a study block over these.</div>
       ${DB.commitments.map(c=>`
         <div class="chap">
           <div style="flex:1;font-size:12px;font-weight:600;">${esc(c.title)}</div>
           <span class="tag info">${esc(c.type)}</span>
           <span class="tag gold">${c.start}–${c.end}</span>
           <span class="tag">${c.days.map(d=>['S','M','T','W','T','F','S'][d]).join('')}</span>
           <button class="btn sm danger" data-act="del-commitment" data-id="${c.id}">×</button>
         </div>
       `).join('')}
     </div>
   
     <div class="section-head"><div class="section-title">Data & Backup</div></div>
     <div class="card">
       <div class="flex gap8 wrap">
         <button class="btn" data-act="export">⤓ Export JSON</button>
         <button class="btn" data-act="export-csv">⤓ Export Tasks CSV</button>
         <button class="btn danger" data-act="reset">⚠ Reset All Data</button>
       </div>
       <div class="small muted mt8">A data file (above) is the safest long-term storage. Exports remain useful for backups or for moving to another machine.</div>
     </div>
     `;
   }
   
   /* ------------------------------------------------------------
      13. RENDER (with scroll restore)
      ------------------------------------------------------------ */
   function render(opts){
     opts=opts||{};
     const view=$('#view'); if(!view) return;
     const prevScroll=view.scrollTop;
   
     renderNav();
     renderExamPill();
   
     const map={
       dashboard:viewDashboard, today:viewToday, tasks:viewTasks,
       exams:viewExams, study:viewStudy, calendar:viewCalendar,
       projects:viewProjects, files:viewFiles, habits:viewHabits,
       analytics:viewAnalytics, settings:viewSettings
     };
     view.dataset.view=VIEW;
     view.innerHTML=(map[VIEW]||viewDashboard)();
     view.scrollTop = opts.resetScroll ? 0 : prevScroll;
   }
   
   /* ------------------------------------------------------------
      14. MODALS
      ------------------------------------------------------------ */
   function openModal(html){ $('#modal').innerHTML=html; $('#overlay').classList.add('show'); }
   function closeModal(){ $('#overlay').classList.remove('show'); }
   
   function modalTaskForm(task, prefilledDate){
     const t=task||{title:'',category:'ACADEMICS',subject:'',priority:2,estimatedMinutes:40,
       deadline:prefilledDate||todayStr(),objective:'',notes:'',subtasks:[],chapterId:null};
   
     const chapterOptions = (DB.subjects||[]).map(s=>`
       <optgroup label="${esc(s.name)}">
         ${s.chapters.map(c=>`<option value="${c.id}" ${t.chapterId===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}
       </optgroup>
     `).join('');
   
     openModal(`
       <h3>${task?'Edit Task':'New Task'}
         <button class="btn ghost sm" data-act="close-modal">✕</button>
       </h3>
       <div class="field"><label>Title</label><input id="m-title" value="${esc(t.title)}" placeholder="Physics — Electric Potential practice" /></div>
       <div class="field"><label>Objective (clear definition of DONE)</label><textarea id="m-objective" placeholder="Understand potential due to point charge and solve 5 problems.">${esc(t.objective||'')}</textarea></div>
       <div class="row">
         <div class="field"><label>Category</label>
           <select id="m-category">
             ${['ACADEMICS','FILES','SKILLS','HEALTH','PROJECT','PERSONAL','RECREATION','OTHER'].map(c=>`<option ${t.category===c?'selected':''}>${c}</option>`).join('')}
           </select>
         </div>
         <div class="field"><label>Subject</label><input id="m-subject" value="${esc(t.subject)}" placeholder="Physics" /></div>
       </div>
       <div class="row">
         <div class="field"><label>Priority</label>
           <select id="m-priority">
             ${[1,2,3,4].map(p=>`<option value="${p}" ${t.priority===p?'selected':''}>P${p}</option>`).join('')}
           </select>
         </div>
         <div class="field"><label>Estimated Minutes</label><input id="m-est" type="number" value="${t.estimatedMinutes}" /></div>
       </div>
       <div class="field"><label>Deadline</label><input id="m-deadline" type="date" value="${t.deadline}" /></div>
       <div class="field">
         <label>Linked Study Chapter (optional)</label>
         <select id="m-chapter">
           <option value="">— none —</option>
           ${chapterOptions}
         </select>
         <div class="small muted mt8">If linked, focus time from this task auto-lands in that chapter's total.</div>
       </div>
       <div class="field"><label>Notes</label><textarea id="m-notes">${esc(t.notes||'')}</textarea></div>
       <div class="modal-foot">
         <button class="btn ghost" data-act="close-modal">Cancel</button>
         <button class="btn primary" data-act="save-task" data-id="${task?task.id:''}">${task?'Save Changes':'Create Task'}</button>
       </div>
     `);
   }
   
   function modalWhatNow(){
     const ranked=rankedTasks();
     if(!ranked.length){ openModal(`<h3>What Should I Do Now? <button class="btn ghost sm" data-act="close-modal">✕</button></h3><div class="empty">No open tasks. Enjoy a real break.</div>`); return; }
     const r=ranked[0];
     const t=r.task;
     const nx=nearestExam(t.subject);
     const reason = nx? `${nx.subject} exam in ${daysBetween(todayStr(),nx.date)} days.` : `Highest-priority open item.`;
     const linked = t.chapterId? findChapterRef(t.chapterId) : null;
     openModal(`
       <h3>Do This Now <button class="btn ghost sm" data-act="close-modal">✕</button></h3>
       <div style="font-size:19px;font-weight:800;color:var(--gold-2);line-height:1.35;">${esc(t.title)}</div>
       <div class="t-meta mt8">
         <span class="pri ${r.level}">${r.level}</span>
         ${catTag(t.category)}
         <span>${esc(t.subject||'')}</span>
         <span>Duration: ${fmtDur(t.estimatedMinutes)}</span>
         ${linked?`<span class="tag violet">◎ ${esc(linked.chapter.name)}</span>`:''}
       </div>
       <div class="hr"></div>
       <div class="small muted" style="margin-bottom:6px;">OBJECTIVE</div>
       <div style="font-size:13px;color:var(--text);line-height:1.7;">${esc(t.objective||'Complete this task with focus.')}</div>
       <div class="hr"></div>
       <div class="small muted" style="margin-bottom:6px;">WHY</div>
       <div style="font-size:12px;color:var(--warn);">${esc(reason)}</div>
       <div class="modal-foot">
         <button class="btn ghost" data-act="close-modal">Later</button>
         <button class="btn primary" data-act="start-task-now" data-id="${t.id}">▶ Start This Task</button>
       </div>
     `);
   }
   
   function modalWasted(){
     openModal(`
       <h3>I Lost Time <button class="btn ghost sm" data-act="close-modal">✕</button></h3>
       <div class="small muted" style="margin-bottom:12px;">Not a failure — the day just got recalculated. How many minutes were lost?</div>
       <div class="flex gap8 wrap" style="margin-bottom:14px;">
         ${[30,60,90,120].map(m=>`<button class="btn sm" data-act="wasted-amt" data-id="${m}">${m} MIN</button>`).join('')}
       </div>
       <div class="field"><label>Custom (minutes)</label><input id="m-wasted" type="number" value="60" /></div>
       <div class="modal-foot">
         <button class="btn ghost" data-act="close-modal">Cancel</button>
         <button class="btn primary" data-act="apply-wasted">⟳ Recalculate Remaining Day</button>
       </div>
     `);
   }
   
   function modalNewExam(prefilledDate){
     openModal(`
       <h3>New Exam <button class="btn ghost sm" data-act="close-modal">✕</button></h3>
       <div class="row">
         <div class="field"><label>Subject</label><input id="ex-subject" placeholder="Physics" /></div>
         <div class="field"><label>Importance</label><select id="ex-imp"><option>HIGH</option><option>MEDIUM</option><option>LOW</option></select></div>
       </div>
       <div class="field"><label>Title</label><input id="ex-title" placeholder="Physics — Board Exam" /></div>
       <div class="row">
         <div class="field"><label>Date</label><input id="ex-date" type="date" value="${prefilledDate||todayStr()}" /></div>
         <div class="field"><label>Start Time</label><input id="ex-start" type="time" value="09:00" /></div>
       </div>
       <div class="field"><label>End Time</label><input id="ex-end" type="time" value="12:00" /></div>
       <div class="field"><label>Chapters (one per line)</label><textarea id="ex-chapters" placeholder="Electric Charges and Fields&#10;Electric Potential"></textarea></div>
       <div class="modal-foot">
         <button class="btn ghost" data-act="close-modal">Cancel</button>
         <button class="btn primary" data-act="save-exam">Create Exam</button>
       </div>
     `);
   }
   
   function modalChapterLog(chapterId){
     const ref=findChapterRef(chapterId); if(!ref) return;
     openModal(`
       <h3>Log Study Time <button class="btn ghost sm" data-act="close-modal">✕</button></h3>
       <div style="font-size:12px;color:var(--gold-2);font-weight:700;letter-spacing:.08em;">${esc(ref.subject.name)} — ${esc(ref.chapter.name)}</div>
       <div class="small muted mt8" style="margin-bottom:16px;">Current total: ${fmtDur(ref.chapter.totalMinutes||0)}</div>
       <div class="quick-log-btns" style="margin-bottom:14px;">
         ${[10,15,25,40,60,90].map(m=>`<button class="btn sm" data-act="ql-amt" data-id="${m}">${m}m</button>`).join('')}
       </div>
       <div class="field"><label>Custom (minutes)</label><input id="ql-min" type="number" value="30" /></div>
       <div class="field"><label>Note (optional)</label><input id="ql-note" placeholder="What did you cover?" /></div>
       <div class="modal-foot">
         <button class="btn ghost" data-act="close-modal">Cancel</button>
         <button class="btn primary" data-act="ql-save" data-id="${chapterId}">Log Session</button>
       </div>
     `);
   }
   
   function modalChapterHistory(chapterId){
     const ref=findChapterRef(chapterId); if(!ref) return;
     const s=[...(ref.chapter.sessions||[])].reverse();
     openModal(`
       <h3>Session History <button class="btn ghost sm" data-act="close-modal">✕</button></h3>
       <div style="font-size:12px;color:var(--gold-2);font-weight:700;letter-spacing:.08em;">${esc(ref.subject.name)} — ${esc(ref.chapter.name)}</div>
       <div class="small muted mt8" style="margin-bottom:16px;">${s.length} session(s) · total ${fmtDur(ref.chapter.totalMinutes||0)}</div>
       <div class="chapter-session-list">
         ${s.length? s.map(x=>`
           <div class="sess">
             <span class="mono" style="color:var(--gold-2);min-width:70px;">${new Date(x.start).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}</span>
             <span class="mono" style="min-width:50px;">${new Date(x.start).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</span>
             <span class="mono" style="color:var(--good);min-width:50px;">${x.minutes}m</span>
             <span style="flex:1;">${esc(x.note||'')}</span>
           </div>
         `).join('') : `<div class="empty">No sessions yet</div>`}
       </div>
       <div class="modal-foot">
         <button class="btn ghost" data-act="close-modal">Close</button>
         <button class="btn primary" data-act="chapter-start" data-id="${chapterId}">▶ Start New Session</button>
       </div>
     `);
   }
   
   /* ------------------------------------------------------------
      15. DRAWER (Calendar day detail)
      ------------------------------------------------------------ */
   let DRAWER_DATE=null;
   
   function openDrawer(dateStr){
     DRAWER_DATE=dateStr;
     renderDrawer();
     $('#drawer').classList.add('show');
     $('#drawerBackdrop').classList.add('show');
   }
   function closeDrawer(){
     $('#drawer').classList.remove('show');
     $('#drawerBackdrop').classList.remove('show');
     DRAWER_DATE=null;
   }
   function renderDrawer(){
     if(!DRAWER_DATE) return;
     const ds=DRAWER_DATE;
     const d=parseD(ds);
     $('#drawerDateLbl').textContent=d.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
     const isToday=ds===todayStr();
     $('#drawerTitle').textContent = isToday? 'Today' : (ds<todayStr()? 'Past Day' : 'Upcoming');
   
     const wd=d.getDay();
     const commits=DB.commitments.filter(c=>c.days.includes(wd));
     const tasks=DB.tasks.filter(t=>t.deadline===ds);
     const exams=DB.exams.filter(e=>e.date===ds);
     const files=DB.files.filter(f=>f.deadline===ds);
   
     $('#drawerBody').innerHTML=`
       <div class="flex gap8 wrap">
         <button class="btn primary sm" data-act="drawer-add-task">+ Task</button>
         <button class="btn sm" data-act="drawer-add-exam">+ Exam</button>
         <button class="btn sm ghost" data-act="drawer-open-day">Open Day Plan →</button>
       </div>
   
       ${commits.length?`
         <div class="drawer-sec">Fixed Commitments</div>
         ${commits.map(c=>`<div class="drawer-row">
           <span class="tag info">${esc(c.type)}</span>
           <span class="mono small" style="color:var(--gold-2);">${c.start}–${c.end}</span>
           <span class="flex-1">${esc(c.title)}</span>
         </div>`).join('')}`:''}
   
       ${exams.length?`
         <div class="drawer-sec">Exams</div>
         ${exams.map(e=>`<div class="drawer-row">
           <span class="tag bad">${esc(e.subject.toUpperCase())}</span>
           <span class="mono small">${e.start}</span>
           <span class="flex-1">${esc(e.title)}</span>
         </div>`).join('')}`:''}
   
       ${tasks.length?`
         <div class="drawer-sec">Tasks (${tasks.length})</div>
         ${tasks.map(t=>`<div class="drawer-row">
           <span class="pri ${levelOfTask(t.id)}">${levelOfTask(t.id)}</span>
           <span class="flex-1">${esc(t.title)}</span>
           <span class="small muted">${fmtDur(t.estimatedMinutes)}</span>
         </div>`).join('')}`:''}
   
       ${files.length?`
         <div class="drawer-sec">Files</div>
         ${files.map(f=>`<div class="drawer-row">
           <span class="tag info">${esc(f.subject)}</span>
           <span class="flex-1">${esc(f.type)}</span>
           <span class="small muted">${esc(f.remaining)}</span>
         </div>`).join('')}`:''}
   
       ${!commits.length && !exams.length && !tasks.length && !files.length ? `<div class="empty">Nothing scheduled. Clear day.</div>`:''}
     `;
   }
   
   /* ------------------------------------------------------------
      16. EVENT DELEGATION
      ------------------------------------------------------------ */
   document.addEventListener('click', e=>{
     const el=e.target.closest('[data-act]');
     if(!el) return;
     const act=el.dataset.act;
     const id=el.dataset.id;
   
     /* --- navigation --- */
     if(act==='nav'){ VIEW=id; render({resetScroll:true}); $('.sidebar').classList.remove('open'); return; }
     if(act==='close-modal'){ closeModal(); return; }
     if(act==='close-drawer'){ closeDrawer(); return; }
     if(act==='filter'){ TASK_FILTER=id; render(); return; }
   
     /* --- study workspace --- */
     if(act==='toggle-subject'){
       STUDY_OPEN[id]=!STUDY_OPEN[id];
       render();
       return;
     }
     if(act==='new-subject'){
       const name=prompt('Subject name:'); if(!name) return;
       const color=SUBJECT_COLORS[DB.subjects.length%SUBJECT_COLORS.length];
       DB.subjects.push({id:uid(),name,color,createdAt:todayStr(),chapters:[]});
       saveDB(); toast('Subject added'); render(); return;
     }
     if(act==='edit-subject'){
       const s=DB.subjects.find(x=>x.id===id); if(!s) return;
       const name=prompt('Rename subject:',s.name); if(!name) return;
       s.name=name.trim(); saveDB(); render(); return;
     }
     if(act==='del-subject'){
       const s=DB.subjects.find(x=>x.id===id); if(!s) return;
       if(!confirm('Delete subject "'+s.name+'" and all its chapters/sessions?')) return;
       DB.subjects=DB.subjects.filter(x=>x.id!==id); saveDB(); render(); return;
     }
     if(act==='new-chapter'){
       const s=DB.subjects.find(x=>x.id===id); if(!s) return;
       const name=prompt('Chapter name:'); if(!name) return;
       s.chapters.push(mkChapter(name.trim()));
       saveDB(); toast('Chapter added'); render(); return;
     }
     if(act==='del-chapter'){
       for(const s of DB.subjects){
         if(s.chapters.some(c=>c.id===id)){
           if(!confirm('Delete this chapter and its session history?')) return;
           s.chapters=s.chapters.filter(c=>c.id!==id);
           saveDB(); render(); return;
         }
       }
       return;
     }
     if(act==='chapter-start'){
       closeModal();
       Timer.setChapter(id, DB.settings.focusDuration||40);
       $('#exec').classList.add('show');
       Timer.start();
       return;
     }
     if(act==='chapter-log'){ modalChapterLog(id); return; }
     if(act==='chapter-history'){ modalChapterHistory(id); return; }
     if(act==='ql-amt'){ $('#ql-min').value=id; return; }
     if(act==='ql-save'){
       const mins=Number($('#ql-min').value)||0;
       if(mins<=0){ toast('Enter a positive minute value'); return; }
       const note=$('#ql-note').value.trim();
       if(logChapterSession(id, mins, {note})){
         // also mirror as a focusSession for analytics
         const ref=findChapterRef(id);
         DB.focusSessions.push({
           id:uid(), taskId:null, chapterId:id,
           subject:ref? ref.subject.name+' · '+ref.chapter.name : '—',
           date:todayStr(),
           start:new Date().toISOString(), end:new Date().toISOString(),
           minutes:mins, mode:'quick-log'
         });
         saveDB(); closeModal();
         toast('Logged '+mins+' min');
         render();
       } else toast('Log failed');
       return;
     }
     if(act==='chapter-manual'){
       for(const s of DB.subjects){
         const c=s.chapters.find(x=>x.id===id);
         if(c){
           c.manualStatus=el.value||null;
           saveDB(); render(); return;
         }
       }
       return;
     }
     if(act==='import-exam-chapters'){
       let added=0;
       DB.exams.forEach(e=>{
         let subj=DB.subjects.find(s=>s.name.toLowerCase()===e.subject.toLowerCase());
         if(!subj){
           subj={id:uid(),name:e.subject,color:SUBJECT_COLORS[DB.subjects.length%SUBJECT_COLORS.length],createdAt:todayStr(),chapters:[]};
           DB.subjects.push(subj);
         }
         e.chapters.forEach(ec=>{
           if(!subj.chapters.some(c=>c.name===ec.name)){
             subj.chapters.push(mkChapter(ec.name));
             added++;
           }
         });
       });
       saveDB(); toast(added+' chapters imported'); render(); return;
     }
   
     /* --- task actions --- */
     if(act==='toggle-task'){
       const t=DB.tasks.find(x=>x.id===id); if(!t) return;
       if(t.status==='COMPLETED'){ t.status='TODO'; t.completedAt=null; }
       else { t.status='COMPLETED'; t.completedAt=new Date().toISOString(); }
       saveDB(); render(); return;
     }
     if(act==='toggle-sub'){
       const t=DB.tasks.find(x=>x.id===id); if(!t) return;
       const s=t.subtasks.find(x=>x.id===el.dataset.sub); if(!s) return;
       s.done=!s.done; saveDB(); render(); return;
     }
     if(act==='start-task'||act==='start-task-now'){
       const t=DB.tasks.find(x=>x.id===id); if(!t) return;
       Timer.setTask(t.id);
       if(t.status==='TODO'){ t.status='IN_PROGRESS'; saveDB(); }
       closeModal();
       $('#exec').classList.add('show');
       Timer.start();
       return;
     }
     if(act==='complete-task'){
       const t=DB.tasks.find(x=>x.id===id); if(!t) return;
       t.status='COMPLETED'; t.completedAt=new Date().toISOString();
       saveDB(); toast('Completed'); render(); return;
     }
     if(act==='skip-task'){
       const t=DB.tasks.find(x=>x.id===id); if(!t) return;
       t.status='SKIPPED'; saveDB(); toast('Skipped'); render(); return;
     }
     if(act==='resched-task'){
       const t=DB.tasks.find(x=>x.id===id); if(!t) return;
       t.status='RESCHEDULED'; saveDB(); toast('Deferred to next slot'); regenerate(0,true); render(); return;
     }
     if(act==='pause-task'){ Timer.pause(); return; }
   
     if(act==='new-task'){ modalTaskForm(); return; }
     if(act==='edit-task'){ modalTaskForm(DB.tasks.find(x=>x.id===id)); return; }
     if(act==='save-task'){
       const id2=el.dataset.id;
       const data={
         title:$('#m-title').value.trim()||'Untitled',
         objective:$('#m-objective').value.trim(),
         category:$('#m-category').value,
         subject:$('#m-subject').value.trim(),
         priority:Number($('#m-priority').value),
         estimatedMinutes:Number($('#m-est').value)||30,
         deadline:$('#m-deadline').value||todayStr(),
         chapterId:$('#m-chapter').value||null,
         notes:$('#m-notes').value.trim()
       };
       if(id2){
         const t=DB.tasks.find(x=>x.id===id2); Object.assign(t,data);
       } else {
         DB.tasks.push({id:uid(),...data,actualMinutes:0,status:'TODO',
           difficulty:'MEDIUM',subtasks:[],createdAt:todayStr(),completedAt:null});
       }
       saveDB(); closeModal(); toast('Task saved'); regenerate(); render(); return;
     }
     if(act==='add-sub'){
       const t=DB.tasks.find(x=>x.id===id); if(!t) return;
       const title=prompt('Subtask title:'); if(!title) return;
       t.subtasks.push({id:uid(),title,done:false,duration:10});
       saveDB(); render(); return;
     }
     if(act==='del-task'){
       if(!confirm('Delete this task?')) return;
       DB.tasks=DB.tasks.filter(x=>x.id!==id); saveDB(); render(); return;
     }
   
     /* --- exams --- */
     if(act==='new-exam'){ modalNewExam(); return; }
     if(act==='save-exam'){
       const subject=$('#ex-subject').value.trim(); if(!subject){ toast('Subject required'); return; }
       const chapters=$('#ex-chapters').value.split('\n').map(s=>s.trim()).filter(Boolean)
         .map(name=>({id:uid(),name,status:'NOT_STARTED',est:{learn:45,practice:40,numericals:45,revision:20,test:30}}));
       DB.exams.push({
         id:uid(),subject,title:$('#ex-title').value.trim()||subject+' Exam',
         date:$('#ex-date').value, start:$('#ex-start').value, end:$('#ex-end').value,
         importance:$('#ex-imp').value, chapters
       });
       saveDB(); closeModal(); toast('Exam added'); render(); return;
     }
     if(act==='del-exam'){
       if(!confirm('Delete this exam?')) return;
       DB.exams=DB.exams.filter(x=>x.id!==id); saveDB(); render(); return;
     }
     if(act==='gen-study'){
       const e=DB.exams.find(x=>x.id===id); if(!e) return;
       let added=0;
       e.chapters.forEach(c=>{
         if(['NOT_STARTED','STARTED','LEARNING'].includes(c.status)){
           const exists=DB.tasks.some(t=>t.subject===e.subject && t.title.includes(c.name));
           if(!exists){
             DB.tasks.push({
               id:uid(),title:`${e.subject} — ${c.name}: study + practice`,
               category:'ACADEMICS',subject:e.subject,priority:1,
               estimatedMinutes:70,actualMinutes:0,deadline:e.date,status:'TODO',
               difficulty:'MEDIUM',notes:'',objective:`Learn, practice and mark weak areas in ${c.name}.`,
               subtasks:[],chapterId:null,createdAt:todayStr(),completedAt:null
             });
             added++;
           }
         }
       });
       saveDB(); toast(added+' study task(s) created'); regenerate(); render(); return;
     }
     if(act==='chap-status'){
       const e=DB.exams.find(x=>x.id===id); if(!e) return;
       const c=e.chapters.find(x=>x.id===el.dataset.chap); if(!c) return;
       c.status=el.value; saveDB(); render(); return;
     }
   
     /* --- misc --- */
     if(act==='regen'){ regenerate(0,false); toast('Day regenerated'); render(); return; }
     if(act==='whatnow'){ modalWhatNow(); return; }
     if(act==='wasted'){ modalWasted(); return; }
     if(act==='wasted-amt'){ $('#m-wasted').value=id; return; }
     if(act==='apply-wasted'){
       const mins=Number($('#m-wasted').value)||60;
       DB.schedule=buildDayPlan(todayStr(),{lostMinutes:mins,fromMin:nowMin()});
       saveDB(); closeModal(); toast('Recalculated · '+mins+' min lost'); render(); return;
     }
   
     /* --- execution mode --- */
     if(act==='open-exec'){
       if(!Timer.taskId && !Timer.chapterId){
         const nb=nextBlock()||currentBlock();
         if(nb && nb.taskId) Timer.setTask(nb.taskId);
       }
       $('#exec').classList.add('show'); Timer.render(); return;
     }
     if(act==='close-exec'){ $('#exec').classList.remove('show'); Timer.pause(); return; }
     if(act==='timer-start'){ Timer.start(); return; }
     if(act==='timer-pause'){ Timer.pause(); return; }
     if(act==='timer-complete'){ Timer.complete(); return; }
     if(act==='timer-launch'){
       if(!Timer.taskId && !Timer.chapterId){
         const nb=nextBlock()||currentBlock();
         if(nb && nb.taskId) Timer.setTask(nb.taskId,5);
       } else if(Timer.chapterId){
         Timer.setChapter(Timer.chapterId,5);
       } else {
         Timer.setTask(Timer.taskId,5);
       }
       Timer.launch=true; Timer.start();
       toast('5-Minute Launch · just start');
       return;
     }
   
     /* --- calendar --- */
     if(act==='cal-prev'){ CAL_MONTH--; if(CAL_MONTH<0){CAL_MONTH=11;CAL_YEAR--;} render(); return; }
     if(act==='cal-next'){ CAL_MONTH++; if(CAL_MONTH>11){CAL_MONTH=0;CAL_YEAR++;} render(); return; }
     if(act==='cal-today'){ const n=new Date(); CAL_MONTH=n.getMonth(); CAL_YEAR=n.getFullYear(); render(); return; }
     if(act==='cal-day'){ openDrawer(id); return; }
   
     /* --- drawer --- */
     if(act==='drawer-add-task'){ modalTaskForm(null, DRAWER_DATE); return; }
     if(act==='drawer-add-exam'){ modalNewExam(DRAWER_DATE); return; }
     if(act==='drawer-open-day'){
       const ds=DRAWER_DATE;
       if(ds===todayStr()){ VIEW='today'; }
       else {
         // jump to that day's plan by faking "today" for the session
         // For simplicity: open the Today view showing today, but toast
         VIEW='calendar';
         toast('Day plan view coming soon — for now, today only');
       }
       closeDrawer();
       render({resetScroll:true});
       return;
     }
   
     /* --- projects --- */
     if(act==='new-project'){
       const title=prompt('Project title:'); if(!title) return;
       DB.projects.push({id:uid(),title,description:'',milestones:[]});
       saveDB(); render(); return;
     }
     if(act==='toggle-project-task'){
       const p=DB.projects.find(x=>x.id===id); if(!p) return;
       const m=p.milestones.find(x=>x.id===el.dataset.ms); if(!m) return;
       const t=m.tasks.find(x=>x.id===el.dataset.task); if(!t) return;
       t.done=!t.done; saveDB(); render(); return;
     }
     if(act==='del-project'){
       if(!confirm('Delete project?')) return;
       DB.projects=DB.projects.filter(x=>x.id!==id); saveDB(); render(); return;
     }
   
     /* --- files --- */
     if(act==='new-file'){
       const subject=prompt('Subject:'); if(!subject) return;
       const type=prompt('Type (Notebook / Practical File / Assignment):','Notebook')||'Notebook';
       DB.files.push({id:uid(),subject,type,deadline:relDate(3),remaining:'10 pages',
         estimatedMinutes:60,priority:3,status:'PENDING',sessions:['Session 1','Session 2']});
       saveDB(); render(); return;
     }
     if(act==='file-session'){
       const f=DB.files.find(x=>x.id===id); if(!f) return;
       DB.tasks.push({
         id:uid(),title:`${f.subject} — ${f.type} session`,
         category:'FILES',subject:f.subject,priority:f.priority,
         estimatedMinutes:30,actualMinutes:0,deadline:f.deadline,status:'TODO',
         difficulty:'LOW',notes:'',objective:'Complete one session and mark progress.',
         subtasks:[],chapterId:null,createdAt:todayStr(),completedAt:null
       });
       saveDB(); toast('Session added to tasks'); regenerate(); render(); return;
     }
     if(act==='del-file'){
       if(!confirm('Delete file work?')) return;
       DB.files=DB.files.filter(x=>x.id!==id); saveDB(); render(); return;
     }
   
     /* --- habits --- */
     if(act==='new-habit'){
       const title=prompt('Habit title:'); if(!title) return;
       const minutes=Number(prompt('Minutes per day:','15'))||15;
       DB.habits.push({id:uid(),title,minutes,days:[0,1,2,3,4,5,6],streak:0,lastDone:null,examSafe:false});
       saveDB(); render(); return;
     }
     if(act==='habit-log'){
       const h=DB.habits.find(x=>x.id===id); if(!h) return;
       if(h.lastDone===todayStr()){ toast('Already logged today'); return; }
       h.streak=(h.streak||0)+1; h.lastDone=todayStr(); saveDB(); toast(h.title+' logged'); render(); return;
     }
     if(act==='del-habit'){
       if(!confirm('Delete habit?')) return;
       DB.habits=DB.habits.filter(x=>x.id!==id); saveDB(); render(); return;
     }
   
     /* --- settings & file sync --- */
     if(act==='save-settings'){
       const s=DB.settings;
       s.user=$('#set-user').value.trim()||'Chief';
       s.examModeThreshold=Number($('#set-examth').value)||10;
       s.wake=$('#set-wake').value; s.sleep=$('#set-sleep').value;
       s.bufferMinutes=Number($('#set-buffer').value)||10;
       s.maxStudyMinutesPerDay=Number($('#set-maxstudy').value)||300;
       s.focusDuration=Number($('#set-focus').value)||40;
       s.breakDuration=Number($('#set-break').value)||10;
       s.exerciseTarget=Number($('#set-exercise').value)||30;
       s.englishTarget=Number($('#set-english').value)||15;
       s.projectTime=Number($('#set-project').value)||30;
       s.recreationAllowance=Number($('#set-recreation').value)||60;
       s.distractions=$('#set-distractions').value;
       saveDB(); toast('Settings saved'); regenerate(); render(); return;
     }
     if(act==='new-commitment'){
       const title=prompt('Commitment title:'); if(!title) return;
       const start=prompt('Start time (HH:MM):','09:00'); if(!start) return;
       const end=prompt('End time (HH:MM):','10:00'); if(!end) return;
       DB.commitments.push({id:uid(),title,type:'routine',start,end,days:[0,1,2,3,4,5,6]});
       saveDB(); regenerate(); render(); return;
     }
     if(act==='del-commitment'){
       if(!confirm('Delete commitment?')) return;
       DB.commitments=DB.commitments.filter(x=>x.id!==id); saveDB(); regenerate(); render(); return;
     }
   
     /* --- file sync --- */
     if(act==='fs-connect'){ FileSync.connect(); return; }
     if(act==='fs-reconnect'){ FileSync.reconnect(); return; }
     if(act==='fs-disconnect'){ if(!confirm('Disconnect the data file? Auto-save will stop.')) return; FileSync.disconnect(); return; }
     if(act==='fs-save'){ FileSync.save().then(()=>toast('Saved to file')); return; }
   
     /* --- export / reset --- */
     if(act==='export'){
       const blob=new Blob([JSON.stringify(DB,null,2)],{type:'application/json'});
       const a=document.createElement('a');
       a.href=URL.createObjectURL(blob);
       a.download='chief-execution-'+todayStr()+'.json';
       a.click(); toast('Exported JSON'); return;
     }
     if(act==='export-csv'){
       const rows=[['id','title','category','subject','priority','status','estimatedMinutes','actualMinutes','deadline','chapterId']];
       DB.tasks.forEach(t=>rows.push([t.id,t.title,t.category,t.subject,t.priority,t.status,t.estimatedMinutes,t.actualMinutes||0,t.deadline||'',t.chapterId||'']));
       const csv=rows.map(r=>r.map(x=>`"${String(x).replace(/"/g,'""')}"`).join(',')).join('\n');
       const blob=new Blob([csv],{type:'text/csv'});
       const a=document.createElement('a');
       a.href=URL.createObjectURL(blob);
       a.download='tasks-'+todayStr()+'.csv';
       a.click(); toast('Exported CSV'); return;
     }
     if(act==='reset'){
       if(!confirm('Reset ALL data? This cannot be undone.')) return;
       if(!confirm('Really delete everything?')) return;
       localStorage.removeItem(DB_KEY); DB=loadDB(); migrate(); regenerate(); render(); toast('Reset complete'); return;
     }
   });
   
   /* ------------------------------------------------------------
      17. INIT
      ------------------------------------------------------------ */
   async function init(){
     DB=loadDB();
     migrate();
     if(!DB.schedule || DB.schedule.date!==todayStr()) regenerate();
   
     renderNav();
     renderClock();
     renderExamPill();
     renderFocusPill();
     render();
   
     // file sync boot
     await FileSync.init();
     FileSync.updateUI();
   
     setInterval(renderClock,1000);
     setInterval(()=>{
       if(['dashboard','today'].includes(VIEW)) render();
     },60000);
   
     $('#menuBtn').addEventListener('click',()=>$('.sidebar').classList.toggle('open'));
     $('#overlay').addEventListener('click',e=>{ if(e.target.id==='overlay') closeModal(); });
     $('#drawerBackdrop').addEventListener('click',closeDrawer);
   
     toast('Assistant online · '+DB.settings.user);
     console.log('%c◈ CHIEF\'S EXECUTION ASSISTANT v2','color:#d4af37;font-size:16px;font-weight:bold;');
   }
   
   document.addEventListener('DOMContentLoaded',init);
