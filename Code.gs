/**
 * GeoAttend — Main Apps Script Entry Points & Client-Callable RPC API
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
    .setTitle('GeoAttend — ITM GIDA Campus Attendance Portal')
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

