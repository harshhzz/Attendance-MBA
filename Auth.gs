/**
 * GeoAttend — Authentication, Password Hashing, and Session Validation Module
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

