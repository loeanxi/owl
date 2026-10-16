//! 记住主窗口上次的客户区大小。关闭进托盘再显示时进程还在，尺寸本来就在；
//! 真正丢掉尺寸的是退出后重新启动。这里把逻辑像素写进数据目录，下次建窗时读回来。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{PhysicalSize, WebviewWindow};

pub const DEFAULT_WIDTH: f64 = 1280.0;
pub const DEFAULT_HEIGHT: f64 = 860.0;

const MIN_WIDTH: f64 = 480.0;
const MIN_HEIGHT: f64 = 360.0;
const MAX_EDGE: f64 = 16_000.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WindowGeometry {
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub maximized: bool,
}

impl Default for WindowGeometry {
    fn default() -> Self {
        Self {
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            maximized: false,
        }
    }
}

impl WindowGeometry {
    /// 非法、过小或过大的尺寸不当成「上次的大小」，调用方改用默认值。
    pub fn sanitized(width: f64, height: f64, maximized: bool) -> Option<Self> {
        if !width.is_finite() || !height.is_finite() {
            return None;
        }
        if !(MIN_WIDTH..=MAX_EDGE).contains(&width) || !(MIN_HEIGHT..=MAX_EDGE).contains(&height) {
            return None;
        }
        Some(Self {
            width,
            height,
            maximized,
        })
    }
}

pub fn parse_geometry(raw: &str) -> WindowGeometry {
    let Ok(parsed) = serde_json::from_str::<WindowGeometry>(raw) else {
        return WindowGeometry::default();
    };
    if let Some(geometry) = WindowGeometry::sanitized(parsed.width, parsed.height, parsed.maximized)
    {
        return geometry;
    }
    if parsed.maximized {
        return WindowGeometry {
            maximized: true,
            ..WindowGeometry::default()
        };
    }
    WindowGeometry::default()
}

/// 物理像素 ÷ 缩放，再取整。存逻辑像素，换显示器缩放后大小仍按用户看到的尺寸恢复。
pub fn logical_inner_size(physical: PhysicalSize<u32>, scale: f64) -> Option<(f64, f64)> {
    if !scale.is_finite() || scale <= f64::EPSILON {
        return None;
    }
    let width = (physical.width as f64 / scale).round();
    let height = (physical.height as f64 / scale).round();
    if !width.is_finite() || !height.is_finite() {
        return None;
    }
    Some((width, height))
}

#[derive(Clone)]
pub struct WindowStateStore {
    inner: Arc<StoreInner>,
}

struct StoreInner {
    path: PathBuf,
    geometry: Mutex<WindowGeometry>,
}

impl WindowStateStore {
    pub fn load(path: PathBuf) -> Self {
        let geometry = std::fs::read_to_string(&path)
            .ok()
            .map(|raw| parse_geometry(&raw))
            .unwrap_or_default();
        Self {
            inner: Arc::new(StoreInner {
                path,
                geometry: Mutex::new(geometry),
            }),
        }
    }

    pub fn geometry(&self) -> WindowGeometry {
        self.inner
            .geometry
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    /// 最小化时的尺寸是 0，全屏时是整块屏幕，这两种都不要覆盖上次的正常大小。
    pub fn remember(&self, window: &WebviewWindow) {
        if window.is_minimized().unwrap_or(true) {
            return;
        }
        let maximized = window.is_maximized().unwrap_or(false);
        let fullscreen = window.is_fullscreen().unwrap_or(false);
        let mut guard = match self.inner.geometry.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };

        if maximized {
            if guard.maximized {
                return;
            }
            guard.maximized = true;
        } else if fullscreen {
            return;
        } else {
            let Ok(physical) = window.inner_size() else {
                return;
            };
            let Ok(scale) = window.scale_factor() else {
                return;
            };
            let Some((width, height)) = logical_inner_size(physical, scale) else {
                return;
            };
            let Some(next) = WindowGeometry::sanitized(width, height, false) else {
                return;
            };
            if *guard == next {
                return;
            }
            *guard = next;
        }

        let snapshot = guard.clone();
        drop(guard);
        let _ = write_geometry(&self.inner.path, &snapshot);
    }
}

fn write_geometry(path: &Path, geometry: &WindowGeometry) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string(geometry).map_err(std::io::Error::other)?;
    std::fs::write(path, raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_broken_file_uses_default_size() {
        assert_eq!(parse_geometry(""), WindowGeometry::default());
        assert_eq!(parse_geometry("{"), WindowGeometry::default());
        assert_eq!(
            parse_geometry(r#"{"width":0,"height":0}"#),
            WindowGeometry::default()
        );
    }

    #[test]
    fn restores_last_logical_size_and_maximized_flag() {
        assert_eq!(
            parse_geometry(r#"{"width":1440.0,"height":900.0,"maximized":true}"#),
            WindowGeometry {
                width: 1440.0,
                height: 900.0,
                maximized: true,
            }
        );
    }

    #[test]
    fn maximized_without_a_usable_size_keeps_the_flag() {
        assert_eq!(
            parse_geometry(r#"{"width":10,"height":10,"maximized":true}"#),
            WindowGeometry {
                maximized: true,
                ..WindowGeometry::default()
            }
        );
    }

    #[test]
    fn logical_size_divides_by_scale_and_rounds() {
        let physical = PhysicalSize::new(1600, 1075);
        assert_eq!(logical_inner_size(physical, 1.25), Some((1280.0, 860.0)));
        assert_eq!(logical_inner_size(physical, 0.0), None);
    }
}
