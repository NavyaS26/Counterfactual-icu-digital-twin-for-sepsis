import { useState, useRef, useEffect } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Area, AreaChart, Legend,
} from "recharts";

// ─────────────────────────────────────────────
// CAUSAL MODEL
// ─────────────────────────────────────────────
function computeCounterfactuals(p) {
  const pivotHour = Math.round(
    Math.max(4, Math.min(18, 8 + p.sofa * 0.45 - (p.map - 65) * 0.1))
  );
  const base = Math.max(0.15, Math.min(0.88,
    0.82 - p.sofa * 0.025 - (p.age - 50) * 0.003
  ));
  const data = Array.from({ length: 24 }, (_, h) => {
    const fd  = h > pivotHour ? (h - pivotHour) * 0.026 : 0;
    const mu0 = Math.max(0.05, base - h * 0.013 - fd);
    const vb  = h >= pivotHour ? Math.min((h - pivotHour) * 0.02, 0.22) : 0;
    const mu1 = Math.min(0.94, Math.max(0.05, base - h * 0.006 + vb));
    const ite = Math.max(0, mu1 - mu0);
    const ci  = 0.04 + h * 0.003;
    return {
      label: `H${h}`, hour: h,
      fluids:       parseFloat(mu0.toFixed(3)),
      vasopressors: parseFloat(mu1.toFixed(3)),
      combined:     parseFloat(((mu0 + mu1) / 2 + 0.04).toFixed(3)),
      ite:          parseFloat(ite.toFixed(3)),
      ite_upper:    parseFloat(Math.min(0.5, ite + ci).toFixed(3)),
      ite_lower:    parseFloat(Math.max(0, ite - ci).toFixed(3)),
    };
  });
  return { pivotHour, data };
}

// currentVital = live vitals at the current hour (NOT admission values)
function simulateTreatment(currentVital, p, mode, currentHour) {
  let map = currentVital?.map ?? p.map;
  let lac = currentVital?.lactate ?? p.lactate;
  const seed = p.sofa * 7 + currentHour;
  const n = (i, a) => a * (Math.sin(seed + i * 1.9) * 0.4);
  return Array.from({ length: 5 }, (_, i) => {
    if (mode === "vasopressors") {
      map = Math.min(90, map + 1.8 + n(i, 1.2));
      lac = Math.max(0.5, lac - 0.12 + n(i, 0.04));
    } else {
      map = Math.max(35, map - 0.8 + n(i, 1.5));
      lac = Math.min(15,  lac + 0.10 + n(i, 0.05));
    }
    return { h: `+${i}h`, map: Math.round(map), lactate: parseFloat(lac.toFixed(1)) };
  });
}

function getSubgroup(p) {
  if (p.creatinine > 2.0 && p.age > 65)
    return { tag: "AKI-Elderly",         color: "#ef4444", desc: "Kidney injury + advanced age. Early vasopressors critical." };
  if (p.lactate > 4.0 && p.sofa >= 11)
    return { tag: "High-Lactate Shock",   color: "#f59e0b", desc: "Severe acidosis. Aggressive therapy indicated." };
  if (p.sofa <= 8)
    return { tag: "Moderate Sepsis",      color: "#10b981", desc: "Moderate severity. Fluid trial may be sufficient." };
  return   { tag: "Standard Septic Shock",color: "#818cf8", desc: "Classic profile. Follow pivot point." };
}

function getXAI(vitals, p) {
  const map   = vitals?.map       ?? p.map;
  const lac   = vitals?.lactate   ?? p.lactate;
  const hr    = vitals?.hr        ?? p.hr;
  const spo2  = vitals?.spo2      ?? p.spo2;
  const urine = vitals?.urine     ?? p.urine;
  const out   = [];
  if (map  < 65)  out.push({ icon:"↓", label:"MAP",        value:`${map} mmHg`,    detail:"Below 65 mmHg — inadequate organ perfusion",       severity:"critical" });
  else if (map < 70) out.push({ icon:"↓", label:"MAP",     value:`${map} mmHg`,    detail:"Borderline perfusion pressure",                    severity:"warning"  });
  if (lac  > 4)   out.push({ icon:"↑", label:"Lactate",    value:`${lac} mmol/L`,  detail:"Severe tissue hypoxia — organs hypoperfused",       severity:"critical" });
  else if (lac>2) out.push({ icon:"↑", label:"Lactate",    value:`${lac} mmol/L`,  detail:"Elevated — inadequate tissue oxygenation",         severity:"warning"  });
  if (p.sofa>=11) out.push({ icon:"↑", label:"SOFA",       value:`${p.sofa}/24`,   detail:"High multi-organ failure risk",                    severity:"critical" });
  else if(p.sofa>=8) out.push({ icon:"↑", label:"SOFA",    value:`${p.sofa}/24`,   detail:"Moderate organ dysfunction",                       severity:"warning"  });
  if (urine < 30) out.push({ icon:"↓", label:"Urine",      value:`${urine} mL/hr`, detail:"Oliguria — kidney hypoperfusion, AKI risk",        severity:"critical" });
  if (hr    > 120)out.push({ icon:"↑", label:"Heart Rate", value:`${hr} bpm`,      detail:"Tachycardia — compensating for low perfusion",     severity:"warning"  });
  if (spo2  < 94) out.push({ icon:"↓", label:"SpO₂",       value:`${spo2}%`,       detail:"Hypoxemia — insufficient oxygen delivery",         severity:"critical" });
  if (p.creatinine > 2) out.push({ icon:"↑", label:"Creatinine", value:`${p.creatinine} mg/dL`, detail:"AKI present", severity:"critical" });
  return out;
}

// ─────────────────────────────────────────────
// PARAMETER EXPLANATIONS
// ─────────────────────────────────────────────
const PARAM_INFO = {
  map: {
    name:"Mean Arterial Pressure (MAP)", unit:"mmHg", normal:"70–100 mmHg", critical:"< 65 mmHg",
    what:"Average blood pressure in arteries. Reflects how well blood is being pushed to organs.",
    fluids:"Fluids increase blood volume, temporarily raising MAP. Effect is limited in severe shock.",
    vasopressors:"Vasopressors squeeze blood vessels, directly raising MAP within minutes. Definitive treatment when MAP < 65.",
    target:"Target ≥ 65 mmHg to maintain organ perfusion.",
  },
  lactate: {
    name:"Serum Lactate", unit:"mmol/L", normal:"< 2.0 mmol/L", critical:"> 4.0 mmol/L",
    what:"Byproduct of anaerobic metabolism. High lactate = organs not getting enough oxygen.",
    fluids:"Fluids can temporarily reduce lactate by improving blood volume. Insufficient alone in shock.",
    vasopressors:"Restore MAP → improve blood flow → organs switch back to aerobic metabolism → lactate falls.",
    target:"Target < 2.0 mmol/L. Falling lactate = treatment working.",
  },
  hr: {
    name:"Heart Rate", unit:"bpm", normal:"60–100 bpm", critical:"> 130 bpm",
    what:"In shock, the heart races to compensate for low blood pressure by pumping faster.",
    fluids:"Fluids reduce compensatory tachycardia somewhat. HR stays high if MAP remains low.",
    vasopressors:"Raise MAP → body no longer needs to compensate → HR falls naturally.",
    target:"Target < 100 bpm at rest. Falling HR alongside rising MAP = good sign.",
  },
  spo2: {
    name:"Oxygen Saturation (SpO₂)", unit:"%", normal:"≥ 96%", critical:"< 90%",
    what:"Percentage of haemoglobin carrying oxygen. Low SpO₂ = lungs or circulation failing.",
    fluids:"Over-fluiding can worsen SpO₂ by causing pulmonary oedema (fluid in lungs).",
    vasopressors:"Improve circulation but don't directly fix SpO₂. Oxygen therapy may also be needed.",
    target:"Target ≥ 94% with supplemental oxygen if needed.",
  },
  urine: {
    name:"Urine Output", unit:"mL/hr", normal:"≥ 30–50 mL/hr", critical:"< 20 mL/hr",
    what:"Low urine output means kidneys are not receiving adequate blood flow — classic sign of shock.",
    fluids:"Fluids can help early shock. But without adequate MAP, fluids alone don't restore renal flow.",
    vasopressors:"Restore renal perfusion pressure. Urine output improves once MAP exceeds 65 consistently.",
    target:"Target ≥ 30 mL/hr. Rising urine output = kidneys recovering.",
  },
  creatinine: {
    name:"Serum Creatinine", unit:"mg/dL", normal:"0.6–1.2 mg/dL", critical:"> 2.0 mg/dL",
    what:"Waste product filtered by kidneys. Rising creatinine = declining kidney function (AKI).",
    fluids:"Can prevent further kidney damage if given early. Cannot reverse established AKI.",
    vasopressors:"Restoring MAP ≥ 65 is critical for kidney recovery.",
    target:"Watch for rising trend. Stable or falling creatinine = kidney function preserved.",
  },
  sofa: {
    name:"SOFA Score", unit:"/24", normal:"0–5 (low risk)", critical:"≥ 11 (high mortality)",
    what:"Sequential Organ Failure Assessment. Measures dysfunction across 6 organ systems. Higher = more organs failing.",
    fluids:"Help early sepsis by correcting hypovolemia. Alone they cannot reverse multi-organ failure.",
    vasopressors:"Early vasopressor therapy linked to lower SOFA progression.",
    target:"Rising SOFA = deterioration. Pivot point model identifies when vasopressors reduce SOFA trajectory.",
  },
};

// ─────────────────────────────────────────────
// SMALL COMPONENTS
// ─────────────────────────────────────────────
const CTip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:"#0a0d14", border:"1px solid rgba(255,255,255,0.1)", borderRadius:8, padding:"10px 14px" }}>
      <div style={{ color:"#6b7280", fontSize:11, marginBottom:6 }}>{label}</div>
      {payload.filter(p => p.name).map((p, i) => (
        <div key={i} style={{ fontSize:12, color:p.color, display:"flex", justifyContent:"space-between", gap:16 }}>
          <span>{p.name}</span>
          <span style={{ fontFamily:"monospace", fontWeight:700 }}>
            {typeof p.value === "number" && p.value < 2 ? `${(p.value * 100).toFixed(1)}%` : p.value}
          </span>
        </div>
      ))}
    </div>
  );
};

function VitalCard({ label, value, unit, status, delta, paramKey, onInfo }) {
  const c = { critical:"#ef4444", warning:"#f59e0b", normal:"#10b981" };
  return (
    <div
      onClick={() => paramKey && onInfo && onInfo(paramKey)}
      style={{ background:"rgba(255,255,255,0.03)", border:`1px solid ${status==="critical"?"rgba(239,68,68,0.3)":status==="warning"?"rgba(245,158,11,0.2)":"rgba(255,255,255,0.07)"}`, borderRadius:12, padding:"13px 16px", position:"relative", overflow:"hidden", cursor: paramKey ? "pointer" : "default" }}
    >
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
        <div style={{ fontSize:9, letterSpacing:"0.12em", color:"#6b7280", textTransform:"uppercase" }}>{label}</div>
        {paramKey && <div style={{ fontSize:9, color:"#4b5563", background:"rgba(255,255,255,0.05)", borderRadius:4, padding:"1px 5px" }}>i</div>}
      </div>
      <div style={{ display:"flex", alignItems:"baseline", gap:4 }}>
        <span style={{ fontSize:24, fontWeight:700, fontFamily:"'DM Mono',monospace", color:c[status]||"#e5e7eb" }}>{value}</span>
        <span style={{ fontSize:11, color:"#6b7280" }}>{unit}</span>
        {delta !== undefined && delta !== 0 && (
          <span style={{ fontSize:11, marginLeft:4, color: delta > 0 && paramKey !== "map" && paramKey !== "spo2" && paramKey !== "urine" ? "#ef4444" : "#10b981" }}>
            {delta > 0 ? `+${delta}` : delta}
          </span>
        )}
      </div>
      <div style={{ position:"absolute", bottom:0, left:0, right:0, height:2, background:c[status]||"#374151", opacity:0.5 }} />
    </div>
  );
}

function ParamModal({ paramKey, onClose }) {
  const info = PARAM_INFO[paramKey];
  if (!info) return null;
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.75)", zIndex:300, display:"flex", alignItems:"center", justifyContent:"center", padding:24 }} onClick={onClose}>
      <div style={{ background:"#0f1117", border:"1px solid rgba(255,255,255,0.12)", borderRadius:16, padding:"28px 32px", maxWidth:540, width:"100%", maxHeight:"80vh", overflowY:"auto" }} onClick={e => e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:20 }}>
          <div>
            <div style={{ fontSize:17, fontWeight:700, color:"#e5e7eb" }}>{info.name}</div>
            <div style={{ fontSize:12, color:"#818cf8", fontFamily:"'DM Mono',monospace", marginTop:2 }}>{info.unit}</div>
          </div>
          <button onClick={onClose} style={{ background:"none", border:"none", color:"#6b7280", cursor:"pointer", fontSize:20 }}>✕</button>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:18 }}>
          {[["Normal", info.normal, "rgba(16,185,129,0.08)", "rgba(16,185,129,0.2)", "#34d399"],
            ["Critical", info.critical, "rgba(239,68,68,0.08)", "rgba(239,68,68,0.2)", "#f87171"]].map(([l,v,bg,border,c])=>(
            <div key={l} style={{ background:bg, border:`1px solid ${border}`, borderRadius:8, padding:"10px 12px" }}>
              <div style={{ fontSize:9, color:c, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:4 }}>{l} Range</div>
              <div style={{ fontSize:13, color:"#e5e7eb", fontFamily:"'DM Mono',monospace" }}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:10, color:"#6b7280", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:5 }}>What is this?</div>
          <div style={{ fontSize:13, color:"#d1d5db", lineHeight:1.7 }}>{info.what}</div>
        </div>
        {[["💧 With IV Fluids", info.fluids, "rgba(59,130,246,0.06)", "rgba(59,130,246,0.15)", "#93c5fd"],
          ["💉 With Vasopressors", info.vasopressors, "rgba(16,185,129,0.06)", "rgba(16,185,129,0.15)", "#6ee7b7"]].map(([title, body, bg, border, c])=>(
          <div key={title} style={{ background:bg, border:`1px solid ${border}`, borderRadius:10, padding:"12px 16px", marginBottom:10 }}>
            <div style={{ fontSize:10, color:c, textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:5 }}>{title}</div>
            <div style={{ fontSize:13, color:"#d1d5db", lineHeight:1.6 }}>{body}</div>
          </div>
        ))}
        <div style={{ background:"rgba(129,140,248,0.06)", border:"1px solid rgba(129,140,248,0.15)", borderRadius:10, padding:"12px 16px" }}>
          <div style={{ fontSize:10, color:"#a5b4fc", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:4 }}>Clinical Target</div>
          <div style={{ fontSize:13, color:"#d1d5db" }}>{info.target}</div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// LOGIN SCREEN
// ─────────────────────────────────────────────
function LoginScreen({ patients, dataSource, onSelect }) {
  const [step, setStep]   = useState("login");
  const [name, setName]   = useState("");
  const [role, setRole]   = useState("Intensivist");
  const [hov,  setHov]    = useState(null);

  const inputStyle = {
    width:"100%", background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.1)",
    borderRadius:8, padding:"10px 14px", color:"#e5e7eb", fontSize:13, fontFamily:"inherit", outline:"none",
  };

  if (step === "login") return (
    <div style={{ minHeight:"100vh", background:"#080b12", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'IBM Plex Sans',sans-serif" }}>
      <div style={{ width:420, padding:"44px 40px", background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:20 }}>
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:30 }}>
          <div style={{ width:40, height:40, background:"linear-gradient(135deg,#4f46e5,#7c3aed)", borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>⚕</div>
          <div>
            <div style={{ fontSize:18, fontWeight:600, color:"#e5e7eb" }}>Causal-ICU</div>
            <div style={{ fontSize:11, color:"#6b7280" }}>Counterfactual Decision Engine</div>
          </div>
        </div>
        <div style={{ marginBottom:28 }}>
          <div style={{ fontSize:11, color:"#4b5563", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:16 }}>How this works — 5 steps</div>
          {[
            ["1","Select a patient","Choose from real MIMIC-III ICU patients"],
            ["2","View live vitals","MAP, lactate, SpO₂ — colour-coded by severity"],
            ["3","See survival curves","3 predicted futures: fluids, vasopressors, combined"],
            ["4","Watch for the alert","Fires the exact hour vasopressors become critical"],
            ["5","Use the simulator","Compare 4-hour predictions for each treatment"],
          ].map(([n, t, d]) => (
            <div key={n} style={{ display:"flex", gap:12, marginBottom:12 }}>
              <div style={{ width:22, height:22, borderRadius:"50%", background:"rgba(99,102,241,0.15)", border:"1px solid rgba(99,102,241,0.3)", color:"#818cf8", fontSize:11, fontWeight:600, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, marginTop:1 }}>{n}</div>
              <div>
                <div style={{ fontSize:13, fontWeight:500, color:"#e5e7eb", marginBottom:1 }}>{t}</div>
                <div style={{ fontSize:12, color:"#6b7280" }}>{d}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginBottom:14 }}>
          <label style={{ fontSize:11, color:"#6b7280", display:"block", marginBottom:5 }}>YOUR NAME</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Dr. Smith" style={inputStyle} />
        </div>
        <div style={{ marginBottom:26 }}>
          <label style={{ fontSize:11, color:"#6b7280", display:"block", marginBottom:5 }}>ROLE</label>
          <select value={role} onChange={e => setRole(e.target.value)} style={inputStyle}>
            <option>Intensivist</option>
            <option>ICU Registrar</option>
            <option>Critical Care Nurse</option>
            <option>Medical Student</option>
          </select>
        </div>
        <button onClick={() => setStep("select")}
          style={{ width:"100%", background:"linear-gradient(135deg,#4f46e5,#7c3aed)", border:"none", color:"#fff", padding:"13px 0", borderRadius:10, fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:"inherit" }}>
          Enter ICU Dashboard →
        </button>
        <div style={{ textAlign:"center", marginTop:14 }}>
          <span style={{ fontSize:11, padding:"3px 10px", borderRadius:6, background:dataSource==="mimic"?"rgba(16,185,129,0.1)":"rgba(245,158,11,0.1)", color:dataSource==="mimic"?"#34d399":"#fbbf24", border:`1px solid ${dataSource==="mimic"?"rgba(16,185,129,0.25)":"rgba(245,158,11,0.25)"}` }}>
            {dataSource === "mimic" ? "● MIMIC-III Real Data" : "● Synthetic Demo Data"}
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight:"100vh", background:"#080b12", fontFamily:"'IBM Plex Sans',sans-serif", color:"#e5e7eb" }}>
      <div style={{ borderBottom:"1px solid rgba(255,255,255,0.06)", height:52, padding:"0 32px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:24, height:24, background:"linear-gradient(135deg,#4f46e5,#7c3aed)", borderRadius:6, display:"flex", alignItems:"center", justifyContent:"center", fontSize:11 }}>⚕</div>
          <span style={{ fontWeight:600, fontSize:14 }}>Causal-ICU</span>
          <span style={{ color:"#374151", margin:"0 4px" }}>/</span>
          <span style={{ color:"#6b7280", fontSize:12 }}>Select Patient</span>
        </div>
        <span style={{ fontSize:12, color:"#6b7280" }}>Welcome, {name || role}</span>
      </div>
      <div style={{ maxWidth:900, margin:"0 auto", padding:"36px 24px" }}>
        <div style={{ marginBottom:28 }}>
          <div style={{ fontSize:22, fontWeight:600, marginBottom:6 }}>ICU Patients</div>
          <div style={{ fontSize:13, color:"#6b7280" }}>{patients.length} patients · {dataSource === "mimic" ? "MIMIC-III clinical data" : "synthetic demo data"}</div>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(380px,1fr))", gap:12 }}>
          {patients.map(p => {
            const sub = getSubgroup(p);
            return (
              <div key={p.id} onClick={() => onSelect(p)}
                onMouseEnter={() => setHov(p.id)} onMouseLeave={() => setHov(null)}
                style={{ background:hov===p.id?"rgba(99,102,241,0.08)":"rgba(255,255,255,0.02)", border:hov===p.id?"1px solid rgba(99,102,241,0.35)":"1px solid rgba(255,255,255,0.07)", borderRadius:14, padding:"20px 22px", cursor:"pointer", transition:"all .15s" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:14 }}>
                  <div>
                    <div style={{ fontFamily:"'DM Mono',monospace", fontSize:11, color:"#818cf8", marginBottom:3 }}>{p.id}</div>
                    <div style={{ fontSize:16, fontWeight:600 }}>{p.name}</div>
                    <div style={{ fontSize:12, color:"#6b7280", marginTop:2 }}>{p.diagnosis} · {p.total_hours}h in ICU</div>
                  </div>
                  <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:5 }}>
                    <span style={{ fontSize:10, padding:"2px 8px", borderRadius:4, background:p.survived?"rgba(16,185,129,0.12)":"rgba(239,68,68,0.12)", color:p.survived?"#34d399":"#f87171" }}>
                      {p.survived ? "Survived" : "Non-survivor"}
                    </span>
                    <span style={{ fontSize:10, padding:"2px 8px", borderRadius:4, background:p.sofa>=11?"rgba(239,68,68,0.12)":"rgba(245,158,11,0.12)", color:p.sofa>=11?"#f87171":"#fbbf24" }}>SOFA {p.sofa}</span>
                  </div>
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8, marginBottom:12 }}>
                  {[["MAP",p.map,"mmHg",p.map<65],["Lactate",p.lactate,"mmol/L",p.lactate>2],["SpO₂",p.spo2,"%",p.spo2<94],["Creat.",p.creatinine,"mg/dL",p.creatinine>1.2]].map(([l,v,u,bad])=>(
                    <div key={l} style={{ background:bad?"rgba(239,68,68,0.06)":"rgba(255,255,255,0.03)", borderRadius:8, padding:"7px 8px", border:`1px solid ${bad?"rgba(239,68,68,0.15)":"rgba(255,255,255,0.05)"}` }}>
                      <div style={{ fontSize:9, color:"#6b7280", marginBottom:2 }}>{l}</div>
                      <div style={{ fontFamily:"'DM Mono',monospace", fontSize:13, fontWeight:600, color:bad?"#f87171":"#e5e7eb" }}>{v}</div>
                      <div style={{ fontSize:9, color:"#4b5563" }}>{u}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <div style={{ width:6, height:6, borderRadius:"50%", background:sub.color }} />
                  <div style={{ fontSize:11, color:"#9ca3af" }}>{sub.tag} — {sub.desc}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// MAIN DASHBOARD
// ─────────────────────────────────────────────
export default function App() {
  const [allPatients,   setAllPatients]   = useState([]);
  const [dataSource,    setDataSource]    = useState("loading");
  const [screen,        setScreen]        = useState("login");
  const [selected,      setSelected]      = useState(null);
  const [vitalsHistory, setVitalsHistory] = useState([]);
  const [currentHour,   setCurrentHour]   = useState(0);
  const [simRunning,    setSimRunning]    = useState(false);
  const [simDone,       setSimDone]       = useState(false);
  const [speedMs,       setSpeedMs]       = useState(800);
  const [pivotVisible,  setPivotVisible]  = useState(false);
  const [alertDismissed,setAlertDismissed]= useState(false);
  const [activeTab,     setActiveTab]     = useState("twin");
  const [simMode,       setSimMode]       = useState(null);
  const [simResult,     setSimResult]     = useState(null);
  const [controlMode,   setControlMode]   = useState("idle");
  const [lastDiff,      setLastDiff]      = useState(null);
  const [paramModal,    setParamModal]    = useState(null);
  const intervalRef = useRef(null);

  // ── load data ──
  useEffect(() => {
    fetch("/patients.json")
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(d => { setAllPatients(d.patients); setDataSource("mimic"); })
      .catch(() => {
        const FB = [
          { id:"P-0041", name:"Male, 67 yrs",   gender:"Male",   age:67, diagnosis:"Septic shock",  sofa:11, lactate:4.2, map:58, hr:118, spo2:94, urine:28, creatinine:1.8, weight:72, survived:true,  received_vasopressors:true,  total_hours:24 },
          { id:"P-0078", name:"Female, 54 yrs",  gender:"Female", age:54, diagnosis:"Severe sepsis", sofa:8,  lactate:2.9, map:63, hr:104, spo2:96, urine:38, creatinine:1.1, weight:65, survived:true,  received_vasopressors:false, total_hours:24 },
          { id:"P-0112", name:"Male, 72 yrs",    gender:"Male",   age:72, diagnosis:"Septic shock",  sofa:13, lactate:5.7, map:51, hr:126, spo2:92, urine:18, creatinine:2.4, weight:80, survived:false, received_vasopressors:true,  total_hours:24 },
          { id:"P-0155", name:"Female, 61 yrs",  gender:"Female", age:61, diagnosis:"Septic shock",  sofa:9,  lactate:3.4, map:60, hr:110, spo2:95, urine:32, creatinine:1.5, weight:68, survived:true,  received_vasopressors:false, total_hours:24 },
        ];
        const buildVitals = p => {
          const seed = p.sofa*13+p.lactate*7+p.map;
          const n=(i,a)=>a*(Math.sin(seed+i*1.7)*0.45);
          let map=p.map,lac=p.lactate,hr=p.hr,spo2=p.spo2,urine=p.urine,vasoOn=false;
          return Array.from({length:24},(_,h)=>{
            if(p.survived&&h>=10) vasoOn=true;
            if(vasoOn){map=Math.min(90,map+1.8+n(h,1.2));lac=Math.max(0.5,lac-0.12+n(h,0.04));}
            else{map=Math.max(35,map-0.35+n(h,4));lac=Math.min(15,lac+0.09+n(h,0.2));}
            hr=Math.max(60,Math.min(160,hr+(vasoOn?-0.3:0.45)+n(h,3)));
            spo2=Math.max(85,Math.min(100,spo2-0.09+n(h,1)));
            urine=Math.max(0,urine-0.95+n(h,5));
            return{hour:h,label:`H${h}`,map:Math.round(map),lactate:parseFloat(lac.toFixed(2)),hr:Math.round(hr),spo2:Math.round(spo2),urine:Math.round(urine),sofa:p.sofa,fluid_ml:vasoOn?0:Math.round(300+n(h,100)),vaso_dose:vasoOn?0.1:0,creatinine:p.creatinine,sys_bp:Math.round(map*1.4),temp:37.5,rr:18};
          });
        };
        setAllPatients(FB.map(p=>({...p,vitals:buildVitals(p)})));
        setDataSource("synthetic");
      });
  }, []);

  // ── reset on patient change ──
  useEffect(() => {
    if (!selected) return;
    clearInterval(intervalRef.current);
    setSimRunning(false); setSimDone(false); setCurrentHour(0);
    setVitalsHistory([selected.vitals[0]]);
    setPivotVisible(false); setAlertDismissed(false);
    setActiveTab("twin"); setSimMode(null); setSimResult(null);
    setControlMode("idle"); setLastDiff(null);
  }, [selected?.id]);

  const cfResult    = selected ? computeCounterfactuals(selected) : null;
  const pivotHour   = cfResult?.pivotHour ?? 10;
  const cfData      = cfResult?.data ?? [];
  const subgroup    = selected ? getSubgroup(selected) : null;
  const curVital    = vitalsHistory[vitalsHistory.length-1] ?? selected;
  const prevVital   = vitalsHistory[vitalsHistory.length-2] ?? null;
  const curCF       = cfData[Math.min(currentHour,23)] ?? {};
  const delayCost   = cfData.length>1 ? parseFloat(((cfData[Math.min(currentHour,23)].vasopressors - cfData[Math.min(currentHour+1,23)].vasopressors)*100).toFixed(1)) : 0;
  const xai         = selected ? getXAI(curVital, selected) : [];
  const showAlert   = pivotVisible && !alertDismissed && (curCF.ite??0)>0.05;
  const finalImprov = cfData.length ? Math.round((cfData[23].vasopressors-cfData[23].fluids)*100) : 0;

  function runSimulation() {
    if (!selected) return;
    clearInterval(intervalRef.current);

    // If already finished, replay from 0. Otherwise RESUME from current hour.
    let startHour = currentHour;
    if (simDone) {
      startHour = 0;
      setCurrentHour(0);
      setVitalsHistory([selected.vitals[0]]);
      setPivotVisible(false);
      setAlertDismissed(false);
    }

    setSimRunning(true);
    setSimDone(false);
    setActiveTab("twin");
    setControlMode("play");
    setLastDiff(null);

    let h = startHour;
    intervalRef.current = setInterval(()=>{
      h++;
      if (!selected.vitals[h] || h >= selected.vitals.length-1) {
        clearInterval(intervalRef.current);
        setSimRunning(false); setSimDone(true); setControlMode("idle");
        setTimeout(()=>setActiveTab("counterfactual"),600);
        return;
      }
      setVitalsHistory(prev=>[...prev, selected.vitals[h]]);
      setCurrentHour(h);
      if (cfData[h]?.ite > 0.05) setPivotVisible(true);
    }, speedMs);
  }

  function stepForward() {
    if (!selected || simRunning) return;
    const nextH = currentHour+1;
    if (nextH >= selected.vitals.length) return;
    clearInterval(intervalRef.current);
    setSimRunning(false); setControlMode("manual");
    const before=selected.vitals[currentHour], after=selected.vitals[nextH];
    const cfB=cfData[currentHour]??{}, cfA=cfData[nextH]??{};
    setLastDiff({
      fromHour:currentHour, toHour:nextH,
      before:{map:before.map,lactate:before.lactate,hr:before.hr,spo2:before.spo2,urine:before.urine},
      after: {map:after.map, lactate:after.lactate, hr:after.hr, spo2:after.spo2, urine:after.urine},
      iteBefore:cfB.ite??0, iteAfter:cfA.ite??0,
      survBefore:cfB.vasopressors??0, survAfter:cfA.vasopressors??0,
      pivotCrossed:(cfB.ite??0)<=0.05 && (cfA.ite??0)>0.05,
    });
    setCurrentHour(nextH);
    setVitalsHistory(prev=>[...prev, after]);
    if ((cfA.ite??0)>0.05) setPivotVisible(true);
  }

  function stepBackward() {
    if (!selected || simRunning || currentHour<=0) return;
    clearInterval(intervalRef.current);
    setSimRunning(false); setControlMode("manual");
    setCurrentHour(h=>h-1);
    setVitalsHistory(prev=>prev.slice(0,-1));
    setLastDiff(null);
  }

  function stopSim() { clearInterval(intervalRef.current); setSimRunning(false); setControlMode("idle"); }

  function runTreatmentSim(mode) {
    if (!selected) return;
    setSimMode(mode);
    // Pass curVital so trajectory starts from CURRENT hour vitals, not admission values
    const traj = simulateTreatment(curVital, selected, mode, currentHour);
    const surv = mode==="vasopressors" ? Math.round((curCF.vasopressors??0)*100) : Math.round((curCF.fluids??0)*100);
    setSimResult({ mode, traj, survival:surv });
  }

  // ── Loading ──
  if (dataSource==="loading") return (
    <div style={{background:"#080b12",minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",color:"#6b7280",fontFamily:"sans-serif"}}>
      Loading patient data…
    </div>
  );

  // ── Login / Patient select ──
  if (screen==="login" || !selected) return (
    <>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>
      <LoginScreen patients={allPatients} dataSource={dataSource} onSelect={p=>{setSelected(p);setScreen("dashboard");}} />
    </>
  );

  // ── Dashboard ──
  return (
    <div style={{minHeight:"100vh",background:"#080b12",fontFamily:"'IBM Plex Sans',sans-serif",color:"#e5e7eb"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#0f1117}::-webkit-scrollbar-thumb{background:#374151;border-radius:2px}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.75}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        @keyframes slideDown{from{opacity:0;transform:translateY(-16px)}to{opacity:1;transform:translateY(0)}}
        @keyframes ping{0%{transform:scale(1);opacity:1}100%{transform:scale(2.4);opacity:0}}
        @keyframes scanline{0%{top:-2px}100%{top:100%}}
        .prow:hover{background:rgba(99,102,241,0.07)!important;cursor:pointer}
        .tab-btn{background:none;border:none;padding:8px 14px;cursor:pointer;font-size:12px;font-family:inherit;transition:color .2s}
        .sim-btn{border:none;padding:11px 0;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;flex:1;transition:all .2s}
        .sim-btn:hover{transform:translateY(-1px)}
      `}</style>

      {paramModal && <ParamModal paramKey={paramModal} onClose={()=>setParamModal(null)} />}

      {/* Alert Banner */}
      {showAlert && (
        <div style={{background:"linear-gradient(90deg,#7f1d1d,#991b1b,#7f1d1d)",borderBottom:"1px solid #ef4444",padding:"12px 28px",display:"flex",alignItems:"center",gap:16,animation:"slideDown 0.4s ease",position:"relative",zIndex:50}}>
          <div style={{position:"absolute",left:0,right:0,height:1,background:"linear-gradient(90deg,transparent,rgba(255,100,100,0.4),transparent)",animation:"scanline 2s linear infinite",pointerEvents:"none"}}/>
          <div style={{position:"relative",width:16,height:16,flexShrink:0}}>
            <div style={{position:"absolute",inset:0,borderRadius:"50%",background:"#fca5a5",animation:"ping 1s infinite"}}/>
            <div style={{position:"absolute",inset:"3px",borderRadius:"50%",background:"#ef4444"}}/>
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:10,color:"#fca5a5",letterSpacing:"0.14em",fontWeight:600,marginBottom:1}}>CRITICAL ICU ALERT — VASOPRESSOR PIVOT DETECTED</div>
            <div style={{fontSize:13,color:"#fff"}}>
              Vasopressors NOW gives{" "}
              <span style={{fontFamily:"'DM Mono',monospace",fontWeight:700,color:"#fca5a5",fontSize:15}}>{Math.round((curCF.vasopressors??0)*100)}%</span>{" "}
              survival vs{" "}
              <span style={{fontFamily:"'DM Mono',monospace",fontWeight:700,color:"#f87171",fontSize:15}}>{Math.round((curCF.fluids??0)*100)}%</span>{" "}
              on fluids — benefit:{" "}
              <span style={{color:"#fca5a5",fontFamily:"'DM Mono',monospace",fontWeight:700}}>+{Math.round((curCF.ite??0)*100)}%</span>
              <span style={{color:"#fca5a5",fontSize:11}}> [{Math.round((curCF.ite_lower??0)*100)}–{Math.round((curCF.ite_upper??0)*100)}% CI]</span>
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2}}>
            <div style={{fontSize:10,color:"#fca5a5",fontFamily:"'DM Mono',monospace"}}>RECOMMENDED ACTION</div>
            <div style={{fontSize:14,color:"#fff",fontWeight:700}}>Start Vasopressors Immediately</div>
          </div>
          <button onClick={()=>setAlertDismissed(true)} style={{background:"rgba(255,255,255,0.1)",border:"1px solid rgba(255,255,255,0.2)",color:"#fca5a5",padding:"4px 10px",borderRadius:6,cursor:"pointer",fontSize:11,fontFamily:"inherit",marginLeft:8}}>
            Dismiss
          </button>
        </div>
      )}

      {/* Header */}
      <div style={{borderBottom:"1px solid rgba(255,255,255,0.06)",height:52,padding:"0 24px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:24,height:24,background:"linear-gradient(135deg,#4f46e5,#7c3aed)",borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11}}>⚕</div>
          <span style={{fontWeight:600,fontSize:14}}>Causal-ICU</span>
          <span style={{color:"#374151",margin:"0 4px"}}>/</span>
          <span style={{color:"#6b7280",fontSize:12}}>{selected.id} · {selected.name}</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <span style={{fontSize:10,padding:"3px 10px",borderRadius:6,background:dataSource==="mimic"?"rgba(16,185,129,0.1)":"rgba(245,158,11,0.1)",color:dataSource==="mimic"?"#34d399":"#fbbf24",border:`1px solid ${dataSource==="mimic"?"rgba(16,185,129,0.25)":"rgba(245,158,11,0.25)"}`}}>
            {dataSource==="mimic"?"● MIMIC-III":"● Synthetic"}
          </span>
          <button onClick={()=>{setScreen("login");setSelected(null);}} style={{background:"transparent",border:"1px solid rgba(255,255,255,0.1)",color:"#6b7280",padding:"5px 12px",borderRadius:7,fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>
            ← Patients
          </button>
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"240px 1fr",height:`calc(100vh - ${52+(showAlert?62:0)}px)`,overflow:"hidden"}}>

        {/* ── Sidebar ── */}
        <div style={{borderRight:"1px solid rgba(255,255,255,0.06)",padding:"12px 8px",overflowY:"auto",display:"flex",flexDirection:"column",gap:3}}>
          <div style={{fontSize:9,letterSpacing:"0.14em",color:"#4b5563",textTransform:"uppercase",marginBottom:5,paddingLeft:4}}>ICU Patients</div>
          {allPatients.map(p=>(
            <div key={p.id} className="prow" onClick={()=>setSelected(p)}
              style={{padding:"9px 10px",borderRadius:9,background:selected.id===p.id?"rgba(99,102,241,0.12)":"transparent",border:selected.id===p.id?"1px solid rgba(99,102,241,0.35)":"1px solid transparent",transition:"all .15s"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:2}}>
                <span style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#818cf8"}}>{p.id}</span>
                <div style={{display:"flex",gap:4}}>
                  <span style={{fontSize:9,color:p.survived?"#10b981":"#ef4444"}}>{p.survived?"✓":"✗"}</span>
                  <span style={{fontSize:9,padding:"1px 5px",borderRadius:3,background:p.sofa>=11?"rgba(239,68,68,0.15)":"rgba(245,158,11,0.15)",color:p.sofa>=11?"#f87171":"#fbbf24"}}>S{p.sofa}</span>
                </div>
              </div>
              <div style={{fontSize:10,color:"#9ca3af"}}>{p.name}</div>
              <div style={{fontSize:9,color:"#4b5563"}}>{p.diagnosis}</div>
            </div>
          ))}

          {/* Static data note */}
          <div style={{padding:"7px 10px",borderRadius:8,background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.05)",marginTop:2}}>
            <div style={{fontSize:9,color:"#4b5563",lineHeight:1.6}}>
              {dataSource==="mimic"
                ? "6 fixed MIMIC-III patients. Re-run mimic_extract.py to load new patients."
                : "4 synthetic patients. Put patients.json in public/ for real data."}
            </div>
          </div>

          {/* Admission baseline */}
          <div style={{marginTop:8,padding:"11px 12px",background:"rgba(255,255,255,0.02)",borderRadius:9,border:"1px solid rgba(255,255,255,0.05)"}}>
            <div style={{fontSize:9,color:"#4b5563",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:7}}>Admission Baseline</div>
            {[["Lactate",selected.lactate,"mmol/L","lactate"],["MAP",selected.map,"mmHg","map"],["SOFA",selected.sofa,"/24","sofa"],["Creatinine",selected.creatinine,"mg/dL","creatinine"]].map(([l,v,u,k])=>(
              <div key={l} style={{display:"flex",justifyContent:"space-between",marginBottom:5,cursor:"pointer"}} onClick={()=>setParamModal(k)}>
                <span style={{fontSize:10,color:"#6b7280"}}>{l} <span style={{color:"#374151",fontSize:9}}>ⓘ</span></span>
                <span style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#e5e7eb"}}>{v} <span style={{color:"#374151"}}>{u}</span></span>
              </div>
            ))}
            {subgroup && (
              <div style={{marginTop:6,padding:"6px 8px",borderRadius:7,background:`${subgroup.color}12`,border:`1px solid ${subgroup.color}25`}}>
                <div style={{fontSize:9,color:subgroup.color,marginBottom:1}}>{subgroup.tag}</div>
                <div style={{fontSize:9,color:"#4b5563"}}>{subgroup.desc}</div>
              </div>
            )}
          </div>

          {/* Playback */}
          <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:6}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 12px",background:"rgba(255,255,255,0.03)",borderRadius:9,border:"1px solid rgba(255,255,255,0.07)"}}>
              <span style={{fontSize:10,color:"#6b7280"}}>Hour</span>
              <div style={{display:"flex",alignItems:"baseline",gap:4}}>
                <span style={{fontFamily:"'DM Mono',monospace",fontSize:20,color:"#818cf8",fontWeight:700}}>H{currentHour}</span>
                <span style={{fontSize:10,color:"#374151"}}>/ {selected.total_hours-1}</span>
              </div>
              <div style={{width:6,height:6,borderRadius:"50%",background:controlMode==="play"?"#10b981":controlMode==="manual"?"#f59e0b":"#374151",animation:controlMode==="play"?"pulse 1.5s infinite":"none"}}/>
            </div>
            <div style={{height:3,background:"rgba(255,255,255,0.06)",borderRadius:2,overflow:"hidden"}}>
              <div style={{height:"100%",background:"linear-gradient(90deg,#4f46e5,#7c3aed)",width:`${(currentHour/Math.max(selected.total_hours-1,1))*100}%`,transition:"width .3s",borderRadius:2}}/>
            </div>

            <div style={{padding:"10px 12px",background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:9}}>
              <div style={{fontSize:9,color:"#4b5563",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:6}}>▶ Auto-play</div>
              <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:6}}>
                <span style={{fontSize:10,color:"#6b7280",flexShrink:0}}>Speed</span>
                <input type="range" min="200" max="2000" step="200" value={speedMs} onChange={e=>setSpeedMs(+e.target.value)} style={{flex:1,accentColor:"#818cf8"}} disabled={controlMode==="play"}/>
                <span style={{fontSize:10,color:"#4b5563",minWidth:28}}>{speedMs/1000}s</span>
              </div>
              <button onClick={simRunning?stopSim:runSimulation}
                style={{background:simRunning?"linear-gradient(135deg,#dc2626,#991b1b)":"linear-gradient(135deg,#4f46e5,#7c3aed)",border:"none",color:"#fff",padding:"9px 0",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",width:"100%"}}>
                {simRunning ? "⏹ Stop" : simDone ? "↺ Replay from H0" : currentHour > 0 ? `▶ Resume from H${currentHour}` : "▶ Play all hours"}
              </button>
            </div>

            <div style={{padding:"10px 12px",background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:9}}>
              <div style={{fontSize:9,color:"#4b5563",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:6}}>⏩ Manual step</div>
              <div style={{display:"flex",gap:6}}>
                <button onClick={stepBackward} disabled={simRunning||currentHour<=0}
                  style={{flex:1,background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.1)",color:"#9ca3af",padding:"9px 0",borderRadius:8,cursor:currentHour<=0?"not-allowed":"pointer",fontFamily:"inherit",fontSize:12,opacity:currentHour<=0?0.35:1}}>
                  ← Back
                </button>
                <button onClick={stepForward} disabled={simRunning||currentHour>=selected.total_hours-1}
                  style={{flex:2,background:"linear-gradient(135deg,#92400e,#b45309)",border:"1px solid rgba(245,158,11,0.4)",color:"#fde68a",padding:"9px 0",borderRadius:8,cursor:currentHour>=selected.total_hours-1?"not-allowed":"pointer",fontFamily:"inherit",fontSize:12,fontWeight:700,opacity:currentHour>=selected.total_hours-1?0.35:1}}>
                  +1 Hour →
                </button>
              </div>
            </div>
          </div>

          {simDone && (
            <div style={{padding:"10px 12px",background:"rgba(16,185,129,0.07)",border:"1px solid rgba(16,185,129,0.2)",borderRadius:9,animation:"fadeIn 0.4s ease"}}>
              <div style={{fontSize:9,color:"#34d399",textTransform:"uppercase",marginBottom:3}}>Final Recommendation</div>
              <div style={{fontSize:11,color:"#e5e7eb",lineHeight:1.6}}>
                Vasopressors at <strong style={{color:"#818cf8"}}>H{pivotHour}</strong> → <strong style={{color:"#34d399"}}>+{finalImprov}%</strong> survival
              </div>
            </div>
          )}
        </div>

        {/* ── Main Panel ── */}
        <div style={{padding:"16px 20px",overflowY:"auto",display:"flex",flexDirection:"column",gap:12}}>

          {/* Vitals row */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
            {[
              {label:"Mean Art. Pressure", val:curVital?.map??selected.map,     prev:prevVital?.map,     unit:"mmHg",   ok:v=>v>=65,  warn:v=>v>=55,  key:"map"},
              {label:"Lactate",            val:curVital?.lactate??selected.lactate, prev:prevVital?.lactate, unit:"mmol/L", ok:v=>v<=2,   warn:v=>v<=4,   key:"lactate"},
              {label:"Heart Rate",         val:curVital?.hr??selected.hr,        prev:prevVital?.hr,      unit:"bpm",    ok:v=>v<=100, warn:v=>v<=120, key:"hr"},
              {label:"SpO₂",               val:curVital?.spo2??selected.spo2,    prev:prevVital?.spo2,    unit:"%",      ok:v=>v>=96,  warn:v=>v>=93,  key:"spo2"},
            ].map(({label,val,prev,unit,ok,warn,key})=>{
              const status=ok(val)?"normal":warn(val)?"warning":"critical";
              const delta=prev!==undefined?Math.round((val-prev)*10)/10:undefined;
              return <VitalCard key={label} label={label} value={val} unit={unit} status={status} delta={delta} paramKey={key} onInfo={setParamModal}/>;
            })}
          </div>

          {/* Extra vitals (from MIMIC JSON) */}
          {(curVital?.sys_bp||curVital?.rr||curVital?.temp) && (
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
              {[
                {label:"Systolic BP",   val:curVital?.sys_bp, unit:"mmHg",  ok:v=>v>=90, warn:v=>v>=80},
                {label:"Resp. Rate",    val:curVital?.rr,     unit:"/min",  ok:v=>v<=20, warn:v=>v<=28},
                {label:"Temperature",   val:curVital?.temp,   unit:"°F",    ok:v=>v>=97&&v<=99,warn:v=>v>=95},
                {label:"Urine Output",  val:curVital?.urine??selected.urine, unit:"mL/hr", ok:v=>v>=30,warn:v=>v>=20, key:"urine"},
              ].map(({label,val,unit,ok,warn,key})=>{
                if (!val && val!==0) return null;
                const status=ok(val)?"normal":warn(val)?"warning":"critical";
                return <VitalCard key={label} label={label} value={val} unit={unit} status={status} paramKey={key} onInfo={key?setParamModal:null}/>;
              })}
            </div>
          )}

          {/* Hint */}
          <div style={{fontSize:10,color:"#374151",textAlign:"right"}}>
            ↑ Click any vital card to learn what it means and how each treatment affects it
          </div>

          {/* What changed diff */}
          {controlMode==="manual" && lastDiff && (()=>{
            const metrics=[
              {label:"MAP",      before:lastDiff.before.map,     after:lastDiff.after.map,     unit:"mmHg",  better:(a,b)=>a>b},
              {label:"Lactate",  before:lastDiff.before.lactate, after:lastDiff.after.lactate, unit:"mmol/L",better:(a,b)=>a<b},
              {label:"HR",       before:lastDiff.before.hr,      after:lastDiff.after.hr,      unit:"bpm",   better:(a,b)=>a<b},
              {label:"SpO₂",     before:lastDiff.before.spo2,    after:lastDiff.after.spo2,    unit:"%",     better:(a,b)=>a>b},
              {label:"ITE",      before:Math.round(lastDiff.iteBefore*100), after:Math.round(lastDiff.iteAfter*100), unit:"%",better:(a,b)=>a>b},
              {label:"Survival", before:Math.round(lastDiff.survBefore*100),after:Math.round(lastDiff.survAfter*100),unit:"%",better:(a,b)=>a>b},
            ];
            return (
              <div style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(245,158,11,0.2)",borderRadius:12,padding:"14px 16px",animation:"fadeIn 0.35s ease"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:11,fontWeight:600}}>What changed</span>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:"#818cf8"}}>H{lastDiff.fromHour} → H{lastDiff.toHour}</span>
                  </div>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    {lastDiff.pivotCrossed && <div style={{fontSize:10,color:"#fca5a5",background:"rgba(239,68,68,0.15)",border:"1px solid rgba(239,68,68,0.3)",padding:"3px 10px",borderRadius:6}}>PIVOT CROSSED</div>}
                    <button onClick={()=>setLastDiff(null)} style={{background:"none",border:"none",color:"#4b5563",cursor:"pointer",fontSize:14}}>✕</button>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                  {metrics.map(m=>{
                    const delta=parseFloat((m.after-m.before).toFixed(2));
                    const improved=m.better(m.after,m.before);
                    const color=delta===0?"#6b7280":improved?"#10b981":"#ef4444";
                    return (
                      <div key={m.label} style={{background:delta===0?"rgba(255,255,255,0.02)":improved?"rgba(16,185,129,0.06)":"rgba(239,68,68,0.06)",border:`1px solid ${delta===0?"rgba(255,255,255,0.06)":improved?"rgba(16,185,129,0.2)":"rgba(239,68,68,0.2)"}`,borderRadius:9,padding:"10px 12px"}}>
                        <div style={{fontSize:9,color:"#6b7280",marginBottom:5,textTransform:"uppercase"}}>{m.label}</div>
                        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                          <span style={{fontFamily:"'DM Mono',monospace",fontSize:13,color:"#4b5563",textDecoration:"line-through"}}>{m.before}</span>
                          <span style={{color:"#374151"}}>→</span>
                          <span style={{fontFamily:"'DM Mono',monospace",fontSize:16,fontWeight:700,color}}>{m.after}</span>
                          <span style={{fontSize:9,color:"#4b5563"}}>{m.unit}</span>
                        </div>
                        <div style={{fontFamily:"'DM Mono',monospace",fontSize:11,color,fontWeight:600}}>{delta>0?`+${delta}`:delta}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* Survival cost cards */}
          {currentHour>0 && cfData.length>0 && (
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,animation:"fadeIn 0.4s ease"}}>
              {[
                {label:"Act NOW",   sub:`H${currentHour} → vasopressors`, val:Math.round((curCF.vasopressors??0)*100),     color:"#10b981", bg:"rgba(16,185,129,0.08)", border:"rgba(16,185,129,0.25)"},
                {label:"Wait 4h",   sub:`H${Math.min(currentHour+4,23)}`,  val:Math.round((cfData[Math.min(currentHour+4,23)]?.vasopressors??0)*100), color:"#f59e0b", bg:"rgba(245,158,11,0.07)", border:"rgba(245,158,11,0.2)"},
                {label:"Never switch",sub:"fluids only H23",               val:Math.round((cfData[23]?.fluids??0)*100),    color:"#ef4444", bg:"rgba(239,68,68,0.07)", border:"rgba(239,68,68,0.2)"},
              ].map(c=>(
                <div key={c.label} style={{background:c.bg,border:`1px solid ${c.border}`,borderRadius:11,padding:"12px 14px"}}>
                  <div style={{fontSize:9,color:c.color,textTransform:"uppercase",marginBottom:5}}>{c.label}</div>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:30,fontWeight:700,color:c.color}}>{c.val}%</div>
                  <div style={{fontSize:10,color:"#6b7280",marginTop:3}}>{c.sub}</div>
                </div>
              ))}
              <div style={{gridColumn:"1/-1",background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:9,padding:"9px 14px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                <span style={{fontSize:11,color:"#6b7280"}}>Each hour of delay costs</span>
                <span style={{fontFamily:"'DM Mono',monospace",fontSize:17,fontWeight:700,color:"#ef4444"}}>−{delayCost}%</span>
                <span style={{fontSize:11,color:"#6b7280"}}>survival for this patient</span>
                <div style={{marginLeft:"auto",fontSize:11}}>
                  ITE: <span style={{fontFamily:"'DM Mono',monospace",color:"#818cf8",fontWeight:700}}>{Math.round((curCF.ite??0)*100)}%</span>
                  <span style={{color:"#4b5563",fontSize:10}}> [{Math.round((curCF.ite_lower??0)*100)}–{Math.round((curCF.ite_upper??0)*100)}%]</span>
                </div>
              </div>
            </div>
          )}

          {/* Treatment Simulator */}
          <div style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:11,padding:"14px 16px"}}>
            <div style={{fontSize:11,fontWeight:600,marginBottom:3}}>Treatment Simulator</div>
            <div style={{fontSize:10,color:"#6b7280",marginBottom:10}}>Simulate counterfactual outcomes for {selected.id} at Hour {currentHour}</div>
            <div style={{display:"flex",gap:8,marginBottom:12}}>
              <button className="sim-btn" onClick={()=>runTreatmentSim("fluids")}
                style={{background:simMode==="fluids"?"rgba(59,130,246,0.2)":"rgba(59,130,246,0.07)",border:`1px solid ${simMode==="fluids"?"#3b82f6":"rgba(59,130,246,0.2)"}`,color:simMode==="fluids"?"#93c5fd":"#6b9fd4"}}>
                💧 Continue IV Fluids
              </button>
              <button className="sim-btn" onClick={()=>runTreatmentSim("vasopressors")}
                style={{background:simMode==="vasopressors"?"rgba(16,185,129,0.2)":"rgba(16,185,129,0.07)",border:`1px solid ${simMode==="vasopressors"?"#10b981":"rgba(16,185,129,0.2)"}`,color:simMode==="vasopressors"?"#6ee7b7":"#4b9e87"}}>
                💉 Start Vasopressors
              </button>
            </div>
            {simResult && (
              <div style={{animation:"fadeIn 0.3s ease",display:"grid",gridTemplateColumns:"1fr auto",gap:12,alignItems:"start"}}>
                <div>
                  <div style={{fontSize:9,color:"#6b7280",marginBottom:6}}>Predicted trajectory (next 4 hours)</div>
                  {[["MAP","map"],["Lactate","lactate"]].map(([name,key])=>(
                    <div key={key} style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                      <span style={{fontSize:10,color:"#9ca3af",width:50}}>{name}</span>
                      <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                        {simResult.traj.map((t,i)=>(
                          <span key={i} style={{fontFamily:"'DM Mono',monospace",fontSize:12,color:simMode==="vasopressors"?"#10b981":"#ef4444"}}>
                            {t[key]}{i<simResult.traj.length-1&&<span style={{color:"#374151"}}> →</span>}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{background:simMode==="vasopressors"?"rgba(16,185,129,0.08)":"rgba(59,130,246,0.08)",border:`1px solid ${simMode==="vasopressors"?"rgba(16,185,129,0.25)":"rgba(59,130,246,0.25)"}`,borderRadius:10,padding:"12px 16px",textAlign:"center",minWidth:130}}>
                  <div style={{fontSize:9,color:simMode==="vasopressors"?"#34d399":"#93c5fd",textTransform:"uppercase",marginBottom:4}}>Predicted Survival</div>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:34,fontWeight:700,color:simMode==="vasopressors"?"#10b981":"#3b82f6"}}>{simResult.survival}%</div>
                  {simMode==="vasopressors" && <div style={{fontSize:11,color:"#34d399",marginTop:4}}>Benefit: +{Math.round((curCF.ite??0)*100)}%</div>}
                </div>
              </div>
            )}
          </div>

          {/* Tabs */}
          <div style={{display:"flex",gap:2,borderBottom:"1px solid rgba(255,255,255,0.06)"}}>
            {[["twin","Digital Twin"],["counterfactual","Counterfactuals"],["ite","ITE Analysis"],["xai","AI Reasoning"],["guide","Parameter Guide"]].map(([id,label])=>(
              <button key={id} className="tab-btn" onClick={()=>setActiveTab(id)}
                style={{color:activeTab===id?"#818cf8":"#6b7280",borderBottom:activeTab===id?"2px solid #818cf8":"2px solid transparent",paddingBottom:8}}>
                {label}
              </button>
            ))}
          </div>

          {/* ── Digital Twin ── */}
          {activeTab==="twin" && (
            <div style={{animation:"fadeIn 0.3s ease",display:"flex",flexDirection:"column",gap:10}}>
              <div style={{fontSize:11,color:"#6b7280"}}>
                {simRunning?`Streaming real vitals — Hour ${currentHour} of ${selected.total_hours-1}`:simDone?"All hours revealed — trajectory complete":"Press ▶ Play or use +1 Hour to step manually"}
              </div>
              <div style={{background:"rgba(255,255,255,0.02)",borderRadius:11,border:"1px solid rgba(255,255,255,0.06)",padding:"12px 10px 6px"}}>
                <div style={{fontSize:9,color:"#6b7280",marginBottom:6}}>MAP (mmHg) — critical threshold: 65 mmHg</div>
                <ResponsiveContainer width="100%" height={140}>
                  <AreaChart data={vitalsHistory}>
                    <defs><linearGradient id="mg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#818cf8" stopOpacity={0.3}/><stop offset="95%" stopColor="#818cf8" stopOpacity={0}/></linearGradient></defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
                    <XAxis dataKey="label" tick={{fontSize:8,fill:"#4b5563"}}/>
                    <YAxis domain={[35,110]} tick={{fontSize:8,fill:"#4b5563"}}/>
                    <Tooltip content={<CTip/>}/>
                    <ReferenceLine y={65} stroke="#ef4444" strokeDasharray="4 4" label={{value:"65",fill:"#ef4444",fontSize:8}}/>
                    <Area type="monotone" dataKey="map" stroke="#818cf8" fill="url(#mg)" strokeWidth={2} dot={vitalsHistory.length<10} name="MAP"/>
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                {[
                  {key:"lactate",label:"Lactate (mmol/L) — normal < 2",color:"#f59e0b",refY:2,domain:[0,15]},
                  {key:"hr",     label:"Heart Rate (bpm) — normal < 100",color:"#f87171",refY:100,domain:[50,170]},
                  {key:"urine",  label:"Urine Output (mL/hr) — target > 30",color:"#10b981",refY:30,domain:[0,300]},
                ].map(({key,label,color,refY,domain})=>(
                  <div key={key} style={{background:"rgba(255,255,255,0.02)",borderRadius:11,border:"1px solid rgba(255,255,255,0.06)",padding:"10px 8px 4px",cursor:"pointer"}} onClick={()=>setParamModal(key==="urine"?"urine":key)}>
                    <div style={{fontSize:8,color:"#6b7280",marginBottom:5}}>{label}</div>
                    <ResponsiveContainer width="100%" height={88}>
                      <AreaChart data={vitalsHistory}>
                        <defs><linearGradient id={`g${key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={color} stopOpacity={0.25}/><stop offset="95%" stopColor={color} stopOpacity={0}/></linearGradient></defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)"/>
                        <XAxis dataKey="label" tick={{fontSize:7,fill:"#4b5563"}}/>
                        <YAxis domain={domain} tick={{fontSize:7,fill:"#4b5563"}}/>
                        <Tooltip content={<CTip/>}/>
                        <ReferenceLine y={refY} stroke={color} strokeDasharray="3 3" opacity={0.5}/>
                        <Area type="monotone" dataKey={key} stroke={color} fill={`url(#g${key})`} strokeWidth={1.8} dot={false} name={label}/>
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                ))}
              </div>
              {vitalsHistory.some(v=>v.fluid_ml||v.vaso_dose) && (
                <div style={{background:"rgba(255,255,255,0.02)",borderRadius:11,border:"1px solid rgba(255,255,255,0.06)",padding:"10px 8px 4px"}}>
                  <div style={{fontSize:9,color:"#6b7280",marginBottom:5}}>Treatment administered — IV fluid (mL) vs vasopressor dose</div>
                  <ResponsiveContainer width="100%" height={80}>
                    <LineChart data={vitalsHistory}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)"/>
                      <XAxis dataKey="label" tick={{fontSize:7,fill:"#4b5563"}}/>
                      <YAxis tick={{fontSize:7,fill:"#4b5563"}}/>
                      <Tooltip content={<CTip/>}/>
                      <Line type="stepAfter" dataKey="fluid_ml" stroke="#3b82f6" strokeWidth={1.5} dot={false} name="Fluid (mL)"/>
                      <Line type="stepAfter" dataKey={d=>d.vaso_dose*100} stroke="#10b981" strokeWidth={1.5} dot={false} name="Vaso dose ×100"/>
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          )}

          {/* ── Counterfactuals ── */}
          {activeTab==="counterfactual" && (
            <div style={{animation:"fadeIn 0.3s ease",display:"flex",flexDirection:"column",gap:10}}>
              <div style={{fontSize:11,color:"#6b7280"}}>3 simulated futures for {selected.id} — predicted 28-day survival probability per treatment strategy</div>
              <div style={{background:"rgba(255,255,255,0.02)",borderRadius:11,border:"1px solid rgba(255,255,255,0.06)",padding:"14px 10px 8px"}}>
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={cfData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
                    <XAxis dataKey="label" tick={{fontSize:8,fill:"#4b5563"}}/>
                    <YAxis domain={[0,1]} tickFormatter={v=>`${(v*100).toFixed(0)}%`} tick={{fontSize:8,fill:"#4b5563"}}/>
                    <Tooltip content={<CTip/>}/>
                    <Legend wrapperStyle={{fontSize:10,color:"#9ca3af"}}/>
                    <ReferenceLine x={`H${pivotHour}`} stroke="#ef4444" strokeDasharray="4 4" label={{value:`Pivot H${pivotHour}`,fill:"#ef4444",fontSize:9,position:"top"}}/>
                    <ReferenceLine x={`H${currentHour}`} stroke="#818cf8" strokeDasharray="2 3" label={{value:"Now",fill:"#818cf8",fontSize:9,position:"top"}}/>
                    <Line type="monotone" dataKey="fluids"       stroke="#ef4444" strokeWidth={2.5} dot={false} name="Continue fluids only"/>
                    <Line type="monotone" dataKey="vasopressors" stroke="#10b981" strokeWidth={2.5} dot={false} name="Start vasopressors"/>
                    <Line type="monotone" dataKey="combined"     stroke="#f59e0b" strokeWidth={1.5} dot={false} name="Combined strategy" strokeDasharray="5 3"/>
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                {[["💧","Fluids only","fluids","#ef4444"],["💉","Vasopressors","vasopressors","#10b981"],["⚕","Combined","combined","#f59e0b"]].map(([icon,label,key,color])=>(
                  <div key={key} style={{background:"rgba(255,255,255,0.02)",border:`1px solid ${color}30`,borderRadius:11,padding:"12px 14px"}}>
                    <div style={{fontSize:14,marginBottom:5}}>{icon}</div>
                    <div style={{fontSize:10,color:"#9ca3af",marginBottom:2}}>{label}</div>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:26,fontWeight:700,color}}>{Math.round(cfData[23][key]*100)}%</div>
                    <div style={{fontSize:9,color:"#6b7280"}}>28-day survival</div>
                    <div style={{fontSize:11,color,marginTop:3,fontWeight:600}}>Now: {Math.round((curCF[key]??0)*100)}%</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── ITE ── */}
          {activeTab==="ite" && (
            <div style={{animation:"fadeIn 0.3s ease",display:"flex",flexDirection:"column",gap:10}}>
              <div style={{fontSize:11,color:"#6b7280"}}>Individual Treatment Effect (ITE) — how much vasopressors help this specific patient each hour. Alert fires when ITE &gt; 5%.</div>
              <div style={{background:"rgba(255,255,255,0.02)",borderRadius:11,border:"1px solid rgba(255,255,255,0.06)",padding:"14px 10px 8px"}}>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={cfData}>
                    <defs><linearGradient id="ig" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#818cf8" stopOpacity={0.4}/><stop offset="95%" stopColor="#818cf8" stopOpacity={0}/></linearGradient></defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
                    <XAxis dataKey="label" tick={{fontSize:8,fill:"#4b5563"}}/>
                    <YAxis tickFormatter={v=>`${(v*100).toFixed(0)}%`} tick={{fontSize:8,fill:"#4b5563"}}/>
                    <Tooltip content={<CTip/>}/>
                    <ReferenceLine x={`H${pivotHour}`} stroke="#ef4444" strokeDasharray="4 4" label={{value:"Pivot",fill:"#ef4444",fontSize:9}}/>
                    <ReferenceLine x={`H${currentHour}`} stroke="#818cf8" strokeDasharray="2 3" label={{value:"Now",fill:"#818cf8",fontSize:9}}/>
                    <ReferenceLine y={0.05} stroke="#818cf8" strokeDasharray="3 3" opacity={0.4} label={{value:"5% threshold",fill:"#818cf8",fontSize:8}}/>
                    <Area type="monotone" dataKey="ite_upper" stroke="none" fill="#818cf818" name=""/>
                    <Area type="monotone" dataKey="ite"       stroke="#818cf8" fill="url(#ig)" strokeWidth={2.5} dot={false} name="ITE"/>
                    <Area type="monotone" dataKey="ite_lower" stroke="none" fill="#080b12" name=""/>
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                <div style={{padding:"11px 14px",background:"rgba(129,140,248,0.06)",border:"1px solid rgba(129,140,248,0.14)",borderRadius:9}}>
                  <div style={{fontSize:9,color:"#818cf8",marginBottom:3}}>ITE RIGHT NOW (H{currentHour})</div>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:26,fontWeight:700,color:"#818cf8"}}>{Math.round((curCF.ite??0)*100)}%</div>
                  <div style={{fontSize:10,color:"#6b7280",marginTop:3}}>90% CI: [{Math.round((curCF.ite_lower??0)*100)}–{Math.round((curCF.ite_upper??0)*100)}%]</div>
                </div>
                <div style={{padding:"11px 14px",background:"rgba(16,185,129,0.06)",border:"1px solid rgba(16,185,129,0.14)",borderRadius:9}}>
                  <div style={{fontSize:9,color:"#34d399",marginBottom:3}}>PIVOT HOUR (peak benefit)</div>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:26,fontWeight:700,color:"#10b981"}}>H{pivotHour}</div>
                  <div style={{fontSize:10,color:"#6b7280",marginTop:3}}>ITE peaks at {Math.round((cfData[pivotHour]?.ite??0)*100)}%</div>
                </div>
              </div>
            </div>
          )}

          {/* ── XAI ── */}
          {activeTab==="xai" && (
            <div style={{animation:"fadeIn 0.3s ease",display:"flex",flexDirection:"column",gap:10}}>
              <div style={{fontSize:11,color:"#6b7280"}}>Why the model recommends this at Hour {currentHour} — transparent clinical indicators</div>
              {xai.length===0 ? (
                <div style={{padding:"20px",textAlign:"center",color:"#4b5563",fontSize:12,background:"rgba(255,255,255,0.02)",borderRadius:11}}>No critical indicators at current hour</div>
              ) : (
                <div style={{display:"flex",flexDirection:"column",gap:7}}>
                  {xai.map((ind,i)=>(
                    <div key={i} style={{background:ind.severity==="critical"?"rgba(239,68,68,0.06)":"rgba(245,158,11,0.06)",border:`1px solid ${ind.severity==="critical"?"rgba(239,68,68,0.2)":"rgba(245,158,11,0.2)"}`,borderRadius:9,padding:"11px 14px",display:"flex",alignItems:"flex-start",gap:10}}>
                      <div style={{fontSize:16,marginTop:1}}>{ind.icon}</div>
                      <div style={{flex:1}}>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                          <span style={{fontSize:12,fontWeight:600,color:ind.severity==="critical"?"#f87171":"#fbbf24"}}>{ind.label}</span>
                          <span style={{fontFamily:"'DM Mono',monospace",fontSize:13,fontWeight:700,color:ind.severity==="critical"?"#ef4444":"#f59e0b"}}>{ind.value}</span>
                        </div>
                        <div style={{fontSize:11,color:"#9ca3af",lineHeight:1.5}}>{ind.detail}</div>
                      </div>
                      <span style={{fontSize:9,padding:"2px 7px",borderRadius:4,background:ind.severity==="critical"?"rgba(239,68,68,0.15)":"rgba(245,158,11,0.15)",color:ind.severity==="critical"?"#f87171":"#fbbf24",flexShrink:0}}>{ind.severity}</span>
                    </div>
                  ))}
                </div>
              )}
              <div style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:9,padding:"12px 14px"}}>
                <div style={{fontSize:9,color:"#6b7280",textTransform:"uppercase",marginBottom:8}}>Decision Summary</div>
                {[
                  ["Critical indicators", xai.filter(x=>x.severity==="critical").length, "#ef4444"],
                  ["Warning indicators",  xai.filter(x=>x.severity==="warning").length,  "#f59e0b"],
                  ["Patient subgroup",    subgroup?.tag,                                  subgroup?.color],
                  [`ITE at H${currentHour}`, `${Math.round((curCF.ite??0)*100)}% [${Math.round((curCF.ite_lower??0)*100)}–${Math.round((curCF.ite_upper??0)*100)}%]`, "#818cf8"],
                  ["Recommendation",     (curCF.ite??0)>0.05?`Start vasopressors at H${pivotHour}`:"Continue monitoring", "#10b981"],
                ].map(([l,v,c])=>(
                  <div key={l} style={{display:"flex",justifyContent:"space-between",marginBottom:6,paddingBottom:6,borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
                    <span style={{fontSize:11,color:"#6b7280"}}>{l}</span>
                    <span style={{fontSize:11,color:c,fontWeight:600}}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Parameter Guide ── */}
          {activeTab==="guide" && (
            <div style={{animation:"fadeIn 0.3s ease",display:"flex",flexDirection:"column",gap:10}}>
              <div style={{fontSize:11,color:"#6b7280"}}>Click any parameter to learn what it means and how fluids vs vasopressors affect it</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10}}>
                {Object.entries(PARAM_INFO).map(([key,info])=>(
                  <div key={key} onClick={()=>setParamModal(key)}
                    style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:11,padding:"14px 16px",cursor:"pointer",transition:"all .15s"}}
                    onMouseEnter={e=>{e.currentTarget.style.borderColor="rgba(129,140,248,0.35)";e.currentTarget.style.background="rgba(99,102,241,0.05)";}}
                    onMouseLeave={e=>{e.currentTarget.style.borderColor="rgba(255,255,255,0.07)";e.currentTarget.style.background="rgba(255,255,255,0.02)";}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                      <div style={{fontSize:13,fontWeight:600,color:"#e5e7eb"}}>{info.name}</div>
                      <span style={{fontSize:10,fontFamily:"'DM Mono',monospace",color:"#818cf8"}}>{info.unit}</span>
                    </div>
                    <div style={{display:"flex",gap:6,marginBottom:8,flexWrap:"wrap"}}>
                      <span style={{fontSize:9,padding:"2px 6px",borderRadius:4,background:"rgba(16,185,129,0.1)",color:"#34d399"}}>Normal: {info.normal}</span>
                      <span style={{fontSize:9,padding:"2px 6px",borderRadius:4,background:"rgba(239,68,68,0.1)",color:"#f87171"}}>Critical: {info.critical}</span>
                    </div>
                    <div style={{fontSize:11,color:"#9ca3af",lineHeight:1.5}}>{info.what.substring(0,90)}…</div>
                    <div style={{fontSize:10,color:"#4b5563",marginTop:8}}>Click to see how fluids &amp; vasopressors affect this →</div>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}