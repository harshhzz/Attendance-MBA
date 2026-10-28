/**
 * GeoAttend — Gmail OTP Password Recovery & First-Time Account Activation (Option A)
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

    // Send OTP Email first — never report success if MailApp throws an error
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
    'GeoAttend — ' + settings.collegeName + '\n' +
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

