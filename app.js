/* ============================================================
   CHIEF'S EXECUTION ASSISTANT — v3
   Adds: Adaptive Rescheduling · Tell the Assistant · Question Practice
   Fixes: Settings auto-save · File/localStorage conflict on load
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
   function savedPulse(){
     let el=document.querySelector('.saved-pulse');
     if(!el){ el=document.createElement('div'); el.className='saved-pulse'; el.textContent='Saved'; document.body.appendChild(el); }
     el.classList.add('show');
     clearTimeout(el._t);
     el._t=setTimeout(()=>el.classList.remove('show'), 1000);
   }
   
   /* ------------------------------------------------------------
      1. INDEXEDDB
      ------------------------------------------------------------ */
   function idbOpen(){return new Promise((res,rej)=>{const r=indexedDB.open('cea_fs',1);
     r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});}
   async function idbSet(k,v){const db=await idbOpen();return new Promise((res,rej)=>{
     const tx=db.transaction('kv','readwrite');tx.objectStore('kv').put(v,k);
     tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error);});}
   async function idbGet(k){const db=await idbOpen();return new Promise((res,rej)=>{
     const tx=db.transaction('kv','readonly');const r=tx.objectStore('kv').get(k);
     r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});}
   async function idbDel(k){const db=await idbOpen();return new Promise((res,rej)=>{
     const tx=db.transaction('kv','readwrite');tx.objectStore('kv').delete(k);
     tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error);});}
   
   /* ------------------------------------------------------------
      2. FILE SYNC — safe (compares timestamps)
      ------------------------------------------------------------ */
   const FileSync = {
     handle:null, connected:false, saving:false, lastSave:null,
     supported: typeof window!=='undefined' && 'showSaveFilePicker' in window,
   
     async init(){
       try{
         const h=await idbGet('dataFileHandle');
         if(h){
           this.handle=h;
           const perm=await h.queryPermission({mode:'readwrite'});
           if(perm==='granted'){
             this.connected=true;
             // CRITICAL: only load from file if file is NEWER than localStorage
             await this.loadFromFileIfNewer();
           }
         }
       }catch(e){ console.warn('FileSync init failed', e); }
       this.updateUI();
     },
   
     async connect(){
       if(!this.supported){ toast('Browser does not support file sync — use Export JSON'); return; }
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
       }catch(e){ if(e && e.name!=='AbortError') toast('Connection failed'); }
     },
   
     async reconnect(){
       if(!this.handle) return this.connect();
       try{
         const perm=await this.handle.requestPermission({mode:'readwrite'});
         if(perm==='granted'){
           this.connected=true;
           await this.loadFromFileIfNewer();
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
       }catch(e){ console.warn('File save failed', e); }
       finally { this.saving=false; }
     },
   
     async loadFromFileIfNewer(){
       try{
         const file=await this.handle.getFile();
         const txt=await file.text();
         if(!txt.trim()) return;
         const data=JSON.parse(txt);
         if(!data || !data.settings) return;
   
         // Compare timestamps
         const localRaw=localStorage.getItem(DB_KEY);
         let localSavedAt=null;
         if(localRaw){ try{ const lp=JSON.parse(localRaw); localSavedAt=lp.savedAt||null; }catch(e){} }
   
         const fileSavedAt = data.savedAt || null;
         const fileTime = fileSavedAt? Date.parse(fileSavedAt) : 0;
         const localTime = localSavedAt? Date.parse(localSavedAt) : 0;
   
         // Only overwrite local if file is NEWER
         if(fileTime > localTime){
           DB=data; migrate();
           localStorage.setItem(DB_KEY, JSON.stringify(DB));
           render();
           toast('Loaded newer data from file');
         } else {
           // Local is newer or equal → keep local, but note we're connected
           console.log('Local data is newer than file — keeping local');
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
       if(this.connected){ p.classList.add('on'); t.textContent='DATA FILE · AUTO-SAVE'; }
       else if(this.handle){ p.classList.remove('on'); t.textContent='DATA FILE · RECONNECT'; }
       else { p.classList.remove('on'); t.textContent='DATA FILE · LOCAL ONLY'; }
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
   
   function mkChapter(name){
     return {id:uid(),name,manualStatus:null,totalMinutes:0,sessions:[],lastStudied:null,createdAt:todayStr()};
   }
   
   function seed(){
     const now=todayStr();
   
     const settings={
       user:'Chief', wake:'06:00', sleep:'23:00',
       bufferMinutes:10, focusDuration:40, breakDuration:10,
       maxStudyMinutesPerDay:300,
       exerciseTarget:30, englishTarget:15, projectTime:30, recreationAllowance:60,
       examModeThreshold:10,
       distractions:'Tablet · Instagram · YouTube · Gaming · PC',
       practiceTimerDefault:'per-question',
       practicePerQuestionSec:90
     };
   
     const commitments=[
       {id:uid(),title:'Morning Routine & Prep',type:'routine', start:'06:00',end:'07:30',days:[0,1,2,3,4,5,6]},
       {id:uid(),title:'School',                type:'school', start:'07:30',end:'13:30',days:[1,2,3,4,5,6]},
       {id:uid(),title:'Lunch',                 type:'meal',   start:'14:15',end:'14:40',days:[0,1,2,3,4,5,6]},
       {id:uid(),title:'Chemistry Coaching',    type:'coaching',start:'15:30',end:'17:00',days:[1,2,4,6]},
       {id:uid(),title:'Physics Coaching',      type:'coaching',start:'17:30',end:'19:00',days:[1,3,5]},
       {id:uid(),title:'Dinner',                type:'meal',   start:'19:00',end:'19:30',days:[0,1,2,3,4,5,6]},
     ];
   
     const ch=(name,status='NOT_STARTED')=>({id:uid(),name,status,est:{learn:45,practice:40,numericals:45,revision:20,test:30}});
   
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
       actualMinutes:0,deadline,status:'TODO',difficulty:opts.difficulty||'MEDIUM',
       notes:opts.notes||'',objective:opts.objective||'',subtasks:opts.subtasks||[],
       chapterId:opts.chapterId||null,createdAt:now,completedAt:null
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
   
     const subjects=[
       {id:uid(),name:'Physics',color:'#d4af37',createdAt:now,chapters:[
         mkChapter('Electric Charges and Fields'),mkChapter('Electric Potential'),
         mkChapter('Capacitance'),mkChapter('Current Electricity')]},
       {id:uid(),name:'Chemistry',color:'#6fb7e0',createdAt:now,chapters:[
         mkChapter('Solutions'),mkChapter('Electrochemistry'),mkChapter('Coordination Compounds')]},
       {id:uid(),name:'Biology',color:'#7fe0a0',createdAt:now,chapters:[
         mkChapter('Reproduction in Flowering Plants'),mkChapter('Human Reproduction'),
         mkChapter('Molecular Basis of Inheritance')]},
     ];
   
     /* --- Seeded question bank (source-labeled, clearly marked as samples) --- */
     const questions = seedQuestions();
   
     return {
       version:3, settings, commitments, tasks, exams, habits, files, projects,
       subjects, questions, practiceSessions:[], rescheduleHistory:[],
       schedule:null, focusSessions:[], reviews:[], log:[],
       savedAt:new Date().toISOString()
     };
   }
   
   function seedQuestions(){
     const mk=(q)=>({
       id:uid(),
       exam:q.exam, year:q.year||null, subject:q.subject, chapter:q.chapter,
       topic:q.topic||'', questionType:q.questionType, difficulty:q.difficulty||'MEDIUM',
       marks:q.marks||1, source:q.source||(q.exam+' '+(q.year||'')+' — '+(q.chapter||'')+' (sample)'),
       questionText:q.questionText,
       options:q.options||null,
       answer:q.answer, solution:q.solution||'',
       recommendedTime:q.recommendedTime||90
     });
   
     return [
       mk({exam:'CBSE',year:2024,subject:'Physics',chapter:'Current Electricity',topic:"Ohm's Law",
         questionType:'MCQ',marks:1,
         questionText:'The drift velocity of electrons in a conductor is directly proportional to:',
         options:['Electric field','Length of conductor','Area of cross-section','Resistivity'],
         answer:'Electric field',solution:'v_d = μE where μ is mobility. Drift velocity is directly proportional to applied electric field.',
         recommendedTime:60, source:'CBSE 2024 Physics — Current Electricity (sample)'}),
   
       mk({exam:'CBSE',year:2023,subject:'Physics',chapter:'Current Electricity',topic:'Kirchhoff',
         questionType:'Short',marks:2,
         questionText:'State Kirchhoff’s junction rule and explain its basis.',
         answer:'Sum of currents entering = sum of currents leaving (conservation of charge)',
         solution:'The junction rule states that at any junction, the algebraic sum of currents is zero: ΣI = 0. This follows from conservation of electric charge — charge cannot accumulate at a junction in a steady state.',
         recommendedTime:120, source:'CBSE 2023 Physics — Current Electricity (sample)'}),
   
       mk({exam:'CBSE',year:2024,subject:'Physics',chapter:'Electrostatics',topic:'Coulomb',
         questionType:'MCQ',marks:1,
         questionText:'The electric field inside a hollow charged conductor is:',
         options:['Zero','Uniform','Maximum at the surface','Depends on shape'],
         answer:'Zero',solution:'For a charged conductor in electrostatic equilibrium, the field inside the cavity is zero (Gauss’s law).',
         recommendedTime:60, source:'CBSE 2024 Physics — Electrostatics (sample)'}),
   
       mk({exam:'NEET',year:2023,subject:'Biology',chapter:'Human Reproduction',topic:'',
         questionType:'MCQ',marks:4,
         questionText:'The process of release of the ovum from the Graafian follicle is called:',
         options:['Ovulation','Fertilisation','Implantation','Gestation'],
         answer:'Ovulation',
         solution:'Ovulation is the release of a secondary oocyte from a mature Graafian follicle, typically around day 14 of the menstrual cycle.',
         recommendedTime:60, source:'NEET 2023 Biology — Human Reproduction (sample)'}),
   
       mk({exam:'NEET',year:2024,subject:'Biology',chapter:'Genetics',topic:'Inheritance',
         questionType:'MCQ',marks:4,
         questionText:'A cross between a homozygous tall pea plant and a homozygous dwarf pea plant produces F1 that is:',
         options:['All tall','All dwarf','1 tall : 1 dwarf','3 tall : 1 dwarf'],
         answer:'All tall',
         solution:'Tall (TT) × dwarf (tt) → all Tt (tall) in F1. Tallness is dominant.',
         recommendedTime:60, source:'NEET 2024 Biology — Genetics (sample)'}),
   
       mk({exam:'JEE Main',year:2023,subject:'Chemistry',chapter:'Electrochemistry',topic:'Nernst',
         questionType:'Numerical',marks:4,
         questionText:'Calculate the EMF of a Daniel cell at 298 K when [Zn²⁺] = 0.1 M and [Cu²⁺] = 0.01 M. (E°cell = 1.10 V)',
         answer:'1.07 V',
         solution:'Nernst: E = E° − (0.0591/n)·log([Zn²⁺]/[Cu²⁺])\nE = 1.10 − 0.0295·log(10) = 1.10 − 0.03 ≈ 1.07 V',
         recommendedTime:180, source:'JEE Main 2023 Chemistry — Electrochemistry (sample)'}),
   
       mk({exam:'JEE Main',year:2024,subject:'Physics',chapter:'Capacitance',topic:'',
         questionType:'MCQ',marks:4,
         questionText:'A parallel plate capacitor is charged and then disconnected. If the plates are pulled apart, the potential difference:',
         options:['Increases','Decreases','Remains same','Becomes zero'],
         answer:'Increases',
         solution:'Q constant (disconnected). C = εA/d decreases as d increases. V = Q/C therefore increases.',
         recommendedTime:90, source:'JEE Main 2024 Physics — Capacitance (sample)'}),
   
       mk({exam:'CBSE',year:2024,subject:'Chemistry',chapter:'Solutions',topic:'Colligative',
         questionType:'Short',marks:2,
         questionText:'Why is the boiling point of a solution higher than that of the pure solvent?',
         answer:'Due to elevation in boiling point caused by vapour pressure lowering.',
         solution:'The presence of a non-volatile solute lowers the vapour pressure of the solution, so a higher temperature is required for the vapour pressure to equal atmospheric pressure — hence the boiling point is elevated.',
         recommendedTime:120, source:'CBSE 2024 Chemistry — Solutions (sample)'}),
   
       mk({exam:'CBSE',year:2023,subject:'Physics',chapter:'Current Electricity',topic:"Wheatstone",
         questionType:'Numerical',marks:3,
         questionText:'In a Wheatstone bridge, the four resistances are 10 Ω, 20 Ω, 30 Ω and 60 Ω in order. Is the bridge balanced?',
         answer:'Yes',
         solution:'Balance condition: P/Q = R/S → 10/20 = 30/60 = 0.5. Balanced.',
         recommendedTime:150, source:'CBSE 2023 Physics — Current Electricity (sample)'}),
   
       mk({exam:'CBSE',year:2024,subject:'Biology',chapter:'Reproductive Health',topic:'',
         questionType:'MCQ',marks:1,
         questionText:'The technique of introducing semen directly into the uterus is called:',
         options:['IUI','ZIFT','GIFT','ICSI'],
         answer:'IUI',
         solution:'IUI (Intra-Uterine Insemination) involves introducing semen (or a prepared sperm sample) into the uterus.',
         recommendedTime:60, source:'CBSE 2024 Biology — Reproductive Health (sample)'}),
     ];
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
     DB.tasks.forEach(t=>{
       if(t.chapterId===undefined) t.chapterId=null;
       if(typeof t.actualMinutes!=='number') t.actualMinutes=0;
       if(typeof t.estimatedMinutes!=='number') t.estimatedMinutes=40;
     });
     if(!DB.questions) DB.questions=seedQuestions();
     if(!DB.practiceSessions) DB.practiceSessions=[];
     if(!DB.rescheduleHistory) DB.rescheduleHistory=[];
     if(!DB.settings.practiceTimerDefault) DB.settings.practiceTimerDefault='per-question';
     if(!DB.settings.practicePerQuestionSec) DB.settings.practicePerQuestionSec=90;
     DB.version=3;
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
   
   let _saveTimer=null;
   function saveDB(){
     DB.savedAt=new Date().toISOString();
     // synchronous localStorage write FIRST
     try{ localStorage.setItem(DB_KEY, JSON.stringify(DB)); }catch(e){ console.warn('LS save failed',e); }
     // async file backup (debounced)
     clearTimeout(_saveTimer);
     _saveTimer=setTimeout(()=>FileSync.save(), 700);
   }
   
   /* ------------------------------------------------------------
      6. CHAPTER HELPERS
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
   function statusPct(s){ return {NOT_STARTED:2,STARTED:15,LEARNING:35,PRACTICE:55,REVISION:75,TESTED:92,MASTERED:100}[s]||0; }
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
       id:uid(), start:opts.start||new Date().toISOString(),
       end:opts.end||new Date().toISOString(), minutes,
       taskId:opts.taskId||null, note:opts.note||''
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
      8. REMAINING WORK + SCHEDULER
      ------------------------------------------------------------ */
   function remainingMinutesFor(task){
     return Math.max(0, (task.estimatedMinutes||40) - (task.actualMinutes||0));
   }
   function commitmentsFor(weekday){
     return DB.commitments.filter(c=>c.days.includes(weekday))
       .map(c=>({...c,s:t2m(c.start),e:t2m(c.end)}))
       .sort((a,b)=>a.s-b.s);
   }
   function mergeIntervals(list){
     const out=[];
     list.slice().sort((a,b)=>a.s-b.s).forEach(iv=>{
       if(out.length && iv.s<=out[out.length-1].e) out[out.length-1].e=Math.max(out[out.length-1].e,iv.e);
       else out.push({...iv});
     });
     return out;
   }
   function complement(start,end,busy){
     const out=[]; let cur=start;
     busy.forEach(b=>{ if(b.s>cur) out.push({s:cur,e:b.s}); cur=Math.max(cur,b.e); });
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
         // CRITICAL: use REMAINING, not original estimate
         const total=remainingMinutesFor(item.task) || item.task.estimatedMinutes || 40;
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
   
   /* ------------------------------------------------------------
      9. ADAPTIVE RESCHEDULER
      ------------------------------------------------------------ */
   function logReschedule(reason, before, after){
     DB.rescheduleHistory=DB.rescheduleHistory||[];
     DB.rescheduleHistory.push({
       id:uid(),
       at:new Date().toISOString(),
       reason,
       before: before.map(b=>({t:b.title,s:b.start,e:b.end})),
       after:  after.map(b=>({t:b.title,s:b.start,e:b.end}))
     });
     if(DB.rescheduleHistory.length>60) DB.rescheduleHistory=DB.rescheduleHistory.slice(-60);
   }
   
   function adaptiveReschedule(opts){
     opts=opts||{};
     const fromMin = opts.fromMin!==undefined ? opts.fromMin : nowMin();
     const prev = DB.schedule || {blocks:[]};
     const beforeBlocks = prev.blocks.filter(b=>b.end>fromMin && b.type!=='break');
   
     // Rebuild remaining day using remaining minutes
     DB.schedule = buildDayPlan(todayStr(),{
       fromMin,
       lostMinutes: opts.lostMinutes||0
     });
   
     const afterBlocks = DB.schedule.blocks.filter(b=>b.end>fromMin && b.type!=='break');
     logReschedule(opts.reason||'Schedule updated', beforeBlocks, afterBlocks);
     saveDB();
   
     // Show banner
     showSchedBanner(opts.reason||'Schedule updated', beforeBlocks, afterBlocks);
   
     return {before:beforeBlocks, after:afterBlocks};
   }
   
   function regenerate(lostMinutes,fromNow){
     if(fromNow){
       adaptiveReschedule({reason: lostMinutes? ('Lost '+lostMinutes+' min'):'Regenerated', lostMinutes:lostMinutes||0});
     } else {
       DB.schedule=buildDayPlan(todayStr(),{lostMinutes:lostMinutes||0});
       saveDB();
     }
   }
   
   let _bannerDiff=null;
   function showSchedBanner(reason, before, after){
     const b=$('#schedBanner'); if(!b) return;
     $('#schedBannerTitle').textContent='Schedule Updated';
     $('#schedBannerMsg').textContent=reason+' — remaining schedule adjusted.';
     b.classList.add('show');
     _bannerDiff={reason, before, after};
     clearTimeout(b._t);
     b._t=setTimeout(()=>b.classList.remove('show'), 12000);
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
      10. STATS
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
      11. FOCUS TIMER
      ------------------------------------------------------------ */
   const Timer={
     running:false, remaining:0, total:0,
     taskId:null, chapterId:null,
     startedAt:null, tick:null, launch:false,
   
     setTask(taskId,minutes){
       this.stopSilently();
       this.taskId=taskId; this.chapterId=null;
       const t=DB.tasks.find(x=>x.id===taskId);
       const rem=t? remainingMinutesFor(t) : 40;
       const mins=minutes|| Math.min(rem||40, DB.settings.focusDuration||40);
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
           if(t.chapterId) logChapterSession(t.chapterId, minutes, {start:this.startedAt, end:endISO, taskId:t.id});
         }
       }
   
       DB.focusSessions.push({
         id:uid(), taskId:this.taskId, chapterId:this.chapterId,
         subject:subjectLbl, date:todayStr(),
         start:this.startedAt||endISO, end:endISO, minutes,
         mode:this.launch?'launch':'focus'
       });
       saveDB();
       return minutes;
     },
   
     complete(){
       const wasTask=this.taskId;
       const taskBefore = wasTask? DB.tasks.find(x=>x.id===wasTask) : null;
       const wasEstimated = taskBefore? taskBefore.estimatedMinutes : 0;
       const wasActualBefore = taskBefore? (taskBefore.actualMinutes||0) : 0;
   
       const mins=this.commit();
       this.pause();
   
       if(wasTask && this.remaining<=0){
         const t=DB.tasks.find(x=>x.id===wasTask);
         if(t){ t.status='COMPLETED'; t.completedAt=new Date().toISOString(); saveDB(); }
         toast('Task completed');
         // After completion, adapt schedule
         setTimeout(()=>{
           adaptiveReschedule({reason:'Completed: '+taskBefore.title.slice(0,32)});
           render();
         }, 400);
       } else if(this.chapterId && this.remaining<=0){
         toast('Session complete · '+mins+' min logged');
         this.reset();
         render();
       } else {
         toast('Session logged · '+mins+' min');
         // If overran significantly, adapt
         const overrun = mins - Math.round(this.total/60);
         if(overrun>3){
           adaptiveReschedule({reason:'Session overran by '+overrun+' min'});
           render();
         } else {
           this.reset();
           render();
         }
       }
       this.reset();
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
      12. INTENT PARSER (Tell the Assistant)
      ------------------------------------------------------------ */
   const IntentParser = {
     parse(raw){
       const input=String(raw||'').trim();
       const t=input.toLowerCase();
       if(!t) return {action:'UNKNOWN', raw:input};
   
       // ---------- QUERIES ----------
       if(/(what should i do( now)?|what now|next task)/.test(t))
         return {action:'QUERY_NEXT_TASK', raw:input};
       if(/(show|what('s| is)) (me )?(my )?(schedule|plan|timeline)/.test(t) || /^my schedule/.test(t))
         return {action:'QUERY_SCHEDULE', raw:input};
       if(/(progress|how (am|are) i doing|status)/.test(t))
         return {action:'QUERY_PROGRESS', raw:input};
   
       // ---------- FOCUS SESSION ----------
       let m = t.match(/^start\s+(\d+)\s*(?:min|minute|m)?\s*(?:of\s+)?(.+?)(?:\s+session)?$/);
       if(m){
         return {action:'START_FOCUS_SESSION', duration:Number(m[1]), subject:m[2].trim(), raw:input};
       }
       if(/^(stop|end|pause)\s+(session|focus|timer)/.test(t) || t==='stop')
         return {action:'STOP_FOCUS_SESSION', raw:input};
   
       // ---------- COMPLETE ----------
       m = t.match(/^(?:i\s+)?(?:finished|completed|done with|did)\s+(.+)$/);
       if(m) return {action:'COMPLETE_TASK', target:m[1].trim(), raw:input};
   
       // ---------- SKIP / MISSED ----------
       m = t.match(/^(?:i\s+)?(?:didn'?t|did not|couldn'?t|could not|skipped|missed|skipped)\s+(.+)$/);
       if(m) return {action:'SKIP_TASK', target:m[1].trim(), raw:input};
   
       // ---------- POSTPONE / MOVE ----------
       m = t.match(/^(?:move|postpone|push|defer|shift)\s+(.+?)\s+to\s+(tomorrow|next week|next month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|(.+))$/);
       if(m) return {action:'POSTPONE_TASK', target:m[1].trim(), when:m[2].trim(), raw:input};
   
       // ---------- DELETE ----------
       m = t.match(/^delete\s+(.+)$/);
       if(m) return {action:'DELETE_TASK', target:m[1].trim(), raw:input, needsConfirm:true};
   
       // ---------- LEAVE TIME ----------
       m = t.match(/i\s+(?:have\s+to|need\s+to|must)\s+(?:leave|go|go out|be out)(?:\s+at\s+|\s+by\s+)(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
       if(m){
         let h=Number(m[1]);
         const mm=Number(m[2]||0);
         const ap=(m[3]||'').toLowerCase();
         if(ap==='pm' && h<12) h+=12;
         if(ap==='am' && h===12) h=0;
         if(!ap && h<7) h+=12; // heuristic: small numbers usually PM
         return {action:'ADD_COMMITMENT', title:'Away', start:pad(h)+':'+pad(mm), end:'23:59', raw:input};
       }
   
       // ---------- ADD / CREATE ----------
       // "add 30 minutes of English speaking [tomorrow]"
       m = t.match(/^(?:add|create|log|schedule)\s+(?:(\d+)\s*(?:min|minute|m|minutes)?\s*(?:of\s+)?)?(.+?)(?:\s+(today|tomorrow|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday))?$/);
       if(m){
         const dur=m[1]? Number(m[1]) : null;
         let title=m[2].trim();
         const when=(m[3]||'today').toLowerCase();
         return {action:'CREATE_TASK', title, duration:dur, when, raw:input};
       }
   
       // ---------- PRACTICE ----------
       m = t.match(/give me\s+(\d+)\s+(.+?)\s+(?:problems|numericals|questions|pyqs)/);
       if(m) return {action:'ADD_PRACTICE_SESSION', count:Number(m[1]), target:m[2].trim(), raw:input};
       m = t.match(/(?:practice|pyq|questions?)\s+(?:for\s+)?(.+)/);
       if(m) return {action:'ADD_PRACTICE_SESSION', count:10, target:m[1].trim(), raw:input};
   
       return {action:'UNKNOWN', raw:input};
     }
   };
   
   /* ------------------------------------------------------------
      13. ASSISTANT (executes intents)
      ------------------------------------------------------------ */
   const Assistant = {
     history:[],  // local, session-only
   
     async executeText(input){
       const intent=IntentParser.parse(input);
       const result=await this.execute(intent);
       this.history.unshift({
         at:new Date().toISOString(),
         input,
         result:result.message,
         ok:result.ok
       });
       if(this.history.length>20) this.history=this.history.slice(0,20);
       return result;
     },
   
     async execute(intent){
       switch(intent.action){
         case 'QUERY_NEXT_TASK': return this.q_nextTask();
         case 'QUERY_SCHEDULE': return this.q_schedule();
         case 'QUERY_PROGRESS': return this.q_progress();
         case 'START_FOCUS_SESSION': return this.startFocus(intent);
         case 'STOP_FOCUS_SESSION': return this.stopFocus();
         case 'COMPLETE_TASK': return this.completeTask(intent);
         case 'SKIP_TASK': return this.skipTask(intent);
         case 'POSTPONE_TASK': return this.postponeTask(intent);
         case 'DELETE_TASK': return this.deleteTask(intent);
         case 'ADD_COMMITMENT': return this.addCommitment(intent);
         case 'CREATE_TASK': return this.createTask(intent);
         case 'ADD_PRACTICE_SESSION': return this.startPractice(intent);
         default:
           return {ok:false, message:'I did not understand that. Try: "Add 30 minutes of English." or "What should I do now?"'};
       }
     },
   
     q_nextTask(){
       const ranked=rankedTasks();
       if(!ranked.length) return {ok:true, message:'No open tasks. Take a break.'};
       const r=ranked[0];
       return {ok:true, message:`Do this now: ${r.task.title} (${fmtDur(remainingMinutesFor(r.task))}) · ${r.level}`};
     },
     q_schedule(){
       const sch=getSchedule();
       const upcoming=sch.blocks.filter(b=>b.type==='task' && b.end>nowMin()).slice(0,6);
       if(!upcoming.length) return {ok:true, message:'Nothing left in today\'s schedule.'};
       const lines=upcoming.map(b=>`${m2t(b.start)} ${b.title}`).join(' · ');
       return {ok:true, message:'Remaining: '+lines};
     },
     q_progress(){
       const st=todayStats();
       return {ok:true, message:`Execution ${st.execution}% · ${st.completed}/${st.plannedTasks} tasks · ${fmtDur(st.actualMin)} logged.`};
     },
   
     startFocus(intent){
       const target=(intent.subject||'').toLowerCase();
       // try chapter first
       let ch=null, subj=null;
       for(const s of DB.subjects){
         if(s.name.toLowerCase().includes(target) || target.includes(s.name.toLowerCase())){
           subj=s; break;
         }
         for(const c of s.chapters){
           if(c.name.toLowerCase().includes(target) || target.includes(c.name.toLowerCase())){
             ch=c; subj=s; break;
           }
         }
         if(ch) break;
       }
       if(ch){
         Timer.setChapter(ch.id, intent.duration||DB.settings.focusDuration);
         $('#exec').classList.add('show'); Timer.start();
         return {ok:true, message:`Started ${intent.duration||DB.settings.focusDuration}-minute session on ${subj.name} — ${ch.name}.`};
       }
       // fall back to task search
       const task=DB.tasks.find(x=>!['COMPLETED','SKIPPED'].includes(x.status) &&
         (x.title.toLowerCase().includes(target) || (x.subject||'').toLowerCase().includes(target)));
       if(task){
         Timer.setTask(task.id, intent.duration);
         $('#exec').classList.add('show'); Timer.start();
         return {ok:true, message:`Started session on "${task.title}".`};
       }
       // generic: create a fresh task and start it
       const newT={
         id:uid(), title:'Focus: '+intent.subject, category:'ACADEMICS',
         subject:intent.subject, priority:2,
         estimatedMinutes:intent.duration||DB.settings.focusDuration,
         actualMinutes:0, deadline:todayStr(), status:'IN_PROGRESS',
         difficulty:'MEDIUM', notes:'', objective:'', subtasks:[], chapterId:null,
         createdAt:todayStr(), completedAt:null
       };
       DB.tasks.push(newT); saveDB();
       Timer.setTask(newT.id, intent.duration);
       $('#exec').classList.add('show'); Timer.start();
       return {ok:true, message:`Started a ${intent.duration||DB.settings.focusDuration}-minute session on "${intent.subject}".`};
     },
     stopFocus(){
       if(!Timer.taskId && !Timer.chapterId) return {ok:false, message:'No active session.'};
       Timer.complete();
       return {ok:true, message:'Session stopped and logged.'};
     },
   
     completeTask(intent){
       const match=this.findTask(intent.target);
       if(!match) return {ok:false, message:`No task found matching "${intent.target}".`};
       match.status='COMPLETED'; match.completedAt=new Date().toISOString();
       saveDB();
       setTimeout(()=>{ adaptiveReschedule({reason:'Completed: '+match.title.slice(0,32)}); render(); }, 300);
       return {ok:true, message:`Marked "${match.title}" as completed.`};
     },
     skipTask(intent){
       const match=this.findTask(intent.target);
       if(!match) return {ok:false, message:`No task found matching "${intent.target}".`};
       match.status='SKIPPED'; saveDB();
       setTimeout(()=>{ adaptiveReschedule({reason:'Skipped: '+match.title.slice(0,32)}); render(); }, 300);
       return {ok:true, message:`Marked "${match.title}" as skipped. Schedule adjusted.`};
     },
     postponeTask(intent){
       const match=this.findTask(intent.target);
       if(!match) return {ok:false, message:`No task found matching "${intent.target}".`};
       const when=this.resolveWhen(intent.when);
       match.deadline=when; match.status='RESCHEDULED'; saveDB();
       setTimeout(()=>{ adaptiveReschedule({reason:'Postponed: '+match.title.slice(0,32)}); render(); }, 300);
       return {ok:true, message:`Moved "${match.title}" to ${fmtDate(when)}.`};
     },
     deleteTask(intent){
       const matches=DB.tasks.filter(t=>t.title.toLowerCase().includes(intent.target.toLowerCase()));
       if(!matches.length) return {ok:false, message:`No task found matching "${intent.target}".`};
       if(matches.length>1) return {ok:false, message:`${matches.length} tasks match "${intent.target}". Please be more specific.`, needsConfirm:true};
       if(!confirm('Delete "'+matches[0].title+'"?')) return {ok:false, message:'Cancelled.'};
       DB.tasks=DB.tasks.filter(x=>x.id!==matches[0].id); saveDB(); render();
       return {ok:true, message:`Deleted "${matches[0].title}".`};
     },
     addCommitment(intent){
       DB.commitments.push({
         id:uid(), title:intent.title||'Away', type:'custom',
         start:intent.start, end:intent.end, days:[0,1,2,3,4,5,6]
       });
       saveDB();
       setTimeout(()=>{ adaptiveReschedule({reason:'New commitment: '+intent.start}); render(); }, 200);
       return {ok:true, message:`Added commitment "${intent.title}" ${intent.start}–${intent.end}. Remaining schedule adjusted.`};
     },
     createTask(intent){
       const when=this.resolveWhen(intent.when||'today');
       const t={
         id:uid(),
         title:intent.title,
         category:'ACADEMICS',
         subject:this.guessSubject(intent.title),
         priority:2,
         estimatedMinutes:intent.duration||40,
         actualMinutes:0,
         deadline:when,
         status:'TODO',
         difficulty:'MEDIUM',
         notes:'', objective:'',
         subtasks:[], chapterId:null,
         createdAt:todayStr(), completedAt:null
       };
       DB.tasks.push(t); saveDB();
       setTimeout(()=>{ regenerate(0,false); render(); }, 200);
       return {ok:true, message:`Added ${fmtDur(t.estimatedMinutes)} "${t.title}" for ${fmtDate(when)}.`};
     },
     startPractice(intent){
       const target=intent.target||'';
       // Match chapter
       let ch=null, subj=null;
       for(const s of DB.subjects){
         for(const c of s.chapters){
           if(c.name.toLowerCase().includes(target.toLowerCase()) || target.toLowerCase().includes(c.name.toLowerCase())){
             ch=c; subj=s; break;
           }
         }
         if(ch) break;
       }
       if(!ch && subj) ch=subj.chapters[0];
       if(!ch) return {ok:false, message:`No chapter found matching "${target}".`};
   
       const pool=DB.questions.filter(q=>q.chapter.toLowerCase()===ch.name.toLowerCase());
       if(!pool.length) return {ok:false, message:`No questions yet for ${ch.name}. Add some in Question Practice.`};
   
       const picked=pool.slice(0, intent.count||10);
       Practice.start({
         mode:'chapter',
         config:{subject:subj.name, chapter:ch.name, count:picked.length},
         questions:picked,
         chapterId:ch.id
       });
       return {ok:true, message:`Starting practice: ${picked.length} questions on ${ch.name}.`};
     },
   
     findTask(target){
       const t=target.toLowerCase();
       const open=DB.tasks.filter(x=>!['COMPLETED','SKIPPED'].includes(x.status));
       // exact first
       let m=open.find(x=>x.title.toLowerCase()===t);
       if(m) return m;
       // starts-with
       m=open.find(x=>x.title.toLowerCase().startsWith(t));
       if(m) return m;
       // includes
       m=open.find(x=>x.title.toLowerCase().includes(t) || (x.subject||'').toLowerCase().includes(t));
       return m||null;
     },
     resolveWhen(w){
       w=(w||'today').toLowerCase();
       if(w==='today') return todayStr();
       if(w==='tomorrow') return relDate(1);
       if(w==='next week') return relDate(7);
       if(w==='next month') return relDate(30);
       const days={monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6,sunday:0};
       if(w in days){
         const now=new Date(); const cur=now.getDay();
         let diff=(days[w]-cur+7)%7; if(diff===0) diff=7;
         return relDate(diff);
       }
       return todayStr();
     },
     guessSubject(text){
       const tl=text.toLowerCase();
       for(const s of DB.subjects){
         if(tl.includes(s.name.toLowerCase())) return s.name;
       }
       return '';
     }
   };
   
   /* ------------------------------------------------------------
      14. QUESTION PRACTICE ENGINE
      ------------------------------------------------------------ */
   const Practice = {
     session:null,
     timerTick:null,
     questionTime:0,
     totalTime:0,
   
     start(config){
       const qs=config.questions;
       if(!qs || !qs.length){ toast('No questions to practice'); return; }
   
       this.session={
         id:uid(),
         mode:config.mode||'custom',
         config:config.config||{},
         questions:qs,
         answers:{},          // qid -> answer string
         marked:{},           // qid -> true
         revealed:{},         // qid -> true (answer shown)
         times:{},            // qid -> seconds spent
         current:0,
         startedAt:new Date().toISOString(),
         finishedAt:null,
         timerMode: DB.settings.practiceTimerDefault||'per-question',
         perQuestionSec: config.perQuestionSec || DB.settings.practicePerQuestionSec || 90,
         totalSec: config.totalSec || 0,
         totalRemaining: config.totalSec || 0,
         chapterId: config.chapterId||null
       };
       this.questionTime=0;
       this.renderSession();
       $('#practiceSession').classList.add('show');
       this.startTimer();
     },
   
     startTimer(){
       this.stopTimer();
       if(this.session.timerMode==='none') return;
       this.timerTick=setInterval(()=>{
         const s=this.session; if(!s) return;
         this.questionTime++;
         const q=s.questions[s.current];
         s.times[q.id]=(s.times[q.id]||0)+1;
   
         if(s.timerMode==='full'){
           s.totalRemaining--;
           if(s.totalRemaining<=0){ this.stopTimer(); this.onTimerExpire(); }
         } else if(s.timerMode==='per-question'){
           const limit=s.perQuestionSec;
           const used=s.times[q.id]||0;
           if(used>=limit) this.onTimerExpire();
         }
         this.renderTimerOnly();
       },1000);
     },
     stopTimer(){
       if(this.timerTick){ clearInterval(this.timerTick); this.timerTick=null; }
     },
     setTimerMode(mode, customSec){
       if(!this.session) return;
       this.session.timerMode=mode;
       if(mode==='per-question' && customSec) this.session.perQuestionSec=customSec;
       this.startTimer();
       this.renderSession();
     },
     onTimerExpire(){
       this.stopTimer();
       if(this.session.timerMode==='per-question'){
         toast('Time expired for this question — you can continue or move on.');
       } else if(this.session.timerMode==='full'){
         toast('Full paper time expired. Submit when ready.');
       }
     },
   
     renderTimerOnly(){
       const s=this.session; if(!s) return;
       const el=$('#psTimer'); if(!el) return;
       let secs=0;
       if(s.timerMode==='full') secs=Math.max(0,s.totalRemaining);
       else if(s.timerMode==='per-question'){
         const q=s.questions[s.current];
         const used=s.times[q.id]||0;
         secs=Math.max(0, s.perQuestionSec - used);
         el.classList.toggle('warn', secs<15);
       } else { secs=0; el.textContent='∞'; el.classList.remove('warn'); return; }
       const m=Math.floor(secs/60), sc=secs%60;
       el.textContent=pad(m)+':'+pad(sc);
     },
   
     renderSession(){
       const s=this.session; if(!s) return;
       const q=s.questions[s.current];
       const total=s.questions.length;
       const isRevealed=!!s.revealed[q.id];
       const sel=s.answers[q.id];
   
       const navDots=s.questions.map((qq,i)=>{
         const cls=['nav-dot'];
         if(i===s.current) cls.push('current');
         if(s.answers[qq.id]) cls.push('answered');
         if(s.marked[qq.id]) cls.push('marked');
         return `<button class="${cls.join(' ')}" data-act="ps-jump" data-id="${i}">${i+1}</button>`;
       }).join('');
   
       const optionsHTML = q.options ? `
         <div class="q-options" id="psOptions">
           ${q.options.map((opt,idx)=>{
             const letter=String.fromCharCode(65+idx);
             let cls='q-opt';
             if(sel===opt) cls+=' selected';
             if(isRevealed){
               if(opt===q.answer) cls+=' correct';
               else if(sel===opt) cls+=' wrong';
             }
             return `<div class="${cls}" data-act="ps-choose" data-opt="${esc(opt)}">
               <span class="opt-letter">${letter}</span>
               <span>${esc(opt)}</span>
             </div>`;
           }).join('')}
         </div>
       ` : `
         <div class="ps-answer-zone">
           <label>Your Answer</label>
           <textarea id="psAnswer" ${isRevealed?'disabled':''} placeholder="Type your answer...">${esc(sel||'')}</textarea>
         </div>
       `;
   
       const solutionHTML = isRevealed ? `
         <div class="ps-solution">
           <h5>Correct Answer</h5>
           <div class="ps-solution-body"><b style="color:var(--gold-2);">${esc(q.answer)}</b></div>
           ${q.solution? `<h5 style="margin-top:14px;">Solution</h5><div class="ps-solution-body">${esc(q.solution)}</div>`:''}
         </div>
       ` : '';
   
       const timed=s.timerMode!=='none';
   
       $('#practiceSession').innerHTML=`
         <div class="ps-top">
           <div>
             <div class="ps-title">QUESTION PRACTICE</div>
             <div class="ps-sub">${esc(s.config.subject||q.subject)} · ${esc(s.config.chapter||q.chapter)} · Question ${s.current+1} of ${total}</div>
           </div>
           <div class="flex gap12 center">
             ${timed?`<div class="ps-timer" id="psTimer">--:--</div>`:`<div class="ps-timer" style="opacity:.5">∞</div>`}
             <button class="btn ghost sm" data-act="ps-change-timer">⏱ Timer: ${s.timerMode==='none'?'Off':s.timerMode==='full'?'Paper':'Per-Q'}</button>
             <button class="btn ghost sm" data-act="ps-exit">Exit</button>
           </div>
         </div>
         <div class="ps-body">
           <div class="ps-qnum">Q ${s.current+1} / ${total} · ${esc(q.questionType)} · ${esc(q.difficulty)} · ${q.marks} mark${q.marks>1?'s':''} · rec. ${fmtDur(Math.round((q.recommendedTime||90)/60))}</div>
           <div class="ps-qtext">${esc(q.questionText)}</div>
           ${optionsHTML}
           ${!isRevealed && !q.options ? `<div style="margin-top:12px;"><button class="btn sm" data-act="ps-save-answer">Save Answer</button></div>`:''}
           ${solutionHTML}
           <div class="q-meta" style="margin-top:18px;">
             <span class="q-src">◎ Source: ${esc(q.source||'—')}</span>
           </div>
         </div>
         <div class="ps-bottom">
           <div class="ps-nav">${navDots}</div>
           <div class="flex gap8 wrap">
             <button class="btn sm ghost" data-act="ps-prev">← Prev</button>
             <button class="btn sm ghost" data-act="ps-mark">${s.marked[q.id]?'✓ Marked':'Mark for Review'}</button>
             ${!isRevealed? `<button class="btn sm" data-act="ps-reveal">Reveal Answer</button>`:''}
             <button class="btn sm" data-act="ps-next">Next →</button>
             <button class="btn primary sm" data-act="ps-submit">Submit Session</button>
           </div>
         </div>
       `;
   
       this.renderTimerOnly();
     },
   
     chooseOption(opt){
       const s=this.session; if(!s) return;
       const q=s.questions[s.current];
       if(s.revealed[q.id]) return;
       s.answers[q.id]=opt;
       this.renderSession();
     },
     saveTextAnswer(){
       const s=this.session; if(!s) return;
       const q=s.questions[s.current];
       const v=($('#psAnswer')||{}).value||'';
       s.answers[q.id]=v;
       toast('Answer saved');
     },
     reveal(){
       const s=this.session; if(!s) return;
       const q=s.questions[s.current];
       if(!q.options){
         const v=($('#psAnswer')||{}).value;
         if(v!==undefined) s.answers[q.id]=v;
       }
       s.revealed[q.id]=true;
       this.stopTimer();
       this.renderSession();
     },
     mark(){
       const s=this.session; if(!s) return;
       const q=s.questions[s.current];
       s.marked[q.id]=!s.marked[q.id];
       this.renderSession();
     },
     jump(i){
       const s=this.session; if(!s) return;
       s.current=clamp(i,0,s.questions.length-1);
       this.renderSession();
       this.startTimer();
     },
     next(){
       const s=this.session; if(!s) return;
       if(s.current<s.questions.length-1){ s.current++; this.renderSession(); this.startTimer(); }
     },
     prev(){
       const s=this.session; if(!s) return;
       if(s.current>0){ s.current--; this.renderSession(); this.startTimer(); }
     },
   
     submit(){
       const s=this.session; if(!s) return;
       this.stopTimer();
   
       // Score
       let correct=0, incorrect=0, skipped=0;
       const detail=[];
       s.questions.forEach(q=>{
         const ans=s.answers[q.id];
         const isCorrect = ans && String(ans).trim().toLowerCase()===String(q.answer).trim().toLowerCase();
         if(!ans || String(ans).trim()===''){ skipped++; }
         else if(isCorrect) correct++;
         else incorrect++;
         detail.push({qid:q.id, ans:ans||'', correct:isCorrect, topic:q.topic||'', chapter:q.chapter, subject:q.subject});
       });
   
       const attempted=correct+incorrect;
       const accuracy = attempted? Math.round(correct/attempted*100) : 0;
       const timeTotal = Object.values(s.times).reduce((a,b)=>a+b,0);
       const avgTime = s.questions.length? Math.round(timeTotal/s.questions.length) : 0;
   
       const session={
         id:s.id,
         mode:s.mode,
         config:s.config,
         questionIds:s.questions.map(q=>q.id),
         answers:s.answers,
         times:s.times,
         startedAt:s.startedAt,
         finishedAt:new Date().toISOString(),
         correct, incorrect, skipped, attempted, accuracy, avgTime,
         detail
       };
       DB.practiceSessions.push(session);
   
       // Contribute actual time to chapter/task if linked
       if(s.chapterId && timeTotal>0){
         const mins=Math.max(1, Math.round(timeTotal/60));
         logChapterSession(s.chapterId, mins, {note:'Practice session'});
       }
   
       saveDB();
       this.renderResults(session);
     },
   
     renderResults(session){
       const s=this.session;
       const total=s.questions.length;
   
       $('#practiceSession').innerHTML=`
         <div class="ps-top">
           <div>
             <div class="ps-title">PRACTICE RESULTS</div>
             <div class="ps-sub">${esc(session.config.subject||'')} · ${esc(session.config.chapter||'')}</div>
           </div>
           <div class="flex gap8">
             <button class="btn primary" data-act="ps-finish">Done</button>
           </div>
         </div>
         <div class="ps-body">
           <div class="result-hero">
             <div class="big">${session.accuracy}%</div>
             <div class="lbl">Accuracy</div>
           </div>
   
           <div class="grid g4" style="margin-bottom:20px;">
             <div class="stat"><div class="lbl">Questions</div><div class="val">${total}</div></div>
             <div class="stat"><div class="lbl">Attempted</div><div class="val" style="color:var(--info)">${session.attempted}</div></div>
             <div class="stat"><div class="lbl">Correct</div><div class="val" style="color:var(--good)">${session.correct}</div></div>
             <div class="stat"><div class="lbl">Incorrect</div><div class="val" style="color:var(--bad)">${session.incorrect}</div></div>
             <div class="stat"><div class="lbl">Skipped</div><div class="val" style="color:var(--muted)">${session.skipped}</div></div>
             <div class="stat"><div class="lbl">Avg Time</div><div class="val" style="font-size:20px">${pad(Math.floor(session.avgTime/60))}:${pad(session.avgTime%60)}</div></div>
             <div class="stat"><div class="lbl">Total Time</div><div class="val" style="font-size:20px">${pad(Math.floor(Object.values(session.times).reduce((a,b)=>a+b,0)/60))}:${pad(Object.values(session.times).reduce((a,b)=>a+b,0)%60)}</div></div>
             <div class="stat"><div class="lbl">Marks Scored</div><div class="val">${session.detail.reduce((a,d)=>{const q=DB.questions.find(x=>x.id===d.qid);return a+(d.correct&&q?q.marks:0);},0)}</div></div>
           </div>
   
           <div class="section-head"><div class="section-title">Question-wise Review</div></div>
           ${s.questions.map((q,i)=>{
             const d=session.detail[i];
             const bg = d.correct? 'rgba(127,224,160,.06)' : (d.ans? 'rgba(224,122,106,.06)' : 'rgba(0,0,0,.3)');
             const border = d.correct? 'rgba(127,224,160,.3)' : (d.ans? 'rgba(224,122,106,.3)' : 'var(--line)');
             return `<div class="q-card" style="background:${bg};border-color:${border};">
               <div class="flex between center gap8 wrap">
                 <div style="font-size:10.5px;letter-spacing:.2em;color:var(--gold);font-weight:800;">Q${i+1} · ${esc(q.questionType)} · ${q.marks} mark${q.marks>1?'s':''}</div>
                 <div class="flex gap8">
                   <span class="tag ${d.correct?'good':'bad'}">${d.correct?'CORRECT':(d.ans?'INCORRECT':'SKIPPED')}</span>
                   <span class="tag">${session.times[q.id]||0}s</span>
                 </div>
               </div>
               <div class="q-title" style="margin-top:10px;">${esc(q.questionText)}</div>
               <div class="q-meta">
                 <span>Your answer: <b style="color:${d.correct?'var(--good)':'var(--bad)'}">${esc(d.ans||'—')}</b></span>
                 <span>Correct: <b style="color:var(--good)">${esc(q.answer)}</b></span>
                 <span class="q-src">${esc(q.source)}</span>
               </div>
             </div>`;
           }).join('')}
   
           <div class="section-head"><div class="section-title">Weak Topics Detected</div></div>
           ${this.detectWeakTopics(session.detail).map(w=>`
             <div class="q-card">
               <div class="flex between center gap8">
                 <div style="font-size:12.5px;">${esc(w.topic||w.chapter)}</div>
                 <span class="tag bad">${w.wrong} incorrect</span>
               </div>
               <div class="small muted mt8">Suggested: practice more PYQs on this topic.</div>
             </div>
           `).join('') || `<div class="empty">No clear weak area detected — insufficient data or all correct.</div>`}
         </div>
       `;
     },
   
     detectWeakTopics(detail){
       const map={};
       detail.forEach(d=>{
         if(!d.correct && d.ans){
           const key=(d.topic||d.chapter||'').trim();
           if(!key) return;
           map[key]=map[key]||{topic:key, chapter:d.chapter, wrong:0};
           map[key].wrong++;
         }
       });
       return Object.values(map).filter(x=>x.wrong>=1).sort((a,b)=>b.wrong-a.wrong);
     },
   
     finish(){
       this.session=null;
       this.stopTimer();
       $('#practiceSession').classList.remove('show');
       render();
     },
   
     exitConfirm(){
       if(!this.session) { this.finish(); return; }
       if(confirm('Exit practice session? Progress for this session will not be saved to results.')){
         this.session=null; this.stopTimer();
         $('#practiceSession').classList.remove('show');
       }
     }
   };
   
   /* ------------------------------------------------------------
      15. NAVIGATION
      ------------------------------------------------------------ */
   const NAV=[
     ['dashboard','Dashboard','◈'],
     ['today','Today','▤'],
     ['tasks','Tasks','✓'],
     ['exams','Exams','✦'],
     ['study','Study','◎'],
     ['practice','Practice','✎'],
     ['calendar','Calendar','▦'],
     ['projects','Projects','▣'],
     ['files','Files','▥'],
     ['habits','Habits','◍'],
     ['analytics','Analytics','◐'],
     ['settings','Settings','⚙'],
   ];
   let VIEW='dashboard';
   let STUDY_OPEN={};
   let PRACTICE_TAB='now';
   let PRACTICE_FILTER={exam:'',subject:'',chapter:''};
   
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
      16. VIEWS
      ------------------------------------------------------------ */
   const CAT_COLOR={ACADEMICS:'gold', FILES:'info', SKILLS:'violet', HEALTH:'good', PROJECT:'violet', PERSONAL:'', RECREATION:'warn', OTHER:''};
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
         <button class="btn ghost" data-act="open-assistant">✦ Tell the Assistant</button>
       </div>
     </div>
   
     <!-- Assistant command bar -->
     <div class="assistant-bar">
       <span class="ab-icon">✦</span>
       <input id="assistantInput" placeholder="Tell the assistant — e.g. &quot;Add 30 min of English&quot;, &quot;What should I do now?&quot;, &quot;I finished Physics&quot;" autocomplete="off" />
       <button class="btn primary" data-act="assistant-execute">Execute</button>
       <button class="btn ghost sm" data-act="assistant-clear">Clear</button>
     </div>
     <div class="assistant-hint">Try: Add 30 minutes of English · Start 45 min Physics · Move Chemistry to tomorrow · What should I do now?</div>
     ${Assistant.history.length? `<div class="assistant-history">
       ${Assistant.history.slice(0,3).map(h=>`<div class="ah-item">
         <span class="ah-time">${new Date(h.at).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</span>
         <span class="ah-text">${esc(h.input)}</span>
         <span class="ah-res">→ ${esc(h.result)}</span>
       </div>`).join('')}
     </div>`:''}
   
     <div class="grid g2" style="margin-top:16px;margin-bottom:16px;">
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
             <span>Remaining ${fmtDur(remainingMinutesFor(curTask))}</span>
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
           <div class="small muted">Nothing active. Next up at <span class="mono" style="color:var(--gold-2)">${m2t(nb.start)}</span></div>
           <div style="font-size:15px;font-weight:700;color:var(--gold-2);margin-top:9px;">${esc(nbTask.title)}</div>
           <div class="t-meta mt8">
             ${catTag(nbTask.category)}
             <span class="pri ${levelOfTask(nbTask.id)}">${levelOfTask(nbTask.id)}</span>
             <span>${fmtDur(remainingMinutesFor(nbTask))} remaining</span>
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
               <div class="small muted" style="margin-top:3px;">${esc(r.task.subject||r.task.category)} · remaining ${fmtDur(remainingMinutesFor(r.task))}${r.task.deadline?' · due '+fmtDate(r.task.deadline).slice(0,12):''}</div>
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
     const typeLabel={school:'SCHOOL',coaching:'COACHING',meal:'MEAL',routine:'ROUTINE',break:'BREAK',task:'TASK',custom:'CUSTOM'};
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
   
     const recent=DB.rescheduleHistory.slice(-3).reverse();
   
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
   
     <div class="card" style="margin-bottom:16px;">
       <div class="card-title">Full Day Timeline</div>
       ${timelineHTML(sch.blocks)}
     </div>
   
     ${recent.length?`
     <div class="section-head"><div class="section-title">Recent Reschedules</div></div>
     <div class="card">
       ${recent.map(h=>`<div class="flex between center" style="padding:9px 0;border-bottom:1px solid rgba(212,175,55,.08);">
         <div style="font-size:11.5px;color:var(--text);">${esc(h.reason)}</div>
         <div class="small muted">${new Date(h.at).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</div>
       </div>`).join('')}
     </div>`:''}
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
     const rem=remainingMinutesFor(t);
     const pct=Math.min(100, Math.round(((t.actualMinutes||0)/(t.estimatedMinutes||1))*100));
   
     return `
     <div class="task ${done?'done':''}">
       <div class="chk" data-act="toggle-task" data-id="${t.id}">${done?'✓':''}</div>
       <div style="flex:1;min-width:0;">
         <div class="t-name">${esc(t.title)}</div>
         <div class="t-meta">
           <span class="pri ${level||'P4'}">${level||'P4'}</span>
           ${catTag(t.category)}
           ${t.subject?`<span>${esc(t.subject)}</span>`:''}
           <span>Est ${fmtDur(t.estimatedMinutes)}</span>
           ${t.actualMinutes?`<span style="color:var(--good)">Actual ${fmtDur(t.actualMinutes)}</span>`:''}
           ${!done && rem<t.estimatedMinutes?`<span style="color:var(--warn)">Remaining ${fmtDur(rem)}</span>`:''}
           ${t.deadline?`<span>due ${fmtDate(t.deadline)}</span>`:''}
           ${subTotal?`<span>${subDone}/${subTotal} steps</span>`:''}
           ${linked?`<span class="tag violet">◎ ${esc(linked.chapter.name.slice(0,18))}</span>`:''}
           <span class="tag">${esc(t.status)}</span>
         </div>
         ${t.actualMinutes>0 && !done? `<div class="bar" style="max-width:280px;"><i style="width:${pct}%"></i></div>`:''}
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
   
   /* ---------- STUDY ---------- */
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
   
   /* ---------- PRACTICE ---------- */
   function viewPractice(){
     const sessions=DB.practiceSessions.slice().reverse();
     const questions=DB.questions;
     const totalSessions=sessions.length;
     const avgAcc = totalSessions? Math.round(sessions.reduce((a,s)=>a+s.accuracy,0)/totalSessions) : 0;
     const totalQs = sessions.reduce((a,s)=>a+s.questionIds.length,0);
   
     const subs=[...new Set(questions.map(q=>q.subject))];
     const chapters=questions.map(q=>q.chapter).filter((v,i,a)=>a.indexOf(v)===i);
     const exams=[...new Set(questions.map(q=>q.exam))];
   
     return `
     <div class="section-head">
       <div class="section-title">Question Practice & PYQ Engine</div>
       <div class="flex gap8 wrap">
         <button class="btn primary" data-act="practice-new">⚡ Practice Now</button>
         <button class="btn" data-act="practice-import-pdf">⇣ Import PDF</button>
         <button class="btn ghost" data-act="practice-add-question">+ Add Question</button>
       </div>
     </div>
   
     <div class="grid g4" style="margin-bottom:18px;">
       <div class="stat"><div class="lbl">Questions in Bank</div><div class="val">${questions.length}</div><div class="sub">available to practice</div></div>
       <div class="stat"><div class="lbl">Sessions Completed</div><div class="val">${totalSessions}</div><div class="sub">all-time</div></div>
       <div class="stat"><div class="lbl">Avg Accuracy</div><div class="val">${avgAcc}%</div><div class="sub">across sessions</div></div>
       <div class="stat"><div class="lbl">Questions Attempted</div><div class="val">${totalQs}</div><div class="sub">total</div></div>
     </div>
   
     <div class="practice-tabs">
       ${['now','chapter','papers','sets','results','bank'].map(t=>`
         <button class="ptab ${PRACTICE_TAB===t?'active':''}" data-act="practice-tab" data-id="${t}">
           ${({now:'Practice Now',chapter:'Chapter PYQs',papers:'Full Papers',sets:'My Sets',results:'Results & Analysis',bank:'Question Bank'})[t]}
         </button>
       `).join('')}
     </div>
   
     ${PRACTICE_TAB==='now'? renderPracticeNow(subs,chapters,exams) : ''}
     ${PRACTICE_TAB==='chapter'? renderChapterPicker(subs,chapters) : ''}
     ${PRACTICE_TAB==='papers'? renderPapers(exams) : ''}
     ${PRACTICE_TAB==='sets'? renderMySets(sessions) : ''}
     ${PRACTICE_TAB==='results'? renderResults(sessions) : ''}
     ${PRACTICE_TAB==='bank'? renderBank(questions) : ''}
     `;
   }
   
   function renderPracticeNow(subs,chapters,exams){
     return `
     <div class="card">
       <div class="card-title">Custom Practice Configuration</div>
       <div class="row">
         <div class="field"><label>Exam</label>
           <select id="p-exam"><option value="">Any</option>${exams.map(e=>`<option>${esc(e)}</option>`).join('')}</select>
         </div>
         <div class="field"><label>Subject</label>
           <select id="p-subject"><option value="">Any</option>${subs.map(s=>`<option>${esc(s)}</option>`).join('')}</select>
         </div>
       </div>
       <div class="row">
         <div class="field"><label>Chapter</label>
           <select id="p-chapter"><option value="">Any</option>${chapters.map(c=>`<option>${esc(c)}</option>`).join('')}</select>
         </div>
         <div class="field"><label>Number of Questions</label>
           <input id="p-count" type="number" value="10" min="1" max="50" />
         </div>
       </div>
       <div class="row">
         <div class="field"><label>Timer Mode</label>
           <select id="p-timer">
             <option value="per-question">Per-question (90s default)</option>
             <option value="full">Full session timer</option>
             <option value="none">No timer</option>
           </select>
         </div>
         <div class="field"><label>Per-question seconds (if applicable)</label>
           <input id="p-pqsec" type="number" value="${DB.settings.practicePerQuestionSec||90}" min="30" />
         </div>
       </div>
       <div class="flex gap8 mt16">
         <button class="btn primary" data-act="practice-start-custom">▶ Start Practice</button>
       </div>
     </div>`;
   }
   
   function renderChapterPicker(subs,chapters){
     const bySubject={};
     DB.questions.forEach(q=>{ (bySubject[q.subject]=bySubject[q.subject]||new Set()).add(q.chapter); });
     return `
     <div class="grid g2">
       ${Object.keys(bySubject).map(s=>`
         <div class="card">
           <div class="card-title">${esc(s)}</div>
           ${[...bySubject[s]].map(c=>{
             const count=DB.questions.filter(q=>q.subject===s && q.chapter===c).length;
             return `<div class="flex between center" style="padding:9px 0;border-bottom:1px solid rgba(212,175,55,.08);">
               <div style="font-size:12px;flex:1;">${esc(c)}</div>
               <span class="tag">${count} Q${count===1?'':'s'}</span>
               <button class="btn sm primary" data-act="practice-chapter" data-id="${esc(s)}||${esc(c)}" style="margin-left:10px;">▶ Practice</button>
             </div>`;
           }).join('')}
         </div>
       `).join('') || `<div class="empty">No questions in the bank yet. Add some or import a PDF.</div>`}
     </div>`;
   }
   
   function renderPapers(exams){
     const papers={};
     DB.questions.forEach(q=>{
       if(!q.year) return;
       const key=q.exam+'||'+q.subject+'||'+q.year;
       if(!papers[key]) papers[key]={exam:q.exam,subject:q.subject,year:q.year,count:0};
       papers[key].count++;
     });
     const list=Object.values(papers);
     return `
     <div class="grid g2">
       ${list.length? list.map(p=>`
         <div class="card">
           <div class="flex between center">
             <div>
               <div style="font-size:15px;font-weight:800;color:var(--gold-2);">${esc(p.exam)} ${esc(p.subject)}</div>
               <div class="small muted mt8">Year ${p.year} · ${p.count} questions available</div>
             </div>
             <button class="btn sm primary" data-act="practice-paper" data-id="${esc(p.exam)}||${esc(p.subject)}||${p.year}">▶ Practice</button>
           </div>
         </div>
       `).join('') : `<div class="empty">No full papers available yet. Import or add questions with year metadata.</div>`}
     </div>`;
   }
   
   function renderMySets(sessions){
     return `
     <div class="grid g2">
       ${sessions.length? sessions.map(s=>{
         const d=new Date(s.startedAt);
         return `<div class="card">
           <div class="flex between center wrap gap8">
             <div>
               <div style="font-size:13px;font-weight:700;color:var(--gold-2);">${esc(s.config.subject||'—')} · ${esc(s.config.chapter||'General')}</div>
               <div class="small muted mt8">${d.toLocaleDateString('en-GB',{day:'numeric',month:'short'})} · ${s.questionIds.length} Qs · ${s.accuracy}% accuracy</div>
             </div>
             <span class="tag ${s.accuracy>=70?'good':s.accuracy>=50?'warn':'bad'}">${s.accuracy}%</span>
           </div>
         </div>`;
       }).join('') : `<div class="empty">No practice sessions yet.</div>`}
     </div>`;
   }
   
   function renderResults(sessions){
     if(!sessions.length) return `<div class="empty">No practice history yet.</div>`;
     // Weak topic aggregation
     const topicMap={};
     sessions.forEach(s=>{
       s.detail.forEach(d=>{
         if(!d.correct && d.ans){
           const key=d.topic||d.chapter||'';
           if(!key) return;
           topicMap[key]=topicMap[key]||{topic:key, chapter:d.chapter, wrong:0, total:0};
           topicMap[key].wrong++;
         }
         const key=d.topic||d.chapter||'';
         if(key){
           topicMap[key]=topicMap[key]||{topic:key, chapter:d.chapter, wrong:0, total:0};
           topicMap[key].total++;
         }
       });
     });
     const weak=Object.values(topicMap).filter(t=>t.wrong>=2).sort((a,b)=>b.wrong-a.wrong);
   
     return `
     <div class="card" style="margin-bottom:18px;">
       <div class="card-title">Weak Topic Analysis</div>
       ${weak.length? weak.map(w=>{
         const rate=Math.round(w.wrong/Math.max(1,w.total)*100);
         return `<div style="padding:10px 0;border-bottom:1px solid rgba(212,175,55,.08);">
           <div class="flex between center">
             <div style="font-size:12.5px;">${esc(w.topic)}</div>
             <span class="tag bad">${w.wrong} / ${w.total} wrong</span>
           </div>
           <div class="small muted mt8">Error rate: ${rate}% · Suggested: practice 5 more PYQs on this topic.</div>
         </div>`;
       }).join('') : `<div class="empty">No clear weak area detected — insufficient data or consistently strong.</div>`}
     </div>
   
     <div class="card">
       <div class="card-title">Session History</div>
       ${sessions.map(s=>{
         const d=new Date(s.startedAt);
         return `<div class="flex between center" style="padding:9px 0;border-bottom:1px solid rgba(212,175,55,.08);">
           <div style="flex:1;">
             <div style="font-size:12px;">${esc(s.config.subject||'—')} · ${esc(s.config.chapter||'General')}</div>
             <div class="small muted">${d.toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
           </div>
           <div class="flex gap8">
             <span class="tag good">${s.correct}✓</span>
             <span class="tag bad">${s.incorrect}✗</span>
             <span class="tag">${s.skipped}—</span>
             <span class="tag gold">${s.accuracy}%</span>
           </div>
         </div>`;
       }).join('')}
     </div>`;
   }
   
   function renderBank(questions){
     return `
     <div class="card">
       <div class="card-title">Question Bank · ${questions.length} questions</div>
       ${questions.length? questions.slice(0,50).map(q=>`
         <div class="q-card">
           <div class="flex between center gap8 wrap">
             <span class="tag gold">${esc(q.exam)} ${q.year||''}</span>
             <span class="tag">${esc(q.subject)} · ${esc(q.chapter)}</span>
             <span class="tag">${esc(q.questionType)}</span>
             <span class="tag">${q.marks}M</span>
           </div>
           <div class="q-title" style="margin-top:10px;">${esc(q.questionText.slice(0,180))}${q.questionText.length>180?'…':''}</div>
           <div class="q-meta"><span class="q-src">◎ ${esc(q.source||'—')}</span></div>
           <div class="flex gap8 mt8">
             <button class="btn sm danger" data-act="practice-del-q" data-id="${q.id}">Delete</button>
           </div>
         </div>
       `).join('') : `<div class="empty">No questions yet. Add via "Add Question" or "Import PDF".</div>`}
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
       <div class="small muted">Changes save automatically as you type.</div></div>
   
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
                     : `<b>BROWSER UNSUPPORTED</b> · use Export JSON.`)}
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
         <div class="row">
           <div class="field"><label>Practice Timer Default</label>
             <select id="set-ptimer">
               <option value="per-question" ${s.practiceTimerDefault==='per-question'?'selected':''}>Per-question</option>
               <option value="full" ${s.practiceTimerDefault==='full'?'selected':''}>Full paper</option>
               <option value="none" ${s.practiceTimerDefault==='none'?'selected':''}>No timer</option>
             </select>
           </div>
           <div class="field"><label>Per-question seconds</label><input id="set-pqsec" type="number" value="${s.practicePerQuestionSec||90}" /></div>
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
     </div>
     `;
   }
   
   /* ------------------------------------------------------------
      17. RENDER (with scroll restore)
      ------------------------------------------------------------ */
   function render(opts){
     opts=opts||{};
     const view=$('#view'); if(!view) return;
     const prevScroll=view.scrollTop;
     renderNav();
     renderExamPill();
     const map={
       dashboard:viewDashboard, today:viewToday, tasks:viewTasks,
       exams:viewExams, study:viewStudy, practice:viewPractice,
       calendar:viewCalendar, projects:viewProjects, files:viewFiles,
       habits:viewHabits, analytics:viewAnalytics, settings:viewSettings
     };
     view.dataset.view=VIEW;
     view.innerHTML=(map[VIEW]||viewDashboard)();
     view.scrollTop = opts.resetScroll ? 0 : prevScroll;
   }
   
   /* ------------------------------------------------------------
      18. MODALS
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
       <h3>${task?'Edit Task':'New Task'}<button class="btn ghost sm" data-act="close-modal">✕</button></h3>
       <div class="field"><label>Title</label><input id="m-title" value="${esc(t.title)}" /></div>
       <div class="field"><label>Objective (clear definition of DONE)</label><textarea id="m-objective">${esc(t.objective||'')}</textarea></div>
       <div class="row">
         <div class="field"><label>Category</label>
           <select id="m-category">
             ${['ACADEMICS','FILES','SKILLS','HEALTH','PROJECT','PERSONAL','RECREATION','OTHER'].map(c=>`<option ${t.category===c?'selected':''}>${c}</option>`).join('')}
           </select>
         </div>
         <div class="field"><label>Subject</label><input id="m-subject" value="${esc(t.subject)}" /></div>
       </div>
       <div class="row">
         <div class="field"><label>Priority</label>
           <select id="m-priority">${[1,2,3,4].map(p=>`<option value="${p}" ${t.priority===p?'selected':''}>P${p}</option>`).join('')}</select>
         </div>
         <div class="field"><label>Estimated Minutes</label><input id="m-est" type="number" value="${t.estimatedMinutes}" /></div>
       </div>
       <div class="field"><label>Deadline</label><input id="m-deadline" type="date" value="${t.deadline}" /></div>
       <div class="field">
         <label>Linked Study Chapter (optional)</label>
         <select id="m-chapter"><option value="">— none —</option>${chapterOptions}</select>
         <div class="small muted mt8">Focus time from this task auto-lands in that chapter's total.</div>
       </div>
       <div class="field"><label>Notes</label><textarea id="m-notes">${esc(t.notes||'')}</textarea></div>
       <div class="modal-foot">
         <button class="btn ghost" data-act="close-modal">Cancel</button>
         <button class="btn primary" data-act="save-task" data-id="${task?task.id:''}">${task?'Save':'Create'}</button>
       </div>
     `);
   }
   
   function modalWhatNow(){
     const ranked=rankedTasks();
     if(!ranked.length){ openModal(`<h3>What Should I Do Now? <button class="btn ghost sm" data-act="close-modal">✕</button></h3><div class="empty">No open tasks. Enjoy a real break.</div>`); return; }
     const r=ranked[0], t=r.task;
     const nx=nearestExam(t.subject);
     const reason = nx? `${nx.subject} exam in ${daysBetween(todayStr(),nx.date)} days.` : `Highest-priority open item.`;
     const linked = t.chapterId? findChapterRef(t.chapterId) : null;
     const rem = remainingMinutesFor(t);
     openModal(`
       <h3>Do This Now <button class="btn ghost sm" data-act="close-modal">✕</button></h3>
       <div style="font-size:19px;font-weight:800;color:var(--gold-2);line-height:1.35;">${esc(t.title)}</div>
       <div class="t-meta mt8">
         <span class="pri ${r.level}">${r.level}</span>
         ${catTag(t.category)}
         <span>${esc(t.subject||'')}</span>
         <span>Remaining: ${fmtDur(rem)}</span>
         ${t.actualMinutes?`<span>Actual: ${fmtDur(t.actualMinutes)}</span>`:''}
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
       <div class="small muted" style="margin-bottom:12px;">Not a failure — the remaining day gets rebuilt. How many minutes were lost?</div>
       <div class="flex gap8 wrap" style="margin-bottom:14px;">
         ${[15,30,45,60,90,120].map(m=>`<button class="btn sm" data-act="wasted-amt" data-id="${m}">${m}m</button>`).join('')}
       </div>
       <div class="field"><label>Custom (minutes)</label><input id="m-wasted" type="number" value="45" /></div>
       <div class="field"><label>Reason (optional)</label><input id="m-wasted-reason" placeholder="e.g. unexpected guests" /></div>
       <div class="modal-foot">
         <button class="btn ghost" data-act="close-modal">Cancel</button>
         <button class="btn primary" data-act="apply-wasted">⟳ Rebuild Remaining Day</button>
       </div>
     `);
   }
   
   function modalDiff(){
     if(!_bannerDiff) return;
     const {reason, before, after}=_bannerDiff;
     openModal(`
       <h3>Schedule Changes <button class="btn ghost sm" data-act="close-modal">✕</button></h3>
       <div class="small muted" style="margin-bottom:12px;">${esc(reason)}</div>
       <div class="diff-grid">
         <div class="diff-col before">
           <h4>Before</h4>
           ${before.length? before.map(b=>`<div class="diff-row"><span class="mono">${m2t(b.start)}–${m2t(b.end)}</span> ${esc(b.title)}</div>`).join('') : `<div class="empty">—</div>`}
         </div>
         <div class="diff-col after">
           <h4>After</h4>
           ${after.length? after.map(b=>`<div class="diff-row"><span class="mono">${m2t(b.start)}–${m2t(b.end)}</span> ${esc(b.title)}</div>`).join('') : `<div class="empty">—</div>`}
         </div>
       </div>
       <div class="modal-foot"><button class="btn primary" data-act="close-modal">OK</button></div>
     `);
   }
   
   function modalNewExam(prefilledDate){
     openModal(`
       <h3>New Exam <button class="btn ghost sm" data-act="close-modal">✕</button></h3>
       <div class="row">
         <div class="field"><label>Subject</label><input id="ex-subject" /></div>
         <div class="field"><label>Importance</label><select id="ex-imp"><option>HIGH</option><option>MEDIUM</option><option>LOW</option></select></div>
       </div>
       <div class="field"><label>Title</label><input id="ex-title" /></div>
       <div class="row">
         <div class="field"><label>Date</label><input id="ex-date" type="date" value="${prefilledDate||todayStr()}" /></div>
         <div class="field"><label>Start Time</label><input id="ex-start" type="time" value="09:00" /></div>
       </div>
       <div class="field"><label>End Time</label><input id="ex-end" type="time" value="12:00" /></div>
       <div class="field"><label>Chapters (one per line)</label><textarea id="ex-chapters"></textarea></div>
       <div class="modal-foot">
         <button class="btn ghost" data-act="close-modal">Cancel</button>
         <button class="btn primary" data-act="save-exam">Create</button>
       </div>
     `);
   }
   
   function modalChapterLog(chapterId){
     const ref=findChapterRef(chapterId); if(!ref) return;
     openModal(`
       <h3>Log Study Time <button class="btn ghost sm" data-act="close-modal">✕</button></h3>
       <div style="font-size:12px;color:var(--gold-2);font-weight:700;">${esc(ref.subject.name)} — ${esc(ref.chapter.name)}</div>
       <div class="small muted mt8" style="margin-bottom:16px;">Current total: ${fmtDur(ref.chapter.totalMinutes||0)}</div>
       <div class="quick-log-btns" style="margin-bottom:14px;">
         ${[10,15,25,40,60,90].map(m=>`<button class="btn sm" data-act="ql-amt" data-id="${m}">${m}m</button>`).join('')}
       </div>
       <div class="field"><label>Custom (minutes)</label><input id="ql-min" type="number" value="30" /></div>
       <div class="field"><label>Note (optional)</label><input id="ql-note" /></div>
       <div class="modal-foot">
         <button class="btn ghost" data-act="close-modal">Cancel</button>
         <button class="btn primary" data-act="ql-save" data-id="${chapterId}">Log</button>
       </div>
     `);
   }
   
   function modalChapterHistory(chapterId){
     const ref=findChapterRef(chapterId); if(!ref) return;
     const s=[...(ref.chapter.sessions||[])].reverse();
     openModal(`
       <h3>Session History <button class="btn ghost sm" data-act="close-modal">✕</button></h3>
       <div style="font-size:12px;color:var(--gold-2);font-weight:700;">${esc(ref.subject.name)} — ${esc(ref.chapter.name)}</div>
       <div class="small muted mt8" style="margin-bottom:16px;">${s.length} session(s) · total ${fmtDur(ref.chapter.totalMinutes||0)}</div>
       <div class="chapter-session-list">
         ${s.length? s.map(x=>`
           <div class="sess">
             <span class="mono" style="color:var(--gold-2);min-width:70px;">${new Date(x.start).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}</span>
             <span class="mono" style="min-width:50px;">${new Date(x.start).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</span>
             <span class="mono" style="color:var(--good);min-width:50px;">${x.minutes}m</span>
             <span style="flex:1;">${esc(x.note||'')}</span>
           </div>`).join('') : `<div class="empty">No sessions yet</div>`}
       </div>
       <div class="modal-foot">
         <button class="btn ghost" data-act="close-modal">Close</button>
         <button class="btn primary" data-act="chapter-start" data-id="${chapterId}">▶ Start Session</button>
       </div>
     `);
   }
   
   function modalAddQuestion(){
     openModal(`
       <h3>Add Question <button class="btn ghost sm" data-act="close-modal">✕</button></h3>
       <div class="row">
         <div class="field"><label>Exam</label><input id="q-exam" value="CBSE" /></div>
         <div class="field"><label>Year</label><input id="q-year" type="number" value="${new Date().getFullYear()}" /></div>
       </div>
       <div class="row">
         <div class="field"><label>Subject</label><input id="q-subject" value="Physics" /></div>
         <div class="field"><label>Chapter</label><input id="q-chapter" /></div>
       </div>
       <div class="row">
         <div class="field"><label>Topic</label><input id="q-topic" /></div>
         <div class="field"><label>Question Type</label>
           <select id="q-type">
             <option>MCQ</option><option>Numerical</option><option>Short</option><option>Long</option>
             <option>Assertion-Reason</option><option>Case-based</option><option>Derivation</option>
           </select>
         </div>
       </div>
       <div class="row">
         <div class="field"><label>Marks</label><input id="q-marks" type="number" value="1" /></div>
         <div class="field"><label>Difficulty</label>
           <select id="q-diff"><option>EASY</option><option selected>MEDIUM</option><option>HARD</option></select>
         </div>
       </div>
       <div class="field"><label>Question Text</label><textarea id="q-text" style="min-height:100px;"></textarea></div>
       <div class="field"><label>Options (comma separated — leave empty for subjective)</label><input id="q-options" placeholder="Option A, Option B, ..." /></div>
       <div class="field"><label>Correct Answer</label><input id="q-answer" /></div>
       <div class="field"><label>Solution</label><textarea id="q-solution"></textarea></div>
       <div class="field"><label>Recommended Time (seconds)</label><input id="q-rtime" type="number" value="90" /></div>
       <div class="field"><label>Source (e.g. "CBSE 2024 Physics")</label><input id="q-source" /></div>
       <div class="modal-foot">
         <button class="btn ghost" data-act="close-modal">Cancel</button>
         <button class="btn primary" data-act="save-question">Save Question</button>
       </div>
     `);
   }
   
   /* ------------------------------------------------------------
      19. DRAWER
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
           <span class="small muted">${fmtDur(remainingMinutesFor(t))}</span>
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
      20. ASSISTANT EXECUTION (from UI)
      ------------------------------------------------------------ */
   async function runAssistant(input){
     const val=String(input||'').trim();
     if(!val) return;
     const result=await Assistant.executeText(val);
     toast(result.message);
     if(result.needsConfirm) return;
     // Refresh view
     render();
   }
   
   /* ------------------------------------------------------------
      21. EVENT DELEGATION
      ------------------------------------------------------------ */
   document.addEventListener('click', e=>{
     const el=e.target.closest('[data-act]');
     if(!el) return;
     const act=el.dataset.act;
     const id=el.dataset.id;
   
     if(act==='nav'){ VIEW=id; render({resetScroll:true}); $('.sidebar').classList.remove('open'); return; }
     if(act==='close-modal'){ closeModal(); return; }
     if(act==='close-drawer'){ closeDrawer(); return; }
     if(act==='filter'){ TASK_FILTER=id; render(); return; }
   
     /* ---------- Assistant ---------- */
     if(act==='open-assistant'){
       VIEW='dashboard'; render({resetScroll:true});
       setTimeout(()=>{ const i=$('#assistantInput'); if(i) i.focus(); }, 100);
       return;
     }
     if(act==='assistant-execute'){
       const i=$('#assistantInput'); if(!i) return;
       runAssistant(i.value); i.value='';
       return;
     }
     if(act==='assistant-clear'){
       Assistant.history=[]; render(); toast('History cleared'); return;
     }
   
     /* ---------- Schedule banner ---------- */
     if(act==='dismiss-banner'){ $('#schedBanner').classList.remove('show'); return; }
     if(act==='view-diff'){ modalDiff(); return; }
   
     /* ---------- Practice ---------- */
     if(act==='practice-tab'){ PRACTICE_TAB=id; render(); return; }
     if(act==='practice-new'){ PRACTICE_TAB='now'; VIEW='practice'; render({resetScroll:true}); return; }
     if(act==='practice-add-question'){ modalAddQuestion(); return; }
     if(act==='practice-import-pdf'){ modalPdfImport(); return; }
     if(act==='save-question'){
       const optsStr=$('#q-options').value.trim();
       const options=optsStr? optsStr.split(',').map(s=>s.trim()).filter(Boolean) : null;
       const q={
         id:uid(),
         exam:$('#q-exam').value.trim()||'Custom',
         year:Number($('#q-year').value)||null,
         subject:$('#q-subject').value.trim(),
         chapter:$('#q-chapter').value.trim(),
         topic:$('#q-topic').value.trim(),
         questionType:$('#q-type').value,
         marks:Number($('#q-marks').value)||1,
         difficulty:$('#q-diff').value,
         questionText:$('#q-text').value.trim(),
         options,
         answer:$('#q-answer').value.trim(),
         solution:$('#q-solution').value.trim(),
         recommendedTime:Number($('#q-rtime').value)||90,
         source:$('#q-source').value.trim()||'Custom'
       };
       if(!q.questionText){ toast('Question text required'); return; }
       if(!q.answer){ toast('Answer required'); return; }
       DB.questions.push(q); saveDB(); closeModal(); toast('Question added'); render(); return;
     }
     if(act==='practice-del-q'){
       if(!confirm('Delete this question?')) return;
       DB.questions=DB.questions.filter(x=>x.id!==id); saveDB(); render(); return;
     }
     if(act==='practice-start-custom'){
       const exam=$('#p-exam').value;
       const subject=$('#p-subject').value;
       const chapter=$('#p-chapter').value;
       const count=Number($('#p-count').value)||10;
       const timer=$('#p-timer').value;
       const pqsec=Number($('#p-pqsec').value)||90;
       let pool=DB.questions.slice();
       if(exam) pool=pool.filter(q=>q.exam===exam);
       if(subject) pool=pool.filter(q=>q.subject===subject);
       if(chapter) pool=pool.filter(q=>q.chapter===chapter);
       if(!pool.length){ toast('No questions match'); return; }
       const picked=pool.slice(0,count);
       Practice.start({
         mode:'custom',
         config:{subject,chapter,count:picked.length},
         questions:picked,
         perQuestionSec:pqsec
       });
       if(timer==='none') Practice.setTimerMode('none');
       else if(timer==='full') Practice.setTimerMode('full', picked.length*pqsec);
       else Practice.setTimerMode('per-question', pqsec);
       return;
     }
     if(act==='practice-chapter'){
       const [sub,ch]=id.split('||');
       const pool=DB.questions.filter(q=>q.subject===sub && q.chapter===ch);
       if(!pool.length){ toast('No questions'); return; }
       const chRef=(DB.subjects||[]).find(s=>s.name===sub)?.chapters.find(c=>c.name===ch);
       Practice.start({
         mode:'chapter',
         config:{subject:sub, chapter:ch, count:pool.length},
         questions:pool,
         chapterId: chRef? chRef.id : null
       });
       return;
     }
     if(act==='practice-paper'){
       const [exam,sub,year]=id.split('||');
       const pool=DB.questions.filter(q=>q.exam===exam && q.subject===sub && String(q.year)===String(year));
       if(!pool.length){ toast('No questions'); return; }
       Practice.start({
         mode:'paper',
         config:{subject:sub, chapter:'Full Paper', exam, year, count:pool.length},
         questions:pool,
         perQuestionSec:90
       });
       Practice.setTimerMode('full', pool.length*90);
       return;
     }
     // Practice session internal actions
     if(act==='ps-choose'){ Practice.chooseOption(el.dataset.opt); return; }
     if(act==='ps-save-answer'){ Practice.saveTextAnswer(); return; }
     if(act==='ps-reveal'){ Practice.reveal(); return; }
     if(act==='ps-mark'){ Practice.mark(); return; }
     if(act==='ps-jump'){ Practice.jump(Number(id)); return; }
     if(act==='ps-next'){ Practice.next(); return; }
     if(act==='ps-prev'){ Practice.prev(); return; }
     if(act==='ps-submit'){ if(confirm('Submit practice session?')) Practice.submit(); return; }
     if(act==='ps-exit'){ Practice.exitConfirm(); return; }
     if(act==='ps-finish'){ Practice.finish(); return; }
     if(act==='ps-change-timer'){
       const s=Practice.session; if(!s) return;
       const opts=['per-question','full','none'];
       const next=opts[(opts.indexOf(s.timerMode)+1)%opts.length];
       Practice.setTimerMode(next);
       toast('Timer: '+next);
       return;
     }
   
     /* ---------- Study workspace ---------- */
     if(act==='toggle-subject'){ STUDY_OPEN[id]=!STUDY_OPEN[id]; render(); return; }
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
       if(!confirm('Delete "'+s.name+'" and all its chapters/sessions?')) return;
       DB.subjects=DB.subjects.filter(x=>x.id!==id); saveDB(); render(); return;
     }
     if(act==='new-chapter'){
       const s=DB.subjects.find(x=>x.id===id); if(!s) return;
       const name=prompt('Chapter name:'); if(!name) return;
       s.chapters.push(mkChapter(name.trim())); saveDB(); toast('Chapter added'); render(); return;
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
       $('#exec').classList.add('show'); Timer.start(); return;
     }
     if(act==='chapter-log'){ modalChapterLog(id); return; }
     if(act==='chapter-history'){ modalChapterHistory(id); return; }
     if(act==='ql-amt'){ $('#ql-min').value=id; return; }
     if(act==='ql-save'){
       const mins=Number($('#ql-min').value)||0;
       if(mins<=0){ toast('Enter minutes'); return; }
       const note=$('#ql-note').value.trim();
       if(logChapterSession(id, mins, {note})){
         const ref=findChapterRef(id);
         DB.focusSessions.push({
           id:uid(), taskId:null, chapterId:id,
           subject:ref? ref.subject.name+' · '+ref.chapter.name : '—',
           date:todayStr(), start:new Date().toISOString(), end:new Date().toISOString(),
           minutes:mins, mode:'quick-log'
         });
         saveDB(); closeModal(); toast('Logged '+mins+' min'); render();
       } else toast('Log failed');
       return;
     }
     if(act==='chapter-manual'){
       for(const s of DB.subjects){
         const c=s.chapters.find(x=>x.id===id);
         if(c){ c.manualStatus=el.value||null; saveDB(); render(); return; }
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
           if(!subj.chapters.some(c=>c.name===ec.name)){ subj.chapters.push(mkChapter(ec.name)); added++; }
         });
       });
       saveDB(); toast(added+' chapters imported'); render(); return;
     }
   
     /* ---------- Tasks ---------- */
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
       $('#exec').classList.add('show'); Timer.start();
       return;
     }
     if(act==='complete-task'){
       const t=DB.tasks.find(x=>x.id===id); if(!t) return;
       t.status='COMPLETED'; t.completedAt=new Date().toISOString();
       saveDB(); toast('Completed');
       setTimeout(()=>{ adaptiveReschedule({reason:'Completed: '+t.title.slice(0,32)}); render(); }, 300);
       return;
     }
     if(act==='skip-task'){
       const t=DB.tasks.find(x=>x.id===id); if(!t) return;
       t.status='SKIPPED'; saveDB(); toast('Skipped');
       setTimeout(()=>{ adaptiveReschedule({reason:'Skipped: '+t.title.slice(0,32)}); render(); }, 300);
       return;
     }
     if(act==='resched-task'){
       const t=DB.tasks.find(x=>x.id===id); if(!t) return;
       t.status='RESCHEDULED'; saveDB();
       adaptiveReschedule({reason:'Deferred: '+t.title.slice(0,32)});
       render(); return;
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
       saveDB(); closeModal(); toast('Task saved'); regenerate(0,false); render(); return;
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
   
     /* ---------- Exams ---------- */
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
       saveDB(); toast(added+' study task(s) created'); regenerate(0,false); render(); return;
     }
     if(act==='chap-status'){
       const e=DB.exams.find(x=>x.id===id); if(!e) return;
       const c=e.chapters.find(x=>x.id===el.dataset.chap); if(!c) return;
       c.status=el.value; saveDB(); render(); return;
     }
   
     /* ---------- Misc ---------- */
     if(act==='regen'){ adaptiveReschedule({reason:'Manual regenerate'}); render(); return; }
     if(act==='whatnow'){ modalWhatNow(); return; }
     if(act==='wasted'){ modalWasted(); return; }
     if(act==='wasted-amt'){ $('#m-wasted').value=id; return; }
     if(act==='apply-wasted'){
       const mins=Number($('#m-wasted').value)||60;
       const reason=$('#m-wasted-reason').value.trim()||('Lost '+mins+' min');
       adaptiveReschedule({reason, lostMinutes:mins, fromMin:nowMin()});
       closeModal(); toast('Rebuilt remaining day'); render(); return;
     }
   
     /* ---------- Execution mode ---------- */
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
       } else if(Timer.chapterId) Timer.setChapter(Timer.chapterId,5);
       else Timer.setTask(Timer.taskId,5);
       Timer.launch=true; Timer.start();
       toast('5-Minute Launch · just start');
       return;
     }
   
     /* ---------- Calendar ---------- */
     if(act==='cal-prev'){ CAL_MONTH--; if(CAL_MONTH<0){CAL_MONTH=11;CAL_YEAR--;} render(); return; }
     if(act==='cal-next'){ CAL_MONTH++; if(CAL_MONTH>11){CAL_MONTH=0;CAL_YEAR++;} render(); return; }
     if(act==='cal-today'){ const n=new Date(); CAL_MONTH=n.getMonth(); CAL_YEAR=n.getFullYear(); render(); return; }
     if(act==='cal-day'){ openDrawer(id); return; }
   
     /* ---------- Drawer ---------- */
     if(act==='drawer-add-task'){ modalTaskForm(null, DRAWER_DATE); return; }
     if(act==='drawer-add-exam'){ modalNewExam(DRAWER_DATE); return; }
   
     /* ---------- Projects / Files / Habits ---------- */
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
     if(act==='new-file'){
       const subject=prompt('Subject:'); if(!subject) return;
       const type=prompt('Type:','Notebook')||'Notebook';
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
       saveDB(); toast('Session added'); regenerate(0,false); render(); return;
     }
     if(act==='del-file'){
       if(!confirm('Delete?')) return;
       DB.files=DB.files.filter(x=>x.id!==id); saveDB(); render(); return;
     }
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
   
     /* ---------- File sync / data ---------- */
     if(act==='new-commitment'){
       const title=prompt('Commitment title:'); if(!title) return;
       const start=prompt('Start time (HH:MM):','09:00'); if(!start) return;
       const end=prompt('End time (HH:MM):','10:00'); if(!end) return;
       DB.commitments.push({id:uid(),title,type:'routine',start,end,days:[0,1,2,3,4,5,6]});
       saveDB(); adaptiveReschedule({reason:'New commitment'}); render(); return;
     }
     if(act==='del-commitment'){
       if(!confirm('Delete commitment?')) return;
       DB.commitments=DB.commitments.filter(x=>x.id!==id); saveDB(); adaptiveReschedule({reason:'Commitment removed'}); render(); return;
     }
     if(act==='fs-connect'){ FileSync.connect(); return; }
     if(act==='fs-reconnect'){ FileSync.reconnect(); return; }
     if(act==='fs-disconnect'){ if(!confirm('Disconnect the data file?')) return; FileSync.disconnect(); return; }
     if(act==='fs-save'){ FileSync.save().then(()=>toast('Saved to file')); return; }
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
       localStorage.removeItem(DB_KEY); DB=loadDB(); migrate(); regenerate(0,false); render(); toast('Reset complete'); return;
     }
   });
   
   /* ---------- Key handlers ---------- */
   document.addEventListener('keydown', e=>{
     // Assistant input: Enter = execute
     if(e.key==='Enter' && e.target && e.target.id==='assistantInput'){
       const i=e.target;
       runAssistant(i.value); i.value='';
       e.preventDefault(); return;
     }
     // Ctrl+K = focus assistant
     if((e.ctrlKey||e.metaKey) && e.key==='k'){
       e.preventDefault();
       VIEW='dashboard'; render({resetScroll:true});
       setTimeout(()=>{ const i=$('#assistantInput'); if(i) i.focus(); }, 80);
       return;
     }
     // Esc = close modal / drawer / exec / practice
     if(e.key==='Escape'){
       if($('#overlay').classList.contains('show')) closeModal();
       else if($('#drawer').classList.contains('show')) closeDrawer();
       else if($('#exec').classList.contains('show')){ $('#exec').classList.remove('show'); Timer.pause(); }
     }
   });
   
   /* ---------- Auto-save settings on input ---------- */
   document.addEventListener('input', e=>{
     const t=e.target;
     if(!t || !t.id || !t.id.startsWith('set-')) return;
     const v=t.value;
     const s=DB.settings;
     const num=x=>{ const n=Number(x); return isNaN(n)? undefined : n; };
   
     switch(t.id){
       case 'set-user': s.user=v.trim()||'Chief'; break;
       case 'set-examth': s.examModeThreshold=num(v)??10; break;
       case 'set-wake': s.wake=v; break;
       case 'set-sleep': s.sleep=v; break;
       case 'set-buffer': s.bufferMinutes=num(v)??10; break;
       case 'set-maxstudy': s.maxStudyMinutesPerDay=num(v)??300; break;
       case 'set-focus': s.focusDuration=num(v)??40; break;
       case 'set-break': s.breakDuration=num(v)??10; break;
       case 'set-exercise': s.exerciseTarget=num(v)??30; break;
       case 'set-english': s.englishTarget=num(v)??15; break;
       case 'set-project': s.projectTime=num(v)??30; break;
       case 'set-recreation': s.recreationAllowance=num(v)??60; break;
       case 'set-pqsec': s.practicePerQuestionSec=num(v)??90; break;
       case 'set-distractions': s.distractions=v; break;
       default: return;
     }
     saveDB(); savedPulse();
   });
   document.addEventListener('change', e=>{
     const t=e.target;
     if(!t || !t.id || !t.id.startsWith('set-')) return;
     if(t.id==='set-ptimer'){ DB.settings.practiceTimerDefault=t.value; saveDB(); savedPulse(); }
   });
   
   /* ------------------------------------------------------------
      22. INIT
      ------------------------------------------------------------ */
   async function init(){
     DB=loadDB();
     migrate();
     if(!DB.schedule || DB.schedule.date!==todayStr()) regenerate(0,false);
   
     renderNav();
     renderClock();
     renderExamPill();
     renderFocusPill();
     render();
   
     await FileSync.init();
     FileSync.updateUI();
   
     setInterval(renderClock,1000);
     setInterval(()=>{
       if(['dashboard','today'].includes(VIEW)) render();
     },60000);
   
     $('#menuBtn').addEventListener('click',()=>$('.sidebar').classList.toggle('open'));
     $('#overlay').addEventListener('click',e=>{ if(e.target.id==='overlay') closeModal(); });
     $('#drawerBackdrop').addEventListener('click',closeDrawer);
   
     // Greet
     toast('Assistant online · '+DB.settings.user);
     console.log('%c◈ CHIEF\'S EXECUTION ASSISTANT v3','color:#d4af37;font-size:16px;font-weight:bold;');
   }
   
   /* ---------- PDF Import modal (basic text extraction) ---------- */
   function modalPdfImport(){
     openModal(`
       <h3>Import Question Paper (PDF) <button class="btn ghost sm" data-act="close-modal">✕</button></h3>
       <div class="small muted" style="margin-bottom:14px;">
         Text PDFs can be parsed automatically. Scanned / image PDFs will need manual entry.
         Extracted questions are <b>not</b> auto-added as PYQs — you review them first.
       </div>
       <div class="pdf-drop" id="pdfDrop">
         <div class="pd-icon">⇣</div>
         <div class="pd-txt"><b>Drop a PDF here</b> or click to select</div>
       </div>
       <input type="file" id="pdfFile" accept=".pdf,application/pdf" style="display:none;" />
       <div class="field" style="margin-top:14px;">
         <label>Paste extracted text manually (fallback)</label>
         <textarea id="pdfManual" placeholder="Paste text from a question paper here, one question per line..."></textarea>
       </div>
       <div class="modal-foot">
         <button class="btn ghost" data-act="close-modal">Cancel</button>
         <button class="btn primary" data-act="pdf-manual-parse">Parse Text</button>
       </div>
     `);
     setTimeout(()=>{
       const drop=$('#pdfDrop'), inp=$('#pdfFile');
       if(!drop || !inp) return;
       drop.addEventListener('click',()=>inp.click());
       drop.addEventListener('dragover', ev=>{ ev.preventDefault(); drop.classList.add('drag'); });
       drop.addEventListener('dragleave', ()=>drop.classList.remove('drag'));
       drop.addEventListener('drop', ev=>{
         ev.preventDefault(); drop.classList.remove('drag');
         const f=ev.dataTransfer.files[0]; if(f) handlePdfFile(f);
       });
       inp.addEventListener('change', ()=>{ const f=inp.files[0]; if(f) handlePdfFile(f); });
     }, 50);
   }
   
   async function handlePdfFile(file){
     if(!file || !file.type.includes('pdf') && !file.name.endsWith('.pdf')){
       toast('Not a PDF'); return;
     }
     // Basic: read as text (works only for text PDFs)
     try{
       const text=await file.text();
       // Very rough: PDF text streams are compressed and won't be readable here
       // We check whether it looks like extracted content
       const looksTexty = /[A-Za-z]{4,}\s+[A-Za-z]{4,}/.test(text) && !text.startsWith('%PDF');
       if(looksTexty){
         $('#pdfManual').value=text.slice(0, 4000);
         toast('Some text extracted — review and parse');
       } else {
         toast('This PDF looks scanned or compressed — paste text manually');
       }
     }catch(e){
       toast('PDF read failed');
     }
   }
   
   document.addEventListener('click', e=>{
     const el=e.target.closest('[data-act]');
     if(!el) return;
     if(el.dataset.act==='pdf-manual-parse'){
       const txt=($('#pdfManual')||{}).value||'';
       const lines=txt.split('\n').map(s=>s.trim()).filter(Boolean);
       if(!lines.length){ toast('No text'); return; }
       let added=0;
       lines.forEach(line=>{
         if(line.length<10) return;
         DB.questions.push({
           id:uid(), exam:'Imported', year:null,
           subject:'', chapter:'', topic:'',
           questionType:'Short', marks:1, difficulty:'MEDIUM',
           questionText:line, options:null, answer:'(set manually)',
           solution:'', recommendedTime:120,
           source:'Imported from PDF — review needed'
         });
         added++;
       });
       saveDB(); closeModal(); toast(added+' questions imported (review needed)');
       PRACTICE_TAB='bank'; VIEW='practice'; render({resetScroll:true});
       return;
     }
   });
   
   document.addEventListener('DOMContentLoaded',init);
