use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpsPosition {
    pub lat: f64,
    pub lng: f64,
    pub accuracy_meters: Option<f64>,
    pub timestamp: f64,
    pub source: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GpsFailureCode {
    NoGpsDevice,
    GpsPermissionDenied,
    GpsNoFix,
    GpsUnavailable,
}

#[derive(Debug, Serialize)]
pub struct GpsFailure {
    pub code: GpsFailureCode,
    pub message: String,
}

impl GpsFailure {
    fn new(code: GpsFailureCode) -> Self {
        let message = match code {
            GpsFailureCode::NoGpsDevice => "No accessible hardware GPS sensor was found.",
            GpsFailureCode::GpsPermissionDenied => "Access to the GPS sensor is denied.",
            GpsFailureCode::GpsNoFix => "The GPS sensor has not produced a current satellite fix.",
            GpsFailureCode::GpsUnavailable => "Hardware GPS is unavailable on this device.",
        };
        Self {
            code,
            message: message.to_owned(),
        }
    }
}

struct GpsSample {
    lat: f64,
    lng: f64,
    accuracy_meters: Option<f64>,
    timestamp: f64,
    fix_quality: Option<i32>,
    fix_type: Option<i32>,
    gps_status: Option<i32>,
    selection_mode: Option<i32>,
}

const MAX_REPORT_AGE_MS: f64 = 30_000.0;
const MAX_FUTURE_CLOCK_SKEW_MS: f64 = 5_000.0;

fn validate_sample(sample: GpsSample, now_ms: f64) -> Option<GpsPosition> {
    if !sample.lat.is_finite()
        || sample.lat.abs() > 90.0
        || !sample.lng.is_finite()
        || sample.lng.abs() > 180.0
        || !sample.timestamp.is_finite()
        || sample.timestamp < 0.0
        || !now_ms.is_finite()
        || now_ms - sample.timestamp > MAX_REPORT_AGE_MS
        || sample.timestamp - now_ms > MAX_FUTURE_CLOCK_SKEW_MS
        || sample
            .fix_quality
            .is_some_and(|value| !matches!(value, 1 | 2))
        || sample.fix_type.is_some_and(|value| !matches!(value, 1..=5))
        || sample.gps_status.is_some_and(|value| value != 1)
        || sample
            .selection_mode
            .is_some_and(|value| !matches!(value, 0 | 1))
    {
        return None;
    }
    // Microsoft defines a zero error radius as unknown, not zero-meter accuracy.
    let accuracy_meters = sample
        .accuracy_meters
        .filter(|value| value.is_finite() && *value > 0.0);
    Some(GpsPosition {
        lat: sample.lat,
        lng: sample.lng,
        accuracy_meters,
        timestamp: sample.timestamp,
        source: "gps",
    })
}

#[tauri::command]
pub async fn gps_location() -> Result<GpsPosition, GpsFailure> {
    tauri::async_runtime::spawn_blocking(gps_location_blocking)
        .await
        .map_err(|_| GpsFailure::new(GpsFailureCode::GpsUnavailable))?
}

pub(crate) fn gps_location_blocking() -> Result<GpsPosition, GpsFailure> {
    #[cfg(windows)]
    {
        platform::read()
    }
    #[cfg(not(windows))]
    {
        Err(GpsFailure::new(GpsFailureCode::GpsUnavailable))
    }
}

#[cfg(windows)]
mod platform {
    use super::{validate_sample, GpsFailure, GpsFailureCode, GpsPosition, GpsSample};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use windows::{
        core::Error,
        Win32::{
            Devices::Sensors::{
                ISensor, ISensorDataReport, ISensorManager, SensorManager,
                SENSOR_DATA_TYPE_ERROR_RADIUS_METERS, SENSOR_DATA_TYPE_FIX_QUALITY,
                SENSOR_DATA_TYPE_FIX_TYPE, SENSOR_DATA_TYPE_GPS_SELECTION_MODE,
                SENSOR_DATA_TYPE_GPS_STATUS, SENSOR_DATA_TYPE_LATITUDE_DEGREES,
                SENSOR_DATA_TYPE_LONGITUDE_DEGREES, SENSOR_STATE_ACCESS_DENIED, SENSOR_STATE_ERROR,
                SENSOR_STATE_NOT_AVAILABLE, SENSOR_STATE_READY, SENSOR_TYPE_LOCATION_GPS,
            },
            Foundation::{ERROR_NOT_FOUND, E_ACCESSDENIED, FILETIME, PROPERTYKEY},
            System::{
                Com::{
                    CoCreateInstance, CoInitializeEx, CoUninitialize,
                    StructuredStorage::{
                        PropVariantClear, PropVariantToDouble, PropVariantToInt32,
                    },
                    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
                },
                Time::SystemTimeToFileTime,
            },
        },
    };

    struct ComApartment;

    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    fn api_failure(error: Error) -> GpsFailure {
        let code = if error.code() == E_ACCESSDENIED {
            GpsFailureCode::GpsPermissionDenied
        } else {
            GpsFailureCode::GpsUnavailable
        };
        GpsFailure::new(code)
    }

    pub(super) fn read() -> Result<GpsPosition, GpsFailure> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(api_failure)?;
        let _apartment = ComApartment;
        let manager: ISensorManager =
            unsafe { CoCreateInstance(&SensorManager, None, CLSCTX_INPROC_SERVER) }
                .map_err(api_failure)?;
        // Query the GPS device type directly. Do not enumerate generic location,
        // lookup, triangulation, static or dead-reckoning providers.
        let collection =
            unsafe { manager.GetSensorsByType(&SENSOR_TYPE_LOCATION_GPS) }.map_err(|error| {
                if error.code() == windows::core::HRESULT::from_win32(ERROR_NOT_FOUND.0) {
                    GpsFailure::new(GpsFailureCode::NoGpsDevice)
                } else {
                    api_failure(error)
                }
            })?;
        let count = unsafe { collection.GetCount() }.map_err(api_failure)?;
        if count == 0 {
            return Err(GpsFailure::new(GpsFailureCode::NoGpsDevice));
        }
        let mut sensors = Vec::<ISensor>::with_capacity(count as usize);
        for index in 0..count {
            sensors.push(unsafe { collection.GetAt(index) }.map_err(api_failure)?);
        }

        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let mut denied = 0;
            let mut unavailable = 0;
            for sensor in &sensors {
                let state = match unsafe { sensor.GetState() } {
                    Ok(state) => state,
                    Err(error) if error.code() == E_ACCESSDENIED => {
                        denied += 1;
                        continue;
                    }
                    Err(_) => {
                        unavailable += 1;
                        continue;
                    }
                };
                if state == SENSOR_STATE_ACCESS_DENIED {
                    denied += 1;
                    continue;
                }
                if state == SENSOR_STATE_ERROR || state == SENSOR_STATE_NOT_AVAILABLE {
                    unavailable += 1;
                    continue;
                }
                if state != SENSOR_STATE_READY {
                    continue;
                }
                let report = match unsafe { sensor.GetData() } {
                    Ok(report) => report,
                    Err(error) if error.code() == E_ACCESSDENIED => {
                        denied += 1;
                        continue;
                    }
                    Err(_) => continue,
                };
                if let Some(position) = read_report(&report) {
                    return Ok(position);
                }
            }
            if denied == sensors.len() {
                return Err(GpsFailure::new(GpsFailureCode::GpsPermissionDenied));
            }
            if unavailable + denied == sensors.len() {
                return Err(GpsFailure::new(GpsFailureCode::GpsUnavailable));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(GpsFailure::new(GpsFailureCode::GpsNoFix));
            }
            std::thread::sleep(remaining.min(Duration::from_millis(250)));
        }
    }

    fn read_number(report: &ISensorDataReport, key: &PROPERTYKEY) -> Option<f64> {
        let mut value = unsafe { report.GetSensorValue(key) }.ok()?;
        let number = unsafe { PropVariantToDouble(&value) }.ok();
        unsafe { PropVariantClear(&mut value) }.ok()?;
        number
    }

    fn read_integer(report: &ISensorDataReport, key: &PROPERTYKEY) -> Option<i32> {
        let mut value = unsafe { report.GetSensorValue(key) }.ok()?;
        let number = unsafe { PropVariantToInt32(&value) }.ok();
        unsafe { PropVariantClear(&mut value) }.ok()?;
        number
    }

    fn read_report(report: &ISensorDataReport) -> Option<GpsPosition> {
        let utc = unsafe { report.GetTimestamp() }.ok()?;
        let mut file_time = FILETIME::default();
        unsafe { SystemTimeToFileTime(&utc, &mut file_time) }.ok()?;
        let ticks =
            (u64::from(file_time.dwHighDateTime) << 32) | u64::from(file_time.dwLowDateTime);
        let timestamp = ticks as f64 / 10_000.0 - 11_644_473_600_000.0;
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_secs_f64()
            * 1000.0;
        validate_sample(
            GpsSample {
                lat: read_number(report, &SENSOR_DATA_TYPE_LATITUDE_DEGREES)?,
                lng: read_number(report, &SENSOR_DATA_TYPE_LONGITUDE_DEGREES)?,
                accuracy_meters: read_number(report, &SENSOR_DATA_TYPE_ERROR_RADIUS_METERS),
                timestamp,
                fix_quality: read_integer(report, &SENSOR_DATA_TYPE_FIX_QUALITY),
                fix_type: read_integer(report, &SENSOR_DATA_TYPE_FIX_TYPE),
                gps_status: read_integer(report, &SENSOR_DATA_TYPE_GPS_STATUS),
                selection_mode: read_integer(report, &SENSOR_DATA_TYPE_GPS_SELECTION_MODE),
            },
            now_ms,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{validate_sample, GpsFailure, GpsFailureCode, GpsSample};

    const NOW: f64 = 1_791_000_000_000.0;

    fn sample() -> GpsSample {
        GpsSample {
            lat: 31.2304,
            lng: 121.4737,
            accuracy_meters: Some(15.0),
            timestamp: NOW,
            fix_quality: Some(1),
            fix_type: Some(1),
            gps_status: Some(1),
            selection_mode: Some(0),
        }
    }

    #[test]
    fn only_current_valid_coordinate_reports_are_accepted() {
        let valid = validate_sample(sample(), NOW).unwrap();
        assert_eq!(valid.source, "gps");
        assert_eq!(valid.accuracy_meters, Some(15.0));
        for latitude in [91.0, -91.0, f64::NAN, f64::INFINITY] {
            let mut invalid = sample();
            invalid.lat = latitude;
            assert!(validate_sample(invalid, NOW).is_none());
        }
        for longitude in [181.0, -181.0, f64::NAN, f64::NEG_INFINITY] {
            let mut invalid = sample();
            invalid.lng = longitude;
            assert!(validate_sample(invalid, NOW).is_none());
        }
    }

    #[test]
    fn stale_future_and_invalid_timestamps_are_rejected() {
        for timestamp in [NOW - 30_001.0, NOW + 5_001.0, -1.0, f64::NAN, f64::INFINITY] {
            let mut invalid = sample();
            invalid.timestamp = timestamp;
            assert!(validate_sample(invalid, NOW).is_none());
        }
        assert!(validate_sample(sample(), f64::NAN).is_none());
    }

    #[test]
    fn unavailable_or_unknown_accuracy_stays_null() {
        for accuracy in [
            None,
            Some(0.0),
            Some(-1.0),
            Some(f64::NAN),
            Some(f64::INFINITY),
        ] {
            let mut unknown = sample();
            unknown.accuracy_meters = accuracy;
            let position = validate_sample(unknown, NOW).unwrap();
            assert_eq!(position.accuracy_meters, None);
            let json = serde_json::to_value(position).unwrap();
            assert!(json["accuracyMeters"].is_null());
        }
    }

    #[test]
    fn no_fix_manual_simulated_dead_reckoned_and_invalid_data_are_rejected() {
        for kind in [0, 6, 7, 8, 99] {
            let mut invalid = sample();
            invalid.fix_type = Some(kind);
            assert!(validate_sample(invalid, NOW).is_none());
        }
        for mode in [2, 3, 4, 5, 99] {
            let mut invalid = sample();
            invalid.selection_mode = Some(mode);
            assert!(validate_sample(invalid, NOW).is_none());
        }
        let mut invalid = sample();
        invalid.fix_quality = Some(0);
        assert!(validate_sample(invalid, NOW).is_none());
        let mut invalid = sample();
        invalid.gps_status = Some(2);
        assert!(validate_sample(invalid, NOW).is_none());
    }

    #[test]
    fn optional_fields_do_not_fabricate_accuracy_and_json_contract_is_camel_case() {
        let mut plain = sample();
        plain.fix_quality = None;
        plain.fix_type = None;
        plain.gps_status = None;
        plain.selection_mode = None;
        plain.accuracy_meters = None;
        let json = serde_json::to_value(validate_sample(plain, NOW).unwrap()).unwrap();
        assert_eq!(json["source"], "gps");
        assert_eq!(json["lat"], 31.2304);
        assert!(json.get("accuracy_meters").is_none());
    }

    #[test]
    fn failure_codes_are_stable_kebab_case() {
        for (code, expected) in [
            (GpsFailureCode::NoGpsDevice, "no-gps-device"),
            (GpsFailureCode::GpsPermissionDenied, "gps-permission-denied"),
            (GpsFailureCode::GpsNoFix, "gps-no-fix"),
            (GpsFailureCode::GpsUnavailable, "gps-unavailable"),
        ] {
            let json = serde_json::to_value(GpsFailure::new(code)).unwrap();
            assert_eq!(json["code"], expected);
            assert!(json["message"].as_str().unwrap().len() > 5);
        }
    }
}
