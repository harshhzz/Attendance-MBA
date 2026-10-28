# GeoAttend --- Full Website Development Brief for Antigravity

## 1. Project Overview

Build **GeoAttend**, a responsive, mobile-friendly **website** for
student attendance at **ITM GIDA, Gorakhpur, Uttar Pradesh, India**.

The website must let an authorized student sign in with their college
roll number and password, verify that their device is within the
configured college geofence, and then mark attendance. Attendance
records must be stored in the project owner's Google Sheets account. Use
Google Apps Script as the backend and Google Sheets as the database. Use
Google Apps Script's Gmail service for password-recovery OTP emails
(**Option A**).

This is a website, not a native Android/iOS app.

### Core rule

The **Mark Present** button must remain disabled until the website
obtains a sufficiently accurate location reading and determines that the
device is within **200 metres** of the configured college coordinates.
The backend must independently validate the request before saving
attendance. Do not trust the browser-only button state.

## 2. College Geofence Configuration

Put these values in a central configuration module / Settings sheet so
an administrator can change them without editing multiple files.

-   Institution: ITM GIDA, Gorakhpur
-   Centre latitude: `26.742681`
-   Centre longitude: `83.273421`
-   Allowed radius: `200` metres
-   Distance calculation: Haversine formula
-   Timezone: `Asia/Kolkata`
-   Date/time display: Indian local date and time

Use a configurable maximum location accuracy, initially **50 metres**.
If browser-reported accuracy is worse than the configured maximum, show
a message asking the student to retry. If the device is near the 200 m
boundary and GPS accuracy makes the result uncertain, do not mark
present; ask them to retry in a location with a better GPS fix.

**Important limitation:** Browser geolocation is an estimate supplied by
the device/browser and can be spoofed or manipulated. GPS geofencing is
a useful deterrent, not cryptographic proof that a person is physically
on campus. Never claim the website makes proxy attendance impossible.

## 3. Recommended Architecture

-   **Frontend:** HTML, CSS, vanilla JavaScript (or a small framework
    only if genuinely useful).
-   **Backend:** Google Apps Script Web App.
-   **Database:** Google Sheets in the project owner's Google account.
-   **Email OTP:** `MailApp` or `GmailApp` from Apps Script, subject to
    Google quotas and account permissions.
-   **Optional files/reports:** Google Drive.
-   **Deployment:** Apps Script web app deployed by the project owner
    from their own Google account.

Build a clean separation between UI code and server-side business logic.
All authentication, OTP validation, attendance checks, and database
writes must happen on the server. Do not expose spreadsheet IDs,
privileged data, password hashes, or secrets to the client.

Do not claim that the app has been deployed or connected to the owner's
Drive unless that has actually been done. Provide deployment
instructions and placeholders for the owner to fill in.

## 4. User Roles

### Student

-   Sign in with college roll number and password.
-   View their basic profile.
-   Check location eligibility.
-   Mark attendance when eligible and within the permitted attendance
    window, if one is configured.
-   View their own attendance history and today's attendance status.
-   Reset a forgotten password using OTP sent to the email already
    verified and stored in the authorized student roster.
-   Sign out.

### Admin

Create a protected admin area or document a secure admin-only setup
for: - Importing/maintaining the authorized student roster. -
Activating/deactivating student accounts. - Configuring geofence radius,
centre coordinates, location accuracy threshold, and attendance
window. - Viewing attendance reports and filtering by date, student,
course, semester, and section. - Exporting attendance to CSV/Google
Sheets. - Reviewing security/audit events. - Resetting or disabling an
account when necessary.

Do not create a default public admin password. Provide a safe initial
admin setup procedure, and keep admin authorization on the server. If
full admin UI is outside the first release, provide a clearly
documented, restricted setup method and a roadmap for the admin UI.

## 5. Authentication and Registration

### Login

-   Login fields: college roll number and password.
-   Normalize roll numbers consistently (for example, trim whitespace
    and apply a consistent case rule if roll numbers are
    case-insensitive).
-   Do not reveal whether a particular roll number exists in the
    database. Use a generic login failure message.
-   Use server-side session/token validation for protected actions.
-   Add login throttling / temporary lockout after repeated failures.
-   Do not store passwords in plaintext.
-   Use a strong password-hashing scheme with a unique salt. Do not
    invent a weak custom hash. If Apps Script cannot safely support a
    suitable password-hashing approach, document the limitation and
    implement a vetted approach compatible with the chosen platform, or
    recommend a backend that can do so securely rather than silently
    storing plaintext passwords.
-   Do not send passwords by email.

### Student registration / account provisioning

The app must not allow anyone to register as an arbitrary student just
by typing a roll number and email.

Preferred initial provisioning: 1. The college/project administrator
imports an authorized student roster into the `Students` sheet. 2. Each
student record includes the student's roll number, name, course,
semester, section, pre-verified email, and active status. 3. Accounts
are created only for students matched to that roster. 4. The first-time
account activation process must verify the email using an OTP sent to
the email already stored in the roster. Do not let a student replace the
roster email during activation. 5. If an email is missing or incorrect,
require an authorized administrator to correct it after verifying the
student's identity.

If registration is implemented, include rate limits, OTP expiry,
duplicate-account checks, and server-side roster matching.

## 6. Forgot Password --- Gmail OTP (Option A)

Use Google Apps Script `MailApp` or `GmailApp` to send a one-time
password-reset code to the **pre-verified email stored in the student
roster**.

### Flow

1.  Student selects **Forgot password**.
2.  Student enters their roll number.
3.  Server looks up the authorized student record and retrieves the
    verified email from the server-side database.
4.  For privacy, show a masked destination email only when appropriate.
    Use a generic response that does not reveal whether a roll number
    exists.
5.  Generate a cryptographically strong, random six-digit OTP on the
    server.
6.  Send the OTP from the project owner's authorized Google account
    using Apps Script mail service.
7.  OTP expires after **5 minutes**.
8.  Limit resend frequency (initial suggestion: one resend per 60
    seconds) and cap total OTP attempts (initial suggestion: 5 attempts
    per request).
9.  Store only a protected representation of the OTP where practical
    (for example, a keyed hash/HMAC with a server-side secret); never
    place the OTP in client-side JavaScript, URLs, logs, or a publicly
    accessible sheet.
10. Verify OTP on the server. Invalidate it after successful use,
    expiry, too many attempts, or a newer OTP request.
11. Allow password reset only after successful OTP verification.
12. Invalidate active sessions after a successful password reset where
    feasible.
13. Send a confirmation email after the password has been changed,
    without including the password.

### Email delivery and quotas

-   Add clear error handling if Apps Script email quotas are exceeded or
    email delivery fails.
-   Do not falsely report that an email was sent if the mail service
    returned an error.
-   Include a clean, professional email template with the product name
    **GeoAttend**, OTP, expiry time, and a warning not to share the
    code.
-   Make sender identity/configuration explicit in deployment
    documentation.
-   Never use an email address supplied only in the password-reset form
    as the destination.

## 7. Geolocation and Mark Attendance Flow

### Frontend behavior

1.  After successful login, display a **Check my location** button or
    automatically request location with a clear explanation.
2.  Request browser geolocation using
    `navigator.geolocation.getCurrentPosition`.
3.  Use high-accuracy mode where supported, with a reasonable timeout
    and maximum-age setting.
4.  Show a loading state while obtaining a fix.
5.  Read latitude, longitude, and reported accuracy. Do not request
    location continuously in the background.
6.  Calculate approximate distance from the configured college centre
    using the Haversine formula.
7.  Show distance and a clear status:
    -   **Eligible:** inside radius and accuracy is acceptable.
    -   **Outside permitted area:** beyond the radius.
    -   **Location too inaccurate:** accuracy exceeds the configured
        threshold or boundary result is uncertain.
    -   **Location permission denied / unavailable / timed out:**
        explain how to retry or enable location permissions.
8.  Keep **Mark Present** disabled unless all client-side checks pass.
9.  Recheck location immediately before the student taps Mark Present,
    or provide a clearly labelled recheck button. Do not rely on an old
    location reading.
10. Disable the button while the attendance request is in progress to
    prevent double-clicks.
11. Show a success confirmation only after the backend confirms the
    attendance write succeeded.

### Backend validation (mandatory)

When a student submits attendance, the server must: - Authenticate the
session and identify the student from the server-side session, not from
a client-supplied student name or ID. - Validate required request fields
and numeric coordinate ranges. - Validate reported accuracy against the
configured threshold. - Recompute distance on the server using the
configured coordinates and Haversine formula. - Reject requests outside
the permitted radius. - Reject requests with inadequate or uncertain
accuracy. - Check that the student is active and authorized. - Enforce
any configured attendance time window. - Prevent duplicate attendance
for the same student on the same attendance date (or apply an explicitly
configured session-based rule). - Use a lock (such as `LockService`)
around duplicate-check-and-write logic to reduce race-condition
duplicates. - Record the server-side timestamp in `Asia/Kolkata` and a
clear attendance date. - Return a structured success/error response. -
Write an audit/security event for suspicious or rejected requests
without storing unnecessary sensitive information.

Do not trust client-supplied distance, status, attendance date, student
name, or server time. The backend must calculate the authoritative
distance and timestamp.

### Distance logic

Use the Haversine formula on both client and server for user feedback
and server validation. The server's result is authoritative. Account for
the location's reported accuracy conservatively; do not accept a fix
simply because its calculated centre distance is under 200 m if the
uncertainty makes campus presence unclear. Make the boundary rule
configurable and document it.

## 8. Database Design --- Google Sheets

Create a spreadsheet called **GeoAttend Database** (or use a configured
spreadsheet ID provided by the owner). Use separate tabs with headers
and validation.

### `Students`

Suggested columns: - `student_id` (internal stable ID; not necessarily
the roll number) - `roll_number` - `full_name` - `course` - `semester` -
`section` - `verified_email` - `email_verified` (boolean) -
`account_status` (`PENDING`, `ACTIVE`, `DISABLED`) - `created_at` -
`updated_at`

Do not expose the entire Students sheet to students. Students should
only receive their own profile fields.

### `Credentials`

Suggested columns: - `student_id` - `password_hash` - `password_salt`
(if required by the selected vetted hashing approach) -
`password_updated_at` - `failed_login_count` - `locked_until` -
`updated_at`

Restrict access to this sheet. Never send credential fields to the
browser. Never store plaintext passwords.

### `Attendance`

Suggested columns: - `attendance_id` - `attendance_date` -
`server_timestamp` - `student_id` - `roll_number` (optional reporting
convenience) - `status` - `distance_meters` (server-calculated) -
`reported_accuracy_meters` - `validation_result` - `created_at`

Store only location details needed for audit and attendance validation.
Avoid retaining raw coordinates indefinitely unless there is a clear
administrative need and a defined retention policy. If raw coordinates
are stored for troubleshooting, restrict access and set a retention
period.

### `OTPRequests`

Suggested columns: - `request_id` - `student_id` -
`otp_hash_or_protected_value` - `created_at` - `expires_at` -
`attempt_count` - `resend_count` - `used_at` - `request_status`

Do not store raw OTP values in plaintext. Limit access to this sheet and
clean up expired entries periodically.

### `Settings`

Suggested keys: - `college_name` - `centre_latitude` -
`centre_longitude` - `allowed_radius_meters` -
`max_location_accuracy_meters` - `timezone` - `attendance_start_time`
(optional) - `attendance_end_time` (optional) - `duplicate_rule`
(e.g. one attendance per student per date) - `location_boundary_policy`

Validate settings on the server before using them.

### `AuditLogs`

Suggested columns: - `event_id` - `server_timestamp` - `event_type` -
`student_id` (nullable) - `outcome` - `reason_code` - `request_id`
(where applicable)

Do not write passwords, OTPs, session tokens, or other secrets to logs.

### `RegisteredDevices` (optional future feature)

Do not claim a website can reliably access an IMEI, device serial
number, or actual hardware device name. Browsers do not generally expose
these identifiers. If device binding is later added, use an appropriate
cryptographic credential such as WebAuthn/passkeys where supported,
explain that passkeys may sync across devices, and do not treat device
binding as proof of physical presence. Device binding is optional and
should not block the first usable release.

## 9. Security, Privacy, and Abuse Prevention

Implement and document: - Server-side authorization for every protected
action. - HTTPS through the deployed Google Apps Script web app. -
Secure session handling, expiry, logout, and token rotation where
applicable. - No passwords, OTPs, secrets, or session tokens in logs. -
Login and OTP rate limits. - Generic authentication/recovery responses
to reduce account enumeration. - Input validation and output escaping. -
Protection against duplicate submissions and race conditions. -
Admin-only access to all-student data and settings. - Minimal collection
and retention of location data. - Clear consent/explanation before
requesting geolocation. - A privacy notice explaining what data is
collected, why, who can access it, and how long it is retained. - A
documented process for correcting a student's email or roster record. -
Backups and export instructions for the Google Sheet. - Do not place
privileged configuration secrets in client-side code. - Do not use
hidden client-side fields as a security control.

Because this is a prototype built on Apps Script and Sheets, document
the platform's quotas, latency, concurrency, and security limitations.
If this will be used for official high-stakes attendance at scale,
recommend a security review and consider a more robust
database/authentication backend.

## 10. UI / UX Requirements

Create a professional, modern, accessible interface with responsive
layouts for mobile, tablet, and desktop.

### Pages / screens

1.  **Login**
    -   GeoAttend wordmark/title.
    -   Roll number and password fields.
    -   Show/hide password.
    -   Forgot password link.
    -   Clear validation and error states.
2.  **Student dashboard**
    -   Student name and roll number.
    -   Today's attendance status.
    -   Location-check panel.
    -   Distance from college centre (approximate).
    -   GPS accuracy value.
    -   Clear location eligibility badge.
    -   Disabled/enabled Mark Present button.
    -   Attendance history.
    -   Logout.
3.  **Forgot password**
    -   Roll number entry.
    -   OTP entry.
    -   New password and confirmation fields.
    -   OTP countdown/expiry messaging.
    -   Resend button with cooldown.
    -   Generic error messaging.
4.  **Admin dashboard**
    -   Summary cards.
    -   Attendance table with filters.
    -   Date-based reports and CSV export.
    -   Student account management.
    -   Geofence and attendance settings.
    -   Audit events.

### UX states

Design explicit states for: - Initial location permission request. -
Location loading. - Location success and inside geofence. - Outside
geofence. - Poor accuracy / uncertain boundary. - Permission denied. -
Timeout / unavailable location. - Attendance submission in progress. -
Attendance success. - Already marked present. - Network or server
error. - Expired OTP and incorrect OTP. - Too many attempts /
cooldown. - Inactive student account.

Use accessible labels, keyboard navigation, readable contrast, clear
focus states, and meaningful error messages. Avoid unnecessary
animations and do not use a map as a prerequisite for the core flow.

## 11. Attendance Reports

Admin reporting should support: - Daily attendance list. - Date-range
report. - Search by roll number/name. - Filters by course, semester, and
section. - Present count and attendance percentage for a selected
period, with the denominator clearly defined. - Export to CSV or a
downloadable spreadsheet.

Use server-side filtering for larger datasets where practical. Do not
expose all students' attendance history to student accounts. Students
can see only their own records.

## 12. Suggested Apps Script Project Structure

Organize the code into readable modules/files. Exact file names can
vary, but separate responsibilities.

-   `Code.gs` --- web app entry points, routing, shared server
    utilities.
-   `Config.gs` --- spreadsheet ID and validated configuration access.
-   `Auth.gs` --- login, session checks, logout, password update.
-   `Otp.gs` --- OTP generation, sending, verification, rate limiting.
-   `GeoFence.gs` --- distance calculation and server-side geofence
    validation.
-   `Attendance.gs` --- duplicate checks, attendance writes, reports.
-   `Students.gs` --- roster lookup and student profile.
-   `Admin.gs` --- admin authorization and admin operations.
-   `Audit.gs` --- security/audit logging.
-   `Index.html` --- app shell.
-   `Styles.html` --- shared CSS.
-   `Client.html` or `Scripts.html` --- client JavaScript.
-   Additional partials for login, dashboard, recovery, and admin pages
    if useful.

Use `google.script.run` or the selected Apps Script-supported request
pattern carefully. Provide a consistent success/error response format
and handle asynchronous calls in the frontend.

## 13. Required Deliverables from Antigravity

Produce a complete, runnable implementation, not just a mockup.

1.  Full frontend and Apps Script backend source code.
2.  Google Sheets schema/setup script that creates the required tabs and
    headers.
3.  A safe configuration mechanism for the spreadsheet ID and settings.
4.  Login and session handling.
5.  Student roster validation and account provisioning/activation flow.
6.  Gmail OTP password recovery.
7.  Geofence location check and disabled/enabled Mark Present UI.
8.  Independent server-side geofence validation.
9.  Duplicate attendance prevention.
10. Admin-only attendance reports and export, or a clearly documented
    secure first-release alternative.
11. Error handling and useful logging without secrets.
12. Sample/test data clearly labelled as fake; never use fake student
    records in production.
13. Automated or manual test plan with expected results.
14. Step-by-step deployment instructions for a non-expert user.
15. A README explaining setup, permissions, configuration, limitations,
    maintenance, and troubleshooting.
16. No unfinished placeholder functions in the core flow. If any
    platform limitation prevents a secure implementation, explain it
    explicitly and propose the safest practical alternative.

## 14. Setup and Deployment Instructions to Include

Write instructions that explain: 1. Create a Google Spreadsheet named
`GeoAttend Database`. 2. Create/open an Apps Script project associated
with the owner's Google account. 3. Add all source files and configure
the spreadsheet ID through server-side script properties or a clearly
documented setting. 4. Run a setup function to create tabs/headers and
validate settings. 5. Authorize the required Google Sheets and email
permissions. 6. Configure the administrator securely without a hardcoded
public password. 7. Import the authorized student roster with
pre-verified email addresses. 8. Test OTP delivery using a test account
and verify Apps Script email quotas. 9. Deploy as a Web App with the
correct execution identity and access settings. Explain who the app
executes as and who can access it; do not choose an overly broad access
setting without warning. 10. Test the web app on a phone using HTTPS and
grant location permission. 11. Run the test checklist below. 12. Explain
how to update the deployment after code changes and how to back up the
spreadsheet.

Never ask the user to paste private passwords, Google account
credentials, or live OTPs into Antigravity or the generated source code.
Use placeholders and owner-side setup steps.

## 15. Test Plan / Acceptance Criteria

The project is not complete until these cases are tested:

### Authentication

-   Valid active student can log in.
-   Incorrect password fails with a generic message.
-   Unknown roll number does not disclose whether it exists.
-   Repeated failures trigger throttling or lockout.
-   Inactive student cannot mark attendance.
-   Student cannot access another student's profile or attendance.

### OTP recovery

-   OTP is sent only to the email stored in the authorized roster.
-   A student cannot substitute an arbitrary email address.
-   Correct OTP within 5 minutes permits reset.
-   Incorrect OTP fails.
-   Expired OTP fails.
-   OTP cannot be reused.
-   Too many attempts and excessive resends are blocked.
-   Password reset confirmation is sent without disclosing the password.
-   Passwords and OTPs are not stored in plaintext or logged.

### Geofence

-   Device clearly inside the 200 m radius with acceptable accuracy:
    eligible to attempt attendance.
-   Device clearly outside the 200 m radius: Mark Present remains
    disabled and server rejects the request.
-   Poor-accuracy location: user is asked to retry.
-   Location permission denied, unavailable, or timed out: useful
    instructions appear.
-   Near-boundary uncertain location: not accepted until a sufficiently
    reliable fix is obtained.
-   Tampering with the client-side button or request does not bypass
    server validation.
-   Client-supplied distance/status/date is ignored by the server.
-   Invalid coordinates or accuracy values are rejected.

### Attendance integrity

-   Successful request creates one attendance record with server
    timestamp.
-   Double-clicks or concurrent requests do not create duplicate
    attendance.
-   A second attempt on the same date returns an "already marked"
    message.
-   Only authorized students can create attendance.
-   Admin can filter and export reports.
-   Student can view only their own attendance history.

### Operations

-   Email quota/delivery errors are handled gracefully.
-   Spreadsheet access or server failures do not show false success.
-   Mobile layout works in common browsers.
-   All key actions have loading, success, and error states.

## 16. Known Limitations and Future Improvements

-   GPS location from a browser can be spoofed. It cannot alone prove
    physical presence.
-   A browser cannot reliably read IMEI, hardware serial number, or a
    unique device name.
-   Google Apps Script and Sheets have quotas and are not a high-scale
    transactional database.
-   Email delivery depends on Google account permissions and quotas.
-   A stronger future version could add rotating classroom QR codes,
    WebAuthn/passkeys, institutional SSO, a dedicated database, and an
    independent email provider. These are future improvements, not
    requirements to silently add to the initial release.
-   If QR attendance is added later, it should use a short-lived
    server-validated token rather than a static reusable QR code.

## 17. Instructions to Antigravity

Treat this document as the source of truth. First inspect the
implementation environment and propose a short file plan, then implement
the full working project. Prioritize secure server-side logic and a
reliable end-to-end flow over visual decoration. Use the exact geofence
configuration above by default, but keep it configurable. Do not invent
real student data, credentials, spreadsheet IDs, or email addresses.
Where owner-only setup is required, provide explicit instructions and
safe placeholders.

Before declaring completion: - Review all server-side authorization
paths. - Verify that no secret or credential is exposed to the client. -
Run through the acceptance tests and report which tests were actually
executed versus which require the owner's live Google account. - List
any remaining limitations honestly.
