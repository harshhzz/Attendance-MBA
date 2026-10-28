/**
 * GeoAttend — Security & Audit Logging Module
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

