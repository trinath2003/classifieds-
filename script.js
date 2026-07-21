const patients = [
  { id:1, name:"Anita R.", age:29, urgency:"mild", sub:"Cough, runny nose · 2 days",
    summary:"Reported cough and runny/blocked nose for 2 days, no fever. Triage: low urgency, self-care suggested." },
  { id:2, name:"Farhan S.", age:41, urgency:"moderate", sub:"Fever + body ache · 3 days",
    summary:"Reported fever and body ache persisting 3 days. Triage: moderate urgency, doctor review recommended." },
  { id:3, name:"Lakshmi V.", age:65, urgency:"urgent", sub:"Chest pain, breathless",
    summary:"Reported chest pain and shortness of breath. Triage: urgent — flagged for immediate clinical attention." },
];

let currentPatient = null;
let medCount = 0;
let issuedRx = null;

// ---- tabs ----
document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-'+btn.dataset.view).classList.add('active');
  });
});

// ---- open-ended multilingual NLU (keyword/entity extraction, not a fixed phrase menu) ----
// In production this step is Bhashini/Azure ASR -> a fine-tuned medical NER model.
// Here it's simulated with multilingual keyword matching so ANY sentence typed gets parsed,
// not just a preset list of sample phrases.
const symptomKeywords = {
  'fever-mild': ['fever','बुखार','जुर','జ్వరం','காய்ச்சல்','ताप','জ্বর','તાવ','ಜ್ವರ','പനി','ਬੁਖਾਰ','ଜ୍ୱର','بخار'],
  'high-fever': ['high fever','tez bukhar','तेज़ बुखार','తీవ్ర జ్వరం','கடுமையான காய்ச்சல்','जोरदार ताप'],
  'cough': ['cough','खांसी','खासी','దగ్గు','இருமல்','खोकला','কাশি','ઉધરસ','ಕೆಮ್ಮು','ചുമ','ਖੰਘ','କାଶ','کھانسی'],
  'cold': ['cold','runny nose','सर्दी','जुकाम','जलुबू','జలుబు','சளி','সর্দি','શરદી','ಶೀತ','ജലദോഷം','ਜ਼ੁਕਾਮ','زکام'],
  'sore-throat': ['sore throat','throat pain','गले में दर्द','गला दुखना','గొంతు నొప్పి','தொண்டை வலி','घसा दुखणे','গলা ব্যথা','ગળામાં દુખાવો','ಗಂಟಲು ನೋವು','തൊണ്ടവേദന','ਗਲਾ ਦਰਦ'],
  'headache': ['headache','सिरदर्द','सिर दर्द','తలనొప్పి','தலைவலி','डोकेदुखी','মাথাব্যথা','માથાનો દુખાવો','ತಲೆನೋವು','തലവേദന','ਸਿਰ ਦਰਦ'],
  'body-ache': ['body ache','बदन दर्द','शरीर दर्द','ఒళ్ళు నొప్పులు','உடல் வலி','अंगदुखी','গায়ে ব্যথা','શરીરમાં દુખાવો','ಮೈ ನೋವು','ദേഹവേദന','ਸਰੀਰ ਦਰਦ'],
  'chest-pain': ['chest pain','सीने में दर्द','छाती में दर्द','ఛాతీ నొప్పి','மார்பு வலி','छातीत दुखणे','বুকে ব্যথা','છાતીમાં દુખાવો','ಎದೆ ನೋವು','നെഞ്ചുവേദന','ਛਾਤੀ ਦਰਦ'],
  'breathless': ['breathless','shortness of breath','सांस लेने में तकलीफ','सांस फूलना','ఊపిరి ఆడకపోవడం','மூச்சு திணறல்','শ্বাসকষ্ট','શ્વાસ લેવામાં તકલીફ','ಉಸಿರಾಟದ ತೊಂದರೆ','ശ്വാസംമുട്ടൽ','ਸਾਹ ਲੈਣ ਵਿੱਚ ਤਕਲੀਫ'],
  'bleeding': ['bleeding','खून बहना','रक्तस्राव','రక్తస్రావం','இரத்தப்போக்கு','রক্তক্ষরণ','રક્તસ્ત્રાવ','ರಕ್ತಸ್ರಾವ','രക്തസ്രാവം','ਖੂਨ ਵਗਣਾ']
};

function parseSpeech(text){
  const lower = text.toLowerCase();
  const found = [];
  Object.entries(symptomKeywords).forEach(([sym, keywords])=>{
    if(keywords.some(k => lower.includes(k) || text.includes(k))){
      found.push(sym);
    }
  });
  // naive duration extraction: any digit followed by day-ish word, across scripts we just grab digits
  const durMatch = text.match(/(\d+)\s*(day|days|din|dina|dinam|naal|divas|diner)?/i);
  const duration = durMatch ? durMatch[0].trim() : null;

  return { found, duration, confidence: found.length > 0 ? (found.length + (duration?1:0)) : 0 };
}

function labelFor(sym){
  const labels = {
    'fever-mild':'Mild fever','high-fever':'High fever','cough':'Cough','cold':'Runny/blocked nose',
    'sore-throat':'Sore throat','headache':'Headache','body-ache':'Body ache','chest-pain':'Chest pain',
    'breathless':'Shortness of breath','bleeding':'Uncontrolled bleeding'
  };
  return labels[sym] || sym;
}

// the ONLY source of symptoms is whatever the AI parses from speech/text — no manual menu
const selected = new Set();
let lastFreeText = "";

// ---- conversation state (slot-filling, ChatGPT-style back-and-forth) ----
const convo = { age:null, duration:null, painAsked:false, painNote:null, turns:0 };
let awaitingSlot = null; // null | 'age' | 'pain' | 'duration'

const micBtn = document.getElementById('micBtn');
const micDot = document.getElementById('micDot');
const micLabel = document.getElementById('micLabel');
const voiceTypeBox = document.getElementById('voiceTypeBox');
const voiceTypeInput = document.getElementById('voiceTypeInput');

// map our language codes to BCP-47 locale tags the browser's speech API understands
const localeMap = {
  hi:'hi-IN', en:'en-IN', te:'te-IN', ta:'ta-IN', mr:'mr-IN', bn:'bn-IN', gu:'gu-IN',
  kn:'kn-IN', ml:'ml-IN', pa:'pa-IN', or:'or-IN', as:'as-IN', ur:'ur-IN', ks:'ks-IN', sd:'sd-IN'
};

const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let micSupported = !!SpeechRecognitionAPI;

function addBotMsg(text){
  const chatlog = document.getElementById('chatlog');
  const el = document.createElement('div');
  el.className = 'msg bot';
  el.textContent = text;
  chatlog.appendChild(el);
  chatlog.scrollTop = chatlog.scrollHeight;
}
function addUserMsg(text){
  const chatlog = document.getElementById('chatlog');
  const el = document.createElement('div');
  el.className = 'msg user';
  el.textContent = text;
  chatlog.appendChild(el);
  chatlog.scrollTop = chatlog.scrollHeight;
}

const painSymptoms = ['chest-pain','headache','body-ache','sore-throat'];
const noWords = ['no','nope','nahi','నో','இல்லை','नाही','না','ના','ಇಲ್ಲ','ഇല്ല','ਨਹੀਂ','ନାହିଁ','نہیں'];

function extractAge(text){
  const m = text.match(/\b(\d{1,3})\b/);
  if(!m) return null;
  const n = parseInt(m[1], 10);
  return (n > 0 && n < 120) ? n : null;
}

// central turn handler — every user message (typed or spoken) comes through here
function handleUserTurn(text){
  if(!text || !text.trim()) return;
  addUserMsg(text);
  convo.turns++;

  if(awaitingSlot === 'age'){
    const age = extractAge(text);
    if(age === null){
      addBotMsg("Just a number is fine — how old are you?");
      return;
    }
    convo.age = age;
    awaitingSlot = null;
    askNextQuestion();
    return;
  }

  if(awaitingSlot === 'pain'){
    convo.painAsked = true;
    const lower = text.toLowerCase();
    if(!noWords.some(w => lower.includes(w))){
      const p = parseSpeech(text);
      p.found.forEach(s => selected.add(s));
      if(p.found.length === 0) convo.painNote = text; // free-text pain description, kept for the doctor if escalated
    }
    awaitingSlot = null;
    askNextQuestion();
    return;
  }

  if(awaitingSlot === 'duration'){
    const dm = text.match(/(\d+)\s*(day|days|din|dina|dinam|naal|divas|diner)?/i);
    convo.duration = dm ? dm[0].trim() : text.trim();
    awaitingSlot = null;
    askNextQuestion();
    return;
  }

  // default: treat as a fresh symptom statement
  const parsed = parseSpeech(text);
  lastFreeText = text;
  if(parsed.found.length === 0){
    addBotMsg("I couldn't quite pick out clear symptoms from that — could you describe how you're feeling in a bit more detail?");
    return;
  }
  parsed.found.forEach(s => selected.add(s));
  if(parsed.duration) convo.duration = parsed.duration;

  addBotMsg(`Got it — noting ${parsed.found.map(labelFor).join(', ').toLowerCase()}.`);
  askNextQuestion();
}

// decides the next follow-up question, ChatGPT-style, based on what's still missing
function askNextQuestion(){
  if(selected.size === 0) return; // nothing to triage yet, wait for first real message

  if(convo.age === null){
    awaitingSlot = 'age';
    addBotMsg("Could you tell me your age? It changes how urgent some symptoms are.");
    return;
  }

  const hasPainSymptom = [...selected].some(s => painSymptoms.includes(s)) || selected.has('chest-pain');
  if(!convo.painAsked && !hasPainSymptom){
    awaitingSlot = 'pain';
    addBotMsg("Are you also experiencing any pain — chest, head, or body aches?");
    return;
  }

  if(!convo.duration){
    awaitingSlot = 'duration';
    addBotMsg("How many days has this been going on?");
    return;
  }

  // all slots filled — give the triage result as a natural chat message + the summary card
  runTriage();
}

if(micSupported){
  micBtn.addEventListener('click', ()=>{
    if(micBtn.classList.contains('listening')){
      recognizer && recognizer.stop();
      return;
    }
    recognizer = new SpeechRecognitionAPI();
    recognizer.lang = localeMap[document.getElementById('langSelect').value] || 'en-IN';
    recognizer.interimResults = false;
    recognizer.maxAlternatives = 1;

    micBtn.classList.add('listening');
    micDot.classList.add('pulse');
    micLabel.textContent = 'Listening… (tap to stop)';

    recognizer.onresult = (e)=>{
      const transcript = e.results[0][0].transcript;
      handleUserTurn(transcript);
    };
    recognizer.onerror = (e)=>{
      micBtn.classList.remove('listening');
      micDot.classList.remove('pulse');
      micLabel.textContent = 'Tap to speak';
      if(e.error === 'not-allowed' || e.error === 'service-not-allowed'){
        alert("Microphone access was blocked. Please allow mic permission in your browser, or type your symptoms below instead.");
      } else if(e.error === 'no-speech'){
        alert("Didn't catch that — please try again, a little closer to the mic.");
      }
    };
    recognizer.onend = ()=>{
      micBtn.classList.remove('listening');
      micDot.classList.remove('pulse');
      micLabel.textContent = 'Tap to speak';
    };
    recognizer.start();
  });
} else {
  micLabel.textContent = 'Speech not available — type instead';
  micBtn.addEventListener('click', ()=>{
    voiceTypeBox.style.display = 'block';
    voiceTypeInput.value = '';
    voiceTypeInput.focus();
  });
}

document.getElementById('voiceSubmitBtn').addEventListener('click', ()=>{
  const text = voiceTypeInput.value.trim();
  voiceTypeBox.style.display = 'none';
  handleUserTurn(text);
});

function classify(symptoms, age){
  const urgentFlags = ['chest-pain','breathless','bleeding'];
  const moderateFlags = ['high-fever'];
  if(urgentFlags.some(f=>symptoms.has(f))) return 'urgent';
  if(moderateFlags.some(f=>symptoms.has(f))) return 'moderate';
  let level = 'mild';
  if(symptoms.has('fever-mild') && (symptoms.has('body-ache') || symptoms.has('headache'))) level = 'moderate';
  // age adjusts risk: young adults tolerate common illnesses better; very young/older patients get bumped up
  if(age !== null){
    if(level === 'moderate' && age >= 18 && age <= 45) level = 'mild';
    if((age < 5 || age > 60) && level === 'mild') level = 'moderate';
  }
  return level;
}

function ageNote(age){
  if(age === null) return '';
  if(age >= 18 && age <= 45) return ` At ${age}, your baseline risk for these turning into something serious is low, but the guidance below still applies.`;
  if(age < 5) return ` Since this is a young child, I'd lean toward getting a doctor's opinion a bit sooner than usual.`;
  if(age > 60) return ` Given your age, it's worth having a doctor review this a bit sooner than you might for a younger adult.`;
  return '';
}

function runTriage(){
  const urgency = classify(selected, convo.age);
  const resultCard = document.getElementById('resultCard');
  const triageResult = document.getElementById('triageResult');

  if(!urgency) return;

  const copy = {
    mild: { title:"Likely mild — self-care may help", care:[
      "Rest and stay well hydrated",
      "Warm fluids can soothe throat/cough",
      "Over-the-counter fever/pain relief per the product label",
      "See a doctor if symptoms last beyond 5–7 days or worsen"
    ]},
    moderate: { title:"Worth a doctor's review soon", care:[
      "Monitor temperature every few hours",
      "Stay hydrated and rest",
      "Book an online consult today so a doctor can assess and prescribe if needed",
      "Seek in-person care if fever crosses 103°F/39.4°C or breathing feels different"
    ]},
    urgent: { title:"Seek medical attention now", care:[
      "This combination of symptoms needs prompt in-person evaluation",
      "Please go to the nearest emergency room or call local emergency services",
      "Do not wait for an online consult for these symptoms"
    ]}
  };

  const symList = [...selected].map(labelFor).join(', ').toLowerCase();
  const durationBit = convo.duration ? ` for about ${convo.duration}` : '';
  const intro = urgency === 'urgent'
    ? `Based on ${symList}${durationBit}, this needs urgent attention — please see the guidance below.`
    : `Thanks — based on ${symList}${durationBit}, here's what this looks like.${ageNote(convo.age)}`;

  addBotMsg(intro);

  resultCard.style.display = 'block';
  triageResult.innerHTML = `
    <div class="urgency-band ${urgency}"><span class="dot"></span>${copy[urgency].title}</div>
    <div class="self-care"><ul>${copy[urgency].care.map(c=>`<li>${c}</li>`).join('')}</ul></div>
    ${urgency !== 'mild' ? '<button class="btn coral" style="margin-top:14px;">Book online consult →</button>' : ''}
  `;
  resultCard.scrollIntoView({behavior:'smooth', block:'nearest'});
}

document.getElementById('checkBtn').addEventListener('click', ()=>{
  const input = document.getElementById('freeText');
  const text = input.value;
  input.value = '';
  handleUserTurn(text);
});
document.getElementById('freeText').addEventListener('keydown', (e)=>{
  if(e.key === 'Enter'){ document.getElementById('checkBtn').click(); }
});

// ---- doctor queue ----
function renderQueue(){
  const list = document.getElementById('queueList');
  list.innerHTML = '';
  patients.forEach(p=>{
    const el = document.createElement('div');
    el.className = 'queue-item' + (currentPatient && currentPatient.id===p.id ? ' active' : '');
    el.innerHTML = `
      <div>
        <div class="queue-name">${p.name} <span style="color:var(--slate); font-weight:400; font-size:12.5px;">· ${p.age}y</span></div>
        <div class="queue-sub">${p.sub}</div>
      </div>
      <div class="urgency-tag ${p.urgency}">${p.urgency}</div>
    `;
    el.addEventListener('click', ()=> selectPatient(p));
    list.appendChild(el);
  });
}

function selectPatient(p){
  currentPatient = p;
  medCount = 0;
  document.getElementById('rxPatientName').textContent = p.name;
  document.getElementById('rxPatientSub').textContent = `${p.age} years old · Triage: ${p.urgency}`;
  const summary = document.getElementById('patientSummary');
  summary.style.display = 'block';
  summary.innerHTML = `<b>Triage summary</b>${p.summary}`;
  document.getElementById('prescriptionForm').style.display = 'block';
  document.getElementById('diagnosis').value = '';
  document.getElementById('advice').value = '';
  document.getElementById('medBlocks').innerHTML = '';
  addMedBlock();
  renderQueue();
}

function addMedBlock(){
  medCount++;
  const id = medCount;
  const block = document.createElement('div');
  block.className = 'med-block';
  block.id = `med-${id}`;
  block.innerHTML = `
    <div class="med-block-head">
      <strong style="font-size:13.5px;">Medicine ${id}</strong>
      <button class="remove-med" onclick="document.getElementById('med-${id}').remove()">Remove</button>
    </div>
    <div class="form-row"><label>Drug name</label><input type="text" class="m-name" placeholder="e.g. Paracetamol"></div>
    <div class="form-grid">
      <div class="form-row"><label>Dosage</label><input type="text" class="m-dose" placeholder="e.g. 500mg"></div>
      <div class="form-row"><label>Frequency</label><input type="text" class="m-freq" placeholder="e.g. Twice daily"></div>
      <div class="form-row"><label>Duration</label><input type="text" class="m-dur" placeholder="e.g. 5 days"></div>
      <div class="form-row"><label>Instructions</label><input type="text" class="m-instr" placeholder="e.g. After food"></div>
    </div>
  `;
  document.getElementById('medBlocks').appendChild(block);
}
document.getElementById('addMedBtn').addEventListener('click', addMedBlock);

document.getElementById('issueRxBtn').addEventListener('click', ()=>{
  if(!currentPatient) return;
  const meds = [...document.querySelectorAll('.med-block')].map(b=>({
    name: b.querySelector('.m-name').value || '—',
    dose: b.querySelector('.m-dose').value || '—',
    freq: b.querySelector('.m-freq').value || '—',
    dur: b.querySelector('.m-dur').value || '—',
    instr: b.querySelector('.m-instr').value || '—',
  })).filter(m=>m.name !== '—');

  issuedRx = {
    patient: currentPatient.name,
    diagnosis: document.getElementById('diagnosis').value || 'Not specified',
    advice: document.getElementById('advice').value,
    meds,
    date: new Date().toLocaleDateString('en-IN', {day:'numeric', month:'short', year:'numeric'}),
    doctor: "Dr. S. Menon, MBBS"
  };

  renderPatientRx();
  alert('Prescription signed and sent to ' + currentPatient.name + '. Switch to Patient app tab to see it.');
});

function renderPatientRx(){
  const el = document.getElementById('patientRxView');
  if(!issuedRx){ return; }
  el.innerHTML = `
    <div class="rx-head">
      <div class="rx-symbol">℞</div>
      <div class="rx-meta">${issuedRx.date}<br>${issuedRx.doctor}</div>
    </div>
    <div class="rx-body">
      <div class="rx-line"><span>Patient</span><span>${issuedRx.patient}</span></div>
      <div class="rx-line"><span>Diagnosis</span><span>${issuedRx.diagnosis}</span></div>
      ${issuedRx.meds.map(m=>`<div class="rx-line"><span>${m.name}</span><span>${m.dose} · ${m.freq} · ${m.dur} · ${m.instr}</span></div>`).join('')}
      ${issuedRx.advice ? `<div class="rx-line"><span>Advice</span><span>${issuedRx.advice}</span></div>` : ''}
    </div>
    <div class="rx-sign">
      <div class="rx-sign-inner">
        <div class="rx-sign-name">S. Menon</div>
        <div class="rx-sign-label">Digitally signed</div>
      </div>
    </div>
  `;
}

renderQueue();

// ================= NEW NAVIGATION LAYER =================

// ---- patient landing: AI Doctor vs Human Doctor ----
function showOnly(id){
  ['patientLanding','aiDoctorView','humanDoctorView'].forEach(v=>{
    document.getElementById(v).style.display = (v===id ? 'block' : 'none');
  });
}
document.getElementById('chooseAiDoctor').addEventListener('click', ()=> showOnly('aiDoctorView'));
document.getElementById('chooseHumanDoctor').addEventListener('click', ()=> { showOnly('humanDoctorView'); showHumanStep('specializationStep'); });
document.querySelectorAll('[data-back="patientLanding"]').forEach(b=> b.addEventListener('click', ()=> showOnly('patientLanding')));

// ---- specializations ----
const specializations = [
  { id:'general', name:'General Physician', emoji:'🩺' },
  { id:'pediatrician', name:'Pediatrician', emoji:'🧒' },
  { id:'dermatologist', name:'Dermatologist', emoji:'🧴' },
  { id:'gynecologist', name:'Gynecologist', emoji:'🤰' },
  { id:'orthopedic', name:'Orthopedic', emoji:'🦴' },
  { id:'ent', name:'ENT Specialist', emoji:'👂' },
  { id:'cardiologist', name:'Cardiologist', emoji:'❤️' },
  { id:'psychiatrist', name:'Psychiatrist', emoji:'🧠' },
];

const doctorsBySpec = {
  general: [ {name:'Dr. Ramesh Iyer', exp:'12 yrs', avail:'now'}, {name:'Dr. Kavya Reddy', exp:'6 yrs', avail:'soon', in:'15 min'} ],
  pediatrician: [ {name:'Dr. Neha Kulkarni', exp:'9 yrs', avail:'now'}, {name:'Dr. Arjun Nair', exp:'14 yrs', avail:'soon', in:'20 min'} ],
  dermatologist: [ {name:'Dr. Priya Menon', exp:'7 yrs', avail:'now'} ],
  gynecologist: [ {name:'Dr. Anjali Rao', exp:'11 yrs', avail:'now'}, {name:'Dr. Fatima Sheikh', exp:'8 yrs', avail:'soon', in:'10 min'} ],
  orthopedic: [ {name:'Dr. Vikram Singh', exp:'15 yrs', avail:'soon', in:'25 min'} ],
  ent: [ {name:'Dr. Sunita Das', exp:'10 yrs', avail:'now'} ],
  cardiologist: [ {name:'Dr. Manoj Pillai', exp:'18 yrs', avail:'soon', in:'30 min'} ],
  psychiatrist: [ {name:'Dr. Ritu Sharma', exp:'9 yrs', avail:'now'} ],
};

function showHumanStep(id){
  ['specializationStep','doctorListStep','chatStep'].forEach(s=>{
    document.getElementById(s).style.display = (s===id ? 'block' : 'none');
  });
}

const specGrid = document.getElementById('specGrid');
specializations.forEach(s=>{
  const el = document.createElement('div');
  el.className = 'spec-card';
  el.innerHTML = `<div class="spec-emoji">${s.emoji}</div><div class="spec-name">${s.name}</div>`;
  el.addEventListener('click', ()=> openDoctorList(s));
  specGrid.appendChild(el);
});

function openDoctorList(spec){
  document.getElementById('specListTitle').textContent = spec.name + ' — available doctors';
  const list = document.getElementById('doctorList');
  list.innerHTML = '';
  (doctorsBySpec[spec.id] || []).forEach(doc=>{
    const el = document.createElement('div');
    el.className = 'doc-card';
    const initials = doc.name.replace('Dr. ','').split(' ').map(w=>w[0]).join('');
    el.innerHTML = `
      <div class="doc-info">
        <div class="doc-avatar">${initials}</div>
        <div>
          <div class="doc-name">${doc.name}</div>
          <div class="doc-meta">${spec.name} · ${doc.exp} experience</div>
        </div>
      </div>
      <div style="text-align:right;">
        <div class="doc-avail ${doc.avail}">${doc.avail==='now' ? 'Available now' : 'Available in '+doc.in}</div>
        <button class="btn small" style="margin-top:8px;">${doc.avail==='now' ? 'Chat now' : 'Notify me'}</button>
      </div>
    `;
    el.querySelector('button').addEventListener('click', ()=> {
      if(doc.avail === 'now') openChat(doc, spec);
      else alert(`We'll notify you the moment ${doc.name} is available (in ${doc.in}).`);
    });
    list.appendChild(el);
  });
  showHumanStep('doctorListStep');
}
document.getElementById('backToSpecs').addEventListener('click', ()=> showHumanStep('specializationStep'));
document.getElementById('backToDoctorList').addEventListener('click', ()=> showHumanStep('doctorListStep'));

// ---- Video call ----
let localStream = null;
let callTimerInterval = null;
let callSeconds = 0;
let micOn = true;
let camOn = true;

async function openChat(doc, spec){
  const initials = doc.name.replace('Dr. ','').split(' ').map(w=>w[0]).join('');
  document.getElementById('callAvatar').textContent = initials;
  document.getElementById('callDocName').textContent = doc.name;
  document.getElementById('callStatus').textContent = 'Connecting…';
  document.getElementById('callStatus').classList.add('connecting');
  document.getElementById('callTimer').style.display = 'none';
  callSeconds = 0;
  showHumanStep('chatStep');

  // request real camera/mic access for the local preview
  const localVideo = document.getElementById('localVideo');
  const noCamMsg = document.getElementById('noCamMsg');
  try{
    localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
    localVideo.srcObject = localStream;
    localVideo.style.display = 'block';
    noCamMsg.style.display = 'none';
  }catch(err){
    noCamMsg.textContent = 'Camera/mic access blocked or unavailable — allow permissions to enable your preview.';
  }

  // simulate the doctor "picking up"
  setTimeout(()=>{
    document.getElementById('callStatus').textContent = spec.name + ' · connected';
    document.getElementById('callStatus').classList.remove('connecting');
    document.getElementById('callTimer').style.display = 'block';
    callTimerInterval = setInterval(()=>{
      callSeconds++;
      const m = String(Math.floor(callSeconds/60)).padStart(2,'0');
      const s = String(callSeconds%60).padStart(2,'0');
      document.getElementById('callTimer').textContent = `${m}:${s}`;
    }, 1000);
  }, 1800);
}

function endCall(){
  if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream = null; }
  if(callTimerInterval){ clearInterval(callTimerInterval); callTimerInterval = null; }
  document.getElementById('localVideo').style.display = 'none';
  document.getElementById('noCamMsg').style.display = 'flex';
  document.getElementById('noCamMsg').textContent = 'Call ended.';
  showHumanStep('doctorListStep');
}
document.getElementById('endCallBtn').addEventListener('click', endCall);

document.getElementById('muteBtn').addEventListener('click', (e)=>{
  micOn = !micOn;
  if(localStream) localStream.getAudioTracks().forEach(t=> t.enabled = micOn);
  e.currentTarget.classList.toggle('off', !micOn);
  e.currentTarget.textContent = micOn ? '🎙️' : '🔇';
});
document.getElementById('camBtn').addEventListener('click', (e)=>{
  camOn = !camOn;
  if(localStream) localStream.getVideoTracks().forEach(t=> t.enabled = camOn);
  e.currentTarget.classList.toggle('off', !camOn);
});
document.querySelectorAll('[data-back="patientLanding"]').forEach(b=> b.addEventListener('click', ()=>{
  if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream=null; }
  if(callTimerInterval){ clearInterval(callTimerInterval); callTimerInterval=null; }
}));

// ---- doctor login gate ----
document.getElementById('docLoginBtn').addEventListener('click', ()=>{
  const name = document.getElementById('docName').value.trim();
  const reg = document.getElementById('docRegNo').value.trim();
  if(!name || !reg){ alert('Please enter your name and registration number to continue.'); return; }
  document.getElementById('doctorLoginStep').style.display = 'none';
  document.getElementById('doctorDashboard').style.display = 'block';
});
