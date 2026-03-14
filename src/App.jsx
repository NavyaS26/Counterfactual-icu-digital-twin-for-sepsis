import { useState, useRef, useEffect } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Area, AreaChart, Legend,
} from "recharts";

// ═══════════════════════════════════════════════════════════════════
// CAUSAL ENGINE
// ───────────────────────────────────────────────────────────────────
// Core logic:
//   delta = decisionHour - pivotHour
//
//   TOO EARLY  (delta < -2):  vasopressors before enough fluid →
//     cardiac output drops → organs worsen → SURVIVAL DECREASES
//
//   OPTIMAL    (|delta| ≤ 2): volume loaded + vasopressors →
//     MAP restores → organs recover → BEST SURVIVAL
//
//   TOO LATE   (delta > 2):   AKI, myocardial depression set in →
//     vasopressors still help but effect shrinks each hour
//
//   POINT OF NO RETURN (delta > noReturnDelta):
//     damage is irreversible → vasopressors can no longer help →
//     survival LOWER than fluids-only
//
//   FLUIDS ONLY: MAP never recovers → multi-organ failure
//
// Survival % only changes when the doctor makes a decision.
// Between decisions it stays fixed — no auto-scrolling numbers.
// ═══════════════════════════════════════════════════════════════════

const PIVOT_WINDOW      = 2;   // ±2h counts as optimal
const DELAY_COST        = 0.023; // survival lost per hour past pivot
const NO_RETURN_DELTA   = 10;  // hours past pivot → vasopressors useless

// ── Compute patient-specific pivot ──────────────────────────────
function computePivot(p) {
  // Earlier pivot for sicker patients (higher SOFA, lower MAP, higher lactate)
  return Math.round(Math.max(3, Math.min(14,
    10 - (p.sofa - 8) * 0.55
       - Math.max(0, 65 - p.map) * 0.14
       - Math.max(0, p.lactate - 2) * 0.38
  )));
}

// ── Point of no return: hours past pivot when vasopressors stop helping ──
function computeNoReturn(p) {
  // Sicker patients have earlier no-return threshold
  const base = NO_RETURN_DELTA;
  if (p.sofa >= 13) return base - 3;
  if (p.sofa >= 11) return base - 2;
  return base;
}

// ── Fluids-only survival at hour h ──────────────────────────────
function fluidsOnly(p, pivotHour, h) {
  const base = Math.max(0.10, Math.min(0.78,
    0.86 - p.sofa * 0.050
         - (p.age - 50) * 0.003
         - Math.max(0, p.lactate - 2) * 0.020
         - Math.max(0, 65 - p.map) * 0.005
         - (p.creatinine > 2 ? 0.05 : 0)
  ));
  const earlyDecay   = h * 0.007;
  const latePenalty  = h > pivotHour ? (h - pivotHour) * 0.030 : 0;
  return Math.max(0.04, base - earlyDecay - latePenalty);
}

// ── Survival if vasopressors started at startHour, evaluated at hour h ──
function vasoAtHour(p, pivotHour, h, startHour) {
  if (startHour === null || startHour === undefined) return fluidsOnly(p, pivotHour, h);
  if (h < startHour) return fluidsOnly(p, pivotHour, h); // before treatment: same as fluids

  const delta    = startHour - pivotHour;
  const noReturn = computeNoReturn(p);
  const base     = fluidsOnly(p, pivotHour, h);

  // POINT OF NO RETURN — vasopressors can no longer help, actually harmful
  if (delta > noReturn) {
    const overDelta = delta - noReturn;
    return Math.max(0.03, base - overDelta * 0.015 - (h - startHour) * 0.005);
  }

  // TOO EARLY — vasoconstriction before volume loading → harm
  if (delta < -PIVOT_WINDOW) {
    const harm        = (Math.abs(delta) - PIVOT_WINDOW) * 0.038;
    const postDecay   = (h - startHour) * 0.008;
    return Math.max(0.03, base - harm - postDecay);
  }

  // OPTIMAL — peak benefit
  if (Math.abs(delta) <= PIVOT_WINDOW) {
    const benefit = Math.min((h - startHour) * 0.014 + 0.05, 0.22);
    return Math.min(0.94, base + benefit + 0.04);
  }

  // TOO LATE — attenuated benefit, shrinks with each hour of delay
  const delayPenalty = delta * DELAY_COST;
  const benefit      = Math.max(0,
    Math.min((h - startHour) * 0.010 + 0.02, 0.13) - delayPenalty
  );
  return Math.max(0.04, base + benefit);
}

// ── Full 24h counterfactual curves ──────────────────────────────
function computeCounterfactuals(p) {
  const pivotHour = computePivot(p);
  const noReturn  = computeNoReturn(p);
  const earlyH    = Math.max(0, pivotHour - 5);
  const lateH     = Math.min(23, pivotHour + 5);
  const noReturnH = Math.min(23, pivotHour + noReturn);

  const data = Array.from({ length: 24 }, (_, h) => {
    const fluids       = parseFloat(fluidsOnly(p, pivotHour, h).toFixed(3));
    const vasopOptimal = parseFloat(vasoAtHour(p, pivotHour, h, pivotHour).toFixed(3));
    const vasopEarly   = parseFloat(vasoAtHour(p, pivotHour, h, earlyH).toFixed(3));
    const vasopLate    = parseFloat(vasoAtHour(p, pivotHour, h, lateH).toFixed(3));
    const noReturnVal  = parseFloat(vasoAtHour(p, pivotHour, h, noReturnH).toFixed(3));

    // ITE: benefit of optimal vasopressors over fluids. Negative = harm before pivot.
    const ite_raw = h < earlyH
      ? parseFloat(Math.max(-0.12, -0.018 * Math.abs(h - pivotHour)).toFixed(3))
      : parseFloat((vasopOptimal - fluids).toFixed(3));
    const ci = 0.035 + h * 0.002;

    return {
      label: `H${h}`, hour: h,
      fluids,
      vasopressors: vasopOptimal,
      too_early:    vasopEarly,
      too_late:     vasopLate,
      no_return:    noReturnVal,
      ite:          ite_raw,
      ite_upper:    parseFloat(Math.min(0.55, ite_raw + ci).toFixed(3)),
      ite_lower:    parseFloat(Math.max(-0.2, ite_raw - ci).toFixed(3)),
    };
  });

  return { pivotHour, noReturn, noReturnH, earlyH, lateH, data };
}

// ── Classify timing of a decision ───────────────────────────────
function classifyTiming(startHour, pivotHour, noReturn) {
  if (startHour === null) return {
    category: "never",
    color:    "#6b7280",
    label:    "Fluids Only — No Vasopressors Given",
    headline: "No vasopressors started",
    why:      "Patient remained on IV fluids only. MAP never recovered past critical threshold. Distributive shock progressed to multi-organ failure without vasoconstrictive support.",
  };

  const delta = startHour - pivotHour;

  if (delta > noReturn) return {
    category: "no_return",
    color:    "#7f1d1d",
    label:    `💀 Point of No Return — H${startHour} (${delta}h past pivot)`,
    headline: "Too late — irreversible organ damage",
    why:      `${delta} hours past the pivot. Prolonged hypoperfusion has caused irreversible AKI, myocardial depression and microvascular failure. Vasopressors cannot reverse established multi-organ failure at this stage. Survival lower than fluids-only.`,
  };

  if (delta > PIVOT_WINDOW) return {
    category: "too_late",
    color:    "#f59e0b",
    label:    `⏰ Too Late — H${startHour} (${delta}h past pivot)`,
    headline: `${delta}h delay — AKI developing, benefit reduced`,
    why:      `Vasopressors started ${delta}h after the optimal window. Prolonged hypotension caused ischaemic AKI and early myocardial depression. Vasopressors still raise MAP, but kidney and cardiac recovery is impaired. Each delay hour costs ~${(DELAY_COST * 100).toFixed(1)}% survival.`,
  };

  if (delta < -PIVOT_WINDOW) return {
    category: "too_early",
    color:    "#ef4444",
    label:    `⚠ Too Early — H${startHour} (${Math.abs(delta)}h before pivot)`,
    headline: "Volume-depleted — vasopressors causing harm",
    why:      `Patient is still volume-depleted. Vasopressors cause vasoconstriction on an empty tank — cardiac output drops, organ perfusion worsens. Fluids first, vasopressors after adequate resuscitation (H${pivotHour}).`,
  };

  return {
    category: "optimal",
    color:    "#10b981",
    label:    `✅ Optimal Timing — H${startHour} (within H${pivotHour} ±${PIVOT_WINDOW}h window)`,
    headline: "Right time — maximum benefit",
    why:      `Volume resuscitation complete. Vasopressors raise MAP effectively against a loaded heart. Organ perfusion restored, lactate clears, kidneys recover. Best achievable outcome for this patient.`,
  };
}

// ── Survival CHANGE from a decision ─────────────────────────────
// This is the delta applied once to the baseline at decision time
function survivalDelta(startHour, pivotHour, noReturn) {
  if (startHour === null) return 0;
  const delta = startHour - pivotHour;

  if (delta > noReturn)          return -0.08 - (delta - noReturn) * 0.015;
  if (delta < -PIVOT_WINDOW)     return -0.02 * (Math.abs(delta) - PIVOT_WINDOW);
  if (Math.abs(delta) <= PIVOT_WINDOW) return +0.18;
  // too late — attenuated
  const raw = 0.12 - 0.02 * delta;
  return raw - DELAY_COST * delta;
}

// ── Project vitals 5h after decision ────────────────────────────
function projectVitals(curVital, p, startHour, pivotHour, noReturn) {
  const timing = classifyTiming(startHour, pivotHour, noReturn);
  let map   = curVital?.map     ?? p.map;
  let lac   = curVital?.lactate ?? p.lactate;
  let hr    = curVital?.hr      ?? p.hr;
  let urine = curVital?.urine   ?? p.urine;

  const seed = p.sofa * 7 + (startHour ?? 0);
  const n    = (i, a) => a * (Math.sin(seed + i * 1.9) * 0.28);

  const cfg = {
    optimal:   { mapD: +4.0, lacD: -0.40, hrD: -1.8, urineD: +5  },
    too_early: { mapD: +0.8, lacD: +0.22, hrD: +3.5, urineD: -6  },
    too_late:  { mapD: +2.5, lacD: -0.18, hrD: -0.8, urineD: +2  },
    no_return: { mapD: -0.8, lacD: +0.30, hrD: +2.0, urineD: -8  },
    never:     { mapD: -0.5, lacD: +0.15, hrD: +2.0, urineD: -4  },
  }[timing.category] ?? { mapD: -0.5, lacD: 0.15, hrD: 2.0, urineD: -4 };

  return Array.from({ length: 5 }, (_, i) => {
    map   = Math.max(25,  Math.min(115, map   + cfg.mapD   + n(i, 1.5)));
    lac   = Math.max(0.3, Math.min(20,  lac   + cfg.lacD   + n(i, 0.06)));
    hr    = Math.max(30,  Math.min(165, hr    + cfg.hrD    + n(i, 2)));
    urine = Math.max(0,   Math.min(180, urine + cfg.urineD + n(i, 2)));
    return { h: `+${i+1}h`, map: Math.round(map), lactate: +lac.toFixed(1), hr: Math.round(hr), urine: Math.round(urine) };
  });
}

// ── XAI: feature-level explanation for why survival is what it is ─
function explainSurvival(vitals, p, currentHour, pivotHour) {
  const map     = vitals?.map     ?? p.map;
  const lactate = vitals?.lactate ?? p.lactate;
  const urine   = vitals?.urine   ?? p.urine;
  const spo2    = vitals?.spo2    ?? p.spo2;
  const hoursPostPivot = Math.max(0, currentHour - pivotHour);

  return [
    {
      feature: "Blood Pressure (MAP)",
      value:   `${map} mmHg`,
      contrib: map >= 65 ? +2 : map >= 55 ? -6 : -14,
      dir:     map >= 65 ? "good" : "bad",
      why:     map >= 65
        ? `MAP ${map} ≥ 65 — organs adequately perfused.`
        : map >= 55
        ? `MAP ${map} is below 65 — borderline hypoperfusion. Each hour here damages kidneys and brain.`
        : `MAP ${map} — critical. Brain, kidneys and gut are starving. This alone contributes ~14% excess mortality.`,
    },
    {
      feature: "Lactate (Oxygen Debt)",
      value:   `${lactate} mmol/L`,
      contrib: lactate <= 2 ? +3 : lactate <= 4 ? -5 : -12,
      dir:     lactate <= 2 ? "good" : "bad",
      why:     lactate <= 2
        ? `Lactate ${lactate} is normal — cells metabolising aerobically.`
        : lactate <= 4
        ? `Lactate ${lactate} elevated — cells partially anaerobic. Moderate tissue oxygen debt.`
        : `Lactate ${lactate} — severe hypoxia. Cells suffocating. Independently predicts ~12% excess mortality.`,
    },
    {
      feature: "Urine Output (Kidneys)",
      value:   `${urine} mL/hr`,
      contrib: urine >= 30 ? +2 : urine >= 15 ? -4 : -9,
      dir:     urine >= 30 ? "good" : "bad",
      why:     urine >= 30
        ? `Urine ${urine} mL/hr — kidneys adequately perfused.`
        : urine >= 15
        ? `Urine ${urine} mL/hr — AKI developing. Kidneys are the first organ to show hypoperfusion.`
        : `Urine ${urine} mL/hr — kidneys nearly shut down. Established AKI adds ~9% mortality.`,
    },
    {
      feature: "SOFA Score (Organ Failure)",
      value:   `${p.sofa}/24`,
      contrib: p.sofa <= 6 ? +3 : p.sofa <= 10 ? -4 : -11,
      dir:     p.sofa <= 6 ? "good" : "bad",
      why:     p.sofa <= 6
        ? `SOFA ${p.sofa} — low dysfunction. Good physiological reserve.`
        : p.sofa <= 10
        ? `SOFA ${p.sofa} — moderate dysfunction across ≥4 organ systems. Mortality ~20–30%.`
        : `SOFA ${p.sofa} — severe multi-organ failure. SOFA ≥11 carries >40% ICU mortality in published cohorts.`,
    },
    {
      feature: "SpO₂ (Blood Oxygen)",
      value:   `${spo2}%`,
      contrib: spo2 >= 95 ? +1 : spo2 >= 90 ? -3 : -7,
      dir:     spo2 >= 95 ? "good" : "bad",
      why:     spo2 >= 95
        ? `SpO₂ ${spo2}% — blood well oxygenated, lungs functioning.`
        : `SpO₂ ${spo2}% — blood oxygen depleted. Risk of pulmonary oedema from excess fluids.`,
    },
    {
      feature: "Hours Past Pivot",
      value:   hoursPostPivot > 0 ? `+${hoursPostPivot}h` : "Not reached",
      contrib: hoursPostPivot === 0 ? 0 : -(hoursPostPivot * 2.3),
      dir:     hoursPostPivot > 0 ? "bad" : "neutral",
      why:     hoursPostPivot === 0
        ? `Still before the pivot point (H${pivotHour}). IV fluids are appropriate.`
        : `${hoursPostPivot}h past optimal pivot. Each hour of continued fluids costs ~2.3% cumulative survival. This is why MAP alone isn't enough — timing depends on ALL parameters together.`,
    },
  ];
}

// ── Why you need this model (not just MAP) ───────────────────────
function whyNotJustMAP(p, vitals, pivotHour, currentHour) {
  const map     = vitals?.map     ?? p.map;
  const lactate = vitals?.lactate ?? p.lactate;
  const reasons = [];

  if (map > 60 && lactate > 3.5) {
    reasons.push(`MAP is ${map} — looks borderline OK. But lactate ${lactate} reveals cells are already in severe oxygen debt despite the BP. A doctor watching MAP alone would miss this.`);
  }
  if (p.age > 65 && p.creatinine > 1.5) {
    reasons.push(`Age ${p.age} and creatinine ${p.creatinine} shift the pivot to H${pivotHour} — earlier than MAP alone would suggest. Older kidneys can't tolerate prolonged hypoperfusion.`);
  }
  const critCount = [map < 65, lactate > 2, p.urine < 30, p.spo2 < 94, p.sofa >= 8].filter(Boolean).length;
  reasons.push(`${critCount} out of 5 parameters are abnormal simultaneously. A human can track 1–2 at a time. The model weighs all of them every single hour to find the exact crossover point.`);
  reasons.push(`The pivot hour H${pivotHour} was computed from SOFA ${p.sofa}, MAP ${p.map}, lactate ${p.lactate}, age ${p.age}, and creatinine ${p.creatinine} — no single parameter gives you this.`);
  return reasons;
}

// ═══════════════════════════════════════════════════════════════════
// PATIENT DATA HELPERS
// ═══════════════════════════════════════════════════════════════════
function getSubgroup(p) {
  if (p.creatinine > 2.0 && p.age > 65) return { tag:"AKI-Elderly",         color:"#ef4444", desc:"Kidney injury + advanced age. Early vasopressors critical." };
  if (p.lactate    > 4.0 && p.sofa>=11)  return { tag:"High-Lactate Shock",  color:"#f59e0b", desc:"Severe acidosis. Aggressive therapy indicated." };
  if (p.sofa <= 8)                        return { tag:"Moderate Sepsis",     color:"#10b981", desc:"Moderate severity. Fluid trial may still be appropriate." };
  return                                         { tag:"Septic Shock",        color:"#818cf8", desc:"Classic profile. Follow the pivot point carefully." };
}

function getUrgency(p) {
  if (p.sofa >= 12 || p.map < 55 || p.lactate > 5) return { level:"CRITICAL",  color:"#ef4444", bg:"rgba(239,68,68,0.12)",  border:"rgba(239,68,68,0.35)" };
  if (p.sofa >= 9  || p.map < 65 || p.lactate > 3) return { level:"HIGH RISK", color:"#f59e0b", bg:"rgba(245,158,11,0.10)", border:"rgba(245,158,11,0.28)" };
  return                                                   { level:"MODERATE",  color:"#10b981", bg:"rgba(16,185,129,0.08)",  border:"rgba(16,185,129,0.22)" };
}

function getCriticalReason(p) {
  if (p.map < 55 && p.lactate > 4) return `BP collapsed to ${p.map} mmHg AND lactate ${p.lactate} — double organ threat`;
  if (p.map < 65)  return `Blood pressure critically low at ${p.map} mmHg — organs underperfused`;
  if (p.lactate>4) return `Severe lactic acidosis (${p.lactate} mmol/L) — cells switching to anaerobic metabolism`;
  if (p.sofa>=11)  return `Multi-organ dysfunction (SOFA ${p.sofa}/24) — high mortality risk`;
  if (p.urine<20)  return `Kidney output ${p.urine} mL/hr — acute kidney injury progressing`;
  return `Septic shock — haemodynamic support required`;
}

// ═══════════════════════════════════════════════════════════════════
// PARAM INFO  (for click-through modals)
// ═══════════════════════════════════════════════════════════════════
const PARAM_INFO = {
  map:{ name:"Mean Arterial Pressure (MAP)", unit:"mmHg", normal:"70–100 mmHg", critical:"< 65 mmHg",
    what:"Average blood pressure in arteries. Below 65 mmHg = organs not receiving enough blood.",
    fluids:"Fluids expand blood volume, temporarily raising MAP. Effect plateaus once vasculature stops responding.",
    vasopressors:"Vasopressors constrict vessels, raising MAP within minutes. Definitive treatment when MAP < 65 persists.",
    target:"Target ≥ 65 mmHg to maintain organ perfusion." },
  lactate:{ name:"Serum Lactate", unit:"mmol/L", normal:"< 2.0 mmol/L", critical:"> 4.0 mmol/L",
    what:"Byproduct of anaerobic metabolism. High lactate = organs starving for oxygen.",
    fluids:"Fluids temporarily reduce lactate by improving volume. Insufficient alone in established shock.",
    vasopressors:"Restoring MAP → blood flow → organs switch back to aerobic metabolism → lactate falls.",
    target:"< 2.0 mmol/L. Falling lactate is the best sign treatment is working." },
  hr:{ name:"Heart Rate", unit:"bpm", normal:"60–100 bpm", critical:"> 130 bpm",
    what:"In shock, the heart races to compensate for low blood pressure by pumping faster.",
    fluids:"Fluids reduce compensatory tachycardia somewhat, but HR stays high if MAP remains low.",
    vasopressors:"Raise MAP → body stops compensating → HR falls naturally.",
    target:"< 100 bpm. Falling HR alongside rising MAP = good response." },
  spo2:{ name:"Oxygen Saturation (SpO₂)", unit:"%", normal:"≥ 96%", critical:"< 90%",
    what:"% of haemoglobin carrying oxygen. Low SpO₂ = lungs or circulation failing.",
    fluids:"Over-fluiding can worsen SpO₂ by causing pulmonary oedema (fluid in lungs).",
    vasopressors:"Improve circulation but don't directly fix SpO₂. Oxygen therapy may also be needed.",
    target:"≥ 94% with supplemental O₂ if needed." },
  urine:{ name:"Urine Output", unit:"mL/hr", normal:"≥ 30–50 mL/hr", critical:"< 20 mL/hr",
    what:"Low urine output = kidneys not receiving adequate blood flow — classic early sign of shock.",
    fluids:"Help in early shock. Without adequate MAP, fluids alone cannot restore renal blood flow.",
    vasopressors:"Restore renal perfusion pressure. Urine improves once MAP consistently ≥ 65.",
    target:"≥ 30 mL/hr. Rising urine = kidneys recovering." },
  creatinine:{ name:"Serum Creatinine", unit:"mg/dL", normal:"0.6–1.2 mg/dL", critical:"> 2.0 mg/dL",
    what:"Waste product filtered by kidneys. Rising creatinine = kidney function declining (AKI).",
    fluids:"Can prevent further AKI if given early. Cannot reverse established kidney injury.",
    vasopressors:"Restoring MAP ≥ 65 is essential for kidney recovery.",
    target:"Stable or falling creatinine = kidney function preserved." },
  sofa:{ name:"SOFA Score", unit:"/24", normal:"0–5 (low risk)", critical:"≥ 11 (high mortality)",
    what:"Sequential Organ Failure Assessment — measures dysfunction across 6 organ systems.",
    fluids:"Help early sepsis. Alone they cannot reverse multi-organ failure.",
    vasopressors:"Early vasopressor therapy linked to lower SOFA progression.",
    target:"Rising SOFA = deterioration. The pivot hour is where vasopressors reduce SOFA trajectory." },
};

// ═══════════════════════════════════════════════════════════════════
// SHARED UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════
const VITAL_MEANINGS = {
  map:     { ok:"Blood pressure adequate",      warn:"Borderline low — watch closely",  bad:"Organs not getting enough blood" },
  lactate: { ok:"Cells getting enough oxygen",  warn:"Cells struggling for oxygen",     bad:"Cells starving — organ failure risk" },
  hr:      { ok:"Heart rate normal",            warn:"Heart racing to compensate",      bad:"Heart severely stressed" },
  spo2:    { ok:"Blood well oxygenated",        warn:"Blood oxygen slightly low",       bad:"Dangerous oxygen shortage" },
  urine:   { ok:"Kidneys working well",         warn:"Kidneys under stress",            bad:"Kidneys shutting down" },
};

function getTrend(key, history) {
  if (history.length < 3) return null;
  const cur  = history[history.length - 1]?.[key];
  const prev = history[history.length - 3]?.[key];
  if (cur == null || prev == null) return null;
  const diff = cur - prev;
  const thresh = { lactate:0.15, map:2, hr:3, spo2:1, urine:3 }[key] ?? 2;
  if (Math.abs(diff) < thresh) return "→";
  const upGood = ["map","spo2","urine"].includes(key);
  return diff > 0 ? (upGood ? "↑good" : "↑bad") : (upGood ? "↓bad" : "↓good");
}

function VitalCard({ label, value, unit, status, delta, paramKey, onInfo, history }) {
  const [hov, setHov] = useState(false);
  const c  = { critical:"#ef4444", warning:"#f59e0b", normal:"#10b981" };
  const bc = { critical:"rgba(239,68,68,0.28)", warning:"rgba(245,158,11,0.20)", normal:"rgba(16,185,129,0.15)" };
  const m  = paramKey && VITAL_MEANINGS[paramKey];
  const sk = status === "critical" ? "bad" : status === "warning" ? "warn" : "ok";
  const trend = paramKey && history ? getTrend(paramKey, history) : null;
  const trendColor = trend === "↑good" || trend === "↓good" ? "#10b981" : trend === "↑bad" || trend === "↓bad" ? "#ef4444" : "#6b7280";
  const trendIcon  = trend ? trend[0] : null;
  return (
    <div onClick={() => paramKey && onInfo(paramKey)} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ background:"rgba(255,255,255,0.03)", border:`1px solid ${bc[status]||"rgba(255,255,255,0.07)"}`, borderRadius:12, padding:"13px 15px", position:"relative", overflow:"visible", cursor:paramKey?"pointer":"default" }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
        <span style={{ fontSize:9, letterSpacing:"0.1em", color:"#6b7280", textTransform:"uppercase" }}>{label}</span>
        <div style={{ display:"flex", gap:5, alignItems:"center" }}>
          {trendIcon && <span style={{ fontSize:13, color:trendColor, fontWeight:700 }}>{trendIcon}</span>}
          {paramKey && <span style={{ fontSize:9, color:"#4b5563", background:"rgba(255,255,255,0.05)", borderRadius:3, padding:"1px 4px" }}>ⓘ</span>}
        </div>
      </div>
      <div style={{ display:"flex", alignItems:"baseline", gap:3 }}>
        <span style={{ fontSize:26, fontWeight:700, fontFamily:"'DM Mono',monospace", color:c[status]||"#e5e7eb" }}>{value}</span>
        <span style={{ fontSize:11, color:"#6b7280" }}>{unit}</span>
        {delta !== undefined && delta !== 0 && (
          <span style={{ fontSize:11, color:(delta>0&&paramKey!=="map"&&paramKey!=="spo2"&&paramKey!=="urine")?"#ef4444":"#10b981", fontWeight:700, marginLeft:2 }}>
            {delta>0?`+${delta}`:delta}
          </span>
        )}
      </div>
      {m && <div style={{ fontSize:10, color:c[status]||"#6b7280", marginTop:4, fontStyle:"italic" }}>{m[sk]}</div>}
      {/* Hover tooltip */}
      {hov && m && (
        <div style={{ position:"absolute", bottom:"calc(100% + 6px)", left:0, right:0, background:"#0f1117", border:`1px solid ${c[status]}40`, borderRadius:9, padding:"9px 12px", zIndex:300, boxShadow:"0 4px 24px rgba(0,0,0,0.7)", pointerEvents:"none" }}>
          <div style={{ fontSize:11, color:"#6b7280", marginBottom:3 }}>What this means right now</div>
          <div style={{ fontSize:12, color:"#e5e7eb", lineHeight:1.6 }}>{m[sk]}</div>
          <div style={{ fontSize:10, color:"#4b5563", marginTop:4 }}>Click for full clinical detail →</div>
        </div>
      )}
      <div style={{ position:"absolute", bottom:0, left:0, right:0, height:2, background:c[status]||"#374151", opacity:0.5, borderRadius:"0 0 12px 12px" }} />
    </div>
  );
}

const CTip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:"#0a0d14", border:"1px solid rgba(255,255,255,0.1)", borderRadius:8, padding:"9px 12px" }}>
      <div style={{ color:"#6b7280", fontSize:10, marginBottom:5 }}>{label}</div>
      {payload.filter(p=>p.name).map((p,i) => (
        <div key={i} style={{ fontSize:11, color:p.color, display:"flex", justifyContent:"space-between", gap:14 }}>
          <span>{p.name}</span>
          <span style={{ fontFamily:"monospace", fontWeight:700 }}>
            {typeof p.value === "number" && p.value < 2 ? `${(p.value*100).toFixed(1)}%` : p.value}
          </span>
        </div>
      ))}
    </div>
  );
};

function ParamModal({ paramKey, onClose }) {
  const info = PARAM_INFO[paramKey];
  if (!info) return null;
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.8)", zIndex:500, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }} onClick={onClose}>
      <div style={{ background:"#0f1117", border:"1px solid rgba(255,255,255,0.12)", borderRadius:16, padding:"26px 30px", maxWidth:520, width:"100%", maxHeight:"80vh", overflowY:"auto" }} onClick={e=>e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:18 }}>
          <div>
            <div style={{ fontSize:16, fontWeight:700, color:"#e5e7eb" }}>{info.name}</div>
            <div style={{ fontSize:11, color:"#818cf8", fontFamily:"'DM Mono',monospace", marginTop:2 }}>{info.unit}</div>
          </div>
          <button onClick={onClose} style={{ background:"none", border:"none", color:"#6b7280", cursor:"pointer", fontSize:18 }}>✕</button>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:16 }}>
          {[["Normal",info.normal,"rgba(16,185,129,0.08)","rgba(16,185,129,0.2)","#34d399"],
            ["Critical",info.critical,"rgba(239,68,68,0.08)","rgba(239,68,68,0.2)","#f87171"]].map(([l,v,bg,bd,c])=>(
            <div key={l} style={{ background:bg, border:`1px solid ${bd}`, borderRadius:8, padding:"10px 12px" }}>
              <div style={{ fontSize:9, color:c, textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:3 }}>{l}</div>
              <div style={{ fontSize:12, color:"#e5e7eb", fontFamily:"'DM Mono',monospace" }}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize:9, color:"#6b7280", textTransform:"uppercase", marginBottom:5 }}>What is this?</div>
        <div style={{ fontSize:12, color:"#d1d5db", lineHeight:1.7, marginBottom:14 }}>{info.what}</div>
        {[["💧 IV Fluids",info.fluids,"rgba(59,130,246,0.06)","rgba(59,130,246,0.15)","#93c5fd"],
          ["💉 Vasopressors",info.vasopressors,"rgba(16,185,129,0.06)","rgba(16,185,129,0.15)","#6ee7b7"]].map(([t,b,bg,bd,c])=>(
          <div key={t} style={{ background:bg, border:`1px solid ${bd}`, borderRadius:9, padding:"11px 14px", marginBottom:9 }}>
            <div style={{ fontSize:9, color:c, textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:4 }}>{t}</div>
            <div style={{ fontSize:12, color:"#d1d5db", lineHeight:1.6 }}>{b}</div>
          </div>
        ))}
        <div style={{ background:"rgba(129,140,248,0.06)", border:"1px solid rgba(129,140,248,0.15)", borderRadius:9, padding:"11px 14px" }}>
          <div style={{ fontSize:9, color:"#a5b4fc", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:4 }}>Clinical Target</div>
          <div style={{ fontSize:12, color:"#d1d5db" }}>{info.target}</div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// LOGIN / TRIAGE BOARD
// ═══════════════════════════════════════════════════════════════════
function LoginScreen({ patients, dataSource, onSelect }) {
  const [step, setStep] = useState("login");
  const [name, setName] = useState("");
  const [role, setRole] = useState("Intensivist");
  const [hov,  setHov]  = useState(null);
  const inp = { width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:8, padding:"10px 14px", color:"#e5e7eb", fontSize:13, fontFamily:"inherit", outline:"none" };

  if (step === "login") return (
    <div style={{ minHeight:"100vh", background:"#080b12", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'IBM Plex Sans',sans-serif" }}>
      <div style={{ width:480, padding:"44px 40px", background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:20 }}>
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:14 }}>
          <div style={{ width:42, height:42, background:"linear-gradient(135deg,#4f46e5,#7c3aed)", borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>⚕</div>
          <div>
            <div style={{ fontSize:20, fontWeight:700, color:"#e5e7eb" }}>Causal-ICU</div>
            <div style={{ fontSize:11, color:"#6b7280" }}>AI-Powered Septic Shock Decision Engine</div>
          </div>
        </div>
        <div style={{ background:"rgba(129,140,248,0.07)", border:"1px solid rgba(129,140,248,0.18)", borderRadius:11, padding:"14px 16px", marginBottom:22 }}>
          <div style={{ fontSize:13, color:"#c4b5fd", lineHeight:1.85 }}>
            In septic shock, doctors face one critical decision:<br/>
            <strong>Keep giving IV fluids</strong> — or — <strong>switch to vasopressors</strong>?<br/><br/>
            Switch too early → vessels over-constrict, cardiac output drops, organs fail.<br/>
            Switch too late → irreversible AKI, myocardial depression, patient dies.<br/><br/>
            <strong style={{ color:"#a5b4fc" }}>This AI finds the exact hour to switch — for each individual patient.</strong>
          </div>
        </div>
        <div style={{ marginBottom:14 }}>
          <label style={{ fontSize:11, color:"#6b7280", display:"block", marginBottom:5 }}>YOUR NAME</label>
          <input value={name} onChange={e=>setName(e.target.value)} placeholder="Dr. Smith" style={inp}/>
        </div>
        <div style={{ marginBottom:24 }}>
          <label style={{ fontSize:11, color:"#6b7280", display:"block", marginBottom:5 }}>ROLE</label>
          <select value={role} onChange={e=>setRole(e.target.value)} style={inp}>
            <option>Intensivist</option><option>ICU Registrar</option><option>Critical Care Nurse</option><option>Medical Student</option>
          </select>
        </div>
        <button onClick={()=>setStep("select")} style={{ width:"100%", background:"linear-gradient(135deg,#4f46e5,#7c3aed)", border:"none", color:"#fff", padding:"13px 0", borderRadius:10, fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>
          Enter ICU — {patients.length} Patients Waiting →
        </button>
        <div style={{ textAlign:"center", marginTop:12 }}>
          <span style={{ fontSize:10, padding:"3px 10px", borderRadius:6, background:dataSource==="mimic"?"rgba(16,185,129,0.1)":"rgba(245,158,11,0.1)", color:dataSource==="mimic"?"#34d399":"#fbbf24", border:`1px solid ${dataSource==="mimic"?"rgba(16,185,129,0.25)":"rgba(245,158,11,0.25)"}` }}>
            {dataSource==="mimic"?"● MIMIC-III Real Patient Data":"● Synthetic Demo Data"}
          </span>
        </div>
      </div>
    </div>
  );

  const critical = patients.filter(p=>getUrgency(p).level==="CRITICAL");
  const highRisk = patients.filter(p=>getUrgency(p).level==="HIGH RISK");
  const moderate = patients.filter(p=>getUrgency(p).level==="MODERATE");

  const Card = ({ p }) => {
    const u = getUrgency(p);
    return (
      <div onClick={()=>onSelect(p)} onMouseEnter={()=>setHov(p.id)} onMouseLeave={()=>setHov(null)}
        style={{ background:hov===p.id?u.bg:"rgba(255,255,255,0.02)", border:`1px solid ${hov===p.id?u.border:"rgba(255,255,255,0.07)"}`, borderRadius:14, padding:"18px 18px 18px 22px", cursor:"pointer", transition:"all .15s", position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", left:0, top:0, bottom:0, width:4, background:u.color, borderRadius:"14px 0 0 14px" }}/>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:9 }}>
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3 }}>
              <div style={{ width:6, height:6, borderRadius:"50%", background:u.color, animation:u.level==="CRITICAL"?"pulse 1.5s infinite":"none" }}/>
              <span style={{ fontSize:10, color:u.color, fontWeight:700, letterSpacing:"0.1em" }}>{u.level}</span>
              <span style={{ fontSize:10, color:"#4b5563" }}>·</span>
              <span style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:"#6b7280" }}>{p.id}</span>
            </div>
            <div style={{ fontSize:15, fontWeight:700, color:"#e5e7eb" }}>{p.name}</div>
            <div style={{ fontSize:11, color:"#6b7280", marginTop:1 }}>{p.diagnosis} · Age {p.age}</div>
          </div>
          <span style={{ fontSize:12, padding:"4px 10px", borderRadius:7, background:u.bg, color:u.color, border:`1px solid ${u.border}`, fontWeight:700 }}>SOFA {p.sofa}/24</span>
        </div>
        <div style={{ background:"rgba(0,0,0,0.3)", border:`1px solid ${u.border}`, borderRadius:8, padding:"8px 12px", marginBottom:11 }}>
          <div style={{ fontSize:9, color:u.color, textTransform:"uppercase", letterSpacing:"0.09em", marginBottom:2, fontWeight:700 }}>Why they need your decision</div>
          <div style={{ fontSize:12, color:"#d1d5db", lineHeight:1.55 }}>{getCriticalReason(p)}</div>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:6, marginBottom:10 }}>
          {[
            { l:"Blood Pressure", v:p.map,        u:"mmHg",  bad:p.map<65,     s:p.map<55?"Failing":p.map<65?"Low":"OK" },
            { l:"Oxygen Debt",    v:p.lactate,     u:"mmol/L",bad:p.lactate>2,  s:p.lactate>4?"Critical":p.lactate>2?"High":"OK" },
            { l:"O₂ Saturation",  v:p.spo2,        u:"%",     bad:p.spo2<94,    s:p.spo2<90?"Critical":p.spo2<94?"Low":"OK" },
            { l:"Kidney Output",  v:p.urine,       u:"mL/hr", bad:p.urine<30,   s:p.urine<15?"Failing":p.urine<30?"Low":"OK" },
          ].map(({ l,v,u,bad,s })=>(
            <div key={l} style={{ background:bad?"rgba(239,68,68,0.07)":"rgba(255,255,255,0.03)", borderRadius:7, padding:"7px 8px", border:`1px solid ${bad?"rgba(239,68,68,0.18)":"rgba(255,255,255,0.05)"}`, textAlign:"center" }}>
              <div style={{ fontSize:8, color:"#6b7280", marginBottom:2 }}>{l}</div>
              <div style={{ fontFamily:"'DM Mono',monospace", fontSize:14, fontWeight:700, color:bad?"#f87171":"#e5e7eb" }}>{v}</div>
              <div style={{ fontSize:8, color:"#4b5563" }}>{u}</div>
              <div style={{ fontSize:9, color:bad?"#f87171":"#6b7280", fontWeight:600, marginTop:1 }}>{s}</div>
            </div>
          ))}
        </div>
        <div style={{ display:"flex", justifyContent:"flex-end" }}>
          <span style={{ fontSize:11, color:u.color, fontWeight:600 }}>Start treatment →</span>
        </div>
      </div>
    );
  };

  return (
    <div style={{ minHeight:"100vh", background:"#080b12", fontFamily:"'IBM Plex Sans',sans-serif", color:"#e5e7eb" }}>
      <div style={{ borderBottom:"1px solid rgba(255,255,255,0.06)", height:52, padding:"0 32px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:24, height:24, background:"linear-gradient(135deg,#4f46e5,#7c3aed)", borderRadius:6, display:"flex", alignItems:"center", justifyContent:"center", fontSize:11 }}>⚕</div>
          <span style={{ fontWeight:700, fontSize:14 }}>Causal-ICU</span>
          <span style={{ color:"#374151", margin:"0 4px" }}>/</span>
          <span style={{ color:"#6b7280", fontSize:12 }}>ICU Triage Board</span>
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {critical.length>0&&<span style={{ fontSize:10, padding:"3px 10px", borderRadius:6, background:"rgba(239,68,68,0.12)", color:"#f87171", border:"1px solid rgba(239,68,68,0.3)", fontWeight:600 }}>🔴 {critical.length} Critical</span>}
          {highRisk.length>0&&<span style={{ fontSize:10, padding:"3px 10px", borderRadius:6, background:"rgba(245,158,11,0.1)", color:"#fbbf24", border:"1px solid rgba(245,158,11,0.25)", fontWeight:600 }}>🟡 {highRisk.length} High Risk</span>}
          {moderate.length>0&&<span style={{ fontSize:10, padding:"3px 10px", borderRadius:6, background:"rgba(16,185,129,0.08)", color:"#34d399", border:"1px solid rgba(16,185,129,0.2)", fontWeight:600 }}>🟢 {moderate.length} Moderate</span>}
          <span style={{ fontSize:12, color:"#6b7280" }}>Dr. {name||role}</span>
        </div>
      </div>
      <div style={{ maxWidth:1080, margin:"0 auto", padding:"28px 24px" }}>
        <div style={{ background:"rgba(129,140,248,0.05)", border:"1px solid rgba(129,140,248,0.14)", borderRadius:12, padding:"14px 20px", marginBottom:24, display:"flex", gap:14, alignItems:"center" }}>
          <span style={{ fontSize:24 }}>🏥</span>
          <div>
            <div style={{ fontSize:14, fontWeight:700, color:"#e5e7eb", marginBottom:3 }}>Select a patient to begin treatment</div>
            <div style={{ fontSize:12, color:"#9ca3af", lineHeight:1.65 }}>Every patient below has septic shock. Watch their vitals hour by hour, then decide when to switch from IV fluids to vasopressors. The AI shows you the optimal moment — and what happens if you're too early, too late, or miss the window entirely.</div>
          </div>
        </div>
        {[["CRITICAL","Immediate Decision Required","#ef4444",critical],["HIGH RISK","Monitor Closely","#fbbf24",highRisk],["MODERATE","Stable But Watch","#34d399",moderate]].map(([lvl,sub,col,pts])=>pts.length>0&&(
          <div key={lvl} style={{ marginBottom:22 }}>
            <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:11 }}>
              <div style={{ width:8, height:8, borderRadius:"50%", background:col, animation:lvl==="CRITICAL"?"pulse 1.5s infinite":"none" }}/>
              <span style={{ fontSize:11, fontWeight:700, color:col, textTransform:"uppercase", letterSpacing:"0.12em" }}>{lvl} — {sub}</span>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(420px,1fr))", gap:11 }}>
              {pts.map(p=><Card key={p.id} p={p}/>)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MAIN DASHBOARD
// ═══════════════════════════════════════════════════════════════════
export default function App() {
  const [allPatients,   setAllPatients]   = useState([]);
  const [dataSource,    setDataSource]    = useState("loading");
  const [screen,        setScreen]        = useState("login");
  const [selected,      setSelected]      = useState(null);
  const [vitalsHist,    setVitalsHist]    = useState([]);
  const [currentHour,   setCurrentHour]   = useState(0);
  const [simRunning,    setSimRunning]    = useState(false);
  const [simDone,       setSimDone]       = useState(false);
  const [speedMs,       setSpeedMs]       = useState(800);
  const [alertDismissed,setAlertDismissed]= useState(false);
  const [activeTab,     setActiveTab]     = useState("twin");
  const [paramModal,    setParamModal]    = useState(null);
  const [controlMode,   setControlMode]  = useState("idle");
  const [lastDiff,      setLastDiff]      = useState(null);

  // Decision state — the ONLY thing that changes survival %
  const [decision,      setDecision]      = useState(null); // {hour, treatment:"vasopressors"|"fluids"}
  const [simResult,     setSimResult]     = useState(null);

  const intervalRef = useRef(null);

  // ── Load data ──────────────────────────────────────────────────
  useEffect(() => {
    fetch("/patients.json")
      .then(r=>{ if(!r.ok) throw new Error(); return r.json(); })
      .then(d=>{ setAllPatients(d.patients); setDataSource("mimic"); })
      .catch(()=>{
        const FB = [
          { id:"P-0041", name:"Male, 67 yrs",   age:67, diagnosis:"Septic shock",  sofa:11, lactate:4.2, map:58, hr:118, spo2:94, urine:28, creatinine:1.8, weight:72, survived:true,  total_hours:24 },
          { id:"P-0078", name:"Female, 54 yrs", age:54, diagnosis:"Severe sepsis", sofa:7,  lactate:2.4, map:63, hr:104, spo2:96, urine:38, creatinine:1.1, weight:65, survived:true,  total_hours:24 },
          { id:"P-0112", name:"Male, 72 yrs",   age:72, diagnosis:"Septic shock",  sofa:14, lactate:6.8, map:48, hr:132, spo2:91, urine:12, creatinine:2.9, weight:80, survived:false, total_hours:22 },
          { id:"P-0155", name:"Female, 81 yrs", age:81, diagnosis:"Septic shock",  sofa:13, lactate:5.1, map:52, hr:124, spo2:92, urine:16, creatinine:2.6, weight:58, survived:false, total_hours:24 },
          { id:"P-0019", name:"Male, 58 yrs",   age:58, diagnosis:"Septic shock",  sofa:9,  lactate:3.4, map:61, hr:112, spo2:95, urine:26, creatinine:1.4, weight:74, survived:true,  total_hours:24 },
          { id:"P-0031", name:"Female, 44 yrs", age:44, diagnosis:"Severe sepsis", sofa:6,  lactate:2.1, map:66, hr:98,  spo2:97, urine:42, creatinine:0.9, weight:61, survived:true,  total_hours:24 },
        ];
        const bv = p => {
          const seed = p.sofa*13+p.lactate*7+p.map;
          const n=(h,a)=>a*(Math.sin(seed+h*1.7)*0.45);
          let map=p.map,lac=p.lactate,hr=p.hr,spo2=p.spo2,urine=p.urine;
          let temp=38.5+Math.sin(seed)*0.6;
          const pivot = computePivot(p);
          let vasoOn=false;
          return Array.from({length:p.total_hours},(_,h)=>{
            if(p.survived && h>=pivot) vasoOn=true;
            if(vasoOn){
              map=Math.min(88,map+1.6+n(h,1.0)); lac=Math.max(0.8,lac-0.14+n(h,0.03));
              hr=Math.max(68,hr-1.2+n(h,2)); spo2=Math.min(100,spo2+0.1+n(h,0.3));
              urine=Math.min(80,urine+1.5+n(h,4)); temp=Math.max(36.8,temp-0.08+n(h,0.05));
            } else if(p.survived&&!vasoOn) {
              map=Math.min(82,map+0.7+n(h,1.5)); lac=Math.max(1.0,lac-0.09+n(h,0.04));
              hr=Math.max(72,hr-0.7+n(h,2)); spo2=Math.min(99,spo2+0.05+n(h,0.2));
              urine=Math.min(60,urine+0.5+n(h,3)); temp=Math.max(37.0,temp-0.04+n(h,0.05));
            } else {
              const dr=0.5+(p.sofa-10)*0.08;
              map=Math.max(28,map-dr*0.8+n(h,3)); lac=Math.min(18,lac+dr*0.22+n(h,0.15));
              hr=h<16?Math.min(155,hr+dr*0.6+n(h,3)):Math.max(35,hr-4+n(h,4));
              spo2=Math.max(72,spo2-0.35+n(h,0.4)); urine=Math.max(0,urine-1.2+n(h,2));
              temp=h<12?Math.min(40.2,temp+0.06+n(h,0.08)):Math.max(34.5,temp-0.12+n(h,0.1));
            }
            return{ hour:h, label:`H${h}`,
              map:Math.round(Math.max(25,map)), lactate:+Math.max(0.3,lac).toFixed(2),
              hr:Math.round(Math.max(20,Math.min(180,hr))), spo2:Math.round(Math.max(70,Math.min(100,spo2))),
              urine:Math.round(Math.max(0,urine)), creatinine:+Math.max(0.5,p.creatinine+(vasoOn?-h*0.01:h*0.04)).toFixed(1),
              sys_bp:Math.round(Math.max(40,map*1.38)), temp:+Math.max(33,Math.min(41,temp)).toFixed(1),
              rr:Math.round(Math.max(8,Math.min(40,18+(lac>4?4:lac>2?2:0)+n(h,2)))),
              fluid_ml:vasoOn?0:Math.round(280+n(h,80)), vaso_dose:vasoOn?+(0.08+h*0.003).toFixed(3):0,
            };
          });
        };
        setAllPatients(FB.map(p=>({...p,vitals:bv(p)})));
        setDataSource("synthetic");
      });
  }, []);

  // ── Reset on patient change ────────────────────────────────────
  useEffect(() => {
    if (!selected) return;
    clearInterval(intervalRef.current);
    setSimRunning(false); setSimDone(false); setCurrentHour(0);
    setVitalsHist([selected.vitals[0]]);
    setAlertDismissed(false); setActiveTab("twin");
    setControlMode("idle"); setLastDiff(null);
    setDecision(null); setSimResult(null);
  }, [selected?.id]);

  // ── Derived values ─────────────────────────────────────────────
  const cf         = selected ? computeCounterfactuals(selected) : null;
  const pivotHour  = cf?.pivotHour ?? 10;
  const noReturn   = cf?.noReturn  ?? 10;
  const noReturnH  = cf?.noReturnH ?? 20;
  const cfData     = cf?.data ?? [];
  const subgroup   = selected ? getSubgroup(selected) : null;
  const curVital   = vitalsHist[vitalsHist.length-1] ?? selected;
  const prevVital  = vitalsHist[vitalsHist.length-2] ?? null;
  const curCF      = cfData[Math.min(currentHour,23)] ?? {};
  const pivotPassed = currentHour >= pivotHour;
  const pastNoReturn= currentHour >= noReturnH;
  const showAlert  = pivotPassed && !alertDismissed && !decision;

  // Decision-driven survival — ONLY changes when doctor decides
  const decisionSurvival = (() => {
    if (!cf || !decision) return null;
    const startHour = decision.treatment === "vasopressors" ? decision.hour : null;
    const base      = fluidsOnly(selected, pivotHour, decision.hour);
    const delta     = survivalDelta(startHour, pivotHour, noReturn);
    return Math.max(0.03, Math.min(0.97, base + delta));
  })();

  // Survival numbers for comparison cards — these are PROJECTIONS ("if you act now")
  const survNow    = cf ? vasoAtHour(selected, pivotHour, 23, currentHour)    : 0;
  const survOptimal= cf ? vasoAtHour(selected, pivotHour, 23, pivotHour)      : 0;
  const survFluids = cf ? fluidsOnly(selected, pivotHour, 23)                 : 0;
  const survNoRet  = cf ? vasoAtHour(selected, pivotHour, 23, noReturnH)      : 0;

  const delayCost = cf && currentHour > pivotHour ? parseFloat(Math.max(0,
    (vasoAtHour(selected,pivotHour,23,currentHour) - vasoAtHour(selected,pivotHour,23,Math.min(23,currentHour+1)))*100
  ).toFixed(1)) : 0;

  const xaiFeatures = selected ? explainSurvival(curVital, selected, currentHour, pivotHour) : [];
  const whyModel    = selected ? whyNotJustMAP(selected, curVital, pivotHour, currentHour) : [];

  // ── Playback controls ──────────────────────────────────────────
  function runSim() {
    if (!selected) return;
    clearInterval(intervalRef.current);
    let h = simDone ? 0 : currentHour;
    if (simDone) {
      setCurrentHour(0); setVitalsHist([selected.vitals[0]]);
      setAlertDismissed(false); setDecision(null); setSimResult(null);
    }
    setSimRunning(true); setSimDone(false); setActiveTab("twin"); setControlMode("play"); setLastDiff(null);
    intervalRef.current = setInterval(() => {
      h++;
      if (!selected.vitals[h] || h >= selected.vitals.length-1) {
        clearInterval(intervalRef.current);
        setSimRunning(false); setSimDone(true); setControlMode("idle");
        setTimeout(()=>setActiveTab("counterfactual"),600);
        return;
      }
      setVitalsHist(prev=>[...prev, selected.vitals[h]]);
      setCurrentHour(h);
    }, speedMs);
  }

  function stepFwd() {
    if (!selected||simRunning) return;
    const nextH = currentHour+1;
    if (nextH >= selected.vitals.length) return;
    clearInterval(intervalRef.current);
    setSimRunning(false); setControlMode("manual");
    const before=selected.vitals[currentHour], after=selected.vitals[nextH];
    const cfB=cfData[currentHour]??{}, cfA=cfData[nextH]??{};
    setLastDiff({ fromHour:currentHour, toHour:nextH,
      before:{map:before.map,lactate:before.lactate,hr:before.hr,spo2:before.spo2},
      after: {map:after.map, lactate:after.lactate, hr:after.hr, spo2:after.spo2},
      iteBefore:cfB.ite??0, iteAfter:cfA.ite??0,
      survBefore:cfB.vasopressors??0, survAfter:cfA.vasopressors??0,
      pivotCrossed:(cfB.ite??0)<=0.05&&(cfA.ite??0)>0.05,
    });
    setCurrentHour(nextH);
    setVitalsHist(prev=>[...prev,after]);
  }

  function stepBack() {
    if (!selected||simRunning||currentHour<=0) return;
    clearInterval(intervalRef.current); setSimRunning(false); setControlMode("manual");
    setCurrentHour(h=>h-1); setVitalsHist(prev=>prev.slice(0,-1)); setLastDiff(null);
  }

  function stopSim() { clearInterval(intervalRef.current); setSimRunning(false); setControlMode("idle"); }

  // ── Treatment decision — the only thing that updates survival ──
  function makeDecision(treatment) {
    if (!selected) return;
    const startHour = treatment === "vasopressors" ? currentHour : null;
    const timing    = classifyTiming(startHour, pivotHour, noReturn);
    const traj      = projectVitals(curVital, selected, startHour, pivotHour, noReturn);
    setDecision({ hour: currentHour, treatment });
    setAlertDismissed(true);
    setSimResult({ treatment, decisionHour: currentHour, timing, traj });
    setActiveTab("ite");
  }

  // ── Screens ────────────────────────────────────────────────────
  if (dataSource === "loading") return (
    <div style={{ background:"#080b12", minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", color:"#6b7280", fontFamily:"sans-serif" }}>Loading…</div>
  );

  if (screen === "login" || !selected) return (
    <>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>
      <LoginScreen patients={allPatients} dataSource={dataSource} onSelect={p=>{setSelected(p);setScreen("dashboard");}}/>
    </>
  );

  // Status badge for header
  const statusBadge = (() => {
    const v = curVital;
    if (decision && simResult?.timing.category === "no_return") return { text:"💀 POINT OF NO RETURN", col:"#fca5a5", bg:"rgba(127,29,29,0.4)", border:"rgba(239,68,68,0.5)" };
    if (v?.map < 35 || (v?.hr < 30 && currentHour > 3)) return { text:"💀 PATIENT CODING", col:"#fca5a5", bg:"rgba(127,29,29,0.4)", border:"rgba(239,68,68,0.5)" };
    if (pastNoReturn && !decision) return { text:"⚠ PAST POINT OF NO RETURN", col:"#fca5a5", bg:"rgba(127,29,29,0.35)", border:"rgba(239,68,68,0.45)" };
    if (pivotPassed && !decision) return { text:"🔴 SWITCH TO VASOPRESSORS NOW", col:"#f87171", bg:"rgba(239,68,68,0.15)", border:"rgba(239,68,68,0.35)" };
    if (decision?.treatment==="vasopressors" && simResult?.timing.category==="optimal") return { text:"✅ VASOPRESSORS — OPTIMAL TIMING", col:"#34d399", bg:"rgba(16,185,129,0.12)", border:"rgba(16,185,129,0.3)" };
    if (decision) return { text:"💉 VASOPRESSORS STARTED", col:"#818cf8", bg:"rgba(129,140,248,0.12)", border:"rgba(129,140,248,0.3)" };
    if (currentHour > 0) return { text:"🟢 ALIVE — MONITORING", col:"#34d399", bg:"rgba(16,185,129,0.1)", border:"rgba(16,185,129,0.25)" };
    return null;
  })();

  return (
    <div style={{ width:"100vw", height:"100vh", background:"#080b12", fontFamily:"'IBM Plex Sans',sans-serif", color:"#e5e7eb", overflow:"hidden", display:"flex", flexDirection:"column" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#0f1117}::-webkit-scrollbar-thumb{background:#374151;border-radius:2px}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.7}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        @keyframes ping{0%{transform:scale(1);opacity:1}100%{transform:scale(2.4);opacity:0}}
        .prow:hover{background:rgba(99,102,241,0.07)!important;cursor:pointer}
        .tab-btn{background:none;border:none;padding:8px 14px;cursor:pointer;font-size:12px;font-family:inherit;transition:color .15s;white-space:nowrap}
        .sbtn{border:none;padding:12px 0;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;flex:1;transition:all .18s}
        .sbtn:hover{transform:translateY(-1px);opacity:0.92}
        .cbtn{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);color:#9ca3af;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-family:inherit;transition:all .15s}
        .cbtn:hover{background:rgba(255,255,255,0.08);color:#e5e7eb}
        .cbtn:disabled{opacity:0.3;cursor:not-allowed}
      `}</style>

      {paramModal && <ParamModal paramKey={paramModal} onClose={()=>setParamModal(null)}/>}

      {/* ── Alert banner — ONLY shows at pivot, before any decision ── */}
      {showAlert && (
        <div style={{ background:"linear-gradient(90deg,#7f1d1d,#991b1b)", borderBottom:"1px solid #ef4444", padding:"11px 24px", display:"flex", alignItems:"center", gap:14, flexShrink:0 }}>
          <div style={{ position:"relative", width:14, height:14, flexShrink:0 }}>
            <div style={{ position:"absolute", inset:0, borderRadius:"50%", background:"#fca5a5", animation:"ping 1s infinite" }}/>
            <div style={{ position:"absolute", inset:"3px", borderRadius:"50%", background:"#ef4444" }}/>
          </div>
          <div style={{ flex:1, fontSize:13, color:"#fff" }}>
            <strong>PIVOT DETECTED — Hour {currentHour}</strong>
            {" · "}Vasopressors now: <strong style={{ color:"#86efac" }}>{Math.round(survNow*100)}%</strong>
            {" · "}Optimal was H{pivotHour}: <strong style={{ color:"#86efac" }}>{Math.round(survOptimal*100)}%</strong>
            {" · "}Fluids only: <strong style={{ color:"#f87171" }}>{Math.round(survFluids*100)}%</strong>
            {" · "}Delay cost: <strong style={{ color:"#fca5a5" }}>−{delayCost}%/hr</strong>
          </div>
          <button onClick={()=>setAlertDismissed(true)} style={{ background:"rgba(255,255,255,0.1)", border:"1px solid rgba(255,255,255,0.2)", color:"#fca5a5", padding:"3px 10px", borderRadius:5, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>
            Dismiss
          </button>
        </div>
      )}

      {/* ── Header ── */}
      <div style={{ borderBottom:"1px solid rgba(255,255,255,0.06)", height:50, padding:"0 22px", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:22, height:22, background:"linear-gradient(135deg,#4f46e5,#7c3aed)", borderRadius:6, display:"flex", alignItems:"center", justifyContent:"center", fontSize:10 }}>⚕</div>
          <span style={{ fontWeight:700, fontSize:13 }}>Causal-ICU</span>
          <span style={{ color:"#374151", margin:"0 4px" }}>/</span>
          <span style={{ color:"#9ca3af", fontSize:12 }}>{selected.id} · {selected.name} · {selected.diagnosis}</span>
          {statusBadge && (
            <span style={{ fontSize:11, padding:"3px 10px", borderRadius:6, background:statusBadge.bg, color:statusBadge.col, border:`1px solid ${statusBadge.border}`, fontWeight:700 }}>
              {statusBadge.text}
            </span>
          )}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:10, padding:"3px 10px", borderRadius:6, background:dataSource==="mimic"?"rgba(16,185,129,0.1)":"rgba(245,158,11,0.1)", color:dataSource==="mimic"?"#34d399":"#fbbf24", border:`1px solid ${dataSource==="mimic"?"rgba(16,185,129,0.25)":"rgba(245,158,11,0.25)"}` }}>
            {dataSource==="mimic"?"● MIMIC-III":"● Synthetic"}
          </span>
          <button onClick={()=>{setScreen("login");setSelected(null);}} className="cbtn">← Patients</button>
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ display:"grid", gridTemplateColumns:"230px 1fr", flex:1, overflow:"hidden" }}>

        {/* SIDEBAR */}
        <div style={{ borderRight:"1px solid rgba(255,255,255,0.06)", padding:"10px 8px", overflowY:"auto", display:"flex", flexDirection:"column", gap:3, background:"rgba(0,0,0,0.12)" }}>
          <div style={{ fontSize:9, letterSpacing:"0.12em", color:"#4b5563", textTransform:"uppercase", marginBottom:4, paddingLeft:4 }}>ICU Patients</div>
          {allPatients.map(p=>(
            <div key={p.id} className="prow" onClick={()=>setSelected(p)}
              style={{ padding:"8px 10px", borderRadius:8, background:selected.id===p.id?"rgba(99,102,241,0.12)":"transparent", border:selected.id===p.id?"1px solid rgba(99,102,241,0.35)":"1px solid transparent" }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:2 }}>
                <span style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:"#818cf8" }}>{p.id}</span>
                <span style={{ fontSize:9, padding:"1px 5px", borderRadius:3, background:p.sofa>=11?"rgba(239,68,68,0.15)":"rgba(245,158,11,0.15)", color:p.sofa>=11?"#f87171":"#fbbf24" }}>S{p.sofa}</span>
              </div>
              <div style={{ fontSize:10, color:"#9ca3af" }}>{p.name}</div>
              <div style={{ fontSize:9, color:"#4b5563" }}>{p.diagnosis}</div>
            </div>
          ))}

          <div style={{ height:1, background:"rgba(255,255,255,0.05)", margin:"6px 0" }}/>

          {/* Baseline */}
          <div style={{ padding:"10px 12px", background:"rgba(255,255,255,0.02)", borderRadius:9, border:"1px solid rgba(255,255,255,0.05)" }}>
            <div style={{ fontSize:9, color:"#4b5563", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:7 }}>Admission Baseline</div>
            {[["Lactate",selected.lactate,"mmol/L","lactate"],["MAP",selected.map,"mmHg","map"],["SOFA",selected.sofa,"/24","sofa"],["Creatinine",selected.creatinine,"mg/dL","creatinine"]].map(([l,v,u,k])=>(
              <div key={l} style={{ display:"flex", justifyContent:"space-between", marginBottom:5, cursor:"pointer" }} onClick={()=>setParamModal(k)}>
                <span style={{ fontSize:10, color:"#6b7280" }}>{l} <span style={{ color:"#374151" }}>ⓘ</span></span>
                <span style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:"#e5e7eb" }}>{v} <span style={{ color:"#4b5563" }}>{u}</span></span>
              </div>
            ))}
            {subgroup && (
              <div style={{ marginTop:6, padding:"6px 8px", borderRadius:7, background:`${subgroup.color}12`, border:`1px solid ${subgroup.color}25` }}>
                <div style={{ fontSize:9, color:subgroup.color, marginBottom:1 }}>{subgroup.tag}</div>
                <div style={{ fontSize:9, color:"#4b5563" }}>{subgroup.desc}</div>
              </div>
            )}
          </div>

          {/* Pivot summary */}
          <div style={{ padding:"10px 12px", background:"rgba(129,140,248,0.05)", borderRadius:9, border:"1px solid rgba(129,140,248,0.15)" }}>
            <div style={{ fontSize:9, color:"#818cf8", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:6 }}>AI Pivot Analysis</div>
            <div style={{ fontSize:10, color:"#9ca3af", lineHeight:1.7 }}>
              Optimal window: <strong style={{ color:"#10b981" }}>H{Math.max(0,pivotHour-PIVOT_WINDOW)}–H{pivotHour+PIVOT_WINDOW}</strong><br/>
              Point of no return: <strong style={{ color:"#ef4444" }}>H{noReturnH}</strong><br/>
              Now: <strong style={{ color:"#818cf8" }}>H{currentHour}</strong>{" · "}
              {currentHour < pivotHour ? <span style={{ color:"#f59e0b" }}>{pivotHour-currentHour}h before pivot</span>
               : currentHour <= pivotHour+PIVOT_WINDOW ? <span style={{ color:"#10b981" }}>In optimal window</span>
               : currentHour < noReturnH ? <span style={{ color:"#f59e0b" }}>{currentHour-pivotHour}h past pivot</span>
               : <span style={{ color:"#ef4444" }}>Past no-return</span>}
            </div>
          </div>

          {/* Playback */}
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"8px 12px", background:"rgba(255,255,255,0.03)", borderRadius:9, border:"1px solid rgba(255,255,255,0.07)" }}>
              <span style={{ fontSize:10, color:"#6b7280" }}>Hour</span>
              <span style={{ fontFamily:"'DM Mono',monospace", fontSize:20, color:"#818cf8", fontWeight:700 }}>H{currentHour}</span>
              <div style={{ width:6, height:6, borderRadius:"50%", background:controlMode==="play"?"#10b981":controlMode==="manual"?"#f59e0b":"#374151", animation:controlMode==="play"?"pulse 1.5s infinite":"none" }}/>
            </div>
            {/* Progress bar with pivot + no-return markers */}
            <div style={{ height:4, background:"rgba(255,255,255,0.06)", borderRadius:2, overflow:"hidden", position:"relative" }}>
              <div style={{ height:"100%", background:"linear-gradient(90deg,#4f46e5,#7c3aed)", width:`${(currentHour/Math.max(selected.total_hours-1,1))*100}%`, transition:"width .3s", borderRadius:2 }}/>
              <div style={{ position:"absolute", top:0, bottom:0, left:`${(pivotHour/Math.max(selected.total_hours-1,1))*100}%`, width:2, background:"#10b981", opacity:0.9 }}/>
              <div style={{ position:"absolute", top:0, bottom:0, left:`${(noReturnH/Math.max(selected.total_hours-1,1))*100}%`, width:2, background:"#ef4444", opacity:0.9 }}/>
            </div>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:8, color:"#4b5563" }}>
              <span>🟢 Pivot H{pivotHour}</span><span>🔴 No-return H{noReturnH}</span>
            </div>

            <div style={{ padding:"10px 12px", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:9 }}>
              <div style={{ fontSize:9, color:"#4b5563", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:6 }}>▶ Auto-play</div>
              <div style={{ display:"flex", gap:6, alignItems:"center", marginBottom:6 }}>
                <span style={{ fontSize:10, color:"#6b7280", flexShrink:0 }}>Speed</span>
                <input type="range" min="200" max="2000" step="200" value={speedMs} onChange={e=>setSpeedMs(+e.target.value)} style={{ flex:1, accentColor:"#818cf8" }} disabled={controlMode==="play"}/>
                <span style={{ fontSize:10, color:"#4b5563", minWidth:28 }}>{speedMs/1000}s</span>
              </div>
              <button onClick={simRunning?stopSim:runSim}
                style={{ background:simRunning?"linear-gradient(135deg,#dc2626,#991b1b)":"linear-gradient(135deg,#4f46e5,#7c3aed)", border:"none", color:"#fff", padding:"9px 0", borderRadius:8, fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit", width:"100%" }}>
                {simRunning?"⏹ Stop":simDone?"↺ Replay":currentHour>0?`▶ Resume H${currentHour}`:"▶ Play all hours"}
              </button>
            </div>
            <div style={{ padding:"10px 12px", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:9 }}>
              <div style={{ fontSize:9, color:"#4b5563", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:6 }}>⏩ Manual step</div>
              <div style={{ display:"flex", gap:6 }}>
                <button onClick={stepBack} disabled={simRunning||currentHour<=0} className="cbtn" style={{ flex:1 }}>← Back</button>
                <button onClick={stepFwd} disabled={simRunning||currentHour>=selected.total_hours-1} className="cbtn"
                  style={{ flex:2, background:"rgba(245,158,11,0.1)", borderColor:"rgba(245,158,11,0.3)", color:"#fbbf24", fontWeight:700 }}>
                  +1h → H{currentHour+1}
                </button>
              </div>
            </div>
          </div>

          {decision && (
            <div style={{ padding:"10px 12px", background:`${simResult?.timing.color}0f`, border:`1px solid ${simResult?.timing.color}30`, borderRadius:9 }}>
              <div style={{ fontSize:9, color:simResult?.timing.color, textTransform:"uppercase", marginBottom:3 }}>Decision Made at H{decision.hour}</div>
              <div style={{ fontSize:10, color:"#e5e7eb", lineHeight:1.6 }}>{simResult?.timing.label}</div>
              {decisionSurvival !== null && (
                <div style={{ fontFamily:"'DM Mono',monospace", fontSize:22, fontWeight:700, color:simResult?.timing.color, marginTop:5 }}>
                  {Math.round(decisionSurvival*100)}% survival
                </div>
              )}
              <button onClick={()=>{setDecision(null);setSimResult(null);setAlertDismissed(false);}} style={{ marginTop:6, background:"none", border:"1px solid rgba(255,255,255,0.1)", color:"#6b7280", padding:"3px 8px", borderRadius:5, cursor:"pointer", fontSize:9, fontFamily:"inherit" }}>
                ↺ Reset decision
              </button>
            </div>
          )}
        </div>

        {/* MAIN PANEL */}
        <div style={{ padding:"16px 20px", overflowY:"auto", display:"flex", flexDirection:"column", gap:12 }}>

          {/* Patient narrative */}
          <div style={{ background:pivotPassed?"rgba(239,68,68,0.06)":"rgba(129,140,248,0.05)", border:`1px solid ${pivotPassed?"rgba(239,68,68,0.22)":"rgba(129,140,248,0.15)"}`, borderRadius:11, padding:"13px 16px", display:"flex", gap:12, alignItems:"flex-start" }}>
            <span style={{ fontSize:20, flexShrink:0 }}>{pastNoReturn?"⚰️":pivotPassed?"⚠️":"🩺"}</span>
            <div>
              <div style={{ fontSize:11, color:pastNoReturn?"#f87171":pivotPassed?"#fbbf24":"#818cf8", textTransform:"uppercase", letterSpacing:"0.09em", fontWeight:700, marginBottom:5 }}>
                {pastNoReturn?"Past Point of No Return":pivotPassed?"Critical — Pivot Passed":`Hour ${currentHour} — Patient Status`}
              </div>
              {currentHour === 0 ? (
                <div style={{ fontSize:13, color:"#9ca3af" }}>{selected.name} admitted with {selected.diagnosis.toLowerCase()}. MAP {selected.map} mmHg, lactate {selected.lactate} mmol/L. Press ▶ Play to watch vitals evolve. The optimal vasopressor window is H{Math.max(0,pivotHour-PIVOT_WINDOW)}–H{pivotHour+PIVOT_WINDOW}. After H{noReturnH} it's too late.</div>
              ) : pastNoReturn && !decision ? (
                <div style={{ fontSize:13, color:"#fca5a5" }}>H{noReturnH} has passed. Prolonged hypoperfusion has caused irreversible AKI and myocardial depression. Vasopressors started now will give <strong>{Math.round(survNow*100)}%</strong> survival — <em>lower than fluids-only</em> ({Math.round(survFluids*100)}%) because damaged vessels can no longer respond normally.</div>
              ) : pivotPassed && !decision ? (
                <div style={{ fontSize:13, color:"#e5e7eb" }}>
                  <span style={{ color:"#fbbf24" }}>MAP has been low for {currentHour-pivotHour} hours past the optimal switch point.</span>{" "}
                  AKI is developing. Each additional hour on fluids costs −{delayCost}% survival.{" "}
                  Vasopressors now: <strong style={{ color:"#10b981" }}>{Math.round(survNow*100)}%</strong> · Optimal H{pivotHour} was: <strong style={{ color:"#818cf8" }}>{Math.round(survOptimal*100)}%</strong> · Fluids only: <strong style={{ color:"#ef4444" }}>{Math.round(survFluids*100)}%</strong>
                </div>
              ) : decision ? (
                <div style={{ fontSize:13, color:"#e5e7eb" }}>
                  {simResult?.timing.why}
                </div>
              ) : (
                <div style={{ fontSize:13, color:"#9ca3af" }}>
                  {currentHour < pivotHour
                    ? `IV fluids appropriate — ${pivotHour-currentHour}h until optimal vasopressor window (H${pivotHour}). MAP ${curVital?.map} mmHg, lactate ${curVital?.lactate}.`
                    : `Within optimal window. Vasopressors now give ${Math.round(survNow*100)}% survival.`
                  }
                </div>
              )}
            </div>
          </div>

          {/* Vitals */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8 }}>
            {[
              { label:"Mean Art. Pressure", val:curVital?.map??selected.map,        prev:prevVital?.map,     unit:"mmHg",   ok:v=>v>=65, warn:v=>v>=55, key:"map"     },
              { label:"Lactate",            val:curVital?.lactate??selected.lactate, prev:prevVital?.lactate, unit:"mmol/L", ok:v=>v<=2,  warn:v=>v<=4,  key:"lactate" },
              { label:"Heart Rate",         val:curVital?.hr??selected.hr,           prev:prevVital?.hr,      unit:"bpm",    ok:v=>v<=100,warn:v=>v<=120,key:"hr"      },
              { label:"SpO₂",               val:curVital?.spo2??selected.spo2,       prev:prevVital?.spo2,    unit:"%",      ok:v=>v>=96, warn:v=>v>=93, key:"spo2"    },
            ].map(({ label,val,prev,unit,ok,warn,key })=>{
              const status=ok(val)?"normal":warn(val)?"warning":"critical";
              const delta=prev!==undefined?Math.round((val-prev)*10)/10:undefined;
              return <VitalCard key={label} label={label} value={val} unit={unit} status={status} delta={delta} paramKey={key} onInfo={setParamModal} history={vitalsHist}/>;
            })}
          </div>
          {(curVital?.sys_bp||curVital?.rr||curVital?.temp) && (
            <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8 }}>
              {[
                { label:"Systolic BP",  val:curVital?.sys_bp,               unit:"mmHg",ok:v=>v>=90,warn:v=>v>=80 },
                { label:"Resp. Rate",   val:curVital?.rr,                   unit:"/min",ok:v=>v<=20,warn:v=>v<=28 },
                { label:"Temperature",  val:curVital?.temp,                 unit:"°C",  ok:v=>v>=36&&v<=38.5,warn:v=>v>=35 },
                { label:"Urine Output", val:curVital?.urine??selected.urine,unit:"mL/hr",ok:v=>v>=30,warn:v=>v>=20,key:"urine"},
              ].map(({ label,val,unit,ok,warn,key })=>{
                if (!val && val!==0) return null;
                const status=ok(val)?"normal":warn(val)?"warning":"critical";
                return <VitalCard key={label} label={label} value={val} unit={unit} status={status} paramKey={key} onInfo={key?setParamModal:null} history={vitalsHist}/>;
              })}
            </div>
          )}
          <div style={{ fontSize:10, color:"#374151", textAlign:"right" }}>↑ Hover any card for plain-English explanation · Click for full clinical detail</div>

          {/* What changed (manual step) */}
          {controlMode==="manual" && lastDiff && (()=>{
            const ms=[
              { l:"MAP",     b:lastDiff.before.map,     a:lastDiff.after.map,     u:"mmHg",  ok:(a,b)=>a>b },
              { l:"Lactate", b:lastDiff.before.lactate, a:lastDiff.after.lactate, u:"mmol/L",ok:(a,b)=>a<b },
              { l:"HR",      b:lastDiff.before.hr,      a:lastDiff.after.hr,      u:"bpm",   ok:(a,b)=>a<b },
              { l:"SpO₂",    b:lastDiff.before.spo2,    a:lastDiff.after.spo2,    u:"%",     ok:(a,b)=>a>b },
              { l:"ITE",     b:Math.round(lastDiff.iteBefore*100), a:Math.round(lastDiff.iteAfter*100), u:"%",ok:(a,b)=>a>b },
              { l:"Best surv",b:Math.round(lastDiff.survBefore*100),a:Math.round(lastDiff.survAfter*100),u:"%",ok:(a,b)=>a>b },
            ];
            return (
              <div style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(245,158,11,0.2)", borderRadius:11, padding:"12px 14px", animation:"fadeIn 0.3s ease" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                  <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                    <span style={{ fontSize:11, fontWeight:700 }}>What changed</span>
                    <span style={{ fontFamily:"'DM Mono',monospace", fontSize:11, color:"#818cf8" }}>H{lastDiff.fromHour}→H{lastDiff.toHour}</span>
                    {lastDiff.pivotCrossed && <span style={{ fontSize:10, color:"#fca5a5", background:"rgba(239,68,68,0.15)", border:"1px solid rgba(239,68,68,0.3)", padding:"2px 8px", borderRadius:5 }}>PIVOT CROSSED</span>}
                  </div>
                  <button onClick={()=>setLastDiff(null)} style={{ background:"none", border:"none", color:"#4b5563", cursor:"pointer", fontSize:14 }}>✕</button>
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:7 }}>
                  {ms.map(m=>{
                    const d=parseFloat((m.a-m.b).toFixed(2));
                    const good=m.ok(m.a,m.b);
                    const col=d===0?"#6b7280":good?"#10b981":"#ef4444";
                    return (
                      <div key={m.l} style={{ background:d===0?"rgba(255,255,255,0.02)":good?"rgba(16,185,129,0.06)":"rgba(239,68,68,0.06)", border:`1px solid ${d===0?"rgba(255,255,255,0.06)":good?"rgba(16,185,129,0.18)":"rgba(239,68,68,0.18)"}`, borderRadius:8, padding:"9px 11px" }}>
                        <div style={{ fontSize:9, color:"#6b7280", marginBottom:4, textTransform:"uppercase" }}>{m.l}</div>
                        <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:3 }}>
                          <span style={{ fontFamily:"'DM Mono',monospace", fontSize:12, color:"#4b5563", textDecoration:"line-through" }}>{m.b}</span>
                          <span style={{ color:"#374151" }}>→</span>
                          <span style={{ fontFamily:"'DM Mono',monospace", fontSize:15, fontWeight:700, color:col }}>{m.a}</span>
                          <span style={{ fontSize:9, color:"#4b5563" }}>{m.u}</span>
                        </div>
                        <div style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:col, fontWeight:700 }}>{d>0?`+${d}`:d}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* ── SURVIVAL PANEL — decision-driven ── */}
          {currentHour > 0 && cf && (
            <div style={{ display:"flex", flexDirection:"column", gap:8, animation:"fadeIn 0.4s ease" }}>
              {/* Four-scenario comparison */}
              <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8 }}>
                {[
                  {
                    label: currentHour < pivotHour-PIVOT_WINDOW ? `⚠ Now (H${currentHour}) — Too Early`
                         : currentHour > noReturnH ? `💀 Now (H${currentHour}) — No Return`
                         : currentHour > pivotHour+PIVOT_WINDOW ? `⏰ Now (H${currentHour}) — Too Late`
                         : `✅ Now (H${currentHour}) — Optimal`,
                    val:Math.round(survNow*100),
                    sub: currentHour < pivotHour-PIVOT_WINDOW ? "Vasopressors would HARM"
                       : currentHour > noReturnH ? "Organs irreversibly damaged"
                       : currentHour > pivotHour+PIVOT_WINDOW ? `${currentHour-pivotHour}h past pivot`
                       : "Within optimal window",
                    col: currentHour < pivotHour-PIVOT_WINDOW ? "#ef4444"
                       : currentHour > noReturnH ? "#7f1d1d"
                       : currentHour > pivotHour+PIVOT_WINDOW ? "#f59e0b"
                       : "#10b981",
                    bg:  currentHour < pivotHour-PIVOT_WINDOW ? "rgba(239,68,68,0.08)"
                       : currentHour > noReturnH ? "rgba(127,29,29,0.15)"
                       : currentHour > pivotHour+PIVOT_WINDOW ? "rgba(245,158,11,0.07)"
                       : "rgba(16,185,129,0.09)",
                    border: currentHour < pivotHour-PIVOT_WINDOW ? "rgba(239,68,68,0.25)"
                          : currentHour > noReturnH ? "rgba(239,68,68,0.4)"
                          : currentHour > pivotHour+PIVOT_WINDOW ? "rgba(245,158,11,0.22)"
                          : "rgba(16,185,129,0.28)",
                  },
                  { label:`✅ Optimal H${pivotHour}`,          val:Math.round(survOptimal*100), sub:"Best possible outcome",            col:"#818cf8", bg:"rgba(129,140,248,0.07)", border:"rgba(129,140,248,0.2)" },
                  { label:`💧 Fluids only (never switch)`,    val:Math.round(survFluids*100),  sub:"Multi-organ failure route",        col:"#6b7280", bg:"rgba(255,255,255,0.03)", border:"rgba(255,255,255,0.08)" },
                  { label:`💀 After no-return H${noReturnH}`, val:Math.round(survNoRet*100),   sub:"Irreversible — lower than fluids", col:"#7f1d1d", bg:"rgba(127,29,29,0.12)",  border:"rgba(239,68,68,0.3)" },
                ].map(c=>(
                  <div key={c.label} style={{ background:c.bg, border:`1px solid ${c.border}`, borderRadius:11, padding:"12px 13px" }}>
                    <div style={{ fontSize:9, color:c.col, textTransform:"uppercase", marginBottom:4, lineHeight:1.4 }}>{c.label}</div>
                    <div style={{ fontFamily:"'DM Mono',monospace", fontSize:30, fontWeight:700, color:c.col, lineHeight:1 }}>{c.val}%</div>
                    <div style={{ fontSize:9, color:"#6b7280", marginTop:4 }}>{c.sub}</div>
                  </div>
                ))}
              </div>
              {/* Decision outcome — updates ONLY after a decision */}
              {decision && decisionSurvival !== null && (
                <div style={{ background:`${simResult?.timing.color}0f`, border:`2px solid ${simResult?.timing.color}40`, borderRadius:11, padding:"14px 16px", animation:"fadeIn 0.3s ease" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8 }}>
                    <div>
                      <div style={{ fontSize:12, fontWeight:700, color:simResult?.timing.color, marginBottom:3 }}>{simResult?.timing.label}</div>
                      <div style={{ fontSize:11, color:"#9ca3af", lineHeight:1.6, maxWidth:600 }}>{simResult?.timing.why}</div>
                    </div>
                    <div style={{ textAlign:"center", flexShrink:0, marginLeft:16 }}>
                      <div style={{ fontSize:9, color:"#6b7280", marginBottom:2 }}>Predicted 28-day survival</div>
                      <div style={{ fontFamily:"'DM Mono',monospace", fontSize:36, fontWeight:700, color:simResult?.timing.color, lineHeight:1 }}>
                        {Math.round(decisionSurvival*100)}%
                      </div>
                      <div style={{ fontSize:9, color:"#6b7280", marginTop:2 }}>
                        vs optimal: {Math.round(survOptimal*100)}% ({Math.round((survOptimal-decisionSurvival)*100) > 0 ? `−${Math.round((survOptimal-decisionSurvival)*100)}%` : "same"})
                      </div>
                    </div>
                  </div>
                  {/* Vital trajectory */}
                  <div style={{ borderTop:"1px solid rgba(255,255,255,0.07)", paddingTop:10 }}>
                    <div style={{ fontSize:9, color:"#6b7280", marginBottom:6 }}>Predicted vital trajectory — next 5 hours</div>
                    {[["MAP","map","mmHg"],["Lactate","lactate","mmol/L"],["HR","hr","bpm"],["Urine","urine","mL/hr"]].map(([n,k,u])=>(
                      <div key={k} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:5 }}>
                        <span style={{ fontSize:10, color:"#9ca3af", width:44, flexShrink:0 }}>{n}</span>
                        <div style={{ display:"flex", gap:5 }}>
                          {simResult.traj.map((t,i)=>(
                            <span key={i} style={{ fontFamily:"'DM Mono',monospace", fontSize:12, fontWeight:700, color:simResult?.timing.color }}>
                              {t[k]}{i<simResult.traj.length-1&&<span style={{ color:"#374151" }}> →</span>}
                            </span>
                          ))}
                        </div>
                        <span style={{ fontSize:9, color:"#4b5563" }}>{u}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Delay cost */}
              {pivotPassed && !pastNoReturn && (
                <div style={{ background:"rgba(239,68,68,0.06)", border:"1px solid rgba(239,68,68,0.2)", borderRadius:9, padding:"10px 14px", display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
                  <span style={{ fontSize:13, color:"#9ca3af" }}>Each additional hour on fluids costs</span>
                  <span style={{ fontFamily:"'DM Mono',monospace", fontSize:20, fontWeight:700, color:"#ef4444" }}>−{delayCost}%</span>
                  <span style={{ fontSize:13, color:"#9ca3af" }}>survival · ITE now:</span>
                  <span style={{ fontFamily:"'DM Mono',monospace", fontSize:16, color:"#818cf8", fontWeight:700 }}>{Math.round((curCF.ite??0)*100)}%</span>
                  <span style={{ fontSize:11, color:"#4b5563" }}>[{Math.round((curCF.ite_lower??0)*100)}–{Math.round((curCF.ite_upper??0)*100)}%]</span>
                </div>
              )}
              {pastNoReturn && !decision && (
                <div style={{ background:"rgba(127,29,29,0.15)", border:"1px solid rgba(239,68,68,0.4)", borderRadius:9, padding:"10px 14px" }}>
                  <div style={{ fontSize:12, color:"#fca5a5", fontWeight:700, marginBottom:3 }}>⚰️ Point of No Return Passed (H{noReturnH})</div>
                  <div style={{ fontSize:11, color:"#9ca3af", lineHeight:1.65 }}>Prolonged hypoperfusion has caused irreversible multi-organ damage. Starting vasopressors now gives only {Math.round(survNow*100)}% — <em>lower than fluids-only</em> ({Math.round(survFluids*100)}%). This is a clinical reality: vasopressors cannot reverse established end-organ failure.</div>
                </div>
              )}
            </div>
          )}

          {/* Treatment Simulator */}
          <div style={{ background:"rgba(255,255,255,0.02)", border:`1px solid ${pivotPassed?"rgba(245,158,11,0.22)":"rgba(255,255,255,0.07)"}`, borderRadius:11, padding:"14px 16px" }}>
            <div style={{ fontSize:12, fontWeight:700, marginBottom:3 }}>Treatment Simulator</div>
            <div style={{ fontSize:10, color:"#6b7280", marginBottom:10 }}>
              H{currentHour} · Pivot H{pivotHour} · No-return H{noReturnH} ·{" "}
              {currentHour < pivotHour-PIVOT_WINDOW
                ? <span style={{ color:"#ef4444" }}>⚠ Starting vasopressors NOW would HARM — patient still needs fluids ({pivotHour-currentHour}h to optimal window)</span>
                : currentHour > noReturnH
                ? <span style={{ color:"#7f1d1d" }}>💀 Past point of no return — vasopressors no longer effective</span>
                : currentHour > pivotHour+PIVOT_WINDOW
                ? <span style={{ color:"#f59e0b" }}>⏰ {currentHour-pivotHour}h past pivot — delayed but vasopressors still help</span>
                : <span style={{ color:"#10b981" }}>✅ Optimal window — start vasopressors now for best outcome</span>
              }
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <button className="sbtn" onClick={()=>makeDecision("fluids")} disabled={!!decision}
                style={{ background:decision?.treatment==="fluids"?"rgba(59,130,246,0.2)":"rgba(59,130,246,0.07)", border:`1px solid ${decision?.treatment==="fluids"?"#3b82f6":"rgba(59,130,246,0.2)"}`, color:decision?.treatment==="fluids"?"#93c5fd":"#6b9fd4", opacity:decision&&decision.treatment!=="fluids"?0.5:1 }}>
                💧 Continue IV Fluids Only
              </button>
              <button className="sbtn" onClick={()=>makeDecision("vasopressors")} disabled={!!decision}
                style={{
                  background: decision?.treatment==="vasopressors"
                    ? currentHour<pivotHour-PIVOT_WINDOW?"rgba(239,68,68,0.2)":currentHour>noReturnH?"rgba(127,29,29,0.25)":currentHour>pivotHour+PIVOT_WINDOW?"rgba(245,158,11,0.2)":"rgba(16,185,129,0.2)"
                    : currentHour<pivotHour-PIVOT_WINDOW?"rgba(239,68,68,0.07)":currentHour>noReturnH?"rgba(127,29,29,0.12)":currentHour>pivotHour+PIVOT_WINDOW?"rgba(245,158,11,0.07)":"rgba(16,185,129,0.07)",
                  border:`1px solid ${currentHour<pivotHour-PIVOT_WINDOW?"rgba(239,68,68,0.3)":currentHour>noReturnH?"rgba(239,68,68,0.4)":currentHour>pivotHour+PIVOT_WINDOW?"rgba(245,158,11,0.3)":"rgba(16,185,129,0.3)"}`,
                  color: currentHour<pivotHour-PIVOT_WINDOW?"#f87171":currentHour>noReturnH?"#fca5a5":currentHour>pivotHour+PIVOT_WINDOW?"#fbbf24":"#6ee7b7",
                  opacity: decision&&decision.treatment!=="vasopressors"?0.5:1,
                }}>
                💉 Start Vasopressors — H{currentHour}
              </button>
            </div>
            {decision && (
              <div style={{ marginTop:8, fontSize:10, color:"#6b7280" }}>Decision locked. Scroll up to see outcome, or reset using sidebar.</div>
            )}
          </div>

          {/* Tabs */}
          <div style={{ display:"flex", borderBottom:"1px solid rgba(255,255,255,0.06)", overflowX:"auto" }}>
            {[["twin","Digital Twin"],["counterfactual","Counterfactuals"],["ite","ITE Analysis"],["xai","AI Reasoning & XAI"],["guide","Parameter Guide"]].map(([id,label])=>(
              <button key={id} className="tab-btn" onClick={()=>setActiveTab(id)}
                style={{ color:activeTab===id?"#818cf8":"#6b7280", borderBottom:activeTab===id?"2px solid #818cf8":"2px solid transparent", paddingBottom:8, fontSize:12 }}>
                {label}
              </button>
            ))}
          </div>

          {/* ── DIGITAL TWIN ── */}
          {activeTab==="twin" && (
            <div style={{ animation:"fadeIn 0.3s ease", display:"flex", flexDirection:"column", gap:10 }}>
              <div style={{ fontSize:11, color:"#6b7280" }}>
                {simRunning?`Streaming — H${currentHour} of ${selected.total_hours-1}`:simDone?"Complete — full trajectory visible":"Press ▶ Play or +1h to step manually"}
              </div>
              <div style={{ background:"rgba(255,255,255,0.02)", borderRadius:11, border:"1px solid rgba(255,255,255,0.06)", padding:"12px 10px 6px" }}>
                <div style={{ fontSize:9, color:"#6b7280", marginBottom:5 }}>MAP (mmHg) — critical threshold 65 mmHg · Green line = pivot H{pivotHour} · Red line = no-return H{noReturnH}</div>
                <ResponsiveContainer width="100%" height={150}>
                  <AreaChart data={vitalsHist}>
                    <defs><linearGradient id="mg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#818cf8" stopOpacity={0.3}/><stop offset="95%" stopColor="#818cf8" stopOpacity={0}/></linearGradient></defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
                    <XAxis dataKey="label" tick={{ fontSize:8, fill:"#4b5563" }}/>
                    <YAxis domain={[25,110]} tick={{ fontSize:8, fill:"#4b5563" }}/>
                    <Tooltip content={<CTip/>}/>
                    <ReferenceLine y={65} stroke="#ef4444" strokeDasharray="4 4" label={{ value:"65 critical", fill:"#ef4444", fontSize:8 }}/>
                    <ReferenceLine x={`H${pivotHour}`}  stroke="#10b981" strokeDasharray="3 3" label={{ value:`Pivot H${pivotHour}`, fill:"#10b981", fontSize:8, position:"top" }}/>
                    <ReferenceLine x={`H${noReturnH}`}  stroke="#ef4444" strokeDasharray="3 3" label={{ value:`NoReturn H${noReturnH}`, fill:"#ef4444", fontSize:8, position:"top" }}/>
                    <Area type="monotone" dataKey="map" stroke="#818cf8" fill="url(#mg)" strokeWidth={2} dot={vitalsHist.length<10} name="MAP"/>
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8 }}>
                {[
                  { key:"lactate", label:"Lactate (mmol/L) — normal < 2.0", color:"#f59e0b", refY:2,   domain:[0,15]  },
                  { key:"hr",      label:"Heart Rate (bpm) — target < 100",  color:"#f87171", refY:100, domain:[30,170] },
                  { key:"urine",   label:"Urine Output (mL/hr) — target > 30",color:"#10b981",refY:30, domain:[0,200] },
                ].map(({ key,label,color,refY,domain })=>(
                  <div key={key} style={{ background:"rgba(255,255,255,0.02)", borderRadius:11, border:"1px solid rgba(255,255,255,0.06)", padding:"10px 8px 4px", cursor:"pointer" }} onClick={()=>setParamModal(key==="urine"?"urine":key)}>
                    <div style={{ fontSize:8, color:"#6b7280", marginBottom:4 }}>{label}</div>
                    <ResponsiveContainer width="100%" height={88}>
                      <AreaChart data={vitalsHist}>
                        <defs><linearGradient id={`g${key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={color} stopOpacity={0.25}/><stop offset="95%" stopColor={color} stopOpacity={0}/></linearGradient></defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)"/>
                        <XAxis dataKey="label" tick={{ fontSize:7, fill:"#4b5563" }}/>
                        <YAxis domain={domain} tick={{ fontSize:7, fill:"#4b5563" }}/>
                        <Tooltip content={<CTip/>}/>
                        <ReferenceLine y={refY} stroke={color} strokeDasharray="3 3" opacity={0.5}/>
                        <Area type="monotone" dataKey={key} stroke={color} fill={`url(#g${key})`} strokeWidth={1.8} dot={false} name={label}/>
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── COUNTERFACTUALS ── */}
          {activeTab==="counterfactual" && cf && (
            <div style={{ animation:"fadeIn 0.3s ease", display:"flex", flexDirection:"column", gap:10 }}>
              <div style={{ fontSize:11, color:"#6b7280" }}>
                4 counterfactual futures — notice "too early" dips <em>below</em> fluids-only (harm). The "no return" line shows why waiting too long is worse than never switching.
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8 }}>
                {[
                  [`Too Early H${cf.earlyH}`, Math.round(vasoAtHour(selected,pivotHour,23,cf.earlyH)*100),"#ef4444","Vasopressors before volume loading → cardiac output drops → organs worsen"],
                  [`Optimal H${pivotHour}`,   Math.round(vasoAtHour(selected,pivotHour,23,pivotHour)*100),"#10b981","Volume loaded + vasopressors → MAP restores → peak benefit"],
                  [`Too Late H${cf.lateH}`,   Math.round(vasoAtHour(selected,pivotHour,23,cf.lateH)*100), "#f59e0b","AKI developing → attenuated benefit, partial recovery"],
                  [`No Return H${noReturnH}`, Math.round(vasoAtHour(selected,pivotHour,23,noReturnH)*100),"#7f1d1d","Irreversible damage → vasopressors now worse than fluids-only"],
                ].map(([l,v,c,r])=>(
                  <div key={l} style={{ background:`${c}0f`, border:`1px solid ${c}30`, borderRadius:9, padding:"10px 12px" }}>
                    <div style={{ fontSize:9, fontWeight:700, color:c, marginBottom:2 }}>{l}</div>
                    <div style={{ fontFamily:"'DM Mono',monospace", fontSize:26, fontWeight:700, color:c }}>{v}%</div>
                    <div style={{ fontSize:9, color:"#6b7280", marginTop:4, lineHeight:1.5 }}>{r}</div>
                  </div>
                ))}
              </div>
              <div style={{ background:"rgba(255,255,255,0.02)", borderRadius:11, border:"1px solid rgba(255,255,255,0.06)", padding:"13px 10px 7px" }}>
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={cfData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
                    <XAxis dataKey="label" tick={{ fontSize:8, fill:"#4b5563" }}/>
                    <YAxis domain={[0,1]} tickFormatter={v=>`${(v*100).toFixed(0)}%`} tick={{ fontSize:8, fill:"#4b5563" }}/>
                    <Tooltip content={<CTip/>}/>
                    <Legend wrapperStyle={{ fontSize:10, color:"#9ca3af" }}/>
                    <ReferenceLine x={`H${pivotHour}`} stroke="#10b981" strokeDasharray="4 4" label={{ value:`Optimal H${pivotHour}`, fill:"#10b981", fontSize:9, position:"top" }}/>
                    <ReferenceLine x={`H${noReturnH}`} stroke="#ef4444" strokeDasharray="3 3" label={{ value:`No-return H${noReturnH}`, fill:"#ef4444", fontSize:9, position:"top" }}/>
                    <ReferenceLine x={`H${currentHour}`} stroke="#818cf8" strokeDasharray="2 3" label={{ value:"Now", fill:"#818cf8", fontSize:9, position:"top" }}/>
                    <Line type="monotone" dataKey="too_early"    stroke="#ef4444" strokeWidth={2}   dot={false} name={`Too early (H${cf.earlyH})`}/>
                    <Line type="monotone" dataKey="fluids"       stroke="#6b7280" strokeWidth={1.5} dot={false} strokeDasharray="5 3" name="Fluids only"/>
                    <Line type="monotone" dataKey="too_late"     stroke="#f59e0b" strokeWidth={2}   dot={false} name={`Too late (H${cf.lateH})`}/>
                    <Line type="monotone" dataKey="vasopressors" stroke="#10b981" strokeWidth={3}   dot={false} name={`Optimal (H${pivotHour})`}/>
                    <Line type="monotone" dataKey="no_return"    stroke="#7f1d1d" strokeWidth={2}   dot={false} strokeDasharray="2 2" name={`No return (H${noReturnH})`}/>
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* ── ITE ── */}
          {activeTab==="ite" && (
            <div style={{ animation:"fadeIn 0.3s ease", display:"flex", flexDirection:"column", gap:10 }}>
              <div style={{ fontSize:11, color:"#9ca3af" }}>
                ITE (Individual Treatment Effect) — how much vasopressors help <em>this specific patient</em> at each hour. <strong style={{ color:"#ef4444" }}>Negative = harm</strong> before the pivot. Alert fires when ITE &gt; 5%.
              </div>
              <div style={{ background:"rgba(255,255,255,0.02)", borderRadius:11, border:"1px solid rgba(255,255,255,0.06)", padding:"13px 10px 7px" }}>
                <ResponsiveContainer width="100%" height={210}>
                  <AreaChart data={cfData}>
                    <defs><linearGradient id="ig" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#818cf8" stopOpacity={0.4}/><stop offset="95%" stopColor="#818cf8" stopOpacity={0}/></linearGradient></defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
                    <XAxis dataKey="label" tick={{ fontSize:8, fill:"#4b5563" }}/>
                    <YAxis tickFormatter={v=>`${(v*100).toFixed(0)}%`} tick={{ fontSize:8, fill:"#4b5563" }}/>
                    <Tooltip content={<CTip/>}/>
                    <ReferenceLine y={0}    stroke="#374151" strokeWidth={1.5}/>
                    <ReferenceLine x={`H${pivotHour}`}  stroke="#10b981" strokeDasharray="4 4" label={{ value:"Pivot",     fill:"#10b981", fontSize:9 }}/>
                    <ReferenceLine x={`H${noReturnH}`}  stroke="#ef4444" strokeDasharray="3 3" label={{ value:"No-return", fill:"#ef4444", fontSize:9 }}/>
                    <ReferenceLine x={`H${currentHour}`}stroke="#818cf8" strokeDasharray="2 3" label={{ value:"Now",       fill:"#818cf8", fontSize:9 }}/>
                    <ReferenceLine y={0.05} stroke="#818cf8" strokeDasharray="3 3" opacity={0.4} label={{ value:"5% alert", fill:"#818cf8", fontSize:8 }}/>
                    <Area type="monotone" dataKey="ite_upper" stroke="none" fill="#818cf818" name=""/>
                    <Area type="monotone" dataKey="ite"       stroke="#818cf8" fill="url(#ig)" strokeWidth={2.5} dot={false} name="ITE"/>
                    <Area type="monotone" dataKey="ite_lower" stroke="none" fill="#080b12" name=""/>
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8 }}>
                <div style={{ padding:"11px 14px", background:"rgba(129,140,248,0.06)", border:"1px solid rgba(129,140,248,0.14)", borderRadius:9 }}>
                  <div style={{ fontSize:9, color:"#818cf8", marginBottom:3 }}>ITE NOW (H{currentHour})</div>
                  <div style={{ fontFamily:"'DM Mono',monospace", fontSize:26, fontWeight:700, color:(curCF.ite??0)<0?"#ef4444":"#818cf8" }}>{Math.round((curCF.ite??0)*100)}%</div>
                  <div style={{ fontSize:10, color:(curCF.ite??0)<0?"#ef4444":"#6b7280", marginTop:2 }}>
                    {(curCF.ite??0)<0?"⚠ Negative — vasopressors harmful now":(curCF.ite??0)>0.05?"Above threshold — action indicated":"Below threshold — wait"}
                  </div>
                </div>
                <div style={{ padding:"11px 14px", background:"rgba(16,185,129,0.06)", border:"1px solid rgba(16,185,129,0.14)", borderRadius:9 }}>
                  <div style={{ fontSize:9, color:"#34d399", marginBottom:3 }}>OPTIMAL PIVOT</div>
                  <div style={{ fontFamily:"'DM Mono',monospace", fontSize:26, fontWeight:700, color:"#10b981" }}>H{pivotHour}</div>
                  <div style={{ fontSize:10, color:"#6b7280", marginTop:2 }}>ITE peaks at {Math.round((cfData[pivotHour]?.ite??0)*100)}%</div>
                </div>
                <div style={{ padding:"11px 14px", background:"rgba(127,29,29,0.1)", border:"1px solid rgba(239,68,68,0.2)", borderRadius:9 }}>
                  <div style={{ fontSize:9, color:"#f87171", marginBottom:3 }}>POINT OF NO RETURN</div>
                  <div style={{ fontFamily:"'DM Mono',monospace", fontSize:26, fontWeight:700, color:"#ef4444" }}>H{noReturnH}</div>
                  <div style={{ fontSize:10, color:"#6b7280", marginTop:2 }}>ITE goes negative again</div>
                </div>
              </div>
              {simResult && (
                <div style={{ padding:"12px 14px", background:`${simResult.timing.color}0f`, border:`2px solid ${simResult.timing.color}40`, borderRadius:10, animation:"fadeIn 0.4s ease" }}>
                  <div style={{ fontSize:11, fontWeight:700, color:simResult.timing.color, marginBottom:3 }}>{simResult.timing.label}</div>
                  <div style={{ fontSize:10, color:"#9ca3af", lineHeight:1.6, marginBottom:6 }}>{simResult.timing.why}</div>
                  <div style={{ fontFamily:"'DM Mono',monospace", fontSize:26, fontWeight:700, color:simResult.timing.color }}>
                    {decisionSurvival !== null ? Math.round(decisionSurvival*100) : "—"}% <span style={{ fontSize:10, color:"#6b7280" }}>28-day survival</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── XAI + WHY MODEL ── */}
          {activeTab==="xai" && (
            <div style={{ animation:"fadeIn 0.3s ease", display:"flex", flexDirection:"column", gap:10 }}>
              <div style={{ fontSize:11, color:"#9ca3af" }}>
                Why the model gives this survival % — feature-by-feature breakdown. This is also why MAP alone is not enough.
              </div>

              {/* Feature contributions */}
              <div style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:11, padding:"16px 18px" }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:12 }}>
                  <div style={{ fontSize:13, fontWeight:700, color:"#e5e7eb" }}>What the model is weighing right now</div>
                  <div style={{ fontSize:10, color:"#6b7280" }}>
                    Net: <span style={{ fontFamily:"'DM Mono',monospace", color: xaiFeatures.reduce((s,c)=>s+c.contrib,0)>=0?"#10b981":"#ef4444", fontWeight:700 }}>
                      {xaiFeatures.reduce((s,c)=>s+c.contrib,0)>=0?"+":""}{xaiFeatures.reduce((s,c)=>s+c.contrib,0).toFixed(0)}%
                    </span>
                  </div>
                </div>
                {xaiFeatures.map((f,i)=>{
                  const barW = Math.min(100, Math.abs(f.contrib)*6);
                  const col  = f.dir==="good"?"#10b981":f.dir==="bad"?"#ef4444":"#6b7280";
                  return (
                    <div key={i} style={{ background:f.dir==="bad"?"rgba(239,68,68,0.05)":f.dir==="good"?"rgba(16,185,129,0.05)":"rgba(255,255,255,0.02)", border:`1px solid ${f.dir==="bad"?"rgba(239,68,68,0.15)":f.dir==="good"?"rgba(16,185,129,0.15)":"rgba(255,255,255,0.06)"}`, borderRadius:9, padding:"11px 13px", marginBottom:7 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:5 }}>
                        <span style={{ fontSize:12, fontWeight:600, color:"#d1d5db" }}>{f.feature}</span>
                        <div style={{ display:"flex", gap:10, alignItems:"center" }}>
                          <span style={{ fontFamily:"'DM Mono',monospace", fontSize:11, color:"#9ca3af" }}>{f.value}</span>
                          <span style={{ fontFamily:"'DM Mono',monospace", fontSize:13, fontWeight:700, color:col }}>
                            {f.contrib>=0?"+":""}{f.contrib}%
                          </span>
                        </div>
                      </div>
                      <div style={{ height:3, background:"rgba(255,255,255,0.06)", borderRadius:2, marginBottom:7 }}>
                        <div style={{ height:"100%", width:`${barW}%`, background:col, borderRadius:2 }}/>
                      </div>
                      <div style={{ fontSize:11, color:"#9ca3af", lineHeight:1.65 }}>{f.why}</div>
                    </div>
                  );
                })}
              </div>

              {/* Why not just MAP */}
              <div style={{ background:"rgba(129,140,248,0.05)", border:"1px solid rgba(129,140,248,0.18)", borderRadius:11, padding:"14px 16px" }}>
                <div style={{ fontSize:12, fontWeight:700, color:"#818cf8", marginBottom:8 }}>Why MAP alone isn't enough — what the model catches that a doctor can't</div>
                {whyModel.map((r,i)=>(
                  <div key={i} style={{ fontSize:12, color:"#9ca3af", lineHeight:1.7, marginBottom:5, paddingLeft:12, borderLeft:"2px solid rgba(129,140,248,0.3)" }}>
                    {r}
                  </div>
                ))}
              </div>

              {/* Classic XAI indicators */}
              <div style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:11, padding:"13px 15px" }}>
                <div style={{ fontSize:11, color:"#6b7280", marginBottom:8 }}>Critical indicator summary — H{currentHour}</div>
                {[
                  { label:"MAP",        val:(curVital?.map??selected.map),        bad:v=>v<65,  warn:v=>v<70,  unit:"mmHg",   detail:`${(curVital?.map??selected.map)<65?"Below 65 — critical hypoperfusion":"Borderline"}` },
                  { label:"Lactate",    val:(curVital?.lactate??selected.lactate), bad:v=>v>4,   warn:v=>v>2,   unit:"mmol/L", detail:`${(curVital?.lactate??selected.lactate)>4?"Severe hypoxia":"Elevated"}` },
                  { label:"Urine",      val:(curVital?.urine??selected.urine),     bad:v=>v<15,  warn:v=>v<30,  unit:"mL/hr",  detail:`${(curVital?.urine??selected.urine)<15?"Kidneys failing":"Reduced output"}` },
                  { label:"SOFA",       val:selected.sofa,                          bad:v=>v>=11, warn:v=>v>=8,  unit:"/24",    detail:`${selected.sofa>=11?"High mortality risk":"Moderate dysfunction"}` },
                ].map(({ label,val,bad,warn,unit,detail })=>{
                  const isBad=bad(val), isWarn=warn(val)&&!bad(val);
                  if (!isBad && !isWarn) return null;
                  return (
                    <div key={label} style={{ display:"flex", alignItems:"center", gap:12, marginBottom:7, background:isBad?"rgba(239,68,68,0.06)":"rgba(245,158,11,0.06)", border:`1px solid ${isBad?"rgba(239,68,68,0.2)":"rgba(245,158,11,0.2)"}`, borderRadius:8, padding:"9px 12px" }}>
                      <span style={{ fontSize:11, fontWeight:700, color:isBad?"#f87171":"#fbbf24", width:60 }}>{label}</span>
                      <span style={{ fontFamily:"'DM Mono',monospace", fontSize:14, fontWeight:700, color:isBad?"#ef4444":"#f59e0b" }}>{val} {unit}</span>
                      <span style={{ fontSize:11, color:"#9ca3af" }}>{detail}</span>
                      <span style={{ marginLeft:"auto", fontSize:9, padding:"2px 7px", borderRadius:4, background:isBad?"rgba(239,68,68,0.15)":"rgba(245,158,11,0.15)", color:isBad?"#f87171":"#fbbf24", fontWeight:700 }}>{isBad?"critical":"warning"}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── PARAMETER GUIDE ── */}
          {activeTab==="guide" && (
            <div style={{ animation:"fadeIn 0.3s ease", display:"flex", flexDirection:"column", gap:10 }}>
              <div style={{ fontSize:11, color:"#9ca3af" }}>Click any parameter to see clinical ranges, what it means, and how fluids vs vasopressors affect it differently.</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(2,1fr)", gap:10 }}>
                {Object.entries(PARAM_INFO).map(([key,info])=>(
                  <div key={key} onClick={()=>setParamModal(key)}
                    style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:11, padding:"13px 15px", cursor:"pointer", transition:"all .15s" }}
                    onMouseEnter={e=>{e.currentTarget.style.borderColor="rgba(129,140,248,0.35)";e.currentTarget.style.background="rgba(99,102,241,0.05)";}}
                    onMouseLeave={e=>{e.currentTarget.style.borderColor="rgba(255,255,255,0.07)";e.currentTarget.style.background="rgba(255,255,255,0.02)";}}>
                    <div style={{ display:"flex", justifyContent:"space-between", marginBottom:7 }}>
                      <div style={{ fontSize:13, fontWeight:600, color:"#e5e7eb" }}>{info.name}</div>
                      <span style={{ fontSize:10, fontFamily:"'DM Mono',monospace", color:"#818cf8" }}>{info.unit}</span>
                    </div>
                    <div style={{ display:"flex", gap:6, marginBottom:7, flexWrap:"wrap" }}>
                      <span style={{ fontSize:9, padding:"2px 6px", borderRadius:4, background:"rgba(16,185,129,0.1)", color:"#34d399" }}>Normal: {info.normal}</span>
                      <span style={{ fontSize:9, padding:"2px 6px", borderRadius:4, background:"rgba(239,68,68,0.1)", color:"#f87171" }}>Critical: {info.critical}</span>
                    </div>
                    <div style={{ fontSize:11, color:"#9ca3af", lineHeight:1.5 }}>{info.what.substring(0,90)}…</div>
                    <div style={{ fontSize:10, color:"#4b5563", marginTop:7 }}>Click to see fluids vs vasopressors effect →</div>
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