/**
 * GeoAttend — Protected Admin Operations, Roster Provisioning, Settings, and Attendance Reports
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
        activeCohortSize + ' eligible student(s) in filter × ' +
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

