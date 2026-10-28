// ============================================================================
// MODULE: Config.gs
// ============================================================================
/**
 * GeoAttend â€” Configuration, Setup, and Database Access Module
 * Institution: ITM GIDA, Gorakhpur, Uttar Pradesh, India
 *
 * SECURITY NOTE:
 * Do NOT hardcode real Spreadsheet IDs or secrets in source files if committing to public repositories.
 * Set SPREADSHEET_ID and HMAC_SECRET via Apps Script Project Settings -> Script Properties,
 * or run initializeSystemConfiguration(spreadsheetId) from the Apps Script Editor once.
 */

var SHEET_NAMES = {
  STUDENTS: 'Students',
  CREDENTIALS: 'Credentials',
  ATTENDANCE: 'Attendance',
  OTP_REQUESTS: 'OTPRequests',
  SETTINGS: 'Settings',
  AUDIT_LOGS: 'AuditLogs',
  SESSIONS: 'Sessions'
};

var DEFAULT_SETTINGS = {
  college_name: 'ITM GIDA, Gorakhpur',
  centre_latitude: '26.742681',
  centre_longitude: '83.273421',
  allowed_radius_meters: '200',
  max_location_accuracy_meters: '50',
  timezone: 'Asia/Kolkata',
  attendance_start_time: '08:30',
  attendance_end_time: '17:30',
  enforce_attendance_window: 'false',
  duplicate_rule: 'ONE_PER_DATE',
  location_boundary_policy: 'CONSERVATIVE' // CONSERVATIVE requires distance + min(accuracy, 25) <= radius, or strict accuracy check
};

var CONFIGURED_SPREADSHEET_ID = 'https://docs.google.com/spreadsheets/d/1KVdNgiVjn0DYLv-ASF0zh_zNkCVJ3NK8ezrDpxJQzdI/edit?gid=0#gid=0';
var CONFIGURED_ADMIN_EMAIL = 'harshhzz505@gmail.com';

/**
 * Helper to configure the Script Properties for the first time.
 * Automatically persists CONFIGURED_SPREADSHEET_ID into ScriptProperties if not already set.
 */
function configureSpreadsheetIdPlaceholder() {
  var props = PropertiesService.getScriptProperties();
  var currentId = props.getProperty('SPREADSHEET_ID');
  if (!currentId || currentId === 'YOUR_SPREADSHEET_ID_HERE') {
    props.setProperty('SPREADSHEET_ID', CONFIGURED_SPREADSHEET_ID);
  }
  ensureServerSecrets();
  Logger.log('Script properties initialized. Current SPREADSHEET_ID: ' + props.getProperty('SPREADSHEET_ID'));
}

/**
 * Ensures cryptographic secrets exist in ScriptProperties for HMAC and PBKDF2-like iterated hashing.
 */
function ensureServerSecrets() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('HMAC_SECRET');
  if (!secret) {
    var randomBytes = [];
    for (var i = 0; i < 4; i++) {
      randomBytes.push(Utilities.getUuid());
    }
    secret = Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_512, randomBytes.join('-') + '-' + new Date().getTime())
    );
    props.setProperty('HMAC_SECRET', secret);
  }
  return secret;
}

/**
 * Retrieves the configured Spreadsheet instance safely.
 */
function getDatabaseSpreadsheet() {
  var props = PropertiesService.getScriptProperties();
  var spreadsheetId = props.getProperty('SPREADSHEET_ID');
  if (!spreadsheetId || spreadsheetId === 'YOUR_SPREADSHEET_ID_HERE') {
    spreadsheetId = CONFIGURED_SPREADSHEET_ID;
    props.setProperty('SPREADSHEET_ID', spreadsheetId);
  }
  try {
    return SpreadsheetApp.openById(spreadsheetId);
  } catch (e) {
    throw new Error('Unable to open GeoAttend Database spreadsheet. Verify SPREADSHEET_ID and permissions.');
  }
}

/**
 * Retrieves a specific sheet by name, throwing an error if missing.
 */
function getSheetByNameSafe(sheetName) {
  var ss = getDatabaseSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('Required database sheet "' + sheetName + '" is missing. Run setupGeoAttendDatabase() first.');
  }
  return sheet;
}

/**
 * Creates all required sheets, headers, formatting, and default settings.
 * Safe to run multiple times (idempotent).
 */
function setupGeoAttendDatabase() {
  ensureServerSecrets();
  var ss = getDatabaseSpreadsheet();

  var schemas = {};
  schemas[SHEET_NAMES.STUDENTS] = [
    'student_id',
    'roll_number',
    'full_name',
    'course',
    'semester',
    'section',
    'verified_email',
    'email_verified',
    'account_status',
    'role',
    'created_at',
    'updated_at'
  ];

  schemas[SHEET_NAMES.CREDENTIALS] = [
    'student_id',
    'password_hash',
    'password_salt',
    'password_updated_at',
    'failed_login_count',
    'locked_until',
    'updated_at'
  ];

  schemas[SHEET_NAMES.ATTENDANCE] = [
    'attendance_id',
    'attendance_date',
    'server_timestamp',
    'student_id',
    'roll_number',
    'status',
    'distance_meters',
    'reported_accuracy_meters',
    'effective_distance_meters',
    'validation_result',
    'created_at'
  ];

  schemas[SHEET_NAMES.OTP_REQUESTS] = [
    'request_id',
    'student_id',
    'purpose',
    'otp_hash',
    'created_at',
    'expires_at',
    'attempt_count',
    'resend_count',
    'last_sent_at',
    'used_at',
    'request_status'
  ];

  schemas[SHEET_NAMES.SETTINGS] = [
    'setting_key',
    'setting_value',
    'description',
    'updated_at'
  ];

  schemas[SHEET_NAMES.AUDIT_LOGS] = [
    'event_id',
    'server_timestamp',
    'event_type',
    'student_id',
    'outcome',
    'reason_code',
    'request_id'
  ];

  schemas[SHEET_NAMES.SESSIONS] = [
    'token_hash',
    'student_id',
    'role',
    'created_at',
    'expires_at',
    'revoked_at'
  ];

  var sheetKeys = Object.keys(schemas);
  for (var i = 0; i < sheetKeys.length; i++) {
    var name = sheetKeys[i];
    var headers = schemas[name];
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
    }
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length)
        .setFontWeight('bold')
        .setBackground('#1e293b')
        .setFontColor('#ffffff');
      sheet.setFrozenRows(1);
    }
  }

  // Populate default settings if Settings sheet has only headers
  var settingsSheet = ss.getSheetByName(SHEET_NAMES.SETTINGS);
  var existingData = settingsSheet.getDataRange().getValues();
  var existingKeys = {};
  for (var r = 1; r < existingData.length; r++) {
    existingKeys[String(existingData[r][0]).trim()] = true;
  }

  var settingDescriptions = {
    college_name: 'Institution Name displayed across GeoAttend',
    centre_latitude: 'Geofence centre latitude in decimal degrees (ITM GIDA)',
    centre_longitude: 'Geofence centre longitude in decimal degrees (ITM GIDA)',
    allowed_radius_meters: 'Maximum allowed distance from campus centre in metres',
    max_location_accuracy_meters: 'Maximum acceptable GPS accuracy uncertainty in metres',
    timezone: 'IANA timezone identifier used for all attendance timestamps',
    attendance_start_time: 'Daily attendance opening time in HH:mm (24-hour IST)',
    attendance_end_time: 'Daily attendance closing time in HH:mm (24-hour IST)',
    enforce_attendance_window: 'Whether to strictly block attendance outside start/end time (true/false)',
    duplicate_rule: 'Duplicate prevention rule (ONE_PER_DATE)',
    location_boundary_policy: 'CONSERVATIVE (requires centre_distance + accuracy_buffer <= radius) or CENTRE_ONLY'
  };

  var nowIso = formatServerTimestamp(new Date());
  var rowsToAppend = [];
  var defaultKeys = Object.keys(DEFAULT_SETTINGS);
  for (var k = 0; k < defaultKeys.length; k++) {
    var key = defaultKeys[k];
    if (!existingKeys[key]) {
      rowsToAppend.push([
        key,
        DEFAULT_SETTINGS[key],
        settingDescriptions[key] || '',
        nowIso
      ]);
    }
  }

  if (rowsToAppend.length > 0) {
    settingsSheet.getRange(settingsSheet.getLastRow() + 1, 1, rowsToAppend.length, 4).setValues(rowsToAppend);
  }

  // Ensure initial Admin account (ADMIN001 -> harshhzz505@gmail.com) is provisioned in Students sheet
  seedSampleTestRoster();

  Logger.log('GeoAttend Database setup completed successfully.');
  return { ok: true, message: 'All database sheets, default settings, and initial Admin account initialized.' };
}

/**
 * Seeds the initial Administrator account (`ADMIN001` -> `harshhzz505@gmail.com`) and sample test records.
 * Safe to run multiple times: only populates if the Students sheet has no records yet.
 */
function seedSampleTestRoster() {
  var studentsSheet = getSheetByNameSafe(SHEET_NAMES.STUDENTS);
  var data = studentsSheet.getDataRange().getValues();
  if (data.length > 1) {
    Logger.log('Students sheet already contains records. Skipping initial seed to avoid overwriting data.');
    return;
  }

  var now = formatServerTimestamp(new Date());
  var sampleStudents = [
    [
      'ADM-001',
      'ADMIN001',
      'ITM System Administrator',
      'ADMINISTRATION',
      'N/A',
      'ALL',
      CONFIGURED_ADMIN_EMAIL,
      false,
      'PENDING',
      'ADMIN',
      now,
      now
    ],
    [
      'STU-TEST-001',
      '2026CSE001',
      'Aarav Sharma (SAMPLE TEST)',
      'B.Tech CSE',
      '6',
      'A',
      CONFIGURED_ADMIN_EMAIL,
      false,
      'PENDING',
      'STUDENT',
      now,
      now
    ],
    [
      'STU-TEST-002',
      '2026CSE002',
      'Priya Verma (SAMPLE TEST)',
      'B.Tech CSE',
      '6',
      'A',
      'student2.sample.test@example.com',
      true,
      'ACTIVE',
      'STUDENT',
      now,
      now
    ]
  ];

  studentsSheet.getRange(2, 1, sampleStudents.length, sampleStudents[0].length).setValues(sampleStudents);
  Logger.log('Initial Admin (ADMIN001 -> ' + CONFIGURED_ADMIN_EMAIL + ') and sample roster seeded. Use First-Time Account Activation (OTP) in the web app to set your password.');
}

/**
 * Reads and validates all system settings from the Settings sheet, falling back to safe defaults.
 */
function getValidatedSettings() {
  var raw = {};
  var defaultsKeys = Object.keys(DEFAULT_SETTINGS);
  for (var i = 0; i < defaultsKeys.length; i++) {
    raw[defaultsKeys[i]] = DEFAULT_SETTINGS[defaultsKeys[i]];
  }

  try {
    var sheet = getSheetByNameSafe(SHEET_NAMES.SETTINGS);
    var values = sheet.getDataRange().getValues();
    for (var r = 1; r < values.length; r++) {
      var k = String(values[r][0] || '').trim();
      var v = String(values[r][1] !== undefined && values[r][1] !== null ? values[r][1] : '').trim();
      if (k && v !== '') {
        raw[k] = v;
      }
    }
  } catch (e) {
    // Fallback to DEFAULT_SETTINGS if sheet not yet initialized
  }

  var lat = parseFloat(raw.centre_latitude);
  var lng = parseFloat(raw.centre_longitude);
  var radius = parseFloat(raw.allowed_radius_meters);
  var maxAcc = parseFloat(raw.max_location_accuracy_meters);

  if (isNaN(lat) || lat < -90 || lat > 90) lat = 26.742681;
  if (isNaN(lng) || lng < -180 || lng > 180) lng = 83.273421;
  if (isNaN(radius) || radius < 10 || radius > 5000) radius = 200;
  if (isNaN(maxAcc) || maxAcc < 5 || maxAcc > 500) maxAcc = 50;

  return {
    collegeName: String(raw.college_name || DEFAULT_SETTINGS.college_name),
    centreLatitude: lat,
    centreLongitude: lng,
    allowedRadiusMeters: radius,
    maxLocationAccuracyMeters: maxAcc,
    timezone: String(raw.timezone || 'Asia/Kolkata'),
    attendanceStartTime: String(raw.attendance_start_time || '08:30'),
    attendanceEndTime: String(raw.attendance_end_time || '17:30'),
    enforceAttendanceWindow: String(raw.enforce_attendance_window).toLowerCase() === 'true',
    duplicateRule: String(raw.duplicate_rule || 'ONE_PER_DATE'),
    locationBoundaryPolicy: String(raw.location_boundary_policy || 'CONSERVATIVE').toUpperCase()
  };
}

/**
 * Returns only public-safe geofence and institution settings to the client browser.
 */
function getPublicClientSettings() {
  var s = getValidatedSettings();
  return {
    collegeName: s.collegeName,
    centreLatitude: s.centreLatitude,
    centreLongitude: s.centreLongitude,
    allowedRadiusMeters: s.allowedRadiusMeters,
    maxLocationAccuracyMeters: s.maxLocationAccuracyMeters,
    timezone: s.timezone,
    attendanceStartTime: s.attendanceStartTime,
    attendanceEndTime: s.attendanceEndTime,
    enforceAttendanceWindow: s.enforceAttendanceWindow,
    locationBoundaryPolicy: s.locationBoundaryPolicy
  };
}

/**
 * Formats a Date object into ISO-like string in Asia/Kolkata timezone (YYYY-MM-DD HH:mm:ss IST).
 */
function formatServerTimestamp(dateObj) {
  var d = dateObj || new Date();
  return Utilities.formatDate(d, 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss');
}

/**
 * Formats a Date object into a canonical attendance date string in Asia/Kolkata (YYYY-MM-DD).
 */
function formatServerDate(dateObj) {
  var d = dateObj || new Date();
  return Utilities.formatDate(d, 'Asia/Kolkata', 'yyyy-MM-dd');
}



// ============================================================================
// MODULE: Audit.gs
// ============================================================================
/**
 * GeoAttend â€” Security & Audit Logging Module
 *
 * Records security-relevant events to the AuditLogs tab without ever storing
 * plaintext passwords, OTP codes, session tokens, or private secrets.
 */

/**
 * Writes an audit event to the AuditLogs sheet.
 *
 * @param {string} eventType - Category of event (e.g. LOGIN_SUCCESS, LOGIN_FAILED, ATTENDANCE_REJECTED, OTP_SENT, ADMIN_ACTION)
 * @param {string|null} studentId - Internal student_id if known, or null/empty
 * @param {string} outcome - SUCCESS, REJECTED, LOCKED, ERROR
 * @param {string} reasonCode - Concise machine/human readable reason without secrets
 * @param {string} [requestId] - Optional correlation or OTP request ID
 */
function writeAuditLog(eventType, studentId, outcome, reasonCode, requestId) {
  try {
    var sheet = getSheetByNameSafe(SHEET_NAMES.AUDIT_LOGS);
    var eventId = 'EVT-' + Utilities.getUuid().substring(0, 12).toUpperCase();
    var timestamp = formatServerTimestamp(new Date());
    var safeReason = sanitizeAuditField(reasonCode);
    var safeStudentId = sanitizeAuditField(studentId || 'ANONYMOUS');
    var safeRequestId = sanitizeAuditField(requestId || '');

    sheet.appendRow([
      eventId,
      timestamp,
      String(eventType || 'UNKNOWN').toUpperCase(),
      safeStudentId,
      String(outcome || 'INFO').toUpperCase(),
      safeReason,
      safeRequestId
    ]);
  } catch (e) {
    // Do not crash core flow if audit logging encounters a transient sheet error, but log to Apps Script execution log
    Logger.log('Audit log write warning: ' + e.message);
  }
}

/**
 * Sanitizes string values before writing to Google Sheets to prevent formula injection
 * and strip accidental sensitive lengths.
 */
function sanitizeAuditField(val) {
  var str = String(val === undefined || val === null ? '' : val).trim();
  if (str.length > 220) {
    str = str.substring(0, 220) + '...';
  }
  return preventSpreadsheetFormulaInjection(str);
}

/**
 * Prevents CSV / Google Sheets formula injection by prefixing leading =, +, -, @ with an apostrophe.
 */
function preventSpreadsheetFormulaInjection(val) {
  if (typeof val !== 'string') return val;
  var trimmed = val.trim();
  if (/^[=+\-@]/.test(trimmed)) {
    return "'" + trimmed;
  }
  return trimmed;
}



// ============================================================================
// MODULE: Students.gs
// ============================================================================
  /**
  * GeoAttend â€” Student Roster Lookup & Profile Management
  *
  * Ensures that only students in the authorized `Students` sheet can activate accounts,
  * reset passwords, or mark attendance. Students can only read their own profile.
  */

  /**
  * Normalizes a college roll number consistently (trim + uppercase).
  */
  function normalizeRollNumber(rollNumber) {
    if (rollNumber === undefined || rollNumber === null) return '';
    return String(rollNumber).trim().toUpperCase().replace(/\s+/g, '');
  }

  /**
  * Finds a student row in the `Students` sheet by normalized roll number.
  * Returns null if not found. Never expose this raw object directly to unauthenticated clients.
  */
  function findStudentByRollNumber(rollNumber) {
    var normRoll = normalizeRollNumber(rollNumber);
    if (!normRoll) return null;

    var sheet = getSheetByNameSafe(SHEET_NAMES.STUDENTS);
    var values = sheet.getDataRange().getValues();
    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      if (normalizeRollNumber(row[1]) === normRoll) {
        return mapRowToStudentObject(row, r + 1);
      }
    }
    return null;
  }

  /**
  * Finds a student row in the `Students` sheet by internal student_id.
  */
  function findStudentById(studentId) {
    var targetId = String(studentId || '').trim();
    if (!targetId) return null;

    var sheet = getSheetByNameSafe(SHEET_NAMES.STUDENTS);
    var values = sheet.getDataRange().getValues();
    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      if (String(row[0] || '').trim() === targetId) {
        return mapRowToStudentObject(row, r + 1);
      }
    }
    return null;
  }

  /**
  * Maps a raw sheet row array to a structured internal student record.
  */
  function mapRowToStudentObject(row, rowIndex) {
    return {
      rowIndex: rowIndex,
      studentId: String(row[0] || '').trim(),
      rollNumber: normalizeRollNumber(row[1]),
      fullName: String(row[2] || '').trim(),
      course: String(row[3] || '').trim(),
      semester: String(row[4] || '').trim(),
      section: String(row[5] || '').trim(),
      verifiedEmail: String(row[6] || '').trim().toLowerCase(),
      emailVerified: String(row[7]).toLowerCase() === 'true' || row[7] === true,
      accountStatus: String(row[8] || 'PENDING').trim().toUpperCase(),
      role: String(row[9] || 'STUDENT').trim().toUpperCase(),
      createdAt: String(row[10] || ''),
      updatedAt: String(row[11] || '')
    };
  }

  /**
  * Converts an internal student object into a safe public profile for the logged-in user.
  */
  function toSafeStudentProfile(student) {
    if (!student) return null;
    return {
      studentId: student.studentId,
      rollNumber: student.rollNumber,
      fullName: student.fullName,
      course: student.course,
      semester: student.semester,
      section: student.section,
      maskedEmail: maskEmailAddress(student.verifiedEmail),
      accountStatus: student.accountStatus,
      role: student.role
    };
  }

  /**
  * Masks an email address for privacy display (e.g., "aa***@example.com").
  */
  function maskEmailAddress(email) {
    var str = String(email || '').trim();
    var atIdx = str.indexOf('@');
    if (atIdx <= 0) return '***@***';
    var local = str.substring(0, atIdx);
    var domain = str.substring(atIdx + 1);
    var visibleLocal = local.length <= 2 ? local.charAt(0) : local.substring(0, 2);
    return visibleLocal + '***@' + domain;
  }

  /**
  * Marks a student's email as verified and sets status to ACTIVE upon first-time activation or OTP reset.
  */
  function activateStudentAccountIfNeeded(studentId) {
    var student = findStudentById(studentId);
    if (!student) return false;

    var sheet = getSheetByNameSafe(SHEET_NAMES.STUDENTS);
    var now = formatServerTimestamp(new Date());

    // Only transition PENDING -> ACTIVE; never automatically re-enable a DISABLED account
    var newStatus = student.accountStatus === 'PENDING' ? 'ACTIVE' : student.accountStatus;
    sheet.getRange(student.rowIndex, 8).setValue(true); // email_verified
    sheet.getRange(student.rowIndex, 9).setValue(newStatus); // account_status
    sheet.getRange(student.rowIndex, 12).setValue(now); // updated_at
    return true;
  }

  /**
  * Self-Registration: Allows a student to submit a registration request with their Roll Number,
  * Full Name, Course, Semester, Section, Email, and Password.
  * The account is created in `PENDING` status and cannot log in or mark attendance until
  * the Administrator clicks "Approve" in the Admin Console.
  */
  function selfRegisterStudentPendingApproval(payload) {
    if (!payload) {
      return { ok: false, message: 'Invalid registration data.' };
    }

    var rollNumber = normalizeRollNumber(payload.rollNumber);
    var fullName = preventSpreadsheetFormulaInjection(String(payload.fullName || '').trim());
    var course = preventSpreadsheetFormulaInjection(String(payload.course || 'B.Tech CSE').trim());
    var semester = preventSpreadsheetFormulaInjection(String(payload.semester || '1').trim());
    var section = preventSpreadsheetFormulaInjection(String(payload.section || 'A').trim());
    var email = String(payload.email || '').trim().toLowerCase();
    var password = String(payload.password || '');

    if (!rollNumber || rollNumber.length < 3) {
      return { ok: false, message: 'Please enter a valid College Roll Number.' };
    }
    if (!fullName || fullName.length < 2) {
      return { ok: false, message: 'Please enter your Full Name.' };
    }
    if (!email || email.indexOf('@') === -1) {
      return { ok: false, message: 'Please enter a valid Email Address (for password recovery).' };
    }
    if (password.length < AUTH_CONSTANTS.MIN_PASSWORD_LENGTH) {
      return {
        ok: false,
        message: 'Password must be at least ' + AUTH_CONSTANTS.MIN_PASSWORD_LENGTH + ' characters long.'
      };
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      var existing = findStudentByRollNumber(rollNumber);
      if (existing) {
        writeAuditLog('STUDENT_SELF_REGISTER_DUPLICATE', existing.studentId, 'REJECTED', 'ROLL_EXISTS:' + rollNumber);
        return {
          ok: false,
          message: 'This Roll Number (' + rollNumber + ') is already registered. If it is awaiting approval, please ask the Admin to approve it, or use Sign In / Forgot Password.'
        };
      }

      var studentId = 'STU-' + Utilities.getUuid().substring(0, 8).toUpperCase();
      var now = formatServerTimestamp(new Date());
      var sheet = getSheetByNameSafe(SHEET_NAMES.STUDENTS);

      sheet.appendRow([
        studentId,
        rollNumber,
        fullName,
        course,
        semester,
        section,
        email,
        false,
        'PENDING', // Requires Admin approval before login is permitted
        'STUDENT',
        now,
        now
      ]);

      // Hash and store the student's chosen password immediately so they can log in right after Admin clicks Approve
      upsertStudentPassword(studentId, password);

      writeAuditLog('STUDENT_SELF_REGISTERED', studentId, 'SUCCESS', 'ROLL:' + rollNumber + ',STATUS:PENDING_ADMIN_APPROVAL');

      return {
        ok: true,
        message: 'Registration submitted for Roll No ' + rollNumber + '! Your account is currently PENDING ADMIN APPROVAL. Once the Admin approves your account, you can sign in with your Roll Number and Password.'
      };
    } finally {
      lock.releaseLock();
    }
  }



// ============================================================================
// MODULE: Auth.gs
// ============================================================================
/**
 * GeoAttend â€” Authentication, Password Hashing, and Session Validation Module
 *
 * SECURITY ARCHITECTURE NOTE:
 * Google Apps Script does not natively expose compiled C-extensions like Argon2 or bcrypt.
 * To protect passwords strongly within the Apps Script runtime without storing plaintext or weak single-pass hashes,
 * this module implements a salted, peppered (server-side ScriptProperty HMAC_SECRET), 3,000-round iterated
 * HMAC-SHA512 key-stretching scheme with constant-time comparison, plus per-account failed-login lockout.
 */

var AUTH_CONSTANTS = {
  HASH_ITERATIONS: 3000,
  MAX_FAILED_ATTEMPTS: 5,
  LOCKOUT_DURATION_MINUTES: 15,
  SESSION_TTL_HOURS: 12,
  MIN_PASSWORD_LENGTH: 8
};

/**
 * Computes an iterated salted HMAC-SHA512 password hash.
 */
function computePasswordHash(password, salt) {
  var secretPepper = ensureServerSecrets();
  var hmacKey = secretPepper + ':' + String(salt);
  var currentBytes = Utilities.computeHmacSha256Signature(String(password), hmacKey);

  for (var i = 0; i < AUTH_CONSTANTS.HASH_ITERATIONS; i++) {
    currentBytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_512,
      currentBytes.concat(Utilities.newBlob(salt + ':' + i).getBytes())
    );
  }
  return Utilities.base64EncodeWebSafe(currentBytes);
}

/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 */
function constantTimeEquals(a, b) {
  var strA = String(a || '');
  var strB = String(b || '');
  var len = Math.max(strA.length, strB.length);
  var diff = strA.length ^ strB.length;
  for (var i = 0; i < len; i++) {
    var charA = i < strA.length ? strA.charCodeAt(i) : 0;
    var charB = i < strB.length ? strB.charCodeAt(i) : 0;
    diff |= (charA ^ charB);
  }
  return diff === 0;
}

/**
 * Finds the credential record for a given student_id.
 */
function findCredentialsByStudentId(studentId) {
  var targetId = String(studentId || '').trim();
  if (!targetId) return null;

  var sheet = getSheetByNameSafe(SHEET_NAMES.CREDENTIALS);
  var values = sheet.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (String(row[0] || '').trim() === targetId) {
      return {
        rowIndex: r + 1,
        studentId: String(row[0] || '').trim(),
        passwordHash: String(row[1] || '').trim(),
        passwordSalt: String(row[2] || '').trim(),
        passwordUpdatedAt: String(row[3] || ''),
        failedLoginCount: parseInt(row[4], 10) || 0,
        lockedUntil: String(row[5] || '').trim(),
        updatedAt: String(row[6] || '')
      };
    }
  }
  return null;
}

/**
 * Creates or updates a student's password hash and clears any login lockouts.
 */
function upsertStudentPassword(studentId, newPlainPassword) {
  var pwd = String(newPlainPassword || '');
  if (pwd.length < AUTH_CONSTANTS.MIN_PASSWORD_LENGTH) {
    throw new Error('Password must be at least ' + AUTH_CONSTANTS.MIN_PASSWORD_LENGTH + ' characters long.');
  }

  var salt = Utilities.getUuid() + '-' + Utilities.getUuid();
  var hash = computePasswordHash(pwd, salt);
  var now = formatServerTimestamp(new Date());

  var sheet = getSheetByNameSafe(SHEET_NAMES.CREDENTIALS);
  var existing = findCredentialsByStudentId(studentId);

  if (existing) {
    sheet.getRange(existing.rowIndex, 2, 1, 6).setValues([[
      hash,
      salt,
      now,
      0,
      '',
      now
    ]]);
  } else {
    sheet.appendRow([
      studentId,
      hash,
      salt,
      now,
      0,
      '',
      now
    ]);
  }

  // Revoke any active sessions for this user on password change
  revokeAllSessionsForStudent(studentId);
}

/**
 * Authenticates a student or admin using Roll Number and Password.
 * Uses generic error messages to prevent account enumeration.
 */
function loginWithRollAndPassword(rollNumber, password) {
  var genericError = 'Invalid roll number or password, or account requires first-time activation.';
  var normRoll = normalizeRollNumber(rollNumber);
  var rawPassword = String(password || '');

  if (!normRoll || !rawPassword) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Please enter both Roll Number and Password.' };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var student = findStudentByRollNumber(normRoll);
    if (!student) {
      // Perform dummy hash work to mitigate timing enumeration
      computePasswordHash(rawPassword, 'DUMMY-SALT-TIMING-MITIGATION');
      writeAuditLog('LOGIN_FAILED', null, 'REJECTED', 'UNKNOWN_ROLL:' + normRoll);
      return { ok: false, code: 'AUTH_FAILED', message: genericError };
    }

    if (student.accountStatus === 'DISABLED') {
      writeAuditLog('LOGIN_FAILED', student.studentId, 'REJECTED', 'ACCOUNT_DISABLED');
      return {
        ok: false,
        code: 'ACCOUNT_DISABLED',
        message: 'This account has been disabled. Please contact the ITM Administration cell.'
      };
    }

    var cred = findCredentialsByStudentId(student.studentId);
    if (!cred || !cred.passwordHash || !cred.passwordSalt) {
      writeAuditLog('LOGIN_FAILED', student.studentId, 'REJECTED', 'NO_CREDENTIALS_PROVISIONED');
      return { ok: false, code: 'AUTH_FAILED', message: genericError };
    }

    // Check temporary lockout
    var nowMs = new Date().getTime();
    if (cred.lockedUntil) {
      var lockExpiryMs = parseTimestampToMs(cred.lockedUntil);
      if (lockExpiryMs && nowMs < lockExpiryMs) {
        var remainingMin = Math.ceil((lockExpiryMs - nowMs) / 60000);
        writeAuditLog('LOGIN_LOCKED', student.studentId, 'LOCKED', 'LOCKED_UNTIL:' + cred.lockedUntil);
        return {
          ok: false,
          code: 'ACCOUNT_LOCKED',
          message: 'Too many failed attempts. Please wait ' + remainingMin + ' minute(s) or use Forgot Password.'
        };
      }
    }

    var candidateHash = computePasswordHash(rawPassword, cred.passwordSalt);
    if (!constantTimeEquals(candidateHash, cred.passwordHash)) {
      var newFailCount = cred.failedLoginCount + 1;
      var lockedUntilStr = '';
      if (newFailCount >= AUTH_CONSTANTS.MAX_FAILED_ATTEMPTS) {
        var unlockDate = new Date(nowMs + AUTH_CONSTANTS.LOCKOUT_DURATION_MINUTES * 60000);
        lockedUntilStr = formatServerTimestamp(unlockDate);
      }

      var credSheet = getSheetByNameSafe(SHEET_NAMES.CREDENTIALS);
      credSheet.getRange(cred.rowIndex, 5, 1, 3).setValues([[
        newFailCount,
        lockedUntilStr,
        formatServerTimestamp(new Date())
      ]]);

      writeAuditLog('LOGIN_FAILED', student.studentId, 'REJECTED', 'BAD_PASSWORD_ATTEMPT_' + newFailCount);
      if (lockedUntilStr) {
        return {
          ok: false,
          code: 'ACCOUNT_LOCKED',
          message: 'Account temporarily locked for ' + AUTH_CONSTANTS.LOCKOUT_DURATION_MINUTES + ' minutes due to repeated failed login attempts.'
        };
      }
      return { ok: false, code: 'AUTH_FAILED', message: genericError };
    }

    // Reset failed login counter if needed
    if (cred.failedLoginCount > 0 || cred.lockedUntil) {
      var credSheetClean = getSheetByNameSafe(SHEET_NAMES.CREDENTIALS);
      credSheetClean.getRange(cred.rowIndex, 5, 1, 3).setValues([[
        0,
        '',
        formatServerTimestamp(new Date())
      ]]);
    }

    if (student.accountStatus !== 'ACTIVE') {
      writeAuditLog('LOGIN_FAILED', student.studentId, 'REJECTED', 'STATUS_NOT_ACTIVE:' + student.accountStatus);
      return {
        ok: false,
        code: 'ACCOUNT_PENDING',
        message: 'Your account (' + student.rollNumber + ') is awaiting Administrator approval. Please wait for the Admin to approve your registration.'
      };
    }

    var sessionToken = createServerSession(student.studentId, student.role);
    writeAuditLog('LOGIN_SUCCESS', student.studentId, 'SUCCESS', 'ROLE:' + student.role);

    return {
      ok: true,
      sessionToken: sessionToken,
      profile: toSafeStudentProfile(student),
      settings: getPublicClientSettings(),
      todayAttendance: getStudentTodayAttendanceStatus(student.studentId),
      attendanceHistory: getStudentAttendanceHistory(student.studentId, 20)
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Generates a high-entropy opaque session token and stores only its HMAC hash on the server.
 */
function createServerSession(studentId, role) {
  var rawToken = Utilities.getUuid() + '-' + Utilities.getUuid() + '-' + new Date().getTime();
  var tokenHash = hashOpaqueToken(rawToken);
  var now = new Date();
  var expires = new Date(now.getTime() + AUTH_CONSTANTS.SESSION_TTL_HOURS * 3600000);

  var sheet = getSheetByNameSafe(SHEET_NAMES.SESSIONS);
  sheet.appendRow([
    tokenHash,
    studentId,
    role || 'STUDENT',
    formatServerTimestamp(now),
    formatServerTimestamp(expires),
    ''
  ]);

  // Also cache for fast lookup
  try {
    CacheService.getScriptCache().put(
      'SESS_' + tokenHash,
      JSON.stringify({ studentId: studentId, role: role || 'STUDENT', expiresMs: expires.getTime() }),
      AUTH_CONSTANTS.SESSION_TTL_HOURS * 3600
    );
  } catch (e) {
    // Ignore cache quota issues; sheet is authoritative
  }

  return rawToken;
}

/**
 * Computes HMAC-SHA256 hash of a session token or OTP code so raw values are never stored in Sheets.
 */
function hashOpaqueToken(rawValue) {
  var secret = ensureServerSecrets();
  var sig = Utilities.computeHmacSha256Signature(String(rawValue || ''), secret);
  return Utilities.base64EncodeWebSafe(sig);
}

/**
 * Validates a client-supplied sessionToken and returns the authoritative student record.
 * Throws or returns null if invalid, expired, or account disabled.
 */
function authenticateSessionToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 20) {
    return null;
  }

  var tokenHash = hashOpaqueToken(rawToken.trim());
  var nowMs = new Date().getTime();

  var sheet = getSheetByNameSafe(SHEET_NAMES.SESSIONS);
  var values = sheet.getDataRange().getValues();
  for (var r = values.length - 1; r >= 1; r--) {
    var row = values[r];
    if (String(row[0] || '') === tokenHash) {
      var revokedAt = String(row[5] || '').trim();
      if (revokedAt) return null;

      var expMs = parseTimestampToMs(row[4]);
      if (!expMs || nowMs > expMs) return null;

      var studentId = String(row[1] || '').trim();
      var student = findStudentById(studentId);
      if (!student || student.accountStatus !== 'ACTIVE') {
        return null;
      }
      return student;
    }
  }
  return null;
}

/**
 * Logs out a session token by marking it revoked in the Sessions sheet and clearing cache.
 */
function logoutSessionToken(rawToken) {
  if (!rawToken) return { ok: true };
  var tokenHash = hashOpaqueToken(String(rawToken).trim());
  try {
    CacheService.getScriptCache().remove('SESS_' + tokenHash);
    var sheet = getSheetByNameSafe(SHEET_NAMES.SESSIONS);
    var values = sheet.getDataRange().getValues();
    var now = formatServerTimestamp(new Date());
    for (var r = values.length - 1; r >= 1; r--) {
      if (String(values[r][0] || '') === tokenHash && !values[r][5]) {
        sheet.getRange(r + 1, 6).setValue(now);
        writeAuditLog('LOGOUT', String(values[r][1] || ''), 'SUCCESS', 'USER_LOGOUT');
        break;
      }
    }
  } catch (e) {
    Logger.log('Logout warning: ' + e.message);
  }
  return { ok: true };
}

/**
 * Revokes all active sessions for a student (called on password reset or account disable).
 */
function revokeAllSessionsForStudent(studentId) {
  var targetId = String(studentId || '').trim();
  if (!targetId) return;

  var sheet = getSheetByNameSafe(SHEET_NAMES.SESSIONS);
  var values = sheet.getDataRange().getValues();
  var now = formatServerTimestamp(new Date());
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][1] || '').trim() === targetId && !values[r][5]) {
      sheet.getRange(r + 1, 6).setValue(now);
      try {
        CacheService.getScriptCache().remove('SESS_' + String(values[r][0]));
      } catch (e) {}
    }
  }
}

/**
 * Parses a sheet cell (Date object or 'yyyy-MM-dd HH:mm:ss' IST string) into epoch milliseconds.
 */
function parseTimestampToMs(tsValue) {
  if (!tsValue) return 0;
  if (typeof tsValue.getTime === 'function') {
    var dMs = tsValue.getTime();
    return isNaN(dMs) ? 0 : dMs;
  }
  if (Object.prototype.toString.call(tsValue) === '[object Date]') {
    var objMs = tsValue.getTime();
    return isNaN(objMs) ? 0 : objMs;
  }
  var raw = String(tsValue).trim();
  if (!raw) return 0;

  // Match 'yyyy-MM-dd HH:mm:ss' or 'yyyy-MM-ddTHH:mm:ss'
  var isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (isoMatch) {
    var isoStr = isoMatch[1] + 'T' + isoMatch[2] + '+05:30';
    var parsedIso = Date.parse(isoStr);
    if (!isNaN(parsedIso)) return parsedIso;
  }

  var fallbackMs = Date.parse(raw);
  return isNaN(fallbackMs) ? 0 : fallbackMs;
}



// ============================================================================
// MODULE: Otp.gs
// ============================================================================
/**
 * GeoAttend â€” Gmail OTP Password Recovery & First-Time Account Activation (Option A)
 *
 * Strictly enforces:
 * - OTP is sent ONLY to the pre-verified email stored in the authorized `Students` sheet.
 * - Never accepts an arbitrary email supplied by the client as destination.
 * - 6-digit random OTP, 5-minute expiry, 60-second resend cooldown, max 5 verification attempts.
 * - Stores only HMAC-SHA256 hash of the OTP in `OTPRequests`.
 * - Checks MailApp daily quota and catches delivery errors honestly.
 */

var OTP_CONSTANTS = {
  EXPIRY_MINUTES: 5,
  RESEND_COOLDOWN_SECONDS: 60,
  MAX_VERIFY_ATTEMPTS: 5,
  MAX_RESENDS_PER_WINDOW: 3
};

/**
 * Generates a cryptographically strong 6-digit OTP string (100000 - 999999).
 */
function generateSixDigitOtp() {
  var seed = Utilities.getUuid() + '-' + Utilities.getUuid() + '-' + new Date().getTime();
  var digest = Utilities.computeHmacSha256Signature(seed, ensureServerSecrets());
  var num = ((digest[0] & 0x7f) << 24) |
            ((digest[1] & 0xff) << 16) |
            ((digest[2] & 0xff) << 8) |
            (digest[3] & 0xff);
  var sixDigit = 100000 + (Math.abs(num) % 900000);
  return String(sixDigit);
}

/**
 * Computes a domain-separated HMAC hash for an OTP tied to studentId and purpose.
 */
function computeOtpHash(studentId, purpose, otpCode) {
  var payload = String(studentId) + ':' + String(purpose) + ':' + String(otpCode).trim();
  return hashOpaqueToken(payload);
}

/**
 * Initiates an OTP request for either PASSWORD_RESET or ACCOUNT_ACTIVATION.
 * Uses a privacy-preserving generic response if the roll number does not exist.
 */
function requestRollNumberOtp(rollNumber, purpose) {
  var normRoll = normalizeRollNumber(rollNumber);
  var cleanPurpose = String(purpose || 'PASSWORD_RESET').toUpperCase() === 'ACCOUNT_ACTIVATION'
    ? 'ACCOUNT_ACTIVATION'
    : 'PASSWORD_RESET';

  if (!normRoll) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Please enter your College Roll Number.' };
  }

  var genericPrivacyResponse = {
    ok: true,
    expirySeconds: OTP_CONSTANTS.EXPIRY_MINUTES * 60,
    cooldownSeconds: OTP_CONSTANTS.RESEND_COOLDOWN_SECONDS,
    message: 'If this roll number is registered in the authorized ITM GIDA roster, a 6-digit verification code has been sent to its pre-registered institutional/verified email address.'
  };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var student = findStudentByRollNumber(normRoll);
    if (!student) {
      writeAuditLog('OTP_REQUEST', null, 'REJECTED', 'UNKNOWN_ROLL:' + normRoll);
      return genericPrivacyResponse;
    }

    if (student.accountStatus === 'DISABLED') {
      writeAuditLog('OTP_REQUEST', student.studentId, 'REJECTED', 'ACCOUNT_DISABLED');
      return genericPrivacyResponse;
    }

    if (!student.verifiedEmail || student.verifiedEmail.indexOf('@') === -1 || student.verifiedEmail.indexOf('replace-with-') === 0) {
      writeAuditLog('OTP_REQUEST', student.studentId, 'ERROR', 'INVALID_ROSTER_EMAIL');
      return {
        ok: false,
        code: 'ROSTER_EMAIL_MISSING',
        message: 'Your roster record does not have a valid pre-verified email configured yet. Please contact the ITM GIDA Administrator to update your official roster email.'
      };
    }

    var sheet = getSheetByNameSafe(SHEET_NAMES.OTP_REQUESTS);
    var values = sheet.getDataRange().getValues();
    var now = new Date();
    var nowMs = now.getTime();

    // Check active pending requests for cooldown and invalidate older ones
    var recentResendCount = 0;
    for (var r = values.length - 1; r >= 1; r--) {
      var row = values[r];
      if (String(row[1] || '') === student.studentId && String(row[10] || '') === 'PENDING') {
        var lastSentMs = parseTimestampToMs(row[8] || row[4]);
        if (lastSentMs && (nowMs - lastSentMs) < OTP_CONSTANTS.RESEND_COOLDOWN_SECONDS * 1000) {
          var waitSec = Math.ceil((OTP_CONSTANTS.RESEND_COOLDOWN_SECONDS * 1000 - (nowMs - lastSentMs)) / 1000);
          writeAuditLog('OTP_RATE_LIMITED', student.studentId, 'REJECTED', 'COOLDOWN_' + waitSec + 'S');
          return {
            ok: false,
            code: 'COOLDOWN_ACTIVE',
            cooldownSeconds: waitSec,
            message: 'Please wait ' + waitSec + ' seconds before requesting another OTP.'
          };
        }
        recentResendCount = (parseInt(row[7], 10) || 0) + 1;
        if (recentResendCount > OTP_CONSTANTS.MAX_RESENDS_PER_WINDOW) {
          var expMsCheck = parseTimestampToMs(row[5]);
          if (expMsCheck && nowMs < expMsCheck) {
            writeAuditLog('OTP_RATE_LIMITED', student.studentId, 'REJECTED', 'MAX_RESENDS_EXCEEDED');
            return {
              ok: false,
              code: 'TOO_MANY_RESENDS',
              message: 'Maximum OTP resend limit reached. Please wait 5 minutes before trying again.'
            };
          }
          recentResendCount = 0;
        }
        // Invalidate previous pending OTP
        sheet.getRange(r + 1, 11).setValue('SUPERSEDED');
      }
    }

    // Check Apps Script MailApp daily quota before committing OTP
    var remainingQuota = 0;
    try {
      remainingQuota = MailApp.getRemainingDailyQuota();
    } catch (quotaErr) {
      writeAuditLog('OTP_EMAIL_ERROR', student.studentId, 'ERROR', 'MAIL_PERMISSION_OR_QUOTA_CHECK_FAILED');
      return {
        ok: false,
        code: 'EMAIL_SERVICE_UNAVAILABLE',
        message: 'Email service is not authorized or unavailable on the server. Administrator must authorize MailApp permissions.'
      };
    }

    if (remainingQuota <= 0) {
      writeAuditLog('OTP_EMAIL_ERROR', student.studentId, 'ERROR', 'DAILY_EMAIL_QUOTA_EXHAUSTED');
      return {
        ok: false,
        code: 'QUOTA_EXCEEDED',
        message: 'Daily server email quota has been exhausted. Please try again tomorrow or contact the system administrator.'
      };
    }

    var otpPlain = generateSixDigitOtp();
    var otpHash = computeOtpHash(student.studentId, cleanPurpose, otpPlain);
    var requestId = 'OTP-' + Utilities.getUuid().substring(0, 10).toUpperCase();
    var createdAtStr = formatServerTimestamp(now);
    var expiresAtStr = formatServerTimestamp(new Date(nowMs + OTP_CONSTANTS.EXPIRY_MINUTES * 60000));

    // Send OTP Email first â€” never report success if MailApp throws an error
    try {
      sendOtpEmailToRosterAddress(student, otpPlain, cleanPurpose, OTP_CONSTANTS.EXPIRY_MINUTES);
    } catch (mailErr) {
      writeAuditLog('OTP_EMAIL_ERROR', student.studentId, 'ERROR', 'SEND_FAILED:' + mailErr.message, requestId);
      return {
        ok: false,
        code: 'EMAIL_DELIVERY_FAILED',
        message: 'Failed to send verification email via Google Mail service. Please try again later.'
      };
    }

    sheet.appendRow([
      requestId,
      student.studentId,
      cleanPurpose,
      otpHash,
      createdAtStr,
      expiresAtStr,
      0,
      recentResendCount,
      createdAtStr,
      '',
      'PENDING'
    ]);

    writeAuditLog('OTP_SENT', student.studentId, 'SUCCESS', cleanPurpose, requestId);
    return genericPrivacyResponse;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Verifies the 6-digit OTP and sets the student's new password.
 */
function verifyOtpAndSetPassword(rollNumber, otpCode, newPassword, purpose) {
  var normRoll = normalizeRollNumber(rollNumber);
  var cleanOtp = String(otpCode || '').trim();
  var rawPassword = String(newPassword || '');
  var cleanPurpose = String(purpose || 'PASSWORD_RESET').toUpperCase() === 'ACCOUNT_ACTIVATION'
    ? 'ACCOUNT_ACTIVATION'
    : 'PASSWORD_RESET';

  if (!normRoll || !/^\d{6}$/.test(cleanOtp)) {
    return { ok: false, code: 'INVALID_OTP_FORMAT', message: 'Please enter a valid Roll Number and 6-digit numeric OTP.' };
  }

  if (rawPassword.length < AUTH_CONSTANTS.MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: 'WEAK_PASSWORD',
      message: 'New password must be at least ' + AUTH_CONSTANTS.MIN_PASSWORD_LENGTH + ' characters long.'
    };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var student = findStudentByRollNumber(normRoll);
    if (!student || student.accountStatus === 'DISABLED') {
      writeAuditLog('OTP_VERIFY_FAILED', student ? student.studentId : null, 'REJECTED', 'INVALID_STUDENT_OR_DISABLED');
      return { ok: false, code: 'OTP_INVALID', message: 'Invalid or expired OTP verification code.' };
    }

    var sheet = getSheetByNameSafe(SHEET_NAMES.OTP_REQUESTS);
    var values = sheet.getDataRange().getValues();
    var now = new Date();
    var nowMs = now.getTime();

    // Find the latest PENDING OTP request for this student and purpose
    var targetRowIdx = -1;
    var targetRow = null;
    for (var r = values.length - 1; r >= 1; r--) {
      var row = values[r];
      if (
        String(row[1] || '') === student.studentId &&
        String(row[2] || '') === cleanPurpose &&
        String(row[10] || '') === 'PENDING'
      ) {
        targetRowIdx = r + 1;
        targetRow = row;
        break;
      }
    }

    if (!targetRow) {
      writeAuditLog('OTP_VERIFY_FAILED', student.studentId, 'REJECTED', 'NO_PENDING_OTP');
      return { ok: false, code: 'OTP_INVALID', message: 'Invalid or expired OTP verification code. Please request a new OTP.' };
    }

    var requestId = String(targetRow[0] || '');
    var expiresMs = parseTimestampToMs(targetRow[5]);
    var attempts = parseInt(targetRow[6], 10) || 0;

    if (!expiresMs || nowMs > expiresMs) {
      sheet.getRange(targetRowIdx, 11).setValue('EXPIRED');
      writeAuditLog('OTP_VERIFY_FAILED', student.studentId, 'REJECTED', 'OTP_EXPIRED', requestId);
      return { ok: false, code: 'OTP_EXPIRED', message: 'This OTP has expired (5-minute limit). Please request a new code.' };
    }

    if (attempts >= OTP_CONSTANTS.MAX_VERIFY_ATTEMPTS) {
      sheet.getRange(targetRowIdx, 11).setValue('MAX_ATTEMPTS_LOCKED');
      writeAuditLog('OTP_VERIFY_FAILED', student.studentId, 'LOCKED', 'MAX_ATTEMPTS_EXCEEDED', requestId);
      return { ok: false, code: 'MAX_ATTEMPTS', message: 'Too many incorrect OTP attempts. This code has been invalidated.' };
    }

    var candidateHash = computeOtpHash(student.studentId, cleanPurpose, cleanOtp);
    var storedHash = String(targetRow[3] || '');

    if (!constantTimeEquals(candidateHash, storedHash)) {
      var nextAttempts = attempts + 1;
      sheet.getRange(targetRowIdx, 7).setValue(nextAttempts);
      if (nextAttempts >= OTP_CONSTANTS.MAX_VERIFY_ATTEMPTS) {
        sheet.getRange(targetRowIdx, 11).setValue('MAX_ATTEMPTS_LOCKED');
      }
      writeAuditLog('OTP_VERIFY_FAILED', student.studentId, 'REJECTED', 'BAD_OTP_ATTEMPT_' + nextAttempts, requestId);
      var remaining = OTP_CONSTANTS.MAX_VERIFY_ATTEMPTS - nextAttempts;
      return {
        ok: false,
        code: 'OTP_INCORRECT',
        message: remaining > 0
          ? 'Incorrect OTP code. You have ' + remaining + ' attempt(s) remaining.'
          : 'Too many failed attempts. Please request a new OTP code.'
      };
    }

    // OTP is valid! Mark USED immediately before setting password
    var nowStr = formatServerTimestamp(now);
    sheet.getRange(targetRowIdx, 7).setValue(attempts + 1);
    sheet.getRange(targetRowIdx, 10).setValue(nowStr);
    sheet.getRange(targetRowIdx, 11).setValue('USED');

    // Update password & revoke active sessions
    upsertStudentPassword(student.studentId, rawPassword);
    // Mark email verified and activate account if pending
    activateStudentAccountIfNeeded(student.studentId);

    writeAuditLog('PASSWORD_UPDATED_VIA_OTP', student.studentId, 'SUCCESS', cleanPurpose, requestId);

    // Send confirmation email (without password)
    try {
      sendPasswordChangeConfirmationEmail(student, nowStr);
    } catch (confErr) {
      Logger.log('Password confirmation email non-fatal warning: ' + confErr.message);
    }

    return {
      ok: true,
      message: 'Your password has been updated and your account is active. You may now sign in.'
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Sends a clean HTML + plain-text OTP email using MailApp.
 */
function sendOtpEmailToRosterAddress(student, otpPlain, purpose, expiryMinutes) {
  var settings = getValidatedSettings();
  var actionLabel = purpose === 'ACCOUNT_ACTIVATION' ? 'First-Time Account Activation' : 'Password Reset';
  var subject = '[GeoAttend] ' + otpPlain + ' is your verification code (' + settings.collegeName + ')';

  var plainBody =
    'GeoAttend â€” ' + settings.collegeName + '\n' +
    '--------------------------------------------------\n' +
    'Hello ' + student.fullName + ' (' + student.rollNumber + '),\n\n' +
    'A request for ' + actionLabel + ' was received for your GeoAttend account.\n\n' +
    'Your 6-digit One-Time Password (OTP) is: ' + otpPlain + '\n\n' +
    'This code will expire in ' + expiryMinutes + ' minutes.\n' +
    'SECURITY WARNING: Never share this code with anyone, including faculty or administrators.\n\n' +
    'If you did not request this code, you can safely ignore this email.\n';

  var htmlBody =
    '<div style="font-family: Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; color: #0f172a;">' +
      '<div style="border-bottom: 1px solid #e2e8f0; padding-bottom: 14px; margin-bottom: 20px;">' +
        '<h2 style="margin: 0; color: #1e3a8a; font-size: 20px;">GeoAttend Verification</h2>' +
        '<p style="margin: 4px 0 0; font-size: 13px; color: #64748b;">' + escapeHtmlServer(settings.collegeName) + '</p>' +
      '</div>' +
      '<p style="font-size: 14px; line-height: 1.5;">Hello <strong>' + escapeHtmlServer(student.fullName) + '</strong> (<code>' + escapeHtmlServer(student.rollNumber) + '</code>),</p>' +
      '<p style="font-size: 14px; line-height: 1.5;">Use the following 6-digit verification code to complete your <strong>' + escapeHtmlServer(actionLabel) + '</strong>:</p>' +
      '<div style="background: #f8fafc; border: 1px dashed #94a3b8; border-radius: 8px; padding: 16px; text-align: center; margin: 20px 0;">' +
        '<span style="font-family: monospace; font-size: 30px; font-weight: 700; letter-spacing: 6px; color: #0f172a;">' + escapeHtmlServer(otpPlain) + '</span>' +
      '</div>' +
      '<p style="font-size: 13px; color: #475569;"><strong>Expiry:</strong> This code expires in <strong>' + expiryMinutes + ' minutes</strong>.</p>' +
      '<p style="font-size: 12px; color: #b91c1c; background: #fef2f2; padding: 10px; border-radius: 6px;"><strong>Security Notice:</strong> Never share this OTP with anyone. GeoAttend staff will never ask for your OTP or password.</p>' +
    '</div>';

  MailApp.sendEmail({
    to: student.verifiedEmail,
    subject: subject,
    body: plainBody,
    htmlBody: htmlBody,
    name: 'GeoAttend (' + settings.collegeName + ')'
  });
}

/**
 * Sends a confirmation email after a password has been changed or activated (never includes the password).
 */
function sendPasswordChangeConfirmationEmail(student, timestampStr) {
  var settings = getValidatedSettings();
  var subject = '[GeoAttend] Security Alert: Your password was updated';
  var plainBody =
    'Hello ' + student.fullName + ' (' + student.rollNumber + '),\n\n' +
    'Your GeoAttend account password for ' + settings.collegeName + ' was successfully updated on ' + timestampStr + ' (IST).\n' +
    'All previous active sessions have been signed out.\n\n' +
    'If you did not perform this change, please contact the ITM GIDA Administration immediately.\n';

  MailApp.sendEmail({
    to: student.verifiedEmail,
    subject: subject,
    body: plainBody,
    name: 'GeoAttend (' + settings.collegeName + ')'
  });
}

/**
 * Basic server-side HTML escaping for email templates.
 */
function escapeHtmlServer(str) {
  return String(str === undefined || str === null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}



// ============================================================================
// MODULE: GeoFence.gs
// ============================================================================
/**
 * GeoAttend â€” Haversine Distance & Authoritative Server-Side Geofence Validation
 *
 * Configured default target:
 * - Institution: ITM GIDA, Gorakhpur
 * - Centre Latitude: 26.742681
 * - Centre Longitude: 83.273421
 * - Allowed Radius: 200 metres
 * - Max Location Accuracy: 50 metres
 *
 * Boundary Policy:
 * By default (`CONSERVATIVE`), if a student is near the 200 m boundary and their reported GPS accuracy
 * uncertainty means their true position could be outside the 200 m boundary (`distance + accuracy > radius`
 * when within the boundary margin), the server rejects the reading as `UNCERTAIN_BOUNDARY` and asks for a tighter GPS fix.
 */

var EARTH_RADIUS_METERS = 6371000;

/**
 * Converts degrees to radians.
 */
function degreesToRadians(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Calculates great-circle distance in metres between two coordinates using the Haversine formula.
 */
function calculateHaversineDistanceMeters(lat1, lon1, lat2, lon2) {
  var dLat = degreesToRadians(lat2 - lat1);
  var dLon = degreesToRadians(lon2 - lon1);
  var rLat1 = degreesToRadians(lat1);
  var rLat2 = degreesToRadians(lat2);

  var a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/**
 * Evaluates client-reported coordinates and accuracy against the server's authoritative geofence settings.
 *
 * @param {number} reportedLat
 * @param {number} reportedLng
 * @param {number} reportedAccuracyMeters
 * @return {Object} Detailed validation decision
 */
function evaluateServerGeofence(reportedLat, reportedLng, reportedAccuracyMeters) {
  var settings = getValidatedSettings();

  var lat = Number(reportedLat);
  var lng = Number(reportedLng);
  var acc = Number(reportedAccuracyMeters);

  if (
    reportedLat === null || reportedLat === undefined || reportedLat === '' ||
    reportedLng === null || reportedLng === undefined || reportedLng === '' ||
    reportedAccuracyMeters === null || reportedAccuracyMeters === undefined || reportedAccuracyMeters === '' ||
    !isFinite(lat) || !isFinite(lng) || !isFinite(acc)
  ) {
    return {
      eligible: false,
      status: 'INVALID_COORDINATES',
      message: 'Valid numeric latitude, longitude, and GPS accuracy readings are required.'
    };
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return {
      eligible: false,
      status: 'OUT_OF_RANGE_COORDINATES',
      message: 'Coordinates are outside valid geographic bounds.'
    };
  }

  if (acc <= 0 || acc > 10000) {
    return {
      eligible: false,
      status: 'INVALID_ACCURACY',
      message: 'Reported GPS accuracy reading is invalid.'
    };
  }

  var distanceMeters = calculateHaversineDistanceMeters(
    settings.centreLatitude,
    settings.centreLongitude,
    lat,
    lng
  );
  var roundedDistance = Math.round(distanceMeters * 10) / 10;
  var roundedAccuracy = Math.round(acc * 10) / 10;
  var effectiveWorstCaseDistance = Math.round((distanceMeters + acc) * 10) / 10;

  // 1. Check accuracy threshold first (e.g., > 50m)
  if (acc > settings.maxLocationAccuracyMeters) {
    return {
      eligible: false,
      status: 'POOR_ACCURACY',
      distanceMeters: roundedDistance,
      accuracyMeters: roundedAccuracy,
      effectiveDistanceMeters: effectiveWorstCaseDistance,
      allowedRadiusMeters: settings.allowedRadiusMeters,
      maxAccuracyMeters: settings.maxLocationAccuracyMeters,
      message: 'GPS accuracy (' + roundedAccuracy + ' m) is worse than the required ' +
               settings.maxLocationAccuracyMeters + ' m threshold. Move outdoors with a clear sky view and retry.'
    };
  }

  // 2. Check if calculated centre distance is already outside radius (e.g., > 200m)
  if (distanceMeters > settings.allowedRadiusMeters) {
    return {
      eligible: false,
      status: 'OUTSIDE_GEOFENCE',
      distanceMeters: roundedDistance,
      accuracyMeters: roundedAccuracy,
      effectiveDistanceMeters: effectiveWorstCaseDistance,
      allowedRadiusMeters: settings.allowedRadiusMeters,
      maxAccuracyMeters: settings.maxLocationAccuracyMeters,
      message: 'You are ' + roundedDistance + ' m away from ' + settings.collegeName +
               ' (permitted radius: ' + settings.allowedRadiusMeters + ' m).'
    };
  }

  // 3. Conservative boundary uncertainty check:
  // If policy is CONSERVATIVE and (distance + accuracy > allowedRadiusMeters), the student is near the 200m edge
  // and their uncertainty circle extends outside campus. Ask for a better GPS fix or step further inside campus.
  if (
    settings.locationBoundaryPolicy === 'CONSERVATIVE' &&
    (distanceMeters + acc) > settings.allowedRadiusMeters
  ) {
    return {
      eligible: false,
      status: 'UNCERTAIN_BOUNDARY',
      distanceMeters: roundedDistance,
      accuracyMeters: roundedAccuracy,
      effectiveDistanceMeters: effectiveWorstCaseDistance,
      allowedRadiusMeters: settings.allowedRadiusMeters,
      maxAccuracyMeters: settings.maxLocationAccuracyMeters,
      message: 'Near geofence boundary: you are ~' + roundedDistance + ' m from centre with Â±' +
               roundedAccuracy + ' m GPS uncertainty (worst-case ' + effectiveWorstCaseDistance +
               ' m > ' + settings.allowedRadiusMeters + ' m). Please step further inside campus or retry for a sharper GPS fix.'
    };
  }

  return {
    eligible: true,
    status: 'ELIGIBLE_INSIDE_GEOFENCE',
    distanceMeters: roundedDistance,
    accuracyMeters: roundedAccuracy,
    effectiveDistanceMeters: effectiveWorstCaseDistance,
    allowedRadiusMeters: settings.allowedRadiusMeters,
    maxAccuracyMeters: settings.maxLocationAccuracyMeters,
    message: 'Location verified inside ' + settings.collegeName + ' geofence (' + roundedDistance + ' m from centre, Â±' + roundedAccuracy + ' m accuracy).'
  };
}



// ============================================================================
// MODULE: Attendance.gs
// ============================================================================
/**
 * GeoAttend â€” Attendance Recording, Duplicate Prevention, and Student History Module
 *
 * Enforces:
 * - Server-side session token authentication (never trusts client-supplied student_id or roll_number).
 * - Authoritative server-side geofence recomputation via `evaluateServerGeofence`.
 * - Optional attendance time-window enforcement (`attendance_start_time` to `attendance_end_time` in Asia/Kolkata).
 * - ScriptLock (`LockService`) around duplicate-check-and-write to eliminate race conditions.
 * - Minimal location data retention (stores server-calculated distance, reported accuracy, and validation status,
 *   not raw GPS coordinates, protecting student privacy).
 */

/**
 * Checks whether the current server time in Asia/Kolkata falls within the configured attendance window.
 */
function checkAttendanceTimeWindow(settings, nowDate) {
  if (!settings.enforceAttendanceWindow) {
    return { allowed: true };
  }

  var currentHm = Utilities.formatDate(nowDate, 'Asia/Kolkata', 'HH:mm');
  var startHm = String(settings.attendanceStartTime || '08:30').trim();
  var endHm = String(settings.attendanceEndTime || '17:30').trim();

  if (currentHm < startHm || currentHm > endHm) {
    return {
      allowed: false,
      message: 'Attendance window is currently closed. Permitted hours: ' + startHm + ' to ' + endHm + ' IST (current time: ' + currentHm + ' IST).'
    };
  }
  return { allowed: true };
}

/**
 * Checks if a student has already marked attendance on the specified date (`YYYY-MM-DD`).
 */
function findStudentAttendanceForDate(studentId, attendanceDateStr) {
  var sheet = getSheetByNameSafe(SHEET_NAMES.ATTENDANCE);
  var values = sheet.getDataRange().getValues();
  for (var r = values.length - 1; r >= 1; r--) {
    var row = values[r];
    var rowDate = normalizeSheetDateString(row[1]);
    var rowStudentId = String(row[3] || '').trim();
    var rowStatus = String(row[5] || '').trim().toUpperCase();
    if (rowStudentId === studentId && rowDate === attendanceDateStr && rowStatus === 'PRESENT') {
      return {
        attendanceId: String(row[0] || ''),
        attendanceDate: rowDate,
        serverTimestamp: String(row[2] || ''),
        status: rowStatus,
        distanceMeters: Number(row[6]),
        reportedAccuracyMeters: Number(row[7])
      };
    }
  }
  return null;
}

/**
 * Normalizes a date cell from Google Sheets (which may be auto-cast to a Date object or string) into `yyyy-MM-dd`.
 */
function normalizeSheetDateString(cellValue) {
  if (!cellValue) return '';
  if (Object.prototype.toString.call(cellValue) === '[object Date]') {
    return formatServerDate(cellValue);
  }
  var str = String(cellValue).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    return str.substring(0, 10);
  }
  var parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return formatServerDate(parsed);
  }
  return str;
}

/**
 * Returns the student's attendance status for today in Asia/Kolkata.
 */
function getStudentTodayAttendanceStatus(studentId) {
  var todayStr = formatServerDate(new Date());
  var record = findStudentAttendanceForDate(studentId, todayStr);
  if (record) {
    return {
      markedToday: true,
      attendanceDate: todayStr,
      record: record
    };
  }
  return {
    markedToday: false,
    attendanceDate: todayStr,
    record: null
  };
}

/**
 * Returns the most recent attendance records for a specific student (student-scoped).
 */
function getStudentAttendanceHistory(studentId, maxLimit) {
  var limit = maxLimit || 30;
  var sheet = getSheetByNameSafe(SHEET_NAMES.ATTENDANCE);
  var values = sheet.getDataRange().getValues();
  var history = [];

  for (var r = values.length - 1; r >= 1; r--) {
    var row = values[r];
    if (String(row[3] || '').trim() === studentId) {
      history.push({
        attendanceId: String(row[0] || ''),
        attendanceDate: normalizeSheetDateString(row[1]),
        serverTimestamp: String(row[2] || ''),
        status: String(row[5] || ''),
        distanceMeters: Number(row[6]),
        reportedAccuracyMeters: Number(row[7]),
        validationResult: String(row[9] || '')
      });
      if (history.length >= limit) break;
    }
  }
  return history;
}

/**
 * Authoritative endpoint to validate location and mark a student present.
 *
 * @param {string} sessionToken - Active session token
 * @param {number} reportedLat - Browser latitude
 * @param {number} reportedLng - Browser longitude
 * @param {number} reportedAccuracy - Browser accuracy in metres
 */
function submitStudentAttendance(sessionToken, reportedLat, reportedLng, reportedAccuracy) {
  var student = authenticateSessionToken(sessionToken);
  if (!student) {
    writeAuditLog('ATTENDANCE_REJECTED', null, 'REJECTED', 'INVALID_OR_EXPIRED_SESSION');
    return {
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Your session has expired or is invalid. Please sign in again.'
    };
  }

  if (student.accountStatus !== 'ACTIVE') {
    writeAuditLog('ATTENDANCE_REJECTED', student.studentId, 'REJECTED', 'ACCOUNT_NOT_ACTIVE:' + student.accountStatus);
    return {
      ok: false,
      code: 'ACCOUNT_INACTIVE',
      message: 'Your student account is not active. Please contact the administrator.'
    };
  }

  var settings = getValidatedSettings();
  var now = new Date();

  // Check optional attendance window
  var windowCheck = checkAttendanceTimeWindow(settings, now);
  if (!windowCheck.allowed) {
    writeAuditLog('ATTENDANCE_REJECTED', student.studentId, 'REJECTED', 'OUTSIDE_TIME_WINDOW');
    return {
      ok: false,
      code: 'OUTSIDE_TIME_WINDOW',
      message: windowCheck.message
    };
  }

  // Recompute geofence eligibility authoritatively on the server
  var geoResult = evaluateServerGeofence(reportedLat, reportedLng, reportedAccuracy);
  if (!geoResult.eligible) {
    writeAuditLog(
      'ATTENDANCE_REJECTED',
      student.studentId,
      'REJECTED',
      geoResult.status + ':dist=' + (geoResult.distanceMeters || 'NA') + 'm,acc=' + (geoResult.accuracyMeters || 'NA') + 'm'
    );
    return {
      ok: false,
      code: geoResult.status,
      geofence: geoResult,
      message: geoResult.message
    };
  }

  // Acquire exclusive script lock around duplicate check + sheet append
  var lock = LockService.getScriptLock();
  lock.waitLock(12000);
  try {
    var todayStr = formatServerDate(now);
    var existing = findStudentAttendanceForDate(student.studentId, todayStr);
    if (existing) {
      writeAuditLog('ATTENDANCE_DUPLICATE_BLOCKED', student.studentId, 'REJECTED', 'ALREADY_MARKED_ON_' + todayStr);
      return {
        ok: false,
        code: 'ALREADY_MARKED',
        todayAttendance: {
          markedToday: true,
          attendanceDate: todayStr,
          record: existing
        },
        message: 'Attendance has already been marked for today (' + todayStr + ' at ' + existing.serverTimestamp + ').'
      };
    }

    var attendanceId = 'ATT-' + Utilities.getUuid().substring(0, 10).toUpperCase();
    var timestampStr = formatServerTimestamp(now);
    var sheet = getSheetByNameSafe(SHEET_NAMES.ATTENDANCE);

    sheet.appendRow([
      attendanceId,
      "'" + todayStr, // Force text date representation so Sheets does not shift timezone
      timestampStr,
      student.studentId,
      student.rollNumber,
      'PRESENT',
      geoResult.distanceMeters,
      geoResult.accuracyMeters,
      geoResult.effectiveDistanceMeters,
      geoResult.status,
      timestampStr
    ]);

    writeAuditLog(
      'ATTENDANCE_MARKED',
      student.studentId,
      'SUCCESS',
      'DIST:' + geoResult.distanceMeters + 'm,ACC:' + geoResult.accuracyMeters + 'm',
      attendanceId
    );

    var createdRecord = {
      attendanceId: attendanceId,
      attendanceDate: todayStr,
      serverTimestamp: timestampStr,
      status: 'PRESENT',
      distanceMeters: geoResult.distanceMeters,
      reportedAccuracyMeters: geoResult.accuracyMeters
    };

    return {
      ok: true,
      code: 'MARKED_PRESENT',
      message: 'Attendance marked PRESENT for ' + todayStr + ' at ' + timestampStr + ' IST.',
      geofence: geoResult,
      todayAttendance: {
        markedToday: true,
        attendanceDate: todayStr,
        record: createdRecord
      },
      attendanceHistory: getStudentAttendanceHistory(student.studentId, 20)
    };
  } finally {
    lock.releaseLock();
  }
}



// ============================================================================
// MODULE: Admin.gs
// ============================================================================
/**
 * GeoAttend â€” Protected Admin Operations, Roster Provisioning, Settings, and Attendance Reports
 *
 * Every function in this module verifies on the server that the caller holds a valid,
 * non-expired session belonging to an ACTIVE user with `role === 'ADMIN'`.
 */

/**
 * Verifies that the session token belongs to an authorized ADMIN user.
 */
function requireAdminSession(sessionToken) {
  var user = authenticateSessionToken(sessionToken);
  if (!user) {
    writeAuditLog('ADMIN_ACCESS_DENIED', null, 'REJECTED', 'INVALID_SESSION');
    throw new Error('Unauthorized: Please sign in with an Administrator account.');
  }
  if (user.role !== 'ADMIN') {
    writeAuditLog('ADMIN_ACCESS_DENIED', user.studentId, 'REJECTED', 'NON_ADMIN_ROLE:' + user.role);
    throw new Error('Forbidden: Administrator privileges are required for this action.');
  }
  return user;
}

/**
 * Fetches summary metrics, filtered attendance report, student roster, settings, and recent audit logs for the Admin Dashboard.
 */
function getAdminDashboardBundle(sessionToken, filters) {
  var admin = requireAdminSession(sessionToken);
  var reportResult = queryAdminAttendanceReportInternal(filters || {});
  var studentsList = getAllStudentsForAdminInternal();
  var auditList = getRecentAuditLogsInternal(60);
  var settings = getValidatedSettings();

  return {
    ok: true,
    adminProfile: toSafeStudentProfile(admin),
    settings: settings,
    report: reportResult,
    students: studentsList,
    auditLogs: auditList
  };
}

/**
 * Queries attendance records with server-side filtering by date range, roll/name search, course, semester, and section.
 * Also calculates summary metrics and clearly defines the attendance percentage denominator.
 */
function queryAdminAttendanceReportInternal(filters) {
  var todayStr = formatServerDate(new Date());
  var startDate = filters && filters.startDate ? String(filters.startDate).trim() : todayStr;
  var endDate = filters && filters.endDate ? String(filters.endDate).trim() : todayStr;
  var searchQuery = filters && filters.search ? String(filters.search).trim().toUpperCase() : '';
  var courseFilter = filters && filters.course ? String(filters.course).trim().toUpperCase() : '';
  var semesterFilter = filters && filters.semester ? String(filters.semester).trim().toUpperCase() : '';
  var sectionFilter = filters && filters.section ? String(filters.section).trim().toUpperCase() : '';

  if (startDate > endDate) {
    var tmp = startDate;
    startDate = endDate;
    endDate = tmp;
  }

  // Load all students into a lookup map and count eligible active students matching cohort filters
  var studentSheet = getSheetByNameSafe(SHEET_NAMES.STUDENTS);
  var studentRows = studentSheet.getDataRange().getValues();
  var studentMap = {};
  var matchingCohortStudents = [];
  var distinctCourses = {};
  var distinctSemesters = {};
  var distinctSections = {};

  for (var s = 1; s < studentRows.length; s++) {
    var st = mapRowToStudentObject(studentRows[s], s + 1);
    if (st.role === 'ADMIN') continue; // Exclude admin accounts from student attendance denominator
    studentMap[st.studentId] = st;

    if (st.course) distinctCourses[st.course] = true;
    if (st.semester) distinctSemesters[st.semester] = true;
    if (st.section) distinctSections[st.section] = true;

    if (courseFilter && st.course.toUpperCase() !== courseFilter) continue;
    if (semesterFilter && st.semester.toUpperCase() !== semesterFilter) continue;
    if (sectionFilter && st.section.toUpperCase() !== sectionFilter) continue;
    if (
      searchQuery &&
      st.rollNumber.indexOf(searchQuery) === -1 &&
      st.fullName.toUpperCase().indexOf(searchQuery) === -1
    ) {
      continue;
    }

    if (st.accountStatus !== 'DISABLED') {
      matchingCohortStudents.push(st);
    }
  }

  // Load attendance records within [startDate, endDate]
  var attSheet = getSheetByNameSafe(SHEET_NAMES.ATTENDANCE);
  var attRows = attSheet.getDataRange().getValues();
  var filteredRecords = [];
  var distinctWorkingDatesInPeriod = {};

  for (var r = attRows.length - 1; r >= 1; r--) {
    var row = attRows[r];
    var attDate = normalizeSheetDateString(row[1]);
    if (attDate < startDate || attDate > endDate) continue;

    distinctWorkingDatesInPeriod[attDate] = true;

    var stId = String(row[3] || '').trim();
    var stObj = studentMap[stId];
    if (!stObj) continue;

    if (courseFilter && stObj.course.toUpperCase() !== courseFilter) continue;
    if (semesterFilter && stObj.semester.toUpperCase() !== semesterFilter) continue;
    if (sectionFilter && stObj.section.toUpperCase() !== sectionFilter) continue;
    if (
      searchQuery &&
      stObj.rollNumber.indexOf(searchQuery) === -1 &&
      stObj.fullName.toUpperCase().indexOf(searchQuery) === -1
    ) {
      continue;
    }

    filteredRecords.push({
      attendanceId: String(row[0] || ''),
      attendanceDate: attDate,
      serverTimestamp: String(row[2] || ''),
      studentId: stId,
      rollNumber: stObj.rollNumber,
      fullName: stObj.fullName,
      course: stObj.course,
      semester: stObj.semester,
      section: stObj.section,
      status: String(row[5] || 'PRESENT'),
      distanceMeters: Number(row[6]),
      reportedAccuracyMeters: Number(row[7]),
      validationResult: String(row[9] || '')
    });
  }

  var activeCohortSize = matchingCohortStudents.length;
  var activeDaysCount = Math.max(1, Object.keys(distinctWorkingDatesInPeriod).length);
  var denominatorTotal = activeCohortSize * activeDaysCount;
  var presentCount = filteredRecords.length;
  var attendancePercentage = denominatorTotal > 0
    ? Math.round((presentCount / denominatorTotal) * 1000) / 10
    : 0;

  return {
    filters: {
      startDate: startDate,
      endDate: endDate,
      search: searchQuery,
      course: courseFilter,
      semester: semesterFilter,
      section: sectionFilter
    },
    availableOptions: {
      courses: Object.keys(distinctCourses).sort(),
      semesters: Object.keys(distinctSemesters).sort(),
      sections: Object.keys(distinctSections).sort()
    },
    summary: {
      presentCount: presentCount,
      eligibleStudentsCount: activeCohortSize,
      recordedDaysInPeriod: activeDaysCount,
      denominatorStudentDays: denominatorTotal,
      attendancePercentage: attendancePercentage,
      denominatorExplanation:
        activeCohortSize + ' eligible student(s) in filter Ã— ' +
        activeDaysCount + ' active attendance day(s) in selected range = ' +
        denominatorTotal + ' student-days'
    },
    records: filteredRecords
  };
}

/**
 * Public admin wrapper for filtering attendance reports and generating CSV export content.
 */
function filterAdminAttendanceReport(sessionToken, filters) {
  requireAdminSession(sessionToken);
  var report = queryAdminAttendanceReportInternal(filters || {});
  return {
    ok: true,
    report: report
  };
}

/**
 * Returns all students in the roster for the Admin Management table.
 */
function getAllStudentsForAdminInternal() {
  var sheet = getSheetByNameSafe(SHEET_NAMES.STUDENTS);
  var values = sheet.getDataRange().getValues();
  var list = [];
  for (var r = 1; r < values.length; r++) {
    var st = mapRowToStudentObject(values[r], r + 1);
    list.push({
      studentId: st.studentId,
      rollNumber: st.rollNumber,
      fullName: st.fullName,
      course: st.course,
      semester: st.semester,
      section: st.section,
      verifiedEmail: st.verifiedEmail,
      emailVerified: st.emailVerified,
      accountStatus: st.accountStatus,
      role: st.role,
      updatedAt: st.updatedAt
    });
  }
  return list;
}

/**
 * Adds a new student or updates an existing student's roster record (Admin only).
 */
function adminSaveStudentRosterRecord(sessionToken, payload) {
  var admin = requireAdminSession(sessionToken);
  if (!payload) {
    return { ok: false, message: 'Missing student payload.' };
  }

  var rollNumber = normalizeRollNumber(payload.rollNumber);
  var fullName = preventSpreadsheetFormulaInjection(String(payload.fullName || '').trim());
  var course = preventSpreadsheetFormulaInjection(String(payload.course || '').trim());
  var semester = preventSpreadsheetFormulaInjection(String(payload.semester || '').trim());
  var section = preventSpreadsheetFormulaInjection(String(payload.section || '').trim());
  var verifiedEmail = String(payload.verifiedEmail || '').trim().toLowerCase();
  var accountStatus = String(payload.accountStatus || 'PENDING').trim().toUpperCase();
  var role = String(payload.role || 'STUDENT').trim().toUpperCase() === 'ADMIN' ? 'ADMIN' : 'STUDENT';

  if (!rollNumber || !fullName || !verifiedEmail || verifiedEmail.indexOf('@') === -1) {
    return { ok: false, message: 'Roll Number, Full Name, and a valid Pre-Verified Email are required.' };
  }

  if (['PENDING', 'ACTIVE', 'DISABLED'].indexOf(accountStatus) === -1) {
    accountStatus = 'PENDING';
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheetByNameSafe(SHEET_NAMES.STUDENTS);
    var existing = findStudentByRollNumber(rollNumber);
    var now = formatServerTimestamp(new Date());

    if (existing) {
      sheet.getRange(existing.rowIndex, 3, 1, 5).setValues([[
        fullName,
        course,
        semester,
        section,
        verifiedEmail
      ]]);
      sheet.getRange(existing.rowIndex, 9, 1, 2).setValues([[
        accountStatus,
        role
      ]]);
      sheet.getRange(existing.rowIndex, 12).setValue(now);

      if (accountStatus === 'DISABLED') {
        revokeAllSessionsForStudent(existing.studentId);
      }

      writeAuditLog('ADMIN_ROSTER_UPDATE', admin.studentId, 'SUCCESS', 'UPDATED_ROLL:' + rollNumber + ',STATUS:' + accountStatus);
      return {
        ok: true,
        message: 'Roster record for ' + rollNumber + ' updated.',
        students: getAllStudentsForAdminInternal()
      };
    } else {
      var newId = (role === 'ADMIN' ? 'ADM-' : 'STU-') + Utilities.getUuid().substring(0, 8).toUpperCase();
      sheet.appendRow([
        newId,
        rollNumber,
        fullName,
        course,
        semester,
        section,
        verifiedEmail,
        false,
        accountStatus,
        role,
        now,
        now
      ]);

    writeAuditLog('ADMIN_ROSTER_CREATE', admin.studentId, 'SUCCESS', 'CREATED_ROLL:' + rollNumber);
      return {
        ok: true,
        message: 'Added ' + fullName + ' (' + rollNumber + ') to authorized roster.',
        students: getAllStudentsForAdminInternal()
      };
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Quick 1-click Admin action to Approve (`ACTIVE`) or Disable/Reject (`DISABLED`) a student account.
 */
function adminSetStudentAccountStatus(sessionToken, rollNumber, newStatus) {
  var admin = requireAdminSession(sessionToken);
  var normRoll = normalizeRollNumber(rollNumber);
  var statusUpper = String(newStatus || '').trim().toUpperCase();

  if (['ACTIVE', 'DISABLED', 'PENDING'].indexOf(statusUpper) === -1) {
    return { ok: false, message: 'Invalid target account status.' };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var student = findStudentByRollNumber(normRoll);
    if (!student) {
      return { ok: false, message: 'Student roll number not found.' };
    }

    var sheet = getSheetByNameSafe(SHEET_NAMES.STUDENTS);
    var now = formatServerTimestamp(new Date());
    sheet.getRange(student.rowIndex, 9).setValue(statusUpper);
    sheet.getRange(student.rowIndex, 12).setValue(now);

    if (statusUpper === 'DISABLED') {
      revokeAllSessionsForStudent(student.studentId);
    }

    writeAuditLog('ADMIN_STATUS_CHANGE', admin.studentId, 'SUCCESS', 'ROLL:' + normRoll + '->' + statusUpper);
    return {
      ok: true,
      message: 'Roll Number ' + normRoll + ' (' + student.fullName + ') is now ' + statusUpper + '.',
      students: getAllStudentsForAdminInternal()
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Updates geofence and attendance settings in the `Settings` sheet (Admin only).
 */
function adminUpdateGeofenceSettings(sessionToken, newSettings) {
  var admin = requireAdminSession(sessionToken);
  if (!newSettings) {
    return { ok: false, message: 'No settings provided.' };
  }

  var lat = parseFloat(newSettings.centreLatitude);
  var lng = parseFloat(newSettings.centreLongitude);
  var radius = parseFloat(newSettings.allowedRadiusMeters);
  var maxAcc = parseFloat(newSettings.maxLocationAccuracyMeters);

  if (isNaN(lat) || lat < -90 || lat > 90) {
    return { ok: false, message: 'Latitude must be a valid decimal number between -90 and 90.' };
  }
  if (isNaN(lng) || lng < -180 || lng > 180) {
    return { ok: false, message: 'Longitude must be a valid decimal number between -180 and 180.' };
  }
  if (isNaN(radius) || radius < 10 || radius > 5000) {
    return { ok: false, message: 'Allowed radius must be between 10 and 5000 metres.' };
  }
  if (isNaN(maxAcc) || maxAcc < 5 || maxAcc > 500) {
    return { ok: false, message: 'Maximum location accuracy threshold must be between 5 and 500 metres.' };
  }

  var updates = {
    college_name: preventSpreadsheetFormulaInjection(String(newSettings.collegeName || DEFAULT_SETTINGS.college_name).trim()),
    centre_latitude: String(lat),
    centre_longitude: String(lng),
    allowed_radius_meters: String(radius),
    max_location_accuracy_meters: String(maxAcc),
    attendance_start_time: String(newSettings.attendanceStartTime || '08:30').trim(),
    attendance_end_time: String(newSettings.attendanceEndTime || '17:30').trim(),
    enforce_attendance_window: String(Boolean(newSettings.enforceAttendanceWindow)),
    location_boundary_policy: String(newSettings.locationBoundaryPolicy || 'CONSERVATIVE').toUpperCase() === 'CENTRE_ONLY'
      ? 'CENTRE_ONLY'
      : 'CONSERVATIVE'
  };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheetByNameSafe(SHEET_NAMES.SETTINGS);
    var values = sheet.getDataRange().getValues();
    var now = formatServerTimestamp(new Date());

    var updatedKeys = {};
    for (var r = 1; r < values.length; r++) {
      var k = String(values[r][0] || '').trim();
      if (updates.hasOwnProperty(k)) {
        sheet.getRange(r + 1, 2).setValue(updates[k]);
        sheet.getRange(r + 1, 4).setValue(now);
        updatedKeys[k] = true;
      }
    }

    var allUpdateKeys = Object.keys(updates);
    for (var i = 0; i < allUpdateKeys.length; i++) {
      var key = allUpdateKeys[i];
      if (!updatedKeys[key]) {
        sheet.appendRow([key, updates[key], '', now]);
      }
    }

    writeAuditLog(
      'ADMIN_SETTINGS_UPDATE',
      admin.studentId,
      'SUCCESS',
      'LAT:' + lat + ',LNG:' + lng + ',RAD:' + radius + ',ACC:' + maxAcc
    );

    return {
      ok: true,
      message: 'Geofence and attendance settings saved.',
      settings: getValidatedSettings()
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Reads the most recent security/audit events for the Admin Audit tab.
 */
function getRecentAuditLogsInternal(limit) {
  var maxRows = limit || 50;
  var sheet = getSheetByNameSafe(SHEET_NAMES.AUDIT_LOGS);
  var values = sheet.getDataRange().getValues();
  var logs = [];

  for (var r = values.length - 1; r >= 1; r--) {
    var row = values[r];
    logs.push({
      eventId: String(row[0] || ''),
      serverTimestamp: String(row[1] || ''),
      eventType: String(row[2] || ''),
      studentId: String(row[3] || ''),
      outcome: String(row[4] || ''),
      reasonCode: String(row[5] || ''),
      requestId: String(row[6] || '')
    });
    if (logs.length >= maxRows) break;
  }
  return logs;
}



// ============================================================================
// MODULE: Code.gs
// ============================================================================
/**
 * GeoAttend â€” Main Apps Script Entry Points & Client-Callable RPC API
 * Institution: ITM GIDA, Gorakhpur, Uttar Pradesh, India
 *
 * All client-callable endpoints (`api*`) wrap server responses in a consistent JSON-safe
 * envelope `{ ok: boolean, code?: string, message?: string, ... }` and never leak stack traces
 * or internal credentials.
 */

/**
 * Serves the GeoAttend web application over HTTPS.
 */
function doGet(e) {
  var template = HtmlService.createTemplateFromFile('Index');
  return template.evaluate()
    .setTitle('GeoAttend â€” ITM GIDA Campus Attendance Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Handles JSON HTTP POST requests from standalone GeoAttend.html / GeoAttend.js
 * (`fetch()` API), completely bypassing Google's `/u/1/` multi-account HtmlService bug
 * on mobile phones and external browsers!
 */
function doPost(e) {
  var responseObj = { ok: false, message: 'Invalid request.' };
  try {
    var bodyStr = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    var payload = JSON.parse(bodyStr);
    var action = String(payload.action || '').trim();
    var args = Array.isArray(payload.args) ? payload.args : [];

    var allowedRpcMethods = {
      apiBootstrapApp: apiBootstrapApp,
      apiLogin: apiLogin,
      apiLogout: apiLogout,
      apiRequestOtp: apiRequestOtp,
      apiVerifyOtpAndResetPassword: apiVerifyOtpAndResetPassword,
      apiCheckLocationEligibility: apiCheckLocationEligibility,
      apiMarkAttendance: apiMarkAttendance,
      apiLoadAdminDashboard: apiLoadAdminDashboard,
      apiFilterAdminReport: apiFilterAdminReport,
      apiAdminSaveStudent: apiAdminSaveStudent,
      apiAdminUpdateSettings: apiAdminUpdateSettings,
      apiRegisterStudent: apiRegisterStudent,
      apiAdminSetStudentStatus: apiAdminSetStudentStatus
    };

    if (!allowedRpcMethods.hasOwnProperty(action)) {
      responseObj = { ok: false, code: 'UNKNOWN_ACTION', message: 'Unsupported API action: ' + action };
    } else {
      responseObj = allowedRpcMethods[action].apply(null, args);
    }
  } catch (err) {
    responseObj = {
      ok: false,
      code: 'SERVER_POST_ERROR',
      message: err.message || 'Server error processing request.'
    };
  }

  return ContentService.createTextOutput(JSON.stringify(responseObj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Includes HTML partials (`Styles.html`, `Client.html`) into `Index.html`.
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Public bootstrap endpoint called on page load.
 * If an existing `sessionToken` is provided and still valid, restores the user's session.
 */
function apiBootstrapApp(sessionToken) {
  try {
    var settings = getPublicClientSettings();
    if (sessionToken) {
      var user = authenticateSessionToken(sessionToken);
      if (user) {
        return {
          ok: true,
          authenticated: true,
          settings: settings,
          profile: toSafeStudentProfile(user),
          todayAttendance: getStudentTodayAttendanceStatus(user.studentId),
          attendanceHistory: getStudentAttendanceHistory(user.studentId, 20)
        };
      }
    }
    return {
      ok: true,
      authenticated: false,
      settings: settings
    };
  } catch (err) {
    return {
      ok: false,
      authenticated: false,
      settings: {
        collegeName: DEFAULT_SETTINGS.college_name,
        centreLatitude: 26.742681,
        centreLongitude: 83.273421,
        allowedRadiusMeters: 200,
        maxLocationAccuracyMeters: 50,
        timezone: 'Asia/Kolkata',
        attendanceStartTime: '08:30',
        attendanceEndTime: '17:30',
        enforceAttendanceWindow: false,
        locationBoundaryPolicy: 'CONSERVATIVE'
      },
      message: err.message || 'Server initialization error.'
    };
  }
}

/**
 * RPC: Student / Admin login with Roll Number and Password.
 */
function apiLogin(rollNumber, password) {
  try {
    return loginWithRollAndPassword(rollNumber, password);
  } catch (err) {
    Logger.log('apiLogin error: ' + err.message);
    return {
      ok: false,
      code: 'SERVER_ERROR',
      message: err.message || 'Unable to process sign-in request.'
    };
  }
}

/**
 * RPC: Logout active session token.
 */
function apiLogout(sessionToken) {
  try {
    return logoutSessionToken(sessionToken);
  } catch (err) {
    return { ok: true };
  }
}

/**
 * RPC: Request 6-digit OTP to pre-verified roster email for Password Reset or First-Time Activation.
 */
function apiRequestOtp(rollNumber, purpose) {
  try {
    return requestRollNumberOtp(rollNumber, purpose);
  } catch (err) {
    Logger.log('apiRequestOtp error: ' + err.message);
    return {
      ok: false,
      code: 'SERVER_ERROR',
      message: err.message || 'Unable to send OTP verification email.'
    };
  }
}

/**
 * RPC: Verify 6-digit OTP and set new password.
 */
function apiVerifyOtpAndResetPassword(rollNumber, otpCode, newPassword, purpose) {
  try {
    return verifyOtpAndSetPassword(rollNumber, otpCode, newPassword, purpose);
  } catch (err) {
    Logger.log('apiVerifyOtpAndResetPassword error: ' + err.message);
    return {
      ok: false,
      code: 'SERVER_ERROR',
      message: err.message || 'Unable to verify OTP and update password.'
    };
  }
}

/**
 * RPC: Pre-check geofence eligibility on the server without recording attendance.
 */
function apiCheckLocationEligibility(sessionToken, lat, lng, accuracy) {
  try {
    var user = authenticateSessionToken(sessionToken);
    if (!user) {
      return { ok: false, code: 'UNAUTHORIZED', message: 'Session expired. Please sign in again.' };
    }
    var geo = evaluateServerGeofence(lat, lng, accuracy);
    return {
      ok: true,
      geofence: geo
    };
  } catch (err) {
    return {
      ok: false,
      code: 'SERVER_ERROR',
      message: err.message || 'Location verification error.'
    };
  }
}

/**
 * RPC: Authoritative attendance submission.
 */
function apiMarkAttendance(sessionToken, lat, lng, accuracy) {
  try {
    return submitStudentAttendance(sessionToken, lat, lng, accuracy);
  } catch (err) {
    Logger.log('apiMarkAttendance error: ' + err.message);
    return {
      ok: false,
      code: 'SERVER_ERROR',
      message: err.message || 'Failed to record attendance.'
    };
  }
}

/**
 * RPC: Load Admin Dashboard data bundle (Admin role verified on server).
 */
function apiLoadAdminDashboard(sessionToken, filters) {
  try {
    return getAdminDashboardBundle(sessionToken, filters);
  } catch (err) {
    return {
      ok: false,
      code: 'ADMIN_ERROR',
      message: err.message || 'Access denied or failed to load Admin Dashboard.'
    };
  }
}

/**
 * RPC: Filter Admin attendance report.
 */
function apiFilterAdminReport(sessionToken, filters) {
  try {
    return filterAdminAttendanceReport(sessionToken, filters);
  } catch (err) {
    return {
      ok: false,
      code: 'ADMIN_ERROR',
      message: err.message || 'Failed to filter attendance report.'
    };
  }
}

/**
 * RPC: Add or update an authorized student record in the roster (Admin only).
 */
function apiAdminSaveStudent(sessionToken, studentPayload) {
  try {
    return adminSaveStudentRosterRecord(sessionToken, studentPayload);
  } catch (err) {
    return {
      ok: false,
      code: 'ADMIN_ERROR',
      message: err.message || 'Failed to save student roster record.'
    };
  }
}

/**
 * RPC: Self-registration by student (creates account in PENDING status awaiting Admin approval).
 */
function apiRegisterStudent(registrationPayload) {
  try {
    return selfRegisterStudentPendingApproval(registrationPayload);
  } catch (err) {
    Logger.log('apiRegisterStudent error: ' + err.message);
    return {
      ok: false,
      code: 'SERVER_ERROR',
      message: err.message || 'Failed to submit student registration.'
    };
  }
}

/**
 * RPC: 1-Click Admin Approve / Disable student status.
 */
function apiAdminSetStudentStatus(sessionToken, rollNumber, newStatus) {
  try {
    return adminSetStudentAccountStatus(sessionToken, rollNumber, newStatus);
  } catch (err) {
    return {
      ok: false,
      code: 'ADMIN_ERROR',
      message: err.message || 'Failed to update student status.'
    };
  }
}

/**
 * RPC: Update geofence and attendance configuration (Admin only).
 */
function apiAdminUpdateSettings(sessionToken, settingsPayload) {
  try {
    return adminUpdateGeofenceSettings(sessionToken, settingsPayload);
  } catch (err) {
    return {
      ok: false,
      code: 'ADMIN_ERROR',
      message: err.message || 'Failed to update settings.'
    };
  }
}




