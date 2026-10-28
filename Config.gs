/**
 * GeoAttend — Configuration, Setup, and Database Access Module
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

