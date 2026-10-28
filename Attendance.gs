/**
 * GeoAttend — Attendance Recording, Duplicate Prevention, and Student History Module
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

