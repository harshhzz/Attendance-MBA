  /**
  * GeoAttend — Student Roster Lookup & Profile Management
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

