/**
 * GeoAttend — Haversine Distance & Authoritative Server-Side Geofence Validation
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
      message: 'Near geofence boundary: you are ~' + roundedDistance + ' m from centre with ±' +
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
    message: 'Location verified inside ' + settings.collegeName + ' geofence (' + roundedDistance + ' m from centre, ±' + roundedAccuracy + ' m accuracy).'
  };
}

