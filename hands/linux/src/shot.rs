//! Window pictures: X11's own GetImage, or grim on wlroots compositors (Hyprland, Sway) for a window on screen. Saved
//! whole as PNG; the MCP copy is cropped to `zoom` and fitted to 1280 pixels.

use crate::desktop::{x11, Backend, WmWindow};
use std::io::Cursor;
use std::process::{Command, Stdio};

pub const FIT: u32 = 1280;

pub struct Image {
    pub w: u32,
    pub h: u32,
    pub rgba: Vec<u8>,
}

/// Whether windows can be captured here, in words for the person.
pub fn available(backend: &Backend) -> Result<String, String> {
    match backend {
        Backend::X11(_) => Ok("X11 gives pictures of windows on the current desktop".into()),
        Backend::Hyprland(_) | Backend::Sway(_) => Command::new("grim")
            .arg("-h")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|_| "grim captures windows that are on screen".into())
            .map_err(no_grim),
        Backend::AtspiOnly(d) => Err(portal_only(d)),
    }
}

fn no_grim(e: std::io::Error) -> String {
    format!("grim didn't run ({e}); install grim for screenshots on wlroots")
}

fn portal_only(desktop: &str) -> String {
    let desktop = if desktop == "unknown" { "this desktop" } else { desktop };
    format!("{desktop} on Wayland lets only its own screenshot portal capture windows, and that asks the person each time")
}

/// The window's pixels, or why there are none (the caller turns it into not_supported).
pub fn capture(backend: &Backend, w: &WmWindow) -> Result<Image, String> {
    match backend {
        Backend::X11(d) => {
            if !w.visible {
                return Err("the window isn't mapped on the current desktop, so X11 has no pixels for it".into());
            }
            let (iw, ih, rgba) = x11::capture(d, w.id as u32)?;
            Ok(Image { w: iw, h: ih, rgba })
        }
        Backend::Hyprland(_) | Backend::Sway(_) => {
            if !w.visible {
                return Err(format!(
                    "the window is on {} and not on screen; grim captures only what an output shows",
                    w.workspace.as_deref().map(|x| format!("workspace {x}")).unwrap_or_else(|| "no visible workspace".into())
                ));
            }
            let (x, y, ww, hh) = w.rect.ok_or("the window manager gave no position for the window")?;
            let out = Command::new("grim")
                .args(["-s", "1", "-t", "png", "-g", &format!("{x},{y} {ww}x{hh}"), "-"])
                .stdin(Stdio::null())
                .stderr(Stdio::piped())
                .output()
                .map_err(no_grim)?;
            if !out.status.success() {
                return Err(format!("grim failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
            }
            decode(&out.stdout)
        }
        Backend::AtspiOnly(d) => Err(portal_only(d)),
    }
}

pub fn decode(bytes: &[u8]) -> Result<Image, String> {
    let mut dec = png::Decoder::new(Cursor::new(bytes));
    dec.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = dec.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let (w, h) = (info.width, info.height);
    let px = (w * h) as usize;
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf[..px * 4].to_vec(),
        png::ColorType::Rgb => buf[..px * 3]
            .chunks_exact(3)
            .flat_map(|c| [c[0], c[1], c[2], 255])
            .collect(),
        png::ColorType::GrayscaleAlpha => buf[..px * 2]
            .chunks_exact(2)
            .flat_map(|c| [c[0], c[0], c[0], c[1]])
            .collect(),
        png::ColorType::Grayscale => buf[..px].iter().flat_map(|&g| [g, g, g, 255]).collect(),
        other => return Err(format!("unexpected PNG color type {other:?}")),
    };
    Ok(Image { w, h, rgba })
}

pub fn encode(img: &Image) -> Result<Vec<u8>, String> {
    let mut out = vec![];
    {
        let mut enc = png::Encoder::new(&mut out, img.w, img.h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut wr = enc.write_header().map_err(|e| e.to_string())?;
        wr.write_image_data(&img.rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

pub fn crop(img: &Image, x: u32, y: u32, w: u32, h: u32) -> Image {
    let x = x.min(img.w.saturating_sub(1));
    let y = y.min(img.h.saturating_sub(1));
    let w = w.min(img.w - x).max(1);
    let h = h.min(img.h - y).max(1);
    let mut rgba = Vec::with_capacity((w * h * 4) as usize);
    for row in y..y + h {
        let start = ((row * img.w + x) * 4) as usize;
        rgba.extend_from_slice(&img.rgba[start..start + (w * 4) as usize]);
    }
    Image { w, h, rgba }
}

/// Fitted so the longer side is at most `max`, by averaging each source box (no aliasing on text).
pub fn fit(img: &Image, max: u32) -> Image {
    let long = img.w.max(img.h);
    if long <= max {
        return Image {
            w: img.w,
            h: img.h,
            rgba: img.rgba.clone(),
        };
    }
    let scale = max as f64 / long as f64;
    let (nw, nh) = (
        ((img.w as f64 * scale).round() as u32).max(1),
        ((img.h as f64 * scale).round() as u32).max(1),
    );
    let mut rgba = vec![0u8; (nw * nh * 4) as usize];
    for ny in 0..nh {
        let y0 = (ny as f64 / scale) as u32;
        let y1 = (((ny + 1) as f64 / scale) as u32).clamp(y0 + 1, img.h);
        for nx in 0..nw {
            let x0 = (nx as f64 / scale) as u32;
            let x1 = (((nx + 1) as f64 / scale) as u32).clamp(x0 + 1, img.w);
            let mut acc = [0u32; 4];
            let mut n = 0u32;
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let i = ((sy * img.w + sx) * 4) as usize;
                    for c in 0..4 {
                        acc[c] += img.rgba[i + c] as u32;
                    }
                    n += 1;
                }
            }
            let o = ((ny * nw + nx) * 4) as usize;
            for c in 0..4 {
                rgba[o + c] = (acc[c] / n.max(1)) as u8;
            }
        }
    }
    Image { w: nw, h: nh, rgba }
}

pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if c.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn fit_keeps_aspect_and_png_round_trips() {
        let img = Image {
            w: 2560,
            h: 100,
            rgba: vec![200; 2560 * 100 * 4],
        };
        let f = fit(&img, 1280);
        assert_eq!((f.w, f.h), (1280, 50));
        assert_eq!(f.rgba[0], 200);
        let back = decode(&encode(&f).unwrap()).unwrap();
        assert_eq!((back.w, back.h), (1280, 50));
        let c = crop(&img, 10, 10, 20, 5);
        assert_eq!((c.w, c.h, c.rgba.len()), (20, 5, 400));
    }
}
