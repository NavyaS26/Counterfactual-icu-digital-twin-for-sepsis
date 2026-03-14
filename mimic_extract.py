"""
Causal-ICU — MIMIC-III Raw Extractor
======================================
Reads the actual MIMIC-III demo CSVs and builds patients.json

USAGE:
  python3 mimic_extract.py --mimic_dir /path/to/mimic-iii-clinical-database-demo-1.4

The folder should contain: ICUSTAYS.csv, CHARTEVENTS.csv, LABEVENTS.csv,
OUTPUTEVENTS.csv, INPUTEVENTS_MV.csv, PATIENTS.csv, ADMISSIONS.csv
"""

import pandas as pd
import numpy as np
import json
import os
import argparse
from pathlib import Path

# ── MIMIC item IDs for the vitals/labs we need ────────────────────────────────
# These are standard MIMIC-III ITEMIDs from D_ITEMS / D_LABITEMS
CHART_ITEMS = {
    "map":     [456, 52, 6702, 443, 220052, 220181],   # Mean arterial pressure
    "hr":      [211, 220045],                           # Heart rate
    "rr":      [618, 615, 220210, 224690],              # Respiratory rate
    "spo2":    [646, 220277],                           # SpO2
    "temp":    [223761, 678, 223762, 676],              # Temperature
    "gcs":     [198, 226755, 227013],                   # GCS total
    "sys_bp":  [51, 442, 455, 6701, 220179, 220050],    # Systolic BP
    "urine":   [40055, 43175, 40069, 40094, 40715,
                40473, 40085, 40057, 40056, 40405,
                40428, 40086, 40096, 40651, 226559,
                226560, 226561, 226584, 226563, 226564,
                226565, 226567, 226557, 226558, 227488, 227489],
}

LAB_ITEMS = {
    "lactate":    [50813],
    "creatinine": [50912],
    "bun":        [51006],
    "wbc":        [51301],
    "platelets":  [51265],
    "ph":         [50820],
    "bicarb":     [50882],
    "glucose":    [50931],
    "paco2":      [50818],
}

# Vasopressors in INPUTEVENTS_MV
VASO_ITEMS = [221906, 221289, 222315, 221749, 221662]  # norepi, epi, vasopressin, phenyl, dopamine

# IV fluids in INPUTEVENTS_MV  
FLUID_ITEMS = [225158, 225828, 220949, 225823, 225825, 225827, 225941, 226089,
               220950, 220952, 220955, 220957, 220960, 220964, 220970]


def load_table(mimic_dir, filename):
    path = Path(mimic_dir) / filename
    if not path.exists():
        # Try lowercase
        path = Path(mimic_dir) / filename.lower()
    if not path.exists():
        print(f"  ⚠️  {filename} not found, skipping")
        return None
    df = pd.read_csv(path, low_memory=False)
    # Lowercase all column names
    df.columns = df.columns.str.lower()
    print(f"  ✓ {filename}: {len(df):,} rows")
    return df


def get_icu_stays(mimic_dir):
    """Get ICU stays with patient demographics."""
    print("\n── ICU Stays + Patients ──")
    stays   = load_table(mimic_dir, "ICUSTAYS.csv")
    patients = load_table(mimic_dir, "PATIENTS.csv")
    admissions = load_table(mimic_dir, "ADMISSIONS.csv")

    if stays is None or patients is None:
        raise FileNotFoundError("ICUSTAYS.csv or PATIENTS.csv missing")

    # Merge demographics
    df = stays.merge(patients[["subject_id","gender","dob"]], on="subject_id", how="left")

    if admissions is not None:
        adm_cols = ["hadm_id","hospital_expire_flag","ethnicity"]
        adm_cols = [c for c in adm_cols if c in admissions.columns]
        df = df.merge(admissions[adm_cols], on="hadm_id", how="left")

    # Compute age at admission
    # MIMIC-III deliberately shifts DOBs for patients >89 yrs to ~year 2109 for anonymization.
    # This causes int64 overflow when subtracting. Fix: use year arithmetic only.
    df["intime"] = pd.to_datetime(df["intime"], errors="coerce")
    df["dob"]    = pd.to_datetime(df["dob"],    errors="coerce")
    df["age"]    = df["intime"].dt.year - df["dob"].dt.year
    # Anyone with computed age > 90 is an anonymized >89yr patient — set to 91
    df["age"]    = df["age"].where(df["age"] <= 90, 91).clip(18, 91).fillna(65)

    # ICU length of stay in hours
    df["outtime"] = pd.to_datetime(df["outtime"])
    df["los_hours"] = ((df["outtime"] - df["intime"]).dt.total_seconds() / 3600).clip(1, 500)

    # Mortality flag
    if "hospital_expire_flag" in df.columns:
        df["died"] = df["hospital_expire_flag"].fillna(0).astype(int)
    elif "deathtime" in patients.columns:
        df = df.merge(patients[["subject_id","deathtime"]], on="subject_id", how="left")
        df["died"] = df["deathtime"].notna().astype(int)
    else:
        df["died"] = 0

    print(f"  Total ICU stays: {len(df)}, Mortality: {df['died'].mean():.1%}")
    return df


def extract_chartevents(mimic_dir, icustay_ids):
    """Extract hourly vitals from CHARTEVENTS."""
    print("\n── Chart Events (vitals) ──")
    ce = load_table(mimic_dir, "CHARTEVENTS.csv")
    if ce is None:
        return pd.DataFrame()

    # Keep only our patients and relevant items
    all_items = [i for items in CHART_ITEMS.values() for i in items]
    ce = ce[ce["icustay_id"].isin(icustay_ids) & ce["itemid"].isin(all_items)].copy()
    ce = ce[ce["error"].isna() | (ce["error"] == 0)] if "error" in ce.columns else ce

    ce["charttime"] = pd.to_datetime(ce["charttime"])
    ce["valuenum"]  = pd.to_numeric(ce["valuenum"], errors="coerce")
    ce = ce.dropna(subset=["valuenum", "icustay_id"])

    # Map itemid → vital name
    item_to_vital = {}
    for vital, items in CHART_ITEMS.items():
        for i in items:
            item_to_vital[i] = vital
    ce["vital"] = ce["itemid"].map(item_to_vital)

    print(f"  Chart rows after filter: {len(ce):,}")
    return ce[["icustay_id","charttime","vital","valuenum"]]


def extract_labevents(mimic_dir, icustay_ids, stays_df):
    """Extract labs from LABEVENTS (joined via hadm_id)."""
    print("\n── Lab Events ──")
    le = load_table(mimic_dir, "LABEVENTS.csv")
    if le is None:
        return pd.DataFrame()

    all_items = [i for items in LAB_ITEMS.values() for i in items]
    le = le[le["itemid"].isin(all_items)].copy()
    le["valuenum"] = pd.to_numeric(le["valuenum"], errors="coerce")
    le = le.dropna(subset=["valuenum"])

    # Join icustay_id via hadm_id
    hadm_to_stay = stays_df.set_index("hadm_id")["icustay_id"].to_dict()
    if "hadm_id" in le.columns:
        le["icustay_id"] = le["hadm_id"].map(hadm_to_stay)
    le = le[le["icustay_id"].isin(icustay_ids)].copy()

    le["charttime"] = pd.to_datetime(le["charttime"])

    item_to_lab = {}
    for lab, items in LAB_ITEMS.items():
        for i in items:
            item_to_lab[i] = lab
    le["vital"] = le["itemid"].map(item_to_lab)

    print(f"  Lab rows after filter: {len(le):,}")
    return le[["icustay_id","charttime","vital","valuenum"]]


def extract_outputs(mimic_dir, icustay_ids):
    """Extract urine output from OUTPUTEVENTS."""
    print("\n── Output Events (urine) ──")
    oe = load_table(mimic_dir, "OUTPUTEVENTS.csv")
    if oe is None:
        return pd.DataFrame()

    oe = oe[oe["icustay_id"].isin(icustay_ids)].copy()
    oe["charttime"] = pd.to_datetime(oe["charttime"])
    oe["value"]     = pd.to_numeric(oe["value"], errors="coerce").fillna(0)
    oe["vital"]     = "urine"
    oe = oe.rename(columns={"value": "valuenum"})

    print(f"  Output rows: {len(oe):,}")
    return oe[["icustay_id","charttime","vital","valuenum"]]


def extract_inputs(mimic_dir, icustay_ids):
    """Extract vasopressors and fluids from INPUTEVENTS_MV."""
    print("\n── Input Events (vasopressors + fluids) ──")
    ie = load_table(mimic_dir, "INPUTEVENTS_MV.csv")
    if ie is None:
        return pd.DataFrame(), pd.DataFrame()

    ie = ie[ie["icustay_id"].isin(icustay_ids)].copy()
    ie["starttime"] = pd.to_datetime(ie["starttime"])
    ie["amount"]    = pd.to_numeric(ie["amount"], errors="coerce").fillna(0)

    vaso  = ie[ie["itemid"].isin(VASO_ITEMS)].copy()
    fluid = ie[ie["itemid"].isin(FLUID_ITEMS)].copy()

    vaso["vital"]  = "vaso_dose"
    fluid["vital"] = "fluid_ml"
    vaso  = vaso.rename(columns={"starttime":"charttime","amount":"valuenum"})
    fluid = fluid.rename(columns={"starttime":"charttime","amount":"valuenum"})

    print(f"  Vasopressor rows: {len(vaso):,}, Fluid rows: {len(fluid):,}")
    return vaso[["icustay_id","charttime","vital","valuenum"]], \
           fluid[["icustay_id","charttime","vital","valuenum"]]


def build_hourly_timeseries(stays_df, all_events):
    """Pivot events into hourly rows per patient."""
    print("\n── Building hourly time-series ──")

    patients_hourly = {}

    for _, stay in stays_df.iterrows():
        sid    = stay["icustay_id"]
        intime = stay["intime"]
        max_h  = min(int(stay["los_hours"]), 72)  # cap at 72h

        stay_events = all_events[all_events["icustay_id"] == sid].copy()
        if len(stay_events) == 0:
            continue

        stay_events["hour"] = ((stay_events["charttime"] - intime)
                                .dt.total_seconds() / 3600).astype(int)
        stay_events = stay_events[(stay_events["hour"] >= 0) & (stay_events["hour"] <= max_h)]

        if len(stay_events) == 0:
            continue

        # Pivot to hour × vital, aggregate by median
        pivoted = (stay_events
                   .groupby(["hour","vital"])["valuenum"]
                   .median()
                   .unstack("vital")
                   .reset_index())

        # Forward-fill then backward-fill
        vital_cols = [c for c in pivoted.columns if c != "hour"]
        pivoted[vital_cols] = pivoted[vital_cols].ffill().bfill()

        # Clip physiological bounds
        bounds = {
            "map": (20,200), "hr": (20,250), "rr": (4,60),
            "spo2": (50,100), "lactate": (0.1,30),
            "creatinine": (0.1,20), "sofa": (0,24),
            "vaso_dose": (0,5000), "fluid_ml": (0,10000),
            "urine": (0,2000),
        }
        for col, (lo,hi) in bounds.items():
            if col in pivoted.columns:
                pivoted[col] = pivoted[col].clip(lo,hi)

        patients_hourly[sid] = pivoted

    print(f"  Built hourly data for {len(patients_hourly)} patients")
    return patients_hourly


def approximate_sofa(row):
    """Rough SOFA from available vitals (simplified)."""
    score = 0
    if pd.notna(row.get("map")) and row["map"] < 70: score += 2
    if pd.notna(row.get("creatinine")) and row["creatinine"] > 1.2: score += 2
    if pd.notna(row.get("platelets")) and row["platelets"] < 100: score += 2
    if pd.notna(row.get("ph")) and row["ph"] < 7.3: score += 2
    return min(score, 24)


def select_sepsis_patients(stays_df, patients_hourly, n=6):
    """Pick n patients who look like septic shock (low MAP, high lactate)."""
    scored = []
    for sid, hourly in patients_hourly.items():
        if len(hourly) < 6:
            continue
        row = hourly.iloc[0]
        map_v = row.get("map", 70) if pd.notna(row.get("map")) else 70
        lac_v = row.get("lactate", 1) if pd.notna(row.get("lactate")) else 1
        severity = (70 - map_v) + (lac_v * 3)
        scored.append((sid, severity))

    scored.sort(key=lambda x: -x[1])
    # Take spread: top severe, mid, mild
    indices = np.linspace(0, min(len(scored)-1, 20), n, dtype=int)
    return [scored[i][0] for i in indices]


def build_json(stays_df, patients_hourly, selected_ids):
    """Convert to the JSON format the frontend expects."""
    patients_out = []
    stay_lookup  = stays_df.set_index("icustay_id")

    for sid in selected_ids:
        hourly = patients_hourly[sid]
        stay   = stay_lookup.loc[sid]

        def sv(col, default=0, dec=1):
            v = hourly.iloc[0].get(col, default)
            if v is None or (isinstance(v, float) and np.isnan(v)):
                return default
            return round(float(v), dec)

        gender = str(stay.get("gender","M")).strip().upper()
        gender = "Male" if gender == "M" else "Female"
        age    = int(stay.get("age", 60))
        died   = int(stay.get("died", 0))
        sofa_0 = int(sv("sofa", approximate_sofa(hourly.iloc[0]), 0))

        # Diagnosis label
        if sofa_0 >= 11: diag = "Septic shock"
        elif sofa_0 >= 8: diag = "Severe sepsis"
        else: diag = "Sepsis"

        has_vaso = False
        if "vaso_dose" in hourly.columns:
            has_vaso = bool((hourly["vaso_dose"].fillna(0) > 0).any())

        vitals = []
        for _, row in hourly.iterrows():
            def rv(col, default=0, dec=1):
                v = row.get(col, default)
                if v is None or (isinstance(v, float) and np.isnan(v)):
                    return default
                return round(float(v), dec)

            vitals.append({
                "hour":       int(row["hour"]),
                "label":      f"H{int(row['hour'])}",
                "map":        rv("map",      65),
                "lactate":    rv("lactate",  2.0, dec=2),
                "hr":         rv("hr",       90),
                "spo2":       rv("spo2",     97),
                "urine":      rv("urine",    40),
                "sofa":       rv("sofa",     sofa_0, dec=0),
                "fluid_ml":   rv("fluid_ml", 0),
                "vaso_dose":  rv("vaso_dose",0, dec=3),
                "creatinine": rv("creatinine",1.0),
                "sys_bp":     rv("sys_bp",   110),
                "temp":       rv("temp",     37.5),
                "rr":         rv("rr",       18),
            })

        patients_out.append({
            "id":                    f"P-{str(sid)[-4:].zfill(4)}",
            "raw_id":                str(sid),
            "name":                  f"{gender}, {age} yrs",
            "gender":                gender,
            "age":                   age,
            "diagnosis":             diag,
            "sofa":                  sofa_0,
            "lactate":               sv("lactate", 2.0),
            "map":                   sv("map",     65),
            "hr":                    sv("hr",      90),
            "spo2":                  sv("spo2",    97),
            "urine":                 sv("urine",   40),
            "creatinine":            sv("creatinine", 1.0),
            "weight":                70,
            "survived":              bool(died == 0),
            "received_vasopressors": has_vaso,
            "total_hours":           len(vitals),
            "vitals":                vitals,
        })
        print(f"  {patients_out[-1]['id']}: {len(vitals)}h, SOFA={sofa_0}, survived={died==0}, vaso={has_vaso}")

    return patients_out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mimic_dir", default=".", help="Path to MIMIC-III folder")
    parser.add_argument("--n", type=int, default=6, help="Number of patients to export")
    parser.add_argument("--out", default="../causal-icu-frontend/public/patients.json")
    args = parser.parse_args()

    print(f"MIMIC-III directory: {args.mimic_dir}")

    # 1. Load stays
    stays_df = get_icu_stays(args.mimic_dir)
    icustay_ids = stays_df["icustay_id"].tolist()
    print(f"\nTotal ICU stays to process: {len(icustay_ids)}")

    # 2. Extract all events
    chart = extract_chartevents(args.mimic_dir, icustay_ids)
    labs  = extract_labevents(args.mimic_dir, icustay_ids, stays_df)
    outs  = extract_outputs(args.mimic_dir, icustay_ids)
    vaso, fluids = extract_inputs(args.mimic_dir, icustay_ids)

    # 3. Combine all events
    all_events = pd.concat([e for e in [chart, labs, outs, vaso, fluids] if len(e) > 0],
                            ignore_index=True)
    all_events["charttime"] = pd.to_datetime(all_events["charttime"])
    print(f"\nTotal events combined: {len(all_events):,}")

    # 4. Build hourly timeseries
    patients_hourly = build_hourly_timeseries(stays_df, all_events)

    # 5. Select best sepsis demo patients
    selected_ids = select_sepsis_patients(stays_df, patients_hourly, n=args.n)
    print(f"\nSelected ICU stay IDs: {selected_ids}")

    # 6. Build JSON
    print("\n── Building output JSON ──")
    patients_out = build_json(stays_df, patients_hourly, selected_ids)

    # 7. Write
    os.makedirs(Path(args.out).parent, exist_ok=True)
    output = {
        "generated_at":   pd.Timestamp.now().isoformat(),
        "source":         "MIMIC-III Clinical Database Demo",
        "total_patients": len(patients_out),
        "patients":       patients_out,
    }
    with open(args.out, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\n✅ Exported {len(patients_out)} real MIMIC-III patients → {args.out}")


if __name__ == "__main__":
    main()