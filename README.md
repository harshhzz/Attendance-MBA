# GeoAttend — Campus Geofence Attendance System (ITM GIDA, Gorakhpur)

**GeoAttend** is a responsive, mobile-friendly web application built on **Google Apps Script** and **Google Sheets** for **ITM GIDA, Gorakhpur, Uttar Pradesh, India** (`26.742681° N, 83.273421° E`).

Students sign in with their authorized College Roll Number and password, verify that their device is physically within **200 metres** of the campus centre with a GPS accuracy of **≤ 50 metres**, and mark daily attendance. All geofence calculations, duplicate checks, OTP validations, and session checks are independently enforced on the server.

---

## 1. Project File Structure

| File | Responsibility |
| :--- | :--- |
| [`Code.gs`](file:///h:/Web%20Dev/Clg%20Prpj/Code.gs) | Web App `doGet` entry point, HTML template inclusion, and client-callable RPC wrappers (`api*`). |
| [`Config.gs`](file:///h:/Web%20Dev/Clg%20Prpj/Config.gs) | Central configuration, `ScriptProperties` secret/ID loading, `setupGeoAttendDatabase()` schema initializer, and `seedSampleTestRoster()`. |
| [`Auth.gs`](file:///h:/Web%20Dev/Clg%20Prpj/Auth.gs) | 3,000-round iterated salted & peppered HMAC-SHA512 password hashing, login lockout/throttling, and opaque server session tokens. |
| [`Otp.gs`](file:///h:/Web%20Dev/Clg%20Prpj/Otp.gs) | Gmail (`MailApp`) 6-digit OTP generation, HMAC storage, 5-minute expiry, 60-second resend cooldown, and 5-attempt cap. |
| [`GeoFence.gs`](file:///h:/Web%20Dev/Clg%20Prpj/GeoFence.gs) | Authoritative Haversine distance calculation, 200 m radius check, 50 m accuracy check, and conservative boundary uncertainty policy. |
| [`Attendance.gs`](file:///h:/Web%20Dev/Clg%20Prpj/Attendance.gs) | `LockService`-protected duplicate prevention, time-window enforcement (`Asia/Kolkata`), and student-scoped history. |
| [`Students.gs`](file:///h:/Web%20Dev/Clg%20Prpj/Students.gs) | Roll number normalization, authorized roster lookups, and email masking. |
| [`Admin.gs`](file:///h:/Web%20Dev/Clg%20Prpj/Admin.gs) | Server-verified `ADMIN` role enforcement, filtered attendance reports, CSV export support, roster provisioning, and geofence settings. |
| [`Audit.gs`](file:///h:/Web%20Dev/Clg%20Prpj/Audit.gs) | Security audit logging (`AuditLogs`) and spreadsheet formula-injection sanitization. |
| [`Index.html`](file:///h:/Web%20Dev/Clg%20Prpj/Index.html) | Responsive app shell (Login, OTP Recovery/Activation, Student Dashboard, and Admin Console). |
| [`Styles.html`](file:///h:/Web%20Dev/Clg%20Prpj/Styles.html) | Accessible, mobile-first CSS stylesheet (`<?!= include('Styles'); ?>`). |
| [`Client.html`](file:///h:/Web%20Dev/Clg%20Prpj/Client.html) | Client-side JavaScript controller, `navigator.geolocation` handler, CSV exporter, and Local Preview Sandbox (`<?!= include('Client'); ?>`). |
| [`GeoAttend.html`](file:///h:/Web%20Dev/Clg%20Prpj/GeoAttend.html) | **Standalone Single-File Local Preview Bundle** — open directly in any desktop/mobile browser to test all flows immediately before deploying to Google Apps Script. |

---

## 2. Step-by-Step Deployment Guide (Non-Expert Friendly)

> **Important Status Notice:** This repository contains the complete, runnable source code. Because only you have access to your private Google account, Google Drive, and Gmail permissions, **the app has not yet been deployed to your live Google account**. Follow the 12 steps below to deploy it safely in ~10 minutes.

### Step 1: Create the Google Spreadsheet
1. Log in to your Google account and open [Google Sheets](https://sheets.google.com).
2. Create a new blank spreadsheet and name it **`GeoAttend Database`**.
3. Look at the browser address bar and copy your **Spreadsheet ID** (the long string between `/d/` and `/edit` in `https://docs.google.com/spreadsheets/d/YOUR_SPREADSHEET_ID_HERE/edit`).

### Step 2: Create the Google Apps Script Project
1. Inside your `GeoAttend Database` spreadsheet, click **Extensions → Apps Script** (or visit [script.google.com](https://script.google.com) and click **New Project**).
2. Rename the project to **`GeoAttend Backend`**.

### Step 3: Add the Source Files
Create the following files in the Apps Script editor and paste the exact contents from this folder:
- **Script files (`.gs`):**
  1. `Code.gs` (replace the default `Code.gs` content)
  2. `Config.gs`
  3. `Audit.gs`
  4. `Students.gs`
  5. `Auth.gs`
  6. `Otp.gs`
  7. `GeoFence.gs`
  8. `Attendance.gs`
  9. `Admin.gs`
- **HTML files (`.html`):** (Click **+** next to Files → **HTML**; do not type `.html` in the name box as Apps Script adds it automatically)
  1. `Index` (from `Index.html`)
  2. `Styles` (from `Styles.html`)
  3. `Client` (from `Client.html`)

### Step 4: Configure `SPREADSHEET_ID` in Script Properties
1. In the Apps Script left sidebar, click **Project Settings** (the gear icon ⚙️).
2. Scroll down to **Script Properties** and click **Add script property**.
3. Set:
   - **Property:** `SPREADSHEET_ID`
   - **Value:** *(Paste the Spreadsheet ID you copied in Step 1)*
4. Click **Save script properties**.

### Step 5: Initialize Database Tabs & Authorize Permissions
1. Return to the **Editor** (`< >` icon in the left sidebar) and open `Config.gs`.
2. In the top toolbar dropdown (next to **Debug**), select **`setupGeoAttendDatabase`** and click **Run**.
3. Google will prompt **Authorization required**:
   - Click **Review permissions** → choose your Google account.
   - If shown a *"Google hasn't verified this app"* screen (normal for personal scripts), click **Advanced → Go to GeoAttend Backend (unsafe)** → **Allow**.
4. Verify in your Google Sheet that 7 tabs were automatically created with styled headers:
   - `Students`, `Credentials`, `Attendance`, `OTPRequests`, `Settings`, `AuditLogs`, `Sessions`

### Step 6: Provision the First Administrator Account Securely (No Default Public Password)
1. In the Apps Script toolbar dropdown, select **`seedSampleTestRoster`** (in `Config.gs`) and click **Run** (or manually add a row in the `Students` tab).
2. Open the **`Students`** tab in your Google Sheet and locate row `ADM-TEST-001` (Roll Number: `ADMIN001`, Role: `ADMIN`, Status: `PENDING`).
3. Replace `replace-with-admin-email@example.com` in column `G` (`verified_email`) with **your own real email address**.
4. Once the web app is deployed (Step 9), click **First-Time Account Activation (OTP)** on the login screen, enter `ADMIN001`, enter the 6-digit OTP sent to your email, and set your private Administrator password.
5. *(Security Reminder)* Delete or disable any sample student rows (`STU-TEST-001`, `STU-TEST-002`) before production use.

### Step 7: Import the Authorized Student Roster
- Add authorized students either via the **Admin Console → Student Roster Provisioning** tab in the web app, or by pasting rows into the `Students` sheet with columns:
  - `student_id` (e.g., `STU-2026-001`)
  - `roll_number` (e.g., `2026CSE001`)
  - `full_name`
  - `course` (e.g., `B.Tech CSE`)
  - `semester` (e.g., `6`)
  - `section` (e.g., `A`)
  - `verified_email` (student's verified email address)
  - `email_verified` (`FALSE` initially)
  - `account_status` (`PENDING`)
  - `role` (`STUDENT`)
  - `created_at` / `updated_at`

### Step 8: Test OTP Email Delivery & Quotas
- Trigger **First-Time Account Activation (OTP)** for your test roll number.
- Verify that the email arrives from your Google account with the subject `[GeoAttend] <OTP> is your verification code (ITM GIDA, Gorakhpur)`.
- Note that consumer Gmail accounts have a `MailApp` quota of **100 emails/day** (Google Workspace educational/business accounts allow up to 1,500/day).

### Step 9: Deploy as an HTTPS Web App
1. In the top-right corner of the Apps Script editor, click **Deploy → New deployment**.
2. Click the gear icon next to **Select type** and choose **Web app**.
3. Configure the deployment settings carefully:
   - **Description:** `GeoAttend v1.0 Production`
   - **Execute as:** **`Me (<your-email@gmail.com>)`**
     *(Required so the script can read/write your private `GeoAttend Database` sheet and send OTP emails via `MailApp` without granting students direct access to your Google Sheet!)*
   - **Who has access:** **`Anyone`** (or *Anyone within your organization* if all students use institutional Google Workspace accounts).
     > **Security Note:** Even when "Who has access" is set to *Anyone* so students can open the login URL on their mobile browsers without needing edit access to your Google Sheet, all application actions are gated by GeoAttend's server-side Roll Number + Password + OTP authentication. Your Google Sheet itself must remain **Private (Restricted to Only You)** in Google Drive.
4. Click **Deploy** and copy the **`https://script.google.com/macros/s/.../exec`** Web App URL.

### Step 10: Test on a Mobile Phone Over HTTPS
1. Open the copied `https://script.google.com/.../exec` URL on a smartphone browser (Chrome on Android or Safari on iOS).
2. Sign in, tap **Check My Location**, and grant browser Location Permission.

### Step 11: Updating the Deployment After Code Edits
- Whenever you modify any `.gs` or `.html` file in Apps Script:
  1. Save the file (`Ctrl+S`).
  2. Click **Deploy → Manage deployments**.
  3. Click the pencil icon ✏️ next to your active deployment.
  4. Under **Version**, select **New version** and click **Deploy**.

### Step 12: Backing Up the Database & Correcting Student Emails
- **Backups:** In Google Sheets, click **File → Download → Microsoft Excel (`.xlsx`)** or **File → Make a copy** weekly to retain offline snapshots.
- **Email Correction Procedure:** Students cannot self-edit their registered email address. If a student's email in the roster is missing or misspelled, the student must verify their college ID card with the ITM GIDA Administrator, who updates `verified_email` via **Admin Console → Student Roster Provisioning** (or directly in the `Students` sheet).

---

## 3. Security, Privacy & Platform Limitations

### Security Controls Implemented
- **No Plaintext Passwords or OTPs:** Passwords are hashed on the server using a 3,000-round iterated HMAC-SHA512 scheme with per-user unique UUID salts and a server-side `HMAC_SECRET` pepper stored in `ScriptProperties`. OTPs and session tokens are stored only as HMAC-SHA256 digests.
- **Zero Client Trust:** The server never trusts client-supplied distance, eligibility status, date, timestamp, or student ID. `submitStudentAttendance` resolves the student exclusively from the server-validated session token and recomputes Haversine distance and accuracy bounds on the server.
- **Race-Condition Protection:** `LockService.getScriptLock()` serializes attendance duplicate checks and writes so rapid double-taps or concurrent requests cannot insert duplicate rows.
- **Conservative Boundary Policy:** When `location_boundary_policy` is set to `CONSERVATIVE` (default), a reading near the 200 m edge where `distance + accuracy > 200 m` is rejected as `UNCERTAIN_BOUNDARY` until the student obtains a tighter GPS fix or steps further inside campus.
- **Formula Injection Defense:** All user-supplied text fields and CSV exports sanitize leading `=`, `+`, `-`, `@` characters.

### Known Platform Limitations
1. **Browser GPS Spoofing:** Browser geolocation (`navigator.geolocation`) is provided by the client OS/browser and can be spoofed using developer tools or mock-location apps. GPS geofencing is a practical deterrent, not cryptographic proof of physical presence.
2. **Hardware Identifiers:** Web browsers do not expose hardware IMEI, serial numbers, or MAC addresses.
3. **Google Apps Script Quotas:**
   - Consumer Google accounts can send up to **100 emails/day** via `MailApp`.
   - Concurrent execution limit is ~30 simultaneous executions per script, and `LockService` serializes sheet writes (~200–500 ms per write). For simultaneous check-ins by thousands of students in the same second, migrate the backend to a dedicated cloud database (e.g., Cloud SQL / Firestore).

