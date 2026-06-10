# 🏥 Causal-ICU: Counterfactual Treatment Decision Engine for Septic Shock

Causal-ICU is an AI-powered clinical decision support system that identifies the optimal time to transition septic shock patients from IV fluids to vasopressors using causal inference and counterfactual reasoning.

Unlike traditional prediction models, Causal-ICU estimates:

* Survival probability if IV fluids are continued
* Survival probability if vasopressors are initiated
* Individual Treatment Effect (ITE)
* Patient-specific intervention windows

The system is trained on the MIMIC-III sepsis cohort and provides real-time treatment recommendations through an interactive ICU simulation dashboard.

## 🚀 Key Features

* T-Learner-based causal inference engine
* Counterfactual treatment outcome simulation
* Individual Treatment Effect (ITE) estimation
* Real-time ICU digital twin visualization
* Explainable AI recommendation panel
* Non-survivor rescue analysis
* Missed intervention window detection
* Vital trajectory forecasting

## 🏗 Tech Stack

### Frontend

* React
* Vite
* Recharts

### Machine Learning

* Python
* Scikit-Learn
* Gradient Boosting Regressors

### Causal Framework

* Potential Outcomes Framework
* T-Learner Metalearner

### Dataset

* MIMIC-III ICU Database

## 📂 Architecture

MIMIC-III Data
↓
Data Extraction
↓
T-Learner Training
↓
Counterfactual Models
↓
React Dashboard
↓
Treatment Decision Support

## 🎯 Impact

Causal-ICU helps clinicians answer a critical question:

> "What would happen if we changed treatment right now?"

By estimating patient-specific treatment effects, the system enables earlier, more informed intervention decisions in septic shock management and demonstrates the potential of causal AI in critical care.

## ⚠️ Disclaimer

This project is intended for research, educational, and demonstration purposes only. It is not FDA-approved and should not be used as a substitute for professional medical judgment or clinical decision-making.
