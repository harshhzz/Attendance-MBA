/**
 * GeoAttend â€” Frontend Controller & Client-Side Geofence / RPC Module
 *
 * Works seamlessly in two environments:
 * 1. Production Google Apps Script Web App (`google.script.run` RPC bridge)
 * 2. Local Preview / Acceptance Sandbox (when opened directly as `GeoAttend.html` outside Apps Script)
 */
(function () {
  'use strict';

  var STORAGE_SESSION_KEY = 'geoattend_session_token_v1';
  var EARTH_RADIUS_METERS = 6371000;
  // Live Google Apps Script Web App API Endpoint (`doPost`)
  var APPS_SCRIPT_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycby-mE6v0rvegKq0CNrscfVJR-JW-_A31furszUL5jWKXHM58RGurr0O_3yYhU4QAJRv/exec';

  var appState = {
    isAppsScriptRuntime: typeof window.google !== 'undefined' && window.google && window.google.script && window.google.script.run,
    useRemoteFetchApi: true, // Connects standalone GeoAttend.html directly to the live Google Sheet via fetch()
    sessionToken: localStorage.getItem(STORAGE_SESSION_KEY) || '',
    profile: null,
    settings: {
      collegeName: 'ITM GIDA, Gorakhpur',
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
    todayAttendance: {
      markedToday: false,
      attendanceDate: '',
      record: null
    },
    attendanceHistory: [],
    lastGeoFix: null, // { lat, lng, accuracy, timestampMs, eligible, distanceMeters, status, message }
    recoveryPurpose: 'PASSWORD_RESET',
    otpExpiryTimerId: null,
    otpCooldownTimerId: null,
    adminLastReport: null,
    simulatedGpsMode: 'real' // Used only in Local Preview Sandbox
  };

  // =========================================================================
  // LOCAL SANDBOX MOCK BACKEND (Only used when running outside Apps Script)
  // =========================================================================
  var LocalSandboxServer = (function () {
    var sandboxSettings = JSON.parse(JSON.stringify(appState.settings));
    var sandboxStudents = [
      {
        studentId: 'STU-TEST-001',
        rollNumber: '2026CSE001',
        fullName: 'Aarav Sharma (SAMPLE TEST)',
        course: 'B.Tech CSE',
        semester: '6',
        section: 'A',
        verifiedEmail: 'aarav.sample.test@itmgida.edu.in',
        emailVerified: false,
        accountStatus: 'PENDING',
        role: 'STUDENT',
        passwordPlainForDemoOnly: null,
        failedCount: 0,
        lockedUntilMs: 0,
        updatedAt: formatIstTimestamp(new Date())
      },
      {
        studentId: 'STU-TEST-002',
        rollNumber: '2026CSE002',
        fullName: 'Priya Verma (SAMPLE TEST)',
        course: 'B.Tech CSE',
        semester: '6',
        section: 'A',
        verifiedEmail: 'priya.sample.test@itmgida.edu.in',
        emailVerified: true,
        accountStatus: 'ACTIVE',
        role: 'STUDENT',
        passwordPlainForDemoOnly: 'Student@123',
        failedCount: 0,
        lockedUntilMs: 0,
        updatedAt: formatIstTimestamp(new Date())
      },
      {
        studentId: 'ADM-001',
        rollNumber: 'ADMIN001',
        fullName: 'ITM System Administrator',
        course: 'ADMINISTRATION',
        semester: 'N/A',
        section: 'ALL',
        verifiedEmail: 'harshhzz505@gmail.com',
        emailVerified: true,
        accountStatus: 'ACTIVE',
        role: 'ADMIN',
        passwordPlainForDemoOnly: 'Admin@12345',
        failedCount: 0,
        lockedUntilMs: 0,
        updatedAt: formatIstTimestamp(new Date())
      }
    ];

    var sandboxSessions = {};
    var sandboxAttendance = [
      {
        attendanceId: 'ATT-SAMPLE01',
        attendanceDate: '2026-10-27',
        serverTimestamp: '2026-10-27 09:14:22',
        studentId: 'STU-TEST-002',
        rollNumber: '2026CSE002',
        status: 'PRESENT',
        distanceMeters: 38.4,
        reportedAccuracyMeters: 14.2,
        validationResult: 'ELIGIBLE_INSIDE_GEOFENCE'
      }
    ];
    var sandboxOtps = {};
    var sandboxAudits = [
      {
        eventId: 'EVT-INIT0001',
        serverTimestamp: formatIstTimestamp(new Date()),
        eventType: 'SANDBOX_BOOT',
        studentId: 'SYSTEM',
        outcome: 'SUCCESS',
        reasonCode: 'LOCAL_PREVIEW_READY',
        requestId: ''
      }
    ];

    function logAudit(type, studentId, outcome, reason) {
      sandboxAudits.unshift({
        eventId: 'EVT-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
        serverTimestamp: formatIstTimestamp(new Date()),
        eventType: type,
        studentId: studentId || 'ANONYMOUS',
        outcome: outcome,
        reasonCode: reason,
        requestId: ''
      });
    }

    function findByRoll(roll) {
      var norm = String(roll || '').trim().toUpperCase().replace(/\s+/g, '');
      for (var i = 0; i < sandboxStudents.length; i++) {
        if (sandboxStudents[i].rollNumber === norm) return sandboxStudents[i];
      }
      return null;
    }

    function findById(id) {
      for (var i = 0; i < sandboxStudents.length; i++) {
        if (sandboxStudents[i].studentId === id) return sandboxStudents[i];
      }
      return null;
    }

    function toProfile(st) {
      var at = st.verifiedEmail.indexOf('@');
      var masked = st.verifiedEmail.substring(0, 2) + '***@' + st.verifiedEmail.substring(at + 1);
      return {
        studentId: st.studentId,
        rollNumber: st.rollNumber,
        fullName: st.fullName,
        course: st.course,
        semester: st.semester,
        section: st.section,
        maskedEmail: masked,
        accountStatus: st.accountStatus,
        role: st.role
      };
    }

    function getTodayStatus(stId) {
      var today = formatIstDate(new Date());
      for (var i = 0; i < sandboxAttendance.length; i++) {
        var r = sandboxAttendance[i];
        if (r.studentId === stId && r.attendanceDate === today && r.status === 'PRESENT') {
          return { markedToday: true, attendanceDate: today, record: r };
        }
      }
      return { markedToday: false, attendanceDate: today, record: null };
    }

    function getHistory(stId) {
      return sandboxAttendance.filter(function (r) { return r.studentId === stId; });
    }

    return {
      apiBootstrapApp: function (token) {
        if (token && sandboxSessions[token]) {
          var st = findById(sandboxSessions[token]);
          if (st && st.accountStatus === 'ACTIVE') {
            return {
              ok: true,
              authenticated: true,
              settings: sandboxSettings,
              profile: toProfile(st),
              todayAttendance: getTodayStatus(st.studentId),
              attendanceHistory: getHistory(st.studentId)
            };
          }
        }
        return { ok: true, authenticated: false, settings: sandboxSettings };
      },

      apiLogin: function (roll, pass) {
        var genericMsg = 'Invalid roll number or password, or account requires first-time activation.';
        var st = findByRoll(roll);
        if (!st) {
          logAudit('LOGIN_FAILED', null, 'REJECTED', 'UNKNOWN_ROLL');
          return { ok: false, message: genericMsg };
        }
        if (st.accountStatus === 'DISABLED') {
          logAudit('LOGIN_FAILED', st.studentId, 'REJECTED', 'ACCOUNT_DISABLED');
          return { ok: false, message: 'This account has been disabled. Contact the ITM Administration cell.' };
        }
        if (st.lockedUntilMs && Date.now() < st.lockedUntilMs) {
          var rem = Math.ceil((st.lockedUntilMs - Date.now()) / 60000);
          return { ok: false, message: 'Too many failed attempts. Account locked for ' + rem + ' minute(s).' };
        }
        if (!st.passwordPlainForDemoOnly || st.passwordPlainForDemoOnly !== pass) {
          st.failedCount = (st.failedCount || 0) + 1;
          if (st.failedCount >= 5) {
            st.lockedUntilMs = Date.now() + 15 * 60000;
            logAudit('LOGIN_LOCKED', st.studentId, 'LOCKED', '5_FAILED_ATTEMPTS');
            return { ok: false, message: 'Account locked for 15 minutes due to 5 failed login attempts.' };
          }
          logAudit('LOGIN_FAILED', st.studentId, 'REJECTED', 'BAD_PASSWORD_' + st.failedCount);
          return { ok: false, message: genericMsg };
        }
        if (st.accountStatus !== 'ACTIVE') {
          return { ok: false, message: genericMsg };
        }
        st.failedCount = 0;
        st.lockedUntilMs = 0;
        var tok = 'SANDBOX-SESS-' + Math.random().toString(36).substring(2) + '-' + Date.now();
        sandboxSessions[tok] = st.studentId;
        logAudit('LOGIN_SUCCESS', st.studentId, 'SUCCESS', 'ROLE:' + st.role);
        return {
          ok: true,
          sessionToken: tok,
          profile: toProfile(st),
          settings: sandboxSettings,
          todayAttendance: getTodayStatus(st.studentId),
          attendanceHistory: getHistory(st.studentId)
        };
      },

      apiLogout: function (token) {
        if (token && sandboxSessions[token]) {
          logAudit('LOGOUT', sandboxSessions[token], 'SUCCESS', 'USER_LOGOUT');
          delete sandboxSessions[token];
        }
        return { ok: true };
      },

      apiRequestOtp: function (roll, purpose) {
        var norm = String(roll || '').trim().toUpperCase();
        if (!norm) return { ok: false, message: 'Please enter your College Roll Number.' };
        var st = findByRoll(norm);
        var now = Date.now();
        if (st && st.accountStatus !== 'DISABLED') {
          var existing = sandboxOtps[st.studentId];
          if (existing && (now - existing.sentAtMs) < 60000) {
            var waitSec = Math.ceil((60000 - (now - existing.sentAtMs)) / 1000);
            return { ok: false, cooldownSeconds: waitSec, message: 'Please wait ' + waitSec + ' seconds before requesting another OTP.' };
          }
          var demoOtp = '482910';
          sandboxOtps[st.studentId] = {
            code: demoOtp,
            purpose: purpose,
            sentAtMs: now,
            expiresAtMs: now + 5 * 60000,
            attempts: 0
          };
          logAudit('OTP_SENT', st.studentId, 'SUCCESS', purpose);
          return {
            ok: true,
            expirySeconds: 300,
            cooldownSeconds: 60,
            message: '[Local Sandbox Preview] In live deployment, MailApp sends the OTP to ' + toProfile(st).maskedEmail + '. For local sandbox testing, use simulated OTP code: 482910'
          };
        }
        logAudit('OTP_REQUEST', null, 'REJECTED', 'GENERIC_RESPONSE');
        return {
          ok: true,
          expirySeconds: 300,
          cooldownSeconds: 60,
          message: 'If this roll number is registered in the authorized ITM GIDA roster, a 6-digit verification code has been sent to its pre-registered email address.'
        };
      },

      apiVerifyOtpAndResetPassword: function (roll, otp, newPass, purpose) {
        var st = findByRoll(roll);
        if (!st || st.accountStatus === 'DISABLED') {
          return { ok: false, message: 'Invalid or expired OTP verification code.' };
        }
        if (!newPass || newPass.length < 8) {
          return { ok: false, message: 'New password must be at least 8 characters long.' };
        }
        var rec = sandboxOtps[st.studentId];
        if (!rec) {
          return { ok: false, message: 'No active OTP found. Please request a new code.' };
        }
        if (Date.now() > rec.expiresAtMs) {
          delete sandboxOtps[st.studentId];
          return { ok: false, message: 'This OTP has expired (5-minute limit). Please request a new code.' };
        }
        if (rec.attempts >= 5) {
          delete sandboxOtps[st.studentId];
          return { ok: false, message: 'Too many incorrect OTP attempts. Code invalidated.' };
        }
        if (String(otp).trim() !== rec.code) {
          rec.attempts++;
          var rem = 5 - rec.attempts;
          logAudit('OTP_VERIFY_FAILED', st.studentId, 'REJECTED', 'ATTEMPT_' + rec.attempts);
          return { ok: false, message: rem > 0 ? 'Incorrect OTP code (' + rem + ' attempt(s) remaining).' : 'Too many incorrect attempts. Code invalidated.' };
        }
        delete sandboxOtps[st.studentId];
        st.passwordPlainForDemoOnly = newPass;
        st.emailVerified = true;
        if (st.accountStatus === 'PENDING') st.accountStatus = 'ACTIVE';
        st.failedCount = 0;
        st.lockedUntilMs = 0;
        logAudit('PASSWORD_UPDATED_VIA_OTP', st.studentId, 'SUCCESS', purpose);
        return { ok: true, message: 'Your password has been updated and your account is active. You may now sign in.' };
      },

      apiCheckLocationEligibility: function (token, lat, lng, acc) {
        var stId = sandboxSessions[token];
        if (!stId) return { ok: false, message: 'Session expired. Please sign in again.' };
        var geo = evaluateClientOrSandboxGeofence(lat, lng, acc, sandboxSettings);
        return { ok: true, geofence: geo };
      },

      apiMarkAttendance: function (token, lat, lng, acc) {
        var stId = sandboxSessions[token];
        var st = findById(stId);
        if (!st || st.accountStatus !== 'ACTIVE') {
          return { ok: false, message: 'Unauthorized or inactive account.' };
        }
        var geo = evaluateClientOrSandboxGeofence(lat, lng, acc, sandboxSettings);
        if (!geo.eligible) {
          logAudit('ATTENDANCE_REJECTED', st.studentId, 'REJECTED', geo.status);
          return { ok: false, code: geo.status, geofence: geo, message: geo.message };
        }
        var today = formatIstDate(new Date());
        var existing = getTodayStatus(st.studentId);
        if (existing.markedToday) {
          logAudit('ATTENDANCE_DUPLICATE_BLOCKED', st.studentId, 'REJECTED', 'ALREADY_MARKED_' + today);
          return {
            ok: false,
            code: 'ALREADY_MARKED',
            todayAttendance: existing,
            message: 'Attendance has already been marked for today (' + today + ').'
          };
        }
        var nowStr = formatIstTimestamp(new Date());
        var rec = {
          attendanceId: 'ATT-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
          attendanceDate: today,
          serverTimestamp: nowStr,
          studentId: st.studentId,
          rollNumber: st.rollNumber,
          status: 'PRESENT',
          distanceMeters: geo.distanceMeters,
          reportedAccuracyMeters: geo.accuracyMeters,
          validationResult: geo.status
        };
        sandboxAttendance.unshift(rec);
        logAudit('ATTENDANCE_MARKED', st.studentId, 'SUCCESS', 'DIST:' + geo.distanceMeters + 'm');
        return {
          ok: true,
          code: 'MARKED_PRESENT',
          message: 'Attendance marked PRESENT for ' + today + ' at ' + nowStr + ' IST.',
          geofence: geo,
          todayAttendance: { markedToday: true, attendanceDate: today, record: rec },
          attendanceHistory: getHistory(st.studentId)
        };
      },

      apiLoadAdminDashboard: function (token, filters) {
        var st = findById(sandboxSessions[token]);
        if (!st || st.role !== 'ADMIN') return { ok: false, message: 'Forbidden: Administrator role required.' };
        return {
          ok: true,
          adminProfile: toProfile(st),
          settings: sandboxSettings,
          report: this.apiFilterAdminReport(token, filters).report,
          students: sandboxStudents,
          auditLogs: sandboxAudits
        };
      },

      apiFilterAdminReport: function (token, filters) {
        var st = findById(sandboxSessions[token]);
        if (!st || st.role !== 'ADMIN') return { ok: false, message: 'Forbidden.' };
        var f = filters || {};
        var today = formatIstDate(new Date());
        var start = f.startDate || '2026-10-01';
        var end = f.endDate || today;
        var q = String(f.search || '').trim().toUpperCase();
        var course = String(f.course || '').trim().toUpperCase();
        var sem = String(f.semester || '').trim().toUpperCase();
        var sec = String(f.section || '').trim().toUpperCase();

        var eligibleStudents = sandboxStudents.filter(function (s) {
          if (s.role === 'ADMIN' || s.accountStatus === 'DISABLED') return false;
          if (course && s.course.toUpperCase() !== course) return false;
          if (sem && s.semester.toUpperCase() !== sem) return false;
          if (sec && s.section.toUpperCase() !== sec) return false;
          if (q && s.rollNumber.indexOf(q) === -1 && s.fullName.toUpperCase().indexOf(q) === -1) return false;
          return true;
        });

        var daysSet = {};
        var recs = [];
        sandboxAttendance.forEach(function (r) {
          if (r.attendanceDate < start || r.attendanceDate > end) return;
          daysSet[r.attendanceDate] = true;
          var stu = findById(r.studentId);
          if (!stu) return;
          if (course && stu.course.toUpperCase() !== course) return;
          if (sem && stu.semester.toUpperCase() !== sem) return;
          if (sec && stu.section.toUpperCase() !== sec) return;
          if (q && stu.rollNumber.indexOf(q) === -1 && stu.fullName.toUpperCase().indexOf(q) === -1) return;
          recs.push({
            attendanceId: r.attendanceId,
            attendanceDate: r.attendanceDate,
            serverTimestamp: r.serverTimestamp,
            studentId: stu.studentId,
            rollNumber: stu.rollNumber,
            fullName: stu.fullName,
            course: stu.course,
            semester: stu.semester,
            section: stu.section,
            status: r.status,
            distanceMeters: r.distanceMeters,
            reportedAccuracyMeters: r.reportedAccuracyMeters
          });
        });

        var daysCount = Math.max(1, Object.keys(daysSet).length);
        var denom = eligibleStudents.length * daysCount;
        var pct = denom > 0 ? Math.round((recs.length / denom) * 1000) / 10 : 0;

        return {
          ok: true,
          report: {
            filters: { startDate: start, endDate: end, search: q, course: course, semester: sem, section: sec },
            summary: {
              presentCount: recs.length,
              eligibleStudentsCount: eligibleStudents.length,
              recordedDaysInPeriod: daysCount,
              denominatorStudentDays: denom,
              attendancePercentage: pct,
              denominatorExplanation: eligibleStudents.length + ' eligible student(s) Ã— ' + daysCount + ' active day(s) = ' + denom + ' student-days'
            },
            records: recs
          }
        };
      },

      apiAdminSaveStudent: function (token, payload) {
        var admin = findById(sandboxSessions[token]);
        if (!admin || admin.role !== 'ADMIN') return { ok: false, message: 'Forbidden.' };
        var roll = String(payload.rollNumber || '').trim().toUpperCase();
        var name = String(payload.fullName || '').trim();
        var email = String(payload.verifiedEmail || '').trim().toLowerCase();
        if (!roll || !name || email.indexOf('@') === -1) {
          return { ok: false, message: 'Roll Number, Full Name, and valid Pre-Verified Email are required.' };
        }
        var existing = findByRoll(roll);
        if (existing) {
          existing.fullName = name;
          existing.course = payload.course || existing.course;
          existing.semester = payload.semester || existing.semester;
          existing.section = payload.section || existing.section;
          existing.verifiedEmail = email;
          existing.accountStatus = payload.accountStatus || existing.accountStatus;
          existing.role = payload.role || existing.role;
          existing.updatedAt = formatIstTimestamp(new Date());
          logAudit('ADMIN_ROSTER_UPDATE', admin.studentId, 'SUCCESS', 'UPDATED:' + roll);
          return { ok: true, message: 'Updated roster record for ' + roll + '.', students: sandboxStudents };
        } else {
          sandboxStudents.push({
            studentId: 'STU-' + Math.random().toString(36).substring(2, 7).toUpperCase(),
            rollNumber: roll,
            fullName: name,
            course: payload.course || 'B.Tech CSE',
            semester: payload.semester || '6',
            section: payload.section || 'A',
            verifiedEmail: email,
            emailVerified: false,
            accountStatus: payload.accountStatus || 'PENDING',
            role: payload.role || 'STUDENT',
            passwordPlainForDemoOnly: null,
            updatedAt: formatIstTimestamp(new Date())
          });
          logAudit('ADMIN_ROSTER_CREATE', admin.studentId, 'SUCCESS', 'CREATED:' + roll);
          return { ok: true, message: 'Added ' + name + ' (' + roll + ') to authorized roster.', students: sandboxStudents };
        }
      },

      apiAdminUpdateSettings: function (token, newSet) {
        var admin = findById(sandboxSessions[token]);
        if (!admin || admin.role !== 'ADMIN') return { ok: false, message: 'Forbidden.' };
        sandboxSettings.collegeName = newSet.collegeName || sandboxSettings.collegeName;
        sandboxSettings.centreLatitude = parseFloat(newSet.centreLatitude) || 26.742681;
        sandboxSettings.centreLongitude = parseFloat(newSet.centreLongitude) || 83.273421;
        sandboxSettings.allowedRadiusMeters = parseFloat(newSet.allowedRadiusMeters) || 200;
        sandboxSettings.maxLocationAccuracyMeters = parseFloat(newSet.maxLocationAccuracyMeters) || 50;
        sandboxSettings.locationBoundaryPolicy = newSet.locationBoundaryPolicy || 'CONSERVATIVE';
        sandboxSettings.attendanceStartTime = newSet.attendanceStartTime || '08:30';
        sandboxSettings.attendanceEndTime = newSet.attendanceEndTime || '17:30';
        sandboxSettings.enforceAttendanceWindow = Boolean(newSet.enforceAttendanceWindow);
        logAudit('ADMIN_SETTINGS_UPDATE', admin.studentId, 'SUCCESS', 'RAD:' + sandboxSettings.allowedRadiusMeters + 'm');
        return { ok: true, message: 'Geofence and attendance settings updated.', settings: sandboxSettings };
      },

      apiRegisterStudent: function (payload) {
        if (!payload) return { ok: false, message: 'Invalid registration data.' };
        var roll = String(payload.rollNumber || '').trim().toUpperCase().replace(/\s+/g, '');
        var name = String(payload.fullName || '').trim();
        var course = String(payload.course || 'B.Tech CSE').trim();
        var sem = String(payload.semester || '6').trim();
        var sec = String(payload.section || 'A').trim();
        var email = String(payload.email || '').trim().toLowerCase();
        var pass = String(payload.password || '');
        if (!roll || !name || !email || email.indexOf('@') === -1) {
          return { ok: false, message: 'Roll Number, Full Name, and valid Email are required.' };
        }
        if (pass.length < 8) {
          return { ok: false, message: 'Password must be at least 8 characters long.' };
        }
        if (findByRoll(roll)) {
          return { ok: false, message: 'This Roll Number (' + roll + ') is already registered. Wait for Admin approval or Sign In.' };
        }
        sandboxStudents.push({
          studentId: 'STU-' + Math.random().toString(36).substring(2, 7).toUpperCase(),
          rollNumber: roll,
          fullName: name,
          course: course,
          semester: sem,
          section: sec,
          verifiedEmail: email,
          emailVerified: false,
          accountStatus: 'PENDING',
          role: 'STUDENT',
          passwordPlainForDemoOnly: pass,
          updatedAt: formatIstTimestamp(new Date())
        });
        logAudit('STUDENT_SELF_REGISTERED', null, 'SUCCESS', 'ROLL:' + roll + ',PENDING_APPROVAL');
        return {
          ok: true,
          message: 'Registration submitted for Roll No ' + roll + '! Your account is currently PENDING ADMIN APPROVAL. Once the Admin approves your account, you can sign in with your Roll Number and Password.'
        };
      },

      apiAdminSetStudentStatus: function (token, roll, newStatus) {
        var admin = findById(sandboxSessions[token]);
        if (!admin || admin.role !== 'ADMIN') return { ok: false, message: 'Forbidden.' };
        var st = findByRoll(roll);
        if (!st) return { ok: false, message: 'Student not found.' };
        st.accountStatus = newStatus;
        st.updatedAt = formatIstTimestamp(new Date());
        logAudit('ADMIN_STATUS_CHANGE', admin.studentId, 'SUCCESS', 'ROLL:' + roll + '->' + newStatus);
        return {
          ok: true,
          message: 'Roll Number ' + roll + ' (' + st.fullName + ') is now ' + newStatus + '.',
          students: sandboxStudents
        };
      }
    };
  })();

  // =========================================================================
  // SHARED HAVERSINE & GEOFENCE LOGIC (Client feedback + Local Sandbox)
  // =========================================================================
  function calculateHaversineMeters(lat1, lon1, lat2, lon2) {
    var toRad = function (d) { return (d * Math.PI) / 180; };
    var dLat = toRad(lat2 - lat1);
    var dLon = toRad(lon2 - lon1);
    var a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS_METERS * c;
  }

  function evaluateClientOrSandboxGeofence(lat, lng, acc, settings) {
    var numLat = Number(lat);
    var numLng = Number(lng);
    var numAcc = Number(acc);

    if (!isFinite(numLat) || !isFinite(numLng) || !isFinite(numAcc) || numAcc <= 0) {
      return {
        eligible: false,
        status: 'INVALID_COORDINATES',
        message: 'Invalid GPS coordinates or accuracy reading.'
      };
    }

    var dist = calculateHaversineMeters(settings.centreLatitude, settings.centreLongitude, numLat, numLng);
    var rDist = Math.round(dist * 10) / 10;
    var rAcc = Math.round(numAcc * 10) / 10;
    var effDist = Math.round((dist + numAcc) * 10) / 10;

    if (numAcc > settings.maxLocationAccuracyMeters) {
      return {
        eligible: false,
        status: 'POOR_ACCURACY',
        distanceMeters: rDist,
        accuracyMeters: rAcc,
        effectiveDistanceMeters: effDist,
        message: 'Location too inaccurate (Â±' + rAcc + ' m exceeds maximum allowed Â±' + settings.maxLocationAccuracyMeters + ' m). Please move outdoors with a clear sky view and retry.'
      };
    }

    if (dist > settings.allowedRadiusMeters) {
      return {
        eligible: false,
        status: 'OUTSIDE_GEOFENCE',
        distanceMeters: rDist,
        accuracyMeters: rAcc,
        effectiveDistanceMeters: effDist,
        message: 'Outside permitted campus area: you are ' + rDist + ' m from ' + settings.collegeName + ' centre (allowed radius: ' + settings.allowedRadiusMeters + ' m).'
      };
    }

    if (settings.locationBoundaryPolicy === 'CONSERVATIVE' && (dist + numAcc) > settings.allowedRadiusMeters) {
      return {
        eligible: false,
        status: 'UNCERTAIN_BOUNDARY',
        distanceMeters: rDist,
        accuracyMeters: rAcc,
        effectiveDistanceMeters: effDist,
        message: 'Near 200 m boundary with uncertain GPS fix: centre distance is ' + rDist + ' m with Â±' + rAcc + ' m uncertainty (worst-case ' + effDist + ' m > ' + settings.allowedRadiusMeters + ' m). Step further inside campus or retry for a sharper GPS fix.'
      };
    }

    return {
      eligible: true,
      status: 'ELIGIBLE_INSIDE_GEOFENCE',
      distanceMeters: rDist,
      accuracyMeters: rAcc,
      effectiveDistanceMeters: effDist,
      message: 'Eligible: Verified inside ' + settings.collegeName + ' geofence (' + rDist + ' m from centre, Â±' + rAcc + ' m GPS accuracy).'
    };
  }

  // =========================================================================
  // UNIFIED SERVER RPC CALLER
  // =========================================================================
  function callServerRpc(methodName, argsArray, onSuccess, onFailure) {
    if (appState.isAppsScriptRuntime) {
      var runner = window.google.script.run
        .withSuccessHandler(function (res) {
          onSuccess(res);
        })
        .withFailureHandler(function (err) {
          if (onFailure) {
            onFailure(err);
          } else {
            showBanner('global-alert', 'danger', (err && err.message) ? err.message : 'Network or Google Apps Script server error.');
          }
        });
      runner[methodName].apply(runner, argsArray || []);
    } else if (appState.useRemoteFetchApi && APPS_SCRIPT_WEB_APP_URL) {
      // Call Google Apps Script doPost(e) using text/plain to avoid CORS preflight blocks
      fetch(APPS_SCRIPT_WEB_APP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: methodName,
          args: argsArray || []
        })
      })
        .then(function (resp) {
          return resp.json();
        })
        .then(function (data) {
          onSuccess(data);
        })
        .catch(function (err) {
          // Automatic fallback to Local Sandbox if doPost is not yet deployed
          try {
            var fn = LocalSandboxServer[methodName];
            if (fn) {
              var fallbackRes = fn.apply(LocalSandboxServer, argsArray || []);
              onSuccess(fallbackRes);
              return;
            }
          } catch (e) {}
          if (onFailure) {
            onFailure(err);
          } else {
            showBanner('global-alert', 'danger', 'Unable to reach live server. Check internet connection or deployment.');
          }
        });
    } else {
      // Simulate realistic network latency in local preview mode
      setTimeout(function () {
        try {
          var fn = LocalSandboxServer[methodName];
          if (!fn) throw new Error('Unknown RPC method: ' + methodName);
          var result = fn.apply(LocalSandboxServer, argsArray || []);
          onSuccess(result);
        } catch (err) {
          if (onFailure) onFailure(err);
        }
      }, 220);
    }
  }

  // =========================================================================
  // DOM HELPERS & SAFE ESCAPING
  // =========================================================================
  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(str) {
    return String(str === undefined || str === null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showBanner(elementId, type, message) {
    var el = byId(elementId);
    if (!el) return;
    if (!message) {
      el.className = 'alert hidden';
      el.textContent = '';
      return;
    }
    el.className = 'alert alert-' + type;
    el.textContent = message;
  }

  function showScreen(screenId) {
    var screens = ['screen-login', 'screen-register', 'screen-recovery', 'screen-student-dashboard', 'screen-admin-dashboard'];
    screens.forEach(function (id) {
      var el = byId(id);
      if (el) {
        if (id === screenId) {
          el.classList.remove('hidden');
        } else {
          el.classList.add('hidden');
        }
      }
    });
    showBanner('global-alert', '', '');
  }

  function formatIstDate(d) {
    try {
      return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    } catch (e) {
      return d.toISOString().substring(0, 10);
    }
  }

  function formatIstTimestamp(d) {
    try {
      var datePart = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      var timePart = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
      return datePart + ' ' + timePart;
    } catch (e) {
      return d.toISOString().replace('T', ' ').substring(0, 19);
    }
  }

  // =========================================================================
  // UI RENDERING: STUDENT DASHBOARD & GEOFENCE PANEL
  // =========================================================================
  function applyPublicSettingsToUi(settings) {
    if (!settings) return;
    appState.settings = settings;
    byId('header-college-name').textContent = settings.collegeName || 'ITM GIDA, Gorakhpur';
    byId('geofence-rule-subtitle').textContent =
      'Must be within ' + settings.allowedRadiusMeters + ' m of ' + settings.collegeName +
      ' centre with GPS accuracy â‰¤ ' + settings.maxLocationAccuracyMeters + ' m.';
    byId('geo-radius-limit-meta').textContent = 'Max allowed: ' + settings.allowedRadiusMeters + ' m';
    byId('geo-accuracy-limit-meta').textContent = 'Required: â‰¤ ' + settings.maxLocationAccuracyMeters + ' m';
  }

  function renderAuthenticatedUi() {
    var p = appState.profile;
    if (!p) {
      byId('btn-logout').classList.add('hidden');
      byId('btn-nav-admin-view').classList.add('hidden');
      byId('btn-nav-student-view').classList.add('hidden');
      showScreen('screen-login');
      return;
    }

    byId('btn-logout').classList.remove('hidden');
    if (p.role === 'ADMIN') {
      byId('btn-nav-admin-view').classList.remove('hidden');
      byId('btn-nav-student-view').classList.remove('hidden');
    } else {
      byId('btn-nav-admin-view').classList.add('hidden');
      byId('btn-nav-student-view').classList.add('hidden');
    }

    byId('student-welcome-line').textContent = p.fullName + ' (' + p.rollNumber + ') â€” ' + appState.settings.collegeName;
    byId('profile-roll-display').textContent = p.rollNumber;
    byId('profile-name-display').textContent = p.fullName;
    byId('profile-course-display').textContent = p.course + ' â€¢ Sem ' + p.semester + ' (' + p.section + ')';
    byId('profile-email-display').textContent = 'Verified Email: ' + p.maskedEmail;

    renderTodayStatusCard();
    renderStudentHistoryTable();
    updateMarkPresentButtonState();

    if (p.role === 'ADMIN') {
      openAdminDashboard();
    } else {
      showScreen('screen-student-dashboard');
    }
  }

  function renderTodayStatusCard() {
    var t = appState.todayAttendance;
    var badge = byId('today-status-badge');
    var statusText = byId('today-status-text');
    var metaText = byId('today-timestamp-text');

    if (t && t.markedToday && t.record) {
      badge.className = 'badge badge-present';
      badge.textContent = 'Present Today (' + t.attendanceDate + ')';
      statusText.textContent = 'PRESENT';
      statusText.style.color = 'var(--success-text)';
      metaText.textContent = 'Recorded at ' + t.record.serverTimestamp + ' IST (' + t.record.distanceMeters + ' m)';
    } else {
      badge.className = 'badge badge-warning';
      badge.textContent = 'Not Marked Today';
      statusText.textContent = 'Pending Check-In';
      statusText.style.color = 'var(--text-primary)';
      metaText.textContent = 'Check your campus location below to enable Mark Present';
    }
  }

  function renderStudentHistoryTable() {
    var tbody = byId('student-history-tbody');
    var list = appState.attendanceHistory || [];
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No attendance records found for your roll number yet.</td></tr>';
      return;
    }

    var rowsHtml = list.map(function (item) {
      return (
        '<tr>' +
          '<td><strong>' + escapeHtml(item.attendanceDate) + '</strong></td>' +
          '<td>' + escapeHtml(item.serverTimestamp) + '</td>' +
          '<td><span class="badge badge-present">' + escapeHtml(item.status) + '</span></td>' +
          '<td>' + escapeHtml(item.distanceMeters) + ' m</td>' +
          '<td>Â±' + escapeHtml(item.reportedAccuracyMeters) + ' m</td>' +
        '</tr>'
      );
    }).join('');
    tbody.innerHTML = rowsHtml;
  }

  /**
   * Enforces the Core Rule on the Mark Present button:
   * Must remain disabled unless:
   * 1. Student is not already marked present today
   * 2. A fresh location fix exists and is eligible (within 200m and accuracy <= 50m and conservative boundary passes)
   */
  function updateMarkPresentButtonState() {
    var btn = byId('btn-mark-present');
    if (!btn) return;

    if (appState.todayAttendance && appState.todayAttendance.markedToday) {
      btn.disabled = true;
      btn.textContent = 'Attendance Already Marked Today';
      return;
    }

    if (appState.lastGeoFix && appState.lastGeoFix.eligible) {
      btn.disabled = false;
      btn.textContent = 'Mark Present Now (' + appState.lastGeoFix.distanceMeters + ' m from Campus Centre)';
    } else {
      btn.disabled = true;
      btn.textContent = 'Mark Present (Requires Eligible Campus Location)';
    }
  }

  // =========================================================================
  // GEOLOCATION ACQUISITION & MARK PRESENT FLOW
  // =========================================================================
  function acquireBrowserOrSimulatedCoordinates(callback) {
    // If running in Local Preview Sandbox and user clicked a simulator preset
    if (!appState.isAppsScriptRuntime && appState.simulatedGpsMode !== 'real') {
      setTimeout(function () {
        var cLat = appState.settings.centreLatitude;
        var cLng = appState.settings.centreLongitude;
        if (appState.simulatedGpsMode === 'inside') {
          // ~42 metres north-east of ITM GIDA centre, 12m accuracy
          callback(null, { latitude: cLat + 0.00031, longitude: cLng + 0.00024, accuracy: 12.4 });
        } else if (appState.simulatedGpsMode === 'outside') {
          // ~480 metres away, 15m accuracy
          callback(null, { latitude: cLat + 0.0041, longitude: cLng + 0.0016, accuracy: 15.0 });
        } else if (appState.simulatedGpsMode === 'poor_accuracy') {
          // Inside radius (~85m) but poor accuracy (78m > 50m max)
          callback(null, { latitude: cLat + 0.00065, longitude: cLng + 0.00042, accuracy: 78.5 });
        } else if (appState.simulatedGpsMode === 'boundary') {
          // ~182m from centre with Â±30m accuracy -> 182+30 = 212m > 200m (Uncertain boundary)
          callback(null, { latitude: cLat + 0.00163, longitude: cLng + 0.0001, accuracy: 30.0 });
        } else if (appState.simulatedGpsMode === 'denied') {
          callback({ code: 1, message: 'User denied Geolocation' }, null);
        }
      }, 350);
      return;
    }

    if (!navigator.geolocation) {
      callback({
        code: 0,
        customMessage: 'Your web browser does not support Geolocation. Please open GeoAttend in a modern mobile browser (Chrome, Safari, or Edge) over HTTPS.'
      }, null);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        callback(null, {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        });
      },
      function (err) {
        callback(err, null);
      },
      {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 0 // Never accept a stale cached position
      }
    );
  }

  function handleCheckLocationClick(afterVerifyCallback) {
    var checkBtn = byId('btn-check-location');
    var markBtn = byId('btn-mark-present');
    var badge = byId('geo-eligibility-badge');

    checkBtn.disabled = true;
    checkBtn.textContent = 'Obtaining High-Accuracy GPS Fix...';
    markBtn.disabled = true;
    badge.className = 'badge badge-neutral';
    badge.textContent = 'Checking GPS...';
    showBanner('geo-status-alert', 'info', 'Requesting high-accuracy GPS reading from your device. Please wait...');

    acquireBrowserOrSimulatedCoordinates(function (geoErr, coords) {
      checkBtn.disabled = false;
      checkBtn.textContent = 'Recheck My Location';

      if (geoErr || !coords) {
        appState.lastGeoFix = null;
        byId('geo-distance-value').textContent = 'â€” m';
        byId('geo-accuracy-value').textContent = 'â€” m';
        badge.className = 'badge badge-danger';

        var errMessage = 'Unable to retrieve your location.';
        if (geoErr && geoErr.customMessage) {
          errMessage = geoErr.customMessage;
          badge.textContent = 'Unavailable';
        } else if (geoErr && geoErr.code === 1) {
          badge.textContent = 'Permission Denied';
          errMessage = 'Location permission was denied. Please enable Location Access for this site in your browser settings and tap Recheck My Location.';
        } else if (geoErr && geoErr.code === 2) {
          badge.textContent = 'Position Unavailable';
          errMessage = 'Device GPS signal is unavailable. Please turn on device Location / GPS services and move near an open area.';
        } else if (geoErr && geoErr.code === 3) {
          badge.textContent = 'GPS Timed Out';
          errMessage = 'Location request timed out while waiting for a high-accuracy fix. Move outdoors with a clear sky view and tap Recheck My Location.';
        }
        showBanner('geo-status-alert', 'danger', errMessage);
        updateMarkPresentButtonState();
        return;
      }

      // Compute immediate client Haversine check & also verify with server
      var localEval = evaluateClientOrSandboxGeofence(
        coords.latitude,
        coords.longitude,
        coords.accuracy,
        appState.settings
      );

      byId('geo-distance-value').textContent = (localEval.distanceMeters !== undefined ? localEval.distanceMeters : 'â€”') + ' m';
      byId('geo-accuracy-value').textContent = 'Â±' + (localEval.accuracyMeters !== undefined ? localEval.accuracyMeters : 'â€”') + ' m';

      callServerRpc(
        'apiCheckLocationEligibility',
        [appState.sessionToken, coords.latitude, coords.longitude, coords.accuracy],
        function (res) {
          var authoritativeGeo = (res && res.geofence) ? res.geofence : localEval;
          appState.lastGeoFix = {
            lat: coords.latitude,
            lng: coords.longitude,
            accuracy: coords.accuracy,
            timestampMs: Date.now(),
            eligible: authoritativeGeo.eligible,
            distanceMeters: authoritativeGeo.distanceMeters,
            accuracyMeters: authoritativeGeo.accuracyMeters,
            status: authoritativeGeo.status,
            message: authoritativeGeo.message
          };

          byId('geo-distance-value').textContent = authoritativeGeo.distanceMeters + ' m';
          byId('geo-accuracy-value').textContent = 'Â±' + authoritativeGeo.accuracyMeters + ' m';

          if (authoritativeGeo.eligible) {
            badge.className = 'badge badge-eligible';
            badge.textContent = 'Eligible (Inside Campus)';
            showBanner('geo-status-alert', 'success', authoritativeGeo.message);
          } else if (authoritativeGeo.status === 'POOR_ACCURACY' || authoritativeGeo.status === 'UNCERTAIN_BOUNDARY') {
            badge.className = 'badge badge-warning';
            badge.textContent = authoritativeGeo.status === 'UNCERTAIN_BOUNDARY' ? 'Uncertain Boundary' : 'Accuracy Too Low';
            showBanner('geo-status-alert', 'warning', authoritativeGeo.message);
          } else {
            badge.className = 'badge badge-danger';
            badge.textContent = 'Outside Permitted Area';
            showBanner('geo-status-alert', 'danger', authoritativeGeo.message);
          }

          updateMarkPresentButtonState();
          if (typeof afterVerifyCallback === 'function') {
            afterVerifyCallback(appState.lastGeoFix);
          }
        }
      );
    });
  }

  function handleMarkPresentClick() {
    if (appState.todayAttendance && appState.todayAttendance.markedToday) {
      updateMarkPresentButtonState();
      return;
    }

    var markBtn = byId('btn-mark-present');
    var checkBtn = byId('btn-check-location');
    markBtn.disabled = true;
    checkBtn.disabled = true;
    markBtn.textContent = 'Verifying Fresh Location & Submitting...';

    // Always re-verify a fresh reading if the previous reading is older than 20 seconds
    var fixAgeMs = appState.lastGeoFix ? (Date.now() - appState.lastGeoFix.timestampMs) : 999999;
    var submitWithCoords = function (fix) {
      if (!fix || !fix.eligible) {
        checkBtn.disabled = false;
        updateMarkPresentButtonState();
        return;
      }

      markBtn.disabled = true;
      markBtn.textContent = 'Recording Attendance on Server...';

      callServerRpc(
        'apiMarkAttendance',
        [appState.sessionToken, fix.lat, fix.lng, fix.accuracy],
        function (res) {
          checkBtn.disabled = false;
          if (!res || !res.ok) {
            if (res && res.todayAttendance) {
              appState.todayAttendance = res.todayAttendance;
              renderTodayStatusCard();
            }
            showBanner('geo-status-alert', 'danger', (res && res.message) ? res.message : 'Attendance submission rejected by server.');
            updateMarkPresentButtonState();
            return;
          }

          appState.todayAttendance = res.todayAttendance;
          if (res.attendanceHistory) {
            appState.attendanceHistory = res.attendanceHistory;
          }
          renderTodayStatusCard();
          renderStudentHistoryTable();
          showBanner('geo-status-alert', 'success', res.message);
          updateMarkPresentButtonState();
        },
        function (err) {
          checkBtn.disabled = false;
          showBanner('geo-status-alert', 'danger', (err && err.message) ? err.message : 'Server communication error while marking attendance.');
          updateMarkPresentButtonState();
        }
      );
    };

    if (fixAgeMs > 20000) {
      handleCheckLocationClick(function (freshFix) {
        submitWithCoords(freshFix);
      });
    } else {
      submitWithCoords(appState.lastGeoFix);
    }
  }

  // =========================================================================
  // AUTHENTICATION & OTP RECOVERY HANDLERS
  // =========================================================================
  function handleLoginSubmit(e) {
    e.preventDefault();
    var roll = byId('login-roll').value.trim();
    var pass = byId('login-password').value;

    if (!roll || !pass) {
      showBanner('login-alert', 'warning', 'Please enter both your College Roll Number and Password.');
      return;
    }

    var btn = byId('btn-login-submit');
    btn.disabled = true;
    btn.textContent = 'Signing In...';
    showBanner('login-alert', '', '');

    callServerRpc('apiLogin', [roll, pass], function (res) {
      btn.disabled = false;
      btn.textContent = 'Sign In to GeoAttend';

      if (!res || !res.ok) {
        showBanner('login-alert', 'danger', (res && res.message) ? res.message : 'Sign-in failed.');
        return;
      }

      appState.sessionToken = res.sessionToken;
      localStorage.setItem(STORAGE_SESSION_KEY, res.sessionToken);
      appState.profile = res.profile;
      if (res.settings) applyPublicSettingsToUi(res.settings);
      appState.todayAttendance = res.todayAttendance || { markedToday: false };
      appState.attendanceHistory = res.attendanceHistory || [];
      appState.lastGeoFix = null;

      byId('login-password').value = '';
      renderAuthenticatedUi();
    });
  }

  function handleLogoutClick() {
    var tok = appState.sessionToken;
    appState.sessionToken = '';
    appState.profile = null;
    appState.lastGeoFix = null;
    localStorage.removeItem(STORAGE_SESSION_KEY);
    callServerRpc('apiLogout', [tok], function () {
      renderAuthenticatedUi();
    });
  }

  function openRecoveryScreen(purpose) {
    appState.recoveryPurpose = purpose;
    clearOtpTimers();
    byId('form-verify-otp').classList.add('hidden');
    byId('recovery-otp').value = '';
    byId('recovery-new-password').value = '';
    byId('recovery-confirm-password').value = '';
    showBanner('recovery-alert', '', '');

    if (purpose === 'ACCOUNT_ACTIVATION') {
      byId('recovery-heading').textContent = 'First-Time Account Activation (OTP)';
      byId('recovery-subtitle').textContent =
        'Enter your authorized ITM GIDA Roll Number. We will send a 6-digit OTP to your pre-registered roster email so you can set your initial password.';
    } else {
      byId('recovery-heading').textContent = 'Reset Forgotten Password (OTP)';
      byId('recovery-subtitle').textContent =
        'Enter your College Roll Number to receive a 6-digit password reset OTP at the verified email address on file.';
    }
    showScreen('screen-recovery');
  }

  function clearOtpTimers() {
    if (appState.otpExpiryTimerId) clearInterval(appState.otpExpiryTimerId);
    if (appState.otpCooldownTimerId) clearInterval(appState.otpCooldownTimerId);
    appState.otpExpiryTimerId = null;
    appState.otpCooldownTimerId = null;
  }

  function startOtpCountdowns(expirySec, cooldownSec) {
    clearOtpTimers();
    var expRem = expirySec || 300;
    var coolRem = cooldownSec || 60;

    var timerBadge = byId('otp-expiry-timer');
    var resendBtn = byId('btn-resend-otp');

    var updateExpiryLabel = function () {
      if (expRem <= 0) {
        timerBadge.className = 'badge badge-danger';
        timerBadge.textContent = 'OTP Expired â€” Request a New Code';
        clearInterval(appState.otpExpiryTimerId);
        return;
      }
      var m = String(Math.floor(expRem / 60)).padStart(2, '0');
      var s = String(expRem % 60).padStart(2, '0');
      timerBadge.className = 'badge badge-neutral';
      timerBadge.textContent = 'OTP Expires in: ' + m + ':' + s;
      expRem--;
    };

    var updateCooldownLabel = function () {
      if (coolRem <= 0) {
        resendBtn.disabled = false;
        resendBtn.textContent = 'Resend OTP';
        clearInterval(appState.otpCooldownTimerId);
        return;
      }
      resendBtn.disabled = true;
      resendBtn.textContent = 'Resend OTP (' + coolRem + 's)';
      coolRem--;
    };

    updateExpiryLabel();
    updateCooldownLabel();
    appState.otpExpiryTimerId = setInterval(updateExpiryLabel, 1000);
    appState.otpCooldownTimerId = setInterval(updateCooldownLabel, 1000);
  }

  function triggerOtpRequest() {
    var roll = byId('recovery-roll').value.trim();
    if (!roll) {
      showBanner('recovery-alert', 'warning', 'Please enter your College Roll Number.');
      return;
    }

    var sendBtn = byId('btn-send-otp');
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending OTP...';
    showBanner('recovery-alert', '', '');

    callServerRpc('apiRequestOtp', [roll, appState.recoveryPurpose], function (res) {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send 6-Digit OTP to Roster Email';

      if (!res || !res.ok) {
        showBanner('recovery-alert', 'danger', (res && res.message) ? res.message : 'Could not send OTP.');
        return;
      }

      byId('form-verify-otp').classList.remove('hidden');
      showBanner('recovery-alert', 'info', res.message);
      startOtpCountdowns(res.expirySeconds || 300, res.cooldownSeconds || 60);
    });
  }

  function handleVerifyOtpSubmit(e) {
    e.preventDefault();
    var roll = byId('recovery-roll').value.trim();
    var otp = byId('recovery-otp').value.trim();
    var newPass = byId('recovery-new-password').value;
    var confirmPass = byId('recovery-confirm-password').value;

    if (!/^\d{6}$/.test(otp)) {
      showBanner('recovery-alert', 'warning', 'Please enter a valid 6-digit numeric OTP code.');
      return;
    }
    if (newPass.length < 8) {
      showBanner('recovery-alert', 'warning', 'New password must be at least 8 characters long.');
      return;
    }
    if (newPass !== confirmPass) {
      showBanner('recovery-alert', 'warning', 'New password and confirmation do not match.');
      return;
    }

    var submitBtn = byId('btn-verify-otp-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Verifying OTP & Updating Password...';

    callServerRpc(
      'apiVerifyOtpAndResetPassword',
      [roll, otp, newPass, appState.recoveryPurpose],
      function (res) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Verify OTP & Save Password';

        if (!res || !res.ok) {
          showBanner('recovery-alert', 'danger', (res && res.message) ? res.message : 'OTP verification failed.');
          return;
        }

        clearOtpTimers();
        showScreen('screen-login');
        byId('login-roll').value = roll.toUpperCase();
        showBanner('login-alert', 'success', res.message);
      }
    );
  }

  // =========================================================================
  // ADMIN CONSOLE LOGIC (Reports, CSV Export, Roster, Settings, Audit)
  // =========================================================================
  function openAdminDashboard() {
    showScreen('screen-admin-dashboard');
    var today = formatIstDate(new Date());
    if (!byId('filter-start-date').value) byId('filter-start-date').value = today;
    if (!byId('filter-end-date').value) byId('filter-end-date').value = today;

    loadAdminBundle();
  }

  function getAdminFilterValues() {
    return {
      startDate: byId('filter-start-date').value,
      endDate: byId('filter-end-date').value,
      search: byId('filter-search').value.trim(),
      course: byId('filter-course').value.trim(),
      semester: byId('filter-semester').value.trim(),
      section: byId('filter-section').value.trim()
    };
  }

  function loadAdminBundle() {
    showBanner('admin-feedback-alert', 'info', 'Loading latest attendance reports, roster, and audit logs...');
    callServerRpc('apiLoadAdminDashboard', [appState.sessionToken, getAdminFilterValues()], function (res) {
      if (!res || !res.ok) {
        showBanner('admin-feedback-alert', 'danger', (res && res.message) ? res.message : 'Failed to load admin console.');
        return;
      }
      showBanner('admin-feedback-alert', '', '');
      if (res.settings) {
        applyPublicSettingsToUi(res.settings);
        populateAdminSettingsForm(res.settings);
      }
      if (res.report) renderAdminReportSection(res.report);
      if (res.students) renderAdminRosterTable(res.students);
      if (res.auditLogs) renderAdminAuditTable(res.auditLogs);
    });
  }

  function renderAdminReportSection(report) {
    appState.adminLastReport = report;
    var sum = report.summary || {};
    byId('admin-stat-present').textContent = sum.presentCount || 0;
    byId('admin-stat-cohort').textContent = sum.eligibleStudentsCount || 0;
    byId('admin-stat-percentage').textContent = (sum.attendancePercentage || 0) + '%';
    byId('admin-stat-denominator-note').textContent = sum.denominatorExplanation || '';

    var tbody = byId('admin-report-tbody');
    var recs = report.records || [];
    if (recs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:var(--text-muted);">No attendance records match the selected filters.</td></tr>';
      return;
    }

    tbody.innerHTML = recs.map(function (r) {
      return (
        '<tr>' +
          '<td><strong>' + escapeHtml(r.attendanceDate) + '</strong></td>' +
          '<td>' + escapeHtml(r.serverTimestamp) + '</td>' +
          '<td><code>' + escapeHtml(r.rollNumber) + '</code></td>' +
          '<td>' + escapeHtml(r.fullName) + '</td>' +
          '<td>' + escapeHtml(r.course) + ' / Sem ' + escapeHtml(r.semester) + ' / ' + escapeHtml(r.section) + '</td>' +
          '<td><span class="badge badge-present">' + escapeHtml(r.status) + '</span></td>' +
          '<td>' + escapeHtml(r.distanceMeters) + ' m</td>' +
          '<td>Â±' + escapeHtml(r.reportedAccuracyMeters) + ' m</td>' +
        '</tr>'
      );
    }).join('');
  }

  function renderAdminRosterTable(students) {
    var tbody = byId('admin-roster-tbody');
    if (!students || students.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No roster records found.</td></tr>';
      return;
    }

    tbody.innerHTML = students.map(function (s, idx) {
      var badgeClass = s.accountStatus === 'ACTIVE'
        ? 'badge-active'
        : (s.accountStatus === 'DISABLED' ? 'badge-disabled' : 'badge-pending');

      var quickActionsHtml = '<div style="display:flex; gap:6px; flex-wrap:wrap;">';
      if (s.accountStatus !== 'ACTIVE') {
        quickActionsHtml += '<button type="button" class="btn btn-success btn-sm" style="padding:5px 10px; font-size:11px;" data-approve-roll="' + escapeHtml(s.rollNumber) + '">Approve</button>';
      }
      if (s.accountStatus !== 'DISABLED' && s.role !== 'ADMIN') {
        quickActionsHtml += '<button type="button" class="btn btn-secondary btn-sm" style="padding:5px 10px; font-size:11px; color:var(--danger-text);" data-disable-roll="' + escapeHtml(s.rollNumber) + '">Disable</button>';
      }
      quickActionsHtml += '<button type="button" class="btn btn-secondary btn-sm" style="padding:5px 10px; font-size:11px;" data-edit-roster-idx="' + idx + '">Edit</button>';
      quickActionsHtml += '</div>';

      return (
        '<tr>' +
          '<td><code>' + escapeHtml(s.rollNumber) + '</code></td>' +
          '<td>' + escapeHtml(s.fullName) + '</td>' +
          '<td>' + escapeHtml(s.course) + ' / ' + escapeHtml(s.semester) + ' / ' + escapeHtml(s.section) + '</td>' +
          '<td>' + escapeHtml(s.verifiedEmail) + '</td>' +
          '<td><span class="badge ' + badgeClass + '">' + escapeHtml(s.accountStatus) + '</span></td>' +
          '<td>' + escapeHtml(s.role) + '</td>' +
          '<td>' + quickActionsHtml + '</td>' +
        '</tr>'
      );
    }).join('');

    // Attach 1-click Approve listeners
    var approveButtons = tbody.querySelectorAll('[data-approve-roll]');
    Array.prototype.forEach.call(approveButtons, function (btn) {
      btn.addEventListener('click', function () {
        var roll = btn.getAttribute('data-approve-roll');
        btn.disabled = true;
        btn.textContent = 'Approving...';
        callServerRpc('apiAdminSetStudentStatus', [appState.sessionToken, roll, 'ACTIVE'], function (res) {
          if (!res || !res.ok) {
            showBanner('admin-feedback-alert', 'danger', (res && res.message) ? res.message : 'Failed to approve student.');
            btn.disabled = false;
            btn.textContent = 'Approve';
            return;
          }
          showBanner('admin-feedback-alert', 'success', res.message);
          if (res.students) renderAdminRosterTable(res.students);
        });
      });
    });

    // Attach 1-click Disable listeners
    var disableButtons = tbody.querySelectorAll('[data-disable-roll]');
    Array.prototype.forEach.call(disableButtons, function (btn) {
      btn.addEventListener('click', function () {
        var roll = btn.getAttribute('data-disable-roll');
        btn.disabled = true;
        btn.textContent = 'Disabling...';
        callServerRpc('apiAdminSetStudentStatus', [appState.sessionToken, roll, 'DISABLED'], function (res) {
          if (!res || !res.ok) {
            showBanner('admin-feedback-alert', 'danger', (res && res.message) ? res.message : 'Failed to disable student.');
            btn.disabled = false;
            btn.textContent = 'Disable';
            return;
          }
          showBanner('admin-feedback-alert', 'warning', res.message);
          if (res.students) renderAdminRosterTable(res.students);
        });
      });
    });

    // Attach click listeners to populate form for editing
    var editButtons = tbody.querySelectorAll('[data-edit-roster-idx]');
    Array.prototype.forEach.call(editButtons, function (btn) {
      btn.addEventListener('click', function () {
        var st = students[parseInt(btn.getAttribute('data-edit-roster-idx'), 10)];
        if (!st) return;
        byId('roster-roll').value = st.rollNumber;
        byId('roster-name').value = st.fullName;
        byId('roster-course').value = st.course;
        byId('roster-semester').value = st.semester;
        byId('roster-section').value = st.section;
        byId('roster-email').value = st.verifiedEmail;
        byId('roster-status').value = st.accountStatus;
        byId('roster-role').value = st.role;
      });
    });
  }

  function populateAdminSettingsForm(s) {
    byId('setting-college-name').value = s.collegeName || 'ITM GIDA, Gorakhpur';
    byId('setting-lat').value = s.centreLatitude;
    byId('setting-lng').value = s.centreLongitude;
    byId('setting-radius').value = s.allowedRadiusMeters;
    byId('setting-accuracy').value = s.maxLocationAccuracyMeters;
    byId('setting-boundary-policy').value = s.locationBoundaryPolicy || 'CONSERVATIVE';
    byId('setting-start-time').value = s.attendanceStartTime || '08:30';
    byId('setting-end-time').value = s.attendanceEndTime || '17:30';
    byId('setting-enforce-window').checked = Boolean(s.enforceAttendanceWindow);
  }

  function renderAdminAuditTable(logs) {
    var tbody = byId('admin-audit-tbody');
    if (!logs || logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No audit events recorded.</td></tr>';
      return;
    }

    tbody.innerHTML = logs.map(function (l) {
      return (
        '<tr>' +
          '<td><code>' + escapeHtml(l.eventId) + '</code></td>' +
          '<td>' + escapeHtml(l.serverTimestamp) + '</td>' +
          '<td><strong>' + escapeHtml(l.eventType) + '</strong></td>' +
          '<td>' + escapeHtml(l.studentId) + '</td>' +
          '<td>' + escapeHtml(l.outcome) + '</td>' +
          '<td>' + escapeHtml(l.reasonCode) + '</td>' +
        '</tr>'
      );
    }).join('');
  }

  function exportCurrentAdminReportToCsv() {
    var report = appState.adminLastReport;
    if (!report || !report.records || report.records.length === 0) {
      showBanner('admin-feedback-alert', 'warning', 'No attendance records in the current filtered view to export.');
      return;
    }

    var sanitizeCsvCell = function (val) {
      var str = String(val === undefined || val === null ? '' : val);
      if (/^[=+\-@]/.test(str.trim())) {
        str = "'" + str;
      }
      return '"' + str.replace(/"/g, '""') + '"';
    };

    var headers = [
      'Attendance ID',
      'Attendance Date (IST)',
      'Server Timestamp (IST)',
      'Roll Number',
      'Full Name',
      'Course',
      'Semester',
      'Section',
      'Status',
      'Distance From Campus Centre (m)',
      'Reported GPS Accuracy (m)'
    ];

    var csvLines = [headers.map(sanitizeCsvCell).join(',')];
    report.records.forEach(function (r) {
      csvLines.push([
        r.attendanceId,
        r.attendanceDate,
        r.serverTimestamp,
        r.rollNumber,
        r.fullName,
        r.course,
        r.semester,
        r.section,
        r.status,
        r.distanceMeters,
        r.reportedAccuracyMeters
      ].map(sanitizeCsvCell).join(','));
    });

    var blob = new Blob([csvLines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'GeoAttend_ITM_GIDA_Report_' + (report.filters.startDate || 'export') + '.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // =========================================================================
  // INITIALIZATION & EVENT BINDINGS
  // =========================================================================
  function bindEvents() {
    // Password visibility toggles
    byId('btn-toggle-login-pass').addEventListener('click', function () {
      var inp = byId('login-password');
      var isPass = inp.type === 'password';
      inp.type = isPass ? 'text' : 'password';
      this.textContent = isPass ? 'Hide' : 'Show';
    });

    byId('btn-toggle-recovery-pass').addEventListener('click', function () {
      var inp = byId('recovery-new-password');
      var isPass = inp.type === 'password';
      inp.type = isPass ? 'text' : 'password';
      this.textContent = isPass ? 'Hide' : 'Show';
    });

    // Auth & Navigation
    byId('form-login').addEventListener('submit', handleLoginSubmit);
    byId('btn-logout').addEventListener('click', handleLogoutClick);

    byId('link-forgot-password').addEventListener('click', function () {
      openRecoveryScreen('PASSWORD_RESET');
    });

    byId('link-activate-account').addEventListener('click', function () {
      openRecoveryScreen('ACCOUNT_ACTIVATION');
    });

    byId('btn-back-to-login').addEventListener('click', function () {
      clearOtpTimers();
      showScreen('screen-login');
    });

    // Self-Registration Screen Navigation & Submit
    byId('btn-open-register').addEventListener('click', function () {
      showBanner('register-alert', '', '');
      showScreen('screen-register');
    });

    byId('btn-back-from-register').addEventListener('click', function () {
      showScreen('screen-login');
    });

    byId('form-register').addEventListener('submit', function (e) {
      e.preventDefault();
      var roll = byId('reg-roll').value.trim();
      var name = byId('reg-name').value.trim();
      var course = byId('reg-course').value.trim();
      var sem = byId('reg-semester').value.trim();
      var sec = byId('reg-section').value.trim();
      var email = byId('reg-email').value.trim();
      var pass = byId('reg-password').value;
      var confirmPass = byId('reg-confirm-password').value;

      if (!roll || !name || !email) {
        showBanner('register-alert', 'warning', 'Please fill in your Roll Number, Full Name, and Email Address.');
        return;
      }
      if (pass.length < 8) {
        showBanner('register-alert', 'warning', 'Password must be at least 8 characters long.');
        return;
      }
      if (pass !== confirmPass) {
        showBanner('register-alert', 'warning', 'Password and Confirm Password do not match.');
        return;
      }

      var submitBtn = byId('btn-register-submit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting Registration...';
      showBanner('register-alert', '', '');

      callServerRpc('apiRegisterStudent', [{
        rollNumber: roll,
        fullName: name,
        course: course,
        semester: sem,
        section: sec,
        email: email,
        password: pass
      }], function (res) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Registration for Admin Approval';

        if (!res || !res.ok) {
          showBanner('register-alert', 'danger', (res && res.message) ? res.message : 'Registration failed.');
          return;
        }

        byId('form-register').reset();
        showScreen('screen-login');
        byId('login-roll').value = roll.toUpperCase();
        showBanner('login-alert', 'success', res.message);
      });
    });

    byId('form-request-otp').addEventListener('submit', function (e) {
      e.preventDefault();
      triggerOtpRequest();
    });

    byId('btn-resend-otp').addEventListener('click', function () {
      triggerOtpRequest();
    });

    byId('form-verify-otp').addEventListener('submit', handleVerifyOtpSubmit);

    // Student Geofence & Attendance
    byId('btn-check-location').addEventListener('click', function () {
      handleCheckLocationClick();
    });

    byId('btn-mark-present').addEventListener('click', handleMarkPresentClick);

    // Admin View Switchers
    byId('btn-nav-admin-view').addEventListener('click', function () {
      openAdminDashboard();
    });

    byId('btn-nav-student-view').addEventListener('click', function () {
      showScreen('screen-student-dashboard');
    });

    byId('btn-admin-refresh').addEventListener('click', loadAdminBundle);

    // Admin Tabs
    var tabBtns = document.querySelectorAll('[data-admin-tab]');
    Array.prototype.forEach.call(tabBtns, function (btn) {
      btn.addEventListener('click', function () {
        var targetId = btn.getAttribute('data-admin-tab');
        Array.prototype.forEach.call(tabBtns, function (b) {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');

        var panes = document.querySelectorAll('.admin-tab-pane');
        Array.prototype.forEach.call(panes, function (p) {
          if (p.id === targetId) p.classList.remove('hidden');
          else p.classList.add('hidden');
        });
      });
    });

    // Admin Forms
    byId('form-admin-filter').addEventListener('submit', function (e) {
      e.preventDefault();
      callServerRpc('apiFilterAdminReport', [appState.sessionToken, getAdminFilterValues()], function (res) {
        if (res && res.ok && res.report) {
          renderAdminReportSection(res.report);
        }
      });
    });

    byId('btn-export-csv').addEventListener('click', exportCurrentAdminReportToCsv);

    byId('form-admin-student').addEventListener('submit', function (e) {
      e.preventDefault();
      var payload = {
        rollNumber: byId('roster-roll').value.trim(),
        fullName: byId('roster-name').value.trim(),
        course: byId('roster-course').value.trim(),
        semester: byId('roster-semester').value.trim(),
        section: byId('roster-section').value.trim(),
        verifiedEmail: byId('roster-email').value.trim(),
        accountStatus: byId('roster-status').value,
        role: byId('roster-role').value
      };
      callServerRpc('apiAdminSaveStudent', [appState.sessionToken, payload], function (res) {
        if (!res || !res.ok) {
          showBanner('admin-feedback-alert', 'danger', (res && res.message) ? res.message : 'Failed to save student.');
          return;
        }
        showBanner('admin-feedback-alert', 'success', res.message);
        if (res.students) renderAdminRosterTable(res.students);
      });
    });

    byId('form-admin-settings').addEventListener('submit', function (e) {
      e.preventDefault();
      var payload = {
        collegeName: byId('setting-college-name').value.trim(),
        centreLatitude: byId('setting-lat').value,
        centreLongitude: byId('setting-lng').value,
        allowedRadiusMeters: byId('setting-radius').value,
        maxLocationAccuracyMeters: byId('setting-accuracy').value,
        locationBoundaryPolicy: byId('setting-boundary-policy').value,
        attendanceStartTime: byId('setting-start-time').value,
        attendanceEndTime: byId('setting-end-time').value,
        enforceAttendanceWindow: byId('setting-enforce-window').checked
      };
      callServerRpc('apiAdminUpdateSettings', [appState.sessionToken, payload], function (res) {
        if (!res || !res.ok) {
          showBanner('admin-feedback-alert', 'danger', (res && res.message) ? res.message : 'Failed to update settings.');
          return;
        }
        if (res.settings) applyPublicSettingsToUi(res.settings);
        showBanner('admin-feedback-alert', 'success', res.message);
      });
    });

    // Local Simulator preset buttons
    var simBtns = document.querySelectorAll('[data-sim-gps]');
    Array.prototype.forEach.call(simBtns, function (btn) {
      btn.addEventListener('click', function () {
        appState.simulatedGpsMode = btn.getAttribute('data-sim-gps');
        showBanner(
          'global-alert',
          'info',
          'Local GPS Simulator preset set to: "' + appState.simulatedGpsMode.toUpperCase() + '". Tap "Check My Location" on the Student Dashboard to test.'
        );
      });
    });
  }

  function initApp() {
    bindEvents();

    var modeBadge = byId('runtime-mode-badge');
    if (appState.isAppsScriptRuntime || (appState.useRemoteFetchApi && APPS_SCRIPT_WEB_APP_URL)) {
      modeBadge.textContent = 'Live Apps Script Server';
      modeBadge.className = 'mode-badge';
      byId('local-simulator-bar').classList.add('hidden');
    } else {
      modeBadge.textContent = 'Local Preview Sandbox';
      modeBadge.className = 'mode-badge demo';
      byId('local-simulator-bar').classList.remove('hidden');
    }

    callServerRpc('apiBootstrapApp', [appState.sessionToken], function (res) {
      if (res && res.settings) {
        applyPublicSettingsToUi(res.settings);
      }
      if (res && res.authenticated && res.profile) {
        appState.profile = res.profile;
        appState.todayAttendance = res.todayAttendance || { markedToday: false };
        appState.attendanceHistory = res.attendanceHistory || [];
        renderAuthenticatedUi();
      } else {
        appState.sessionToken = '';
        localStorage.removeItem(STORAGE_SESSION_KEY);
        showScreen('screen-login');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();
